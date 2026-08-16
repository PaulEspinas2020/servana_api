/**
 * "No providers available" must say WHY.
 *
 * The sentence is emitted identically when nobody holds the service, when
 * fourteen do and all are deactivated, and when the pool was capped before
 * anybody was evaluated. Those are a catalog fact, an incident, and a
 * measurement artefact, and an operator cannot act on any of them without
 * being told which one happened.
 *
 * Two halves are locked here:
 *
 *   1. the diagnosis itself — pure, arithmetic, no database;
 *   2. that the live candidate pool actually produces it, evaluated through
 *      the real engine with the database mocked, so the wiring is proven by
 *      behaviour rather than by reading the source.
 *
 * The second half also pins the capability correction: candidate generation
 * now asks the EXECUTOR's qualification question, so a provider the assign
 * call would accept can no longer be missing from the list that offers them.
 */

jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn() },
}));
jest.mock('../src/config', () => ({ db: { schema: 'servana' } }));

// Collaborators are mocked to their permissive answers: this suite is about
// pool arithmetic and capability, and a real availability or compliance
// evaluation would decide the outcome before those ever came into play.
jest.mock('../src/services/providerAvailabilityEngine', () => ({
  explainAvailability: jest.fn(async (providerUid: string) => ({
    providerUid, startAt: '', endAt: '', available: true, reasons: [],
  })),
}));
jest.mock('../src/services/providerServiceAreaEngine', () => ({
  explainCoverage: jest.fn(async (providerUid: string) => ({
    providerUid, covered: true, reasons: [],
  })),
}));
jest.mock('../src/services/providerProfileComplianceService', () => ({
  calculateCompliance: jest.fn(async () => ({ state: 'compliant' })),
}));
jest.mock('../src/services/providerServicePolicyService', () => ({
  evaluateServicePolicy: jest.fn(async () => ({ eligible: true, code: 'OK', message: '' })),
}));

import dbQuery from '../src/db/dbQuery';
import fs from 'fs';
import path from 'path';

import {
  summariseCandidatePool,
  primaryBlockerOf,
  auditSummaryOf,
  ZERO_CANDIDATE_REASONS,
  ZERO_CANDIDATE_REASON_CODES,
  BLOCKER_PRECEDENCE,
  type DiagnosableCandidate,
} from '../src/services/booking/candidateDiagnostics';
import {
  CAPABLE_PROVIDER_COUNT_SQL,
  CAPABILITY_GRANT_EXISTS_SQL,
  PROVIDER_CAPABILITY_SQL,
} from '../src/services/booking/eligibilityPipeline';
import {
  listAssignmentCandidatePool,
  listAssignmentCandidates,
  CANDIDATE_POOL_CAP,
} from '../src/services/providerEligibilityEngine';

const q = dbQuery.query as jest.Mock;

const blocker = (code: string) => ({ code, severity: 'blocker' });
const warning = (code: string) => ({ code, severity: 'warning' });

const candidate = (eligible: boolean, ...reasons: Array<{ code: string; severity: string }>):
  DiagnosableCandidate => ({ eligible, reasons });

// ─── 1. The reason vocabulary ─────────────────────────────────────────────────

describe('the zero-candidate reasons are declared, not improvised', () => {
  it('has a unique code, an operator message and an action for each', () => {
    const codes = ZERO_CANDIDATE_REASONS.map((r) => r.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const reason of ZERO_CANDIDATE_REASONS) {
      // A code with no message is a code that reaches an operator as a token.
      expect(reason.operatorMessage.length).toBeGreaterThan(30);
      expect(reason.actionable.length).toBeGreaterThan(10);
    }
  });

  it('orders them from "nothing to work with" to "something is wrong"', () => {
    /**
     * The order is load-bearing: the first matching reason is the one
     * reported, and an earlier code makes a later one unanswerable. With no
     * canonical service the capability count is not zero, it is meaningless.
     */
    expect(ZERO_CANDIDATE_REASON_CODES).toEqual([
      'BOOKING_HAS_NO_SERVICE',
      'NO_PROVIDER_POPULATION',
      'NO_PROVIDER_HAS_CAPABILITY',
      'POOL_TRUNCATED_BEFORE_EVALUATION',
      'ALL_CANDIDATES_BLOCKED',
    ]);
  });

  it('the blocker precedence runs from account-wide to job-specific', () => {
    // So the dominant cause reported is the most general TRUE one: an archived
    // account attributed to OUTSIDE_SCHEDULE_WINDOW sends an operator to the
    // wrong screen.
    expect(BLOCKER_PRECEDENCE.indexOf('ACCOUNT_INACTIVE'))
      .toBeLessThan(BLOCKER_PRECEDENCE.indexOf('NO_ACTIVE_SERVICE'));
    expect(BLOCKER_PRECEDENCE.indexOf('NO_ACTIVE_SERVICE'))
      .toBeLessThan(BLOCKER_PRECEDENCE.indexOf('BOOKING_CONFLICT'));
    expect(new Set(BLOCKER_PRECEDENCE).size).toBe(BLOCKER_PRECEDENCE.length);
  });
});

// ─── 2. Attribution ───────────────────────────────────────────────────────────

describe('each blocked provider is attributed to ONE cause', () => {
  it('picks the earliest blocker in precedence, not the first emitted', () => {
    const c = candidate(false, blocker('BOOKING_CONFLICT'), blocker('ACCOUNT_ARCHIVED'));
    expect(primaryBlockerOf(c)).toBe('ACCOUNT_ARCHIVED');
  });

  it('ignores warnings and info when attributing', () => {
    const c = candidate(false, warning('SERVICE_GRANT_INACTIVE'), blocker('TIME_OFF'));
    expect(primaryBlockerOf(c)).toBe('TIME_OFF');
  });

  it('keeps an unknown blocker rather than dropping it', () => {
    // A code this module has never heard of is exactly the one worth seeing.
    expect(primaryBlockerOf(candidate(false, blocker('SOMETHING_NEW')))).toBe('SOMETHING_NEW');
  });

  it('names an ineligible provider that gave no reason', () => {
    const d = summariseCandidatePool({
      serviceId: '55', population: 1, cap: null, capable: 1,
      candidates: [candidate(false)],
    });
    // Denied without saying why is itself the defect; it must not vanish from
    // the histogram, which would make the counts stop adding up.
    expect(d.primaryBlockers).toEqual({ UNATTRIBUTED_BLOCK: 1 });
  });

  it('the primary histogram sums to the blocked count', () => {
    const d = summariseCandidatePool({
      serviceId: '55', population: 3, cap: null, capable: 3,
      candidates: [
        candidate(false, blocker('ACCOUNT_INACTIVE'), blocker('TIME_OFF')),
        candidate(false, blocker('TIME_OFF')),
        candidate(true),
      ],
    });
    const total = Object.values(d.primaryBlockers).reduce((a, b) => a + b, 0);
    expect(total).toBe(d.blocked);
    expect(d.primaryBlockers).toEqual({ ACCOUNT_INACTIVE: 1, TIME_OFF: 1 });
    // Occurrences count every blocker, so they legitimately sum higher.
    expect(d.blockerOccurrences).toEqual({ ACCOUNT_INACTIVE: 1, TIME_OFF: 2 });
  });

  it('breaks a tie deterministically', () => {
    // Small pools tie constantly, and a summary that reorders between two
    // identical runs is a summary nobody trusts.
    const input = {
      serviceId: '55', population: 2, cap: null, capable: 2,
      candidates: [candidate(false, blocker('TIME_OFF')), candidate(false, blocker('ACCOUNT_INACTIVE'))],
    };
    expect(summariseCandidatePool(input).dominantBlocker).toBe('ACCOUNT_INACTIVE');
    expect(summariseCandidatePool({ ...input, candidates: [...input.candidates].reverse() })
      .dominantBlocker).toBe('ACCOUNT_INACTIVE');
  });
});

// ─── 3. The zero-candidate diagnosis ──────────────────────────────────────────

describe('an empty pool names the stage that emptied it', () => {
  const base = {
    serviceId: '55' as string | null,
    population: 5,
    cap: null,
    capable: 5 as number | null,
    candidates: [candidate(false, blocker('TIME_OFF'))],
  };

  it('reports nothing when somebody is eligible', () => {
    const d = summariseCandidatePool({ ...base, candidates: [candidate(true)] });
    expect(d.zeroCandidateReason).toBeNull();
    expect(d.zeroCandidateMessage).toBeNull();
    expect(d.supplyCollapse.suspected).toBe(false);
  });

  it('a booking with no canonical service cannot be diagnosed further', () => {
    const d = summariseCandidatePool({ ...base, serviceId: null });
    expect(d.zeroCandidateReason).toBe('BOOKING_HAS_NO_SERVICE');
  });

  it('an empty population is not a per-provider block', () => {
    const d = summariseCandidatePool({ ...base, serviceId: '55', population: 0, candidates: [] });
    expect(d.zeroCandidateReason).toBe('NO_PROVIDER_POPULATION');
  });

  it('nobody holding the service is a catalog fact, not an incident', () => {
    const d = summariseCandidatePool({ ...base, serviceId: '55', capable: 0 });
    expect(d.zeroCandidateReason).toBe('NO_PROVIDER_HAS_CAPABILITY');
    expect(d.supplyCollapse.suspected).toBe(false);
  });

  it('a capped pool is reported as capped, not as zero supply', () => {
    // THE silent failure: the providers who could do this job may simply sort
    // after the cap. Reading that as "no supply" is how a supply collapse hides.
    const d = summariseCandidatePool({
      serviceId: '55', population: 25, cap: 20, capable: 14,
      candidates: Array.from({ length: 20 }, () => candidate(false, blocker('ACCOUNT_INACTIVE'))),
    });
    expect(d.truncated).toBe(true);
    expect(d.evaluated).toBe(20);
    expect(d.zeroCandidateReason).toBe('POOL_TRUNCATED_BEFORE_EVALUATION');
  });

  it('otherwise names the dominant blocker', () => {
    const d = summariseCandidatePool({
      serviceId: '55', population: 3, cap: 20, capable: 3,
      candidates: [
        candidate(false, blocker('TIME_OFF')),
        candidate(false, blocker('TIME_OFF')),
        candidate(false, blocker('BOOKING_CONFLICT')),
      ],
    });
    expect(d.zeroCandidateReason).toBe('ALL_CANDIDATES_BLOCKED');
    expect(d.dominantBlocker).toBe('TIME_OFF');
    expect(d.zeroCandidateMessage).toContain('blocked');
  });
});

describe('supply collapse is a claim, and needs a denominator', () => {
  it('is raised when capable providers exist and none are assignable', () => {
    const d = summariseCandidatePool({
      serviceId: '55', population: 14, cap: 20, capable: 14,
      candidates: Array.from({ length: 14 }, () => candidate(false, blocker('PROVIDER_ACTIVATION_NOT_ACTIVE'))),
    });
    expect(d.supplyCollapse.suspected).toBe(true);
    expect(d.supplyCollapse.detail).toContain('14 provider(s) hold this service');
    expect(d.supplyCollapse.detail).toContain('PROVIDER_ACTIVATION_NOT_ACTIVE');
  });

  it('is NOT raised when the denominator was not measured', () => {
    /**
     * `capable: null` means the count failed. Claiming a collapse from an
     * unmeasured denominator manufactures the outage the flag exists to
     * detect — and claiming health from it hides a real one. Neither: no claim.
     */
    const d = summariseCandidatePool({
      serviceId: '55', population: 3, cap: 20, capable: null,
      candidates: [candidate(false, blocker('TIME_OFF'))],
    });
    expect(d.supplyCollapse.suspected).toBe(false);
    expect(d.supplyCollapse.detail).toBeNull();
    expect(d.capable).toBeNull();
    // The pool is still diagnosed — only the supply CLAIM is withheld.
    expect(d.zeroCandidateReason).toBe('ALL_CANDIDATES_BLOCKED');
  });

  it('is not raised merely because the pool was capped', () => {
    // Truncation distorts the count too, but `truncated`/`cap`/`population`
    // already state it. Folding it in would make one flag mean two things.
    const d = summariseCandidatePool({
      serviceId: '55', population: 25, cap: 20, capable: 25,
      candidates: [candidate(true), ...Array.from({ length: 19 }, () => candidate(false, blocker('TIME_OFF')))],
    });
    expect(d.truncated).toBe(true);
    expect(d.supplyCollapse.suspected).toBe(false);
  });
});

describe('the audit summary', () => {
  it('carries the numbers needed to reconstruct the pool, and no provider list', () => {
    const d = summariseCandidatePool({
      serviceId: '55', population: 4, cap: 20, capable: 4,
      candidates: [candidate(true), candidate(false, blocker('TIME_OFF'))],
    });
    const summary = auditSummaryOf(d);
    expect(summary).toMatchObject({
      serviceId: '55', population: 4, evaluated: 2, truncated: false,
      capable: 4, eligibleCount: 1, blockedCount: 1,
      dominantBlocker: 'TIME_OFF', zeroCandidateReason: null,
      supplyCollapseSuspected: false,
    });
    // Per-provider detail belongs in the response, not in every audit row.
    expect(JSON.stringify(summary)).not.toContain('primaryBlockers');
  });
});

// ─── 4. The live pool produces the diagnosis ──────────────────────────────────

/** The legacy family every fixture booking's service belongs to. */
const LEGACY_FAMILY = 7;

interface PoolFixture {
  serviceId: number | null;
  providers: string[];
  capable?: number | 'error';
  capableCanonical?: number;
  capableLegacyOnly?: number;
  accountRow?: (uid: string) => Record<string, unknown> | null;
  capabilityRows?: (uid: string) => unknown[];
  activeGrant?: (uid: string) =>
    { active_grant: boolean; approved_application: boolean; canonical_grant: boolean } | 'error';
  applicationStatus?: string | null;
}

/** Routes the engine's own queries. Everything unrecognised answers empty. */
const mountPool = (f: PoolFixture) => {
  q.mockReset();
  q.mockImplementation((sql: string, params: any[] = []) => {
    const rows = (r: any[]) => Promise.resolve({ rows: r, rowCount: r.length });

    if (/FROM servana\.bookings b/.test(sql)) {
      // Two id spaces: the canonical `services.id` the canonical table keys on,
      // and the legacy family the fallback keys on. The fixture keeps them
      // distinct so a predicate that confused them would fail here.
      return rows([{
        id: 1, schedule: '2026-09-01T10:00:00.000Z', branch_id: null,
        status: 'AWAITING_ASSIGNMENT',
        canonical_service_id: f.serviceId,
        legacy_family_id: f.serviceId === null ? null : LEGACY_FAMILY,
        duration_mins: 120,
      }]);
    }
    if (/AS capable/.test(sql)) {
      if (f.capable === 'error') return Promise.reject(new Error('capability count failed'));
      const capable = f.capable ?? f.providers.length;
      return rows([{
        capable,
        canonical: f.capableCanonical ?? capable,
        legacy_only: f.capableLegacyOnly ?? 0,
      }]);
    }
    if (/uc\.account_status = 'active'/.test(sql)) {
      return rows(f.providers.map((uid, i) => ({
        uid, first_name: `P${i}`, last_name: 'X', email: `${uid}@x.test`,
        phone_number: null, avatar_url: null,
      })));
    }
    if (/uc\.account_status, uc\.is_archive/.test(sql)) {
      const row = f.accountRow
        ? f.accountRow(params[0])
        : { account_status: 'active', is_archive: false, activation_status: 'ACTIVE' };
      return rows(row ? [row] : []);
    }
    if (/active_grant/.test(sql)) {
      const grant = f.activeGrant
        ? f.activeGrant(params[0])
        : { active_grant: true, approved_application: true, canonical_grant: true };
      if (grant === 'error') return Promise.reject(new Error('employee_services.status absent'));
      return rows([grant]);
    }
    if (/ORDER BY submitted_at/.test(sql)) {
      return rows(f.applicationStatus ? [{ status: f.applicationStatus }] : []);
    }
    if (/UNION ALL/.test(sql) && /employee_services/.test(sql)) {
      // Rows now carry the SOURCE that matched, which is what lets the engine
      // tell "the canonical table said so" from "only the legacy grant did".
      return rows(f.capabilityRows ? f.capabilityRows(params[0]) : [{ source: 'CANONICAL' }]);
    }
    if (/SELECT service_id FROM servana\.employee_services/.test(sql)) {
      return rows([{ service_id: f.serviceId }]);
    }
    return rows([]);
  });
};

describe('the live candidate pool', () => {
  it('reports the cap it applied instead of applying it silently', async () => {
    mountPool({ serviceId: 55, providers: ['p0', 'p1'], capable: 2 });
    const { candidates, diagnostics } = await listAssignmentCandidatePool('1');

    expect(candidates.length).toBeLessThanOrEqual(CANDIDATE_POOL_CAP);
    expect(diagnostics.cap).toBe(CANDIDATE_POOL_CAP);
    expect(diagnostics.truncated).toBe(false);
  });

  it('publishes population, evaluated and capable for a truncated pool', async () => {
    mountPool({
      serviceId: 55,
      providers: Array.from({ length: 25 }, (_, i) => `p${i}`),
      capable: 14,
      accountRow: () => ({ account_status: 'suspended', is_archive: false, activation_status: 'ACTIVE' }),
    });
    const { candidates, diagnostics } = await listAssignmentCandidatePool('1');

    expect(candidates).toHaveLength(CANDIDATE_POOL_CAP);
    expect(diagnostics.population).toBe(25);
    expect(diagnostics.evaluated).toBe(CANDIDATE_POOL_CAP);
    expect(diagnostics.truncated).toBe(true);
    expect(diagnostics.capable).toBe(14);
    expect(diagnostics.eligible).toBe(0);
    expect(diagnostics.zeroCandidateReason).toBe('POOL_TRUNCATED_BEFORE_EVALUATION');
    expect(diagnostics.dominantBlocker).toBe('ACCOUNT_INACTIVE');
    expect(diagnostics.supplyCollapse.suspected).toBe(true);
  });

  it('distinguishes an empty catalog from a collapsed one', async () => {
    mountPool({
      serviceId: 55, providers: ['p0', 'p1'], capable: 0,
      capabilityRows: () => [],
    });
    const { diagnostics } = await listAssignmentCandidatePool('1');
    expect(diagnostics.zeroCandidateReason).toBe('NO_PROVIDER_HAS_CAPABILITY');
    expect(diagnostics.supplyCollapse.suspected).toBe(false);
  });

  it('reports a failed capability count as unmeasured, never as zero', async () => {
    // A broken count reading as "nobody holds this service" would fabricate an
    // outage; reading as healthy would hide one.
    mountPool({
      serviceId: 55, providers: ['p0'], capable: 'error',
      capabilityRows: () => [],
    });
    const { diagnostics } = await listAssignmentCandidatePool('1');
    expect(diagnostics.capable).toBeNull();
    expect(diagnostics.zeroCandidateReason).toBe('ALL_CANDIDATES_BLOCKED');
    expect(diagnostics.supplyCollapse.suspected).toBe(false);
  });

  it('says when capability was never part of the evaluation', async () => {
    /**
     * A booking with no canonical service produces a FULL list of confident
     * candidates that nobody checked for capability — a more dangerous pool
     * than an empty one, and indistinguishable from a healthy one by count.
     * So this is flagged whether or not the pool came back empty.
     */
    mountPool({ serviceId: null, providers: ['p0'], capable: 0 });
    const { candidates, diagnostics } = await listAssignmentCandidatePool('1');
    expect(diagnostics.serviceId).toBeNull();
    expect(diagnostics.capabilityEvaluated).toBe(false);
    expect(candidates[0].eligible).toBe(true);
    // Nothing was capability-blocked, so there is no zero-candidate reason to
    // report; the flag above is what tells an operator the list is unverified.
    expect(diagnostics.zeroCandidateReason).toBeNull();
  });

  it('names the missing service when such a pool IS empty', async () => {
    mountPool({
      serviceId: null, providers: ['p0'], capable: 0,
      accountRow: () => ({ account_status: 'suspended', is_archive: false, activation_status: 'ACTIVE' }),
    });
    const { diagnostics } = await listAssignmentCandidatePool('1');
    expect(diagnostics.zeroCandidateReason).toBe('BOOKING_HAS_NO_SERVICE');
  });

  it('keeps the array-returning entry point describing the same pool', async () => {
    mountPool({ serviceId: 55, providers: ['p0', 'p1'], capable: 2 });
    const list = await listAssignmentCandidates('1');
    mountPool({ serviceId: 55, providers: ['p0', 'p1'], capable: 2 });
    const { candidates } = await listAssignmentCandidatePool('1');
    expect(list.map((c) => c.providerUid)).toEqual(candidates.map((c) => c.providerUid));
  });
});

describe('candidate generation asks the executor’s capability question', () => {
  it('offers a provider qualified ONLY by an approved application', async () => {
    /**
     * The measured defect: the preview asked employee_services with an active
     * status and nothing else, so a provider whose approval had not been
     * mirrored into that table was assignable by the executor and invisible in
     * the list that offers them. A narrower preview does not fail safe.
     */
    mountPool({
      serviceId: 55, providers: ['p0'], capable: 1,
      capabilityRows: () => [{ source: 'CANONICAL' }],
      activeGrant: () => ({ active_grant: false, approved_application: true, canonical_grant: false }),
    });
    const { candidates } = await listAssignmentCandidatePool('1');
    expect(candidates[0].eligible).toBe(true);
    expect(candidates[0].checks.hasActiveService).toBe(true);
    expect(candidates[0].reasons.map((r) => r.code)).not.toContain('NO_ACTIVE_SERVICE');
  });

  it('offers a provider whose only grant is inactive, but flags it', async () => {
    // The executor would commit them, so hiding them re-creates the divergence.
    // The warning costs them rank instead of eligibility.
    mountPool({
      serviceId: 55, providers: ['p0'], capable: 1,
      // No canonical row either, so the inactive legacy grant is the ONLY thing
      // qualifying them — which is what the warning is about.
      activeGrant: () => ({ active_grant: false, approved_application: false, canonical_grant: false }),
    });
    const { candidates } = await listAssignmentCandidatePool('1');
    expect(candidates[0].eligible).toBe(true);
    expect(candidates[0].reasons.map((r) => r.code)).toContain('SERVICE_GRANT_INACTIVE');
    expect(candidates[0].score).toBeLessThan(100);
  });

  it('claims nothing about the grant when the status column is absent', async () => {
    // employee_services.status is created by lazy DDL. A failed probe means
    // "cannot tell", which is not a finding.
    mountPool({
      serviceId: 55, providers: ['p0'], capable: 1,
      activeGrant: () => 'error',
    });
    const { candidates } = await listAssignmentCandidatePool('1');
    expect(candidates[0].eligible).toBe(true);
    expect(candidates[0].reasons.map((r) => r.code)).not.toContain('SERVICE_GRANT_INACTIVE');
  });

  it('still blocks a provider with no grant at all, with an actionable reason', async () => {
    mountPool({
      serviceId: 55, providers: ['p0'], capable: 1,
      capabilityRows: () => [],
      applicationStatus: 'pending_review',
    });
    const { candidates } = await listAssignmentCandidatePool('1');
    expect(candidates[0].eligible).toBe(false);
    const reason = candidates[0].reasons.find((r) => r.code === 'NO_ACTIVE_SERVICE');
    expect(reason?.message).toContain('pending review');
  });
});

// ─── 5. Wiring that behaviour cannot prove ────────────────────────────────────

const SRC = path.join(__dirname, '..', 'src');
const codeOf = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8')
  .replace(/\r\n/g, '\n')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

describe('the pool is generated from the shared declarations', () => {
  const engine = codeOf('services/providerEligibilityEngine.ts');

  it('uses the executor’s capability predicate rather than a local one', () => {
    expect(engine).toContain('PROVIDER_CAPABILITY_SQL(s)');
    // The narrower local query that DECIDED qualification is gone, not merely
    // bypassed. Two raw reads of that table remain and are pinned so a third
    // cannot reappear as a qualification decision: the inactive-grant WARNING
    // probe (proven non-deciding by the probe-failure case above), and the
    // display list of a candidate's services.
    expect(engine.match(/\$\{s\}\.employee_services/g)).toHaveLength(2);
    // And the canonical table is consulted in the same probe, so an inactive
    // legacy grant cannot outrank a live canonical row.
    expect(engine).toContain('canonical_grant');
    expect(engine).toContain('active_grant');
    expect(engine).toContain('SELECT service_id FROM ${s}.employee_services');
  });

  it('counts capability supply with the canonical counter', () => {
    expect(engine).toContain('CAPABLE_PROVIDER_COUNT_SQL(s)');
  });

  it('names its cap instead of hard-coding a slice', () => {
    expect(engine).toContain('slice(0, CANDIDATE_POOL_CAP)');
    expect(engine).not.toContain('slice(0, 20)');
  });

  it('does not re-inline the provider role list', () => {
    expect(engine).not.toMatch(/role::int IN \(2, 4\)/);
    expect(engine).toContain("providerRoleSqlPredicate('uc.role')");
  });
});

describe('the diagnosis reaches the routes additively', () => {
  const adminBooking = codeOf('controllers/adminBookingController.ts');
  const availability = codeOf('controllers/adminProviderAvailabilityController.ts');

  it('leaves `data` the array live Admin clients already parse', () => {
    // Shared surfaces move additively until every client has migrated.
    expect(adminBooking).toContain("data: candidates, diagnostics");
    expect(availability).toContain('ok(res, candidates, { diagnostics })');
  });

  it('records the pool shape in the audit trail, not just its size', () => {
    expect(adminBooking).toContain('auditSummaryOf(diagnostics)');
  });

  it('both candidate routes read the same pool', () => {
    expect(adminBooking).toContain('listAssignmentCandidatePool');
    expect(availability).toContain('listAssignmentCandidatePool');
  });
});

describe('the capability counter', () => {
  const sql = CAPABLE_PROVIDER_COUNT_SQL('servana');

  it('names every grant source, from the same declaration as the row probe', () => {
    for (const fragment of [
      'catalog_provider_services', 'employee_services',
      'worker_service_applications', "status = 'approved'",
    ]) {
      expect(sql).toContain(fragment);
      expect(PROVIDER_CAPABILITY_SQL('servana')).toContain(fragment);
    }
  });

  it('measures SUPPLY, so it does not filter account state', () => {
    /**
     * Deliberate. "Capable but all deactivated" must report as a collapse with
     * an attributable cause, not as an empty catalog — and it cannot if the
     * denominator is filtered by the same conditions as the numerator.
     */
    expect(sql).not.toContain('account_status');
    expect(sql).not.toContain('activation_status');
    // Archived accounts ARE excluded: an archived account is not supply.
    expect(sql).toContain('uc.is_archive = false');
    expect(sql).toContain('role::int IN (2, 4)');
  });

  it('interpolates only caller-controlled SQL, never a request value', () => {
    // All three expression arguments are column references or placeholders; the
    // service ids travel as $1 and $2.
    expect(CAPABILITY_GRANT_EXISTS_SQL('servana', 'uc.uid', '$1', '$2')).toContain('$1');
    expect(sql).toContain('$1');
    expect(sql).toContain('$2');
  });
});
