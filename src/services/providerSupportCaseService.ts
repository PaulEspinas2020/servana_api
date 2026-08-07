import { createHash, randomBytes } from 'crypto';
import dbQuery, { pool } from '../db/dbQuery';
import { db } from '../config';
import { assertBookingAccess } from './bookingAccessService';
import { createNotification } from './notification.service';
import { emitSupportCaseUpdated } from './supportRealtimeService';
import {
  APPEAL_GROUNDS, providerCaseActions, providerStateLabel,
  providerTimeExpectation, slaTargets,
} from './supportCasePolicy';
import { validateDataUri, AllowedUploadMime } from '../helpers/fileSignature';
import { assertCleanScan, scanProviderFile } from './providerManagedFileScanner';

const s = db.schema;
const ACTIVE_STATES = ['SUBMITTED','RECEIVED','WAITING_FOR_SERVANA','WAITING_FOR_PROVIDER','UNDER_REVIEW','ESCALATED','RESOLUTION_PROPOSED','REOPENED'];
const SOURCE_TYPES = ['ACCOUNT','BOOKING','CALENDAR','LEDGER_ENTRY','PAYOUT','WITHDRAWAL','REVIEW','SERVICE','DOCUMENT','MESSAGE'] as const;
const ALLOWED_UPLOADS = ['image/jpeg','image/png','image/webp','application/pdf'] as const;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
let schemaReady: Promise<void> | null = null;

const fail = (message: string, code: string, statusCode: number, data?: unknown) =>
  Object.assign(new Error(message), { code, statusCode, data });

const requireSchema = async () => {
  schemaReady ??= dbQuery.query(
    `SELECT to_regclass($1) AS cases, to_regclass($2) AS categories`,
    [`${s}.provider_support_cases`, `${s}.support_case_categories`],
  ).then(result => {
    if (!result.rows[0]?.cases || !result.rows[0]?.categories) {
      throw fail('Support case schema is not deployed. Apply migration 014.', 'SUPPORT_SCHEMA_NOT_DEPLOYED', 503);
    }
  });
  return schemaReady;
};

const requestId = (value: unknown) => {
  const id = String(value ?? '').trim();
  if (!/^[a-zA-Z0-9:_-]{16,128}$/.test(id)) throw fail('A valid client request id is required.', 'INVALID_IDEMPOTENCY_KEY', 400);
  return id;
};

const text = (value: unknown, min: number, max: number, field: string) => {
  const result = String(value ?? '').trim();
  if (result.length < min || result.length > max) throw fail(`${field} must be between ${min} and ${max} characters.`, 'INVALID_CASE_CONTENT', 422);
  return result;
};

const publicReference = () => `SUP-${new Date().getUTCFullYear()}-${randomBytes(5).toString('hex').toUpperCase()}`;

type AuthorizedSource = { sourceType: string; sourceId: string; safeLabel: string; sourceVersion: string | null };

async function authorizeSource(providerUid: string, rawType: unknown, rawId: unknown): Promise<AuthorizedSource | null> {
  if (rawType == null || String(rawType).trim() === '') return null;
  const sourceType = String(rawType).toUpperCase();
  if (!(SOURCE_TYPES as readonly string[]).includes(sourceType)) throw fail('Unsupported source type.', 'SOURCE_TYPE_INVALID', 422);
  const sourceId = String(rawId ?? '').trim();
  if (sourceType === 'ACCOUNT') return { sourceType, sourceId: providerUid, safeLabel: 'Provider account', sourceVersion: null };
  if (!sourceId) throw fail('Select an affected record.', 'SOURCE_REQUIRED', 422);

  if (sourceType === 'BOOKING') {
    const bookingId = Number(sourceId);
    const role = await assertBookingAccess(bookingId, providerUid);
    if (role !== 'provider') throw fail('Booking is unavailable.', 'SOURCE_ACCESS_DENIED', 403);
    const result = await dbQuery.query(`SELECT status, updated_at FROM ${s}.bookings WHERE id = $1`, [bookingId]);
    return { sourceType, sourceId: String(bookingId), safeLabel: `Booking SVN-${String(bookingId).padStart(6, '0')}`, sourceVersion: result.rows[0]?.updated_at?.toISOString?.() ?? null };
  }
  const lookups: Record<string, { sql: string; label: string }> = {
    REVIEW: { sql: `SELECT version FROM ${s}.customer_reviews WHERE review_id::text = $1 AND provider_uid = $2`, label: 'Provider review' },
    LEDGER_ENTRY: { sql: `SELECT updated_at AS version FROM ${s}.finance_ledger_entries WHERE id::text = $1 AND provider_uid = $2`, label: 'Earning ledger record' },
    PAYOUT: { sql: `SELECT updated_at AS version FROM ${s}.disbursements WHERE id::text = $1 AND worker_uid = $2`, label: 'Provider payout' },
    SERVICE: { sql: `SELECT updated_at AS version FROM ${s}.worker_service_applications WHERE id::text = $1 AND worker_uid = $2`, label: 'Provider service application' },
    DOCUMENT: { sql: `SELECT updated_at AS version FROM ${s}.worker_requirements WHERE id::text = $1 AND worker_uid = $2`, label: 'Provider requirement' },
  };
  const lookup = lookups[sourceType];
  if (!lookup) throw fail('This source integration is not available yet.', 'SOURCE_TYPE_UNAVAILABLE', 409);
  const result = await dbQuery.query(lookup.sql, [sourceId, providerUid]);
  if (!result.rowCount) throw fail('Affected record is unavailable.', 'SOURCE_ACCESS_DENIED', 403);
  const version = result.rows[0].version;
  return { sourceType, sourceId, safeLabel: lookup.label, sourceVersion: version == null ? null : String(version) };
}

const decodeCursor = (value: unknown): [boolean, string, string] | null => {
  if (!value) return null;
  try {
    const [action, updated, id] = Buffer.from(String(value), 'base64url').toString('utf8').split('|');
    return (action === '0' || action === '1') && !Number.isNaN(Date.parse(updated)) && id ? [action === '1', updated, id] : null;
  } catch { return null; }
};
const encodeCursor = (row: any) => Buffer.from(`${row.provider_action_required ? '1' : '0'}|${new Date(row.updated_at).toISOString()}|${row.case_id}`).toString('base64url');

const CASE_SELECT = `
  SELECT c.*, cat.provider_title AS category_title, cat.provider_description AS category_description,
         cat.reopen_window_days,
         CASE WHEN c.resolved_at IS NULL THEN NULL ELSE c.resolved_at + make_interval(days => cat.reopen_window_days) END AS reopen_deadline_at,
         r.resolution_id, r.provider_explanation AS resolution_explanation,
         a.appeal_id, a.state AS appeal_state
    FROM ${s}.provider_support_cases c
    JOIN ${s}.support_case_categories cat ON cat.category_id = c.category_id
    LEFT JOIN LATERAL (SELECT * FROM ${s}.support_case_resolutions x WHERE x.case_id = c.case_id ORDER BY x.applied_at DESC LIMIT 1) r ON TRUE
    LEFT JOIN LATERAL (SELECT * FROM ${s}.support_case_appeals x WHERE x.case_id = c.case_id ORDER BY x.submitted_at DESC LIMIT 1) a ON TRUE`;

const presentCase = (row: any) => ({
  id: String(row.case_id), reference: row.public_reference, domain: row.domain,
  category: { id: row.category_id, title: row.category_title, description: row.category_description },
  title: row.title, summary: String(row.provider_narrative).slice(0, 240),
  state: row.provider_state, stateLabel: providerStateLabel(row.provider_state),
  severity: row.severity, priority: row.priority,
  immediateDanger: Boolean(row.immediate_danger),
  providerActionRequired: Boolean(row.provider_action_required),
  servanaActionRequired: Boolean(row.servana_action_required),
  escalationState: row.escalation_state,
  timeExpectation: providerTimeExpectation(row),
  lastProviderVisibleUpdateAt: row.last_provider_visible_update_at,
  resolution: row.resolution_id ? { id: String(row.resolution_id), code: row.resolution_code, explanation: row.resolution_explanation } : null,
  appeal: row.appeal_id ? { id: String(row.appeal_id), state: row.appeal_state } : null,
  appealEligible: Boolean(row.appeal_eligible), appealDeadlineAt: row.appeal_deadline_at,
  version: Number(row.version), createdAt: row.created_at, updatedAt: row.updated_at,
  availableActions: providerCaseActions(row),
});

export async function listCategories() {
  await requireSchema();
  const result = await dbQuery.query(
    `SELECT category_id, domain, provider_title, provider_description, eligible_source_types,
            required_fields, evidence_policy, default_severity, policy_version
       FROM ${s}.support_case_categories WHERE active = TRUE ORDER BY domain, category_id`,
  );
  return result.rows.map((row: any) => ({
    id: row.category_id, domain: row.domain, title: row.provider_title,
    description: row.provider_description, eligibleSourceTypes: row.eligible_source_types,
    requiredFields: row.required_fields, evidencePolicy: row.evidence_policy,
    defaultSeverity: row.default_severity, policyVersion: Number(row.policy_version),
  }));
}

export async function listCases(providerUid: string, filters: Record<string, unknown>) {
  await requireSchema();
  const limit = Math.max(1, Math.min(Number(filters.limit ?? 20), 50));
  const values: any[] = [providerUid];
  const where = ['c.provider_uid = $1'];
  if (filters.domain) { values.push(String(filters.domain).toUpperCase()); where.push(`c.domain = $${values.length}`); }
  if (filters.state) { values.push(String(filters.state).toUpperCase()); where.push(`c.provider_state = $${values.length}`); }
  if (filters.actionRequired === 'true') where.push('c.provider_action_required = TRUE');
  if (filters.sourceType && filters.sourceId) {
    values.push(String(filters.sourceType).toUpperCase(), String(filters.sourceId));
    where.push(`EXISTS (SELECT 1 FROM ${s}.support_case_sources sx WHERE sx.case_id = c.case_id AND sx.source_type = $${values.length - 1} AND sx.source_id = $${values.length})`);
  }
  const cursor = decodeCursor(filters.cursor);
  if (cursor) {
    values.push(cursor[0], cursor[1], cursor[2]);
    where.push(`(c.provider_action_required, c.updated_at, c.case_id) < ($${values.length - 2}::boolean,$${values.length - 1}::timestamptz,$${values.length}::uuid)`);
  }
  values.push(limit + 1);
  const result = await dbQuery.query(
    `${CASE_SELECT} WHERE ${where.join(' AND ')}
      ORDER BY c.provider_action_required DESC, c.updated_at DESC, c.case_id DESC LIMIT $${values.length}`, values,
  );
  const rows = result.rows.slice(0, limit);
  return { cases: rows.map(presentCase), nextCursor: result.rows.length > limit && rows.length ? encodeCursor(rows[rows.length - 1]) : null };
}

async function ownedCase(providerUid: string, caseId: string, run = dbQuery.query.bind(dbQuery)) {
  const result = await run(`${CASE_SELECT} WHERE c.case_id = $1 AND c.provider_uid = $2`, [caseId, providerUid]);
  if (!result.rowCount) throw fail('Support case not found.', 'CASE_NOT_FOUND', 404);
  return result.rows[0];
}

export async function getCase(providerUid: string, caseId: string) {
  await requireSchema();
  const row = await ownedCase(providerUid, caseId);
  const [sources, messages, timeline, attachments] = await Promise.all([
    dbQuery.query(`SELECT source_type, source_id, safe_label, source_version, linked_at FROM ${s}.support_case_sources WHERE case_id = $1 AND provider_uid = $2 ORDER BY linked_at`, [caseId, providerUid]),
    dbQuery.query(`SELECT message_id, sender_type, provider_visible_body, created_at FROM ${s}.support_case_messages WHERE case_id = $1 ORDER BY created_at, message_id`, [caseId]),
    dbQuery.query(`SELECT event_id, event_type, provider_label, public_detail, created_at FROM ${s}.support_case_events WHERE case_id = $1 AND provider_visible = TRUE ORDER BY created_at, event_id`, [caseId]),
    dbQuery.query(`SELECT attachment_id, safe_file_name, mime_type, byte_size, evidence_class, state, created_at FROM ${s}.support_case_attachments WHERE case_id = $1 AND provider_uid = $2 ORDER BY created_at`, [caseId, providerUid]),
  ]);
  const safeSources = await Promise.all(sources.rows.map(async (x: any) => {
    try {
      await authorizeSource(providerUid, x.source_type, x.source_id);
      return { type: x.source_type, safeLabel: x.safe_label, available: true, linkedAt: x.linked_at };
    } catch {
      // Preserve the case history without returning a source identifier that is
      // no longer authorized for this provider/session.
      return { type: x.source_type, safeLabel: x.safe_label, available: false, linkedAt: x.linked_at };
    }
  }));
  return {
    ...presentCase(row), narrative: row.provider_narrative, desiredOutcome: row.desired_outcome,
    sources: safeSources,
    messages: messages.rows.map((x: any) => ({ id: String(x.message_id), senderType: x.sender_type, body: x.provider_visible_body, createdAt: x.created_at })),
    timeline: timeline.rows.map((x: any) => ({ id: String(x.event_id), type: x.event_type, label: x.provider_label, detail: x.public_detail, createdAt: x.created_at })),
    attachments: attachments.rows.map((x: any) => ({ id: String(x.attachment_id), fileName: x.safe_file_name, mimeType: x.mime_type, byteSize: Number(x.byte_size), evidenceClass: x.evidence_class, state: x.state, createdAt: x.created_at })),
  };
}

export async function createCase(providerUid: string, input: Record<string, unknown>) {
  await requireSchema();
  const idempotency = requestId(input.clientRequestId);
  const categoryId = String(input.categoryId ?? '').toUpperCase();
  const categoryResult = await dbQuery.query(`SELECT * FROM ${s}.support_case_categories WHERE category_id = $1 AND active = TRUE`, [categoryId]);
  if (!categoryResult.rowCount) throw fail('Select a valid support category.', 'CATEGORY_NOT_AVAILABLE', 422);
  const category = categoryResult.rows[0];
  const source = await authorizeSource(providerUid, input.sourceEntityType, input.sourceEntityId);
  const eligible = Array.isArray(category.eligible_source_types) ? category.eligible_source_types : [];
  if (source && !eligible.includes(source.sourceType)) throw fail('This record cannot be linked to the selected category.', 'SOURCE_NOT_ELIGIBLE', 422);
  const requiredFields = Array.isArray(category.required_fields) ? category.required_fields : [];
  if (requiredFields.includes('sourceEntityId') && !source) throw fail('Select the affected record.', 'SOURCE_REQUIRED', 422);
  const emergency = categoryId === 'EMERGENCY_INCIDENT' || Boolean(input.immediateDanger);
  const narrative = emergency && !String(input.narrative ?? '').trim()
    ? 'Provider created a minimal urgent safety incident record.'
    : text(input.narrative, 10, 4000, 'Description');
  const title = input.title == null || !String(input.title).trim()
    ? String(category.provider_title)
    : text(input.title, 3, 160, 'Title');
  const desiredOutcome = input.desiredOutcome == null || !String(input.desiredOutcome).trim()
    ? null : text(input.desiredOutcome, 3, 1000, 'Desired help');
  const policySeverity = emergency ? 'CRITICAL' : String(category.default_severity);
  const priority = policySeverity === 'CRITICAL' ? 'URGENT' : policySeverity === 'HIGH' ? 'HIGH' : 'NORMAL';
  const targets = slaTargets(String(category.sla_policy_code), policySeverity);
  const client = await pool.connect();
  let caseId = '';
  let duplicate = false;
  try {
    await client.query('BEGIN');
    const replay = await client.query(`SELECT case_id FROM ${s}.provider_support_cases WHERE provider_uid = $1 AND client_request_id = $2`, [providerUid, idempotency]);
    if (replay.rowCount) {
      caseId = String(replay.rows[0].case_id);
      duplicate = true;
      await client.query('COMMIT');
      return { ...(await getCase(providerUid, caseId)), duplicate: true, duplicateReason: 'IDEMPOTENT_REPLAY' };
    }
    const duplicateLock = `${providerUid}:${categoryId}:${source?.sourceType ?? 'NONE'}:${source?.sourceId ?? 'NONE'}`;
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [duplicateLock]);
    if (category.domain !== 'SAFETY' && source && !Boolean(input.confirmDistinctIssue)) {
      const existing = await client.query(
        `SELECT c.case_id FROM ${s}.provider_support_cases c
          JOIN ${s}.support_case_sources sx ON sx.case_id = c.case_id
         WHERE c.provider_uid = $1 AND c.category_id = $2
           AND sx.source_type = $3 AND sx.source_id = $4
           AND c.provider_state = ANY($5::text[])
         ORDER BY c.created_at DESC LIMIT 1`,
        [providerUid, categoryId, source.sourceType, source.sourceId, ACTIVE_STATES],
      );
      if (existing.rowCount) {
        caseId = String(existing.rows[0].case_id);
        duplicate = true;
        await client.query('COMMIT');
        return { ...(await getCase(providerUid, caseId)), duplicate: true, duplicateReason: 'ACTIVE_SOURCE_CASE' };
      }
    }
    const inserted = await client.query(
      `INSERT INTO ${s}.provider_support_cases
        (public_reference, provider_uid, account_uid, domain, category_id, title,
         provider_narrative, desired_outcome, provider_state, internal_state,
         severity, priority, safety_classification, immediate_danger, current_queue,
         sla_policy_code, first_response_target_at, resolution_target_at,
         escalation_due_at, client_request_id, policy_version)
       VALUES ($1,$2,$2,$3,$4,$5,$6,$7,'SUBMITTED','NEW',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING case_id`,
      [publicReference(), providerUid, category.domain, categoryId, title, narrative,
       desiredOutcome, policySeverity, priority, category.domain === 'SAFETY' ? categoryId : 'NONE',
       emergency, category.routing_queue, category.sla_policy_code,
       targets.firstResponseTargetAt, targets.resolutionTargetAt, targets.escalationDueAt,
       idempotency, category.policy_version],
    );
    caseId = String(inserted.rows[0].case_id);
    if (source) {
      await client.query(
        `INSERT INTO ${s}.support_case_sources
          (case_id, provider_uid, source_type, source_id, safe_label, source_version)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [caseId, providerUid, source.sourceType, source.sourceId, source.safeLabel, source.sourceVersion],
      );
    }
    await client.query(
      `INSERT INTO ${s}.support_case_events
        (case_id, event_type, actor_type, actor_uid, provider_label, public_detail, idempotency_key)
       VALUES ($1,'CASE_SUBMITTED','PROVIDER',$2,'Case submitted',$3::jsonb,$4)`,
      [caseId, providerUid, JSON.stringify({ state: 'SUBMITTED' }), `create:${idempotency}`],
    );
    await client.query('COMMIT');
  } catch (error: any) {
    await client.query('ROLLBACK');
    if (error?.code === '23505') {
      const replay = await dbQuery.query(`SELECT case_id FROM ${s}.provider_support_cases WHERE provider_uid = $1 AND client_request_id = $2`, [providerUid, idempotency]);
      if (replay.rowCount) return { ...(await getCase(providerUid, String(replay.rows[0].case_id))), duplicate: true, duplicateReason: 'IDEMPOTENT_REPLAY' };
    }
    throw error;
  } finally { client.release(); }
  emitSupportCaseUpdated(providerUid, caseId, 'CASE_SUBMITTED');
  void createNotification(providerUid, {
    notificationKey: `support-case-created:${caseId}`,
    type: category.domain === 'SAFETY' ? 'SAFETY_CASE_RECEIVED' : 'SUPPORT_CASE_RECEIVED',
    severity: category.domain === 'SAFETY' ? 'high' : 'info',
    title: category.domain === 'SAFETY' ? 'Safety report received' : 'Support case received',
    safeBody: 'Your case was recorded. Open Support Center for its current status.',
    safeContextLabel: 'Support Center', route: { screen: 'SupportCase', caseId }, canOpenDetail: true,
  }).catch(() => undefined);
  return { ...(await getCase(providerUid, caseId)), duplicate };
}

export async function addProviderMessage(providerUid: string, caseId: string, input: Record<string, unknown>) {
  await requireSchema();
  const idempotency = requestId(input.clientRequestId);
  const body = text(input.message, 2, 4000, 'Message');
  const expectedVersion = Number(input.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw fail('Current case version is required.', 'INVALID_VERSION', 400);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const replay = await client.query(`SELECT message_id FROM ${s}.support_case_messages WHERE case_id = $1 AND sender_type = 'PROVIDER' AND client_request_id = $2`, [caseId, idempotency]);
    if (replay.rowCount) { await client.query('COMMIT'); return getCase(providerUid, caseId); }
    const row = await client.query(`SELECT provider_state FROM ${s}.provider_support_cases WHERE case_id = $1 AND provider_uid = $2 AND version = $3 FOR UPDATE`, [caseId, providerUid, expectedVersion]);
    if (!row.rowCount) throw fail('Case changed. Refresh before replying.', 'CASE_VERSION_CONFLICT', 409);
    if (['RESOLVED','CLOSED','CANCELLED'].includes(String(row.rows[0].provider_state))) throw fail('This case is not open for replies.', 'CASE_ACTION_UNAVAILABLE', 409);
    await client.query(
      `INSERT INTO ${s}.support_case_messages (case_id, sender_type, sender_uid, provider_visible_body, client_request_id)
       VALUES ($1,'PROVIDER',$2,$3,$4)`, [caseId, providerUid, body, idempotency],
    );
    await client.query(
      `UPDATE ${s}.provider_support_cases
          SET provider_state = 'WAITING_FOR_SERVANA', internal_state = 'ASSIGNED',
              provider_action_required = FALSE, servana_action_required = TRUE,
              updated_at = NOW(), last_provider_visible_update_at = NOW(), version = version + 1
        WHERE case_id = $1`, [caseId],
    );
    await client.query(
      `INSERT INTO ${s}.support_case_events
        (case_id,event_type,actor_type,actor_uid,provider_label,public_detail,idempotency_key)
       VALUES ($1,'PROVIDER_REPLIED','PROVIDER',$2,'Information submitted','{}'::jsonb,$3)`,
      [caseId, providerUid, `message:${idempotency}`],
    );
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  emitSupportCaseUpdated(providerUid, caseId, 'PROVIDER_REPLIED');
  return getCase(providerUid, caseId);
}

export async function withdrawCase(providerUid: string, caseId: string, input: Record<string, unknown>) {
  await requireSchema();
  const idempotency = requestId(input.clientRequestId);
  const expectedVersion = Number(input.expectedVersion);
  const reason = text(input.reason, 3, 1000, 'Withdrawal reason');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const replay = await client.query(
      `SELECT 1 FROM ${s}.support_case_events e JOIN ${s}.provider_support_cases c ON c.case_id = e.case_id
        WHERE e.case_id = $1 AND c.provider_uid = $2 AND e.idempotency_key = $3`,
      [caseId, providerUid, `withdraw:${idempotency}`],
    );
    if (replay.rowCount) { await client.query('COMMIT'); return getCase(providerUid, caseId); }
    const updated = await client.query(
      `UPDATE ${s}.provider_support_cases SET provider_state = 'CANCELLED', internal_state = 'CLOSED',
              provider_action_required = FALSE, servana_action_required = FALSE,
              closed_at = NOW(), updated_at = NOW(), last_provider_visible_update_at = NOW(), version = version + 1
        WHERE case_id = $1 AND provider_uid = $2 AND version = $3 AND domain <> 'SAFETY'
          AND provider_state = ANY($4::text[]) RETURNING case_id`,
      [caseId, providerUid, expectedVersion, ACTIVE_STATES],
    );
    if (!updated.rowCount) throw fail('This case cannot be withdrawn. Refresh its current state.', 'CASE_ACTION_UNAVAILABLE', 409);
    await client.query(
      `INSERT INTO ${s}.support_case_events
        (case_id,event_type,actor_type,actor_uid,provider_label,public_detail,idempotency_key)
       VALUES ($1,'CASE_WITHDRAWN','PROVIDER',$2,'Case withdrawn',$3::jsonb,$4) ON CONFLICT DO NOTHING`,
      [caseId, providerUid, JSON.stringify({ reason }), `withdraw:${idempotency}`],
    );
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  emitSupportCaseUpdated(providerUid, caseId, 'CASE_WITHDRAWN');
  return getCase(providerUid, caseId);
}

export async function reopenCase(providerUid: string, caseId: string, input: Record<string, unknown>) {
  await requireSchema();
  const idempotency = requestId(input.clientRequestId);
  const expectedVersion = Number(input.expectedVersion);
  const reason = text(input.reason, 10, 2000, 'Reopen reason');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const replay = await client.query(
      `SELECT 1 FROM ${s}.support_case_events e JOIN ${s}.provider_support_cases c ON c.case_id = e.case_id
        WHERE e.case_id = $1 AND c.provider_uid = $2 AND e.idempotency_key = $3`,
      [caseId, providerUid, `reopen:${idempotency}`],
    );
    if (replay.rowCount) { await client.query('COMMIT'); return getCase(providerUid, caseId); }
    const updated = await client.query(
      `UPDATE ${s}.provider_support_cases c SET provider_state = 'REOPENED', internal_state = 'NEW',
              provider_action_required = FALSE, servana_action_required = TRUE,
              resolved_at = NULL, closed_at = NULL, updated_at = NOW(),
              last_provider_visible_update_at = NOW(), version = version + 1
        FROM ${s}.support_case_categories cat
       WHERE c.case_id = $1 AND c.provider_uid = $2 AND c.version = $3
         AND c.category_id = cat.category_id AND c.provider_state IN ('RESOLVED','CLOSED')
         AND COALESCE(c.resolved_at,c.closed_at) + make_interval(days => cat.reopen_window_days) >= NOW()
       RETURNING c.case_id`, [caseId, providerUid, expectedVersion],
    );
    if (!updated.rowCount) throw fail('This case is not eligible to reopen.', 'CASE_REOPEN_UNAVAILABLE', 409);
    await client.query(
      `INSERT INTO ${s}.support_case_messages (case_id,sender_type,sender_uid,provider_visible_body,client_request_id)
       VALUES ($1,'PROVIDER',$2,$3,$4)`, [caseId, providerUid, reason, `reopen:${idempotency}`],
    );
    await client.query(
      `INSERT INTO ${s}.support_case_events
        (case_id,event_type,actor_type,actor_uid,provider_label,public_detail,idempotency_key)
       VALUES ($1,'CASE_REOPENED','PROVIDER',$2,'Case reopened','{}'::jsonb,$3)`,
      [caseId, providerUid, `reopen:${idempotency}`],
    );
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  emitSupportCaseUpdated(providerUid, caseId, 'CASE_REOPENED');
  return getCase(providerUid, caseId);
}

export async function appealCase(providerUid: string, caseId: string, input: Record<string, unknown>) {
  await requireSchema();
  const idempotency = requestId(input.clientRequestId);
  const ground = String(input.ground ?? '').toUpperCase();
  if (!(APPEAL_GROUNDS as readonly string[]).includes(ground)) throw fail('Select a valid appeal ground.', 'INVALID_APPEAL_GROUND', 422);
  const explanation = text(input.explanation, 20, 3000, 'Appeal explanation');
  const expectedVersion = Number(input.expectedVersion);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const replay = await client.query(`SELECT appeal_id FROM ${s}.support_case_appeals WHERE provider_uid = $1 AND client_request_id = $2`, [providerUid, idempotency]);
    if (replay.rowCount) { await client.query('COMMIT'); return getCase(providerUid, caseId); }
    const found = await client.query(
      `SELECT c.case_id, r.resolution_id FROM ${s}.provider_support_cases c
        JOIN LATERAL (SELECT * FROM ${s}.support_case_resolutions x WHERE x.case_id = c.case_id ORDER BY x.applied_at DESC LIMIT 1) r ON TRUE
       WHERE c.case_id = $1 AND c.provider_uid = $2 AND c.version = $3
         AND c.appeal_eligible = TRUE AND c.appeal_deadline_at >= NOW() FOR UPDATE OF c`,
      [caseId, providerUid, expectedVersion],
    );
    if (!found.rowCount) throw fail('This resolution is not currently appealable.', 'CASE_APPEAL_UNAVAILABLE', 409);
    await client.query(
      `INSERT INTO ${s}.support_case_appeals
        (case_id,provider_uid,resolution_id,ground,explanation,client_request_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [caseId, providerUid, found.rows[0].resolution_id, ground, explanation, idempotency],
    );
    await client.query(
      `UPDATE ${s}.provider_support_cases SET provider_state = 'UNDER_REVIEW', internal_state = 'QUALITY_REVIEW',
              provider_action_required = FALSE, servana_action_required = TRUE,
              updated_at = NOW(), last_provider_visible_update_at = NOW(), version = version + 1
        WHERE case_id = $1`, [caseId],
    );
    await client.query(
      `INSERT INTO ${s}.support_case_events
        (case_id,event_type,actor_type,actor_uid,provider_label,public_detail,idempotency_key)
       VALUES ($1,'APPEAL_SUBMITTED','PROVIDER',$2,'Appeal submitted',$3::jsonb,$4)`,
      [caseId, providerUid, JSON.stringify({ state: 'SUBMITTED' }), `appeal:${idempotency}`],
    );
    await client.query('COMMIT');
  } catch (error: any) {
    await client.query('ROLLBACK');
    if (error?.code === '23505') throw fail('An appeal already exists for this resolution.', 'APPEAL_ALREADY_EXISTS', 409);
    throw error;
  } finally { client.release(); }
  emitSupportCaseUpdated(providerUid, caseId, 'APPEAL_SUBMITTED');
  return getCase(providerUid, caseId);
}

export async function uploadAttachment(providerUid: string, caseId: string, input: Record<string, unknown>) {
  await requireSchema();
  const idempotency = requestId(input.clientRequestId);
  const expectedVersion = Number(input.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw fail('Current case version is required.', 'INVALID_VERSION', 400);
  const fileName = text(input.fileName, 1, 180, 'File name').replace(/[^a-zA-Z0-9._ -]/g, '_');
  const evidenceClass = String(input.evidenceClass ?? 'STANDARD').toUpperCase();
  if (!['STANDARD','FINANCIAL','SAFETY','MEDICAL'].includes(evidenceClass)) throw fail('Invalid evidence classification.', 'INVALID_EVIDENCE_CLASS', 422);
  const validation = validateDataUri(String(input.file ?? ''), { allowed: ALLOWED_UPLOADS as readonly AllowedUploadMime[], maxBytes: MAX_ATTACHMENT_BYTES });
  if (!validation.ok) throw fail(validation.message, validation.code, 422);
  const scan = await scanProviderFile({ buffer: validation.buffer, mimeType: validation.mime, fileName });
  assertCleanScan(scan);
  const bytes = scan.sanitizedBuffer ?? validation.buffer;
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const prior = await dbQuery.query(
    `SELECT attachment_id FROM ${s}.support_case_attachments WHERE provider_uid = $1 AND client_request_id = $2`, [providerUid, idempotency],
  );
  if (prior.rowCount) return getCase(providerUid, caseId);
  const owned = await dbQuery.query(
    `SELECT domain, provider_state FROM ${s}.provider_support_cases WHERE case_id = $1 AND provider_uid = $2 AND version = $3`,
    [caseId, providerUid, expectedVersion],
  );
  if (!owned.rowCount) throw fail('Case changed. Refresh before adding evidence.', 'CASE_VERSION_CONFLICT', 409);
  if (['CLOSED','CANCELLED'].includes(String(owned.rows[0].provider_state))) throw fail('Evidence cannot be added to this case.', 'CASE_ACTION_UNAVAILABLE', 409);
  if (['SAFETY','MEDICAL'].includes(evidenceClass) && owned.rows[0].domain !== 'SAFETY') throw fail('Sensitive safety evidence can only be attached to a safety case.', 'EVIDENCE_CLASS_MISMATCH', 422);
  const dataUri = `data:${validation.mime};base64,${bytes.toString('base64')}`;
  const { uploadPrivateFileToStorage, deletePrivateStoredFile } = await import('../helpers/firebaseStorageUploader');
  const stored = await uploadPrivateFileToStorage(`provider-support/${providerUid}/${caseId}`, idempotency, dataUri);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(
      `UPDATE ${s}.provider_support_cases SET updated_at = NOW(), version = version + 1
        WHERE case_id = $1 AND provider_uid = $2 AND version = $3 RETURNING case_id`,
      [caseId, providerUid, expectedVersion],
    );
    if (!updated.rowCount) throw fail('Case changed. Refresh before adding evidence.', 'CASE_VERSION_CONFLICT', 409);
    await client.query(
      `INSERT INTO ${s}.support_case_attachments
        (case_id,provider_uid,private_storage_path,safe_file_name,mime_type,byte_size,
         content_sha256,scan_status,scanner_engine,evidence_class,client_request_id,retention_until)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'clean',$8,$9,$10,NOW() + INTERVAL '365 days')`,
      [caseId, providerUid, stored.storagePath, fileName, validation.mime, stored.byteSize,
       sha256, scan.engine, evidenceClass, idempotency],
    );
    await client.query(
      `INSERT INTO ${s}.support_case_events
        (case_id,event_type,actor_type,actor_uid,provider_label,public_detail,idempotency_key)
       VALUES ($1,'EVIDENCE_SUBMITTED','PROVIDER',$2,'Evidence submitted',$3::jsonb,$4)`,
      [caseId, providerUid, JSON.stringify({ fileName, evidenceClass }), `attachment:${idempotency}`],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    await deletePrivateStoredFile(stored.storagePath).catch(() => undefined);
    throw error;
  } finally { client.release(); }
  emitSupportCaseUpdated(providerUid, caseId, 'EVIDENCE_SUBMITTED');
  return getCase(providerUid, caseId);
}

export async function previewAttachment(providerUid: string, caseId: string, attachmentId: string) {
  await requireSchema();
  const found = await dbQuery.query(
    `SELECT private_storage_path,mime_type,safe_file_name FROM ${s}.support_case_attachments
      WHERE attachment_id = $1 AND case_id = $2 AND provider_uid = $3 AND state = 'AVAILABLE'`,
    [attachmentId, caseId, providerUid],
  );
  if (!found.rowCount) throw fail('Evidence is unavailable.', 'EVIDENCE_NOT_FOUND', 404);
  const { createPrivatePreviewUrl } = await import('../helpers/firebaseStorageUploader');
  return { attachmentId, fileName: found.rows[0].safe_file_name, mimeType: found.rows[0].mime_type, ...(await createPrivatePreviewUrl(found.rows[0].private_storage_path, 180)) };
}
