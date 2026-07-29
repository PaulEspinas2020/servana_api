import dbQuery from "../db/dbQuery";
import { db } from "../config";

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
  'COMMUNICATION',   'VALUE',           'CLEANLINESS',
  'ACCURACY',
]);

// ─── Lazy table init ──────────────────────────────────────────────────────────

let tablesReady: Promise<void> | null = null;

async function initTables(): Promise<void> {
  await dbQuery.query(`
    CREATE TABLE IF NOT EXISTS ${dbSchema}.customer_reviews (
      review_id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      booking_id          VARCHAR(128) NOT NULL,
      customer_uid        VARCHAR(128) NOT NULL,
      provider_uid        VARCHAR(128),
      service_id          VARCHAR(128),
      overall_rating      INTEGER      NOT NULL CHECK (overall_rating BETWEEN 1 AND 5),
      public_comment      TEXT,
      private_feedback    TEXT,
      visibility          VARCHAR(30)  NOT NULL DEFAULT 'PUBLIC'
        CHECK (visibility IN ('PUBLIC','ANONYMOUS_PUBLIC','PRIVATE')),
      moderation_status   VARCHAR(30)  NOT NULL DEFAULT 'NOT_REQUIRED'
        CHECK (moderation_status IN ('NOT_REQUIRED','PENDING','APPROVED','REJECTED','HIDDEN','REMOVED','FLAGGED')),
      client_request_id   VARCHAR(128),
      created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      edited_at           TIMESTAMPTZ,
      deleted_at          TIMESTAMPTZ,
      UNIQUE (booking_id, customer_uid)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cr_client_req
      ON ${dbSchema}.customer_reviews (customer_uid, client_request_id)
      WHERE client_request_id IS NOT NULL AND deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_cr_customer_uid
      ON ${dbSchema}.customer_reviews (customer_uid, created_at DESC)
      WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_cr_provider_uid
      ON ${dbSchema}.customer_reviews (provider_uid, created_at DESC)
      WHERE deleted_at IS NULL AND moderation_status IN ('NOT_REQUIRED','APPROVED');

    CREATE TABLE IF NOT EXISTS ${dbSchema}.review_dimension_scores (
      id           BIGSERIAL    PRIMARY KEY,
      review_id    UUID         NOT NULL REFERENCES ${dbSchema}.customer_reviews(review_id) ON DELETE CASCADE,
      dimension_key VARCHAR(50) NOT NULL,
      score        INTEGER      NOT NULL CHECK (score BETWEEN 1 AND 5),
      UNIQUE (review_id, dimension_key)
    );

    CREATE TABLE IF NOT EXISTS ${dbSchema}.review_provider_responses (
      response_id       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      review_id         UUID         NOT NULL REFERENCES ${dbSchema}.customer_reviews(review_id) ON DELETE CASCADE,
      provider_uid      VARCHAR(128) NOT NULL,
      body              TEXT         NOT NULL,
      moderation_status VARCHAR(30)  NOT NULL DEFAULT 'NOT_REQUIRED',
      created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      deleted_at        TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS ${dbSchema}.review_reports (
      report_id    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      review_id    UUID         REFERENCES ${dbSchema}.customer_reviews(review_id),
      response_id  UUID         REFERENCES ${dbSchema}.review_provider_responses(response_id),
      reporter_uid VARCHAR(128) NOT NULL,
      reason       VARCHAR(50)  NOT NULL,
      details      TEXT,
      created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ${dbSchema}.provider_rating_aggregates (
      provider_uid     VARCHAR(128) PRIMARY KEY,
      average_rating   NUMERIC(3,2) NOT NULL DEFAULT 0,
      review_count     INTEGER      NOT NULL DEFAULT 0,
      rating_1_count   INTEGER      NOT NULL DEFAULT 0,
      rating_2_count   INTEGER      NOT NULL DEFAULT 0,
      rating_3_count   INTEGER      NOT NULL DEFAULT 0,
      rating_4_count   INTEGER      NOT NULL DEFAULT 0,
      rating_5_count   INTEGER      NOT NULL DEFAULT 0,
      last_updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
  `);
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

async function getBookingForReview(bookingId: string, customerUid: string) {
  // Fetch booking, verify ownership, get provider + service
  const res = await dbQuery.query(
    `SELECT
       b.id::text        AS id,
       b.user_id         AS customer_uid,
       b.status,
       so.service_id::text AS service_id,
       bw.worker_uid     AS provider_uid,
       bw.completed_at
     FROM ${dbSchema}.bookings b
     LEFT JOIN ${dbSchema}.service_options so ON so.id = b.service_option_id
     LEFT JOIN ${dbSchema}.booking_workers bw
       ON bw.booking_id = b.id
       AND bw.status IN ('COMPLETED','IN_PROGRESS','ACCEPTED','ASSIGNED')
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
    completed_at: Date | null;
  };
}

async function getExistingReview(bookingId: string, customerUid: string) {
  const res = await dbQuery.query(
    `SELECT review_id::text, overall_rating, created_at, edited_at, deleted_at
     FROM ${dbSchema}.customer_reviews
     WHERE booking_id = $1 AND customer_uid = $2`,
    [bookingId, customerUid]
  );
  return res.rows.length ? res.rows[0] : null;
}

function reviewWindowFor(completedAt: Date | null): { opens: Date; closes: Date } {
  const base = completedAt ?? new Date();
  const closes = new Date(base.getTime() + REVIEW_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return { opens: base, closes };
}

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

  const status = (booking.status || '').toUpperCase();
  if (!['COMPLETED', 'REVIEWED', 'PAID'].includes(status)) {
    // Allow PAID as some flows mark payment before completion
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

  const booking = await getBookingForReview(bookingId, customerUid);
  if (!booking) {
    throw Object.assign(new Error('BOOKING_NOT_OWNED'), { code: 'REVIEW_FORBIDDEN', status: 403 });
  }
  const status = (booking.status || '').toUpperCase();
  if (!['COMPLETED', 'REVIEWED', 'PAID'].includes(status)) {
    throw Object.assign(new Error('BOOKING_NOT_COMPLETED'), { code: 'REVIEW_NOT_ELIGIBLE', status: 422 });
  }

  // Check idempotency: same clientRequestId from same customer
  if (clientRequestId) {
    const idem = await dbQuery.query(
      `SELECT review_id::text FROM ${dbSchema}.customer_reviews
       WHERE customer_uid = $1 AND client_request_id = $2 AND deleted_at IS NULL`,
      [customerUid, clientRequestId]
    );
    if (idem.rows.length) {
      return getReviewById(idem.rows[0].review_id, customerUid);
    }
  }

  // Enforce one-review-per-booking
  const existing = await getExistingReview(bookingId, customerUid);
  if (existing && !existing.deleted_at) {
    throw Object.assign(new Error('REVIEW_ALREADY_EXISTS'), { code: 'REVIEW_DUPLICATE_REQUEST', status: 409 });
  }

  // Validate dimensions
  const validDims: Record<string, number> = {};
  for (const [key, score] of Object.entries(dimensions)) {
    if (VALID_DIMENSIONS.has(key) && Number.isInteger(score) && score >= 1 && score <= 5) {
      validDims[key] = score;
    }
  }

  const validVisibility = ['PUBLIC', 'ANONYMOUS_PUBLIC', 'PRIVATE'].includes(visibility)
    ? visibility : 'PUBLIC';

  const reviewRes = await dbQuery.query(
    `INSERT INTO ${dbSchema}.customer_reviews
       (booking_id, customer_uid, provider_uid, service_id, overall_rating,
        public_comment, private_feedback, visibility, moderation_status, client_request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'NOT_REQUIRED', $9)
     RETURNING review_id::text, booking_id, overall_rating, visibility,
               moderation_status, created_at, updated_at`,
    [
      bookingId,
      customerUid,
      booking.provider_uid,
      booking.service_id,
      overallRating,
      publicComment?.trim() || null,
      privateFeedback?.trim() || null,
      validVisibility,
      clientRequestId || null,
    ]
  );
  const review = reviewRes.rows[0];

  // Insert dimension scores
  if (Object.keys(validDims).length) {
    const dimValues = Object.entries(validDims)
      .map((_, i) => `($1, $${i * 2 + 2}, $${i * 2 + 3})`)
      .join(', ');
    const dimParams: unknown[] = [review.review_id];
    for (const [k, v] of Object.entries(validDims)) {
      dimParams.push(k, v);
    }
    await dbQuery.query(
      `INSERT INTO ${dbSchema}.review_dimension_scores (review_id, dimension_key, score)
       VALUES ${dimValues} ON CONFLICT (review_id, dimension_key) DO UPDATE SET score = EXCLUDED.score`,
      dimParams
    );
  }

  // Mark booking as REVIEWED
  await dbQuery.query(
    `UPDATE ${dbSchema}.bookings SET status = 'REVIEWED', updated_at = NOW() WHERE id = $1::bigint`,
    [bookingId]
  );

  // Recalculate provider aggregate
  if (booking.provider_uid) {
    await recalcProviderAggregate(booking.provider_uid);
  }

  return getReviewById(review.review_id, customerUid);
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

  const validVisibility = ['PUBLIC', 'ANONYMOUS_PUBLIC', 'PRIVATE'].includes(visibility)
    ? visibility : 'PUBLIC';

  await dbQuery.query(
    `UPDATE ${dbSchema}.customer_reviews
     SET overall_rating = $1, public_comment = $2, private_feedback = $3,
         visibility = $4, edited_at = NOW(), updated_at = NOW()
     WHERE review_id = $5`,
    [overallRating, publicComment?.trim() || null, privateFeedback?.trim() || null, validVisibility, reviewId]
  );

  // Update dimensions
  const validDims: Record<string, number> = {};
  for (const [key, score] of Object.entries(dimensions)) {
    if (VALID_DIMENSIONS.has(key) && Number.isInteger(score) && score >= 1 && score <= 5) {
      validDims[key] = score;
    }
  }
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

  if (row.provider_uid) await recalcProviderAggregate(row.provider_uid);
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
    `UPDATE ${dbSchema}.customer_reviews SET deleted_at = NOW(), updated_at = NOW() WHERE review_id = $1`,
    [reviewId]
  );
  const providerUid = existing.rows[0].provider_uid;
  if (providerUid) await recalcProviderAggregate(providerUid);
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
  return res.rows.map(row => mapReviewRow(row, false));
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
       AND r.moderation_status IN ('NOT_REQUIRED','APPROVED')
     ORDER BY r.created_at DESC
     LIMIT $2 OFFSET $3`,
    [providerUid, limit, offset]
  );
  const countRes = await dbQuery.query(
    `SELECT COUNT(*)::int AS total FROM ${dbSchema}.customer_reviews
     WHERE provider_uid = $1 AND deleted_at IS NULL
       AND visibility IN ('PUBLIC','ANONYMOUS_PUBLIC')
       AND moderation_status IN ('NOT_REQUIRED','APPROVED')`,
    [providerUid]
  );
  return { reviews: res.rows.map(r => mapPublicReviewRow(r)), total: countRes.rows[0].total };
}

// ─── Provider aggregate ───────────────────────────────────────────────────────

export async function getProviderAggregate(providerUid: string) {
  const res = await dbQuery.query(
    `SELECT average_rating, review_count,
            rating_1_count, rating_2_count, rating_3_count, rating_4_count, rating_5_count,
            last_updated_at
     FROM ${dbSchema}.provider_rating_aggregates WHERE provider_uid = $1`,
    [providerUid]
  );
  if (!res.rows.length) {
    return { providerUid, averageRating: 0, reviewCount: 0, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } };
  }
  const r = res.rows[0];
  return {
    providerUid,
    averageRating: parseFloat(r.average_rating) || 0,
    reviewCount: r.review_count,
    distribution: {
      1: r.rating_1_count, 2: r.rating_2_count, 3: r.rating_3_count,
      4: r.rating_4_count, 5: r.rating_5_count,
    },
  };
}

async function recalcProviderAggregate(providerUid: string): Promise<void> {
  await dbQuery.query(
    `INSERT INTO ${dbSchema}.provider_rating_aggregates
       (provider_uid, average_rating, review_count,
        rating_1_count, rating_2_count, rating_3_count, rating_4_count, rating_5_count,
        last_updated_at)
     SELECT
       $1,
       ROUND(AVG(overall_rating)::numeric, 2),
       COUNT(*)::int,
       COUNT(*) FILTER (WHERE overall_rating = 1)::int,
       COUNT(*) FILTER (WHERE overall_rating = 2)::int,
       COUNT(*) FILTER (WHERE overall_rating = 3)::int,
       COUNT(*) FILTER (WHERE overall_rating = 4)::int,
       COUNT(*) FILTER (WHERE overall_rating = 5)::int,
       NOW()
     FROM ${dbSchema}.customer_reviews
     WHERE provider_uid = $1 AND deleted_at IS NULL
       AND visibility IN ('PUBLIC','ANONYMOUS_PUBLIC')
       AND moderation_status IN ('NOT_REQUIRED','APPROVED')
     ON CONFLICT (provider_uid) DO UPDATE SET
       average_rating  = EXCLUDED.average_rating,
       review_count    = EXCLUDED.review_count,
       rating_1_count  = EXCLUDED.rating_1_count,
       rating_2_count  = EXCLUDED.rating_2_count,
       rating_3_count  = EXCLUDED.rating_3_count,
       rating_4_count  = EXCLUDED.rating_4_count,
       rating_5_count  = EXCLUDED.rating_5_count,
       last_updated_at = NOW()`,
    [providerUid]
  );
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
     WHERE review_id = $1 AND deleted_at IS NULL`,
    [reviewId]
  );
  if (!exists.rows.length) {
    throw Object.assign(new Error('REVIEW_NOT_FOUND'), { code: 'REVIEW_NOT_FOUND', status: 404 });
  }

  await dbQuery.query(
    `INSERT INTO ${dbSchema}.review_reports (review_id, reporter_uid, reason, details)
     VALUES ($1, $2, $3, $4)`,
    [reviewId, reporterUid, safeReason, details?.trim() || null]
  );

  // Flag the review for moderation
  await dbQuery.query(
    `UPDATE ${dbSchema}.customer_reviews SET moderation_status = 'FLAGGED', updated_at = NOW()
     WHERE review_id = $1 AND moderation_status = 'NOT_REQUIRED'`,
    [reviewId]
  );

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
