/**
 * Why auto-assignment refused a provider — in the same vocabulary the Admin
 * candidate list uses.
 *
 * ## What this replaced
 *
 * `AUTO_ASSIGN` used to commit with `targetValidation: 'LEGACY_AUTO'`: the
 * schedule conflict and nothing else. Role, archive state and canonical
 * capability were skipped, so the matching engine could commit a provider
 * `ADMIN_ASSIGN` would have refused — two producers of the same write
 * disagreeing, which is the failure this tab exists to remove.
 *
 * The previous revision measured that gap in shadow rather than closing it,
 * because closing it is a TIGHTENING and the runbook wanted a number first.
 * The canonical validation now DECIDES on both paths. This module is what
 * stops that being a silent narrowing: every refusal is attributed to a reason
 * code an operator already knows from the candidate pool, counted, and
 * returned to the caller so the search continues rather than collapsing.
 *
 * ## The attribution
 *
 * `assertAssignableProvider` throws `TransitionError` with a `reasonCode` in
 * its detail, drawn from `candidateDiagnostics.BLOCKER_PRECEDENCE`. Using the
 * SAME codes as the Admin preview is the point: "why did nobody get this job"
 * and "why is this provider greyed out in the list" are the same question, and
 * an operator should not have to learn two vocabularies to ask it.
 *
 * ## What it must never do
 *
 * Decide. It records and it explains. The refusal itself comes from the
 * executor, under the booking-row and provider advisory locks.
 */

import { BLOCKER_PRECEDENCE } from './candidateDiagnostics';

/**
 * Reason codes an assignment refusal can carry.
 *
 * Every one is already in `BLOCKER_PRECEDENCE`, asserted below, so the auto
 * path cannot invent a code the candidate diagnostics cannot rank.
 */
export type AssignmentRefusalCode =
  | 'ACCOUNT_INACTIVE'
  | 'ACCOUNT_ARCHIVED'
  | 'NO_ACTIVE_SERVICE'
  | 'BOOKING_CONFLICT';

export const ASSIGNMENT_REFUSAL_CODES: readonly AssignmentRefusalCode[] = [
  'ACCOUNT_INACTIVE',
  'ACCOUNT_ARCHIVED',
  'NO_ACTIVE_SERVICE',
  'BOOKING_CONFLICT',
];

/**
 * Is this code one the candidate diagnostics can already rank?
 *
 * Exported so the guard test asserts the two vocabularies agree rather than
 * trusting that they were written to.
 */
export const isRankableRefusal = (code: string): boolean =>
  BLOCKER_PRECEDENCE.includes(code);

/**
 * A refusal that a candidate WALK should survive.
 *
 * `assignNearestWorker` ranks a candidate list and commits the first provider
 * that validates. Every code here means "not this provider" — so the search
 * moves to the next one. It does NOT mean "not this booking", which is why the
 * distinction is declared rather than inferred from an error class.
 *
 * All four are currently skippable. Kept as a list anyway: the first refusal
 * that means "stop, this booking is broken" must be added here consciously,
 * not discovered when auto-assignment silently walks past it.
 */
export const SKIPPABLE_REFUSALS: readonly AssignmentRefusalCode[] = [
  'ACCOUNT_INACTIVE',
  'ACCOUNT_ARCHIVED',
  'NO_ACTIVE_SERVICE',
  'BOOKING_CONFLICT',
];

export const isSkippableRefusal = (code: unknown): code is AssignmentRefusalCode =>
  typeof code === 'string' && (SKIPPABLE_REFUSALS as readonly string[]).includes(code);

// ─── The counters ─────────────────────────────────────────────────────────────

export interface AutoAssignDiagnosticsReport {
  /** Providers the strict validation was asked about. */
  evaluated: number;
  /** Of those, ones it committed. */
  committed: number;
  /** Of those, ones it refused — attributed below. */
  refused: number;
  /** Refusals per reason code. Sums to `refused`. */
  byReason: Record<string, number>;
  /**
   * Bookings that reached the end of their candidate list with nobody
   * assignable. The number an operator actually feels.
   */
  exhausted: number;
  since: string;
}

const fresh = (): AutoAssignDiagnosticsReport => ({
  evaluated: 0,
  committed: 0,
  refused: 0,
  byReason: {},
  exhausted: 0,
  since: new Date().toISOString(),
});

let report = fresh();

/** Never throws: this runs on the assignment path. */
export const recordAutoAssignEvaluation = (
  outcome: { committed: boolean; reasonCode?: unknown },
): void => {
  try {
    report.evaluated += 1;
    if (outcome.committed) { report.committed += 1; return; }

    report.refused += 1;
    const code = typeof outcome.reasonCode === 'string' && outcome.reasonCode.trim()
      ? outcome.reasonCode
      : 'UNATTRIBUTED_REFUSAL';
    report.byReason[code] = (report.byReason[code] ?? 0) + 1;
  } catch { /* a counter must never break an assignment */ }
};

/** A booking whose whole candidate list was refused. */
export const recordAutoAssignExhausted = (): void => {
  try { report.exhausted += 1; } catch { /* never throws */ }
};

export const autoAssignDiagnosticsReport = (): AutoAssignDiagnosticsReport => ({
  ...report,
  byReason: { ...report.byReason },
});

export const resetAutoAssignDiagnostics = (): void => { report = fresh(); };

/**
 * The dominant reason a booking found nobody, from the refusals collected
 * while walking its candidate list.
 *
 * Ranked by `BLOCKER_PRECEDENCE`, exactly as the Admin candidate pool ranks
 * them, so the same pool produces the same headline either way. Ties break on
 * count first, then precedence, then alphabetically — deterministic, because a
 * reason that changes between two identical runs is a reason nobody trusts.
 */
export const dominantRefusal = (codes: readonly string[]): string | null => {
  if (!codes.length) return null;

  const counts = new Map<string, number>();
  for (const code of codes) counts.set(code, (counts.get(code) ?? 0) + 1);

  const rank = (code: string): number => {
    const index = BLOCKER_PRECEDENCE.indexOf(code);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };

  return [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    if (rank(a[0]) !== rank(b[0])) return rank(a[0]) - rank(b[0]);
    return a[0].localeCompare(b[0]);
  })[0][0];
};

/**
 * The reason `assignNearestWorker` reports when no candidate could be
 * committed.
 *
 * `NO_WORKER_AVAILABLE_AFTER_RECHECK` was true and useless: it said the walk
 * finished without saying what stopped it, so an operator could not tell a
 * capability gap from a diary full of conflicts. The attributed form keeps the
 * legacy string as the `reason` — the field callers already switch on — and
 * adds the diagnosis beside it.
 */
export const noAssignmentDiagnosis = (
  refusals: readonly string[],
): { reason: string; refusedBy: string | null; refusals: Record<string, number> } => {
  const counts: Record<string, number> = {};
  for (const code of refusals) counts[code] = (counts[code] ?? 0) + 1;

  return {
    reason: 'NO_WORKER_AVAILABLE_AFTER_RECHECK',
    refusedBy: dominantRefusal(refusals),
    refusals: counts,
  };
};
