/**
 * The persistence the booking experiences need, and the DDL that guarantees it.
 *
 * ## Why the schema is ensured lazily
 *
 * The only database this repository can reach is production, which this work is
 * forbidden to touch. A migration file alone therefore has the failure mode that
 * has already taken this platform down once: the code ships, the migration has
 * not run, and every read fails on a missing relation.
 *
 * `services/otpService.ensureOtpPurposeColumn` established the answer and this
 * follows it exactly — a memoised, AWAITED ensure that every reader and writer
 * depends on, plus `scripts/migrations/030-booking-experiences.sql` carrying the
 * same DDL for the controlled path. Both are `IF NOT EXISTS`, so whichever runs
 * first wins and the other is a no-op.
 *
 * ## Why it does NOT degrade quietly
 *
 * `otpService` falls back to an unscoped read when its ALTER fails, and that is
 * correct there: with one purpose in existence, scoped and unscoped return the
 * same row, so the degradation is provably harmless. Nothing here has that
 * property. An OTP attempt limit that silently stops counting is a limit that
 * does not exist, and a reschedule proposal that silently is not written is the
 * silent overwrite §62 exists to prevent.
 *
 * So a failure here THROWS, and the endpoint answers a real error. A refusal is
 * recoverable; an unrecorded credential attempt is not.
 *
 * ## Two new tables, nothing altered on `bookings`
 *
 * `bookings` is read by every client and every report. The codes themselves stay
 * in the columns they have always lived in (`otp_code`, `worker_code`) — this
 * adds the surrounding EVIDENCE beside them rather than widening the hot table.
 */

import dbQuery from '../../db/dbQuery';
import { db } from '../../config';

const s = db.schema;

export type Runner = { query: (sql: string, params?: any[]) => Promise<any> };

let ensured: Promise<void> | null = null;

/**
 * Creates the experience tables and the columns disputes needs.
 *
 * Memoised on the PROMISE, not on a boolean: two concurrent first requests must
 * await one DDL run rather than race two.
 */
export async function ensureExperienceSchema(): Promise<void> {
  if (!ensured) {
    ensured = (async () => {
      /**
       * Every code ever issued and every attempt ever made against one.
       *
       * The audit §63 asks for, and simultaneously the STATE the policy needs:
       * the newest `ISSUED` row dates the current code (expiry), its distance
       * from now gates a resend (cooldown), and the `FAILED` rows after it are
       * the attempt count. Deriving all three from one append-only log means
       * there is no counter that can disagree with its own history.
       *
       * `code_hash` is NOT stored. The plaintext code already lives on the
       * booking row where the compare-and-swap needs it; a second copy here
       * would be a credential in an audit table, which is the thing audit
       * tables are least able to protect.
       */
      await dbQuery.query(
        `CREATE TABLE IF NOT EXISTS ${s}.booking_otp_events (
           id          SERIAL PRIMARY KEY,
           booking_id  INTEGER NOT NULL,
           purpose     VARCHAR(40) NOT NULL,
           event       VARCHAR(20) NOT NULL,
           actor_uid   TEXT,
           actor_role  VARCHAR(24),
           detail      JSONB,
           created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
         )`,
        [],
      );
      await dbQuery.query(
        `CREATE INDEX IF NOT EXISTS idx_booking_otp_events_scope
           ON ${s}.booking_otp_events (booking_id, purpose, created_at DESC)`,
        [],
      );

      /**
       * A proposal per schedule change, accepted or not.
       *
       * `status` carries ACCEPTED / REFUSED / PENDING_PROVIDER. The third value
       * is unreachable while
       * `experiencePolicy.RESCHEDULE_REQUIRES_PROVIDER_ACCEPTANCE` is false, and
       * exists so flipping that flag needs no migration — the acceptance
       * workflow is a state this table can already hold.
       */
      await dbQuery.query(
        `CREATE TABLE IF NOT EXISTS ${s}.booking_reschedule_requests (
           id              SERIAL PRIMARY KEY,
           booking_id      INTEGER NOT NULL,
           previous_schedule TIMESTAMPTZ,
           proposed_schedule TIMESTAMPTZ NOT NULL,
           reason_code     VARCHAR(40),
           reason          TEXT,
           status          VARCHAR(24) NOT NULL,
           refusal_code    VARCHAR(40),
           requested_by    TEXT,
           requested_role  VARCHAR(24) NOT NULL,
           decided_at      TIMESTAMPTZ,
           created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
         )`,
        [],
      );
      await dbQuery.query(
        `CREATE INDEX IF NOT EXISTS idx_booking_reschedule_booking
           ON ${s}.booking_reschedule_requests (booking_id, created_at DESC)`,
        [],
      );

      /**
       * `booking_escalations` gains three columns; the table itself is not
       * recreated here.
       *
       * `adminBookingService.ensureBookingOpsSchema` owns its creation and the
       * admin portal reads every existing column. Adding the canonical fields
       * with `IF NOT EXISTS` keeps one dispute record for all three actors
       * instead of a second table that would give admin and customer different
       * answers to "is this booking disputed?".
       *
       * - `category`      the standardized vocabulary, distinct from the legacy
       *                   free-form `reason_code` admins have been writing.
       * - `opened_by_role` which seat raised it. `actor_uid` alone cannot say.
       * - `state_snapshot` the service and financial state AT OPENING (§66),
       *                    because a dispute argued three weeks later is argued
       *                    against a booking that has since moved.
       */
      await dbQuery.query(
        `CREATE TABLE IF NOT EXISTS ${s}.booking_escalations (
           id             SERIAL PRIMARY KEY,
           booking_id     INTEGER NOT NULL,
           reason_code    VARCHAR(80),
           reason         TEXT NOT NULL,
           severity       VARCHAR(20) NOT NULL DEFAULT 'normal',
           assigned_team  TEXT,
           actor_uid      TEXT,
           resolved_at    TIMESTAMPTZ,
           created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
         )`,
        [],
      );
      for (const column of [
        'category VARCHAR(40)',
        'opened_by_role VARCHAR(24)',
        'state_snapshot JSONB',
      ]) {
        await dbQuery.query(
          `ALTER TABLE ${s}.booking_escalations ADD COLUMN IF NOT EXISTS ${column}`,
          [],
        );
      }

      /**
       * At most ONE unresolved escalation per booking, enforced by the database.
       *
       * §66 requires duplicate prevention. The service checks first, but a check
       * followed by an insert is a race with a window, and two people reporting
       * the same problem within a second of each other is the most likely way
       * this is ever exercised. A partial unique index makes the second insert
       * fail rather than succeed, so the race has one authoritative outcome
       * whatever the application does.
       */
      await dbQuery.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_booking_escalations_one_open
           ON ${s}.booking_escalations (booking_id)
         WHERE resolved_at IS NULL`,
        [],
      );
    })().catch((error) => {
      // Un-memoise, so a transient failure does not poison every later request
      // with a rejected promise nobody can retry past.
      ensured = null;
      throw error;
    });
  }
  return ensured;
}

/** Test seam — the memo is module-global and would leak between cases. */
export function __resetExperienceSchema(): void {
  ensured = null;
}

/**
 * The unique-violation code, so a caller can tell "somebody beat me to it" from
 * a real failure without matching on a driver message.
 */
export const UNIQUE_VIOLATION = '23505';

export const isUniqueViolation = (error: unknown): boolean =>
  !!error && typeof error === 'object' && (error as { code?: string }).code === UNIQUE_VIOLATION;
