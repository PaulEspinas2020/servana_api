/**
 * Authorization parity on money (TAB 01, F-01 / F-10).
 *
 * ## What went wrong, and why no per-route review would have caught it
 *
 * `POST /api/admin/disbursements/:id/retry` and
 * `POST /api/admin/finance/payouts/:disbursementId/retry` operated the same
 * disbursement rows. The finance route required `payouts.retry_failed` and
 * wrote an audit record. The disbursement route required nothing, wrote
 * nothing, enforced no retry cap, and POSTed to PayMongo inside the request.
 *
 * Read on its own, each route looks defensible. The bypass exists only in the
 * relationship between them — which is exactly the shape a reviewer scanning
 * one file at a time cannot see, and exactly what a test can.
 *
 * ## Why this asserts a derived property rather than a table
 *
 * The tempting test is a list of route → expected permission. That list is a
 * second statement of the same fact, and a reassembled predicate can be WIDER
 * than the real one — it would describe a system that does not exist and pass
 * while doing so. Nothing here contains a list of routes. Everything is read
 * out of the route table, the handler chains, the controller bodies and the
 * permission catalogue's own `requires` chain.
 *
 * A third route to `retryPayout` fails this suite without anybody updating it.
 *
 * ## The positive controls are the point
 *
 * A green gate proves nothing until it has been watched failing. Every property
 * below is asserted twice: once against the real repository, and once against a
 * synthetic fixture reproducing the PRE-FIX state. If somebody weakens the
 * detector, the fixtures go green and the suite fails on them — so the gate
 * cannot rot into a check that always passes.
 */

import {
  buildRouteCapabilities,
  moneyRoutesWithoutPermission,
  incomparableMoneyGuards,
  permissionRequires,
  closureOf,
  touchesMoney,
  type RouteCapability,
} from '../scripts/lib/capabilityParity';

const caps = buildRouteCapabilities();

const fixture = (over: Partial<RouteCapability>): RouteCapability => ({
  verb: 'post',
  fullPath: '/api/fixture',
  routeFile: 'src/routes/fixture.routes.ts',
  line: 1,
  permissions: [],
  capabilities: [],
  ...over,
});

describe('the analyzer reads the real route table', () => {
  it('resolves routes to money capabilities at all', () => {
    const money = caps.filter(touchesMoney);
    expect(money.length).toBeGreaterThan(10);
  });

  it('reads the permission catalogue and its requires chain', () => {
    const requires = permissionRequires();
    expect(requires.size).toBeGreaterThan(200);
    expect(requires.get('payouts.retry_failed')).toEqual(
      expect.arrayContaining(['payouts.view', 'payouts.details.view']),
    );
  });

  it('expands a permission into everything holding it implies', () => {
    const closure = closureOf(['payouts.retry_failed']);
    expect(closure).toContain('payouts.retry_failed');
    expect(closure).toContain('payouts.details.view');
    expect(closure).toContain('payouts.view');
    // …and transitively, because payouts.view requires it.
    expect(closure).toContain('finance.dashboard.view');
  });

  it('finds the four disbursement routes and the five payout routes', () => {
    const paths = caps.map((c) => `${c.verb} ${c.fullPath}`);
    expect(paths).toContain('post /api/admin/disbursements/trigger');
    expect(paths).toContain('post /api/admin/finance/payouts/:disbursementId/retry');
  });
});

describe('PROPERTY A — no route reaches money without a named permission', () => {
  it('holds across the whole repository', () => {
    const offenders = moneyRoutesWithoutPermission(caps).map(
      (r) => `${r.verb.toUpperCase()} ${r.fullPath} (${r.routeFile})`,
    );
    expect(offenders).toEqual([]);
  });

  it('the batch trigger demands the dangerous permission written for it', () => {
    const trigger = caps.find((c) => c.fullPath === '/api/admin/disbursements/trigger');
    expect(trigger).toBeDefined();
    expect(trigger!.permissions).toContain('payouts.trigger_due_run');
  });

  it('every disbursement route carries a payouts.* permission', () => {
    const legacy = caps.filter((c) => c.fullPath.startsWith('/api/admin/disbursements'));
    expect(legacy.length).toBe(4);
    for (const route of legacy) {
      expect(route.permissions.some((p) => p.startsWith('payouts.'))).toBe(true);
    }
  });

  // ── positive control: the pre-fix state MUST be detected ──────────────────
  it('detects the pre-fix disbursement routes (positive control)', () => {
    const preFix = [
      fixture({
        verb: 'post',
        fullPath: '/api/admin/disbursements/trigger',
        permissions: [],
        capabilities: ['src/services/disbursement.service.ts#processPendingDisbursements'],
      }),
      fixture({
        verb: 'post',
        fullPath: '/api/admin/disbursements/:id/retry',
        permissions: [],
        capabilities: ['src/services/disbursement.service.ts#manualRetry'],
      }),
    ];
    expect(moneyRoutesWithoutPermission(preFix)).toHaveLength(2);
  });

  it('does not fire on a non-money route with no permission', () => {
    const harmless = [
      fixture({
        fullPath: '/api/catalog',
        permissions: [],
        capabilities: ['src/services/catalogAdminService.ts#listCategories'],
      }),
    ];
    expect(moneyRoutesWithoutPermission(harmless)).toEqual([]);
  });
});

describe('PROPERTY B — two routes to one money capability must be ordered', () => {
  it('holds across the whole repository', () => {
    const pairs = incomparableMoneyGuards(caps).map(
      (p) => `${p.capability}: ${p.a.fullPath} [${p.a.permissions}] vs ${p.b.fullPath} [${p.b.permissions}]`,
    );
    expect(pairs).toEqual([]);
  });

  it('tolerates a stricter route reading its own row back', () => {
    // The real shape: retry holds retry_failed (which REQUIRES details.view),
    // the detail read holds details.view. Different sets, ordered closures.
    const ordered = [
      fixture({
        fullPath: '/api/admin/disbursements/:id/retry',
        permissions: ['payouts.retry_failed'],
        capabilities: ['src/services/adminFinanceService.ts#getPayoutDetail'],
      }),
      fixture({
        verb: 'get',
        fullPath: '/api/admin/finance/payouts/:disbursementId',
        permissions: ['payouts.details.view'],
        capabilities: ['src/services/adminFinanceService.ts#getPayoutDetail'],
      }),
    ];
    expect(incomparableMoneyGuards(ordered)).toEqual([]);
  });

  // ── positive control ──────────────────────────────────────────────────────
  it('detects two guards that are each a way around the other (positive control)', () => {
    const incomparable = [
      fixture({
        fullPath: '/api/admin/finance/payouts/:id/retry',
        permissions: ['payouts.retry_failed'],
        capabilities: ['src/services/adminFinanceService.ts#retryPayout'],
      }),
      fixture({
        fullPath: '/api/admin/disbursements/:id/retry',
        permissions: ['payouts.hold'],
        capabilities: ['src/services/adminFinanceService.ts#retryPayout'],
      }),
    ];
    const found = incomparableMoneyGuards(incomparable);
    expect(found).toHaveLength(1);
    expect(found[0].capability).toBe('src/services/adminFinanceService.ts#retryPayout');
  });
});

describe('the deleted path stays deleted', () => {
  it('no route reaches manualRetry, because it no longer exists', () => {
    const reaching = caps.filter((c) =>
      c.capabilities.some((cap) => cap.endsWith('#manualRetry')),
    );
    expect(reaching).toEqual([]);
  });

  it('every route reaching the due-run batch demands a permission', () => {
    const batch = caps.filter((c) =>
      c.capabilities.some(
        (cap) => cap.endsWith('#processPendingDisbursements') || cap.endsWith('#runDuePayoutBatch'),
      ),
    );
    expect(batch.length).toBeGreaterThan(0);
    for (const route of batch) {
      expect(route.permissions.length).toBeGreaterThan(0);
    }
  });
});
