/**
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

export const CANCELLATION_NOTICE_HOURS = 48;

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

  const block = (blockCode: CancellationBlockCode): CancellationEligibility => ({
    canCancel: false,
    blockCode,
    hoursUntilStart,
    noticeHours: CANCELLATION_NOTICE_HOURS,
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

  if (hoursUntilStart! < CANCELLATION_NOTICE_HOURS) {
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
    noticeHours: CANCELLATION_NOTICE_HOURS,
    reasons: PROVIDER_CANCELLATION_REASONS,
  };
}
