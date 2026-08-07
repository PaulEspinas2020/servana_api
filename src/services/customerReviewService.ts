import dbQuery, { pool } from "../db/dbQuery";
import { db } from "../config";
import { createNotification } from './notification.service';
import { getPublicRatingSummary, recalculateProviderRating, QueryRunner } from './ratingAggregationService';
import { emitReputationUpdated } from './reputationRealtimeService';

const dbSchema = db.schema;

// ─── Constants ────────────────────────────────────────────────────────────────

const REVIEW_WINDOW_DAYS   = 14;
const EDIT_WINDOW_HOURS    = 48;
const MIN_RATING           = 1;
const MAX_RATING           = 5;
const MAX_COMMENT_LENGTH   = 2000;
const MAX_PRIVATE_LENGTH   = 2000;
const VALID_DIMENSIONS     = new Set([
  'SERVICE_QUALITY', 'PROFESSIONALISM', 'PUNCTUALITY',
  'COMMUNICATION', 'CLEANLINESS', 'SCOPE_ADHERENCE',
]);

// ─── Lazy table init ──────────────────────────────────────────────────────────

let tablesReady: Promise<void> | null = null;

async function initTables(): Promise<void> {
  const result = await dbQuery.query(`SELECT to_regclass('${dbSchema}.customer_reviews') AS table_name`);
  if (!result.rows[0]?.table_name) {
    throw Object.assign(new Error('Review schema is not deployed. Apply migration 012.'), {
      code: 'REVIEW_SCHEMA_NOT_DEPLOYED', statusCode: 503,
    });
  }
}

export function ensureReviewTables(): Promise<void> {
  if (!tablesReady) tablesReady = initTables();
  return tablesReady;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ReviewEligibilityResult {
  bookingId:        string;
  eligible:         boolean;
  reason:           string | null;
  reviewId:         string | null;
  reviewWindow:     { opensAt: string; closesAt: string } | null;
  editableUntil:    string | null;
  availableActions: string[];
}

export interface CreateReviewPayload {
  bookingId:       string;
  customerUid:     string;
  overallRating:   number;
  dimensions:      Record<string, number>;
  publicComment:   string | null;
  privateFeedback: string | null;
  visibility:      string;
  clientRequestId: string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getBookingForReview(
  bookingId: string,
  customerUid: string,
  runner: QueryRunner = (sql, params = []) => dbQuery.query(sql, params),
) {
  // Fetch booking, verify ownership, get provider + service
  const res = await runner(
    `SELECT
       b.id::text        AS id,
       b.user_id         AS customer_uid,
       b.status,
       so.service_id::text AS service_id,
       bw.worker_uid     AS provider_uid,
       bw.status         AS assignment_status,
       bw.completed_at,
       uc.account_status AS customer_account_status,
       uc.role           AS customer_role
     FROM ${dbSchema}.bookings b
     LEFT JOIN ${dbSchema}.service_options so ON so.id = b.service_option_id
     LEFT JOIN ${dbSchema}.booking_workers bw
       ON bw.booking_id = b.id
       AND bw.status = 'COMPLETED'
     LEFT JOIN ${dbSchema}.user_credentials uc ON uc.uid = b.user_id
     WHERE b.id = $1::bigint
     ORDER BY bw.completed_at DESC NULLS LAST
     LIMIT 1`,
    [bookingId]
  );
  if (!res.rows.length) return null;
  const row = res.rows[0];
  if (row.customer_uid !== customerUid) return null; // not owner
  return row as {
    id: string;
    customer_uid: string;
    status: string;
    service_id: string | null;
    provider_uid: string | null;
    assignment_status: string | null;
    completed_at: Date | null;
    customer_account_status: string | null;
    customer_role: number | string | null;
  };
}

async function getExistingReview(bookingId: string, customerUid: string, runner: QueryRunner = (sql, params = []) => dbQuery.query(sql, params)) {
  const res = await runner(
    `SELECT review_id::text, overall_rating, created_at, edited_at, deleted_at
     FROM ${dbSchema}.customer_reviews
     WHERE booking_id = $1 AND customer_uid = $2
     ORDER BY deleted_at NULLS FIRST, created_at DESC
     LIMIT 1`,
    [bookingId, customerUid]
  );
  return res.rows.length ? res.rows[0] : null;
}

function reviewWindowFor(completedAt: Date | null): { opens: Date; closes: Date } {
  if (!completedAt) throw Object.assign(new Error('BOOKING_COMPLETION_NOT_FINALIZED'), { code: 'REVIEW_NOT_ELIGIBLE', status: 422 });
  const base = completedAt;
  const closes = new Date(base.getTime() + REVIEW_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return { opens: base, closes };
}

const reviewContentNeedsModeration = (text: string | null): boolean => Boolean(text &&
  /(?:\b\+?63\d{9,10}\b|\b\d{10,11}\b|[\w.+-]+@[\w.-]+\.[a-z]{2,}|https?:\/\/|\b(?:theft|injury|threat|harass|fraud)\b)/i.test(text));

// ─── Eligibility ─────────────────────────────────────────────────────────────

export async function getReviewEligibility(
  bookingId: string,
  customerUid: string
): Promise<ReviewEligibilityResult> {
  const base: ReviewEligibilityResult = {
    bookingId,
    eligible: false,
    reason: null,
    reviewId: null,
    reviewWindow: null,
    editableUntil: null,
    availableActions: [],
  };

  const booking = await getBookingForReview(bookingId, customerUid);
  if (!booking) {
    return { ...base, reason: 'BOOKING_NOT_OWNED' };
  }

  if (Number(booking.customer_role) !== 3 || booking.customer_account_status !== 'active') {
    return { ...base, reason: 'REVIEW_RESTRICTED' };
  }

  if (!booking.provider_uid || booking.provider_uid === customerUid) {
    return { ...base, reason: 'BOOKING_INVALID' };
  }

  const status = (booking.status || '').toUpperCase();
  const assignmentStatus = (booking.assignment_status || '').toUpperCase();
  if (!['COMPLETED', 'REVIEWED'].includes(status) || assignmentStatus !== 'COMPLETED' || !booking.completed_at) {
    const notCompleted =
      status === 'CANCELLED' ? 'BOOKING_CANCELLED' : 'BOOKING_NOT_COMPLETED';
    return { ...base, reason: notCompleted };
  }

  const existing = await getExistingReview(bookingId, customerUid);

  if (existing && existing.deleted_at) {
    // Soft-deleted — treat as new for eligibility
  } else if (existing) {
    const { opens, closes } = reviewWindowFor(booking.completed_at);
    const now = new Date();
    const editDeadline = new Date(
      existing.created_at.getTime() + EDIT_WINDOW_HOURS * 60 * 60 * 1000
    );
    const canEdit = now < editDeadline && now < closes;
    return {
      ...base,
      eligible: false,
      reason: 'REVIEW_ALREADY_SUBMITTED',
      reviewId: existing.review_id,
      reviewWindow: { opensAt: opens.toISOString(), closesAt: closes.toISOString() },
      editableUntil: canEdit ? editDeadline.toISOString() : null,
      availableActions: canEdit ? ['EDIT_REVIEW', 'DELETE_REVIEW'] : ['VIEW_REVIEW'],
    };
  }

  const { opens, closes } = reviewWindowFor(booking.completed_at);
  const now = new Date();
  if (now < opens) {
    return { ...base, reason: 'REVIEW_WINDOW_NOT_OPEN', reviewWindow: { opensAt: opens.toISOString(), closesAt: closes.toISOString() } };
  }
  if (now > closes) {
    return { ...base, reason: 'REVIEW_WINDOW_EXPIRED', reviewWindow: { opensAt: opens.toISOString(), closesAt: closes.toISOString() } };
  }

  return {
    ...base,
    eligible: true,
    reason: null,
    reviewWindow: { opensAt: opens.toISOString(), closesAt: closes.toISOString() },
    availableActions: ['CREATE_REVIEW'],
  };
}

// ─── Create review ────────────────────────────────────────────────────────────

export async function createReview(payload: CreateReviewPayload) {
  const {
    bookingId, customerUid, overallRating, dimensions,
    publicComment, privateFeedback, visibility, clientRequestId,
  } = payload;

  // Validate rating
  if (!Number.isInteger(overallRating) || overallRating < MIN_RATING || overallRating > MAX_RATING) {
    throw Object.assign(new Error('INVALID_RATING'), { code: 'REVIEW_CONTENT_INVALID', status: 400 });
  }
  if (publicComment && publicComment.length > MAX_COMMENT_LENGTH) {
    throw Object.assign(new Error('COMMENT_TOO_LONG'), { code: 'REVIEW_CONTENT_INVALID', status: 400 });
  }
  if (privateFeedback && privateFeedback.length > MAX_PRIVATE_LENGTH) {
    throw Object.assign(new Error('PRIVATE_TOO_LONG'), { code: 'REVIEW_CONTENT_INVALID', status: 400 });
  }

  const requestId = clientRequestId?.trim() || `legacy-review:${customerUid}:${bookingId}`;
  if (requestId.length > 128) {
    throw Object.assign(new Error('INVALID_CLIENT_REQUEST_ID'), { code: 'REVIEW_CONTENT_INVALID', status: 400 });
  }

  const client = await pool.connect();
  let reviewId: string;
  let providerUid: string;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`review:${customerUid}:${bookingId}`]);
    const run: QueryRunner = (sql, params = []) => client.query(sql, params);

    const replay = await run(
      `SELECT review_id::text FROM ${dbSchema}.customer_reviews
       WHERE customer_uid = $1 AND client_request_id = $2 AND deleted_at IS NULL`,
      [customerUid, requestId],
    );
    if (replay.rows.length) {
      reviewId = replay.rows[0].review_id;
      await client.query('COMMIT');
      return getReviewById(reviewId, customerUid);
    }

    const booking = await getBookingForReview(bookingId, customerUid, run);
    if (!booking) throw Object.assign(new Error('BOOKING_NOT_OWNED'), { code: 'REVIEW_FORBIDDEN', status: 403 });
    if (Number(booking.customer_role) !== 3 || booking.customer_account_status !== 'active') {
      throw Object.assign(new Error('REVIEW_RESTRICTED'), { code: 'REVIEW_FORBIDDEN', status: 403 });
    }
    if (!booking.provider_uid || booking.provider_uid === customerUid) {
      throw Object.assign(new Error('BOOKING_INVALID'), { code: 'REVIEW_NOT_ELIGIBLE', status: 422 });
    }
    const bookingStatus = (booking.status || '').toUpperCase();
    if (!['COMPLETED', 'REVIEWED'].includes(bookingStatus)
        || (booking.assignment_status || '').toUpperCase() !== 'COMPLETED'
        || !booking.completed_at) {
      throw Object.assign(new Error('BOOKING_NOT_COMPLETED'), { code: 'REVIEW_NOT_ELIGIBLE', status: 422 });
    }
    const { opens, closes } = reviewWindowFor(booking.completed_at);
    const now = new Date();
    if (now < opens || now > closes) {
      throw Object.assign(new Error('REVIEW_WINDOW_CLOSED'), { code: 'REVIEW_NOT_ELIGIBLE', status: 422 });
    }
    const existing = await getExistingReview(bookingId, customerUid, run);
    if (existing && !existing.deleted_at) {
      throw Object.assign(new Error('REVIEW_ALREADY_EXISTS'), { code: 'REVIEW_DUPLICATE_REQUEST', status: 409 });
    }

    const configured = booking.service_id ? await run(
      `SELECT dimension_key FROM ${dbSchema}.service_review_dimensions
       WHERE service_id::text = $1 AND is_active = TRUE AND policy_version = 1`,
      [booking.service_id],
    ) : { rows: [] };
    const allowed = configured.rows.length
      ? new Set(configured.rows.map((row: any) => String(row.dimension_key)))
      : VALID_DIMENSIONS;
    const validDims: Record<string, number> = {};
    for (const [key, score] of Object.entries(dimensions)) {
      if (!allowed.has(key) || !Number.isInteger(score) || score < 1 || score > 5) {
        throw Object.assign(new Error('INVALID_REVIEW_DIMENSION'), { code: 'REVIEW_CONTENT_INVALID', status: 400 });
      }
      validDims[key] = score;
    }

    const validVisibility = ['PUBLIC', 'ANONYMOUS_PUBLIC', 'PRIVATE'].includes(visibility) ? visibility : 'PUBLIC';
    const needsModeration = validVisibility !== 'PRIVATE' && reviewContentNeedsModeration(publicComment);
    const publicationState = validVisibility === 'PRIVATE' ? 'PRIVATE' : needsModeration ? 'PENDING_MODERATION' : 'PUBLISHED';
    const moderationStatus = needsModeration ? 'PENDING' : 'AUTOMATED_CHECKS_PASSED';
    const inserted = await run(
      `INSERT INTO ${dbSchema}.customer_reviews
       (booking_id, customer_uid, provider_uid, service_id, overall_rating, public_comment,
        private_feedback, visibility, publication_state, moderation_status, client_request_id,
        policy_version, submitted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,NOW())
       RETURNING review_id::text`,
      [bookingId, customerUid, booking.provider_uid, booking.service_id, overallRating,
       publicComment?.trim() || null, privateFeedback?.trim() || null, validVisibility,
       publicationState, moderationStatus, requestId],
    );
    reviewId = inserted.rows[0].review_id;
    providerUid = booking.provider_uid;

    for (const [key, score] of Object.entries(validDims)) {
      await run(
        `INSERT INTO ${dbSchema}.review_dimension_scores (review_id, dimension_key, score)
         VALUES ($1,$2,$3)`,
        [reviewId, key, score],
      );
    }
    await run(
      `INSERT INTO ${dbSchema}.review_reputation_events
       (review_id, provider_uid, event_type, actor_type, actor_uid, public_detail, idempotency_key)
       VALUES ($1,$2,'REVIEW_SUBMITTED','CUSTOMER',$3,$4::jsonb,$5)`,
      [reviewId, providerUid, customerUid, JSON.stringify({ publicationState }), `review:${requestId}`],
    );
    await recalculateProviderRating(providerUid, run);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  void createNotification(providerUid!, {
    notificationKey: `review-received:${reviewId!}`,
    type: 'REVIEW_RECEIVED',
    severity: 'info',
    title: 'New verified review',
    safeBody: 'A customer submitted feedback for a completed booking.',
    safeContextLabel: 'Reviews & performance',
    route: { screen: 'ReviewsPerformance' },
    canOpenDetail: true,
  }).catch(() => undefined);
  emitReputationUpdated(providerUid!, 'REVIEW_SUBMITTED', reviewId!);
  return getReviewById(reviewId!, customerUid);
}

// ─── Get review ───────────────────────────────────────────────────────────────

export async function getReviewById(reviewId: string, customerUid: string) {
  const res = await dbQuery.query(
    `SELECT
       r.review_id::text,
       r.booking_id,
       r.provider_uid,
       r.service_id,
       r.overall_rating,
       r.public_comment,
       r.visibility,
       r.moderation_status,
       r.created_at,
       r.updated_at,
       r.edited_at,
       r.deleted_at,
       COALESCE(
         json_agg(json_build_object('dimensionKey', ds.dimension_key, 'score', ds.score))
           FILTER (WHERE ds.id IS NOT NULL),
         '[]'
       ) AS dimensions,
       rpr.response_id::text,
       rpr.body AS response_body,
       rpr.moderation_status AS response_moderation_status,
       rpr.created_at AS response_created_at
     FROM ${dbSchema}.customer_reviews r
     LEFT JOIN ${dbSchema}.review_dimension_scores ds ON ds.review_id = r.review_id
     LEFT JOIN ${dbSchema}.review_provider_responses rpr
       ON rpr.review_id = r.review_id
       AND rpr.deleted_at IS NULL
       AND rpr.moderation_status IN ('NOT_REQUIRED','APPROVED')
     WHERE r.review_id = $1 AND r.customer_uid = $2
     GROUP BY r.review_id, rpr.response_id, rpr.body, rpr.moderation_status, rpr.created_at`,
    [reviewId, customerUid]
  );
  if (!res.rows.length) return null;
  return mapReviewRow(res.rows[0], true);
}

export async function getReviewByBooking(bookingId: string, customerUid: string) {
  const res = await dbQuery.query(
    `SELECT
       r.review_id::text,
       r.booking_id,
       r.provider_uid,
       r.service_id,
       r.overall_rating,
       r.public_comment,
       r.visibility,
       r.moderation_status,
       r.created_at,
       r.updated_at,
       r.edited_at,
       r.deleted_at,
       COALESCE(
         json_agg(json_build_object('dimensionKey', ds.dimension_key, 'score', ds.score))
           FILTER (WHERE ds.id IS NOT NULL),
         '[]'
       ) AS dimensions,
       rpr.response_id::text,
       rpr.body AS response_body,
       rpr.moderation_status AS response_moderation_status,
       rpr.created_at AS response_created_at
     FROM ${dbSchema}.customer_reviews r
     LEFT JOIN ${dbSchema}.review_dimension_scores ds ON ds.review_id = r.review_id
     LEFT JOIN ${dbSchema}.review_provider_responses rpr
       ON rpr.review_id = r.review_id
       AND rpr.deleted_at IS NULL
       AND rpr.moderation_status IN ('NOT_REQUIRED','APPROVED')
     WHERE r.booking_id = $1 AND r.customer_uid = $2 AND r.deleted_at IS NULL
     GROUP BY r.review_id, rpr.response_id, rpr.body, rpr.moderation_status, rpr.created_at`,
    [bookingId, customerUid]
  );
  if (!res.rows.length) return null;
  return mapReviewRow(res.rows[0], true);
}

// ─── Edit review ─────────────────────────────────────────────────────────────

export async function editReview(
  reviewId: string,
  customerUid: string,
  overallRating: number,
  dimensions: Record<string, number>,
  publicComment: string | null,
  privateFeedback: string | null,
  visibility: string,
) {
  const existing = await dbQuery.query(
    `SELECT review_id, booking_id, provider_uid, created_at, deleted_at
     FROM ${dbSchema}.customer_reviews
     WHERE review_id = $1 AND customer_uid = $2`,
    [reviewId, customerUid]
  );
  if (!existing.rows.length) {
    throw Object.assign(new Error('REVIEW_NOT_FOUND'), { code: 'REVIEW_NOT_FOUND', status: 404 });
  }
  const row = existing.rows[0];
  if (row.deleted_at) {
    throw Object.assign(new Error('REVIEW_NOT_FOUND'), { code: 'REVIEW_NOT_FOUND', status: 404 });
  }

  const now = new Date();
  const editDeadline = new Date(row.created_at.getTime() + EDIT_WINDOW_HOURS * 60 * 60 * 1000);
  if (now > editDeadline) {
    throw Object.assign(new Error('EDIT_WINDOW_EXPIRED'), { code: 'REVIEW_EDIT_NOT_ALLOWED', status: 422 });
  }

  if (!Number.isInteger(overallRating) || overallRating < MIN_RATING || overallRating > MAX_RATING) {
    throw Object.assign(new Error('INVALID_RATING'), { code: 'REVIEW_CONTENT_INVALID', status: 400 });
  }
  if (publicComment && publicComment.length > MAX_COMMENT_LENGTH) {
    throw Object.assign(new Error('COMMENT_TOO_LONG'), { code: 'REVIEW_CONTENT_INVALID', status: 400 });
  }
  if (privateFeedback && privateFeedback.length > MAX_PRIVATE_LENGTH) {
    throw Object.assign(new Error('PRIVATE_TOO_LONG'), { code: 'REVIEW_CONTENT_INVALID', status: 400 });
  }

  const validVisibility = ['PUBLIC', 'ANONYMOUS_PUBLIC', 'PRIVATE'].includes(visibility)
    ? visibility : 'PUBLIC';
  const needsModeration = validVisibility !== 'PRIVATE' && reviewContentNeedsModeration(publicComment);
  const publicationState = validVisibility === 'PRIVATE' ? 'PRIVATE' : needsModeration ? 'PENDING_MODERATION' : 'EDITED';
  const moderationStatus = needsModeration ? 'PENDING' : 'AUTOMATED_CHECKS_PASSED';
  const validDims: Record<string, number> = {};
  for (const [key, score] of Object.entries(dimensions)) {
    if (!VALID_DIMENSIONS.has(key) || !Number.isInteger(score) || score < 1 || score > 5) {
      throw Object.assign(new Error('INVALID_REVIEW_DIMENSION'), { code: 'REVIEW_CONTENT_INVALID', status: 400 });
    }
    validDims[key] = score;
  }

  await dbQuery.query(
    `UPDATE ${dbSchema}.customer_reviews
     SET overall_rating = $1, public_comment = $2, private_feedback = $3,
         visibility = $4, publication_state = $5, moderation_status = $6,
         edited_at = NOW(), updated_at = NOW(), version = version + 1
     WHERE review_id = $7`,
    [overallRating, publicComment?.trim() || null, privateFeedback?.trim() || null,
     validVisibility, publicationState, moderationStatus, reviewId]
  );

  // Update dimensions
  if (Object.keys(validDims).length) {
    await dbQuery.query(
      `DELETE FROM ${dbSchema}.review_dimension_scores WHERE review_id = $1`,
      [reviewId]
    );
    const dimValues = Object.entries(validDims)
      .map((_, i) => `($1, $${i * 2 + 2}, $${i * 2 + 3})`).join(', ');
    const dimParams: unknown[] = [reviewId];
    for (const [k, v] of Object.entries(validDims)) { dimParams.push(k, v); }
    await dbQuery.query(
      `INSERT INTO ${dbSchema}.review_dimension_scores (review_id, dimension_key, score) VALUES ${dimValues}`,
      dimParams
    );
  }

  if (row.provider_uid) {
    await recalculateProviderRating(row.provider_uid);
    emitReputationUpdated(String(row.provider_uid), 'REVIEW_EDITED', reviewId);
    void createNotification(String(row.provider_uid), {
      notificationKey: `review-edited:${reviewId}:${Date.now()}`,
      type: 'REVIEW_UPDATED', severity: 'info', title: 'Review updated',
      safeBody: 'A verified customer review was updated.',
      safeContextLabel: 'Reviews & performance', route: { screen: 'ReviewsPerformance' },
      canOpenDetail: true,
    }).catch(() => undefined);
  }
  return getReviewById(reviewId, customerUid);
}

// ─── Delete review ────────────────────────────────────────────────────────────

export async function deleteReview(reviewId: string, customerUid: string) {
  const existing = await dbQuery.query(
    `SELECT review_id, provider_uid, deleted_at FROM ${dbSchema}.customer_reviews
     WHERE review_id = $1 AND customer_uid = $2`,
    [reviewId, customerUid]
  );
  if (!existing.rows.length || existing.rows[0].deleted_at) {
    throw Object.assign(new Error('REVIEW_NOT_FOUND'), { code: 'REVIEW_NOT_FOUND', status: 404 });
  }
  await dbQuery.query(
    `UPDATE ${dbSchema}.customer_reviews
     SET deleted_at = NOW(), publication_state = 'WITHDRAWN', updated_at = NOW(), version = version + 1
     WHERE review_id = $1`,
    [reviewId]
  );
  const providerUid = existing.rows[0].provider_uid;
  if (providerUid) {
    await recalculateProviderRating(providerUid);
    emitReputationUpdated(String(providerUid), 'REVIEW_WITHDRAWN', reviewId);
    void createNotification(String(providerUid), {
      notificationKey: `review-withdrawn:${reviewId}`,
      type: 'REVIEW_WITHDRAWN', severity: 'info', title: 'Review withdrawn',
      safeBody: 'A customer withdrew a verified review.',
      safeContextLabel: 'Reviews & performance', route: { screen: 'ReviewsPerformance' },
      canOpenDetail: true,
    }).catch(() => undefined);
  }
  return { deleted: true };
}

// ─── Customer review history ──────────────────────────────────────────────────

export async function listCustomerReviews(customerUid: string) {
  const res = await dbQuery.query(
    `SELECT
       r.review_id::text,
       r.booking_id,
       r.provider_uid,
       r.service_id,
       r.overall_rating,
       r.public_comment,
       r.visibility,
       r.moderation_status,
       r.created_at,
       r.edited_at,
       rpr.response_id::text,
       rpr.body AS response_body,
       rpr.moderation_status AS response_moderation_status
     FROM ${dbSchema}.customer_reviews r
     LEFT JOIN ${dbSchema}.review_provider_responses rpr
       ON rpr.review_id = r.review_id
       AND rpr.deleted_at IS NULL
       AND rpr.moderation_status IN ('NOT_REQUIRED','APPROVED')
     WHERE r.customer_uid = $1 AND r.deleted_at IS NULL
     ORDER BY r.created_at DESC
     LIMIT 50`,
    [customerUid]
  );
  return res.rows.map((row: any) => mapReviewRow(row, false));
}

// ─── Provider public reviews ──────────────────────────────────────────────────

export async function listProviderReviews(providerUid: string, limit = 20, offset = 0) {
  const res = await dbQuery.query(
    `SELECT
       r.review_id::text,
       r.overall_rating,
       r.public_comment,
       r.visibility,
       r.moderation_status,
       r.created_at,
       r.edited_at,
       rpr.response_id::text,
       rpr.body AS response_body,
       rpr.created_at AS response_created_at
     FROM ${dbSchema}.customer_reviews r
     LEFT JOIN ${dbSchema}.review_provider_responses rpr
       ON rpr.review_id = r.review_id
       AND rpr.deleted_at IS NULL
       AND rpr.moderation_status IN ('NOT_REQUIRED','APPROVED')
     WHERE r.provider_uid = $1
       AND r.deleted_at IS NULL
       AND r.visibility IN ('PUBLIC','ANONYMOUS_PUBLIC')
       AND r.publication_state IN ('PUBLISHED','EDITED','REDACTED')
       AND r.moderation_status IN ('NOT_REQUIRED','AUTOMATED_CHECKS_PASSED','APPROVED','RESTORED','REPORTED')
     ORDER BY r.created_at DESC
     LIMIT $2 OFFSET $3`,
    [providerUid, limit, offset]
  );
  const countRes = await dbQuery.query(
    `SELECT COUNT(*)::int AS total FROM ${dbSchema}.customer_reviews
     WHERE provider_uid = $1 AND deleted_at IS NULL
       AND visibility IN ('PUBLIC','ANONYMOUS_PUBLIC')
       AND publication_state IN ('PUBLISHED','EDITED','REDACTED')
       AND moderation_status IN ('NOT_REQUIRED','AUTOMATED_CHECKS_PASSED','APPROVED','RESTORED','REPORTED')`,
    [providerUid]
  );
  return { reviews: res.rows.map((r: any) => mapPublicReviewRow(r)), total: countRes.rows[0].total };
}

// ─── Provider aggregate ───────────────────────────────────────────────────────

export async function getProviderAggregate(providerUid: string) {
  return { providerUid, ...(await getPublicRatingSummary(providerUid)) };
}

// ─── Report review ────────────────────────────────────────────────────────────

export async function reportReview(
  reviewId: string, reporterUid: string, reason: string, details: string | null
) {
  const VALID_REASONS = new Set([
    'PERSONAL_INFORMATION', 'THREATENING_CONTENT', 'SPAM',
    'HARASSMENT', 'HATE_SPEECH', 'INACCURATE', 'OTHER',
  ]);
  const safeReason = VALID_REASONS.has(reason) ? reason : 'OTHER';

  const exists = await dbQuery.query(
    `SELECT review_id FROM ${dbSchema}.customer_reviews
     WHERE review_id = $1 AND customer_uid = $2 AND deleted_at IS NULL`,
    [reviewId, reporterUid]
  );
  if (!exists.rows.length) {
    throw Object.assign(new Error('REVIEW_NOT_FOUND'), { code: 'REVIEW_NOT_FOUND', status: 404 });
  }

  await dbQuery.query(
    `INSERT INTO ${dbSchema}.review_reports (review_id, reporter_uid, reason, details)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (review_id, reporter_uid) WHERE review_id IS NOT NULL DO NOTHING`,
    [reviewId, reporterUid, safeReason, details?.trim() || null]
  );

  // A report is a workflow signal, never an automatic rating exclusion.
  return { reported: true };
}

// ─── Row mappers ──────────────────────────────────────────────────────────────

function mapReviewRow(row: Record<string, unknown>, includePrivate: boolean) {
  const providerResponse = row.response_id
    ? {
        responseId:        row.response_id as string,
        body:              row.response_body as string,
        moderationStatus:  row.response_moderation_status as string,
        createdAt:         row.response_created_at,
      }
    : null;

  return {
    reviewId:         row.review_id as string,
    bookingId:        row.booking_id as string,
    overallRating:    row.overall_rating as number,
    publicComment:    row.public_comment as string | null,
    ...(includePrivate ? { privateFeedback: row.private_feedback as string | null } : {}),
    visibility:       row.visibility as string,
    moderationStatus: row.moderation_status as string,
    dimensions:       Array.isArray(row.dimensions) ? row.dimensions : [],
    providerResponse,
    createdAt:        row.created_at,
    updatedAt:        row.updated_at,
    editedAt:         row.edited_at ?? null,
  };
}

function mapPublicReviewRow(row: Record<string, unknown>) {
  const providerResponse = row.response_id
    ? { responseId: row.response_id as string, body: row.response_body as string, createdAt: row.response_created_at }
    : null;
  return {
    reviewId:         row.review_id as string,
    overallRating:    row.overall_rating as number,
    publicComment:    row.public_comment as string | null,
    visibility:       row.visibility as string,
    moderationStatus: row.moderation_status as string,
    createdAt:        row.created_at,
    editedAt:         row.edited_at ?? null,
    providerResponse,
  };
}
