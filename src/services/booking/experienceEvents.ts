/**
 * The one emitter for every booking-experience domain event (§67).
 *
 * ## Why a closed catalog and a single function
 *
 * Before this, each capability wrote its own timeline row with its own event
 * type spelled at the call site. Two of them — `booking_rescheduled` and
 * `dispute_opened` — are values the admin portal renders, so a typo in a new
 * caller produces an event the timeline silently cannot draw. And a capability
 * that simply forgot to write one produced a state change with no history,
 * which is the failure the executor's in-transaction timeline exists to stop.
 *
 * `emitExperienceEvent` takes a NAME from `BOOKING_EXPERIENCE_EVENTS` — the type
 * is the union of declared names, so an undeclared event does not compile.
 *
 * ## Emission never fails the operation
 *
 * §45, applied consistently: a booking that has already moved must not be rolled
 * back because a timeline insert failed. The executor achieves that by writing
 * its transitions INSIDE the transaction; these are downstream records of
 * something already committed, so they are best-effort and logged.
 *
 * The exception is `runner`. When a caller passes its own transaction, the write
 * joins that transaction and its failure IS the caller's failure — that is the
 * point of passing it, and the reschedule proposal relies on it.
 */

import dbQuery from '../../db/dbQuery';
import { db } from '../../config';
import {
  BOOKING_EXPERIENCE_EVENTS,
  UNEMITTED_EVENTS,
  eventSpec,
  type BookingExperienceEventName,
  type ExperienceActor,
} from './experiencePolicy';
import type { Runner } from './experienceStore';

const s = db.schema;

/** Values already used by `booking_timeline_events.actor_type`. */
const ACTOR_TYPE: Record<ExperienceActor, string> = {
  customer: 'customer',
  assigned_provider: 'provider',
  admin: 'admin',
};

/**
 * Anything that must never reach a timeline row.
 *
 * The same list the executor redacts, for the same reason: `detail` is written
 * by whichever service raised the event, and one careless spread of a request
 * body would put a live credential into a table support staff can read.
 */
const REDACTED_KEYS = ['otp', 'otpCode', 'code', 'workerCode', 'worker_code', 'token', 'password'];

export const redactEventDetail = (
  detail: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null => {
  if (!detail) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    out[key] = REDACTED_KEYS.includes(key) ? '[redacted]' : value;
  }
  return out;
};

export interface EmitParams {
  bookingId: number;
  event: BookingExperienceEventName;
  actor: ExperienceActor;
  actorUid: string | null;
  /** One line, human-readable, safe for a customer to see. */
  title: string;
  description?: string | null;
  detail?: Record<string, unknown> | null;
  /**
   * A transaction to join. When supplied, a failure propagates: the caller
   * asked for the event and the operation to be one atomic thing.
   */
  runner?: Runner;
}

export async function emitExperienceEvent(params: EmitParams): Promise<void> {
  const spec = eventSpec(params.event);

  // A catalogued-but-never-emitted event reaching this function means somebody
  // wired up the thing the catalog says was deliberately not wired up.
  if (UNEMITTED_EVENTS.includes(params.event)) {
    throw new Error(
      `experienceEvents: "${params.event}" is declared as deliberately not emitted — ` +
        'see BOOKING_EXPERIENCE_EVENTS. Remove it from UNEMITTED_EVENTS in a reviewed diff first.',
    );
  }

  const write = async (runner: Runner) => {
    await runner.query(
      `INSERT INTO ${s}.booking_timeline_events
         (booking_id, event_type, title, description, actor_type, actor_uid, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        params.bookingId,
        spec.timelineType,
        params.title,
        params.description ?? null,
        ACTOR_TYPE[params.actor],
        params.actorUid,
        JSON.stringify({
          event: spec.name,
          capability: spec.capability,
          ...(redactEventDetail(params.detail) ?? {}),
        }),
      ],
    );
  };

  if (params.runner) {
    await write(params.runner);
    return;
  }

  try {
    await write(dbQuery);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(
      `[experience-event] ${spec.name} not recorded for booking ${params.bookingId}:`,
      (error as Error)?.message ?? error,
    );
  }
}

/** Every event the catalog says is real. Used by the docs and the tests. */
export const EMITTABLE_EVENTS = BOOKING_EXPERIENCE_EVENTS.filter(
  (e) => !UNEMITTED_EVENTS.includes(e.name),
);
