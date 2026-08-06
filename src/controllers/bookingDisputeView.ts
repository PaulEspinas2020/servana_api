/**
 * Provider-facing dispute status and eligibility.
 *
 * Command 18 §29, which asks this command for "the safe entry and status
 * summary" only — a later command may build the complete dispute center.
 *
 * ── Built on what already exists ──────────────────────────────────────────
 * Servana already has disputes: `booking_escalations` (reason_code, reason,
 * severity, assigned_team, actor_uid, resolved_at) plus a `dispute_opened`
 * timeline event and the admin portal's `hasDispute` filter, which derives
 * `'disputed'` from an unresolved escalation.
 *
 * So this reads that table rather than inventing a parallel dispute concept —
 * the standing equivalence rule. A second table would have given admin and
 * provider two different answers to "is this booking disputed?".
 *
 * ── What must NOT cross to the provider ───────────────────────────────────
 * §29: "Do not expose internal investigation notes." The escalation row is an
 * ADMIN record. `reason` is free text an admin typed, `assigned_team` is
 * internal routing, `severity` is internal triage, and `actor_uid` identifies
 * a person. None of them are returned. The provider gets state, timing, and
 * whether it was theirs.
 */

export type DisputeState = "NONE" | "OPEN" | "RESOLVED";

/** Why the provider may not open a dispute right now. */
export type DisputeIneligibilityCode =
  | "ALREADY_OPEN"
  | "NOT_YET_ACTIONABLE"
  | "BOOKING_NOT_YOURS";

/**
 * Categories a provider may raise, from §29.
 *
 * Deliberately a fixed list rather than free text: §29 requires standardized
 * categories, and free text from a provider about a customer is exactly the
 * content that must not end up in an unmoderated field.
 */
export const PROVIDER_DISPUTE_CATEGORIES = [
  "SCOPE_DISAGREEMENT",
  "PAYMENT_ISSUE",
  "CUSTOMER_CONDUCT",
  "PROVIDER_SAFETY",
  "CANCELLATION_DISAGREEMENT",
  "COMPLETION_DISAGREEMENT",
  "DAMAGE_CLAIM",
] as const;

export type ProviderDisputeCategory = (typeof PROVIDER_DISPUTE_CATEGORIES)[number];

export interface DisputeSummary {
  state: DisputeState;
  openedAt: string | null;
  resolvedAt: string | null;
  /** True when this escalation was raised by the calling provider. */
  openedByYou: boolean;
  canOpen: boolean;
  ineligibleReason: DisputeIneligibilityCode | null;
  categories: readonly string[];
}

interface EscalationRow {
  actor_uid?: unknown;
  resolved_at?: unknown;
  created_at?: unknown;
}

const iso = (v: unknown): string | null => {
  if (v == null || v === "") return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/**
 * Worker statuses at which raising a dispute makes sense.
 *
 * A provider who has not yet accepted has nothing to dispute — declining is
 * the mechanism there, and a dispute would be a support ticket. Once work is
 * committed to, every later stage can go wrong.
 */
const ACTIONABLE_WORKER_STATUSES = new Set([
  "ACCEPTED",
  "EN_ROUTE",
  "ARRIVED",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELED",
  "CANCELLED",
]);

export function buildDisputeSummary(params: {
  workerStatus: string | null | undefined;
  callerUid: string;
  /** The most recent escalation on the booking, if any. */
  escalation: EscalationRow | null;
}): DisputeSummary {
  const { workerStatus, callerUid, escalation } = params;
  const status = String(workerStatus ?? "").toUpperCase();

  const openedAt = escalation ? iso(escalation.created_at) : null;
  const resolvedAt = escalation ? iso(escalation.resolved_at) : null;
  const openedByYou =
    !!escalation && String(escalation.actor_uid ?? "") === callerUid;

  const state: DisputeState = !escalation
    ? "NONE"
    : resolvedAt
      ? "RESOLVED"
      : "OPEN";

  // §29: "Prevent duplicate disputes." An unresolved escalation blocks a new
  // one regardless of who raised it — the booking is already under review.
  let ineligibleReason: DisputeIneligibilityCode | null = null;
  if (state === "OPEN") {
    ineligibleReason = "ALREADY_OPEN";
  } else if (!ACTIONABLE_WORKER_STATUSES.has(status)) {
    // Covers ASSIGNED, DECLINED, and anything unrecognised — fails closed.
    ineligibleReason = "NOT_YET_ACTIONABLE";
  }

  return {
    state,
    openedAt,
    resolvedAt,
    openedByYou,
    canOpen: ineligibleReason === null,
    ineligibleReason,
    // Offering categories the provider cannot act on would be a dead menu, so
    // they appear only alongside a usable entry point.
    categories: ineligibleReason === null ? PROVIDER_DISPUTE_CATEGORIES : [],
  };
}
