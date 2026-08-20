/**
 * The orphan list cannot silently regrow (TAB 09, F-12).
 *
 * ## What this can and cannot assert
 *
 * The book's coverage assertion is two-directional: every admin route has a
 * portal caller, and every portal call resolves to a live route. The second
 * half needs `servana_adminportal`, which is not on this machine, so it is a
 * manual task rather than a silent omission.
 *
 * What IS assertable here is the half that lives in this repository: every
 * classification names a route that still exists, and every route the book
 * enumerated is still accounted for. A disposition that outlives its route is
 * how a list of thirteen becomes a list of nine that nobody notices shrinking.
 *
 * ## Why a classification without a reason is refused
 *
 * A disposition is a decision. `RETIRE` with no reason is indistinguishable
 * from `RETIRE` because somebody was tidying, and the two have very different
 * consequences when acted on. The reason field is required by the type and its
 * substance is asserted below.
 */

import {
  ADMIN_ROUTE_DISPOSITIONS,
  dispositionFor,
  type AdminDisposition,
} from '../src/api/v1/adminSurfaceManifest';
import { buildMountedRoutes } from '../scripts/lib/routeTable';

const mounted = buildMountedRoutes().filter((r) => r.fullPath.startsWith('/api/admin'));
const signature = (verb: string, path: string) => `${verb.toLowerCase()} ${path}`;
const mountedSignatures = new Set(mounted.map((r) => signature(r.verb, r.fullPath)));

describe('the fixture is real (positive control)', () => {
  it('finds the admin surface', () => {
    expect(mounted.length).toBeGreaterThan(200);
  });

  it('has classifications to check', () => {
    expect(ADMIN_ROUTE_DISPOSITIONS.length).toBeGreaterThan(10);
  });
});

describe('every classification names a route that still exists', () => {
  it.each(ADMIN_ROUTE_DISPOSITIONS.map((d) => [`${d.method} ${d.path}`, d.method, d.path]))(
    '%s',
    (_label, method, path) => {
      // A disposition that outlives its route is a decision about nothing, and
      // it makes the list look longer than the problem.
      expect(mountedSignatures.has(signature(String(method), String(path)))).toBe(true);
    },
  );
});

describe('every classification is a decision, not a label', () => {
  it.each(ADMIN_ROUTE_DISPOSITIONS.map((d) => [`${d.method} ${d.path}`, d]))('%s', (_l, entry) => {
    const d = entry as { reason: string; disposition: AdminDisposition; canonical?: string };
    // Long enough to carry an argument. A one-word reason is a label.
    expect(d.reason.length).toBeGreaterThan(60);
  });

  it('every CONVERGE names the surface that survives', () => {
    // "Converge" without saying onto what is two surfaces and an opinion.
    const missing = ADMIN_ROUTE_DISPOSITIONS.filter(
      (d) => d.disposition === 'CONVERGE' && !d.canonical,
    ).map((d) => `${d.method} ${d.path}`);
    expect(missing).toEqual([]);
  });

  it('no RETIRE claims telemetry it does not have', () => {
    // Every RETIRE in this repository is a PROPOSAL. "Unreachable from the
    // portal" is not "deletable": the portal is one of six consumers and the
    // other five are not on this machine.
    for (const d of ADMIN_ROUTE_DISPOSITIONS.filter((x) => x.disposition === 'RETIRE')) {
      expect(d.reason).toMatch(/PROPOSAL|telemetry|confirm/i);
    }
  });
});

describe('the thirteen the book enumerated are all accounted for', () => {
  /**
   * Listed here as the book measured them, so a classification quietly
   * disappearing fails rather than passing. This is the one place a hard-coded
   * list is correct: it is a record of what an external document claimed, and
   * its purpose is to be compared against.
   */
  const BOOK_ORPHANS: Array<[string, string]> = [
    ['get', '/api/admin/disbursements'],
    ['get', '/api/admin/disbursements/booking/:bookingId'],
    ['post', '/api/admin/disbursements/:id/retry'],
    ['post', '/api/admin/disbursements/trigger'],
    ['patch', '/api/admin/support/cases/:caseId/state'],
    ['patch', '/api/admin/support/cases/:caseId/appeals/:appealId'],
    ['get', '/api/admin/support/cases/:caseId/attachments/:attachmentId/preview'],
    ['post', '/api/admin/support/cases/sla-sweep'],
    ['post', '/api/admin/providers/:uid/eligibility-preview'],
    ['post', '/api/admin/provider-availability/evaluate-booking'],
    ['get', '/api/admin/provider-catalog/offerings'],
    ['get', '/api/admin/provider/reconciliation'],
    ['patch', '/api/admin/workers/:uid/archive'],
  ];

  it('is thirteen', () => {
    expect(BOOK_ORPHANS).toHaveLength(13);
  });

  it.each(BOOK_ORPHANS)('%s %s still exists', (method, path) => {
    expect(mountedSignatures.has(signature(method, path))).toBe(true);
  });

  it.each(BOOK_ORPHANS)('%s %s is classified', (method, path) => {
    // None left undecided — the TAB's first acceptance criterion.
    expect(dispositionFor(method, path)).toBeDefined();
  });
});

describe('the SLA sweep is scheduled, not merely permissioned', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const source: string = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'scheduler.ts'),
    'utf8',
  );

  it('runs on a cron', () => {
    expect(source).toMatch(/name: 'support-sla-sweep'/);
  });

  it('goes through the job lease, like every other scheduled job', () => {
    // Two replicas double-sweeping would write the provider-visible event
    // twice. The lease is what makes the schedule safe to add.
    expect(source).toMatch(/withJobLease\(job\.name, job\.run\)/);
  });

  it('states what a duplicate run would do', () => {
    const entry = source.slice(source.indexOf("name: 'support-sla-sweep'"));
    expect(entry).toMatch(/duplicateEffect/);
  });

  it('does not attribute a system sweep to an admin', () => {
    expect(source).toMatch(/SLA_SWEEP_SYSTEM_ACTOR/);
  });
});
