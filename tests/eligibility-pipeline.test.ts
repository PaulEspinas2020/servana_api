/**
 * One eligibility pipeline, and the split that makes it safe.
 *
 * Candidate generation, Admin assignment and auto-assignment may RANK
 * differently. They must not QUALIFY differently — a provider the preview calls
 * ineligible and the executor happily assigns is a contradiction the operator
 * gets blamed for, and it was measurably real: three capability predicates and
 * two conflict predicates, disagreeing.
 */

import fs from 'fs';
import path from 'path';

import {
  ELIGIBILITY_PIPELINE,
  COMMIT_CRITICAL_STAGES,
  PROVIDER_CAPABILITY_SQL,
  CAPABILITY_GRANT_EXISTS_SQL,
  CAPABLE_PROVIDER_COUNT_SQL,
  bookingCanonicalServiceSql,
  CONFLICTING_BOOKING_SQL,
  DEFAULT_SERVICE_DURATION_MINS,
  bookingSpan,
  NON_OCCUPYING_STATUSES,
  providerRolePredicate,
  LEGACY_AUTO_GAP,
} from '../src/services/booking/eligibilityPipeline';
import { PROVIDER_ROLES } from '../src/constants/providerRoles';

const SRC = path.join(__dirname, '..', 'src');

const codeOf = (relative: string): string => fs
  .readFileSync(path.join(SRC, relative), 'utf8')
  .replace(/\r\n/g, '\n')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((l) => !l.trim().startsWith('//'))
  .join('\n');

// ─── The pipeline is declared, ordered and split ──────────────────────────────

describe('the pipeline declaration', () => {
  it('has twelve stages in order, with no gaps', () => {
    expect(ELIGIBILITY_PIPELINE).toHaveLength(12);
    expect(ELIGIBILITY_PIPELINE.map((s) => s.step)).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    );
  });

  it('splits ownership at stage 10', () => {
    /**
     * TAB 05: who is eligible and who ranks highest.
     * Executor: whether the ALREADY-SELECTED provider can still be committed.
     */
    for (const stage of ELIGIBILITY_PIPELINE) {
      expect(`${stage.step}:${stage.owner}`)
        .toBe(`${stage.step}:${stage.step <= 10 ? 'TAB05' : 'EXECUTOR'}`);
    }
  });

  it('every stage states WHY it is classified as it is', () => {
    // "It is in the list" is not a reason, and a stage nobody can justify is a
    // stage somebody will reclassify by accident.
    for (const stage of ELIGIBILITY_PIPELINE) {
      expect(stage.why.length).toBeGreaterThan(50);
      expect(stage.name).toMatch(/^[a-zA-Z]+$/);
    }
  });

  it('names exactly the stages that can RACE as commit-critical', () => {
    /**
     * The three things that change between ranking and writing: a provider can
     * be deactivated, lose a qualification, or take another job. Everything
     * else is edited by the provider on their own schedule and does not race
     * with an assignment in flight.
     */
    expect([...COMMIT_CRITICAL_STAGES].sort()).toEqual([
      'activeNotArchived',
      'bookingConflict',
      'capabilityForBookingService',
    ]);
  });

  it('does NOT make ranking commit-critical', () => {
    /**
     * Re-running scoring under a row lock would hold the lock for a scoring
     * pass. A stale ranking is a suboptimal assignment; a stale conflict check
     * is a double-booked provider. Only one is a correctness failure.
     */
    const ranking = ELIGIBILITY_PIPELINE.find((s) => s.name === 'distanceEtaRankingScoring');
    expect(ranking?.stageClass).toBe('SELECTION_ONLY');
    expect(COMMIT_CRITICAL_STAGES).not.toContain('distanceEtaRankingScoring');
  });

  it('commit-critical stages are derived, not hand-listed', () => {
    // A hand-maintained second list is how the two fall out of step.
    const derived = ELIGIBILITY_PIPELINE
      .filter((s) => s.stageClass === 'COMMIT_CRITICAL' && s.owner === 'TAB05')
      .map((s) => s.name);
    expect(COMMIT_CRITICAL_STAGES).toEqual(derived);
  });
});

// ─── The shared predicates ────────────────────────────────────────────────────

describe('capability is asked ONE way, and the canonical source is primary', () => {
  const sql = PROVIDER_CAPABILITY_SQL('servana');

  it('asks the CANONICAL table first', () => {
    /**
     * The Master Command's capability source:
     * `catalog_provider_services.service_id -> services.id`.
     *
     * Declared first in the source list, so the canonical answer is the one a
     * reader sees first and the one the classifier reports as `CANONICAL`.
     */
    expect(sql).toContain('servana.catalog_provider_services');
    expect(sql.indexOf('catalog_provider_services'))
      .toBeLessThan(sql.indexOf('servana.employee_services'));
    // The canonical table has a real status column with a CHECK constraint,
    // so unlike the legacy grant it CAN be filtered safely.
    expect(sql).toMatch(/catalog_provider_services[\s\S]*?status\s*=\s*'active'/);
  });

  it('keeps the legacy family grants as a fallback, not as the answer', () => {
    /**
     * Removing them would be a NARROWING, and a narrowing of capability is the
     * silent supply collapse this tab exists to prevent: a provider whose
     * canonical row was never projected would simply stop being assignable.
     *
     * Since canonical rows are a fan-out OF these grants, canonical is a subset
     * of legacy and the union preserves today's assignability exactly.
     */
    expect(sql).toContain('servana.employee_services');
    expect(sql).toContain('servana.worker_service_applications');
    expect(sql).toContain("status = 'approved'");
    expect(sql).toContain('UNION ALL');
  });

  it('reports WHICH source answered, rather than stopping at the first', () => {
    // A probe that stopped at the first match could not answer "did the
    // canonical table say so, or did only the legacy grant" — which is the
    // number that decides when the fallback can be removed.
    expect(sql).toContain("SELECT 'CANONICAL' AS source");
    expect(sql).toContain("SELECT 'LEGACY_EMPLOYEE_SERVICE' AS source");
    expect(sql).toContain("SELECT 'LEGACY_APPROVED_APPLICATION' AS source");
    expect(sql).not.toContain('LIMIT 1');
  });

  it('takes BOTH id spaces, because they are not interchangeable', () => {
    /**
     * `$2` is the canonical `services.id`; `$3` is the legacy
     * `service_families.id`. One family implies up to 54 bookable services, so
     * comparing one against the other would qualify the wrong providers.
     */
    const canonicalClause = sql.slice(sql.indexOf('catalog_provider_services'), sql.indexOf('UNION ALL'));
    expect(canonicalClause).toContain('g.service_id = $2');

    const legacyClauses = sql.slice(sql.indexOf('UNION ALL'));
    expect(legacyClauses).toContain('g.service_id = $3');
    expect(legacyClauses).not.toContain('g.service_id = $2');
  });

  it('does NOT filter employee_services.status', () => {
    /**
     * Looks like an oversight; is not. The column is created by lazy DDL in
     * providerAutoOnlineEngine, so filtering on it would make qualification
     * depend on which code path ran first — the hazard class migration 027
     * exists to close, and one of the reasons to move to the canonical table.
     */
    const legacyClauses = sql.slice(sql.indexOf('servana.employee_services'));
    expect(legacyClauses).not.toMatch(/employee_services[\s\S]*?status\s*=\s*'active'/);
  });

  it('the executor uses the shared predicate, not a copy', () => {
    const executor = codeOf('services/booking/transitionExecutor.ts');
    expect(executor).toContain('PROVIDER_CAPABILITY_SQL');
    // And it classifies the answer rather than merely counting rows.
    expect(executor).toContain('classifyCapabilityRows');
    expect(executor).toContain('recordCapabilityDecision');
  });

  it('substitutes the schema rather than hard-coding one', () => {
    expect(PROVIDER_CAPABILITY_SQL('other')).toContain('other.catalog_provider_services');
    expect(PROVIDER_CAPABILITY_SQL('other')).toContain('other.employee_services');
    expect(sql).not.toContain('other.');
  });

  it('asks it the same way of ONE provider and of a whole population', () => {
    /**
     * The row probe (fixed placeholders, what the executor runs) and the
     * boolean fragment (column references, what candidate generation and the
     * supply counters run) are built from a single declaration of the grant
     * sources. Two hand-written forms of the same question is how the audit
     * came to find three capability predicates naming different subsets of
     * these tables — agreement re-established by hand lasts until the next edit.
     */
    const fragment = CAPABILITY_GRANT_EXISTS_SQL('servana', 'uc.uid', '$1', '$2');
    for (const source of [
      'servana.catalog_provider_services',
      'servana.employee_services',
      'servana.worker_service_applications',
    ]) {
      expect(sql).toContain(source);
      expect(fragment).toContain(source);
    }
    expect(fragment).toContain("status = 'approved'");
    expect(fragment).toContain('provider_uid = uc.uid');
    expect(fragment).toContain('employee_uid = uc.uid');
    expect(fragment).toContain('worker_uid = uc.uid');
    expect(fragment).not.toContain('LIMIT');
  });

  it('can be narrowed to one source, for the adoption measurement', () => {
    // How the supply counter reports canonical and legacy-only separately
    // without a second hand-written predicate.
    const canonicalOnly = CAPABILITY_GRANT_EXISTS_SQL('servana', 'uc.uid', '$1', '$2', 'CANONICAL_ONLY');
    expect(canonicalOnly).toContain('catalog_provider_services');
    expect(canonicalOnly).not.toContain('employee_services');

    const legacyOnly = CAPABILITY_GRANT_EXISTS_SQL('servana', 'uc.uid', '$1', '$2', 'LEGACY_ONLY');
    expect(legacyOnly).not.toContain('catalog_provider_services');
    expect(legacyOnly).toContain('employee_services');
    expect(legacyOnly).toContain('worker_service_applications');
  });
});

describe('the booking resolves to a canonical services.id', () => {
  const expr = bookingCanonicalServiceSql('servana');

  it('prefers the stored column and resolves the rest, rather than copying an id', () => {
    /**
     * `catalog_service_id` and `service_option_id` are equal only for the 95
     * promoted rows. A Service created through the Admin API takes its id from
     * the sequence and has no legacy option, so copying the option id would
     * write a dangling reference that looks correct today.
     */
    expect(expr).toContain('b.catalog_service_id');
    expect(expr).toContain('legacy_service_option_id');
    expect(expr).toContain('servana.services');
  });

  it('is an expression, so it can be embedded in any booking query', () => {
    expect(bookingCanonicalServiceSql('servana', 'bk')).toContain('bk.catalog_service_id');
  });
});

describe('the capability supply counter', () => {
  const counter = CAPABLE_PROVIDER_COUNT_SQL('servana');

  it('is the denominator that makes "zero candidates" diagnosable', () => {
    // Zero eligible out of zero capable is a catalog fact; zero out of fourteen
    // is an incident. Nothing downstream can tell those apart without this.
    expect(counter).toContain('AS capable');
    expect(counter).toContain(CAPABILITY_GRANT_EXISTS_SQL('servana', 'uc.uid', '$1', '$2'));
  });

  it('splits the count by SOURCE, which is the adoption measurement', () => {
    /**
     * `capable` is what the matcher will accept while the fallback lives, so it
     * stays the honest denominator. `legacy_only` is the number that has to
     * reach zero before the fallback can be removed — without it, "the canonical
     * table is complete" is a belief rather than a measurement.
     */
    expect(counter).toContain('AS canonical');
    expect(counter).toContain('AS legacy_only');
    expect(counter).toContain('FILTER (WHERE');
  });

  it('does not filter by the same conditions as the numerator', () => {
    // Filtering account state here would report "capable but all deactivated"
    // as an empty catalog — the exact confusion the count resolves.
    expect(counter).not.toContain('account_status');
    expect(counter).not.toContain('activation_status');
    expect(counter).toContain('uc.is_archive = false');
  });

  it('uses the canonical role predicate', () => {
    expect(counter).toContain(providerRolePredicate('uc.role'));
  });
});

describe('the conflict rule is the job SPAN, not a fixed window', () => {
  /**
   * The policy moved, deliberately and once.
   *
   * The previous revision pinned `±2 hours` here and said, in as many words,
   * that adopting the real-span rule would change eligibility AND centralise it
   * in the same step, making a supply change impossible to attribute. Both
   * conditions that blocked it have since been met: every producer now shares
   * one predicate, and there are no live booking records for the new rule to
   * re-decide. The arithmetic itself lives in
   * `tests/booking-conflict-overlap.test.ts`.
   */
  it('has no fixed window left to configure', () => {
    const pipeline = codeOf('services/booking/eligibilityPipeline.ts');
    expect(pipeline).not.toContain('CONFLICT_WINDOW_HOURS');
    expect(pipeline).not.toContain('conflictWindowFor');
    expect(pipeline).not.toContain('2 * 60 * 60 * 1000');
  });

  it('DOES consult duration_mins now, through one declaration', () => {
    // The inverse of the marker the previous revision carried. What matters is
    // that there is exactly one place the fallback is written down.
    const pipeline = codeOf('services/booking/eligibilityPipeline.ts');
    expect(pipeline).toContain('duration_mins');
    expect(pipeline).toContain('DEFAULT_SERVICE_DURATION_MINS');
    expect(DEFAULT_SERVICE_DURATION_MINS).toBe(120);
  });

  it('computes a span forward from the schedule, never backwards', () => {
    const span = bookingSpan(new Date('2026-09-01T10:00:00.000Z'), 45);
    expect(span.from.toISOString()).toBe('2026-09-01T10:00:00.000Z');
    expect(span.to.toISOString()).toBe('2026-09-01T10:45:00.000Z');
  });

  it('treats finished and cancelled work as non-occupying', () => {
    expect([...NON_OCCUPYING_STATUSES].sort()).toEqual(
      ['CANCELED', 'CANCELLED', 'COMPLETED', 'EXPIRED', 'FAILED', 'REFUNDED'],
    );
    // Both cancellation spellings, because both exist in production data.
    expect(NON_OCCUPYING_STATUSES).toContain('CANCELLED');
    expect(NON_OCCUPYING_STATUSES).toContain('CANCELED');
  });

  it('the emitted SQL excludes every non-occupying status', () => {
    const sql = CONFLICTING_BOOKING_SQL('servana');
    for (const status of NON_OCCUPYING_STATUSES) {
      expect(sql).toContain(`'${status}'`);
    }
    expect(sql).toContain('b.worker_uid = $1');
    expect(sql).toContain('b.id <> $2');
  });

  it('the executor uses the shared predicate, not a copy', () => {
    const executor = codeOf('services/booking/transitionExecutor.ts');
    expect(executor).toContain('CONFLICTING_BOOKING_SQL');
    expect(executor).not.toContain('2 * 60 * 60 * 1000');
    // It passes only identifiers: the spans are resolved in SQL, so the
    // committer cannot disagree with the preview about how long a job lasts.
    expect(executor).toContain('[providerUid, bookingId]');
  });
});

describe('EVERY producer asks the conflict question the same way', () => {
  /**
   * The audit found two conflict predicates and three capability predicates.
   * Fixing the executor alone leaves the divergence intact where it does the
   * most damage: in the SELECTORS, which decide who is ever offered.
   *
   * Every file below either generates candidates or commits an assignment.
   */
  const PRODUCERS = [
    'services/booking/transitionExecutor.ts',   // commit-time revalidation
    'services/technicianService.ts',            // auto-assignment selection
    'services/adminBookingService.ts',          // admin candidate preview
    'services/providerAvailabilityEngine.ts',   // per-provider availability answer
    'services/providerEligibilityEngine.ts',    // ranked admin candidate pool
  ];

  it.each(PRODUCERS)('%s does not re-inline a fixed window', (file) => {
    const code = codeOf(file);
    expect(code).not.toContain('2 * 60 * 60 * 1000');
    expect(code).not.toContain("INTERVAL '2 hours'");
    expect(code).not.toContain('CONFLICT_WINDOW_HOURS');
  });

  /**
   * Every SQL template in the file that asks about a PROVIDER'S BOOKINGS —
   * both a worker column and the schedule. That is the occupancy question,
   * wherever it is asked from: commit-time revalidation, candidate generation,
   * a per-provider availability answer, or a time-off collision check.
   *
   * Scoped this way deliberately. A status filter on an admin LIST is a
   * different question ("which bookings are late") and answering it with the
   * occupancy list would be wrong, so a file-wide ban would push a correct
   * query to satisfy a guard it is not about.
   */
  const occupancyQueriesIn = (file: string): string[] =>
    (codeOf(file).match(/`[^`]*`/g) ?? [])
      .filter((sql) => /worker_uid|bw\.worker_uid/.test(sql) && /schedule/.test(sql))
      .filter((sql) => /NOT IN/.test(sql));

  it.each(PRODUCERS)('%s builds its occupancy list from the shared declaration', (file) => {
    const queries = occupancyQueriesIn(file);
    for (const sql of queries) {
      // A hand-written list is how the availability engine came to treat a
      // REFUNDED booking as occupying while the executor did not — a preview
      // narrower than its committer, which hides assignable providers.
      expect(sql).not.toMatch(/status\s+NOT\s+IN\s*\(\s*'/i);
      expect(sql).toMatch(/NON_OCCUPYING_STATUSES|OCCUPANCY_EXCLUSION_SQL/);
    }
  });

  it.each(PRODUCERS)('%s measures a job by its own duration', (file) => {
    // Either it embeds the shared span expression, or it delegates to a builder
    // that does. What it must never do is assume a length.
    expect(codeOf(file)).toMatch(
      /serviceDurationMinsSql|bookingEndSql|OVERLAPS_SPAN_SQL|CONFLICTING_BOOKING_SQL|BUSY_PROVIDERS_SQL|bookingSpan/,
    );
  });

  it('the occupancy scan still finds a query to check', () => {
    // A filter that matched nothing would make the assertion above vacuous.
    const found = PRODUCERS.filter((f) => occupancyQueriesIn(f).length > 0);
    expect(found.length).toBeGreaterThan(0);
  });

  it('only ONE producer still writes an occupancy query by hand', () => {
    /**
     * It used to be four. The executor, auto-assignment selection and the admin
     * preview now call `CONFLICTING_BOOKING_SQL` / `BUSY_PROVIDERS_SQL` instead
     * of assembling their own, so the raw SQL exists in one place.
     *
     * The availability engine keeps its own because it answers a different
     * shape of question — one provider, both assignment tables unioned, with
     * per-reason explanations — but it interpolates the same predicate.
     */
    const found = PRODUCERS.filter((f) => occupancyQueriesIn(f).length > 0);
    expect(found).toEqual(['services/providerAvailabilityEngine.ts']);
    for (const sql of occupancyQueriesIn(found[0])) {
      // Either the whole overlap predicate, or — for the time-off collision
      // query, which compares local times of day rather than instants — the
      // shared duration expression it is built from.
      expect(sql).toMatch(/OVERLAPS_SPAN_SQL|serviceDurationMinsSql/);
    }
  });

  it('the producer list is not empty, and names files that exist', () => {
    // A typo'd path would make every assertion above vacuous.
    expect(PRODUCERS.length).toBeGreaterThan(3);
    for (const file of PRODUCERS) expect(codeOf(file).length).toBeGreaterThan(500);
  });
});

describe('the provider role predicate comes from the canonical set', () => {
  it('covers every declared provider role', () => {
    // Role 4 is a SECOND provider role. Asking `role = 2` reported role-4
    // providers as "Provider not found".
    const predicate = providerRolePredicate('uc.role');
    for (const role of PROVIDER_ROLES) {
      expect(predicate).toContain(String(role));
    }
  });

  it('is re-exported so callers do not inline IN (2, 4)', () => {
    // Inlining is exactly how one predicate came to be missing role 4 while
    // its neighbour had it.
    expect(typeof providerRolePredicate).toBe('function');
  });
});

// ─── The LEGACY_AUTO gap stays visible ────────────────────────────────────────

describe('the LEGACY_AUTO gap is CLOSED', () => {
  it('records that it closed, and what closed it', () => {
    /**
     * Auto-assignment used to commit with the schedule conflict alone, so it
     * could take a provider `ADMIN_ASSIGN` would refuse. It now declares
     * `FULL`, like every other producer of that write.
     */
    expect(LEGACY_AUTO_GAP.status).toBe('CLOSED');
    expect(LEGACY_AUTO_GAP.missingStages).toEqual([]);
    expect(LEGACY_AUTO_GAP.closedBy).toContain("targetValidation: 'FULL'");
  });

  it('keeps what it used to skip, so the correction stays legible', () => {
    // A closed gap with no memory of what it was reads as if the weakness
    // never existed, and the next person to add a profile learns nothing.
    expect([...LEGACY_AUTO_GAP.previouslySkipped].sort()).toEqual([
      'activeNotArchived', 'canonicalProviderRole', 'capabilityForBookingService',
    ]);
  });

  it('every previously-skipped stage is a real pipeline stage', () => {
    // Otherwise the note rots into a description of something that no longer
    // exists.
    const names = ELIGIBILITY_PIPELINE.map((s) => s.name);
    for (const stage of LEGACY_AUTO_GAP.previouslySkipped) {
      expect(names).toContain(stage);
    }
  });

  it('auto-assignment declares the canonical profile', () => {
    const executor = codeOf('services/booking/transitionExecutor.ts');
    const autoAssign = executor.slice(
      executor.indexOf('AUTO_ASSIGN: {'),
      executor.indexOf('ADMIN_REASSIGN: {'),
    );
    expect(autoAssign).toContain("targetValidation: 'FULL'");
    expect(executor).not.toContain("targetValidation: 'LEGACY_AUTO'");
  });

  it('the weaker profile cannot be declared again', () => {
    // The union has one member, so a second profile has to be added in a diff
    // somebody reviews rather than by a flag appearing on one action.
    const executor = codeOf('services/booking/transitionExecutor.ts');
    expect(executor).toContain("export type TargetValidationProfile = 'FULL';");
  });

  it('a refusal is attributed, not merely thrown', () => {
    // The tightening is only safe because a refused provider costs a candidate
    // rather than a booking — and that is only diagnosable if the refusal says
    // which stage refused.
    const executor = codeOf('services/booking/transitionExecutor.ts');
    expect(executor).toContain('recordAutoAssignEvaluation');
    expect(executor).toContain("reasonCode: 'ACCOUNT_ARCHIVED'");
    expect(executor).toContain("reasonCode: 'NO_ACTIVE_SERVICE'");
    expect(executor).toContain("reasonCode: 'BOOKING_CONFLICT'");
  });
});
