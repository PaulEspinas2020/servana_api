import { pool } from '../db/dbQuery';
import dbQuery from '../db/dbQuery';
import { db } from '../config';
import { getPublicRatingSummary, recalculateProviderRating } from './ratingAggregationService';
import { emitReputationUpdated } from './reputationRealtimeService';
import { createNotification } from './notification.service';

const s = db.schema;
const RESPONSE_WINDOW_DAYS = 30;
const APPEAL_WINDOW_DAYS = 14;
let schemaReady: Promise<void> | null = null;

const requireReputationSchema = async (): Promise<void> => {
  schemaReady ??= dbQuery.query(
    `SELECT to_regclass($1) AS reviews, to_regclass($2) AS response_cases`,
    [`${s}.customer_reviews`, `${s}.review_response_moderation_cases`],
  ).then((result) => {
    if (!result.rows[0]?.reviews || !result.rows[0]?.response_cases) {
      throw fail('Review schema is not deployed. Apply migrations 012 and 013.', 'REVIEW_SCHEMA_NOT_DEPLOYED', 503);
    }
  });
  return schemaReady;
};

export const REPORT_REASONS = [
  'NOT_RELATED_TO_BOOKING', 'PRIVATE_INFORMATION', 'HARASSMENT_OR_THREATS',
  'DISCRIMINATORY_CONTENT', 'FRAUD_OR_EXTORTION', 'OFF_PLATFORM_PAYMENT',
  'PROHIBITED_CONTENT', 'SERVICE_NOT_EXPERIENCED', 'DUPLICATE_REVIEW',
  'INCORRECT_PROVIDER', 'CONFLICT_OF_INTEREST', 'RETALIATORY_REVIEW',
] as const;

export const APPEAL_GROUNDS = [
  'EVIDENCE_NOT_CONSIDERED', 'WRONG_PROVIDER_OR_BOOKING', 'POLICY_VIOLATION',
  'AUTHORITATIVE_CONTRADICTION', 'MANIPULATED_REVIEW', 'PROCEDURAL_ERROR',
] as const;

const fail = (message: string, code: string, statusCode: number) =>
  Object.assign(new Error(message), { code, statusCode });

const requestId = (value: unknown) => {
  const id = String(value ?? '').trim();
  if (!/^[a-zA-Z0-9:_-]{16,128}$/.test(id)) throw fail('A valid client request id is required.', 'INVALID_IDEMPOTENCY_KEY', 400);
  return id;
};

const safeText = (value: unknown, maximum: number, field: string) => {
  const text = String(value ?? '').trim();
  if (!text || text.length > maximum) throw fail(`${field} must be between 1 and ${maximum} characters.`, 'INVALID_CONTENT', 422);
  return text;
};

export const providerResponseNeedsModeration = (body: string): boolean => {
  const unsafe = /(?:\b\+?63\d{9,10}\b|\b\d{10,11}\b|[\w.+-]+@[\w.-]+\.[a-z]{2,}|https?:\/\/|\b(?:gcash|paymaya|bank account)\b|\b(?:threat|revenge|find you)\b)/i;
  return unsafe.test(body);
};

const encodeCursor = (createdAt: unknown, reviewId: unknown) =>
  Buffer.from(`${String(createdAt)}|${String(reviewId)}`, 'utf8').toString('base64url');

const decodeCursor = (cursor: unknown): [string, string] | null => {
  if (!cursor) return null;
  try {
    const [createdAt, reviewId] = Buffer.from(String(cursor), 'base64url').toString('utf8').split('|');
    return createdAt && reviewId && !Number.isNaN(Date.parse(createdAt)) ? [createdAt, reviewId] : null;
  } catch { return null; }
};

const reviewActions = (row: any): string[] => {
  const actions = ['VIEW'];
  const age = Date.now() - new Date(row.created_at).getTime();
  if (!row.response_id && age <= RESPONSE_WINDOW_DAYS * 86_400_000
      && !['REMOVED','WITHDRAWN','ARCHIVED'].includes(String(row.publication_state))) actions.push('RESPOND');
  if (!row.report_id && !['WITHDRAWN','ARCHIVED'].includes(String(row.publication_state))) actions.push('REPORT');
  if (row.case_id && ['REMOVED','REDACTED','APPROVED','RESTORED'].includes(String(row.case_state)) && !row.appeal_id) actions.push('APPEAL');
  return actions;
};

const providerReviewDto = (row: any) => ({
  id: String(row.review_id),
  rating: Number(row.overall_rating),
  service: { id: row.service_id == null ? null : String(row.service_id), name: row.service_name ?? 'Service' },
  safeBookingReference: `SVN-${String(row.booking_id).padStart(6, '0')}`,
  verifiedBooking: true,
  submittedAt: row.submitted_at ?? row.created_at,
  editedAt: row.edited_at ?? null,
  publicComment: row.public_comment ?? null,
  publicationState: row.publication_state ?? 'PUBLISHED',
  moderationState: row.moderation_status ?? 'NOT_REQUIRED',
  appealState: row.appeal_state ?? 'NONE',
  providerResponseState: row.provider_response_state ?? (row.response_id ? 'PENDING_MODERATION' : 'NONE'),
  providerResponse: row.response_id ? {
    id: String(row.response_id),
    body: row.response_body,
    state: row.response_publication_state ?? 'PENDING_MODERATION',
    createdAt: row.response_created_at,
    moderationCase: row.response_case_id ? {
      id: String(row.response_case_id),
      state: row.response_case_state,
      providerReasonCode: row.response_reason_code ?? null,
      providerReasonDetail: row.response_reason_detail ?? null,
      updatedAt: row.response_case_updated_at,
      version: Number(row.response_case_version),
    } : null,
  } : null,
  report: row.report_id ? {
    id: String(row.report_id), state: row.report_state ?? 'SUBMITTED', reason: row.report_reason,
  } : null,
  moderationCase: row.case_id ? {
    id: String(row.case_id), state: row.case_state,
    providerReasonCode: row.provider_reason_code ?? null,
    providerReasonDetail: row.provider_reason_detail ?? null,
    updatedAt: row.case_updated_at,
  } : null,
  appeal: row.appeal_id ? {
    id: String(row.appeal_id), state: row.current_appeal_state,
    providerReasonCode: row.appeal_reason_code ?? null,
    providerReasonDetail: row.appeal_reason_detail ?? null,
  } : null,
  version: Number(row.version ?? 1),
  availableActions: reviewActions(row),
});

const OWNED_REVIEW_SELECT = `
  SELECT r.review_id, r.booking_id, r.overall_rating, r.service_id, s.name AS service_name,
         r.public_comment, r.publication_state, r.moderation_status, r.appeal_state,
         r.provider_response_state, r.submitted_at, r.created_at, r.edited_at, r.version,
         pr.response_id, pr.body AS response_body, pr.publication_state AS response_publication_state,
         pr.created_at AS response_created_at,
         rmc.case_id AS response_case_id, rmc.state AS response_case_state,
         rmc.provider_reason_code AS response_reason_code,
         rmc.provider_reason_detail AS response_reason_detail,
         rmc.updated_at AS response_case_updated_at, rmc.version AS response_case_version,
         rr.report_id, rr.state AS report_state, rr.reason AS report_reason,
         mc.case_id, mc.state AS case_state, mc.provider_reason_code, mc.provider_reason_detail,
         mc.updated_at AS case_updated_at,
         ra.appeal_id, ra.state AS current_appeal_state,
         ra.provider_reason_code AS appeal_reason_code, ra.provider_reason_detail AS appeal_reason_detail
    FROM ${s}.customer_reviews r
    LEFT JOIN ${s}.services s ON s.id::text = r.service_id
    LEFT JOIN ${s}.review_provider_responses pr ON pr.review_id = r.review_id AND pr.provider_uid = r.provider_uid AND pr.deleted_at IS NULL
    LEFT JOIN ${s}.review_response_moderation_cases rmc ON rmc.response_id = pr.response_id
    LEFT JOIN ${s}.review_reports rr ON rr.review_id = r.review_id AND rr.reporter_uid = r.provider_uid
    LEFT JOIN LATERAL (
      SELECT * FROM ${s}.review_moderation_cases x WHERE x.review_id = r.review_id ORDER BY x.created_at DESC LIMIT 1
    ) mc ON TRUE
    LEFT JOIN LATERAL (
      SELECT * FROM ${s}.review_appeals x WHERE x.review_id = r.review_id AND x.provider_uid = r.provider_uid ORDER BY x.submitted_at DESC LIMIT 1
    ) ra ON TRUE`;

export async function getProviderReputationSummary(providerUid: string) {
  await requireReputationSchema();
  const [rating, services, actions] = await Promise.all([
    getPublicRatingSummary(providerUid),
    dbQuery.query(
      `SELECT a.service_id, s.name, a.average_rating, a.review_count, a.calculated_at
         FROM ${s}.provider_service_rating_aggregates a
         LEFT JOIN ${s}.services s ON s.id::text = a.service_id
        WHERE a.provider_uid = $1 ORDER BY a.review_count DESC, a.service_id`,
      [providerUid],
    ),
    dbQuery.query(
      `SELECT action_id, service_id, action_type, state, provider_reason_code,
              provider_reason_detail, is_mandatory, due_at, effective_at, policy_version, version
         FROM ${s}.provider_quality_actions
        WHERE provider_uid = $1 AND state IN ('OPEN','IN_PROGRESS','ACTION_REQUIRED')
        ORDER BY is_mandatory DESC, effective_at DESC LIMIT 20`,
      [providerUid],
    ),
  ]);
  return {
    publicRating: rating,
    serviceRatings: services.rows.map((row: any) => ({
      serviceId: String(row.service_id), serviceName: row.name ?? 'Service',
      averageRating: Number(row.review_count) ? Math.round(Number(row.average_rating) * 10) / 10 : null,
      reviewCount: Number(row.review_count), calculatedAt: row.calculated_at,
    })),
    privateQuality: {
      label: 'Private performance',
      explanation: 'Operational measures are separate from your public customer rating.',
      actions: actions.rows.map((row: any) => ({
        id: String(row.action_id), serviceId: row.service_id == null ? null : String(row.service_id),
        type: row.action_type, state: row.state, reasonCode: row.provider_reason_code,
        explanation: row.provider_reason_detail, mandatory: Boolean(row.is_mandatory),
        dueAt: row.due_at ?? null, effectiveAt: row.effective_at,
        policyVersion: Number(row.policy_version), version: Number(row.version),
      })),
    },
  };
}

export async function listOwnedProviderReviews(providerUid: string, filters: Record<string, unknown>) {
  await requireReputationSchema();
  const limit = Math.max(1, Math.min(Number(filters.limit ?? 20), 50));
  const cursor = decodeCursor(filters.cursor);
  const values: any[] = [providerUid];
  const where = ['r.provider_uid = $1', "r.publication_state <> 'ARCHIVED'"];
  if (filters.rating && Number.isInteger(Number(filters.rating))) { values.push(Number(filters.rating)); where.push(`r.overall_rating = $${values.length}`); }
  if (filters.serviceId) { values.push(String(filters.serviceId)); where.push(`r.service_id = $${values.length}`); }
  if (filters.state) { values.push(String(filters.state).toUpperCase()); where.push(`(r.publication_state = $${values.length} OR r.moderation_status = $${values.length})`); }
  if (filters.responded === 'true') where.push('pr.response_id IS NOT NULL');
  if (filters.reported === 'true') where.push('rr.report_id IS NOT NULL');
  if (cursor) { values.push(cursor[0], cursor[1]); where.push(`(r.created_at, r.review_id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`); }
  values.push(limit + 1);
  const result = await dbQuery.query(
    `${OWNED_REVIEW_SELECT} WHERE ${where.join(' AND ')}
      ORDER BY r.created_at DESC, r.review_id DESC LIMIT $${values.length}`,
    values,
  );
  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  const last = rows[rows.length - 1];
  return { reviews: rows.map(providerReviewDto), nextCursor: hasMore && last ? encodeCursor(last.created_at, last.review_id) : null };
}

export async function getOwnedProviderReview(providerUid: string, reviewId: string) {
  await requireReputationSchema();
  const result = await dbQuery.query(`${OWNED_REVIEW_SELECT} WHERE r.provider_uid = $1 AND r.review_id = $2`, [providerUid, reviewId]);
  if (!result.rowCount) throw fail('Review unavailable.', 'REVIEW_NOT_FOUND', 404);
  const dimensions = await dbQuery.query(
    `SELECT ds.dimension_key, ds.score, d.provider_label, d.description
       FROM ${s}.review_dimension_scores ds
       LEFT JOIN ${s}.review_dimension_definitions d ON d.dimension_key = ds.dimension_key
      WHERE ds.review_id = $1 ORDER BY d.provider_label`, [reviewId],
  );
  const timeline = await dbQuery.query(
    `SELECT event_type, public_detail, created_at FROM ${s}.review_reputation_events
      WHERE review_id = $1 AND provider_uid = $2 ORDER BY created_at, event_id`, [reviewId, providerUid],
  );
  return {
    ...providerReviewDto(result.rows[0]),
    dimensions: dimensions.rows.map((row: any) => ({ key: row.dimension_key, label: row.provider_label ?? row.dimension_key, score: Number(row.score), description: row.description ?? null })),
    timeline: timeline.rows.map((row: any) => ({ type: row.event_type, detail: row.public_detail ?? {}, createdAt: row.created_at })),
  };
}

export async function submitProviderResponse(providerUid: string, reviewId: string, input: { body: unknown; clientRequestId: unknown }) {
  await requireReputationSchema();
  const idempotency = requestId(input.clientRequestId);
  const body = safeText(input.body, 1000, 'Response');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const replay = await client.query(`SELECT response_id FROM ${s}.review_provider_responses WHERE provider_uid = $1 AND client_request_id = $2`, [providerUid, idempotency]);
    if (replay.rowCount) { await client.query('COMMIT'); return getOwnedProviderReview(providerUid, reviewId); }
    const review = await client.query(`SELECT review_id, created_at, publication_state FROM ${s}.customer_reviews WHERE review_id = $1 AND provider_uid = $2 FOR UPDATE`, [reviewId, providerUid]);
    if (!review.rowCount) throw fail('Review unavailable.', 'REVIEW_NOT_FOUND', 404);
    if (['REMOVED','WITHDRAWN','ARCHIVED'].includes(String(review.rows[0].publication_state))) throw fail('A response is unavailable for this review.', 'RESPONSE_NOT_AVAILABLE', 409);
    if (Date.now() - new Date(review.rows[0].created_at).getTime() > RESPONSE_WINDOW_DAYS * 86_400_000) throw fail('The response window has closed.', 'RESPONSE_WINDOW_EXPIRED', 409);
    const existing = await client.query(`SELECT 1 FROM ${s}.review_provider_responses WHERE review_id = $1 AND provider_uid = $2 AND deleted_at IS NULL`, [reviewId, providerUid]);
    if (existing.rowCount) throw fail('A response already exists for this review.', 'RESPONSE_ALREADY_EXISTS', 409);
    const moderation = providerResponseNeedsModeration(body) ? 'PENDING' : 'APPROVED';
    const publication = moderation === 'APPROVED' ? 'PUBLISHED' : 'PENDING_MODERATION';
    const inserted = await client.query(
      `INSERT INTO ${s}.review_provider_responses
        (review_id, provider_uid, body, moderation_status, publication_state, client_request_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING response_id`,
      [reviewId, providerUid, body, moderation, publication, idempotency],
    );
    if (moderation === 'PENDING') {
      await client.query(
        `INSERT INTO ${s}.review_response_moderation_cases
          (response_id, review_id, provider_uid, state)
         VALUES ($1,$2,$3,'PENDING_REVIEW')`,
        [inserted.rows[0].response_id, reviewId, providerUid],
      );
    }
    await client.query(`UPDATE ${s}.customer_reviews SET provider_response_state = $2, updated_at = NOW() WHERE review_id = $1`, [reviewId, publication]);
    await client.query(
      `INSERT INTO ${s}.review_reputation_events
        (review_id, provider_uid, event_type, actor_type, actor_uid, public_detail, idempotency_key)
       VALUES ($1,$2,'PROVIDER_RESPONSE_SUBMITTED','PROVIDER',$2,$3::jsonb,$4)`,
      [reviewId, providerUid, JSON.stringify({ state: publication }), `response:${idempotency}`],
    );
    await client.query('COMMIT');
    emitReputationUpdated(providerUid, 'PROVIDER_RESPONSE_SUBMITTED', reviewId);
    return getOwnedProviderReview(providerUid, reviewId);
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

export async function reportOwnedReview(providerUid: string, reviewId: string, input: { reason: unknown; details?: unknown; clientRequestId: unknown }) {
  await requireReputationSchema();
  const idempotency = requestId(input.clientRequestId);
  const reason = String(input.reason ?? '').toUpperCase();
  if (!(REPORT_REASONS as readonly string[]).includes(reason)) throw fail('Select a valid report reason.', 'INVALID_REPORT_REASON', 422);
  const details = input.details == null || String(input.details).trim() === '' ? null : safeText(input.details, 1000, 'Report context');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const replay = await client.query(`SELECT report_id FROM ${s}.review_reports WHERE reporter_uid = $1 AND client_request_id = $2`, [providerUid, idempotency]);
    if (replay.rowCount) { await client.query('COMMIT'); return getOwnedProviderReview(providerUid, reviewId); }
    const review = await client.query(`SELECT review_id FROM ${s}.customer_reviews WHERE review_id = $1 AND provider_uid = $2 FOR UPDATE`, [reviewId, providerUid]);
    if (!review.rowCount) throw fail('Review unavailable.', 'REVIEW_NOT_FOUND', 404);
    const report = await client.query(
      `INSERT INTO ${s}.review_reports
        (review_id, reporter_uid, reason, details, client_request_id, state)
       VALUES ($1,$2,$3,$4,$5,'SUBMITTED') RETURNING report_id`,
      [reviewId, providerUid, reason, details, idempotency],
    );
    const moderationCase = await client.query(
      `INSERT INTO ${s}.review_moderation_cases (review_id, report_id, state, public_effect)
       VALUES ($1,$2,'PENDING_REVIEW','UNCHANGED') RETURNING case_id`,
      [reviewId, report.rows[0].report_id],
    );
    await client.query(`UPDATE ${s}.customer_reviews SET moderation_status = 'REPORTED', updated_at = NOW(), version = version + 1 WHERE review_id = $1`, [reviewId]);
    await client.query(
      `INSERT INTO ${s}.review_reputation_events
        (review_id, provider_uid, event_type, actor_type, actor_uid, public_detail, idempotency_key)
       VALUES ($1,$2,'REVIEW_REPORTED','PROVIDER',$2,$3::jsonb,$4)`,
      [reviewId, providerUid, JSON.stringify({ caseId: moderationCase.rows[0].case_id, state: 'PENDING_REVIEW' }), `report:${idempotency}`],
    );
    await client.query('COMMIT');
    emitReputationUpdated(providerUid, 'REVIEW_REPORTED', reviewId);
    return getOwnedProviderReview(providerUid, reviewId);
  } catch (error: any) {
    await client.query('ROLLBACK');
    if (error?.code === '23505') throw fail('This review has already been reported.', 'REPORT_ALREADY_EXISTS', 409);
    throw error;
  } finally { client.release(); }
}

export async function appealOwnedReview(providerUid: string, caseId: string, input: { ground: unknown; explanation: unknown; clientRequestId: unknown }) {
  await requireReputationSchema();
  const idempotency = requestId(input.clientRequestId);
  const ground = String(input.ground ?? '').toUpperCase();
  if (!(APPEAL_GROUNDS as readonly string[]).includes(ground)) throw fail('Select a valid appeal ground.', 'INVALID_APPEAL_GROUND', 422);
  const explanation = safeText(input.explanation, 2000, 'Appeal explanation');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const replay = await client.query(`SELECT review_id FROM ${s}.review_appeals WHERE provider_uid = $1 AND client_request_id = $2`, [providerUid, idempotency]);
    if (replay.rowCount) { await client.query('COMMIT'); return getOwnedProviderReview(providerUid, replay.rows[0].review_id); }
    const moderationCase = await client.query(
      `SELECT mc.case_id, mc.review_id, mc.state, mc.decision_at
         FROM ${s}.review_moderation_cases mc
         JOIN ${s}.customer_reviews r ON r.review_id = mc.review_id
        WHERE mc.case_id = $1 AND r.provider_uid = $2 FOR UPDATE`,
      [caseId, providerUid],
    );
    if (!moderationCase.rowCount) throw fail('Moderation case unavailable.', 'MODERATION_CASE_NOT_FOUND', 404);
    const row = moderationCase.rows[0];
    if (!['APPROVED','REDACTED','REMOVED','RESTORED'].includes(String(row.state))) throw fail('This moderation decision is not currently appealable.', 'APPEAL_NOT_AVAILABLE', 409);
    if (!row.decision_at || Date.now() - new Date(row.decision_at).getTime() > APPEAL_WINDOW_DAYS * 86_400_000) throw fail('The appeal window has closed.', 'APPEAL_EXPIRED', 409);
    await client.query(
      `INSERT INTO ${s}.review_appeals
        (case_id, review_id, provider_uid, ground, explanation, client_request_id)
       VALUES ($1,$2,$3,$4,$5,$6)`, [caseId, row.review_id, providerUid, ground, explanation, idempotency],
    );
    await client.query(`UPDATE ${s}.customer_reviews SET appeal_state = 'SUBMITTED', updated_at = NOW(), version = version + 1 WHERE review_id = $1`, [row.review_id]);
    await client.query(
      `INSERT INTO ${s}.review_reputation_events
        (review_id, provider_uid, event_type, actor_type, actor_uid, public_detail, idempotency_key)
       VALUES ($1,$2,'APPEAL_SUBMITTED','PROVIDER',$2,$3::jsonb,$4)`,
      [row.review_id, providerUid, JSON.stringify({ state: 'SUBMITTED' }), `appeal:${idempotency}`],
    );
    await client.query('COMMIT');
    emitReputationUpdated(providerUid, 'APPEAL_SUBMITTED', String(row.review_id));
    return getOwnedProviderReview(providerUid, row.review_id);
  } catch (error: any) {
    await client.query('ROLLBACK');
    if (error?.code === '23505') throw fail('An appeal already exists for this decision.', 'APPEAL_ALREADY_EXISTS', 409);
    throw error;
  } finally { client.release(); }
}

export async function listModerationCases(filters: Record<string, unknown>) {
  await requireReputationSchema();
  const limit = Math.max(1, Math.min(Number(filters.limit ?? 25), 100));
  const values: any[] = [];
  const where: string[] = [];
  if (filters.state) { values.push(String(filters.state).toUpperCase()); where.push(`mc.state = $${values.length}`); }
  if (filters.providerUid) { values.push(String(filters.providerUid)); where.push(`r.provider_uid = $${values.length}`); }
  values.push(limit);
  const result = await dbQuery.query(
    `SELECT mc.case_id, mc.review_id, r.provider_uid, r.overall_rating, r.publication_state,
            mc.state, mc.public_effect, rr.reason, mc.provider_reason_code,
            mc.provider_reason_detail, mc.created_at, mc.updated_at, mc.version,
            EXISTS (SELECT 1 FROM ${s}.review_appeals a WHERE a.case_id = mc.case_id) AS has_appeal
       FROM ${s}.review_moderation_cases mc
       JOIN ${s}.customer_reviews r ON r.review_id = mc.review_id
       LEFT JOIN ${s}.review_reports rr ON rr.report_id = mc.report_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY mc.created_at DESC LIMIT $${values.length}`,
    values,
  );
  return result.rows.map((row: any) => ({
    caseId: String(row.case_id), reviewId: String(row.review_id), providerUid: String(row.provider_uid),
    rating: Number(row.overall_rating), publicationState: row.publication_state,
    state: row.state, publicEffect: row.public_effect, reportReason: row.reason ?? null,
    providerReasonCode: row.provider_reason_code ?? null, providerReasonDetail: row.provider_reason_detail ?? null,
    createdAt: row.created_at, updatedAt: row.updated_at, version: Number(row.version), hasAppeal: Boolean(row.has_appeal),
  }));
}

export async function decideModerationCase(adminUid: string, caseId: string, input: {
  decision: unknown; expectedVersion: unknown; providerReasonCode: unknown;
  providerReasonDetail: unknown; internalNotes?: unknown;
}) {
  await requireReputationSchema();
  const decision = String(input.decision ?? '').toUpperCase();
  const mapping: Record<string, { caseState: string; publication: string; moderation: string; effect: string }> = {
    APPROVE: { caseState: 'APPROVED', publication: 'PUBLISHED', moderation: 'APPROVED', effect: 'UNCHANGED' },
    REDACT: { caseState: 'REDACTED', publication: 'REDACTED', moderation: 'REDACTED', effect: 'TEXT_REDACTED' },
    REMOVE: { caseState: 'REMOVED', publication: 'REMOVED', moderation: 'REMOVED', effect: 'RATING_EXCLUDED' },
    RESTORE: { caseState: 'RESTORED', publication: 'PUBLISHED', moderation: 'RESTORED', effect: 'RATING_RESTORED' },
    REQUEST_INFORMATION: { caseState: 'ADDITIONAL_INFORMATION_REQUIRED', publication: 'HIDDEN_PENDING_REVIEW', moderation: 'PENDING', effect: 'TEMPORARILY_HIDDEN' },
    ESCALATE: { caseState: 'ESCALATED', publication: 'HIDDEN_PENDING_REVIEW', moderation: 'FLAGGED', effect: 'TEMPORARILY_HIDDEN' },
  };
  const next = mapping[decision];
  if (!next) throw fail('Invalid moderation decision.', 'INVALID_MODERATION_DECISION', 422);
  const expectedVersion = Number(input.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw fail('A current case version is required.', 'INVALID_VERSION', 400);
  const reasonCode = safeText(input.providerReasonCode, 64, 'Provider reason code').toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  const reasonDetail = safeText(input.providerReasonDetail, 1000, 'Provider explanation');
  const internalNotes = input.internalNotes == null ? null : String(input.internalNotes).trim().slice(0, 4000) || null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(
      `UPDATE ${s}.review_moderation_cases
          SET state = $2, public_effect = $3, provider_reason_code = $4,
              provider_reason_detail = $5, internal_notes = $6,
              decision_admin_uid = $7, decision_at = NOW(), updated_at = NOW(), version = version + 1
        WHERE case_id = $1 AND version = $8
        RETURNING review_id, version`,
      [caseId, next.caseState, next.effect, reasonCode, reasonDetail, internalNotes, adminUid, expectedVersion],
    );
    if (!updated.rowCount) throw fail('This moderation case changed. Refresh before deciding.', 'MODERATION_VERSION_CONFLICT', 409);
    const review = await client.query(
      `UPDATE ${s}.customer_reviews
          SET publication_state = $2, moderation_status = $3, updated_at = NOW(), version = version + 1
        WHERE review_id = $1 RETURNING provider_uid`,
      [updated.rows[0].review_id, next.publication, next.moderation],
    );
    const providerUid = String(review.rows[0].provider_uid);
    await client.query(
      `INSERT INTO ${s}.review_reputation_events
        (review_id, provider_uid, event_type, actor_type, actor_uid, public_detail, restricted_detail)
       VALUES ($1,$2,'MODERATION_DECISION','ADMIN',$3,$4::jsonb,$5::jsonb)`,
      [updated.rows[0].review_id, providerUid, adminUid,
       JSON.stringify({ state: next.caseState, reasonCode, reasonDetail }),
       JSON.stringify({ internalNotes })],
    );
    await recalculateProviderRating(providerUid, (sql, params = []) => client.query(sql, params));
    await client.query('COMMIT');
    emitReputationUpdated(providerUid, 'REVIEW_MODERATED', String(updated.rows[0].review_id));
    void createNotification(providerUid, {
      notificationKey: `review-moderated:${caseId}:${updated.rows[0].version}`,
      type: 'REVIEW_MODERATED', severity: 'info', title: 'Review moderation updated',
      safeBody: 'A moderation decision is available in Reviews & performance.',
      safeContextLabel: 'Reviews & performance',
      route: { screen: 'ReviewsPerformance' },
      canOpenDetail: true,
    }).catch(() => undefined);
    return { caseId, reviewId: String(updated.rows[0].review_id), state: next.caseState, version: Number(updated.rows[0].version) };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

export async function listResponseModerationCases(filters: Record<string, unknown>) {
  await requireReputationSchema();
  const limit = Math.max(1, Math.min(Number(filters.limit ?? 25), 100));
  const values: any[] = [];
  const where: string[] = [];
  if (filters.state) { values.push(String(filters.state).toUpperCase()); where.push(`mc.state = $${values.length}`); }
  if (filters.providerUid) { values.push(String(filters.providerUid)); where.push(`mc.provider_uid = $${values.length}`); }
  values.push(limit);
  const result = await dbQuery.query(
    `SELECT mc.case_id, mc.response_id, mc.review_id, mc.provider_uid, mc.state,
            mc.provider_reason_code, mc.provider_reason_detail, mc.created_at,
            mc.updated_at, mc.version, pr.body
       FROM ${s}.review_response_moderation_cases mc
       JOIN ${s}.review_provider_responses pr ON pr.response_id = mc.response_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY CASE WHEN mc.state = 'PENDING_REVIEW' THEN 0 ELSE 1 END,
               mc.created_at ASC LIMIT $${values.length}`,
    values,
  );
  return result.rows.map((row: any) => ({
    caseId: String(row.case_id), responseId: String(row.response_id),
    reviewId: String(row.review_id), providerUid: String(row.provider_uid),
    responseBody: row.body, state: row.state,
    providerReasonCode: row.provider_reason_code ?? null,
    providerReasonDetail: row.provider_reason_detail ?? null,
    createdAt: row.created_at, updatedAt: row.updated_at, version: Number(row.version),
  }));
}

export const responseModerationTransition = (decision: string) => ({
  APPROVE: { caseState: 'APPROVED', moderation: 'APPROVED', publication: 'PUBLISHED' },
  REJECT: { caseState: 'REJECTED', moderation: 'REJECTED', publication: 'REJECTED' },
  REQUEST_INFORMATION: { caseState: 'ADDITIONAL_INFORMATION_REQUIRED', moderation: 'PENDING', publication: 'PENDING_MODERATION' },
  ESCALATE: { caseState: 'ESCALATED', moderation: 'PENDING', publication: 'PENDING_MODERATION' },
}[decision.toUpperCase()] ?? null);

export async function decideResponseModerationCase(adminUid: string, caseId: string, input: {
  decision: unknown; expectedVersion: unknown; providerReasonCode: unknown;
  providerReasonDetail: unknown; internalNotes?: unknown;
}) {
  await requireReputationSchema();
  const next = responseModerationTransition(String(input.decision ?? ''));
  if (!next) throw fail('Invalid response moderation decision.', 'INVALID_RESPONSE_MODERATION_DECISION', 422);
  const expectedVersion = Number(input.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw fail('A current case version is required.', 'INVALID_VERSION', 400);
  const reasonCode = safeText(input.providerReasonCode, 64, 'Provider reason code').toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  const reasonDetail = safeText(input.providerReasonDetail, 1000, 'Provider explanation');
  const internalNotes = input.internalNotes == null ? null : String(input.internalNotes).trim().slice(0, 4000) || null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(
      `UPDATE ${s}.review_response_moderation_cases
          SET state = $2, provider_reason_code = $3, provider_reason_detail = $4,
              internal_notes = $5, decision_admin_uid = $6, decision_at = NOW(),
              updated_at = NOW(), version = version + 1
        WHERE case_id = $1 AND version = $7
        RETURNING response_id, review_id, provider_uid, version`,
      [caseId, next.caseState, reasonCode, reasonDetail, internalNotes, adminUid, expectedVersion],
    );
    if (!updated.rowCount) throw fail('This response case changed. Refresh before deciding.', 'MODERATION_VERSION_CONFLICT', 409);
    const row = updated.rows[0];
    await client.query(
      `UPDATE ${s}.review_provider_responses
          SET moderation_status = $2, publication_state = $3, updated_at = NOW(), version = version + 1
        WHERE response_id = $1`, [row.response_id, next.moderation, next.publication],
    );
    await client.query(
      `UPDATE ${s}.customer_reviews SET provider_response_state = $2, updated_at = NOW()
        WHERE review_id = $1`, [row.review_id, next.publication],
    );
    await client.query(
      `INSERT INTO ${s}.review_reputation_events
        (review_id, provider_uid, event_type, actor_type, actor_uid, public_detail, restricted_detail)
       VALUES ($1,$2,'PROVIDER_RESPONSE_MODERATED','ADMIN',$3,$4::jsonb,$5::jsonb)`,
      [row.review_id, row.provider_uid, adminUid,
       JSON.stringify({ state: next.caseState, reasonCode, reasonDetail }), JSON.stringify({ internalNotes })],
    );
    await client.query('COMMIT');
    const providerUid = String(row.provider_uid);
    const reviewId = String(row.review_id);
    emitReputationUpdated(providerUid, 'PROVIDER_RESPONSE_MODERATED', reviewId);
    void createNotification(providerUid, {
      notificationKey: `response-moderated:${caseId}:${row.version}`,
      type: 'PROVIDER_RESPONSE_MODERATED', severity: 'info', title: 'Review response updated',
      safeBody: 'A moderation decision is available for your review response.',
      safeContextLabel: 'Reviews & performance',
      route: { screen: 'ReviewsPerformance' }, canOpenDetail: true,
    }).catch(() => undefined);
    return { caseId, responseId: String(row.response_id), reviewId, state: next.caseState, version: Number(row.version) };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
