/**
 * Rescheduling, as a proposal that is decided rather than an UPDATE that lands.
 *
 * ## What it replaces
 *
 * One admin-only function whose entire mechanism was:
 *
 *     UPDATE bookings SET schedule = $1 WHERE id = $2
 *
 * No optimistic concurrency, so two admins moving the same booking produced one
 * silent winner. No provider-calendar check, so a booking could be moved onto a
 * time its assigned provider was already working. No customer path at all — a
 * customer who needed a different day had to cancel and rebook, which loses the
 * provider, the price and the history.
 *
 * ## Who may move a booking, and why the provider is not asked
 *
 * §62 asks for "explicit proposal/acceptance **if both parties must agree**".
 * They do not: the operator's recorded policy (C18 §14/§24, stated verbatim in
 * `adminBookingService.adminRescheduleBooking`) is that "the provider is NOT a
 * party to rescheduling — only the customer and admin may move a booking, and
 * the provider only responds to the outcome".
 *
 * That policy is preserved, and
 * `experiencePolicy.RESCHEDULE_REQUIRES_PROVIDER_ACCEPTANCE` is the one line
 * that states it. What is NOT preserved is the silent overwrite: every attempt
 * writes a `booking_reschedule_requests` row — accepted or refused — so a
 * schedule change always has a proposer, a before, an after and a reason, and
 * flipping that flag turns the same record into an acceptance workflow.
 *
 * ## The conflict rule is REFUSAL, not release
 *
 * A move that would collide with the assigned provider's calendar is refused
 * with `PROVIDER_CONFLICT`. The tempting alternative — release the assignment
 * and re-match — is a lifecycle transition, and inventing one here would put a
 * second writer next to the executor for the exact operation TAB 04 centralised.
 * Refusing is honest, additive and leaves the operator holding a real choice:
 * reassign first, then move.
 */

import dbQuery from '../../db/dbQuery';
import { publishEventSafely } from '../events/eventOutbox';
import { dispatchSoon } from '../events/notificationProjector';
import { db } from '../../config';
import { deriveCanonicalState, type BookingState } from './canonicalState';
import {
  evaluateReschedule,
  RESCHEDULE_REQUIRES_PROVIDER_ACCEPTANCE,
  RESCHEDULABLE_STATES,
  RESCHEDULE_REASONS,
  type ExperienceActor,
  type RescheduleRefusal,
  type RescheduleVerdict,
} from './experiencePolicy';
import { ensureExperienceSchema } from './experienceStore';
import { emitExperienceEvent } from './experienceEvents';
import {
  OVERLAPS_SPAN_SQL,
  OCCUPANCY_EXCLUSION_SQL,
  serviceDurationMinsSql,
} from './eligibilityPipeline';

const s = db.schema;

export class RescheduleError extends Error {
  constructor(
    readonly code: RescheduleRefusal | 'BOOKING_NOT_FOUND',
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'RescheduleError';
  }
}

export type RescheduleStatus = 'ACCEPTED' | 'REFUSED' | 'PENDING_PROVIDER';

export interface RescheduleResult {
  bookingId: number;
  requestId: number | null;
  status: RescheduleStatus;
  previousSchedule: string | null;
  scheduledAt: string;
  reasonCode: string | null;
  /** True while the flag above is false. Stated so a client need not infer it. */
  appliedImmediately: boolean;
  verdict: RescheduleVerdict;
}

/**
 * Records the attempt, whatever its outcome.
 *
 * Runs on its own connection and never inside the caller's transaction: a
 * refusal has no transaction, and an accepted move must not be rolled back
 * because its proposal row failed to insert — the schedule change is the thing
 * the customer was promised.
 */
const recordProposal = async (params: {
  bookingId: number;
  previousSchedule: unknown;
  proposedSchedule: string;
  reasonCode: string | null;
  reason: string | null;
  status: RescheduleStatus;
  refusalCode: RescheduleRefusal | null;
  actor: ExperienceActor;
  actorUid: string | null;
  runner?: { query: (sql: string, params?: any[]) => Promise<any> };
}): Promise<number | null> => {
  const runner = params.runner ?? dbQuery;
  try {
    const { rows } = await runner.query(
      `INSERT INTO ${s}.booking_reschedule_requests
         (booking_id, previous_schedule, proposed_schedule, reason_code, reason,
          status, refusal_code, requested_by, requested_role, decided_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $6 = 'PENDING_PROVIDER' THEN NULL ELSE NOW() END)
       RETURNING id`,
      [
        params.bookingId,
        params.previousSchedule ?? null,
        params.proposedSchedule,
        params.reasonCode,
        params.reason,
        params.status,
        params.refusalCode,
        params.actorUid,
        params.actor,
      ],
    );
    return rows[0]?.id ?? null;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(
      `[reschedule] proposal row not written for booking ${params.bookingId}:`,
      (error as Error)?.message ?? error,
    );
    return null;
  }
};

/**
 * Does the assigned provider already have work across the PROPOSED span?
 *
 * Built from the same three primitives the matching engine and the executor use
 * — `OVERLAPS_SPAN_SQL`, `OCCUPANCY_EXCLUSION_SQL`, `serviceDurationMinsSql` —
 * rather than from a fresh idea of what a collision is. A reschedule with its
 * own overlap rule could move a booking onto a slot the assignment path would
 * have refused, which is the two-writers problem in a different costume.
 *
 * `CONFLICTING_BOOKING_SQL` itself does not fit: it reads the target's span from
 * the booking row, and the whole question here is about a span the booking does
 * not have yet. So the target CTE is rebuilt around the proposed start while the
 * duration still comes from the booking's own service option — the caller never
 * supplies a length.
 */
const providerHasConflict = async (params: {
  bookingId: number;
  providerUid: string;
  proposedSchedule: string;
}): Promise<boolean> => {
  const { rows } = await dbQuery.query(
    `WITH target AS (
       SELECT $2::timestamptz AS start_at,
              ($2::timestamptz + (${serviceDurationMinsSql('tso')} || ' minutes')::interval) AS end_at
         FROM ${s}.bookings tb
         LEFT JOIN ${s}.service_options tso ON tso.id = tb.service_option_id
        WHERE tb.id = $3
     )
     SELECT EXISTS (
       SELECT 1
         FROM ${s}.bookings b
         LEFT JOIN ${s}.service_options so ON so.id = b.service_option_id
         CROSS JOIN target t
        WHERE b.worker_uid = $1
          AND b.id <> $3
          AND b.status NOT IN (${OCCUPANCY_EXCLUSION_SQL})
          AND ${OVERLAPS_SPAN_SQL('t.start_at', 't.end_at')}
     ) AS conflict`,
    [params.providerUid, params.proposedSchedule, params.bookingId],
  );
  return rows[0]?.conflict === true;
};

export async function rescheduleBooking(params: {
  bookingId: number;
  scheduledAt: string;
  actor: ExperienceActor;
  actorUid: string | null;
  reasonCode?: string | null;
  reason?: string | null;
  /** Optimistic concurrency: the schedule the caller last read. */
  expectedSchedule?: string | null;
  now?: Date;
}): Promise<RescheduleResult> {
  const { bookingId, scheduledAt, actor, actorUid } = params;
  const now = params.now ?? new Date();
  const reasonCode = params.reasonCode ?? null;
  const reason = params.reason ?? null;

  await ensureExperienceSchema();

  const bookingRes = await dbQuery.query(
    `SELECT b.id, b.status, b.schedule, b.worker_uid,
            (SELECT bw.status FROM ${s}.booking_workers bw
              WHERE bw.booking_id = b.id AND bw.worker_uid = b.worker_uid
              ORDER BY bw.id DESC LIMIT 1) AS worker_status,
            EXISTS (SELECT 1 FROM ${s}.booking_escalations esc
                     WHERE esc.booking_id = b.id AND esc.resolved_at IS NULL) AS has_escalation
       FROM ${s}.bookings b
      WHERE b.id = $1`,
    [bookingId],
  );
  const booking = bookingRes.rows[0];
  if (!booking) throw new RescheduleError('BOOKING_NOT_FOUND', 'No booking with that id.');

  const state: BookingState = deriveCanonicalState({
    bookingStatus: booking.status,
    workerStatus: booking.worker_status,
    workerUid: booking.worker_uid ?? null,
    hasEscalation: !!booking.has_escalation,
  });

  const previousSchedule = booking.schedule ?? null;

  const refuse = async (
    refusal: RescheduleRefusal,
    message: string,
    verdict: RescheduleVerdict,
    detail?: Record<string, unknown>,
  ): Promise<never> => {
    await recordProposal({
      bookingId,
      previousSchedule,
      proposedSchedule: scheduledAt,
      reasonCode,
      reason,
      status: 'REFUSED',
      refusalCode: refusal,
      actor,
      actorUid,
    });
    await emitExperienceEvent({
      bookingId,
      event: 'reschedule.refused',
      actor,
      actorUid,
      title: 'Reschedule refused',
      description: message,
      detail: { refusal, proposedSchedule: scheduledAt },
    });
    throw new RescheduleError(refusal, message, { ...detail, verdict });
  };

  const verdict = evaluateReschedule({
    state,
    actor,
    currentSchedule: previousSchedule,
    proposedSchedule: scheduledAt,
    reasonCode,
    now,
  });

  if (!verdict.allowed) {
    const MESSAGES: Record<RescheduleRefusal, string> = {
      STATE_NOT_RESCHEDULABLE: 'This booking can no longer be moved.',
      SCHEDULE_INVALID: 'That date and time cannot be used.',
      INSIDE_NOTICE_WINDOW: `A booking must be moved at least ${verdict.noticeHours} hours before it starts.`,
      REASON_INVALID: 'That reason code is not one of the standardized reasons.',
      PROVIDER_CONFLICT: 'The assigned provider is not free then.',
      SCHEDULE_CHANGED: 'This booking has already been moved. Reload and try again.',
    };
    await refuse(verdict.refusal!, MESSAGES[verdict.refusal!], verdict, {
      state,
      reschedulableStates: RESCHEDULABLE_STATES,
      reasons: RESCHEDULE_REASONS,
    });
  }

  /**
   * The provider-calendar check, only when there IS a provider.
   *
   * An unassigned booking cannot collide with anything, and running the query
   * anyway would refuse a move for a booking whose provider does not exist yet.
   */
  if (booking.worker_uid) {
    const conflict = await providerHasConflict({
      bookingId,
      providerUid: String(booking.worker_uid),
      proposedSchedule: scheduledAt,
    });
    if (conflict) {
      await refuse(
        'PROVIDER_CONFLICT',
        'The assigned provider already has work across that time. Reassign the booking first, then move it.',
        verdict,
        { providerAssigned: true },
      );
    }
  }

  if (RESCHEDULE_REQUIRES_PROVIDER_ACCEPTANCE && booking.worker_uid) {
    /* istanbul ignore next — unreachable while the flag is false. Kept so the
       acceptance path is a flag flip and a test, not a schema change. */
    const requestId = await recordProposal({
      bookingId,
      previousSchedule,
      proposedSchedule: scheduledAt,
      reasonCode,
      reason,
      status: 'PENDING_PROVIDER',
      refusalCode: null,
      actor,
      actorUid,
    });
    await emitExperienceEvent({
      bookingId,
      event: 'reschedule.proposed',
      actor,
      actorUid,
      title: 'Reschedule proposed',
      detail: { proposedSchedule: scheduledAt, reasonCode },
    });
    return {
      bookingId,
      requestId,
      status: 'PENDING_PROVIDER',
      previousSchedule: previousSchedule ? new Date(previousSchedule).toISOString() : null,
      scheduledAt,
      reasonCode,
      appliedImmediately: false,
      verdict,
    };
  }

  /**
   * Apply, under an optimistic-concurrency predicate.
   *
   * `schedule IS NOT DISTINCT FROM $3` rather than `=`, because a booking with a
   * NULL schedule is a real case and `NULL = NULL` is NULL — which would make
   * every such move fail as a conflict. The predicate is what turns two
   * simultaneous reschedules into one winner and one `SCHEDULE_CHANGED`
   * instead of a silent last-write-wins.
   *
   * The expected value is the schedule this call READ, not one the client sent,
   * unless the client sent one. A caller that supplies `expectedSchedule` gets
   * the stronger guarantee; one that does not is still protected against a
   * change that landed between this function's read and its write.
   */
  const expected =
    params.expectedSchedule !== undefined && params.expectedSchedule !== null
      ? params.expectedSchedule
      : previousSchedule;

  const applied = await dbQuery.query(
    `UPDATE ${s}.bookings
        SET schedule = $1
      WHERE id = $2
        AND schedule IS NOT DISTINCT FROM $3::timestamptz
      RETURNING schedule`,
    [scheduledAt, bookingId, expected],
  );

  if (!applied.rowCount) {
    await refuse(
      'SCHEDULE_CHANGED',
      'This booking has already been moved. Reload and try again.',
      verdict,
      { expectedSchedule: expected ? new Date(expected).toISOString() : null },
    );
  }

  const requestId = await recordProposal({
    bookingId,
    previousSchedule,
    proposedSchedule: scheduledAt,
    reasonCode,
    reason,
    status: 'ACCEPTED',
    refusalCode: null,
    actor,
    actorUid,
  });

  await emitExperienceEvent({
    bookingId,
    event: 'reschedule.applied',
    actor,
    actorUid,
    title: 'Booking rescheduled',
    description: reason,
    detail: {
      from: previousSchedule ? new Date(previousSchedule).toISOString() : null,
      to: scheduledAt,
      reasonCode,
    },
  });

  /**
   * The canonical fact (TAB 09).
   *
   * Published only on the APPLIED path. A reschedule that was merely PROPOSED
   * has not moved anything, and telling a provider their job moved when it has
   * not is worse than telling them nothing — they would rearrange a day around
   * a change that never happened.
   *
   * No legacy producer exists for this, so the projection is purely additive:
   * until now a customer moved their booking and the assigned provider was
   * never notified at all.
   */
  void publishEventSafely({
    name: 'BookingRescheduled',
    refs: { bookingId },
    display: { bookingCode: `SVN-${String(bookingId).padStart(6, '0')}` },
    metadata: { actorUid, reasonCode },
    dedupeKey: `BookingRescheduled:${bookingId}:${requestId}`,
  }).then(() => dispatchSoon());

  return {
    bookingId,
    requestId,
    status: 'ACCEPTED',
    previousSchedule: previousSchedule ? new Date(previousSchedule).toISOString() : null,
    scheduledAt: new Date(applied.rows[0].schedule).toISOString(),
    reasonCode,
    appliedImmediately: true,
    verdict,
  };
}

/** One recorded attempt to move a booking, as a caller sees it. */
export interface RescheduleRequestRecord {
  id: number;
  previousSchedule: string | null;
  proposedSchedule: string;
  reasonCode: string | null;
  status: RescheduleStatus;
  refusalCode: string | null;
  /** The SEAT that proposed it. The uid is deliberately not projected. */
  requestedRole: string;
  decidedAt: string | null;
  createdAt: string;
}

/** The proposal history for one booking, newest first. */
export async function listRescheduleRequests(
  bookingId: number,
): Promise<RescheduleRequestRecord[]> {
  await ensureExperienceSchema();
  const { rows } = await dbQuery.query(
    `SELECT id, previous_schedule, proposed_schedule, reason_code, status,
            refusal_code, requested_role, decided_at, created_at
       FROM ${s}.booking_reschedule_requests
      WHERE booking_id = $1
      ORDER BY created_at DESC, id DESC`,
    [bookingId],
  );
  return rows.map((r: any) => ({
    id: r.id,
    previousSchedule: r.previous_schedule ? new Date(r.previous_schedule).toISOString() : null,
    proposedSchedule: new Date(r.proposed_schedule).toISOString(),
    reasonCode: r.reason_code ?? null,
    status: r.status as RescheduleStatus,
    refusalCode: r.refusal_code ?? null,
    // The uid of the proposer is NOT projected. Who moved a booking is an
    // operational fact for the timeline and the audit log, not a field a
    // customer needs about an admin or a provider needs about a customer.
    requestedRole: r.requested_role,
    decidedAt: r.decided_at ? new Date(r.decided_at).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}
