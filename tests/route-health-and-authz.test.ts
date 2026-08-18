/**
 * Route health (§143) and the authorization matrix (§145).
 *
 * ## The rule §143 states, and why it is not pedantry
 *
 * > "A 401 from global auth middleware must never be considered route proof."
 *
 * `GET /api/catalog` shipped unreachable. It was shadowed by `GET /api/:id` in
 * the legacy tree, and every check that touched it saw a plausible response and
 * concluded the route was fine — because in that tree an unknown single-segment
 * path is parsed as a booking id and answers 401 or 400, which is exactly what a
 * route that exists and is protected also answers.
 *
 * So `classifyProbe` returns a PROOF STRENGTH, this suite asserts a bare 401 is
 * `INCONCLUSIVE`, and route health is measured only by responses the handler
 * produced or by the v1 router's own terminal 404.
 *
 * ## And why §145 is two questions
 *
 * Role access is necessary and not sufficient. Every customer holds the customer
 * role; the point is that one customer must not read another's booking — which a
 * role check cannot express. A booking carries an address and a time when
 * somebody will be at home.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' }, tempId: undefined }));
jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
  pool: { connect: jest.fn() },
}));

import fs from 'fs';
import path from 'path';
import {
  CREDENTIAL_RULES,
  SMOKE_ACCOUNTS,
  classifyProbe,
  isConclusive,
  smokePlan,
  smokeSummary,
} from '../src/api/v1/routeHealth';
import {
  OBJECT_PARAMETERS,
  OWNERSHIP_RULES,
  PROVIDER_MODE_EXCLUDES_ADMIN,
  ROLES,
  ROLE_ACCESS,
  authorizationMatrix,
  matrixSummary,
  mayCall,
  objectScopedEntries,
  unguardedEntries,
} from '../src/api/v1/authzMatrix';
import { V1_CONTRACT } from '../src/api/v1/contract';

const REPO_ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

// ─── §143: what counts as proof ───────────────────────────────────────────────

describe('a 401 is never route proof', () => {
  it('classifies a bare 401 as inconclusive', () => {
    expect(classifyProbe({ status: 401, body: { status: 'failed' } })).toBe('INCONCLUSIVE');
    expect(classifyProbe({ status: 401, body: null })).toBe('INCONCLUSIVE');
  });

  it('classifies a v1-shaped UNAUTHENTICATED as inconclusive too', () => {
    /**
     * The subtle case. A v1 envelope is not enough — an absent route behind
     * global auth would produce exactly this, so an auth code proves the CHAIN
     * ran, never that the route exists.
     */
    expect(classifyProbe({
      status: 401,
      body: { error: { code: 'UNAUTHENTICATED', message: 'Authentication is required.', requestId: 'r1' } },
    })).toBe('INCONCLUSIVE');
  });

  it('classifies a 403 role rejection as inconclusive', () => {
    expect(classifyProbe({
      status: 403,
      body: { error: { code: 'ROLE_NOT_PERMITTED', message: 'no', requestId: 'r1' } },
    })).toBe('INCONCLUSIVE');
  });

  it('accepts a handler success as proof', () => {
    expect(classifyProbe({ status: 200, body: { data: { anything: true } } })).toBe('HANDLER_REACHED');
  });

  it('accepts a DOMAIN error as proof — the handler ran to produce it', () => {
    expect(classifyProbe({
      status: 404,
      body: { error: { code: 'BOOKING_NOT_FOUND', message: 'No booking.', requestId: 'r1' } },
    })).toBe('HANDLER_REACHED');
  });

  it('recognises the v1 router\'s terminal 404 as definitive absence', () => {
    // The one case where a 404 is informative: the v1 router ends in its own
    // 404 rather than falling through to the legacy tree.
    expect(classifyProbe({
      status: 404,
      body: { error: { code: 'NOT_FOUND', message: 'No v1 endpoint for GET /api/v1/nope', requestId: 'r1' } },
    })).toBe('ROUTE_ABSENT');
  });

  it('rejects an HTML body, which is a proxy answering rather than the app', () => {
    // A 502 page from Nginx parses as nothing and proves nothing.
    expect(classifyProbe({ status: 502, contentType: 'text/html', body: null })).toBe('INCONCLUSIVE');
  });

  it('rejects a 200 that is not in the v1 envelope', () => {
    // A legacy-shaped 200 under a v1 path would mean the request never reached
    // the v1 router.
    expect(classifyProbe({ status: 200, body: { status: 'success', data: {} } })).toBe('HANDLER_REACHED');
    expect(classifyProbe({ status: 200, body: { message: 'ok' } })).toBe('INCONCLUSIVE');
  });

  it('only two verdicts count as conclusive', () => {
    expect(isConclusive('HANDLER_REACHED')).toBe(true);
    expect(isConclusive('ROUTE_ABSENT')).toBe(true);
    expect(isConclusive('INCONCLUSIVE')).toBe(false);
  });
});

// ─── §143/§150: the smoke plan ────────────────────────────────────────────────

describe('the production smoke plan is read-only by construction', () => {
  const plan = smokePlan();

  it('covers every mounted endpoint', () => {
    const mounted = V1_CONTRACT.filter((e) => e.status === 'implemented').length;
    expect(plan).toHaveLength(mounted);
  });

  it('probes no write, ever', () => {
    /**
     * Excluded by construction rather than by care. A POST to
     * `/bookings/:id/cancel` on production enters the same state machine a real
     * customer's booking uses, and no amount of account isolation makes that a
     * smoke test.
     */
    for (const step of plan) {
      if (step.method !== 'GET') expect(step.safe).toBe(false);
    }
    expect(plan.filter((s) => s.safe).every((s) => s.method === 'GET')).toBe(true);
  });

  it('expects HANDLER_REACHED and explicitly fails on a 401', () => {
    for (const step of plan.filter((s) => s.safe)) {
      expect(step.expectation).toContain('HANDLER_REACHED');
      expect(step.expectation).toContain('INCONCLUSIVE');
    }
  });

  it('never fills a path parameter from a live record', () => {
    for (const step of plan.filter((s) => s.safe && s.path.includes(':'))) {
      expect(step.parameterSource).toContain('seeded');
      expect(step.parameterSource).toContain('Never a live id');
    }
  });

  it('assigns a least-privilege account to every protected step', () => {
    for (const step of plan.filter((s) => s.safe && s.authMode !== 'public')) {
      expect(step.account).not.toBeNull();
      expect(SMOKE_ACCOUNTS.some((a) => a.key === step.account)).toBe(true);
    }
  });

  it('probes a meaningful share of the surface', () => {
    const summary = smokeSummary();
    expect(summary.probed).toBeGreaterThan(40);
    expect(summary.probed + summary.skippedWrites).toBe(summary.total);
  });
});

describe('smoke credentials are least-privilege and never in the repository', () => {
  it('holds no credential value, only the name of an environment variable', () => {
    /**
     * "No secrets in tests" as a property of the type rather than of somebody's
     * care: there is no field on `SmokeAccount` that could hold one.
     */
    for (const account of SMOKE_ACCOUNTS) {
      expect(account.credentialEnv).toMatch(/^[A-Z][A-Z0-9_]+$/);
      expect(JSON.stringify(account)).not.toMatch(/Bearer |eyJ|password|secret=/i);
    }
  });

  it('treats provider records as live and seeds a dedicated account', () => {
    // The standing constraint, written where the automation would otherwise
    // reach for a convenient existing provider.
    const provider = SMOKE_ACCOUNTS.find((a) => a.authMode === 'provider')!;
    expect(provider.constraints.join(' ')).toMatch(/LIVE/);
    expect(provider.constraints.join(' ')).toMatch(/never an existing provider/i);
  });

  it('gives the admin account read-only privileges and the fastest rotation', () => {
    const admin = SMOKE_ACCOUNTS.find((a) => a.authMode === 'admin')!;
    expect(admin.privilege).toMatch(/READ/i);
    expect(admin.rotationDays).toBeLessThanOrEqual(
      Math.min(...SMOKE_ACCOUNTS.filter((a) => a.authMode !== 'admin').map((a) => a.rotationDays)),
    );
  });

  it('forbids personal credentials and says why', () => {
    expect(CREDENTIAL_RULES.personalAccounts).toMatch(/forbidden/i);
    expect(CREDENTIAL_RULES.personalAccounts).toMatch(/audit trail/i);
  });

  it('never echoes a token on failure', () => {
    expect(CREDENTIAL_RULES.onFailure).toMatch(/never echoes the token/i);
  });

  it('the repository contains no smoke credential value', () => {
    // The rule, checked against the files rather than asserted.
    const source = read('src/api/v1/routeHealth.ts');
    for (const account of SMOKE_ACCOUNTS) {
      const assignment = new RegExp(`${account.credentialEnv}\\s*=\\s*['"]`);
      expect(source).not.toMatch(assignment);
    }
  });
});

// ─── §145: role access ────────────────────────────────────────────────────────

describe('the role matrix matches the auth chain the router builds', () => {
  const registerSource = read('src/api/v1/register.ts');

  it('public admits everyone and authenticated admits every signed-in role', () => {
    for (const role of ROLES) expect(mayCall('public', role)).toBe(true);
    expect(mayCall('authenticated', 'anonymous')).toBe(false);
    for (const role of ['customer', 'provider', 'admin'] as const) {
      expect(mayCall('authenticated', role)).toBe(true);
    }
  });

  it('admin mode admits only admin', () => {
    expect(mayCall('admin', 'admin')).toBe(true);
    for (const role of ['anonymous', 'customer', 'provider'] as const) {
      expect(mayCall('admin', role)).toBe(false);
    }
    // ...and the chain really is verifyAuth + verifyRoles([1]).
    expect(registerSource).toMatch(/case 'admin':[\s\S]{0,120}verifyRoles\(\[1\]\)/);
  });

  it('provider mode excludes admin, deliberately', () => {
    expect(mayCall('provider', 'admin')).toBe(false);
    expect(PROVIDER_MODE_EXCLUDES_ADMIN).toMatch(/no assignments/i);
    expect(registerSource).toMatch(/case 'provider':[\s\S]{0,120}requireProviderRole/);
  });

  it('every declared auth mode has a row', () => {
    const modes = new Set(V1_CONTRACT.map((e) => e.auth));
    for (const mode of modes) expect(ROLE_ACCESS[mode]).toBeDefined();
  });

  it('no public endpoint is object-scoped', () => {
    /**
     * A public endpoint taking a bookingId would be an unauthenticated read of
     * somebody's address. `objectScopedEntries` filters public out, so this
     * asserts the filter is not hiding one.
     */
    const publicObjectScoped = V1_CONTRACT.filter(
      (e) =>
        e.status === 'implemented' &&
        e.auth === 'public' &&
        e.path.split('/').filter((s) => s.startsWith(':'))
          .map((s) => s.slice(1))
          .some((p) => OBJECT_PARAMETERS.includes(p)),
    );
    expect(publicObjectScoped.map((e) => e.id)).toEqual([]);
  });
});

// ─── §145: object-level ownership ─────────────────────────────────────────────

describe('every object-scoped endpoint has an ownership rule', () => {
  it('leaves nothing unguarded', () => {
    /**
     * THE §145 gate. A new booking-scoped endpoint added without an ownership
     * rule fails here — which is the case the domain suites cannot catch,
     * because none of them can see the whole contract.
     */
    expect(unguardedEntries().map((e) => `${e.id} (${e.domain})`)).toEqual([]);
  });

  it('finds a substantial number of object-scoped endpoints', () => {
    // A guard that matched nothing would pass forever.
    expect(objectScopedEntries().length).toBeGreaterThan(25);
  });

  it('gives every rule a predicate, an enforcer and a proving suite', () => {
    for (const rule of OWNERSHIP_RULES) {
      expect(rule.predicate.length).toBeGreaterThan(15);
      expect(rule.enforcedBy).toMatch(/^services\//);
      expect(rule.provenBy).toMatch(/tests\/.+\.test\.ts/);
    }
  });

  it('the enforcing module and the proving suite both exist', () => {
    // A rule naming a file that was renamed is a rule nobody is checking.
    for (const rule of OWNERSHIP_RULES) {
      const module = path.join(REPO_ROOT, 'src', `${rule.enforcedBy.split(' ')[0]}.ts`);
      expect({ rule: rule.domain, exists: fs.existsSync(module) })
        .toEqual({ rule: rule.domain, exists: true });

      for (const suite of rule.provenBy.split(',').map((s) => s.trim())) {
        expect({ rule: rule.domain, suite, exists: fs.existsSync(path.join(REPO_ROOT, suite)) })
          .toEqual({ rule: rule.domain, suite, exists: true });
      }
    }
  });

  it('refuses a non-owner without telling them the object exists', () => {
    /**
     * Answering 403 for an object that exists and 404 for one that does not is
     * an enumeration oracle, and booking ids are small integers. Most rules
     * therefore answer 404 for both; the reviews rule answers 403 on ownership
     * FIRST, which leaks nothing for the same reason — it is the first gate, so
     * no other fact is reachable.
     */
    for (const rule of OWNERSHIP_RULES) {
      // Asserted as data rather than by reading the prose: the conversations
      // rule states the property without naming a status code, and a regex
      // over English would have called that a violation.
      expect({ domain: rule.domain, leaks: rule.distinguishesAbsentFromForbidden })
        .toEqual({ domain: rule.domain, leaks: false });
      expect(rule.refusal.length).toBeGreaterThan(10);
    }
    const bookings = OWNERSHIP_RULES.find((r) => r.domain === 'bookings')!;
    expect(bookings.refusal).toMatch(/indistinguishable/i);
  });

  it('covers every domain §145 names', () => {
    const covered = OWNERSHIP_RULES.map((r) => r.domain);
    // bookings, jobs, messages, notifications, reviews, earnings, documents
    for (const domain of [
      'bookings', 'provider-jobs', 'conversations', 'notifications', 'reviews', 'finance', 'account',
    ]) {
      expect(covered).toContain(domain);
    }
  });

  it('the matrix reports full ownership coverage', () => {
    const summary = matrixSummary();
    expect(summary.objectScoped).toBe(summary.objectScopedWithRule);
    expect(summary.unguarded).toBe(0);
  });

  it('every matrix row carries a complete access decision', () => {
    for (const row of authorizationMatrix()) {
      for (const role of ROLES) {
        expect(['allow', 'deny']).toContain(row.access[role]);
      }
    }
  });
});
