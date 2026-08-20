/**
 * No route in the worker family may be mounted without an authorization rung.
 *
 * ## Why this exists as a standing invariant rather than a list
 *
 * `unauthenticated-pii-routes.test.ts` asserts the guards on routes it names
 * one by one. That is the right shape for the routes it was written about — it
 * says WHY each is gated, and a named assertion survives a refactor that a
 * count does not. What it cannot do is notice a SIXTH route appearing. A route
 * added by copy-paste tomorrow is outside every list written yesterday, and the
 * worker family is the one family in this repository where a bare route has
 * twice been shipped and twice been found by audit rather than by a gate.
 *
 * This file closes that: it enumerates the family from the route table and
 * refuses if any member carries no rung, whatever its name.
 *
 * ## Why it must resolve middleware aliases, and what happens when it does not
 *
 * 43 of the 58 worker-family routes declare their guards as `...adminOnly`, a
 * spread of `[verifyAuth, verifyRoles([0, 1]), adminRateLimit]` defined in the
 * same file. A classifier that reads the handler text WITHOUT resolving that
 * spread sees none of the ladder's names and reports the route `public` — the
 * weakest rung.
 *
 * That misreading is not hypothetical here; it is this file's whole reason for
 * existing, and it has now happened three times:
 *
 *   1. A sweep counted "261 of 412 routes unauthenticated". The real number was
 *      71 (`unauthenticated-pii-routes.test.ts`).
 *   2. A deletion pass removed 30 routes rather than 24, because the detector
 *      searched each line for the literal `verifyAuth`. Six SECURED admin routes
 *      were deleted and had to be restored (`technician.routes.ts`, which now
 *      carries a comment telling any future sweep to resolve aliases).
 *   3. A backend hand-over reported these five as carrying no authentication at
 *      all, two of them writes, and led with it as the P0 blocking any launch:
 *        GET    /api/workers/all
 *        GET    /api/workers/role/:role
 *        GET    /api/workers/:uid/services
 *        POST   /api/workers/:uid/services
 *        DELETE /api/workers/:uid/services/:serviceId
 *      All five carry `...adminOnly` and have been authenticated since
 *      a062ef9 (2026-08-01) and rate-limited since f5c4743 (2026-08-18).
 *
 * So this test uses `authOf`, the classifier that resolves aliases per-file,
 * and the controls below prove it is still resolving them. A count of open
 * routes is worth exactly what its classifier is worth.
 *
 * ## Which direction this fails in
 *
 * If alias resolution breaks, guarded routes classify as `public` and this test
 * goes RED. That is the safe direction: the gate cries wolf rather than going
 * quiet. The dangerous direction is a classifier that over-credits — a rung
 * pattern loose enough to match anything — which would report zero open routes
 * because it can no longer tell the difference. The `refuses a bare chain`
 * control exists for that case and nothing else.
 */

import { buildMountedRoutes, type MountedRoute } from '../scripts/lib/routeTable';
import { authOf, resolvedChain } from '../scripts/legacy-authz-inventory';

/**
 * A route is in the family when `worker` or `workers` is a whole SEGMENT.
 *
 * Substring matching would pull in `/api/workers-report` and miss nothing, but
 * it also decides membership by spelling rather than by structure. Segment
 * matching is the same rule the protected-contract floor uses, which is why the
 * counts below reconcile with it exactly.
 */
const isWorkerFamily = (r: MountedRoute): boolean => {
  const segments = r.fullPath.split('/').filter(Boolean);
  return segments.includes('worker') || segments.includes('workers');
};

const family = buildMountedRoutes().filter(isWorkerFamily);
const label = (r: MountedRoute) => `${r.verb.toUpperCase()} ${r.fullPath} (${r.file}:${r.line})`;

describe('the instrument, before its zero is believed', () => {
  /**
   * A positive fixture. Without it, a filter that matches nothing reports zero
   * unauthenticated routes and passes — the honest-looking zero that several
   * gates in this repository have been caught reporting.
   */
  it('sees the worker family at all', () => {
    expect(family.length).toBeGreaterThan(50);
  });

  it('sees both halves of the family the floor freezes', () => {
    const under = (p: string) => family.filter((r) => r.fullPath.startsWith(p)).length;
    // 39 + 19 is the frozen protected-contract floor's own split. If these move,
    // the floor and this test disagree and one of them is wrong.
    expect(under('/api/worker/')).toBe(39);
    expect(under('/api/workers/')).toBe(19);
  });

  /**
   * Proves the alias resolver is still resolving. `...adminOnly` must widen
   * into a chain naming `verifyAuth`; if it stops doing so, the guard below
   * would still be correct but for the wrong reason, and the next person to
   * read a green run would draw the wrong conclusion from it.
   */
  it('resolves a spread alias into the middleware it names', () => {
    const spread = family.find((r) => r.handlers.join(' ').includes('...adminOnly'));
    expect(spread).toBeDefined();
    const chain = resolvedChain(spread as MountedRoute);
    expect(chain).not.toContain('...adminOnly');
    expect(chain).toContain('verifyAuth');
    expect(chain).toContain('verifyRoles');
  });

  /**
   * The control for the dangerous direction. A classifier that has become loose
   * enough to credit anything reports zero open routes because it can no longer
   * see one. A chain with no middleware in it must still come back `public`.
   */
  it('refuses a bare chain — the classifier can still say public', () => {
    const bare = { ...(family[0] as MountedRoute), handlers: ['technicianController.list'] };
    expect(authOf(bare)).toBe('public');
  });
});

describe('WORKER_SURFACE_AUTHENTICATED', () => {
  it('mounts no worker-family route without an authorization rung', () => {
    const open = family.filter((r) => authOf(r) === 'public');
    expect(open.map(label)).toEqual([]);
  });

  /**
   * The two writes called out by name, because a read left open is a
   * disclosure and a write left open changes state. A provider's service list
   * decides what work they are offered, so an open POST/DELETE here is an
   * earnings problem, not only a data one.
   */
  it.each([
    ['post', '/api/workers/:uid/services'],
    ['delete', '/api/workers/:uid/services/:serviceId'],
  ])('the %s %s write is gated', (verb, path) => {
    const route = family.find((r) => r.verb === verb && r.fullPath === path);
    expect(route).toBeDefined();
    const chain = resolvedChain(route as MountedRoute);
    expect(chain).toContain('verifyAuth');
    expect(authOf(route as MountedRoute)).not.toBe('public');
  });
});
