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
  // Stored admin-side events (C18-04). Derived from booking_timeline_events.
  | "ADMIN_ASSIGNED"
  | "ADMIN_RESCHEDULED"
  | "ADMIN_CANCELLED"
  | "COMPLETION_APPROVED"
  | "DISPUTE_OPENED"
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

// ─── Stored admin-side events (C18-04) ──────────────────────────────────────
//
// `booking_timeline_events` is written by the admin and booking services and
// holds history the provider genuinely needs — their booking being rescheduled,
// cancelled or disputed. The provider path writes nothing to it, so the two
// sources are disjoint rather than duplicates: derived events are the
// provider's own actions, stored events are everyone else's.
//
// Three rules govern what crosses:
//
//   1. WHITELIST by event type. `admin_note_added` is an internal note (§22)
//      and never crosses. An event type added later is unknown, and unknown is
//      dropped — fail closed.
//   2. NEVER pass through stored text. `title`, `description` and `metadata`
//      are admin-authored and may name people or carry investigation detail.
//      Each whitelisted type maps to a FIXED label written here.
//   3. Suppress entirely once the booking is reassigned away. A provider who
//      no longer holds the booking has no business watching what happens to it
//      next — the same rule C17 applied to customer data.

const STORED_EVENT_LABELS: Record<string, { code: TimelineEventCode; label: string }> = {
  booking_assigned:    { code: "ADMIN_ASSIGNED",     label: "Assigned by Servana" },
  booking_rescheduled: { code: "ADMIN_RESCHEDULED",  label: "Booking rescheduled" },
  booking_cancelled:   { code: "ADMIN_CANCELLED",    label: "Booking cancelled" },
  completion_approved: { code: "COMPLETION_APPROVED", label: "Completion approved" },
  dispute_opened:      { code: "DISPUTE_OPENED",     label: "A dispute was opened" },
  // Deliberately absent:
  //   admin_note_added   — internal note (§22)
  //   provider_reassigned — naming a handover to a provider who has lost the
  //                         booking tells them they were replaced and invites
  //                         asking by whom (§27). The suppression below is the
  //                         mechanism; this omission is belt and braces.
};

export interface StoredEventRow {
  event_type?: unknown;
  created_at?: unknown;
}

/**
 * Merges stored admin-side events into a derived provider timeline.
 *
 * `isCurrentAssignee` is the authorization gate: false means the booking was
 * reassigned away, and no admin event crosses. The provider keeps their OWN
 * history, which is a record of what they did, not surveillance of a booking
 * that is no longer theirs.
 */
export function mergeStoredEvents(
  derived: TimelineEvent[],
  stored: StoredEventRow[],
  isCurrentAssignee: boolean
): TimelineEvent[] {
  if (!isCurrentAssignee || !stored.length) return derived;

  const mapped: TimelineEvent[] = [];
  for (const row of stored) {
    const entry = STORED_EVENT_LABELS[String(row.event_type ?? "").toLowerCase()];
    if (!entry) continue; // unknown or blacklisted — fail closed
    const at = iso(row.created_at);
    if (!at) continue; // no authoritative time, no event (§21)
    mapped.push({
      code: entry.code,
      label: entry.label,
      at,
      actor: "SERVANA",
      // Slotted between the derived stages by time rather than given a fixed
      // rank: an admin action can land at any point in the lifecycle.
      sequence: sequenceForTime(derived, at),
    });
  }

  return [...derived, ...mapped].sort((a, b) => {
    if (a.sequence !== b.sequence) return a.sequence - b.sequence;
    // Same slot: order by time, and a null time sorts first so an untimed
    // stage never jumps ahead of a dated admin action.
    return String(a.at ?? "").localeCompare(String(b.at ?? ""));
  });
}

/** Places a stored event after the last derived stage that preceded it. */
function sequenceForTime(derived: TimelineEvent[], at: string): number {
  let seq = 0;
  for (const e of derived) {
    if (e.at && e.at <= at) seq = e.sequence;
  }
  return seq;
}
