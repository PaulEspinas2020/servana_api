/**
 * The registry agrees with what the clients actually call (TAB 04).
 *
 * ## What this replaces
 *
 * `callers.<client>` in `src/api/v1/contract.ts` is a claim made in THIS
 * repository about code in five OTHERS. Measured 2026-08-18:
 * `providerWeb: 'migrated'` appeared **zero times** across all 109 entries,
 * while 36 of them name a canonical path the Provider Web portal calls
 * unconditionally.
 *
 * That is not a stale row or two. Alias retirement requires every client the
 * matrix lists to read migrated; with none recorded, none of the 89
 * `ALIAS_TEMPORARILY` routes could ever be retired. And since
 * `PER_CLIENT_MIGRATION_PLAN.md` is generated from the field, it told the
 * Provider Web team to redo work they had already shipped.
 *
 * ## Why this test reads a manifest and not a list
 *
 * The acceptance criterion is explicit that the check must read the client's
 * own published manifest "rather than a hand-written list". A list here would be
 * the same defect in a new file: something a person must remember to update when
 * a call site changes in another repository.
 *
 * `src/api/v1/client-manifests/providerWeb.canonical-calls.json` is GENERATED in
 * the portal from its source, with a `file:line` citation per call site, and
 * copied here. Delete a call over there and this test turns red over here.
 */

import { V1_CONTRACT } from '../src/api/v1/contract';
import { loadManifests, calledKeys } from '../scripts/reconcile-client-manifests';

const shape = (p: string) => p.replace(/:[A-Za-z0-9_]+/g, ':param').replace(/\/+$/, '');
const key = (method: string, p: string) => `${method.toLowerCase()} ${shape(p)}`;

describe('the contract agrees with the clients that publish a manifest', () => {
  const manifests = loadManifests();

  it('the manifests are present — without them this suite proves nothing', () => {
    // A vacuous pass is the failure mode of every parity check. Say so out loud.
    expect(manifests.map((m) => m.client)).toContain('providerWeb');
    expect(manifests.map((m) => m.client)).toContain('providerMobile');
    for (const m of manifests) expect(m.endpoints.length).toBeGreaterThan(0);
  });

  it('every endpoint the portal calls exists in the contract', () => {
    const providerWeb = manifests.find((m) => m.client === 'providerWeb')!;
    const contractKeys = new Set((V1_CONTRACT as any[]).map((e) => key(e.method, e.path)));
    const orphans = [...calledKeys(providerWeb)].filter((k) => !contractKeys.has(k));
    // A call with no contract entry means the client and the registry disagree
    // about what exists — a finding, not a formatting problem.
    expect(orphans).toEqual([]);
  });

  it("providerWeb reads 'migrated' for exactly the endpoints the portal calls", () => {
    const providerWeb = manifests.find((m) => m.client === 'providerWeb')!;
    const called = calledKeys(providerWeb);

    const derived = (V1_CONTRACT as any[])
      .filter((e) => called.has(key(e.method, e.path)))
      .map((e) => e.id)
      .sort();

    const recorded = (V1_CONTRACT as any[])
      .filter((e) => e.callers?.providerWeb === 'migrated')
      .map((e) => e.id)
      .sort();

    expect(recorded).toEqual(derived);
  });

  it('the correction actually moved — not zero, and not everything', () => {
    const migrated = (V1_CONTRACT as any[]).filter((e) => e.callers?.providerWeb === 'migrated');
    // Zero was the measured starting state and the reason this TAB exists.
    expect(migrated.length).toBeGreaterThan(0);
    // And a blanket promotion would be the same error with the opposite sign.
    expect(migrated.length).toBeLessThan(V1_CONTRACT.length);
  });

  it('leaves clients with no manifest untouched, rather than guessing', () => {
    /**
     * Customer Web, Provider Mobile, Customer Mobile and Admin Web publish no
     * manifest yet (TAB 04 mandate 2). Deriving their state from anything else
     * available here would be a guess dressed as a derivation, which is exactly
     * how the providerWeb rows came to be wrong. So their distribution is left
     * alone and this asserts that it was.
     */
    const withManifest = new Set(manifests.map((m) => m.client));

    // Derived from what is on disk rather than from a list written here. When
    // the worker app's manifest landed, the hardcoded version of this assertion
    // failed for the right reason and had to be generalised — a list in a test
    // is the same maintenance burden as a list in the contract, one file along.
    for (const client of ['customerWeb', 'providerMobile', 'customerMobile', 'admin'] as const) {
      if (withManifest.has(client)) continue;
      const migrated = (V1_CONTRACT as any[]).filter((e) => e.callers?.[client] === 'migrated');
      expect(migrated.length).toBe(0);
    }
  });

  /**
   * The second client, and the reason the reconciler had to stop naming the
   * first one twice.
   *
   * `providerMobile` is the worker app. Its manifest is generated from the
   * RESOLVED Dart AST rather than from a pattern over text, and its shape
   * matches providerWeb's field for field, so the reconciler needed no special
   * case to read it — which is the property being asserted here.
   */
  it("providerMobile reads 'migrated' for exactly the endpoints the worker app calls", () => {
    const providerMobile = manifests.find((m) => m.client === 'providerMobile')!;
    const called = calledKeys(providerMobile);
    for (const entry of V1_CONTRACT as any[]) {
      const k = key(entry.method, entry.path);
      if (called.has(k)) {
        expect([entry.id, entry.callers.providerMobile]).toEqual([entry.id, 'migrated']);
      } else {
        expect([entry.id, entry.callers.providerMobile]).not.toEqual([entry.id, 'migrated']);
      }
    }
  });

  it('both clients are reconciled, and they are not the same set', () => {
    // A reconciler that had collapsed to one client would still pass every
    // assertion above if both columns happened to agree. They do not.
    const web = new Set(calledKeys(manifests.find((m) => m.client === 'providerWeb')!));
    const mobile = new Set(calledKeys(manifests.find((m) => m.client === 'providerMobile')!));
    expect(web.size).toBeGreaterThan(0);
    expect(mobile.size).toBeGreaterThan(0);
    expect([...mobile].some((k) => !web.has(k))).toBe(true);
  });
});
