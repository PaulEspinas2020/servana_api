/**
 * THE only writer of booking lifecycle state.
 *
 * ## Why an ACTION and not a destination state
 *
 * `transitionBooking({ action: 'PROVIDER_START' })`, never
 * `transitionBooking({ toState: 'IN_PROGRESS' })`.
 *
 * A caller that names a destination can pick any state the machine happens to
 * allow from where the booking is, and bypass the business rule that was
 * supposed to get it there. Naming the action makes the machine decide what it
 * means — including which guards apply and who may do it.
 *
 * ## The order of operations, and why each step is where it is
 *
 *   1. idempotency lookup      a retry must not re-run the work
 *   2. BEGIN
 *   3. SELECT … FOR UPDATE     the row lock that stops two providers accepting
 *   4. derive canonical state  from the locked rows, never from the request
 *   5. expectedState check     optimistic concurrency, inside the lock
 *   6. authorize actor         from the loaded assignment, never from the body
 *   7. validate transition     the machine's whitelist
 *   8. write booking row
 *   9. write assignment row
 *  10. append timeline         SAME transaction — see below
 *  11. record idempotency      SAME transaction
 *  12. COMMIT
 *  13. return; the caller emits notifications AFTER commit
 *
 * Steps 3–11 are one transaction. The timeline is inside it deliberately: an
 * `UPDATE status; COMMIT; INSERT timeline` sequence lets operational state
 * change with no historical evidence, and the gap is exactly where a crash
 * leaves a booking that moved for no recorded reason.
 *
 * Notifications, push and websocket emission are downstream and are NOT done
 * here. §45: a notification failure must not roll back a committed transition.
 */

import type { PoolClient } from 'pg';
import { pool } from '../../db/dbQuery';
import dbQuery from '../../db/dbQuery';
import { db } from '../../config';
import {
  deriveCanonicalState,
  canTransition,
  isTerminal,
  type BookingState,
  type Actor,
} from './canonicalState';
import { CANONICAL_CANCELLED } from './cancellationVocabulary';
import { evaluateCancellation, customerMayCancel } from './bookingPolicies';

const s = db.schema;

// ─── Guards ───────────────────────────────────────────────────────────────────

/**
 * Named policy checks the machine runs before it will perform an action.
 *
 * A guard is business POLICY, distinct from the transition whitelist. The
 * whitelist answers "is this move structurally possible"; a guard answers "is
 * the operator willing to allow it right now". Both must pass, and both live
 * behind the executor so that no caller can route around either.
 *
 * The rules themselves are NOT written here. They live in `bookingPolicies.ts`
 * with their thresholds, so an operator changing the notice period edits one
 * named constant rather than hunting through a state machine. This layer only
 * decides which policy applies to which action, and turns a refusal into a
 * transport-neutral reason code.
 */
export type BookingGuardName =
  | 'providerCancellationWindow'
  | 'cashPaymentSettledBeforeCompletion'
  | 'bookingAwaitsOtpConfirmation'
  | 'customerCancellationStage';

export interface GuardVerdict {
  allowed: boolean;
  /** A specific, client-renderable reason. Never a generic failure. */
  reasonCode?: string;
  message?: string;
  /** Safe to show a provider. Deadlines, never another party's identity. */
  detail?: Record<string, unknown>;
}

export interface GuardContext {
  bookingId: number;
  bookingStatus: string | null;
  workerStatus: string | null;
  schedule: unknown;
  now: Date;
  metadata: Record<string, unknown>;
  /**
   * Reads whatever the guard needs, on the CALLER's connection.
   *
   * The executor passes its locked transaction, so a guard sees the same
   * consistent snapshot the decision is made in and cannot be raced between
   * the check and the write. `getAvailableActions` passes the pool, because
   * advertising what a provider may do is advisory and takes no lock.
   *
   * A guard that needs no data ignores it.
   */
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>;
}

/**
 * The guards, by name.
 *
 * Evaluated identically by the executor (enforcement) and by
 * `GET /api/v1/bookings/:id/transitions` (what the UI may offer). One
 * implementation for both is the point: a UI deciding button visibility from
 * its own copy of a rule eventually offers something the executor refuses.
 */
export const BOOKING_GUARDS: Record<BookingGuardName, (ctx: GuardContext) => GuardVerdict | Promise<GuardVerdict>> = {
  providerCancellationWindow: (ctx) => {
    const verdict = evaluateCancellation({
      workerStatus: ctx.workerStatus,
      schedule: ctx.schedule,
      now: ctx.now,
      reasonCode: (ctx.metadata.reasonCode as string | undefined) ?? undefined,
    });
    if (verdict.canCancel) return { allowed: true };

    // The block codes are already specific; they are surfaced rather than
    // flattened, because "you cannot cancel" and "you cannot cancel THIS CLOSE
    // to the start, the deadline was Thursday" are different answers to a
    // provider deciding what to do next.
    const REASONS: Record<string, string> = {
      INSIDE_NOTICE_WINDOW: 'BOOKING_PROVIDER_CANCEL_WINDOW_EXPIRED',
      NOT_CANCELLABLE_AT_THIS_STAGE: 'BOOKING_PROVIDER_CANCEL_STAGE_INVALID',
      SCHEDULE_UNKNOWN: 'BOOKING_PROVIDER_CANCEL_SCHEDULE_UNKNOWN',
      INVALID_REASON: 'BOOKING_PROVIDER_CANCEL_REASON_INVALID',
    };
    const reasonCode = REASONS[verdict.blockCode ?? ''] ?? 'BOOKING_PROVIDER_CANCEL_REFUSED';

    return {
      allowed: false,
      reasonCode,
      message:
        verdict.blockCode === 'INSIDE_NOTICE_WINDOW'
          ? `Self-cancellation closed ${verdict.noticeHours} hours before the scheduled start. Contact support.`
          : 'This booking cannot be cancelled by you at this stage.',
      detail: {
        // What a client needs to explain the refusal WITHOUT recomputing it.
        allowedUntil: verdict.allowedUntil,
        noticeHours: verdict.noticeHours,
        hoursUntilStart: verdict.hoursUntilStart,
      },
    };
  },

  /**
   * A cash job cannot be completed until the cash is recorded as received.
   *
   * ## This is a PRECONDITION, not a side effect
   *
   * It was previously an `EXISTS` clause inside `completeJob`'s UPDATE, which
   * made it a genuine transition guard: the write simply did not happen. The
   * migration had to classify it correctly or break it. Running it after the
   * executor committed would hand the caller `UnpaidCashBookingError` for a
   * booking that had ALREADY completed — a failure response over a successful
   * state change, and the provider's app would show the job still open while
   * the money pipeline treated it as done.
   *
   * So it is a named guard, evaluated inside the transaction, before any
   * write.
   *
   * ## The predicate is the legacy one, unchanged
   *
   *   EXISTS a payment row where the method is not CASH, or it is CASH and
   *   already PAID.
   *
   * Note what that means for a booking with NO payment row at all: EXISTS is
   * false, so completion is refused. That is existing behaviour and is
   * preserved deliberately rather than corrected here — a booking with no
   * payment record is not a completion problem to solve during a state-machine
   * migration.
   */
  cashPaymentSettledBeforeCompletion: async (ctx) => {
    const res = await ctx.query(
      `SELECT
         EXISTS (
           SELECT 1 FROM ${s}.payments p
            WHERE p.booking_id = $1
              AND (UPPER(COALESCE(p.method, '')) <> 'CASH'
                   OR UPPER(COALESCE(p.status, '')) = 'PAID')
         ) AS settled,
         (SELECT UPPER(COALESCE(method, '')) FROM ${s}.payments
           WHERE booking_id = $1 LIMIT 1) AS first_method,
         (SELECT UPPER(COALESCE(status, '')) FROM ${s}.payments
           WHERE booking_id = $1 LIMIT 1) AS first_status`,
      [ctx.bookingId],
    );
    if (res.rows[0]?.settled === true) return { allowed: true };

    // Classified exactly as the legacy miss-handler did: the FIRST payment row
    // decides whether this reads as unpaid cash or as a generic refusal.
    const method = String(res.rows[0]?.first_method ?? '');
    const status = String(res.rows[0]?.first_status ?? '');
    const unpaidCash = method === 'CASH' && status !== 'PAID';

    return {
      allowed: false,
      reasonCode: unpaidCash
        ? 'BOOKING_CASH_PAYMENT_REQUIRED'
        : 'BOOKING_COMPLETION_PAYMENT_UNSETTLED',
      message: unpaidCash
        ? "Record the customer's cash payment before completing this job"
        : 'This booking cannot be completed yet.',
      // No amounts, no payment ids. A provider needs to know what to do, not
      // the customer's payment record.
      detail: { cashPaymentOutstanding: unpaidCash },
    };
  },

  /**
   * The booking has not already been OTP-confirmed.
   *
   * ## Why a guard is needed at all: the derivation is LOSSY here
   *
   * `deriveCanonicalState` maps BOTH of these to AWAITING_ASSIGNMENT:
   *
   *   status = PAID,      worker_uid NULL   — paid, NOT yet OTP-confirmed
   *   status = CONFIRMED, worker_uid NULL   — confirmed, awaiting a provider
   *
   * Operationally they are the same thing — a booking with no provider on it —
   * so the collapse is right for every other purpose. It is wrong for exactly
   * one question: may this booking still be confirmed? The legacy
   * compare-and-swap answered it with
   * `status = 'PENDING_OTP' OR (status = 'PAID' AND worker_uid IS NULL)`, and
   * that clause is the ONLY reason replaying a valid OTP failed.
   *
   * Dropping it into the canonical UPDATE would rebuild a state machine in
   * SQL. Dropping it entirely lets a correct code confirm the same booking
   * twice — which the Phase C replay test caught. So it is stated here
   * instead: one named guard, one documented reason, in one place.
   *
   * ## Not a second state machine
   *
   * It answers a single question the canonical state cannot express, and it
   * answers nothing about legality — the machine has already decided the
   * transition is structurally permitted before this runs. If the derivation
   * ever gains a state that distinguishes "paid, unconfirmed" from
   * "confirmed", this guard is deleted rather than extended.
   */
  bookingAwaitsOtpConfirmation: (ctx) => {
    const status = String(ctx.bookingStatus ?? '').toUpperCase();
    if (status === 'PENDING_OTP') return { allowed: true };
    // Payment-first bookings land at PAID still needing the code. Once a
    // provider is on it, the moment for confirmation has passed.
    if (status === 'PAID' && !ctx.metadata.hasProvider) return { allowed: true };

    return {
      allowed: false,
      reasonCode: 'BOOKING_ALREADY_CONFIRMED',
      message: 'This booking is not awaiting verification.',
    };
  },

  /**
   * The stage a customer may still self-cancel from.
   *
   * Implements `requires: ['cancellation_eligible']`, which the transition
   * table has declared on the customer-cancel rules since it was written and
   * which nothing enforced. The machine permits customer cancellation from
   * ACCEPTED, EN_ROUTE and ARRIVED; the platform does not, once the provider
   * is travelling. Without this the migration would silently widen what a
   * customer can cancel.
   *
   * Reads the RAW status deliberately — see the list's own docblock. Two of
   * its entries are not canonical states, and deriving first would make them
   * cancellable.
   */
  customerCancellationStage: (ctx) => {
    if (customerMayCancel(ctx.bookingStatus)) return { allowed: true };
    return {
      allowed: false,
      reasonCode: 'BOOKING_NOT_CANCELLABLE_AT_THIS_STAGE',
      // The legacy message, verbatim: both callers surface it directly.
      message: `Cannot cancel booking with status: ${ctx.bookingStatus}`,
    };
  },
};

// ─── Actions ──────────────────────────────────────────────────────────────────

/**
 * Every lifecycle action, and what it means to the machine.
 *
 * `to` is what the machine is asked to validate. It is derived from the action,
 * not supplied by the caller — that is the whole point of an action-based API.
 *
 * ## Why some actions also name their SOURCE states
 *
 * The machine's whitelist is keyed on `(from, to, actor)`. Two actions that
 * share a destination AND an actor are therefore indistinguishable to it — and
 * four of these do:
 *
 *   PROVIDER_DECLINE / PROVIDER_CANCEL   both → AWAITING_ASSIGNMENT, provider
 *   ADMIN_ASSIGN     / ADMIN_REASSIGN    both → ASSIGNED,            admin
 *
 * Without `from`, declining an already-ACCEPTED booking is accepted as if it
 * were a cancellation. That is not a naming quibble: provider cancellation
 * carries a 48-hour policy check, its own tracking note and its own
 * notifications, so a decline that lands on the cancel transition slips past
 * all three. Found by the B1.2 tests, which expected the legacy refusal.
 *
 * `from` is what makes the action, not merely its destination, decide what is
 * legal. `tests/booking-state-machine.test.ts` fails if any two actions sharing
 * a destination and an actor have overlapping source states.
 */
export const BOOKING_ACTIONS = {
  /**
   * The customer proves presence with the booking OTP.
   *
   * `requires` is not documentation. It is checked before any write, so the
   * action cannot be performed without the credential even by an internal
   * caller that never went near HTTP — which is exactly the hole this closes:
   * before Phase C this branch wrote CONFIRMED with no credential check at
   * all, and was saved only by not yet being wired to an endpoint.
   */
  CUSTOMER_CONFIRM_OTP: {
    to: 'AWAITING_ASSIGNMENT', actor: 'customer',
    from: ['PENDING_OTP', 'AWAITING_ASSIGNMENT'],
    requires: 'BOOKING_OTP',
    guard: 'bookingAwaitsOtpConfirmation',
  },
  CUSTOMER_CANCEL: {
    to: 'CANCELLED', actor: 'customer',
    guard: 'customerCancellationStage',
  },
  PROVIDER_ACCEPT: { to: 'ACCEPTED', actor: 'assigned_provider' },
  /** Answering an offer. Only ever from an unanswered assignment. */
  PROVIDER_DECLINE: {
    to: 'AWAITING_ASSIGNMENT', actor: 'assigned_provider',
    from: ['ASSIGNED'],
  },
  PROVIDER_EN_ROUTE: { to: 'EN_ROUTE', actor: 'assigned_provider' },
  PROVIDER_ARRIVED: { to: 'ARRIVED', actor: 'assigned_provider' },
  PROVIDER_START: { to: 'IN_PROGRESS', actor: 'assigned_provider' },
  PROVIDER_COMPLETE: {
    to: 'COMPLETED', actor: 'assigned_provider',
    guard: 'cashPaymentSettledBeforeCompletion',
  },
  /** Walking away from a job already taken on. Subject to the 48-hour policy. */
  PROVIDER_CANCEL: {
    to: 'AWAITING_ASSIGNMENT', actor: 'assigned_provider',
    from: ['ACCEPTED', 'EN_ROUTE', 'ARRIVED'],
    guard: 'providerCancellationWindow',
  },
  // Not PENDING_OTP: the machine has no such transition, because a booking is
  // not assignable until its OTP is confirmed.
  ADMIN_ASSIGN: { to: 'ASSIGNED', actor: 'admin', from: ['AWAITING_ASSIGNMENT'] },
  ADMIN_REASSIGN: {
    to: 'ASSIGNED', actor: 'admin',
    from: ['ASSIGNED', 'ACCEPTED', 'EN_ROUTE', 'ARRIVED'],
  },
  ADMIN_CANCEL: { to: 'CANCELLED', actor: 'admin' },
  ADMIN_COMPLETE: { to: 'COMPLETED', actor: 'admin' },
  SYSTEM_EXPIRE: { to: 'EXPIRED', actor: 'system' },
} as const satisfies Record<
  string,
  {
    to: BookingState;
    actor: Actor;
    from?: readonly BookingState[];
    guard?: BookingGuardName;
    requires?: BookingCredential;
  }
>;

/**
 * A secret the ACTOR must present, checked atomically with the write.
 *
 * Distinct from a guard. A guard asks the operator's policy a question the
 * server can answer alone; a credential is something only the right person
 * holds, and it is verified in the same statement as the mutation so there is
 * no window between proving it and using it.
 *
 * Both existing credentials are six-digit codes the CUSTOMER reads out or
 * receives, and both are compared inside the UPDATE rather than before it.
 */
export type BookingCredential = 'BOOKING_OTP' | 'WORKER_CODE';

/** Which metadata field carries each credential, and how it is refused. */
const CREDENTIAL_FIELD: Record<BookingCredential, { field: string; code: TransitionErrorCode; message: string }> = {
  BOOKING_OTP: {
    field: 'otp',
    code: 'BOOKING_OTP_INVALID',
    message: 'That code does not match this booking.',
  },
  WORKER_CODE: {
    field: 'workerCode',
    code: 'WORKER_CODE_INVALID',
    message: 'That code does not match this booking. Ask the customer to read it again.',
  },
};

export type BookingAction = keyof typeof BOOKING_ACTIONS;

export const isBookingAction = (v: unknown): v is BookingAction =>
  typeof v === 'string' && Object.prototype.hasOwnProperty.call(BOOKING_ACTIONS, v);

// ─── Outcomes ─────────────────────────────────────────────────────────────────

export type TransitionErrorCode =
  /** The booking does not exist. */
  | 'BOOKING_NOT_FOUND'
  /** The caller is not this booking's customer / current provider / an admin. */
  | 'NOT_AUTHORIZED'
  /** The machine has no such transition from the current state. */
  | 'INVALID_TRANSITION'
  /** The booking already finished. */
  | 'TERMINAL_STATE'
  /** `expectedState` did not match. Reload and decide again. */
  | 'BOOKING_STATE_CONFLICT'
  /** A named guard was not satisfied. */
  | 'GUARD_FAILED'
  /** Same key, different request. */
  | 'IDEMPOTENCY_KEY_REUSED'
  /**
   * The customer's six-digit code did not match.
   *
   * Distinct from GUARD_FAILED because it is the ONE precondition checked
   * atomically with the write rather than before it — state, assignment and
   * terminality are all already validated when this fires, so it names exactly
   * one cause. The legacy path answered "Job cannot be started" for all four.
   */
  | 'WORKER_CODE_INVALID'
  /**
   * The booking OTP did not match.
   *
   * Same shape as WORKER_CODE_INVALID and for the same reason: state,
   * authorization and terminality are all validated before the statement runs,
   * so a zero-row result names exactly one cause.
   */
  | 'BOOKING_OTP_INVALID'
  /**
   * A named policy guard refused, and said which.
   *
   * Separate from GUARD_FAILED because a policy refusal is not a malformed
   * request: the caller did everything right and the answer is still no. The
   * `detail` carries the specific reason and, where the rule is time-based, the
   * deadline — so Provider Web and ServanaWorker can explain the refusal
   * without reimplementing the calculation.
   */
  | 'POLICY_REFUSED';

/**
 * The rows the executor read under `FOR UPDATE`, as they were when it refused.
 *
 * Attached to every refusal raised after the lock is held. Callers that owe
 * their clients a richer vocabulary than the executor's eight codes — the
 * provider accept/decline path owes six of its own — can classify from this
 * instead of issuing a second, unlocked read. A snapshot taken outside the
 * transaction can disagree with the one the decision was actually made on, and
 * an error message that contradicts the refusal is worse than a vague one.
 */
export interface LockedSnapshot {
  bookingStatus: string | null;
  bookingWorkerUid: string | null;
  /** The CURRENT provider's assignment row. */
  assignmentStatus: string | null;
  /** The ACTOR's own assignment row, which after a decline is the only one. */
  actorAssignmentStatus: string | null;
  canonicalState: BookingState;
}

export class TransitionError extends Error {
  constructor(
    readonly code: TransitionErrorCode,
    message: string,
    readonly detail?: Record<string, unknown>,
    /** Present on refusals raised after the row lock was taken. */
    readonly snapshot?: LockedSnapshot,
  ) {
    super(message);
    this.name = 'TransitionError';
  }
}

export interface TransitionResult {
  bookingId: number;
  action: BookingAction;
  fromState: BookingState;
  toState: BookingState;
  /** True when this call did nothing because an identical one already had. */
  idempotentReplay: boolean;
  /** Correlation id, echoed into the timeline row. */
  correlationId: string;
  timelineEventId: number | null;
}

export interface TransitionInput {
  bookingId: number;
  action: BookingAction;
  /** Who is asking. Resolved from the token by the caller — never from a body. */
  actorUid: string | null;
  actorRole: Actor;
  /** Optimistic concurrency. When supplied and stale, the call is refused. */
  expectedState?: BookingState;
  idempotencyKey?: string | null;
  /** Reason, worker code, resolution — whatever the guards need. */
  metadata?: Record<string, unknown>;
  correlationId?: string;
}

// ─── Schema ───────────────────────────────────────────────────────────────────

let ensured: Promise<void> | null = null;

/**
 * Timeline and idempotency tables.
 *
 * Memoised and AWAITED by the executor rather than fired at boot: `app.ts`
 * launches fourteen schema bootstraps without waiting for any of them, so a
 * table created that way is not guaranteed to exist when the first request
 * arrives. This is the same reasoning as `otpService`.
 */
export async function ensureTransitionSchema(): Promise<void> {
  if (!ensured) {
    ensured = (async () => {
      await dbQuery.query(
        `CREATE TABLE IF NOT EXISTS ${s}.booking_transitions (
           id            BIGSERIAL PRIMARY KEY,
           booking_id    INTEGER     NOT NULL,
           action        TEXT        NOT NULL,
           from_state    TEXT        NOT NULL,
           to_state      TEXT        NOT NULL,
           actor_role    TEXT        NOT NULL,
           actor_uid     TEXT,
           provider_uid  TEXT,
           reason        TEXT,
           metadata      JSONB       NOT NULL DEFAULT '{}'::jsonb,
           correlation_id TEXT,
           occurred_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
         )`,
        [],
      );
      await dbQuery.query(
        `CREATE INDEX IF NOT EXISTS idx_booking_transitions_booking
           ON ${s}.booking_transitions (booking_id, occurred_at)`,
        [],
      );
      await dbQuery.query(
        `CREATE TABLE IF NOT EXISTS ${s}.booking_transition_idempotency (
           actor_uid       TEXT        NOT NULL,
           booking_id      INTEGER     NOT NULL,
           action          TEXT        NOT NULL,
           idempotency_key TEXT        NOT NULL,
           request_digest  TEXT        NOT NULL,
           result          JSONB       NOT NULL,
           created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           PRIMARY KEY (actor_uid, booking_id, action, idempotency_key)
         )`,
        [],
      );
    })().catch((error) => {
      ensured = null;
      throw error;
    });
  }
  return ensured;
}

/** Test seam. */
export const __resetTransitionSchema = () => { ensured = null; };

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * A stable digest of the request, so a reused key with a DIFFERENT payload is a
 * conflict rather than a replay of somebody else's answer.
 *
 * Non-cryptographic on purpose: this detects an accidental key reuse by a
 * client, not an attack. The key itself is already scoped to one actor and one
 * booking by the primary key.
 */
export const requestDigest = (input: TransitionInput): string => {
  const canonical = JSON.stringify({
    action: input.action,
    expectedState: input.expectedState ?? null,
    metadata: input.metadata ?? {},
  });
  let h = 0;
  for (let i = 0; i < canonical.length; i++) h = (h * 31 + canonical.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
};

const newCorrelationId = (): string =>
  `bt_${Date.now().toString(36)}_${Math.abs((Math.random() * 1e9) | 0).toString(36)}`;

interface LoadedBooking {
  id: number;
  status: string | null;
  customerUid: string | null;
  workerUid: string | null;
  assignmentStatus: string | null;
  /**
   * The ACTOR's own assignment row, which is not always the booking's current
   * one. After a decline the booking has no provider at all, so
   * `assignmentStatus` is null and only this can tell a provider who already
   * declined ("you have already done this", 200) from a stranger ("not yours",
   * 409). Null when the actor never had a row, or is not a provider.
   */
  actorAssignmentStatus: string | null;
  /** Scheduled start, needed by time-based policy guards. */
  schedule: unknown;
  /** An open escalation exists. */
  hasEscalation: boolean;
}

/**
 * Loads the booking and its ACTIVE assignment, holding a row lock.
 *
 * `FOR UPDATE` on the booking row is what makes the accept/accept race
 * impossible: the second transaction blocks until the first commits, then reads
 * the state the first produced and is refused by the machine. Optimistic
 * checking alone would let both read ASSIGNED and both proceed.
 *
 * The assignment is read with `FOR UPDATE` too — reassignment writes it, and
 * locking only the parent would leave that write unserialised.
 */
async function loadForUpdate(
  client: PoolClient,
  bookingId: number,
  actorUid: string | null,
): Promise<LoadedBooking | null> {
  const booking = await client.query(
    `SELECT id, status, user_id AS customer_uid, worker_uid, schedule
       FROM ${s}.bookings
      WHERE id = $1
      FOR UPDATE`,
    [bookingId],
  );
  if (!booking.rows.length) return null;
  const row = booking.rows[0];

  const assignment = await client.query(
    `SELECT status
       FROM ${s}.booking_workers
      WHERE booking_id = $1 AND worker_uid = $2
      ORDER BY assigned_at DESC NULLS LAST, id DESC
      LIMIT 1
      FOR UPDATE`,
    [bookingId, row.worker_uid],
  );

  // An escalation makes the booking DISPUTED. Read inside the same transaction
  // so a dispute raised concurrently cannot be missed by this decision.
  const escalation = await client.query(
    `SELECT 1 FROM ${s}.booking_transitions
      WHERE booking_id = $1 AND to_state = 'DISPUTED'
      LIMIT 1`,
    [bookingId],
  );

  // The actor's OWN row, when they are not the booking's current provider.
  // Locked too: the classification a caller builds from it must not be read
  // from a moment other than the one the decision was made in.
  let actorAssignmentStatus: string | null = assignment.rows[0]?.status ?? null;
  if (actorUid && actorUid !== row.worker_uid) {
    const own = await client.query(
      `SELECT status
         FROM ${s}.booking_workers
        WHERE booking_id = $1 AND worker_uid = $2
        ORDER BY assigned_at DESC NULLS LAST, id DESC
        LIMIT 1
        FOR UPDATE`,
      [bookingId, actorUid],
    );
    actorAssignmentStatus = own.rows[0]?.status ?? null;
  }

  return {
    id: Number(row.id),
    status: row.status ?? null,
    customerUid: row.customer_uid ?? null,
    workerUid: row.worker_uid ?? null,
    assignmentStatus: assignment.rows[0]?.status ?? null,
    actorAssignmentStatus,
    schedule: row.schedule ?? null,
    hasEscalation: escalation.rows.length > 0,
  };
}

/**
 * Is this actor who they claim to be FOR THIS BOOKING?
 *
 * Derived entirely from the loaded rows. Nothing here reads a customer or
 * provider id from the request — §11: ids are identifiers, not authorization,
 * and this is the one place the distinction has teeth.
 */
function authorize(loaded: LoadedBooking, input: TransitionInput): void {
  const { actorRole, actorUid } = input;

  if (actorRole === 'admin' || actorRole === 'system') return;

  if (!actorUid) {
    throw new TransitionError('NOT_AUTHORIZED', 'No authenticated actor.');
  }

  if (actorRole === 'customer') {
    if (loaded.customerUid && loaded.customerUid === actorUid) return;
    throw new TransitionError('NOT_AUTHORIZED', 'This booking is not yours.');
  }

  if (actorRole === 'assigned_provider') {
    // The CURRENT assignment, not a past one. A provider who was reassigned
    // away keeps a valid token and a stale app; this is what stops them
    // advancing a booking that is no longer theirs.
    if (loaded.workerUid && loaded.workerUid === actorUid) return;
    throw new TransitionError('NOT_AUTHORIZED', 'You are not the assigned provider for this booking.');
  }

  throw new TransitionError('NOT_AUTHORIZED', 'Unrecognised actor.');
}

/**
 * ─── LEGACY_STATUS_PROJECTION ────────────────────────────────────────────────
 *
 * Mirrors an arrival state onto `bookings.status`.
 *
 * ## This is NOT canonical state
 *
 * The canonical operational progression lives on `booking_workers.status`.
 * `bookings.status` carrying EN_ROUTE or ARRIVED is a duplicate, and it is
 * exactly the dual-status architecture this command exists to end. It is
 * written anyway, for one measured reason.
 *
 * ## The measured reason
 *
 * A sweep of every consumer (2026-08-12) found the backend does not depend on
 * it at all — all 29 `bookings.status` filters use COMPLETED, CANCELLED,
 * PENDING_OTP, CONFIRMED, PAID, WORKER_ASSIGNED, IN_PROGRESS, REFUNDED, FAILED
 * or EXPIRED, and every arrival-aware SQL predicate is on
 * `booking_workers.status`. Neither does the Admin portal, Provider Web,
 * ServanaWorker or the customer web portal.
 *
 * ServanaClient does. `formatBooking` spreads the raw row, so the customer app
 * receives both `status` and `effectiveStatus`, and it reads `status` in the
 * two places that matter:
 *
 *   customer_booking.dart:166           the bookings LIST
 *   assignment_polling_service.dart:100 the POLLER that detects the transition
 *
 * Drop the projection and neither errors — the booking simply never appears to
 * progress. A silent stall on the largest installed base.
 *
 * ## Retirement
 *
 * LEGACY_STATUS_PROJECTION_RETIREMENT_BLOCKER:
 *   ServanaClient's bookings list and assignment poller read `bookings.status`.
 *
 * RETIREMENT CONDITION — both, not either:
 *   1. A customer-app version reading `effectiveStatus` (or `canonicalState`)
 *      is released AND sufficiently adopted; and
 *   2. production telemetry confirms no installed version still requires the
 *      projection.
 *
 * Two Dart lines is the code change. It is not the retirement condition —
 * an unupdated app keeps reading the old field for as long as it stays
 * installed, which is the whole reason mobile aliases carry a 90-day rule.
 *
 * ## The rule this must never break
 *
 * The value written here is DERIVED from a transition the canonical machine has
 * already approved, under the row lock, before this runs. It is never an input
 * to whether the transition is legal. A projection that starts deciding things
 * is a second state machine, and `tests/booking-legacy-status-projection.test.ts`
 * fails if this is reached from anywhere but an approved transition.
 */
async function writeLegacyStatusProjection(
  client: PoolClient,
  bookingId: number,
  providerUid: string | null,
  approvedState: Extract<BookingState, 'EN_ROUTE' | 'ARRIVED'>,
): Promise<void> {
  if (!providerUid) return;
  // Scoped to this provider's booking, exactly as `advanceArrivalStage` was, so
  // a concurrent admin action on a reassigned booking cannot be clobbered.
  await client.query(
    `UPDATE ${s}.bookings SET status = $2 WHERE id = $1 AND worker_uid = $3`,
    [bookingId, approvedState, providerUid],
  );
}

/**
 * ─── LEGACY_TRACKING_PROJECTION ──────────────────────────────────────────────
 *
 * Appends the row `booking_tracking` has always carried for this action.
 *
 * ## Why this is not the timeline
 *
 * `booking_transitions` is the canonical lifecycle history and every new
 * surface reads it. `booking_tracking` is older and wider: payments, refunds
 * and admin operations write to it too, so it is not a lifecycle-owned table
 * and the executor cannot claim it. But three live surfaces read it —
 *
 *   controllers/providerController.ts:3241   the provider job history
 *   services/adminBookingService.ts:723      the admin booking timeline
 *   services/bookingService.ts:666           the customer booking timeline
 *
 * — so a migrated action that stops writing it silently loses a row from three
 * timelines at once. That is a regression, not a cleanup.
 *
 * ## Why it is in the transaction
 *
 * It always was. Legacy wrote the tracking row between the status UPDATE and
 * the COMMIT; writing it after the commit instead would open the window where
 * a booking has advanced with no entry in the timeline the customer is looking
 * at.
 *
 * ## Why the map is incomplete
 *
 * One entry per migrated action, added by the phase that migrates it, with the
 * note text copied verbatim from the legacy site. An action absent from this
 * map has not been migrated yet, and the legacy service is still writing its
 * own row — adding a speculative entry now would double-write it.
 */
const LEGACY_TRACKING: Partial<Record<BookingAction, { status: string; note: string }>> = {
  // technicianService.acceptJob
  PROVIDER_ACCEPT: { status: 'ACCEPTED', note: 'Provider accepted the booking' },
  // technicianService.releaseBookingAndReassign, called by declineJob.
  // The tracking STATUS is the booking's new status, not the canonical state —
  // the row records where the booking landed, and it landed back at CONFIRMED.
  PROVIDER_DECLINE: { status: 'CONFIRMED', note: 'Worker declined — seeking reassignment' },
  // technicianService.markEnRoute. Here the tracking status IS the canonical
  // state, because the legacy path cascaded it onto `bookings.status` too.
  PROVIDER_EN_ROUTE: { status: 'EN_ROUTE', note: 'Provider is on the way' },
  // technicianService.markArrived.
  PROVIDER_ARRIVED: { status: 'ARRIVED', note: 'Provider has arrived' },
  // bookingService.confirmOtp
  CUSTOMER_CONFIRM_OTP: { status: 'CONFIRMED', note: 'OTP verified' },
};

/**
 * ─── LEGACY_TIMELINE_EVENT_PROJECTION ────────────────────────────────────────
 *
 * `booking_timeline_events` is a THIRD event table, older than
 * `booking_transitions` and narrower than `booking_tracking`. Customer
 * cancellation is the only lifecycle action that writes it today.
 *
 * Same reasoning as the tracking projection: it is read by a live surface, so
 * an action that stops writing it loses a row from a customer's timeline, and
 * legacy wrote it as a bare statement after the status write — a failure there
 * threw AFTER the cancellation had already committed. Inside the transaction
 * it either happens or the cancellation does not.
 *
 * Not canonical. `booking_transitions` remains the evidence; this retires when
 * the surfaces reading it move over.
 */
const LEGACY_TIMELINE_EVENT: Partial<Record<BookingAction, {
  eventType: string; title: string; actorType: string;
}>> = {
  CUSTOMER_CANCEL: {
    eventType: 'booking_cancelled',
    title: 'Booking cancelled by customer',
    actorType: 'customer',
  },
};

async function writeLegacyTimelineEvent(
  client: PoolClient,
  loaded: LoadedBooking,
  input: TransitionInput,
): Promise<void> {
  const entry = LEGACY_TIMELINE_EVENT[input.action];
  if (!entry) return;
  const reasonCode = input.metadata?.reasonCode;
  await client.query(
    `INSERT INTO ${s}.booking_timeline_events
       (booking_id, event_type, title, description, actor_type, actor_uid, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      loaded.id,
      entry.eventType,
      entry.title,
      input.metadata?.reason ? String(input.metadata.reason) : null,
      entry.actorType,
      input.actorUid ?? null,
      reasonCode ? JSON.stringify({ reasonCode }) : null,
    ],
  );
}

async function writeLegacyTracking(
  client: PoolClient,
  bookingId: number,
  action: BookingAction,
): Promise<void> {
  const entry = LEGACY_TRACKING[action];
  if (!entry) return;
  await client.query(
    `INSERT INTO ${s}.booking_tracking (booking_id, status, note) VALUES ($1, $2, $3)`,
    [bookingId, entry.status, entry.note],
  );
}

/** The physical writes a canonical destination implies. */
async function applyState(
  client: PoolClient,
  loaded: LoadedBooking,
  to: BookingState,
  input: TransitionInput,
): Promise<void> {
  const providerUid = loaded.workerUid;

  switch (to) {
    case 'AWAITING_ASSIGNMENT': {
      // Reached by confirmOtp, decline, or a provider cancel. In the latter two
      // the assignment ends and the booking returns to the pool — the OLD
      // assignment is closed rather than overwritten, so its history survives.
      if (input.action === 'CUSTOMER_CONFIRM_OTP') {
        /**
         * The OTP is compared IN the statement that writes, exactly as the
         * legacy compare-and-swap did.
         *
         * A check-then-write would be equivalent only if the lock behaves as
         * expected; keeping the predicate here means the credential and the
         * mutation cannot be separated at all. Same reasoning as the worker
         * code on PROVIDER_START.
         *
         * What is deliberately NOT reproduced is the legacy statement's other
         * half —
         *
         *   status = 'PENDING_OTP' OR (status = 'PAID' AND worker_uid IS NULL)
         *
         * — which was a second state machine written in SQL. The canonical
         * machine has already decided this transition is legal from this
         * state, under the row lock, before this line runs. One authority for
         * the lifecycle; the predicate is only for the credential.
         */
        const otp = String(input.metadata?.otp ?? '').trim();
        const confirmed = await client.query(
          `UPDATE ${s}.bookings SET status = 'CONFIRMED'
            WHERE id = $1 AND otp_code = $2::text`,
          [loaded.id, otp],
        );
        if (!confirmed.rowCount) {
          throw new TransitionError('BOOKING_OTP_INVALID', CREDENTIAL_FIELD.BOOKING_OTP.message);
        }
        return;
      }
      if (!providerUid) return;

      const declined = input.action === 'PROVIDER_DECLINE';
      await client.query(
        `UPDATE ${s}.booking_workers
            SET status = $3,
                declined_at = CASE WHEN $4 THEN NOW() ELSE declined_at END
          WHERE booking_id = $1 AND worker_uid = $2`,
        [loaded.id, providerUid, declined ? 'DECLINED' : CANONICAL_CANCELLED, declined],
      );

      /**
       * The full release, not just the pointer.
       *
       * `worker_code` is the part that matters beyond tidiness. It is the
       * six-digit code the customer reads out to start the job, and it is never
       * consumed — clearing it here is the ONLY thing that invalidates it for
       * the provider who just walked away. Leaving it set would let a declined
       * provider start the job later with a code they had already been given.
       *
       * `status = 'CONFIRMED'` is what returns the booking to the pool: with
       * `worker_uid` NULL it derives as AWAITING_ASSIGNMENT, which is where the
       * reassignment search expects to find it. The ETA fields belonged to the
       * departing provider and describe nothing now.
       */
      await client.query(
        `UPDATE ${s}.bookings
            SET worker_uid  = NULL,
                status      = 'CONFIRMED',
                eta_minutes = NULL,
                eta_at      = NULL,
                worker_code = NULL
          WHERE id = $1`,
        [loaded.id],
      );
      return;
    }

    case 'ASSIGNED': {
      /**
       * Assign and reassign are NOT interchangeable, even though both land here.
       *
       * `from` already separates them — ADMIN_ASSIGN only from
       * AWAITING_ASSIGNMENT, ADMIN_REASSIGN only from a live assignment — so
       * reaching this branch with the wrong one is impossible. What this checks
       * is the other half: that the operation actually does what its name says.
       *
       * An ADMIN_ASSIGN that quietly closed an existing assignment would be a
       * reassignment wearing the wrong label, and the timeline would record it
       * as one. "Assigned Provider A" and "Reassigned Provider A → Provider B"
       * are different events to anyone reading a booking's history, and the
       * distinction cannot be recovered afterwards.
       */
      const nextProvider = String(input.metadata?.providerUid ?? '');
      if (!nextProvider) {
        throw new TransitionError('GUARD_FAILED', 'providerUid is required to assign.', { guard: 'provider_eligible' });
      }
      if (input.action === 'ADMIN_ASSIGN' && providerUid) {
        throw new TransitionError(
          'INVALID_TRANSITION',
          'This booking already has a provider. Use ADMIN_REASSIGN.',
          { currentState: 'ASSIGNED', reason: 'ASSIGNMENT_ALREADY_EXISTS' },
        );
      }
      if (input.action === 'ADMIN_REASSIGN' && !providerUid) {
        throw new TransitionError(
          'INVALID_TRANSITION',
          'This booking has no provider to reassign. Use ADMIN_ASSIGN.',
          { currentState: 'AWAITING_ASSIGNMENT', reason: 'NO_ASSIGNMENT_TO_REPLACE' },
        );
      }
      if (providerUid && providerUid !== nextProvider) {
        /**
         * Close the outgoing assignment. Never overwrite it: the old
         * provider's progression has to stay readable, and TAB 05 depends on
         * an assignment row being terminal rather than mutated.
         *
         * ## Why DECLINED and not REASSIGNED
         *
         * REASSIGNED is the semantically accurate word, and it is NOT used,
         * because `DECLINED` is load-bearing for two live consumers:
         *
         *   technicianService.ts:917       auto-assignment EXCLUDES providers
         *                                  whose row on this booking says
         *                                  DECLINED, so they are not offered
         *                                  it again
         *   providerPerformanceService:70  counts DECLINED as the provider's
         *                                  declined metric
         *
         * The first is the one that decides this. Writing REASSIGNED would
         * make the provider an admin has just removed immediately eligible for
         * auto-assignment back onto the same booking — the booking bouncing
         * straight back to the person it was taken from.
         *
         * So the legacy value is preserved verbatim. The distinction the
         * timeline needs is not lost by doing so: `booking_transitions`
         * records ADMIN_REASSIGN as its own action, which is the canonical
         * evidence that this was a reassignment and not a refusal.
         *
         * KNOWN DISTORTION, deferred to the assignment work: a provider's
         * acceptance rate is damaged by an admin's decision. Fixing it means
         * either a distinct status plus the matching exclusion updated to read
         * both, or a metric that reads `booking_transitions` instead. Both are
         * assignment-policy changes, not state-machine ones.
         */
        await client.query(
          `UPDATE ${s}.booking_workers SET status = 'DECLINED'
            WHERE booking_id = $1 AND worker_uid = $2`,
          [loaded.id, providerUid],
        );
      }
      await client.query(
        `INSERT INTO ${s}.booking_workers (booking_id, worker_uid, status, assigned_at)
         VALUES ($1, $2, 'ASSIGNED', NOW())
         ON CONFLICT DO NOTHING`,
        [loaded.id, nextProvider],
      );
      await client.query(`UPDATE ${s}.bookings SET worker_uid = $2 WHERE id = $1`, [loaded.id, nextProvider]);
      return;
    }

    case 'ACCEPTED':
      // `accepted_at` is what the provider app renders as "accepted at" and what
      // `emitToProvider` echoes back on the socket. It is a timestamp, not a
      // state — but it must land in the same statement as the state, or a crash
      // between them leaves an ACCEPTED row that never records when.
      await client.query(
        `UPDATE ${s}.booking_workers SET status = $3, accepted_at = NOW()
          WHERE booking_id = $1 AND worker_uid = $2`,
        [loaded.id, providerUid, to],
      );
      return;

    case 'EN_ROUTE':
    case 'ARRIVED': {
      /**
       * Canonical: the provider lifecycle lives on the assignment row.
       *
       * The timestamp column is chosen from the destination rather than passed
       * in, so a caller cannot stamp `arrived_at` on an EN_ROUTE transition.
       * The columns are real as of migration 027 — the executor performs no
       * schema repair of its own.
       */
      const stampedAt = to === 'EN_ROUTE' ? 'en_route_at' : 'arrived_at';
      await client.query(
        `UPDATE ${s}.booking_workers SET status = $3, ${stampedAt} = NOW()
          WHERE booking_id = $1 AND worker_uid = $2`,
        [loaded.id, providerUid, to],
      );
      await writeLegacyStatusProjection(client, loaded.id, providerUid, to);
      return;
    }

    case 'IN_PROGRESS': {
      /**
       * The worker code is checked ATOMICALLY, in the same statement as the
       * write.
       *
       * `technicianService.startJob` has always done this, and it is the right
       * shape: the six-digit code the customer reads out is the only gate on
       * starting a chargeable job, and a check-then-write leaves a window
       * between the two. Moving the transition into the executor must not
       * downgrade that to a lock-plus-check that is only equivalent if the lock
       * behaves as expected.
       *
       * ## What this predicate does NOT do
       *
       * The legacy statement also carried
       * `bw.status IN ('ACCEPTED','EN_ROUTE','ARRIVED')` — a second, separately
       * maintained copy of the transition table living in SQL. It is not
       * reproduced here. The canonical machine already decided that this
       * transition is legal from this state, under the row lock, before we
       * reach this line. One authority for the lifecycle; the predicate is only
       * for the credential.
       *
       * ## Which is why a zero-row result means one thing
       *
       * State, assignment and terminality were all validated above. The only
       * remaining reason this statement matches nothing is the code, so the
       * caller gets BOOKING_WORKER_CODE_INVALID rather than the legacy
       * "Job cannot be started", which conflated a wrong code, a wrong state
       * and a wrong provider into one unactionable sentence.
       *
       * The code is NOT consumed. It is cleared only when the provider is
       * unassigned (`technicianService` sets `worker_code = NULL` on reset), so
       * reassignment already invalidates it for the outgoing provider. No
       * one-time behaviour is introduced here, because none exists today.
       */
      const workerCode = input.metadata?.workerCode;
      if (typeof workerCode !== 'string' || !workerCode.trim()) {
        throw new TransitionError('GUARD_FAILED', 'A worker code is required to start this job.', {
          guard: 'worker_code',
        });
      }

      const started = await client.query(
        `UPDATE ${s}.booking_workers bw
            SET status = 'IN_PROGRESS', started_at = NOW()
           FROM ${s}.bookings b
          WHERE bw.booking_id = $1
            AND bw.worker_uid = $2
            AND bw.booking_id = b.id
            AND b.worker_code = $3
          RETURNING bw.booking_id`,
        [loaded.id, providerUid, workerCode.trim()],
      );

      if (!started.rowCount) {
        throw new TransitionError(
          'WORKER_CODE_INVALID',
          'That code does not match this booking. Ask the customer to read it again.',
        );
      }
      return;
    }

    case 'COMPLETED':
      await client.query(`UPDATE ${s}.bookings SET status = 'COMPLETED' WHERE id = $1`, [loaded.id]);
      if (providerUid) {
        await client.query(
          `UPDATE ${s}.booking_workers SET status = 'COMPLETED', completed_at = NOW()
            WHERE booking_id = $1 AND worker_uid = $2`,
          [loaded.id, providerUid],
        );
      }
      return;

    case 'CANCELLED': {
      // The canonical spelling, always. The deprecated one is read-only.
      await client.query(
        `UPDATE ${s}.bookings SET status = $2, cancelled_at = NOW() WHERE id = $1`,
        [loaded.id, CANONICAL_CANCELLED],
      );
      /**
       * Every LIVE assignment row, not only the current provider's.
       *
       * The legacy customer-cancel closed any row in an active status; scoping
       * to `worker_uid` alone would leave a stale live assignment on a
       * cancelled booking if the pointer had already been cleared. Closed rows
       * — DECLINED, REASSIGNED, COMPLETED — are history and are left alone.
       */
      await client.query(
        `UPDATE ${s}.booking_workers SET status = $2
          WHERE booking_id = $1
            AND status IN ('ASSIGNED','ACCEPTED','EN_ROUTE','ARRIVED')`,
        [loaded.id, CANONICAL_CANCELLED],
      );
      return;
    }

    case 'EXPIRED':
      await client.query(`UPDATE ${s}.bookings SET status = 'EXPIRED' WHERE id = $1`, [loaded.id]);
      return;

    case 'DISPUTED':
    case 'PENDING_OTP':
      // DISPUTED is recorded by the timeline row alone — it is an exception
      // ON TOP of the service outcome, and writing it into `bookings.status`
      // would erase whether the booking had completed or been cancelled. That
      // distinction has different financial consequences downstream.
      return;

    default: {
      const unreachable: never = to;
      throw new Error(`No write mapping for ${String(unreachable)}`);
    }
  }
}

// ─── The executor ─────────────────────────────────────────────────────────────

/**
 * Perform one lifecycle action.
 *
 * The only function permitted to write `bookings.status` or
 * `booking_workers.status`. `tests/booking-raw-write-guard.test.ts` enforces
 * that, with an allow-list of the legacy sites still being migrated.
 */
export async function transitionBooking(input: TransitionInput): Promise<TransitionResult> {
  await ensureTransitionSchema();

  const correlationId = input.correlationId ?? newCorrelationId();
  const spec = BOOKING_ACTIONS[input.action];
  if (!spec) throw new TransitionError('INVALID_TRANSITION', `Unknown action ${input.action}`);

  const digest = requestDigest(input);
  const idemKey = input.idempotencyKey?.trim() || null;
  const idemActor = input.actorUid ?? `role:${input.actorRole}`;

  // ── 1. Idempotency, before any work ────────────────────────────────────────
  if (idemKey) {
    const prior = await dbQuery.query(
      `SELECT request_digest, result FROM ${s}.booking_transition_idempotency
        WHERE actor_uid = $1 AND booking_id = $2 AND action = $3 AND idempotency_key = $4`,
      [idemActor, input.bookingId, input.action, idemKey],
    );
    if (prior.rows.length) {
      const row = prior.rows[0];
      if (row.request_digest !== digest) {
        throw new TransitionError(
          'IDEMPOTENCY_KEY_REUSED',
          'This idempotency key was already used for a different request.',
        );
      }
      // A retry of a request that already succeeded returns the ORIGINAL
      // outcome. Without this the second call reaches the machine, finds the
      // state already advanced, and answers INVALID_TRANSITION — telling the
      // client its own successful request failed.
      return { ...(row.result as TransitionResult), idempotentReplay: true };
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const loaded = await loadForUpdate(client, input.bookingId, input.actorUid ?? null);
    if (!loaded) throw new TransitionError('BOOKING_NOT_FOUND', 'No such booking.');

    const fromState = deriveCanonicalState({
      bookingStatus: loaded.status,
      workerStatus: loaded.assignmentStatus,
      workerUid: loaded.workerUid,
      hasEscalation: loaded.hasEscalation,
    });

    // What the locked rows said at the moment of the decision. Every refusal
    // below carries it, so a caller's own error vocabulary is derived from the
    // same read the refusal was — not from a second one taken after the
    // transaction ended, which can disagree.
    const snapshot: LockedSnapshot = {
      bookingStatus: loaded.status,
      bookingWorkerUid: loaded.workerUid,
      assignmentStatus: loaded.assignmentStatus,
      actorAssignmentStatus: loaded.actorAssignmentStatus,
      canonicalState: fromState,
    };

    // ── Optimistic concurrency, INSIDE the lock ──────────────────────────────
    if (input.expectedState && input.expectedState !== fromState) {
      throw new TransitionError(
        'BOOKING_STATE_CONFLICT',
        `Booking is ${fromState}, not ${input.expectedState}. Reload and try again.`,
        { currentState: fromState, expectedState: input.expectedState },
        snapshot,
      );
    }

    try {
      authorize(loaded, input);
    } catch (error) {
      throw error instanceof TransitionError
        ? new TransitionError(error.code, error.message, error.detail, snapshot)
        : error;
    }

    const toState = spec.to as BookingState;

    /**
     * The action's own source restriction, checked BEFORE the whitelist.
     *
     * Where two actions share a destination and an actor, this is the only
     * thing separating them. Refusing here rather than letting the whitelist
     * wave it through is what stops a decline being executed as a cancellation.
     */
    const allowedFrom = (spec as { from?: readonly BookingState[] }).from;
    if (allowedFrom && !allowedFrom.includes(fromState)) {
      throw new TransitionError(
        isTerminal(fromState) ? 'TERMINAL_STATE' : 'INVALID_TRANSITION',
        isTerminal(fromState)
          ? `Booking is already ${fromState}.`
          : `Cannot ${input.action} from ${fromState}.`,
        { currentState: fromState, attempted: toState, reason: 'ACTION_SOURCE_NOT_PERMITTED' },
        snapshot,
      );
    }

    const verdict = canTransition(fromState, toState, input.actorRole);
    if (!verdict.allowed) {
      // A refusal on a FINISHED booking is TERMINAL_STATE whatever the machine's
      // internal reason was. Re-completing a completed booking returns
      // ALREADY_IN_STATE from the machine, and reporting that as
      // INVALID_TRANSITION would suggest the caller might try something else —
      // when the honest answer is that this booking is over.
      const code: TransitionErrorCode =
        isTerminal(fromState)
          ? 'TERMINAL_STATE'
          : verdict.reason === 'ACTOR_NOT_PERMITTED'
          ? 'NOT_AUTHORIZED'
          : 'INVALID_TRANSITION';

      const message = isTerminal(fromState)
        ? `Booking is already ${fromState}.`
        : `Cannot ${input.action} from ${fromState}.`;

      throw new TransitionError(
        code,
        message,
        { currentState: fromState, attempted: toState, reason: verdict.reason },
        snapshot,
      );
    }

    /**
     * Policy, last and inside the lock.
     *
     * After the whitelist so a structurally impossible move is reported as
     * such rather than as a policy refusal, and before any write so a refused
     * action leaves nothing behind. The guard reads the LOCKED rows, so the
     * schedule it measures against cannot be edited between the check and the
     * transition.
     */
    /**
     * The credential must be PRESENT before anything is written.
     *
     * Its correctness is proven inside the write itself; this only refuses a
     * caller that supplied nothing, so an action declaring `requires` can
     * never reach its mutation without one. Structural, not conventional: an
     * internal caller that bypasses HTTP entirely is refused here too.
     */
    const credential = (spec as { requires?: BookingCredential }).requires;
    if (credential) {
      const { field, code, message } = CREDENTIAL_FIELD[credential];
      const supplied = input.metadata?.[field];
      if (typeof supplied !== 'string' || !supplied.trim()) {
        throw new TransitionError(code, message, { credential, missing: true }, snapshot);
      }
    }

    const guardName = (spec as { guard?: BookingGuardName }).guard;
    if (guardName) {
      const verdict = await BOOKING_GUARDS[guardName]({
        bookingId: loaded.id,
        bookingStatus: loaded.status,
        workerStatus: loaded.assignmentStatus,
        schedule: loaded.schedule,
        now: new Date(),
        metadata: { ...(input.metadata ?? {}), hasProvider: !!loaded.workerUid },
        // The LOCKED transaction: a guard reads the same snapshot the decision
        // is made in, so nothing can change between the check and the write.
        query: (sql, params) => client.query(sql, params as any[]),
      });
      if (!verdict.allowed) {
        throw new TransitionError(
          'POLICY_REFUSED',
          verdict.message ?? 'This action is not permitted by policy.',
          { guard: guardName, reasonCode: verdict.reasonCode, ...(verdict.detail ?? {}) },
          snapshot,
        );
      }
    }

    try {
      await applyState(client, loaded, toState, input);
      await writeLegacyTracking(client, loaded.id, input.action);
      await writeLegacyTimelineEvent(client, loaded, input);
    } catch (error) {
      throw error instanceof TransitionError
        ? new TransitionError(error.code, error.message, error.detail, snapshot)
        : error;
    }

    // ── Timeline, in the SAME transaction ────────────────────────────────────
    const timeline = await client.query(
      `INSERT INTO ${s}.booking_transitions
         (booking_id, action, from_state, to_state, actor_role, actor_uid,
          provider_uid, reason, metadata, correlation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
       RETURNING id`,
      [
        loaded.id,
        input.action,
        fromState,
        toState,
        input.actorRole,
        input.actorUid,
        loaded.workerUid,
        input.metadata?.reason ? String(input.metadata.reason) : null,
        // The worker code is a secret the customer reads out. It authorises the
        // transition; it is never evidence of it (§58).
        JSON.stringify(redactMetadata(input.metadata ?? {})),
        correlationId,
      ],
    );

    const result: TransitionResult = {
      bookingId: loaded.id,
      action: input.action,
      fromState,
      toState,
      idempotentReplay: false,
      correlationId,
      timelineEventId: Number(timeline.rows[0]?.id ?? 0) || null,
    };

    if (idemKey) {
      await client.query(
        `INSERT INTO ${s}.booking_transition_idempotency
           (actor_uid, booking_id, action, idempotency_key, request_digest, result)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)
         ON CONFLICT DO NOTHING`,
        [idemActor, loaded.id, input.action, idemKey, digest, JSON.stringify(result)],
      );
    }

    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Secrets never reach the timeline, which is read by support and by admins. */
export const redactMetadata = (metadata: Record<string, unknown>): Record<string, unknown> => {
  const REDACT = ['workerCode', 'worker_code', 'otp', 'otpCode', 'token', 'password'];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(metadata)) {
    out[k] = REDACT.includes(k) ? '[redacted]' : v;
  }
  return out;
};

// ─── Timeline read ────────────────────────────────────────────────────────────

export interface TimelineEvent {
  id: number;
  bookingId: number;
  action: string;
  fromState: BookingState;
  toState: BookingState;
  actorRole: Actor;
  providerUid: string | null;
  reason: string | null;
  correlationId: string | null;
  occurredAt: string;
}

/**
 * One booking's transition history, oldest first.
 *
 * Every surface reads THIS. A reassignment away from a provider who was
 * EN_ROUTE leaves the full progression behind — accepted, en route, reassigned,
 * assigned — because the current state resetting must not erase what happened.
 */
// ─── What may be done next ────────────────────────────────────────────────────

export interface AvailableAction {
  action: BookingAction;
  allowed: boolean;
  /** Why not. A specific rule, never a generic refusal. */
  reasonCode?: string;
  /** Safe context — deadlines and counts, never another party's identity. */
  detail?: Record<string, unknown>;
  /**
   * A secret the caller must supply when performing this action.
   *
   * `allowed: true` here means the STATE permits the action, never that the
   * credential has been proven — this endpoint does not have the code and must
   * not ask for one merely to render a button. A client uses it to know it
   * needs to prompt; the POST remains the only authority.
   */
  requiresCredential?: BookingCredential;
}

/**
 * The actions this actor may take on this booking, and why not for the rest.
 *
 * ## Why this exists rather than a client working it out
 *
 * A UI that decides button visibility from its own copy of the rules
 * eventually offers a button the executor refuses — the provider taps cancel,
 * gets a 409, and the app looks broken. The two must come from one
 * implementation, so this runs the SAME checks in the SAME order as
 * `transitionBooking`: the action's source restriction, the machine's
 * whitelist, then the named policy guard.
 *
 * Clients render `allowed` and `reasonCode`. They must never recompute a
 * policy — the 48-hour window in particular, which is why the guard returns
 * `allowedUntil` rather than expecting anyone to subtract it from a schedule.
 *
 * ## Why it does not take a lock
 *
 * This is advisory: it tells a client what to draw. Enforcement is the
 * executor's, under `FOR UPDATE`, and it re-runs every one of these checks. A
 * booking that moves between this read and the action is exactly the case
 * `expectedState` and the lock exist to handle.
 */
export async function getAvailableActions(
  bookingId: number,
  actorUid: string | null,
  actorRole: Actor,
): Promise<AvailableAction[]> {
  const res = await dbQuery.query(
    `SELECT b.id, b.status, b.user_id AS customer_uid, b.worker_uid, b.schedule,
            bw.status AS worker_status,
            EXISTS (
              SELECT 1 FROM ${s}.booking_transitions t
               WHERE t.booking_id = b.id AND t.to_state = 'DISPUTED'
            ) AS has_escalation
       FROM ${s}.bookings b
       LEFT JOIN LATERAL (
            SELECT status FROM ${s}.booking_workers
             WHERE booking_id = b.id AND worker_uid = b.worker_uid
             ORDER BY assigned_at DESC NULLS LAST, id DESC
             LIMIT 1
       ) bw ON TRUE
      WHERE b.id = $1`,
    [bookingId],
  );
  if (!res.rows.length) throw new TransitionError('BOOKING_NOT_FOUND', 'No such booking.');
  const row = res.rows[0];

  const fromState = deriveCanonicalState({
    bookingStatus: row.status,
    workerStatus: row.worker_status,
    workerUid: row.worker_uid,
    hasEscalation: row.has_escalation === true,
  });

  // Same authorization rule the executor applies, not a looser one.
  const isCurrentProvider = !!actorUid && row.worker_uid === actorUid;
  const isCustomer = !!actorUid && row.customer_uid === actorUid;

  const out: AvailableAction[] = [];
  for (const [name, raw] of Object.entries(BOOKING_ACTIONS)) {
    const action = name as BookingAction;
    const spec = raw as {
      to: BookingState;
      actor: Actor;
      from?: readonly BookingState[];
      guard?: BookingGuardName;
      requires?: BookingCredential;
    };
    if (spec.actor !== actorRole) continue;
    if (actorRole === 'assigned_provider' && !isCurrentProvider) continue;
    if (actorRole === 'customer' && !isCustomer) continue;

    if (spec.from && !spec.from.includes(fromState)) {
      out.push({ action, allowed: false, reasonCode: 'BOOKING_TRANSITION_INVALID' });
      continue;
    }
    const verdict = canTransition(fromState, spec.to, actorRole);
    if (!verdict.allowed) {
      out.push({
        action,
        allowed: false,
        reasonCode: isTerminal(fromState) ? 'BOOKING_TERMINAL' : 'BOOKING_TRANSITION_INVALID',
      });
      continue;
    }
    if (spec.guard) {
      const guarded = await BOOKING_GUARDS[spec.guard]({
        bookingId: Number(row.id),
        bookingStatus: row.status,
        workerStatus: row.worker_status,
        schedule: row.schedule,
        now: new Date(),
        metadata: { hasProvider: !!row.worker_uid },
        // No lock: this is advisory. Enforcement re-runs the same guard under
        // FOR UPDATE, which is where a race is actually resolved.
        query: (sql, params) => dbQuery.query(sql, params as any[]),
      });
      if (!guarded.allowed) {
        out.push({
          action,
          allowed: false,
          reasonCode: guarded.reasonCode,
          detail: guarded.detail,
        });
        continue;
      }
    }
    // Deliberately no credential check: this endpoint neither holds the OTP
    // nor the worker code, and validating one here would leak whether a code
    // is correct to anyone who can read a booking.
    out.push({
      action,
      allowed: true,
      ...(spec.requires ? { requiresCredential: spec.requires } : {}),
    });
  }
  return out;
}

export async function getBookingTimeline(bookingId: number): Promise<TimelineEvent[]> {
  await ensureTransitionSchema();
  const res = await dbQuery.query(
    `SELECT id, booking_id, action, from_state, to_state, actor_role,
            provider_uid, reason, correlation_id, occurred_at
       FROM ${s}.booking_transitions
      WHERE booking_id = $1
      ORDER BY occurred_at ASC, id ASC`,
    [bookingId],
  );
  return res.rows.map((r: any) => ({
    id: Number(r.id),
    bookingId: Number(r.booking_id),
    action: r.action,
    fromState: r.from_state,
    toState: r.to_state,
    actorRole: r.actor_role,
    providerUid: r.provider_uid ?? null,
    reason: r.reason ?? null,
    correlationId: r.correlation_id ?? null,
    occurredAt: new Date(r.occurred_at).toISOString(),
  }));
}

/**
 * The service outcome a dispute was raised ON TOP OF.
 *
 * `DISPUTED after COMPLETED` and `DISPUTED after CANCELLED` have different
 * financial consequences, so the dispute must not erase which one happened.
 * The executor never writes DISPUTED into `bookings.status` for exactly this
 * reason; the terminal outcome stays in the row and the dispute lives in the
 * timeline. This reads it back.
 */
export async function priorTerminalState(bookingId: number): Promise<BookingState | null> {
  const events = await getBookingTimeline(bookingId);
  for (let i = events.length - 1; i >= 0; i--) {
    const state = events[i].toState;
    if (state !== 'DISPUTED' && isTerminal(state)) return state;
  }
  return null;
}
