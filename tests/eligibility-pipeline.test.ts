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
  CONFLICTING_BOOKING_SQL,
  CONFLICT_WINDOW_HOURS,
  conflictWindowFor,
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

describe('capability is asked ONE way', () => {
  const sql = PROVIDER_CAPABILITY_SQL('servana');

  it('preserves the executor semantics exactly — two grants', () => {
    /**
     * The preview moves to meet the committer, not the other way round:
     * changing what COMMITS is a larger behaviour change than changing what a
     * preview says.
     */
    expect(sql).toContain('servana.employee_services');
    expect(sql).toContain('servana.worker_service_applications');
    expect(sql).toContain("status = 'approved'");
    expect(sql).toContain('UNION ALL');
  });

  it('does NOT filter employee_services.status', () => {
    /**
     * Looks like an oversight; is not. The column is created by lazy DDL in
     * providerAutoOnlineEngine, so filtering on it would make qualification
     * depend on which code path ran first — the hazard class migration 027
     * exists to close.
     */
    expect(sql).not.toMatch(/employee_services[\s\S]*?status\s*=\s*'active'/);
  });

  it('has not silently adopted catalog_provider_services', () => {
    // Nothing in this repository writes that table. Adopting it blind could
    // shrink the assignable pool with no error anybody sees.
    expect(sql).not.toContain('catalog_provider_services');
  });

  it('the executor uses the shared predicate, not a copy', () => {
    const executor = codeOf('services/booking/transitionExecutor.ts');
    expect(executor).toContain('PROVIDER_CAPABILITY_SQL');
    expect(executor).not.toContain('worker_service_applications\n');
  });

  it('substitutes the schema rather than hard-coding one', () => {
    expect(PROVIDER_CAPABILITY_SQL('other')).toContain('other.employee_services');
    expect(sql).not.toContain('other.');
  });
});

describe('the conflict rule is centralised, NOT redesigned', () => {
  it('keeps the +/-2 hour window', () => {
    /**
     * Deliberately not the better rule. The availability engine models the
     * job's real span with duration_mins, which is a more accurate question —
     * but adopting it here would change eligibility AND centralise it in one
     * commit, making any supply drop impossible to attribute to either.
     */
    expect(CONFLICT_WINDOW_HOURS).toBe(2);

    const schedule = new Date('2026-09-01T10:00:00.000Z');
    const w = conflictWindowFor(schedule);
    expect(w.from.toISOString()).toBe('2026-09-01T08:00:00.000Z');
    expect(w.to.toISOString()).toBe('2026-09-01T12:00:00.000Z');
  });

  it('does not consult duration_mins yet', () => {
    // The marker that the policy change has NOT been smuggled in.
    const pipeline = codeOf('services/booking/eligibilityPipeline.ts');
    expect(pipeline).not.toContain('duration_mins');
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
    expect(sql).toContain('worker_uid = $1');
    expect(sql).toContain('id <> $2');
  });

  it('the executor uses the shared predicate, not a copy', () => {
    const executor = codeOf('services/booking/transitionExecutor.ts');
    expect(executor).toContain('CONFLICTING_BOOKING_SQL');
    expect(executor).toContain('conflictWindowFor');
    expect(executor).not.toContain('2 * 60 * 60 * 1000');
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

describe('the LEGACY_AUTO gap closes upward, not quietly', () => {
  it('is recorded as OPEN with the stages it is missing', () => {
    expect(LEGACY_AUTO_GAP.status).toBe('OPEN');
    expect([...LEGACY_AUTO_GAP.missingStages].sort()).toEqual([
      'activeNotArchived', 'canonicalProviderRole', 'capabilityForBookingService',
    ]);
  });

  it('every missing stage is a real pipeline stage', () => {
    // Otherwise the gap note rots into a description of something that no
    // longer exists.
    const names = ELIGIBILITY_PIPELINE.map((s) => s.name);
    for (const stage of LEGACY_AUTO_GAP.missingStages) {
      expect(names).toContain(stage);
    }
  });

  it('requires measurement before it is closed', () => {
    // Tightening auto-assignment changes which bookings get assigned at all.
    expect(LEGACY_AUTO_GAP.closesWith).toContain('measuring');
    expect(LEGACY_AUTO_GAP.closesWith).toContain('behaviour correction');
  });

  it('auto-assignment still declares the weaker profile', () => {
    // The gap is real until it is closed; a test claiming otherwise would be
    // describing an intention.
    const executor = codeOf('services/booking/transitionExecutor.ts');
    expect(executor).toContain("targetValidation: 'LEGACY_AUTO'");
  });
});
