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

const s = db.schema;

// ─── Actions ──────────────────────────────────────────────────────────────────

/**
 * Every lifecycle action, and what it means to the machine.
 *
 * `to` is what the machine is asked to validate. It is derived from the action,
 * not supplied by the caller — that is the whole point of an action-based API.
 *
 * `resolveTo` exists for the two actions whose destination depends on the
 * booking: reassignment always lands on ASSIGNED, and a provider cancel lands
 * on AWAITING_ASSIGNMENT regardless of how far the old provider had got.
 */
export const BOOKING_ACTIONS = {
  CUSTOMER_CONFIRM_OTP: { to: 'AWAITING_ASSIGNMENT', actor: 'customer' },
  CUSTOMER_CANCEL: { to: 'CANCELLED', actor: 'customer' },
  PROVIDER_ACCEPT: { to: 'ACCEPTED', actor: 'assigned_provider' },
  PROVIDER_DECLINE: { to: 'AWAITING_ASSIGNMENT', actor: 'assigned_provider' },
  PROVIDER_EN_ROUTE: { to: 'EN_ROUTE', actor: 'assigned_provider' },
  PROVIDER_ARRIVED: { to: 'ARRIVED', actor: 'assigned_provider' },
  PROVIDER_START: { to: 'IN_PROGRESS', actor: 'assigned_provider' },
  PROVIDER_COMPLETE: { to: 'COMPLETED', actor: 'assigned_provider' },
  PROVIDER_CANCEL: { to: 'AWAITING_ASSIGNMENT', actor: 'assigned_provider' },
  ADMIN_ASSIGN: { to: 'ASSIGNED', actor: 'admin' },
  ADMIN_REASSIGN: { to: 'ASSIGNED', actor: 'admin' },
  ADMIN_CANCEL: { to: 'CANCELLED', actor: 'admin' },
  ADMIN_COMPLETE: { to: 'COMPLETED', actor: 'admin' },
  SYSTEM_EXPIRE: { to: 'EXPIRED', actor: 'system' },
} as const satisfies Record<string, { to: BookingState; actor: Actor }>;

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
  | 'WORKER_CODE_INVALID';

export class TransitionError extends Error {
  constructor(
    readonly code: TransitionErrorCode,
    message: string,
    readonly detail?: Record<string, unknown>,
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
async function loadForUpdate(client: PoolClient, bookingId: number): Promise<LoadedBooking | null> {
  const booking = await client.query(
    `SELECT id, status, user_id AS customer_uid, worker_uid
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

  return {
    id: Number(row.id),
    status: row.status ?? null,
    customerUid: row.customer_uid ?? null,
    workerUid: row.worker_uid ?? null,
    assignmentStatus: assignment.rows[0]?.status ?? null,
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
        await client.query(`UPDATE ${s}.bookings SET status = 'CONFIRMED' WHERE id = $1`, [loaded.id]);
      } else if (providerUid) {
        await client.query(
          `UPDATE ${s}.booking_workers SET status = $3
            WHERE booking_id = $1 AND worker_uid = $2`,
          [loaded.id, providerUid, input.action === 'PROVIDER_DECLINE' ? 'DECLINED' : 'CANCELLED'],
        );
        await client.query(`UPDATE ${s}.bookings SET worker_uid = NULL WHERE id = $1`, [loaded.id]);
      }
      return;
    }

    case 'ASSIGNED': {
      // Assign or reassign. The incoming provider comes from metadata because
      // it is not derivable from the booking — it is the operator's choice.
      const nextProvider = String(input.metadata?.providerUid ?? '');
      if (!nextProvider) {
        throw new TransitionError('GUARD_FAILED', 'providerUid is required to assign.', { guard: 'provider_eligible' });
      }
      if (providerUid && providerUid !== nextProvider) {
        // Close the outgoing assignment. Never overwrite it: TAB 05 depends on
        // an assignment row being terminal rather than mutated, and the old
        // provider's progression has to stay readable.
        await client.query(
          `UPDATE ${s}.booking_workers SET status = 'REASSIGNED'
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
      await client.query(
        `UPDATE ${s}.booking_workers SET status = $3
          WHERE booking_id = $1 AND worker_uid = $2`,
        [loaded.id, providerUid, to],
      );
      return;

    case 'EN_ROUTE':
    case 'ARRIVED': {
      // Canonical: the provider lifecycle lives on the assignment row.
      await client.query(
        `UPDATE ${s}.booking_workers SET status = $3
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

    case 'CANCELLED':
      // The canonical spelling, always. The deprecated one is read-only.
      await client.query(
        `UPDATE ${s}.bookings SET status = $2, cancelled_at = NOW() WHERE id = $1`,
        [loaded.id, CANONICAL_CANCELLED],
      );
      if (providerUid) {
        await client.query(
          `UPDATE ${s}.booking_workers SET status = $3 WHERE booking_id = $1 AND worker_uid = $2`,
          [loaded.id, providerUid, CANONICAL_CANCELLED],
        );
      }
      return;

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

    const loaded = await loadForUpdate(client, input.bookingId);
    if (!loaded) throw new TransitionError('BOOKING_NOT_FOUND', 'No such booking.');

    const fromState = deriveCanonicalState({
      bookingStatus: loaded.status,
      workerStatus: loaded.assignmentStatus,
      workerUid: loaded.workerUid,
      hasEscalation: loaded.hasEscalation,
    });

    // ── Optimistic concurrency, INSIDE the lock ──────────────────────────────
    if (input.expectedState && input.expectedState !== fromState) {
      throw new TransitionError(
        'BOOKING_STATE_CONFLICT',
        `Booking is ${fromState}, not ${input.expectedState}. Reload and try again.`,
        { currentState: fromState, expectedState: input.expectedState },
      );
    }

    authorize(loaded, input);

    const toState = spec.to as BookingState;
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

      throw new TransitionError(code, message, {
        currentState: fromState,
        attempted: toState,
        reason: verdict.reason,
      });
    }

    await applyState(client, loaded, toState, input);

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
