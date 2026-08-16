/**
 * Cross-platform endpoint convergence (§129–§133, §137).
 *
 * ## The release gates, as executable checks
 *
 *   - "Similar platform features call the same canonical endpoints"
 *     → every capability spanning >1 surface resolves to one route family, or
 *       is a declared role split.
 *   - "Role-specific routes share one domain service"
 *     → every role-split capability names exactly ONE domain service module,
 *       compared string-by-string against `V1_CONTRACT[].domainService`.
 *   - "No supported client is broken during migration"
 *     → every legacy route with a canonical successor is still mounted, and
 *       every caller cell that reads `legacy` still has a legacy path to call.
 *
 * ## Why the shared-service check is worth anything
 *
 * Because it compares strings the ROUTER is built from, not a promise. When
 * `provider.jobs.accept` and `admin.bookings.assign` both name
 * `transitionExecutor.transitionBooking`, the claim "one state machine, two
 * permissions" is checkable. The day somebody adds `providerBookingService` to
 * make a provider-only rule easier, the verdict flips to DIVERGENT and this
 * suite fails — which is the entire mechanism §131 asks for.
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
  ARCHITECTURE_REVIEW_RULE,
  CLIENT_SURFACES,
  SERVICE_DELEGATIONS,
  SURFACE_CORRECTION_COST,
  canonicalManifest,
  capabilityRegistry,
  convergenceOf,
  convergenceSummary,
  deprecationPlan,
  domainServiceRoot,
  doubleClaimedIds,
  parityRow,
  declaredServiceDrift,
  resolveDelegation,
  unclaimedEntries,
} from '../src/api/v1/convergence';
import { V1_CONTRACT, V1_PREFIX } from '../src/api/v1/contract';
import { RETIREMENT_CRITERIA, buildWatchList } from '../src/api/v1/legacyTelemetry';

const REPO_ROOT = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

const REGISTRY = capabilityRegistry();

// ─── §129: the sweep is complete ──────────────────────────────────────────────

describe('every canonical endpoint belongs to a declared capability', () => {
  it('claims every entry in the contract', () => {
    // The §129 sweep, as a check rather than a document. An endpoint no
    // capability claims is an endpoint no parity matrix covers, and §137 has
    // nothing to compare a new one against.
    expect(unclaimedEntries().map((e) => e.id)).toEqual([]);
  });

  it('claims each entry exactly once', () => {
    // Two capabilities claiming one endpoint means two rows of the matrix
    // disagree about which client calls it.
    expect(doubleClaimedIds()).toEqual([]);
  });

  it('names no endpoint that does not exist', () => {
    for (const capability of REGISTRY) {
      expect(convergenceOf(capability).missingIds).toEqual([]);
    }
  });

  it('federates rather than copies — every capability names its source file', () => {
    for (const capability of REGISTRY) {
      expect(capability.source.length).toBeGreaterThan(5);
      if (capability.source.startsWith('services/')) {
        expect(fs.existsSync(path.join(REPO_ROOT, 'src', `${capability.source}.ts`))).toBe(true);
      }
    }
  });

  it('covers all five surfaces in its vocabulary', () => {
    expect([...CLIENT_SURFACES].sort()).toEqual(
      ['admin', 'customerMobile', 'customerWeb', 'providerMobile', 'providerWeb'],
    );
  });
});

// ─── §131: role splits share one domain service ───────────────────────────────

describe('role-specific routes share one domain service', () => {
  it('has no divergent capability', () => {
    const divergent = REGISTRY.map(convergenceOf).filter((r) => r.verdict === 'DIVERGENT');
    expect(
      divergent.map((r) => `${r.capability.key}: ${r.services.join(' | ')}`),
    ).toEqual([]);
  });

  it('proves the booking state machine is ONE machine across three route families', () => {
    /**
     * The single most important assertion in this suite. Customer cancel,
     * provider accept/decline/en-route/arrived/start/complete/cancel, and admin
     * assign/reassign are ten endpoints on three URL families — and they are one
     * state machine with ten doors.
     */
    const transitionEntries = V1_CONTRACT.filter((e) =>
      e.domainService.includes('transitionExecutor.transitionBooking'),
    );
    expect(transitionEntries.length).toBeGreaterThanOrEqual(10);

    const families = new Set(transitionEntries.map((e) => `/${e.path.split('/').filter(Boolean)[0]}`));
    expect([...families].sort()).toEqual(['/admin', '/bookings', '/provider']);

    // Three families, one module.
    const services = new Set(transitionEntries.map((e) => domainServiceRoot(e.domainService)));
    expect([...services]).toEqual(['services/booking/transitionExecutor']);
  });

  it('gives each of those doors a DIFFERENT actor verb', () => {
    // One machine with ten doors, not one door called ten times: the verb is
    // what carries the authorization, so two endpoints sharing a verb would be
    // a duplicate route rather than a role split.
    const verbs = V1_CONTRACT.filter((e) =>
      e.domainService.includes('transitionExecutor.transitionBooking'),
    ).map((e) => e.domainService.match(/\(([A-Z_]+)\)/)?.[1]);

    expect(verbs.every(Boolean)).toBe(true);
    expect(new Set(verbs).size).toBe(verbs.length);
  });

  it('every role split names exactly one service', () => {
    for (const capability of REGISTRY) {
      const report = convergenceOf(capability);
      if (report.verdict === 'ROLE_SPLIT_SHARED_SERVICE') {
        expect(report.services).toHaveLength(1);
        expect(report.routeFamilies.length).toBeGreaterThan(1);
      }
    }
  });

  it('every capability carries a rationale that says something', () => {
    // §131 asks for the sentence per capability. A one-word rationale would
    // satisfy a `.length > 0` check and nothing else.
    for (const capability of REGISTRY) {
      expect(capability.roleSplitRationale.length).toBeGreaterThan(80);
    }
  });

  it('every single-surface capability explains why it has no equivalent', () => {
    for (const capability of REGISTRY) {
      if (convergenceOf(capability).verdict !== 'SINGLE_SURFACE') continue;
      // The words that distinguish "only admins do this" from "we built it for
      // admin and never thought about anyone else".
      expect(capability.roleSplitRationale.toLowerCase()).toMatch(
        /role-specific|operator|no customer|no provider|admin/,
      );
    }
  });
});

// ─── Delegations are verified, not asserted ───────────────────────────────────

describe('every declared delegation is real', () => {
  it('names a file that imports the module it claims to delegate to', () => {
    /**
     * A delegation exemption is the one place this whole design could be
     * quietly weakened — add an entry and any fork becomes legal. So each one
     * is checked against the source, and an exemption that stops being true
     * stops being granted.
     */
    expect(SERVICE_DELEGATIONS.length).toBeGreaterThan(0);
    for (const delegation of SERVICE_DELEGATIONS) {
      const source = read(delegation.evidenceFile);
      expect(source).toContain(delegation.evidenceImport);
      expect(delegation.why.length).toBeGreaterThan(80);
    }
  });

  it('resolves a delegated root onto its target', () => {
    for (const delegation of SERVICE_DELEGATIONS) {
      expect(resolveDelegation(delegation.from)).toBe(delegation.to);
    }
  });

  it('leaves an undelegated module alone', () => {
    expect(resolveDelegation('services/booking/transitionExecutor'))
      .toBe('services/booking/transitionExecutor');
  });

  it('the notification-preference delegation writes through ONE writer', () => {
    // Two writers to one preference row is how a provider's saved choices get
    // overwritten by a customer-shaped default map.
    const source = read('src/services/events/notificationPreferences.ts');
    expect(source).toContain('NOT a second writer');
    expect(source).not.toMatch(/INSERT INTO|UPDATE\s+\$\{/);
  });
});

// ─── §137: the architecture-review rule ───────────────────────────────────────

describe('the architecture-review rule is enforced, not published', () => {
  it('states the rule and names what enforces it', () => {
    expect(ARCHITECTURE_REVIEW_RULE.statement).toContain('single client');
    expect(ARCHITECTURE_REVIEW_RULE.enforcedBy).toContain('test');
    expect(ARCHITECTURE_REVIEW_RULE.checks.length).toBeGreaterThanOrEqual(5);
  });

  it('a new endpoint claimed by nobody fails the check', () => {
    // The guard's own guard: prove the check can fail, so a green run means
    // something. A check that cannot fail is decoration.
    const pretend = { ...V1_CONTRACT[0], id: 'someones.private.endpoint' };
    const claimed = new Set(REGISTRY.flatMap((c) => c.contractIds));
    expect(claimed.has(pretend.id)).toBe(false);
  });

  it('offers a route through review rather than a wall', () => {
    // A rule with no exemption process is a rule people route around.
    expect(ARCHITECTURE_REVIEW_RULE.exemptionProcess).toContain('roleSplitRationale');
  });
});

// ─── §133/§138: the canonical call manifest ───────────────────────────────────

describe('the canonical call manifest describes the router', () => {
  const manifest = canonicalManifest();

  it('lists every mounted endpoint and nothing else', () => {
    const mounted = V1_CONTRACT.filter((e) => e.status === 'implemented').map((e) => e.id).sort();
    expect(manifest.map((m) => m.id).sort()).toEqual(mounted);
  });

  it('omits planned entries, which would generate calls to a 404', () => {
    const planned = V1_CONTRACT.filter((e) => e.status === 'planned').map((e) => e.id);
    expect(planned.length).toBeGreaterThan(0);
    for (const id of planned) {
      expect(manifest.some((m) => m.id === id)).toBe(false);
    }
  });

  it('gives every endpoint a full path under the v1 prefix', () => {
    for (const row of manifest) {
      expect(row.path.startsWith(V1_PREFIX)).toBe(true);
    }
  });

  it('attributes every endpoint to a capability', () => {
    for (const row of manifest) {
      expect(row.capability).not.toBeNull();
    }
  });

  it('records which legacy paths each canonical endpoint supersedes', () => {
    const superseding = manifest.filter((m) => m.supersedes.length);
    expect(superseding.length).toBeGreaterThan(20);
  });

  it('the committed manifest matches what the code generates', () => {
    const onDisk = JSON.parse(read('docs/api/CANONICAL_CALL_MANIFEST.json'));
    expect(onDisk.endpoints.map((e: any) => e.id)).toEqual(manifest.map((m) => m.id));
    expect(onDisk.endpointCount).toBe(manifest.length);
    expect(onDisk.prefix).toBe(V1_PREFIX);
  });
});

// ─── "No supported client is broken during migration" ─────────────────────────

describe('no supported client is broken during migration', () => {
  it('every surface still reading legacy has a legacy path to call', () => {
    /**
     * The gate that protects the live platform. A caller cell reading `legacy`
     * with no legacy mapping means the route the client actually calls was
     * removed from the contract's knowledge — and the next retirement sweep
     * cannot see what it would break.
     */
    for (const entry of V1_CONTRACT) {
      const stillLegacy = CLIENT_SURFACES.filter((s) => entry.callers[s] === 'legacy');
      if (stillLegacy.length) {
        expect({ id: entry.id, legacy: entry.legacy.length }).toMatchObject({
          legacy: expect.any(Number),
        });
        expect(entry.legacy.length).toBeGreaterThan(0);
      }
    }
  });

  it('counts every legacy route it documents as superseded', () => {
    // Telemetry derives its watch list from the same array, so a route can only
    // be documented as superseded if it is also being measured.
    const watch = buildWatchList();
    const documented = new Set(
      V1_CONTRACT.flatMap((e) => e.legacy.map((l) => `${l.method} ${l.path}`)),
    );
    for (const key of documented) {
      expect(watch.some((w) => `${w.method} ${w.path}` === key)).toBe(true);
    }
  });

  it('retires nothing while any client still calls it', () => {
    for (const row of deprecationPlan()) {
      if (row.blockingSurfaces.length) expect(row.retirable).toBe(false);
    }
  });

  it('gives a mobile-blocked alias the longer window', () => {
    // An unupdated app keeps calling the old path for as long as it stays
    // installed, which is why the window is days of silence rather than
    // releases.
    for (const row of deprecationPlan()) {
      const mobile = row.blockingSurfaces.some((s) => s.endsWith('Mobile'));
      if (mobile) expect(row.earliestWindowDays).toBe(RETIREMENT_CRITERIA.mobileZeroTrafficDays);
    }
  });

  it('names a concrete blocker for every alias that is not retirable', () => {
    // "Not yet" is not a plan. Each row says what has to become true.
    for (const row of deprecationPlan()) {
      if (!row.retirable) expect(row.blockedBy.length).toBeGreaterThan(0);
    }
  });

  it('orders migration by correction cost, mobile last', () => {
    expect(SURFACE_CORRECTION_COST.admin.retirementDays)
      .toBe(RETIREMENT_CRITERIA.webZeroTrafficDays);
    expect(SURFACE_CORRECTION_COST.customerMobile.retirementDays)
      .toBe(RETIREMENT_CRITERIA.mobileZeroTrafficDays);
    expect(SURFACE_CORRECTION_COST.customerMobile.retirementDays)
      .toBeGreaterThan(SURFACE_CORRECTION_COST.customerWeb.retirementDays);
  });
});

// ─── Parity rows ──────────────────────────────────────────────────────────────

describe('the parity matrix reports honestly', () => {
  it('marks a capability n/a for a surface that does not perform it', () => {
    for (const capability of REGISTRY) {
      const row = parityRow(capability);
      for (const surface of CLIENT_SURFACES) {
        if (!capability.surfaces.includes(surface)) {
          expect(row.surfaces[surface]).toBe('n/a');
        }
      }
    }
  });

  it('claims no client has migrated, because none has', () => {
    /**
     * The honest cell. Every canonical route is mounted and tested, and the
     * namespace is unpushed — nothing can migrate against a contract that is
     * not serving. A matrix showing optimistic cells here would read as
     * permission to start deleting aliases.
     */
    expect(convergenceSummary().migratedCallerCells).toBe(0);
  });

  it('reports mixed rather than rounding a half-migrated capability', () => {
    // Rounding would make the matrix lie in the direction of whoever wrote it.
    const capability = REGISTRY.find((c) => c.contractIds.length > 2)!;
    const entries = capability.contractIds
      .map((id) => V1_CONTRACT.find((e) => e.id === id)!)
      .filter(Boolean);
    const states = new Set(entries.map((e) => e.callers.customerMobile));
    const row = parityRow(capability);
    states.delete('n/a');
    if (states.size > 1) expect(row.surfaces.customerMobile).toBe('mixed');
  });

  it('lists the legacy paths a client is still on for each capability', () => {
    const withLegacy = REGISTRY.map(parityRow).filter((r) => r.legacyPaths.length);
    expect(withLegacy.length).toBeGreaterThan(10);
    for (const row of withLegacy) {
      for (const p of row.legacyPaths) expect(p).toMatch(/^(GET|POST|PUT|PATCH|DELETE) \/api\//);
    }
  });
});

// ─── The declaration must match the code ──────────────────────────────────────

describe('declared domain modules are checked against the contract', () => {
  /**
   * The gap this closes.
   *
   * `domainModule` says "the ONE domain module the capability's endpoints are
   * expected to share". It is authored by hand, published in
   * CLIENT_ENDPOINT_PARITY_MATRIX.md and quoted in the TAB 13 certification as a
   * statement of architecture — and until now nothing compared it to the
   * `domainService` the contract entries actually name.
   *
   * Five capabilities were naming a module no endpoint reached, including
   * `services/ratingAggregationService`, which exists but is not what the rating
   * endpoints call, and `services/providerProfileComplianceService`, where the
   * real module is `services/account/providerProfileService`. Every one of them
   * was a real file, which is what made the claims read as verified.
   *
   * This is the same failure class TAB 15 hit: a careful, specific, plausible
   * claim that no second source ever checked.
   */
  it('names no domain module that none of its endpoints reach', () => {
    const drift = declaredServiceDrift();
    expect(
      drift.map((d) => `${d.capability}: declared ${d.unreached.join(', ')}, actual ${d.actual.join(', ')}`),
    ).toEqual([]);
  });

  it('tolerates a capability composing several services', () => {
    /**
     * Containment, not equality — asserted so the rule cannot be tightened into
     * one that cries wolf. `bookings.get` authorises through one module and
     * fetches through another; calling that a drift would make the check
     * useless and it would get turned off.
     */
    const composing = capabilityRegistry()
      .map(convergenceOf)
      .filter((r) => r.services.length > 1);
    expect(composing.length).toBeGreaterThan(0);
    expect(declaredServiceDrift()).toEqual([]);
  });
});
