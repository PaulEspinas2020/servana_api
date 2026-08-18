/**
 * Post-service support cases, grounded in a completed booking (§126).
 *
 * ## What this is for
 *
 * A customer whose job went wrong needs somewhere to say so that is ATTACHED to
 * the booking. The existing support surfaces are not that: `customerSupportService`
 * is general contact, and `providerSupportCaseService` is a provider's own
 * account or a job they worked. Neither carries a `bookingId`, so a quality
 * complaint arrives with no way to see which visit it is about.
 *
 * ## The routing decision
 *
 * A BILLING category is accepted and ROUTED to the finance domain rather than
 * handled here. Handling it would mean a second refund path with its own
 * eligibility rules beside the one `bookingPaymentService` already enforces —
 * and a refund granted by a support agent under different rules from the ones
 * reconciliation checks is a break nobody can close.
 *
 * Refusing it outright would be worse in the other direction: the customer has a
 * real problem and no button. So the case is created, marked as routed, and the
 * response NAMES the canonical endpoint that actually issues refunds.
 *
 * ## Authorization is the booking, not a role
 *
 * Only the booking's customer may raise a case about it, resolved from
 * `bookings.user_id`. There is no parameter that names another booking's owner.
 */

import type { PoolClient } from 'pg';
import dbQuery, { pool } from '../../db/dbQuery';
import { db } from '../../config';
import {
  ELEVATED_CATEGORIES,
  SUPPORT_CASE_LIMITS,
  SUPPORT_CATEGORIES,
  SUPPORT_CATEGORY_NAMES,
  routeForCategory,
  type SupportCategory,
  type SupportRoute,
} from './reviewPolicy';

const s = db.schema;

export class SupportCaseError extends Error {
  constructor(
    readonly code:
      | 'SUPPORT_BOOKING_NOT_ELIGIBLE'
      | 'SUPPORT_CATEGORY_INVALID'
      | 'SUPPORT_CONTENT_INVALID'
      | 'SUPPORT_CASE_LIMIT_REACHED',
    message: string,
    readonly status: number = 422,
  ) {
    super(message);
    this.name = 'SupportCaseError';
  }
}

// ─── Schema ───────────────────────────────────────────────────────────────────

let schemaReady: Promise<void> | null = null;

/**
 * Additive, IF NOT EXISTS, lazily applied — the convention every tab since 029
 * has used. `scripts/migrations/035-post-service-support.sql` performs the same
 * DDL so a DBA can apply it deliberately; whichever runs first wins.
 */
export const ensureSupportSchema = async (): Promise<void> => {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    await dbQuery.query(
      `CREATE TABLE IF NOT EXISTS ${s}.booking_support_cases (
         case_id        BIGSERIAL PRIMARY KEY,
         booking_id     BIGINT       NOT NULL,
         customer_uid   VARCHAR(128) NOT NULL,
         provider_uid   VARCHAR(128),
         category       VARCHAR(40)  NOT NULL,
         severity       VARCHAR(16)  NOT NULL DEFAULT 'normal',
         routed_to      VARCHAR(16)  NOT NULL DEFAULT 'support',
         state          VARCHAR(24)  NOT NULL DEFAULT 'OPEN',
         summary        VARCHAR(200) NOT NULL,
         detail         TEXT,
         client_request_id VARCHAR(128),
         created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
         resolved_at    TIMESTAMPTZ
       )`,
      [],
    );
    await dbQuery.query(
      `CREATE INDEX IF NOT EXISTS idx_booking_support_cases_booking
         ON ${s}.booking_support_cases (booking_id, created_at DESC)`,
      [],
    );
    /**
     * Idempotency, at the database.
     *
     * A customer on a flaky connection retrying "report a problem" must not open
     * three cases for one complaint — a human then triages the same incident
     * three times and the customer is asked the same questions twice.
     */
    await dbQuery.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_booking_support_cases_request
         ON ${s}.booking_support_cases (customer_uid, client_request_id)
       WHERE client_request_id IS NOT NULL`,
      [],
    );
  })().catch((error) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
};

// ─── DTO ──────────────────────────────────────────────────────────────────────

export interface SupportCaseDto {
  caseId: string;
  bookingId: number;
  category: SupportCategory;
  severity: 'normal' | 'elevated';
  /** Where this case is handled. `finance` means the money path owns it. */
  routedTo: SupportRoute;
  state: string;
  summary: string;
  createdAt: string | null;
  /**
   * Present when `routedTo` is `finance`: the canonical endpoint that actually
   * issues a refund. The case records the complaint; it does not move money.
   */
  nextEndpoint: string | null;
}

const toDto = (row: any): SupportCaseDto => ({
  caseId: String(row.case_id),
  bookingId: Number(row.booking_id),
  category: String(row.category) as SupportCategory,
  severity: row.severity === 'elevated' ? 'elevated' : 'normal',
  routedTo: (row.routed_to === 'finance' ? 'finance' : 'support') as SupportRoute,
  state: String(row.state ?? 'OPEN'),
  summary: String(row.summary ?? ''),
  createdAt: row.created_at ? new Date(String(row.created_at)).toISOString() : null,
  nextEndpoint: row.routed_to === 'finance'
    ? SUPPORT_CATEGORIES.BILLING.handler.split('— ')[1] ?? null
    : null,
});

// ─── Create ───────────────────────────────────────────────────────────────────

export interface CreateSupportCaseInput {
  bookingId: number;
  customerUid: string;
  category: string;
  summary: string;
  detail?: string | null;
  clientRequestId?: string | null;
}

/**
 * Raise a case about a completed booking.
 *
 * ## Eligibility is the booking's, not the caller's role
 *
 * The booking must exist, belong to the caller, and have reached a state where
 * "the service had a problem" is a coherent statement. A case about a booking
 * that has not happened yet is not a post-service complaint — it is a
 * cancellation or a schedule question, and both have their own paths.
 *
 * ## Idempotent
 *
 * The whole create runs in ONE transaction with an advisory lock on
 * (customer, booking), and a `clientRequestId` replays the original case rather
 * than opening a second. Same shape `createReview` uses, and for the same
 * reason.
 */
export const createSupportCase = async (
  input: CreateSupportCaseInput,
): Promise<SupportCaseDto> => {
  const category = String(input.category ?? '').toUpperCase();
  if (!SUPPORT_CATEGORY_NAMES.includes(category as SupportCategory)) {
    throw new SupportCaseError(
      'SUPPORT_CATEGORY_INVALID',
      `Unknown category. Known: ${SUPPORT_CATEGORY_NAMES.join(', ')}.`,
      400,
    );
  }

  const summary = String(input.summary ?? '').trim();
  if (!summary) {
    throw new SupportCaseError('SUPPORT_CONTENT_INVALID', 'A summary is required.', 400);
  }
  if (summary.length > SUPPORT_CASE_LIMITS.summary) {
    throw new SupportCaseError(
      'SUPPORT_CONTENT_INVALID',
      `The summary must be at most ${SUPPORT_CASE_LIMITS.summary} characters.`,
      400,
    );
  }
  const detail = input.detail == null ? null : String(input.detail).trim();
  if (detail && detail.length > SUPPORT_CASE_LIMITS.detail) {
    throw new SupportCaseError(
      'SUPPORT_CONTENT_INVALID',
      `The detail must be at most ${SUPPORT_CASE_LIMITS.detail} characters.`,
      400,
    );
  }

  await ensureSupportSchema();

  const requestId = input.clientRequestId?.trim() || null;
  if (requestId && requestId.length > SUPPORT_CASE_LIMITS.summary) {
    throw new SupportCaseError('SUPPORT_CONTENT_INVALID', 'clientRequestId is too long.', 400);
  }

  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [`support:${input.customerUid}:${input.bookingId}`],
    );

    if (requestId) {
      const replay = await client.query(
        `SELECT * FROM ${s}.booking_support_cases
          WHERE customer_uid = $1 AND client_request_id = $2`,
        [input.customerUid, requestId],
      );
      if (replay.rows.length) {
        await client.query('COMMIT');
        return toDto(replay.rows[0]);
      }
    }

    // OWNERSHIP and eligibility, from the booking. Ownership answers the same
    // way as a missing booking: telling the two apart lets a caller enumerate
    // booking ids, and a booking id is a small integer.
    const booking = await client.query(
      `SELECT b.id, b.status, b.user_id,
              (SELECT bw.worker_uid FROM ${s}.booking_workers bw
                WHERE bw.booking_id = b.id
                ORDER BY bw.id DESC LIMIT 1) AS provider_uid
         FROM ${s}.bookings b
        WHERE b.id = $1 AND b.user_id = $2
        LIMIT 1`,
      [input.bookingId, input.customerUid],
    );
    if (!booking.rows.length) {
      throw new SupportCaseError(
        'SUPPORT_BOOKING_NOT_ELIGIBLE',
        'No booking with that id.',
        404,
      );
    }

    const status = String(booking.rows[0].status ?? '').toUpperCase();
    // A case about a booking that has not happened is not a post-service
    // complaint. Cancellation and rescheduling have their own paths.
    if (!['COMPLETED', 'REVIEWED', 'CANCELLED'].includes(status)) {
      throw new SupportCaseError(
        'SUPPORT_BOOKING_NOT_ELIGIBLE',
        'A post-service case can only be raised once the booking has concluded.',
        422,
      );
    }

    const open = await client.query(
      `SELECT COUNT(*)::int AS count FROM ${s}.booking_support_cases
        WHERE booking_id = $1 AND customer_uid = $2 AND state = 'OPEN'`,
      [input.bookingId, input.customerUid],
    );
    if (Number(open.rows[0]?.count ?? 0) >= SUPPORT_CASE_LIMITS.maxOpenPerBooking) {
      throw new SupportCaseError(
        'SUPPORT_CASE_LIMIT_REACHED',
        `At most ${SUPPORT_CASE_LIMITS.maxOpenPerBooking} open cases per booking.`,
        409,
      );
    }

    const routedTo = routeForCategory(category) ?? 'support';
    const severity = ELEVATED_CATEGORIES.includes(category as SupportCategory)
      ? 'elevated'
      : 'normal';

    const created = await client.query(
      `INSERT INTO ${s}.booking_support_cases
         (booking_id, customer_uid, provider_uid, category, severity, routed_to,
          summary, detail, client_request_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        input.bookingId,
        input.customerUid,
        booking.rows[0].provider_uid ?? null,
        category,
        severity,
        routedTo,
        summary,
        detail,
        requestId,
      ],
    );

    await client.query('COMMIT');
    return toDto(created.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};

/**
 * The cases this customer raised on this booking.
 *
 * Owner-scoped in SQL. There is no parameter naming another account, which is
 * what makes the isolation test a statement about the code rather than about
 * today's routes.
 */
export const listSupportCases = async (
  bookingId: number,
  customerUid: string,
): Promise<SupportCaseDto[]> => {
  await ensureSupportSchema();
  const { rows } = await dbQuery.query(
    `SELECT * FROM ${s}.booking_support_cases
      WHERE booking_id = $1 AND customer_uid = $2
      ORDER BY created_at DESC`,
    [bookingId, customerUid],
  );
  return rows.map(toDto);
};

/** Test seam. */
export const __resetSupportSchema = (): void => {
  schemaReady = null;
};
