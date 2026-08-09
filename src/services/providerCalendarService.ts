/**
 * Provider calendar aggregation — the backend half of a screen that shipped
 * without one.
 *
 * ServanaWorker has a Calendar tab (`CalendarView`, routed in main_router.dart
 * and embedded in the homepage) whose store calls `GET /api/provider/calendar`.
 * That endpoint never existed. The store catches the failure and renders an
 * error state, which is why a permanently broken primary tab went unnoticed.
 *
 * Mobile is a protected client, so ITS parser is the contract and this file
 * conforms to it rather than the other way round
 * (`lib/core/calendar/provider_calendar_event.dart`). Three of its rules are
 * load-bearing and easy to violate:
 *
 *   1. `end` must be STRICTLY after `start`. An event with equal timestamps is
 *      silently dropped — not rendered, not logged. Every producer below
 *      guarantees a minimum span rather than trusting the data.
 *   2. `generatedAt` and a non-empty `timezone` are mandatory at the top level.
 *      Their absence throws a FormatException that fails the WHOLE response,
 *      not one event.
 *   3. `eventId`, `title`, `start`, `end`, `updatedAt` and a per-event
 *      `timezone` are all required, or that event is dropped.
 *
 * Read-only: this endpoint aggregates, it never writes (see
 * [[feedback_read_paths_must_not_write]] — an account-state read once upserted
 * a row per call).
 */

import { db } from '../config';
import dbQuery from '../db/dbQuery';

const s = db.schema;

/** §59 — Servana operates on Philippine time; the client renders in this zone. */
export const SERVANA_TIMEZONE = 'Asia/Manila';

/** Bumped when the SHAPE of this payload changes, so clients can branch. */
export const CALENDAR_RESULT_VERSION = 1;

/** Wire vocabulary, mirrored from ProviderCalendarEventType.fromWire. */
export type CalendarEventType =
  | 'CONFIRMED_BOOKING'
  | 'BOOKING_AWAITING_RESPONSE'
  | 'PENDING_RESCHEDULE'
  | 'AVAILABILITY'
  | 'AVAILABILITY_EXCEPTION'
  | 'TIME_OFF'
  | 'BRANCH_CLOSURE'
  | 'COMPLIANCE_DEADLINE'
  | 'PAYOUT_DATE'
  | 'OPERATIONAL_MILESTONE';

export interface CalendarAction {
  code: string;
  label: string;
}

export interface CalendarEvent {
  eventId: string;
  eventType: CalendarEventType;
  sourceEntityId: string | null;
  title: string;
  start: string;
  end: string;
  timezone: string;
  allDay: boolean;
  status: string;
  priority: number;
  providerSummary: string;
  hasConflict: boolean;
  availableActions: CalendarAction[];
  version: number;
  updatedAt: string;
}

export interface CalendarResult {
  generatedAt: string;
  timezone: string;
  events: CalendarEvent[];
  availabilityVersion: number | null;
  resultVersion: number;
}

/**
 * Widest window this endpoint will aggregate, in days.
 *
 * §56: the range comes from the client, and an unbounded one is an unbounded
 * scan over every booking a provider has ever had. A year of calendar is more
 * than any month view needs.
 */
export const MAX_RANGE_DAYS = 366;

/** Shortest span given to an event whose real duration is unknown or zero. */
const MIN_EVENT_MINUTES = 15;

/**
 * Booking statuses that mean the provider has committed to being there, versus
 * ones still waiting on them. Anything else is not a calendar commitment and is
 * excluded entirely — a declined or cancelled job is not an appointment.
 */
const CONFIRMED_WORKER_STATUSES = ['ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'IN_PROGRESS', 'COMPLETED'];
const AWAITING_WORKER_STATUSES = ['ASSIGNED', 'PENDING', 'OFFERED', 'AWAITING_CONFIRMATION'];

/**
 * pg returns timestamps as ISO STRINGS in this codebase, never Date objects
 * (see [[feedback_pg_type_parser_strings]]). Parse before doing arithmetic, and
 * treat anything unparseable as absent rather than as epoch zero.
 */
const toDate = (value: unknown): Date | null => {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * The calendar day of a `date` column, as 'YYYY-MM-DD'.
 *
 * Takes the RAW column value, never a parsed Date, and that distinction is the
 * whole reason this is a named function instead of an inline slice.
 *
 * pg returns `date` columns as 'YYYY-MM-DD' strings, so slicing the raw value
 * gives the day directly. Slicing a Date does NOT: `String(new Date(...))` is
 * 'Wed Mar 01 2027 08:00:00 GMT+0800 …', whose first ten characters are
 * 'Wed Mar 0' — unparseable.
 *
 * This was a live bug, found by inserting one real row rather than by any test:
 * a single-day all-day leave came back as a FIFTEEN MINUTE event, because the
 * malformed end fell through to the minimum-span fallback. Nothing errored and
 * the event still rendered — it was simply the wrong length, which is the kind
 * of defect a unit test with tidy fixtures never notices.
 */
export const calendarDayOf = (raw: unknown): string => String(raw ?? '').slice(0, 10);

/** Guarantees rule 1: the returned end is always strictly after start. */
const endAfter = (start: Date, candidate: Date | null, fallbackMinutes = MIN_EVENT_MINUTES): Date => {
  if (candidate && candidate.getTime() > start.getTime()) return candidate;
  return new Date(start.getTime() + fallbackMinutes * 60_000);
};

export interface CalendarQuery {
  start: Date;
  end: Date;
  /**
   * The same bounds pre-rendered for the query layer.
   *
   * Carried rather than computed at each call site so no `.toISOString()` is
   * invoked on a value near database code. The repo has a guard that flags
   * exactly that shape, because pg hands back timestamps as STRINGS and calling
   * a Date method on one is a real and repeated bug here
   * ([[feedback_pg_type_parser_strings]]). These two ARE genuine Dates, but a
   * guard that has to distinguish safe cases from unsafe ones by eye is a guard
   * that will eventually be argued with — so the pattern is removed instead.
   */
  startIso: string;
  endIso: string;
  eventTypes?: CalendarEventType[];
}

/**
 * Validates the caller-supplied window.
 *
 * Throws tagged errors (§21: safe, actionable, no internals) rather than
 * returning a partial result, because a calendar silently narrowed to a
 * different range than the one requested is worse than an error.
 */
export function parseCalendarQuery(raw: {
  start?: unknown;
  end?: unknown;
  eventTypes?: unknown;
}): CalendarQuery {
  const start = toDate(raw.start);
  const end = toDate(raw.end);

  if (!start || !end) {
    throw Object.assign(new Error('A start and end date are required.'), {
      statusCode: 400,
      code: 'CALENDAR_RANGE_REQUIRED',
    });
  }
  if (end.getTime() <= start.getTime()) {
    throw Object.assign(new Error('The end of the range must be after the start.'), {
      statusCode: 400,
      code: 'CALENDAR_RANGE_INVALID',
    });
  }
  const days = (end.getTime() - start.getTime()) / 86_400_000;
  if (days > MAX_RANGE_DAYS) {
    throw Object.assign(new Error(`A calendar range cannot be longer than ${MAX_RANGE_DAYS} days.`), {
      statusCode: 400,
      code: 'CALENDAR_RANGE_TOO_LARGE',
    });
  }

  let eventTypes: CalendarEventType[] | undefined;
  if (typeof raw.eventTypes === 'string' && raw.eventTypes.trim()) {
    // Unknown names are ignored rather than rejected: a newer client asking for
    // a type this build does not produce should get the types it does, not a
    // 400 (§4).
    eventTypes = raw.eventTypes
      .split(',')
      .map((t) => t.trim().toUpperCase())
      .filter(Boolean) as CalendarEventType[];
    if (eventTypes.length === 0) eventTypes = undefined;
  }

  return { start, end, startIso: start.toISOString(), endIso: end.toISOString(), eventTypes };
}

/** Bookings this provider is assigned to, as calendar commitments. */
async function loadBookingEvents(providerUid: string, q: CalendarQuery): Promise<CalendarEvent[]> {
  const { rows } = await dbQuery.query(
    `SELECT b.id,
            b.schedule,
            b.eta_minutes,
            b.status          AS booking_status,
            b.created_at,
            bw.status         AS worker_status,
            bw.assigned_at,
            bw.confirmed_at,
            bw.accepted_at,
            -- service_options has no name column; the human label is the
            -- deepest populated level of the catalog hierarchy.
            COALESCE(NULLIF(TRIM(so.level_3), ''), NULLIF(TRIM(so.level_2), '')) AS service_name,
            so.duration_mins
       FROM ${s}.booking_workers bw
       JOIN ${s}.bookings b ON b.id = bw.booking_id
       LEFT JOIN ${s}.service_options so ON so.id = b.service_option_id
      WHERE bw.worker_uid = $1
        AND b.schedule IS NOT NULL
        AND b.schedule >= $2
        AND b.schedule <= $3
        AND UPPER(COALESCE(bw.status, '')) = ANY($4)
      ORDER BY b.schedule ASC`,
    [providerUid, q.startIso, q.endIso,
      [...CONFIRMED_WORKER_STATUSES, ...AWAITING_WORKER_STATUSES]],
  );

  const events: CalendarEvent[] = [];
  for (const r of rows) {
    const start = toDate(r.schedule);
    if (!start) continue; // rule 3 — no start, no event

    const workerStatus = String(r.worker_status ?? '').toUpperCase();
    const confirmed = CONFIRMED_WORKER_STATUSES.includes(workerStatus);

    // `service_options.duration_mins` is the booked job length and is the right
    // width for a calendar block. `eta_minutes` is only the travel estimate, so
    // it is a fallback rather than the first choice — a 10-minute drive would
    // otherwise draw a 10-minute job.
    const duration = Number(r.duration_mins);
    const eta = Number(r.eta_minutes);
    const minutes =
      Number.isFinite(duration) && duration > 0
        ? duration
        : Number.isFinite(eta) && eta > 0
          ? eta
          : 0;
    const end = endAfter(start, minutes > 0 ? new Date(start.getTime() + minutes * 60_000) : null, 60);

    const service = String(r.service_name ?? '').trim() || 'Servana booking';
    const updatedAt =
      toDate(r.confirmed_at) ?? toDate(r.accepted_at) ?? toDate(r.assigned_at) ?? toDate(r.created_at) ?? start;

    events.push({
      eventId: `booking-${r.id}`,
      eventType: confirmed ? 'CONFIRMED_BOOKING' : 'BOOKING_AWAITING_RESPONSE',
      sourceEntityId: String(r.id),
      title: service,
      start: start.toISOString(),
      end: end.toISOString(),
      timezone: SERVANA_TIMEZONE,
      allDay: false,
      status: workerStatus || 'UNKNOWN',
      // Work still awaiting a response is what the provider must act on, so it
      // sorts above work already committed to.
      priority: confirmed ? 1 : 2,
      providerSummary: confirmed ? `Confirmed — ${service}` : `Awaiting your response — ${service}`,
      hasConflict: false,
      availableActions: confirmed
        ? [{ code: 'VIEW_JOB', label: 'View job' }]
        : [
            { code: 'ACCEPT_BOOKING', label: 'Accept' },
            { code: 'DECLINE_BOOKING', label: 'Decline' },
          ],
      version: 1,
      updatedAt: updatedAt.toISOString(),
    });
  }
  return events;
}

/** Approved time away, which is what makes the rest of the calendar honest. */
async function loadTimeOffEvents(providerUid: string, q: CalendarQuery): Promise<CalendarEvent[]> {
  const { rows } = await dbQuery.query(
    `SELECT id, start_date, end_date, all_day, start_time, end_time,
            reason, note, status, created_at, cancelled_at
       FROM ${s}.worker_time_off
      WHERE worker_uid = $1
        AND COALESCE(cancelled_at, NULL) IS NULL
        AND UPPER(COALESCE(status, 'ACTIVE')) <> 'CANCELLED'
        AND start_date <= $3
        AND end_date   >= $2
      ORDER BY start_date ASC`,
    [providerUid, q.startIso, q.endIso],
  );

  const events: CalendarEvent[] = [];
  for (const r of rows) {
    const startDay = toDate(r.start_date);
    const endDay = toDate(r.end_date);
    if (!startDay) continue;

    const allDay = r.all_day === true || !r.start_time || !r.end_time;
    let start: Date;
    let end: Date;

    if (allDay) {
      start = new Date(`${calendarDayOf(r.start_date)}T00:00:00.000Z`);
      // end_date is inclusive, so the block runs to the END of that day.
      // Without the +1 a single-day leave would have start === end and be
      // dropped by the client (rule 1).
      end = new Date(`${calendarDayOf(r.end_date ?? r.start_date)}T00:00:00.000Z`);
      end = new Date(end.getTime() + 86_400_000);
    } else {
      // Same rule as the all-day branch: raw column, not a parsed Date. This
      // half had the identical defect and would have silently produced a
      // 15-minute block for every timed leave.
      start = new Date(`${calendarDayOf(r.start_date)}T${String(r.start_time).slice(0, 5)}:00.000Z`);
      end = endAfter(start, new Date(`${calendarDayOf(r.end_date ?? r.start_date)}T${String(r.end_time).slice(0, 5)}:00.000Z`));
    }
    if (Number.isNaN(start.getTime())) continue;
    end = endAfter(start, Number.isNaN(end.getTime()) ? null : end);

    const label = String(r.reason ?? '').trim() || 'Time off';
    events.push({
      eventId: `time-off-${r.id}`,
      eventType: 'TIME_OFF',
      sourceEntityId: String(r.id),
      title: label,
      start: start.toISOString(),
      end: end.toISOString(),
      timezone: SERVANA_TIMEZONE,
      allDay,
      status: String(r.status ?? 'ACTIVE').toUpperCase(),
      priority: 0,
      // `note` is the provider's own text. It is shown back only to them, and
      // never to a customer (§58).
      providerSummary: String(r.note ?? '').trim() || label,
      hasConflict: false,
      availableActions: [{ code: 'VIEW_TIME_OFF', label: 'View' }],
      version: 1,
      updatedAt: (toDate(r.created_at) ?? start).toISOString(),
    });
  }
  return events;
}

/**
 * Marks bookings that overlap approved time off.
 *
 * Surfaced rather than resolved: the backend does not know which one is wrong,
 * and §57's "report ambiguity rather than guess" applies to a live schedule as
 * much as to a migration. The provider sees the clash and decides.
 */
function flagConflicts(events: CalendarEvent[]): CalendarEvent[] {
  const timeOff = events.filter((e) => e.eventType === 'TIME_OFF');
  if (timeOff.length === 0) return events;

  return events.map((e) => {
    if (e.eventType === 'TIME_OFF') return e;
    const s0 = new Date(e.start).getTime();
    const e0 = new Date(e.end).getTime();
    const clashes = timeOff.some((t) => s0 < new Date(t.end).getTime() && e0 > new Date(t.start).getTime());
    return clashes ? { ...e, hasConflict: true } : e;
  });
}

/**
 * Builds the calendar for ONE provider.
 *
 * `providerUid` comes from the verified token at the controller and is never
 * accepted from the wire (§7/§11) — mobile's own comment on this call says the
 * same thing.
 */
export async function getProviderCalendar(
  providerUid: string,
  query: CalendarQuery,
): Promise<CalendarResult> {
  const [bookings, timeOff] = await Promise.all([
    loadBookingEvents(providerUid, query),
    loadTimeOffEvents(providerUid, query),
  ]);

  // One booking can carry several `booking_workers` rows for the same provider
  // — production booking 75 has two, from a reassignment — and the eventId is
  // keyed on the BOOKING, so the same id would be emitted twice. §9 says one
  // booking is one canonical event, so it is collapsed here rather than left
  // for the client. Mobile happens to dedupe too, but a contract that depends
  // on the consumer cleaning up after it is not a contract.
  //
  // The surviving row is the most recently updated one, which is the current
  // assignment rather than a superseded one.
  const canonical = new Map<string, CalendarEvent>();
  for (const event of [...bookings, ...timeOff]) {
    const existing = canonical.get(event.eventId);
    if (!existing || event.updatedAt > existing.updatedAt) canonical.set(event.eventId, event);
  }

  let events = flagConflicts([...canonical.values()]);

  if (query.eventTypes?.length) {
    const wanted = new Set(query.eventTypes);
    events = events.filter((e) => wanted.has(e.eventType));
  }

  events.sort((a, b) => (a.start === b.start ? a.eventId.localeCompare(b.eventId) : a.start < b.start ? -1 : 1));

  return {
    generatedAt: new Date().toISOString(),
    timezone: SERVANA_TIMEZONE,
    events,
    availabilityVersion: null,
    resultVersion: CALENDAR_RESULT_VERSION,
  };
}
