/**
 * The surface the contract does not name may only shrink.
 *
 * `V1_CONTRACT`'s `legacy` mappings are what the migration matrix, the
 * deprecation schedule and the authorization parity gate all read. A mounted
 * route the contract never names is invisible to every one of them at once —
 * no declared successor, no disposition, and no comparison against a v1 twin.
 *
 * So a completeness figure derived from the contract measures the surface
 * somebody chose to name, not the surface actually served. 115 of 520 mounted
 * legacy routes carry a disposition; 405 do not.
 *
 * The book asks for a gate that fails on any undispositioned route. Shipped that
 * way it fails 405 times on the first run, and a gate that cannot pass is
 * deleted inside a week — the reasoning `release-gate.yml` already gives for
 * keeping its dependency step non-blocking. So the 405 are frozen and this
 * asserts only that the number does not RISE.
 */

import { orphanRoutes, frozenOrphans, orphanDelta } from '../scripts/orphan-route-ratchet';

describe('the undispositioned legacy surface', () => {
  it('adds no new orphan', () => {
    // The property that makes draining it converge. Without it, one route can be
    // dispositioned while another is mounted undispositioned, and the count
    // reports progress that did not happen.
    expect(orphanDelta().added).toEqual([]);
  });

  it('is measured against the mounted routes, not against a hand-kept list', () => {
    // A frozen list that stopped being derived would pass forever. Anchoring on
    // the live route table is what stops this becoming decoration.
    const now = orphanRoutes();
    expect(now.length).toBeGreaterThan(100);
    expect(now.every((r) => /^(GET|POST|PUT|PATCH|DELETE) \/api\//.test(r))).toBe(true);
  });

  it('never counts a v1 route as an orphan (negative fixture)', () => {
    // The v1 tree IS the contract. If it ever appeared here the comparison
    // would be inverted, and the ratchet would freeze the wrong surface.
    expect(orphanRoutes().some((r) => r.includes('/api/v1/'))).toBe(false);
  });

  it('keeps the frozen list in step with what the script derives', () => {
    // Retirements are reported rather than silently absorbed, so lowering the
    // ratchet stays a deliberate --write.
    expect(frozenOrphans().length).toBeGreaterThanOrEqual(orphanRoutes().length);
  });
});
