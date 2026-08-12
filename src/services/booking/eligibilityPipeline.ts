/**
 * ONE eligibility pipeline, shared by every assignment producer.
 *
 * Candidate generation, Admin assignment and auto-assignment may rank
 * differently — that is a product question and TAB 05 owns it. They must not
 * *qualify* differently, because a provider the preview calls ineligible and
 * the executor happily assigns is a contradiction the operator gets blamed for.
 *
 * Measured before this existed (see `CAPABILITY_QUERY_AUDIT.md`): three live
 * capability predicates and two conflict predicates, disagreeing.
 *
 * ## The stage order
 *
 * Declared as data below, not as prose, so the split can be tested rather than
 * remembered. Stages 1–10 are TAB 05's: who is eligible and who ranks highest.
 * Stage 11 is the executor's: whether the ALREADY-SELECTED provider can still
 * be committed safely, right now, under locks.
 *
 * ## Why the executor rechecks anything at all
 *
 * Because selection and commit are separated by time. Between ranking a
 * provider and writing the row, they can accept another job, go offline, or be
 * archived. So the executor revalidates exactly the stages that can RACE — and
 * only those.
 *
 * It deliberately does NOT rerun ranking. Ranking is expensive, it is not a
 * safety property, and re-running it under a row lock would hold the lock for
 * the duration of a scoring pass. A stale ranking produces a suboptimal
 * assignment; a stale conflict check produces a double-booked provider. Only
 * one of those is a correctness failure.
 */

import { providerRoleSqlPredicate } from '../../constants/providerRoles';

/**
 * Whether a stage can change between selection and commit.
 *
 * `COMMIT_CRITICAL` stages are revalidated inside the executor's transaction.
 * `SELECTION_ONLY` stages are not — either they cannot race (a service
 * qualification is not revoked mid-assignment in practice) or re-running them
 * would cost more than the staleness does.
 */
export type StageClass = 'COMMIT_CRITICAL' | 'SELECTION_ONLY';

export interface EligibilityStage {
  step: number;
  name: string;
  owner: 'TAB05' | 'EXECUTOR';
  stageClass: StageClass;
  why: string;
}

export const ELIGIBILITY_PIPELINE: readonly EligibilityStage[] = [
  {
    step: 1, name: 'providerIdentityExists', owner: 'TAB05', stageClass: 'SELECTION_ONLY',
    why: 'A uid that resolves to no provider cannot become one mid-assignment.',
  },
  {
    step: 2, name: 'canonicalProviderRole', owner: 'TAB05', stageClass: 'SELECTION_ONLY',
    why: 'Roles 2 AND 4. Asking role = 2 reported role-4 providers as "not found", '
      + 'the least diagnosable message available — fixed in TAB 04 D4.',
  },
  {
    step: 3, name: 'activeNotArchived', owner: 'TAB05', stageClass: 'COMMIT_CRITICAL',
    why: 'RACES. A provider can be archived or deactivated between ranking and '
      + 'commit, and assigning a deactivated provider is exactly the case '
      + 'deactivation exists to prevent.',
  },
  {
    step: 4, name: 'capabilityForBookingService', owner: 'TAB05', stageClass: 'COMMIT_CRITICAL',
    why: 'Rechecked because it is cheap and because a revoked qualification '
      + 'between selection and commit would put an unqualified provider on a job.',
  },
  {
    step: 5, name: 'serviceAreaAndGeography', owner: 'TAB05', stageClass: 'SELECTION_ONLY',
    why: 'A service area is edited by the provider, not by the flow of other '
      + 'bookings, so it does not race with an assignment in progress.',
  },
  {
    step: 6, name: 'availabilityForSchedule', owner: 'TAB05', stageClass: 'SELECTION_ONLY',
    why: 'Declared availability — the weekly pattern and time off. Changed by the '
      + 'provider, not by concurrent assignment.',
  },
  {
    step: 7, name: 'bookingConflict', owner: 'TAB05', stageClass: 'COMMIT_CRITICAL',
    why: 'THE race. Two bookings selecting the same provider both read "no '
      + 'conflict" and both commit unless the check is repeated while holding '
      + 'the provider advisory lock. This is what that lock is FOR.',
  },
  {
    step: 8, name: 'capacityAndOperationalLimits', owner: 'TAB05', stageClass: 'SELECTION_ONLY',
    why: 'No capacity limit is enforced today. Declared so the stage exists '
      + 'before somebody adds one somewhere else.',
  },
  {
    step: 9, name: 'distanceEtaRankingScoring', owner: 'TAB05', stageClass: 'SELECTION_ONLY',
    why: 'Ranking, not eligibility. Never re-run at commit: a stale ranking is a '
      + 'suboptimal assignment, not an incorrect one.',
  },
  {
    step: 10, name: 'selectCandidate', owner: 'TAB05', stageClass: 'SELECTION_ONLY',
    why: 'The output of selection. Everything after this is commit machinery.',
  },
  {
    step: 11, name: 'revalidateCommitCritical', owner: 'EXECUTOR', stageClass: 'COMMIT_CRITICAL',
    why: 'Re-runs ONLY the commit-critical stages, inside the transaction, with '
      + 'the booking row locked and the provider advisory lock held.',
  },
  {
    step: 12, name: 'commitThroughTransitionBooking', owner: 'EXECUTOR', stageClass: 'COMMIT_CRITICAL',
    why: 'AUTO_ASSIGN / ADMIN_ASSIGN / ADMIN_REASSIGN. The only writer.',
  },
];

/** The stages the executor must repeat under lock. Derived, never hand-listed. */
export const COMMIT_CRITICAL_STAGES: readonly string[] = ELIGIBILITY_PIPELINE
  .filter((s) => s.stageClass === 'COMMIT_CRITICAL' && s.owner === 'TAB05')
  .map((s) => s.name);

// ─── The shared predicates ────────────────────────────────────────────────────

/**
 * Canonical provider qualification for a service.
 *
 * **Semantics preserved exactly from the executor**, which is the predicate
 * that currently decides real assignments. Changing what COMMITS is a larger
 * behaviour change than changing what a preview says, so the preview moves to
 * meet the committer rather than the other way round.
 *
 * Two grants, deliberately:
 *   - an `employee_services` row, at ANY status;
 *   - an APPROVED `worker_service_applications` row.
 *
 * `employee_services.status` is not filtered. That looks like an oversight and
 * is not: the column is created by LAZY DDL in `providerAutoOnlineEngine`, so
 * on any path where that bootstrap has not run the column may not exist. Adding
 * the filter here would make qualification depend on which code path ran first.
 *
 * The migration to `catalog_provider_services` is a SEPARATE, declared change —
 * nothing in this repository writes that table, so adopting it blind could
 * shrink the assignable pool silently. See `CAPABILITY_QUERY_AUDIT.md` §4.
 *
 * `$1` = provider uid, `$2` = service id.
 */
export const PROVIDER_CAPABILITY_SQL = (schema: string | undefined): string => `
  SELECT 1 FROM ${schema}.employee_services
   WHERE employee_uid = $1 AND service_id = $2
  UNION ALL
  SELECT 1 FROM ${schema}.worker_service_applications
   WHERE worker_uid = $1 AND service_id = $2 AND status = 'approved'
  LIMIT 1`;

/**
 * The canonical provider-role predicate, built from the declared role set.
 *
 * Re-exported here so an eligibility caller does not reach past the pipeline
 * for it and inline `IN (2, 4)` — which is how role 4 came to be missing from
 * one predicate while present in its neighbour.
 */
export const providerRolePredicate = providerRoleSqlPredicate;

/**
 * The booking-conflict window.
 *
 * **±2 hours around the booking's scheduled time. UNCHANGED.**
 *
 * This is deliberately not the better rule. The availability engine models the
 * job's real span using `duration_mins` and half-open overlap, and that is a
 * more accurate question — but adopting it here would change provider
 * eligibility *and* centralise it in the same commit, making any resulting
 * supply drop impossible to attribute to either.
 *
 * So: one implementation of the CURRENT policy now, shared by candidate
 * generation and commit-time revalidation. The policy change is a separate
 * product decision after TAB 05 certifies, and it should be preceded by
 * measuring newly-excluded providers, newly-eligible providers, assignment
 * success rate, average candidate count and late-arrival risk.
 */
export const CONFLICT_WINDOW_HOURS = 2;

export const conflictWindowFor = (schedule: Date): { from: Date; to: Date } => ({
  from: new Date(schedule.getTime() - CONFLICT_WINDOW_HOURS * 60 * 60 * 1000),
  to: new Date(schedule.getTime() + CONFLICT_WINDOW_HOURS * 60 * 60 * 1000),
});

/**
 * Booking statuses that do NOT occupy a provider.
 *
 * A completed or cancelled job is not a conflict. Both cancellation spellings
 * are listed because both exist in production data.
 */
export const NON_OCCUPYING_STATUSES: readonly string[] =
  ['COMPLETED', 'CANCELLED', 'CANCELED', 'REFUNDED', 'FAILED', 'EXPIRED'];

export const CONFLICTING_BOOKING_SQL = (schema: string | undefined): string => `
  SELECT id FROM ${schema}.bookings
   WHERE worker_uid = $1 AND id <> $2
     AND schedule BETWEEN $3 AND $4
     AND status NOT IN (${NON_OCCUPYING_STATUSES.map((s) => `'${s}'`).join(',')})
   LIMIT 1`;

/**
 * The LEGACY_AUTO gap, recorded so it closes upward rather than quietly.
 *
 * Auto-assignment validates its target more weakly than Admin assignment does.
 * TAB 04 preserved that deliberately — tightening it would have changed which
 * bookings get auto-assigned, mid-migration. The correction belongs in TAB 05
 * as a declared behaviour change, and it must be preceded by measuring the
 * candidate delta: how many auto-assignments the stricter rule would refuse.
 */
export const LEGACY_AUTO_GAP = {
  status: 'OPEN',
  missingStages: ['canonicalProviderRole', 'activeNotArchived', 'capabilityForBookingService'],
  closesWith:
    'Adopt the FULL target validation for AUTO_ASSIGN, after measuring how many '
    + 'currently-successful auto-assignments the stricter rule would refuse. '
    + 'Declare it as a TAB 05 behaviour correction, not folded into a refactor.',
} as const;
