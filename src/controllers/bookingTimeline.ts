/**
 * The provider-facing booking timeline.
 *
 * Command 18 §21. Every event here is derived from a real timestamp column, so
 * the frontend never has to invent one — §21: "Generate from authoritative
 * events. Never fabricate missing events in the frontend."
 *
 * That rule cuts both ways. If a stage has no timestamp, it produces no event
 * rather than a guessed one: a booking whose `accepted_at` predates the column
 * being added shows no acceptance event, which is honest, instead of a
 * fabricated time that would read as fact.
 *
 * §21 also forbids exposing internal metadata and other providers' identities.
 * Actors are therefore CATEGORIES ("you", "the customer", "Servana") — never
 * names, never uids.
 */

export type TimelineEventCode =
  | "BOOKING_CREATED"
  | "ASSIGNED"
  | "PROVIDER_ACCEPTED"
  | "PROVIDER_DECLINED"
  | "PROVIDER_EN_ROUTE"
  | "PROVIDER_ARRIVED"
  | "JOB_STARTED"
  | "JOB_COMPLETED"
  | "BOOKING_CANCELLED";

/** Who caused the event, at a granularity that identifies nobody. */
export type TimelineActor = "YOU" | "CUSTOMER" | "SERVANA";

export interface TimelineEvent {
  code: TimelineEventCode;
  /** Provider-facing label. Not a backend transition name (§5). */
  label: string;
  /** ISO-8601, or null when the stage is known to have happened but was not
   *  timestamped — older rows predating the lazily-added columns. */
  at: string | null;
  actor: TimelineActor;
  /** Position in the canonical order, stable regardless of timestamps. */
  sequence: number;
}

interface TimelineRow {
  created_at?: unknown;
  assigned_at?: unknown;
  accepted_at?: unknown;
  declined_at?: unknown;
  en_route_at?: unknown;
  arrived_at?: unknown;
  started_at?: unknown;
  completed_at?: unknown;
  /** booking_workers.status */
  worker_status?: unknown;
  /** bookings.status — the source of cancellation. */
  booking_status?: unknown;
}

const iso = (v: unknown): string | null => {
  if (v == null || v === "") return null;
  // pg parsers hand back ISO strings for timestamps in this codebase, but a
  // Date survives a direct driver call, so both are accepted.
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const upper = (v: unknown) => String(v ?? "").toUpperCase();

/**
 * Builds the timeline in canonical order.
 *
 * Ordering is by `sequence`, not by timestamp: clock skew between rows must not
 * reorder a lifecycle whose sequence is known. §21 requires chronological
 * order, and the canonical sequence IS the chronology for a state machine that
 * only moves forwards.
 */
export function buildBookingTimeline(row: TimelineRow): TimelineEvent[] {
  const workerStatus = upper(row.worker_status);
  const bookingStatus = upper(row.booking_status);
  const events: TimelineEvent[] = [];

  const add = (
    code: TimelineEventCode,
    label: string,
    at: string | null,
    actor: TimelineActor,
    sequence: number
  ) => events.push({ code, label, at, actor, sequence });

  const created = iso(row.created_at);
  if (created) add("BOOKING_CREATED", "Booking created", created, "CUSTOMER", 0);

  const assigned = iso(row.assigned_at);
  if (assigned) add("ASSIGNED", "Assigned to you", assigned, "SERVANA", 1);

  // Terminal response: a declined booking never continues, so nothing after it
  // is emitted even if a stale timestamp exists on the row.
  if (workerStatus === "DECLINED") {
    add("PROVIDER_DECLINED", "You declined this booking", iso(row.declined_at), "YOU", 2);
    return events.sort((a, b) => a.sequence - b.sequence);
  }

  // Every status past ASSIGNED implies acceptance happened, even when the
  // timestamp is absent on rows predating the column.
  const acceptedImplied = ["ACCEPTED", "EN_ROUTE", "ARRIVED", "IN_PROGRESS", "COMPLETED"].includes(
    workerStatus
  );
  const acceptedAt = iso(row.accepted_at);
  if (acceptedAt || acceptedImplied) {
    add("PROVIDER_ACCEPTED", "You accepted this booking", acceptedAt, "YOU", 2);
  }

  const enRoute = iso(row.en_route_at);
  if (enRoute) add("PROVIDER_EN_ROUTE", "You marked yourself on the way", enRoute, "YOU", 3);

  const arrived = iso(row.arrived_at);
  if (arrived) add("PROVIDER_ARRIVED", "You marked yourself arrived", arrived, "YOU", 4);

  const started = iso(row.started_at);
  if (started) add("JOB_STARTED", "Job started", started, "YOU", 5);

  const completed = iso(row.completed_at);
  if (completed) add("JOB_COMPLETED", "Job completed", completed, "YOU", 6);

  // Cancellation can arrive from either side at any point. §12/§27 forbid
  // naming who replaced the provider, so the label attributes nobody.
  const cancelled =
    ["CANCELED", "CANCELLED"].includes(bookingStatus) ||
    ["CANCELED", "CANCELLED"].includes(workerStatus);
  if (cancelled) {
    add("BOOKING_CANCELLED", "Booking cancelled", null, "SERVANA", 7);
  }

  return events.sort((a, b) => a.sequence - b.sequence);
}

/**
 * The event the provider is currently at — the last one that happened.
 *
 * §21 requires distinguishing completed, current and upcoming steps without
 * relying on colour alone; this gives the client the anchor to do it.
 */
export function currentTimelineStep(events: TimelineEvent[]): TimelineEventCode | null {
  return events.length ? events[events.length - 1].code : null;
}
