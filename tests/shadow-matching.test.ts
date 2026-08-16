/**
 * Shadow matching: run the real pipeline over a fixed cast of providers and
 * compare the whole outcome against a written-down table.
 *
 * ## Why a table rather than more single-property tests
 *
 * Every stage in the pipeline already has a test that says "this predicate
 * refuses that provider". None of them says what the pipeline DECIDES when the
 * stages are composed — and composition is where matching actually goes wrong:
 * a stage silently stops running, two stages both fire and the blocker
 * attributed is the less useful one, or a widened predicate quietly promotes a
 * provider nobody expected.
 *
 * So the fixture below is a cast of twelve providers, each embodying exactly
 * one interesting combination of capability, account state, availability,
 * service area and compliance. The expected verdict for each is declared
 * beside it. A predicate change that moves ANY provider between eligible and
 * blocked flips a cell in that table and fails here by name, rather than
 * changing a number in a count assertion somewhere.
 *
 * ## What is real and what is a stand-in
 *
 * Real: the eligibility engine, its query sequence, the canonical capability
 * predicate, the score, the blocker attribution and the pool diagnosis.
 *
 * Stand-ins: `explainAvailability`, `explainCoverage`, `calculateCompliance`
 * and `evaluateServicePolicy` answer from the fixture. They are separately
 * tested against their own SQL, and running them for real here would make this
 * suite fail for reasons that have nothing to do with matching composition —
 * which is the way a golden test stops being read.
 */

jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn() },
}));
jest.mock('../src/config', () => ({ db: { schema: 'servana' } }));

jest.mock('../src/services/providerAvailabilityEngine', () => ({
  explainAvailability: jest.fn(),
}));
jest.mock('../src/services/providerServiceAreaEngine', () => ({
  explainCoverage: jest.fn(),
}));
jest.mock('../src/services/providerProfileComplianceService', () => ({
  calculateCompliance: jest.fn(),
}));
jest.mock('../src/services/providerServicePolicyService', () => ({
  evaluateServicePolicy: jest.fn(),
}));

import dbQuery from '../src/db/dbQuery';
import { explainAvailability } from '../src/services/providerAvailabilityEngine';
import { explainCoverage } from '../src/services/providerServiceAreaEngine';
import { calculateCompliance } from '../src/services/providerProfileComplianceService';
import { evaluateServicePolicy } from '../src/services/providerServicePolicyService';
import {
  listAssignmentCandidatePool,
  CANDIDATE_POOL_CAP,
} from '../src/services/providerEligibilityEngine';

const q = dbQuery.query as jest.Mock;

/** Canonical `services.id` — what catalog_provider_services keys on. */
const SERVICE = 55;
const OTHER_SERVICE = 77;
/** Legacy `service_families.id` — what the fallback grant tables key on. */
const LEGACY_FAMILY = 7;
const OTHER_LEGACY_FAMILY = 9;

// ─── The fixture cast ─────────────────────────────────────────────────────────

/**
 * How a provider is qualified, at the grain each source keys on.
 *
 * `CANONICAL` is a `catalog_provider_services` row on the bookable
 * `services.id`. The three legacy values are family grants, which the matcher
 * still honours through the instrumented fallback. Keeping them distinct is the
 * point: a predicate that confused the two id spaces would qualify the wrong
 * providers, and this fixture would say which.
 */
type Grant =
  | 'CANONICAL'
  | 'CANONICAL_AND_LEGACY'
  | 'ACTIVE_EMPLOYEE_SERVICE'
  | 'INACTIVE_EMPLOYEE_SERVICE'
  | 'APPROVED_APPLICATION'
  | 'NONE';

interface ProviderFixture {
  uid: string;
  /** What qualifies (or fails to qualify) them for the booking's service. */
  grant: Grant;
  accountStatus?: string;
  archived?: boolean;
  activation?: string;
  /** Availability verdict, as the availability engine would phrase it. */
  availability?: 'AVAILABLE' | 'TIME_OFF' | 'DAY_NOT_AVAILABLE' | 'BOOKING_CONFLICT';
  area?: 'COVERED' | 'CITY_NOT_IN_AREA';
  compliance?: 'compliant' | 'expiring_soon' | 'blocked';
  /** The application row that explains a refusal to an operator. */
  applicationStatus?: string;

  // ── The expected verdict. Declared, not derived. ──
  eligible: boolean;
  /** The single cause this provider must be attributed to when blocked. */
  primaryBlocker?: string;
  /** Non-blocking findings that must appear. */
  warnings?: string[];
}

/**
 * Twelve providers, one interesting combination each.
 *
 * Ordered by uid so the population query's ORDER BY is reproducible; the
 * ordering assertions below depend on it being fixed, not on what it is.
 */
const CAST: ProviderFixture[] = [
  {
    // The end state: a canonical row on the bookable service, and the legacy
    // family grant it was projected from.
    uid: 'p01-ideal', grant: 'CANONICAL_AND_LEGACY',
    eligible: true,
  },
  {
    // Canonical ONLY — an admin grant, or a legacy row since cleaned up. This
    // provider proves the canonical source can qualify somebody by itself,
    // which is the whole point of the migration.
    uid: 'p02-canonical-only', grant: 'CANONICAL',
    eligible: true,
  },
  {
    // LEGACY ONLY: the projection never ran for them. Assignable — removing
    // the fallback today would take their work away — and flagged, because the
    // canonical table should have answered and did not.
    uid: 'p02b-legacy-only', grant: 'APPROVED_APPLICATION',
    eligible: true, warnings: ['CAPABILITY_LEGACY_FALLBACK'],
  },
  {
    // Qualified only by a non-active grant. Offered, and flagged: the
    // executor would commit them, so hiding them re-creates the divergence.
    uid: 'p03-inactive-grant', grant: 'INACTIVE_EMPLOYEE_SERVICE',
    eligible: true, warnings: ['SERVICE_GRANT_INACTIVE', 'CAPABILITY_LEGACY_FALLBACK'],
  },
  {
    uid: 'p04-no-grant', grant: 'NONE', applicationStatus: 'pending_review',
    eligible: false, primaryBlocker: 'NO_ACTIVE_SERVICE',
  },
  {
    uid: 'p05-suspended', grant: 'CANONICAL_AND_LEGACY', accountStatus: 'suspended',
    eligible: false, primaryBlocker: 'ACCOUNT_INACTIVE',
  },
  {
    uid: 'p06-archived', grant: 'CANONICAL_AND_LEGACY', archived: true,
    eligible: false, primaryBlocker: 'ACCOUNT_ARCHIVED',
  },
  {
    uid: 'p07-not-activated', grant: 'CANONICAL_AND_LEGACY', activation: 'PENDING',
    eligible: false, primaryBlocker: 'PROVIDER_ACTIVATION_NOT_ACTIVE',
  },
  {
    uid: 'p08-day-off', grant: 'CANONICAL_AND_LEGACY', availability: 'DAY_NOT_AVAILABLE',
    eligible: false, primaryBlocker: 'DAY_NOT_AVAILABLE',
  },
  {
    uid: 'p09-time-off', grant: 'CANONICAL_AND_LEGACY', availability: 'TIME_OFF',
    eligible: false, primaryBlocker: 'TIME_OFF',
  },
  {
    uid: 'p10-busy', grant: 'CANONICAL_AND_LEGACY', availability: 'BOOKING_CONFLICT',
    eligible: false, primaryBlocker: 'BOOKING_CONFLICT',
  },
  {
    uid: 'p11-out-of-area', grant: 'CANONICAL_AND_LEGACY', area: 'CITY_NOT_IN_AREA',
    eligible: false, primaryBlocker: 'CITY_NOT_IN_AREA',
  },
  {
    // Compliance and availability BOTH fail. Attribution must pick the
    // account-wide cause, not the job-specific one.
    uid: 'p12-noncompliant', grant: 'CANONICAL_AND_LEGACY',
    compliance: 'blocked', availability: 'TIME_OFF',
    eligible: false, primaryBlocker: 'PROVIDER_COMPLIANCE_BLOCKED',
  },
];

/**
 * The cast the CURRENT scenario is running, which is not always the whole cast.
 *
 * A scenario may hand in a modified population — the same providers with one
 * attribute changed — and every per-provider query has to answer from THAT
 * version, or the scenario silently tests the default fixture instead.
 */
let activeCast: ProviderFixture[] = CAST;

const byUid = (uid: string): ProviderFixture => {
  const found = activeCast.find((p) => p.uid === uid) ?? CAST.find((p) => p.uid === uid);
  if (!found) throw new Error(`fixture asked about an unknown provider: ${uid}`);
  return found;
};

const grantsCapability = (p: ProviderFixture): boolean => p.grant !== 'NONE';

const hasCanonical = (p: ProviderFixture): boolean =>
  p.grant === 'CANONICAL' || p.grant === 'CANONICAL_AND_LEGACY';

const hasLegacyFamily = (p: ProviderFixture): boolean =>
  p.grant === 'CANONICAL_AND_LEGACY'
  || p.grant === 'ACTIVE_EMPLOYEE_SERVICE'
  || p.grant === 'INACTIVE_EMPLOYEE_SERVICE'
  || p.grant === 'APPROVED_APPLICATION';

// ─── Mounting the fixture ─────────────────────────────────────────────────────

interface Scenario {
  serviceId: number | null;
  /** Providers the population query returns, in order. Defaults to the cast. */
  population?: ProviderFixture[];
}

const mount = (scenario: Scenario) => {
  const population = scenario.population ?? CAST;
  activeCast = population;

  q.mockReset();
  q.mockImplementation((sql: string, params: any[] = []) => {
    const rows = (r: any[]) => Promise.resolve({ rows: r, rowCount: r.length });

    if (/FROM servana\.bookings b/.test(sql)) {
      return rows([{
        id: 1, schedule: '2026-09-07T02:00:00.000Z', branch_id: 'branch-1',
        status: 'AWAITING_ASSIGNMENT',
        canonical_service_id: scenario.serviceId,
        legacy_family_id: scenario.serviceId === SERVICE ? LEGACY_FAMILY : OTHER_LEGACY_FAMILY,
        duration_mins: 120,
      }]);
    }
    if (/AS capable/.test(sql)) {
      // The denominator, measured the way the canonical counter measures it:
      // capability for THIS service only, unfiltered by account state — and
      // split by source, which is the adoption measurement.
      const asked = Number(params[0]);
      const forThisService = asked === SERVICE;
      return rows([{
        capable: forThisService ? CAST.filter(grantsCapability).length : 0,
        canonical: forThisService ? CAST.filter(hasCanonical).length : 0,
        legacy_only: forThisService
          ? CAST.filter((p) => hasLegacyFamily(p) && !hasCanonical(p)).length
          : 0,
      }]);
    }
    if (/uc\.account_status = 'active'/.test(sql)) {
      // The population query already excludes suspended and archived accounts;
      // the fixture keeps them in to prove the per-provider stage catches them
      // too, since the two filters are separate code and can drift apart.
      return rows(population.map((p) => ({
        uid: p.uid, first_name: p.uid, last_name: 'Fixture',
        email: `${p.uid}@fixture.test`, phone_number: null, avatar_url: null,
      })));
    }
    if (/uc\.account_status, uc\.is_archive/.test(sql)) {
      const p = byUid(params[0]);
      return rows([{
        account_status: p.accountStatus ?? 'active',
        is_archive: p.archived ?? false,
        activation_status: p.activation ?? 'ACTIVE',
      }]);
    }
    if (/active_grant/.test(sql)) {
      const p = byUid(params[0]);
      return rows([{
        active_grant: p.grant === 'CANONICAL_AND_LEGACY' || p.grant === 'ACTIVE_EMPLOYEE_SERVICE',
        approved_application: p.grant === 'APPROVED_APPLICATION',
        canonical_grant: hasCanonical(p),
      }]);
    }
    if (/ORDER BY submitted_at/.test(sql)) {
      const p = byUid(params[0]);
      return rows(p.applicationStatus ? [{ status: p.applicationStatus }] : []);
    }
    if (/UNION ALL/.test(sql) && /employee_services/.test(sql)) {
      /**
       * The capability probe, answering per SOURCE.
       *
       * `$2` is the canonical service id and `$3` the legacy family, and each
       * source is matched against its own id space — the same separation the
       * real SQL makes. A fixture that answered from one id for both would hide
       * exactly the confusion this migration had to avoid.
       */
      const p = byUid(params[0]);
      const canonicalAsked = params[1] === null ? null : Number(params[1]);
      const familyAsked = params[2] === null ? null : Number(params[2]);

      const matched: Array<{ source: string }> = [];
      if (canonicalAsked === SERVICE && hasCanonical(p)) matched.push({ source: 'CANONICAL' });
      if (familyAsked === LEGACY_FAMILY) {
        if (p.grant === 'CANONICAL_AND_LEGACY' || p.grant === 'ACTIVE_EMPLOYEE_SERVICE'
            || p.grant === 'INACTIVE_EMPLOYEE_SERVICE') {
          matched.push({ source: 'LEGACY_EMPLOYEE_SERVICE' });
        }
        if (p.grant === 'APPROVED_APPLICATION') {
          matched.push({ source: 'LEGACY_APPROVED_APPLICATION' });
        }
      }
      return rows(matched);
    }
    if (/SELECT service_id FROM servana\.employee_services/.test(sql)) {
      return rows([{ service_id: SERVICE }]);
    }
    return rows([]);
  });

  (explainAvailability as jest.Mock).mockImplementation(async (uid: string) => {
    const state = byUid(uid).availability ?? 'AVAILABLE';
    if (state === 'AVAILABLE') return { providerUid: uid, available: true, reasons: [] };
    return {
      providerUid: uid,
      available: false,
      reasons: [{ code: state, severity: 'blocker', message: `fixture: ${state}` }],
    };
  });

  (explainCoverage as jest.Mock).mockImplementation(async (uid: string) => {
    const state = byUid(uid).area ?? 'COVERED';
    if (state === 'COVERED') return { providerUid: uid, covered: true, reasons: [] };
    return {
      providerUid: uid,
      covered: false,
      reasons: [{ code: state, severity: 'blocker', message: `fixture: ${state}` }],
    };
  });

  (calculateCompliance as jest.Mock).mockImplementation(async (uid: string) => ({
    state: byUid(uid).compliance ?? 'compliant',
  }));

  (evaluateServicePolicy as jest.Mock).mockImplementation(async () => ({
    eligible: true, code: 'OK', message: '',
  }));
};

const codesOf = (candidate: { reasons: ReadonlyArray<{ code: string }> }): string[] =>
  candidate.reasons.map((r) => r.code);

// ─── The golden table ─────────────────────────────────────────────────────────

describe('shadow matching over the fixture cast', () => {
  it('produces exactly the declared eligible set', async () => {
    /**
     * The headline assertion. A predicate that widens promotes a name into
     * this list; one that narrows drops a name out. Either way the diff names
     * the provider and the combination they stand for.
     */
    mount({ serviceId: SERVICE });
    const { candidates } = await listAssignmentCandidatePool('1');

    const eligible = candidates.filter((c) => c.eligible).map((c) => c.providerUid).sort();
    expect(eligible).toEqual(CAST.filter((p) => p.eligible).map((p) => p.uid).sort());
  });

  it.each(CAST.map((p) => [p.uid, p] as const))(
    '%s reaches its declared verdict',
    async (_uid, fixture) => {
      mount({ serviceId: SERVICE });
      const { candidates } = await listAssignmentCandidatePool('1');
      const candidate = candidates.find((c) => c.providerUid === fixture.uid)!;

      expect(candidate).toBeDefined();
      expect(candidate.eligible).toBe(fixture.eligible);

      if (fixture.primaryBlocker) {
        const blockers = candidate.reasons.filter((r) => r.severity === 'blocker');
        expect(blockers.map((r) => r.code)).toContain(fixture.primaryBlocker);
      }
      for (const warning of fixture.warnings ?? []) {
        expect(codesOf(candidate)).toContain(warning);
      }
    },
  );

  it('attributes a multiply-blocked provider to the most GENERAL true cause', async () => {
    // p12 fails compliance and is on time off. An operator sent to the
    // scheduling screen for an account-wide compliance block is sent to the
    // wrong screen.
    mount({ serviceId: SERVICE });
    const { diagnostics } = await listAssignmentCandidatePool('1');

    expect(diagnostics.primaryBlockers).toMatchObject({ PROVIDER_COMPLIANCE_BLOCKED: 1 });
    // And the job-specific cause is still visible, just not the attribution.
    expect(diagnostics.blockerOccurrences).toMatchObject({ TIME_OFF: 2 });
  });

  it('scores a flagged provider below a clean one', async () => {
    // The inactive-grant warning has to cost something, or it is decoration.
    mount({ serviceId: SERVICE });
    const { candidates } = await listAssignmentCandidatePool('1');

    const ideal = candidates.find((c) => c.providerUid === 'p01-ideal')!;
    const flagged = candidates.find((c) => c.providerUid === 'p03-inactive-grant')!;
    expect(flagged.score).toBeLessThan(ideal.score);
    expect(candidates.findIndex((c) => c.providerUid === 'p01-ideal'))
      .toBeLessThan(candidates.findIndex((c) => c.providerUid === 'p03-inactive-grant'));
  });

  it('diagnoses a healthy pool as healthy', async () => {
    mount({ serviceId: SERVICE });
    const { diagnostics } = await listAssignmentCandidatePool('1');

    expect(diagnostics).toMatchObject({
      serviceId: String(SERVICE),
      capabilityEvaluated: true,
      population: CAST.length,
      evaluated: CAST.length,
      truncated: false,
      eligible: 4,
      blocked: 9,
      zeroCandidateReason: null,
    });
    expect(diagnostics.supplyCollapse.suspected).toBe(false);
    expect(diagnostics.population).toBeLessThanOrEqual(CANDIDATE_POOL_CAP);
  });
});

// ─── The dimensions, moved one at a time ──────────────────────────────────────

describe('one dimension at a time', () => {
  /**
   * Each of these changes a SINGLE input and asserts that exactly one verdict
   * moves. A test that changes two things at once cannot tell which one did it,
   * and that is precisely the question asked when matching supply drops.
   */

  it('SERVICE: a booking for a service nobody holds empties the pool', async () => {
    mount({ serviceId: OTHER_SERVICE });
    const { candidates, diagnostics } = await listAssignmentCandidatePool('1');

    expect(candidates.filter((c) => c.eligible)).toEqual([]);

    /**
     * Everybody who was otherwise fine falls to NO_ACTIVE_SERVICE — and the
     * four providers with an account-wide problem KEEP it, because precedence
     * reports the most general true cause. That distinction is the point: an
     * archived account is not a capability gap, and an operator told otherwise
     * goes and approves a service for somebody who cannot work at all.
     */
    expect(diagnostics.primaryBlockers).toEqual({
      NO_ACTIVE_SERVICE: 9,
      ACCOUNT_INACTIVE: 1,
      ACCOUNT_ARCHIVED: 1,
      PROVIDER_ACTIVATION_NOT_ACTIVE: 1,
      PROVIDER_COMPLIANCE_BLOCKED: 1,
    });

    // And the pool is diagnosed as a catalog fact, not as an incident: zero
    // eligible out of zero capable is nobody's outage.
    expect(diagnostics.capable).toBe(0);
    expect(diagnostics.zeroCandidateReason).toBe('NO_PROVIDER_HAS_CAPABILITY');
    expect(diagnostics.supplyCollapse.suspected).toBe(false);
  });

  it('SERVICE: capable providers with nobody assignable IS an incident', async () => {
    /**
     * The other half of the same dimension, and the reason the denominator
     * exists. Same fixture, same service — but every provider who holds it is
     * blocked, so the identical empty list means something entirely different.
     */
    mount({
      serviceId: SERVICE,
      population: CAST.filter((p) => p.eligible).map((p) => ({ ...p, accountStatus: 'suspended' })),
    });
    const { diagnostics } = await listAssignmentCandidatePool('1');

    expect(diagnostics.eligible).toBe(0);
    expect(diagnostics.capable).toBeGreaterThan(0);
    expect(diagnostics.zeroCandidateReason).toBe('ALL_CANDIDATES_BLOCKED');
    expect(diagnostics.supplyCollapse.suspected).toBe(true);
    expect(diagnostics.dominantBlocker).toBe('ACCOUNT_INACTIVE');
  });

  it('LOCATION: coverage decides p11 and nobody else', async () => {
    mount({ serviceId: SERVICE });
    const withGap = await listAssignmentCandidatePool('1');

    // Now cover everybody, changing nothing else.
    (explainCoverage as jest.Mock).mockImplementation(async (uid: string) => ({
      providerUid: uid, covered: true, reasons: [],
    }));
    const covered = await listAssignmentCandidatePool('1');

    const eligibleOf = (r: Awaited<ReturnType<typeof listAssignmentCandidatePool>>) =>
      r.candidates.filter((c) => c.eligible).map((c) => c.providerUid).sort();

    expect(eligibleOf(covered)).toEqual([...eligibleOf(withGap), 'p11-out-of-area'].sort());
  });

  it('AVAILABILITY: the schedule decides p08, p09 and p10 and nobody else', async () => {
    mount({ serviceId: SERVICE });
    const withGaps = await listAssignmentCandidatePool('1');

    (explainAvailability as jest.Mock).mockImplementation(async (uid: string) => ({
      providerUid: uid, available: true, reasons: [],
    }));
    const allFree = await listAssignmentCandidatePool('1');

    const eligibleOf = (r: Awaited<ReturnType<typeof listAssignmentCandidatePool>>) =>
      r.candidates.filter((c) => c.eligible).map((c) => c.providerUid).sort();

    // p12 stays blocked: compliance is not an availability question.
    expect(eligibleOf(allFree)).toEqual(
      [...eligibleOf(withGaps), 'p08-day-off', 'p09-time-off', 'p10-busy'].sort(),
    );
    expect(eligibleOf(allFree)).not.toContain('p12-noncompliant');
  });
});

// ─── Properties the shadow must hold whatever the fixture says ────────────────

describe('the pipeline is deterministic', () => {
  it('gives the same answer twice for identical input', async () => {
    // Ranking ties are common in a small pool; a list that reorders between two
    // identical runs is a list an operator cannot compare against yesterday's.
    mount({ serviceId: SERVICE });
    const first = await listAssignmentCandidatePool('1');
    mount({ serviceId: SERVICE });
    const second = await listAssignmentCandidatePool('1');

    expect(second.candidates.map((c) => c.providerUid))
      .toEqual(first.candidates.map((c) => c.providerUid));
    expect(second.diagnostics).toEqual(first.diagnostics);
  });

  it('does not let population ORDER change who is eligible', async () => {
    /**
     * Eligibility is a property of the provider, not of where they landed in
     * the query. This is the guard that a cap or an early-exit has not been
     * added in a way that makes qualification depend on ordering — the exact
     * shape of the silent truncation the diagnostics exist to report.
     */
    mount({ serviceId: SERVICE });
    const forwards = await listAssignmentCandidatePool('1');

    mount({ serviceId: SERVICE, population: [...CAST].reverse() });
    const backwards = await listAssignmentCandidatePool('1');

    const eligible = (r: Awaited<ReturnType<typeof listAssignmentCandidatePool>>) =>
      r.candidates.filter((c) => c.eligible).map((c) => c.providerUid).sort();

    expect(eligible(backwards)).toEqual(eligible(forwards));
    expect(backwards.diagnostics.primaryBlockers).toEqual(forwards.diagnostics.primaryBlockers);
  });

  it('every blocked provider is attributed exactly once', async () => {
    mount({ serviceId: SERVICE });
    const { diagnostics } = await listAssignmentCandidatePool('1');

    const attributed = Object.values(diagnostics.primaryBlockers).reduce((a, b) => a + b, 0);
    expect(attributed).toBe(diagnostics.blocked);
    // Nothing denied without saying why.
    expect(diagnostics.primaryBlockers).not.toHaveProperty('UNATTRIBUTED_BLOCK');
  });
});
