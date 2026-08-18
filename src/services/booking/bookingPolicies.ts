/**
 * Booking POLICY — the operator's rules, in the domain layer.
 *
 * Moved here from `controllers/bookingCancellationPolicy.ts`. It was correct
 * where it was and enforced on the one path that existed, but a controller is
 * transport: a policy living there is optional depending on which caller
 * reaches the executor, which is exactly what centralisation is supposed to
 * end. It is now a named guard the canonical machine runs, so no backend caller
 * can route around it.
 *
 * Two consumers, ONE implementation:
 *
 *   transitionBooking(PROVIDER_CANCEL)      enforcement
 *   GET /api/v1/bookings/:id/transitions    what the UI may offer
 *
 * That pairing is deliberate. A UI that decides button visibility from its own
 * copy of the rule eventually shows a button the executor refuses; both now
 * read the same function, so they cannot disagree.
 *
 * Clients must NOT reimplement the window. They render the backend's
 * `allowed` / `reasonCode` / `allowedUntil`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * When a provider may cancel a booking they already accepted.
 *
 * Command 18 §26. The policy is the operator's, recorded here verbatim rather
 * than inferred — §26 says outright "Do not invent penalties":
 *
 *   - Cancellation is allowed up to 48 HOURS before the booking.
 *   - Inside 48 hours the provider cannot self-cancel; support handles it.
 *   - RECORD ONLY. No penalty, no fee, no rating impact. Nothing in this file
 *     computes a consequence, because none was specified and inventing one
 *     would be worse than having none.
 *   - Cancelling triggers auto-reassignment and notifies admin.
 *
 * Bookings are already paid and assigned by the time they are CONFIRMED, which
 * is why the window is measured against the scheduled start rather than
 * against acceptance.
 */

/**
 * The window, in one place.
 *
 * An operator changing the notice period edits this line and nothing else —
 * the executor guard, the transitions endpoint and the provider controller all
 * read it.
 */
export const PROVIDER_CANCEL_WINDOW_HOURS = 48;

/** Historical name, kept so existing callers and tests are not churned. */
export const CANCELLATION_NOTICE_HOURS = PROVIDER_CANCEL_WINDOW_HOURS;

/** Standardized reasons (§26 requires a reason code, §28 standardizes them). */
export const PROVIDER_CANCELLATION_REASONS = [
  "SCHEDULE_CONFLICT",
  "ILLNESS_OR_EMERGENCY",
  "TRANSPORT_UNAVAILABLE",
  "EQUIPMENT_UNAVAILABLE",
  "OUTSIDE_SERVICE_AREA",
  "CUSTOMER_REQUESTED",
  "OTHER",
] as const;

export type ProviderCancellationReason =
  (typeof PROVIDER_CANCELLATION_REASONS)[number];

export type CancellationBlockCode =
  /** Inside the 48-hour window. */
  | "INSIDE_NOTICE_WINDOW"
  /** Work has started, or the booking is already finished/cancelled. */
  | "NOT_CANCELLABLE_AT_THIS_STAGE"
  /** No schedule on the booking — cannot prove the window is satisfied. */
  | "SCHEDULE_UNKNOWN"
  /** Reason code not in the standardized list. */
  | "INVALID_REASON";

/**
 * Stages a provider may cancel from.
 *
 * Everything after acceptance and before work begins. IN_PROGRESS is excluded
 * deliberately: the 48-hour rule cannot be satisfied by a job that has already
 * started, and abandoning live work is a support and safety matter (§28), not
 * a self-service cancellation.
 */
const CANCELLABLE_WORKER_STATUSES = new Set(["ACCEPTED", "EN_ROUTE", "ARRIVED"]);

export interface CancellationEligibility {
  canCancel: boolean;
  blockCode: CancellationBlockCode | null;
  /** Whole hours until the scheduled start; negative once it has passed. */
  hoursUntilStart: number | null;
  noticeHours: number;
  /**
   * The instant after which self-cancellation is refused, ISO-8601.
   *
   * Returned so a client can say "until Thursday 09:00" without subtracting
   * 48 hours from a schedule itself. Null when there is no usable schedule —
   * a client must not invent one.
   */
  allowedUntil: string | null;
  reasons: readonly string[];
}

export function evaluateCancellation(params: {
  workerStatus: string | null | undefined;
  /** Scheduled start of the booking. */
  schedule: unknown;
  /** Server time. Passed in so the rule is testable without faking a clock. */
  now: Date;
  /** Omit when only checking eligibility rather than performing a cancel. */
  reasonCode?: string | null;
}): CancellationEligibility {
  const { workerStatus, schedule, now, reasonCode } = params;
  const status = String(workerStatus ?? "").toUpperCase();

  const scheduledAt =
    schedule instanceof Date ? schedule : schedule ? new Date(String(schedule)) : null;
  const scheduleValid = !!scheduledAt && !Number.isNaN(scheduledAt.getTime());

  const hoursUntilStart = scheduleValid
    ? Math.floor((scheduledAt!.getTime() - now.getTime()) / 3_600_000)
    : null;

  /**
   * The instant after which self-cancellation is refused.
   *
   * Returned on the block as well as the pass, so a provider seeing the button
   * disabled can be told what the deadline WAS rather than being left to
   * subtract 48 hours from a schedule themselves.
   */
  const allowedUntil = scheduleValid
    ? new Date(scheduledAt!.getTime() - PROVIDER_CANCEL_WINDOW_HOURS * 3_600_000).toISOString()
    : null;

  const block = (blockCode: CancellationBlockCode): CancellationEligibility => ({
    canCancel: false,
    blockCode,
    hoursUntilStart,
    noticeHours: PROVIDER_CANCEL_WINDOW_HOURS,
    allowedUntil,
    // No point offering reasons for a cancellation that cannot proceed.
    reasons: [],
  });

  // Stage first: a completed or declined booking is not "inside the window",
  // it is simply not cancellable, and saying so is clearer.
  if (!CANCELLABLE_WORKER_STATUSES.has(status)) {
    return block("NOT_CANCELLABLE_AT_THIS_STAGE");
  }

  if (!scheduleValid) {
    // Fail closed. Without a schedule the 48-hour guarantee cannot be proven,
    // and a cancellation that might be inside the window must not slip through.
    return block("SCHEDULE_UNKNOWN");
  }

  if (hoursUntilStart! < PROVIDER_CANCEL_WINDOW_HOURS) {
    return block("INSIDE_NOTICE_WINDOW");
  }

  if (reasonCode !== undefined && reasonCode !== null) {
    if (!PROVIDER_CANCELLATION_REASONS.includes(reasonCode as any)) {
      return block("INVALID_REASON");
    }
  }

  return {
    canCancel: true,
    blockCode: null,
    hoursUntilStart,
    noticeHours: PROVIDER_CANCEL_WINDOW_HOURS,
    allowedUntil,
    reasons: PROVIDER_CANCELLATION_REASONS,
  };
}


// ─── Customer self-cancellation ───────────────────────────────────────────────

/**
 * Booking statuses a customer may NOT self-cancel from.
 *
 * Moved here from `bookingService` when CUSTOMER_CANCEL migrated to the
 * executor. The list is unchanged, including the entries that are not
 * canonical states — `AWAITING_COMPLETION`, `REVIEWED`, `REFUNDED`, `FAILED`.
 *
 * That last point is the reason this reads the RAW status rather than the
 * canonical one. `deriveCanonicalState` maps an unrecognised status to
 * AWAITING_ASSIGNMENT, and cancelling from AWAITING_ASSIGNMENT is permitted —
 * so deriving first would make a booking at AWAITING_COMPLETION or REVIEWED
 * newly cancellable by its customer. Preserving the legacy list exactly is the
 * point; widening it by accident is not a refactor.
 *
 * The transition table has always declared `requires: ['cancellation_eligible']`
 * on the customer-cancel rules and nothing implemented it. This is that guard.
 */
export const CUSTOMER_NON_CANCELLABLE_STATUSES: ReadonlySet<string> = new Set([
  'CANCELLED', 'CANCELED', 'COMPLETED', 'IN_PROGRESS',
  'EN_ROUTE', 'ARRIVED', 'AWAITING_COMPLETION',
  'REVIEWED', 'REFUNDED', 'EXPIRED', 'FAILED',
]);

export const customerMayCancel = (bookingStatus: unknown): boolean =>
  !CUSTOMER_NON_CANCELLABLE_STATUSES.has(String(bookingStatus ?? '').toUpperCase());
