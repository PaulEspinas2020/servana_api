/**
 * Booking-scoped tracking: what happened, where the provider is, and whether the
 * caller may be told.
 *
 * ## The three things that used to be three endpoints
 *
 *   GET /api/:id/tracking                      the `booking_tracking` rows
 *   GET /api/booking/:id/provider-location     the provider's position
 *   GET /api/workers/location/:uid             the same position, UNAUTHENTICATED
 *
 * The third is the reason this exists. It takes the SUBJECT from the URL, so
 * anyone could follow any provider's live position without a token; the second
 * was written as its authenticated successor and re-framed the question around a
 * booking the caller already owns. But the successor still answered in every
 * state — a customer could watch their provider's position for a booking that
 * was cancelled last week, or one that had not started.
 *
 * §64 closes that: tracking is booking-scoped provider location sharing "with
 * strict state/authorization/time-window rules". All three rules are in
 * `experiencePolicy.evaluateTrackingVisibility`, which holds no database handle,
 * so the documentation, the tests and this service evaluate one implementation.
 *
 * ## Authorization and visibility are different questions
 *
 * `assertBookingAccess` decides whether the caller may see the BOOKING. The
 * visibility rule decides whether anyone may see the PROVIDER'S POSITION on it.
 * A caller who passes the first and fails the second gets the booking's tracking
 * history and a null position with a named reason — never a 403, because being
 * told "not yet" is not the same as being told "not yours".
 */

import dbQuery from '../../db/dbQuery';
import { db } from '../../config';
import * as technician from '../technicianService';
import { deriveCanonicalState, type BookingState } from './canonicalState';
import {
  evaluateTrackingVisibility,
  TRACKING_LOCATION_STATES,
  TRACKING_MAX_HOURS_SINCE_MOVEMENT,
  type TrackingVerdict,
} from './experiencePolicy';

const s = db.schema;

export interface TrackingStep {
  status: string | null;
  note: string | null;
  at: string | null;
}

export interface BookingTrackingView {
  bookingId: number;
  state: BookingState;
  /** The operational breadcrumb rows, oldest first. */
  steps: TrackingStep[];
  assignedProvider: {
    assigned: boolean;
    /** The provider's position, or null with a reason on the verdict. */
    location: unknown | null;
  };
  visibility: TrackingVerdict;
  policy: {
    trackableStates: readonly BookingState[];
    maxHoursSinceMovement: number;
  };
}

const iso = (v: unknown): string | null => {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/**
 * When the provider last MOVED, from the canonical transition log.
 *
 * The window is measured from this rather than from the schedule, because a job
 * that started three hours late is still live and a job that was never completed
 * must eventually go dark. `booking_transitions` is the executor's own
 * append-only record, so this cannot disagree with the state it is bounding.
 *
 * A booking whose provider moved before the executor existed has no row, and the
 * policy fails closed on that — which is the safe direction: the position is
 * withheld rather than shared on an unprovable timestamp.
 */
const lastMovementAt = async (bookingId: number): Promise<Date | null> => {
  // The executor owns this table's DDL and creates it lazily, so a read that
  // arrives before any transition has ever been written must not fail on a
  // missing relation.
  const { rows } = await dbQuery.query(
    `SELECT occurred_at
       FROM ${s}.booking_transitions
      WHERE booking_id = $1
        AND to_state = ANY($2::text[])
      ORDER BY occurred_at DESC, id DESC
      LIMIT 1`,
    [bookingId, [...TRACKING_LOCATION_STATES]],
  );
  const at = rows[0]?.occurred_at;
  if (at == null) return null;
  const d = at instanceof Date ? at : new Date(String(at));
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * The whole tracking answer for one booking.
 *
 * Authorization is the CALLER's job — this is a domain service and takes an
 * already-entitled caller, exactly as `bookingService.getTracking` did. The v1
 * handler runs `assertBookingAccess` first, and the legacy controller already
 * does.
 */
export async function getBookingTracking(bookingId: number, now: Date = new Date()): Promise<BookingTrackingView> {
  const bookingRes = await dbQuery.query(
    `SELECT b.id, b.status, b.worker_uid,
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
  if (!booking) {
    throw Object.assign(new Error('Booking not found'), { statusCode: 404, code: 'BOOKING_NOT_FOUND' });
  }

  const state = deriveCanonicalState({
    bookingStatus: booking.status,
    workerStatus: booking.worker_status,
    workerUid: booking.worker_uid ?? null,
    hasEscalation: !!booking.has_escalation,
  });

  const stepsRes = await dbQuery.query(
    `SELECT status, note, created_at
       FROM ${s}.booking_tracking
      WHERE booking_id = $1
      ORDER BY created_at ASC`,
    [bookingId],
  );
  const steps: TrackingStep[] = stepsRes.rows.map((r: any) => ({
    status: r.status ?? null,
    note: r.note ?? null,
    at: iso(r.created_at),
  }));

  const workerUid: string | null = booking.worker_uid ?? null;
  const hasAssignment = !!workerUid;

  /**
   * The position is fetched ONLY when the state rule already permits it.
   *
   * Evaluating visibility first and reading second means a withheld position is
   * never loaded into memory at all — there is no branch in which the value
   * exists and is discarded on the way out, which is the shape that eventually
   * leaks through a debug log or an added field.
   */
  const movement = hasAssignment ? await lastMovementAt(bookingId) : null;

  const provisional = evaluateTrackingVisibility({
    state,
    hasAssignment,
    lastMovementAt: movement,
    // Assume a position exists for this first pass; NO_POSITION_REPORTED is
    // decided below, once the cheaper rules have already permitted a read.
    hasPosition: true,
    now,
  });

  let location: unknown | null = null;
  let visibility = provisional;

  if (provisional.visibility === 'VISIBLE') {
    location = (await technician.getWorkerLocation(workerUid!)) ?? null;
    visibility = evaluateTrackingVisibility({
      state,
      hasAssignment,
      lastMovementAt: movement,
      hasPosition: !!location,
      now,
    });
    if (visibility.visibility !== 'VISIBLE') location = null;
  }

  return {
    bookingId,
    state,
    steps,
    assignedProvider: { assigned: hasAssignment, location },
    visibility,
    policy: {
      trackableStates: TRACKING_LOCATION_STATES,
      maxHoursSinceMovement: TRACKING_MAX_HOURS_SINCE_MOVEMENT,
    },
  };
}
