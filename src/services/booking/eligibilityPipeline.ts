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
 * Provider qualification for a service.
 *
 * ## Two id spaces, and why the predicate needs both
 *
 * The canonical grant keys on `services.id` — the bookable Specific Service.
 * The legacy grants key on `service_families.id` — the coarse family, of which
 * there are ten. One family approval implies every bookable service under it,
 * up to 54. They are not interchangeable and never were, so the predicate takes
 * both ids rather than pretending one converts to the other:
 *
 *   `$1` = provider uid
 *   `$2` = canonical `services.id`        (from `bookings.catalog_service_id`)
 *   `$3` = legacy `service_families.id`   (from `service_options.service_id`)
 *
 * ## Canonical first, legacy as an INSTRUMENTED fallback
 *
 * `catalog_provider_services` is the authoritative source. It is asked first,
 * and every decision records which source answered
 * (`capabilitySource.classifyCapabilityRows`).
 *
 * The legacy sources remain in the predicate because removing them would be a
 * NARROWING, and a narrowing of capability is exactly the silent supply
 * collapse this tab exists to prevent: a provider whose canonical row was never
 * projected would simply stop being assignable, with no error anybody sees.
 * They are kept until the fallback counter reads zero for a full window — the
 * criteria are in `capabilitySource.CANONICAL_ADOPTION_CRITERIA`, and they are
 * measurable rather than a promise.
 *
 * Since the canonical rows are a fan-out OF the legacy grants (migration 021,
 * migration 029), canonical ⊆ legacy by construction. Asking for the union
 * therefore preserves today's assignability EXACTLY while making the canonical
 * source primary and its coverage measurable.
 *
 * `employee_services.status` is still not filtered. That looks like an
 * oversight and is not: the column is created by LAZY DDL in
 * `providerAutoOnlineEngine`, so on a path where that bootstrap has not run the
 * column may not exist. The canonical table has a real `status` column with a
 * CHECK constraint and IS filtered — which is one of the reasons to move.
 */
interface CapabilityGrantSource {
  /** Reported on every decision, so a fallback is countable rather than silent. */
  name: 'CANONICAL' | 'LEGACY_EMPLOYEE_SERVICE' | 'LEGACY_APPROVED_APPLICATION';
  table: string;
  uidColumn: string;
  /** Which id space this source keys on. */
  key: 'CANONICAL_SERVICE' | 'LEGACY_FAMILY';
  /** Extra predicate, if the grant only counts in some states. Aliased. */
  extra: (alias: string) => string;
}

/**
 * The grant sources, declared ONCE, canonical first.
 *
 * The row-probe (`PROVIDER_CAPABILITY_SQL`, what the executor runs), the
 * set-shaped fragment (`CAPABILITY_GRANT_EXISTS_SQL`, what candidate generation
 * runs) and the supply counters are all built from this list, so a source
 * cannot be added to one and forgotten in the others. That is not
 * hypothetical: the capability audit found three predicates naming different
 * subsets of these tables.
 */
const CAPABILITY_GRANT_SOURCES: readonly CapabilityGrantSource[] = [
  {
    name: 'CANONICAL',
    table: 'catalog_provider_services',
    uidColumn: 'provider_uid',
    key: 'CANONICAL_SERVICE',
    extra: (a) => ` AND ${a}.status = 'active'`,
  },
  {
    name: 'LEGACY_EMPLOYEE_SERVICE',
    table: 'employee_services',
    uidColumn: 'employee_uid',
    key: 'LEGACY_FAMILY',
    extra: () => '',
  },
  {
    name: 'LEGACY_APPROVED_APPLICATION',
    table: 'worker_service_applications',
    uidColumn: 'worker_uid',
    key: 'LEGACY_FAMILY',
    extra: (a) => ` AND ${a}.status = 'approved'`,
  },
];

/** The canonical source, named once so nothing has to look it up by index. */
export const CANONICAL_CAPABILITY_TABLE = 'catalog_provider_services';

export const LEGACY_CAPABILITY_TABLES: readonly string[] = CAPABILITY_GRANT_SOURCES
  .filter((g) => g.key === 'LEGACY_FAMILY')
  .map((g) => g.table);

const keyPlaceholder = (source: CapabilityGrantSource): string =>
  (source.key === 'CANONICAL_SERVICE' ? '$2' : '$3');

/**
 * Which sources qualify this provider — ALL of them, not the first.
 *
 * Deliberately not `LIMIT 1`. The question is no longer only "is this provider
 * qualified" but "did the canonical source say so, or did only the legacy one",
 * and a probe that stops at the first match cannot answer the second. At most
 * three index lookups, and the answer is what makes the fallback retirable.
 */
export const PROVIDER_CAPABILITY_SQL = (schema: string | undefined): string =>
  CAPABILITY_GRANT_SOURCES.map((g) => `SELECT '${g.name}' AS source FROM ${schema}.${g.table} g
   WHERE g.${g.uidColumn} = $1 AND g.service_id = ${keyPlaceholder(g)}${g.extra('g')}`)
    .join('\n  UNION ALL\n  ');

/**
 * The same qualification as a boolean fragment, for set-shaped queries.
 *
 * `PROVIDER_CAPABILITY_SQL` answers for ONE provider with fixed placeholders.
 * Candidate generation asks the same question of a whole population in one
 * pass, and the supply counters ask how many providers hold a grant at all —
 * neither can use a fixed-placeholder probe. Rather than let those callers
 * write the predicate again (which is how the divergence started), they
 * interpolate this.
 *
 * All three expression arguments are CALLER-CONTROLLED SQL, not values: pass
 * column references or placeholders only, never anything derived from a
 * request. Pass `NULL` for an id space the caller does not have — a comparison
 * against NULL is never true, so that source simply does not match.
 */
export const CAPABILITY_GRANT_EXISTS_SQL = (
  schema: string | undefined,
  uidExpression: string,
  canonicalServiceExpression: string,
  legacyFamilyExpression: string,
  only?: 'CANONICAL_ONLY' | 'LEGACY_ONLY',
): string => {
  const sources = CAPABILITY_GRANT_SOURCES.filter((g) =>
    only === undefined
    || (only === 'CANONICAL_ONLY' && g.key === 'CANONICAL_SERVICE')
    || (only === 'LEGACY_ONLY' && g.key === 'LEGACY_FAMILY'));

  return `(${sources.map((g) => {
    const key = g.key === 'CANONICAL_SERVICE' ? canonicalServiceExpression : legacyFamilyExpression;
    return `EXISTS (SELECT 1 FROM ${schema}.${g.table} g
      WHERE g.${g.uidColumn} = ${uidExpression} AND g.service_id = ${key}${g.extra('g')})`;
  }).join('\n     OR ')})`;
};

/**
 * How many providers hold a grant for a service, ignoring every other stage.
 *
 * This is the denominator that makes "zero candidates" diagnosable. Zero
 * eligible providers out of zero capable is a catalog fact; zero out of
 * fourteen is an outage, and the two are indistinguishable without this count.
 *
 * Split three ways on purpose. `capable` is what the matcher will actually
 * accept, so it is the honest denominator while the fallback lives. `canonical`
 * and `legacyOnly` are the ADOPTION measurement: `legacyOnly > 0` means rows
 * are missing from `catalog_provider_services`, and it is the number that has
 * to reach zero before the fallback can be removed.
 *
 * Deliberately does NOT filter `account_status` or `provider_activation`. It
 * measures capability SUPPLY, so that "capable but all deactivated" reports as
 * a collapse with an attributable cause rather than as an empty catalog.
 *
 * `$1` = canonical `services.id`, `$2` = legacy `service_families.id`.
 */
export const CAPABLE_PROVIDER_COUNT_SQL = (schema: string | undefined): string => {
  const anyGrant = CAPABILITY_GRANT_EXISTS_SQL(schema, 'uc.uid', '$1', '$2');
  const canonical = CAPABILITY_GRANT_EXISTS_SQL(schema, 'uc.uid', '$1', '$2', 'CANONICAL_ONLY');
  const legacy = CAPABILITY_GRANT_EXISTS_SQL(schema, 'uc.uid', '$1', '$2', 'LEGACY_ONLY');

  return `
  SELECT COUNT(*) FILTER (WHERE ${anyGrant})::int                      AS capable,
         COUNT(*) FILTER (WHERE ${canonical})::int                     AS canonical,
         COUNT(*) FILTER (WHERE ${legacy} AND NOT ${canonical})::int   AS legacy_only
    FROM ${schema}.user_credentials uc
   WHERE uc.is_archive = false
     AND ${providerRoleSqlPredicate('uc.role')}`;
};

/**
 * The booking's canonical `services.id`, resolved three ways in one expression.
 *
 * `bookings.catalog_service_id` is written by `bookingService` for new bookings
 * and was backfilled for history by migration 021 — but a booking created in
 * the window between those two, or one whose option has no canonical Service,
 * carries NULL. The subselect resolves it through `legacy_service_option_id`
 * rather than copying `service_option_id`, because the two are equal only for
 * the 95 promoted rows: a Service created through the Admin API takes its id
 * from the sequence and has no legacy option at all.
 *
 * NULL is a legitimate answer (the ADD_ON options were never promoted). It
 * means the canonical source cannot match, and the legacy fallback decides —
 * which the diagnostics report rather than hide.
 */
export const bookingCanonicalServiceSql = (
  schema: string | undefined,
  bookingAlias = 'b',
): string =>
  `COALESCE(${bookingAlias}.catalog_service_id,
            (SELECT cs.id FROM ${schema}.services cs
              WHERE cs.legacy_service_option_id = ${bookingAlias}.service_option_id))`;

/**
 * The canonical provider-role predicate, built from the declared role set.
 *
 * Re-exported here so an eligibility caller does not reach past the pipeline
 * for it and inline `IN (2, 4)` — which is how role 4 came to be missing from
 * one predicate while present in its neighbour.
 */
export const providerRolePredicate = providerRoleSqlPredicate;

/**
 * The booking-conflict rule: **half-open overlap against each job's real span.**
 *
 * ## What this replaced, and why it had to
 *
 * Until now the rule was a fixed **±2 hours around the scheduled time**, which
 * asks a question nobody actually means: it ignores how long the job lasts. The
 * Phase 0 measurement found it wrong in BOTH directions, and the executor and
 * the availability engine disagreeing about the same provider:
 *
 * | Scenario | Fixed ±2h | Real span |
 * |---|---|---|
 * | 30-min job at 10:00, second job at 11:30 | **refuses** | 10:00–10:30 vs 11:30 → free |
 * | 4-hour job at 10:00, second job at 13:00 | **assigns** | 10:00–14:00 covers 13:00 → conflict |
 *
 * The second row is the operationally damaging one: it double-books a provider
 * on work the availability engine already knew overlapped. The first quietly
 * starves short-job supply — a provider doing 30-minute jobs was blocked out
 * for four hours around each one.
 *
 * ## Why it is safe to change NOW and was not before
 *
 * Two conditions had to hold, and both now do.
 *
 * 1. **Centralisation first.** Changing eligibility *and* centralising it in one
 *    step would have made a resulting supply change impossible to attribute to
 *    either. Every producer now shares this one declaration, so the policy moves
 *    once, here, and every caller moves with it.
 * 2. **No live bookings.** Provider records are live; client, order and booking
 *    records are not. There is no historical assignment for this rule to
 *    re-decide, so the delta is prospective only.
 *
 * ## Half-open, deliberately
 *
 * `[start, end)`. A job ending at 12:00 does NOT collide with one starting at
 * 12:00. Closed intervals would refuse every back-to-back booking, which is the
 * normal shape of a working day, and the time-off overlap rule in
 * `providerAvailabilityEngine` already uses the half-open form — so this is the
 * repository's existing convention, adopted rather than invented.
 *
 * ## Instants, not wall-clock
 *
 * The comparison is between `timestamptz` values, so it is timezone-independent
 * by construction. The old rule did its arithmetic on JS `Date` objects in the
 * server's zone; this cannot drift with a deployment region or a DST boundary.
 */

/**
 * The duration to assume when a job does not state one.
 *
 * **Not invented here.** `service_options.duration_mins` is declared
 * `INT NOT NULL DEFAULT 120` by the lazy DDL in `adminCreateBookingService`,
 * and three live queries already read it as `COALESCE(duration_mins, 120)`.
 * This constant names that existing convention so the fallback is one value
 * rather than a literal repeated at each call site.
 *
 * A row predating the column, or one whose value is NULL, is therefore treated
 * exactly as it is treated everywhere else today: a two-hour job.
 */
export const DEFAULT_SERVICE_DURATION_MINS = 120;

/**
 * A job's duration in minutes, defended against the three ways it can be absent
 * or nonsensical.
 *
 * NULL (row predates the column), zero and negative all fall back to the
 * default. Zero is the dangerous one: a zero-length span overlaps nothing, so a
 * single bad row would make a provider infinitely bookable at that instant —
 * silently, and only for that provider.
 */
export const serviceDurationMinsSql = (optionAlias = 'so'): string =>
  `COALESCE(NULLIF(GREATEST(${optionAlias}.duration_mins, 0), 0), ${DEFAULT_SERVICE_DURATION_MINS})`;

/** A job's end instant: its schedule plus its duration. */
export const bookingEndSql = (bookingAlias = 'b', optionAlias = 'so'): string =>
  `(${bookingAlias}.schedule + (${serviceDurationMinsSql(optionAlias)} || ' minutes')::interval)`;

/**
 * Half-open overlap between an existing booking and a candidate span.
 *
 * `startExpression` and `endExpression` are CALLER-CONTROLLED SQL — placeholders
 * or column references, never a request value.
 */
export const OVERLAPS_SPAN_SQL = (
  startExpression: string,
  endExpression: string,
  bookingAlias = 'b',
  optionAlias = 'so',
): string =>
  `(${bookingAlias}.schedule < ${endExpression} AND ${bookingEndSql(bookingAlias, optionAlias)} > ${startExpression})`;

/** The same span, computed in TypeScript for callers that already hold both values. */
export const bookingSpan = (
  schedule: Date,
  durationMins?: number | null,
): { from: Date; to: Date } => {
  const minutes = typeof durationMins === 'number' && durationMins > 0
    ? durationMins
    : DEFAULT_SERVICE_DURATION_MINS;
  return { from: schedule, to: new Date(schedule.getTime() + minutes * 60 * 1000) };
};

/**
 * Booking statuses that do NOT occupy a provider.
 *
 * A completed or cancelled job is not a conflict. Both cancellation spellings
 * are listed because both exist in production data.
 */
export const NON_OCCUPYING_STATUSES: readonly string[] =
  ['COMPLETED', 'CANCELLED', 'CANCELED', 'REFUNDED', 'FAILED', 'EXPIRED'];

export const OCCUPANCY_EXCLUSION_SQL: string =
  NON_OCCUPYING_STATUSES.map((s) => `'${s}'`).join(', ');

/**
 * Does this provider already hold work overlapping the target booking's span?
 *
 * Both spans are resolved IN SQL from the booking rows themselves, so the
 * caller cannot supply a duration that disagrees with the database — the shape
 * that let the preview and the committer answer differently in the first place.
 *
 * `$1` = provider uid, `$2` = the booking being assigned (excluded from its own
 * conflict check).
 */
export const CONFLICTING_BOOKING_SQL = (schema: string | undefined): string => `
  WITH target AS (
    SELECT tb.schedule AS start_at, ${bookingEndSql('tb', 'tso')} AS end_at
      FROM ${schema}.bookings tb
      LEFT JOIN ${schema}.service_options tso ON tso.id = tb.service_option_id
     WHERE tb.id = $2
  )
  SELECT b.id
    FROM ${schema}.bookings b
    LEFT JOIN ${schema}.service_options so ON so.id = b.service_option_id
    CROSS JOIN target t
   WHERE b.worker_uid = $1 AND b.id <> $2
     AND b.status NOT IN (${OCCUPANCY_EXCLUSION_SQL})
     AND ${OVERLAPS_SPAN_SQL('t.start_at', 't.end_at')}
   LIMIT 1`;

/**
 * The providers already occupied during a span. The set-shaped form.
 *
 * `$1` = span start, `$2` = span end, `$3` = a booking id to exclude (pass the
 * booking being assigned, or `NULL` when previewing a slot that has none yet).
 */
export const BUSY_PROVIDERS_SQL = (schema: string | undefined): string => `
  SELECT DISTINCT b.worker_uid
    FROM ${schema}.bookings b
    LEFT JOIN ${schema}.service_options so ON so.id = b.service_option_id
   WHERE b.worker_uid IS NOT NULL
     AND ($3::int IS NULL OR b.id <> $3)
     AND b.status NOT IN (${OCCUPANCY_EXCLUSION_SQL})
     AND ${OVERLAPS_SPAN_SQL('$1::timestamptz', '$2::timestamptz')}`;

/**
 * The LEGACY_AUTO gap: CLOSED.
 *
 * Auto-assignment used to validate its target more weakly than Admin
 * assignment — the schedule conflict only, skipping role, archive state and
 * canonical capability. So the matching engine could commit a provider
 * `ADMIN_ASSIGN` would have refused: two producers of the same write
 * disagreeing, which is the failure this pipeline exists to remove.
 *
 * `AUTO_ASSIGN` now declares `targetValidation: 'FULL'`, so every producer
 * passes the same hard constraints under the same two locks.
 *
 * ## Why the "measure first" caveat no longer applies
 *
 * The caveat was real: tightening auto-assignment changes which bookings get
 * assigned, and the runbook wanted the delta measured before the flip. What
 * made it moot is the SHAPE of the refusal, not a number.
 *
 * `assignNearestWorker` walks a RANKED CANDIDATE LIST. A refusal costs a
 * candidate, not a booking — the walk moves to the next provider — so the
 * tightening cannot fail an assignment that would otherwise have succeeded
 * unless EVERY candidate is ineligible, and in that case the assignment was
 * wrong to make. Each refusal is attributed to a candidate-diagnostics reason
 * code and counted, so a booking that exhausts its list says which stage
 * emptied it (`services/booking/autoAssignDiagnostics.ts`).
 */
export const LEGACY_AUTO_GAP = {
  status: 'CLOSED',
  /** Stages `LEGACY_AUTO` skipped, now revalidated at commit like every other. */
  missingStages: [] as readonly string[],
  closedBy:
    "AUTO_ASSIGN declares targetValidation: 'FULL'. The refusal is skippable — "
    + 'the caller walks a ranked candidate list, so a refused provider costs a '
    + 'candidate rather than a booking — and every refusal is attributed to a '
    + 'candidate-diagnostics reason code and counted in autoAssignDiagnostics.',
  /** What it used to skip. Kept so the correction stays legible. */
  previouslySkipped: [
    'canonicalProviderRole', 'activeNotArchived', 'capabilityForBookingService',
  ] as readonly string[],
} as const;
