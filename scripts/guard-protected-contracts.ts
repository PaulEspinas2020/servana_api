#!/usr/bin/env ts-node
/**
 * Guard: the mobile-authoritative and provider-web route contracts are still
 * MOUNTED. Detects accidental removal.
 *
 * ## Why this stopped grepping src/ (M-21)
 *
 * The previous `.mjs` guard asked `srcContains(pattern)` — "does this string
 * appear anywhere under src/". That is not the question. It was satisfied by
 * text in files that mount nothing:
 *
 *   /worker/   ← satisfied by src/middleware/workerCodeLimiter.ts
 *   /booking   ← satisfied by src/api/v1/contract.ts
 *   /admin/    ← satisfied by src/api/v1/adminSurfaceManifest.ts
 *
 * Every worker route could have been deleted and this gate would have stayed
 * green on the strength of a middleware mention. A gate that cannot fail is
 * indistinguishable from no gate, and worse, because it is believed.
 *
 * `buildMountedRoutes()` answers the real question. It is static analysis — it
 * never imports app.ts, so there is no listener, no pg pool, no Firebase and no
 * credentials — which is what makes it safe to run inside `verify`.
 *
 * ## Why counts are frozen and not just "at least one"
 *
 * "At least one" restates the old promise in an honest instrument, but it still
 * cannot see 38 of 39 worker routes being deleted. The stated purpose of this
 * guard is "detects accidental removal", so the floor is the promise. Ratchet
 * direction is the inverse of the orphan ratchet: these counts may RISE freely
 * and may not FALL. Removing a route on purpose is legitimate — re-freeze with
 * `npm run guard:protected-contracts -- --freeze` in the same commit, so the
 * removal is a reviewable line in the diff instead of a silent drift.
 */

import fs from 'fs';
import path from 'path';
import { buildMountedRoutes, MountedRoute, REPO_ROOT } from './lib/routeTable';

interface Contract {
  key: string;
  label: string;
  match: RegExp;
}

/**
 * Anchored at the start of the full path, with the api/ and v1/ segments
 * optional because the same contract is served under more than one mount.
 * Anchoring is what stops `/bookings` satisfying the `/booking/` contract —
 * the defect this guard already recorded once, as a source-text regex.
 */
const CONTRACTS: Contract[] = [
  { key: 'worker', label: '/worker/ routes (worker mobile)', match: /^\/(api\/)?(v1\/)?worker\// },
  { key: 'workers', label: '/workers/ routes (worker mobile)', match: /^\/(api\/)?(v1\/)?workers\// },
  { key: 'booking', label: '/booking/ routes (customer mobile)', match: /^\/(api\/)?(v1\/)?booking\// },
  { key: 'bookings', label: '/bookings routes (customer mobile)', match: /^\/(api\/)?(v1\/)?bookings(\/|$)/ },
  { key: 'addressSuggestions', label: '/location/address-suggestions', match: /address-suggestions/ },
  { key: 'addressDetails', label: '/location/address-details', match: /address-details/ },
  { key: 'auth', label: '/auth/ routes', match: /^\/(api\/)?(v1\/)?auth\// },
  { key: 'admin', label: '/admin/ routes (provider web + admin)', match: /^\/(api\/)?(v1\/)?admin\// },
];

const FLOOR_FILE = path.join(REPO_ROOT, 'scripts', 'protected-routes.floor.json');

const countsOf = (routes: MountedRoute[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const c of CONTRACTS) out[c.key] = routes.filter((r) => c.match.test(r.fullPath)).length;
  return out;
};

const main = (): void => {
  const freeze = process.argv.includes('--freeze');
  const routes = buildMountedRoutes();
  const counts = countsOf(routes);

  if (freeze) {
    fs.writeFileSync(FLOOR_FILE, JSON.stringify(counts, null, 2) + '\n');
    console.log(`[guard-contracts] froze ${CONTRACTS.length} contract floors from ${routes.length} mounted routes.`);
    return;
  }

  const floor: Record<string, number> = fs.existsSync(FLOOR_FILE)
    ? JSON.parse(fs.readFileSync(FLOOR_FILE, 'utf8'))
    : {};

  let failures = 0;
  console.log(`[guard-contracts] ${routes.length} mounted routes`);
  for (const c of CONTRACTS) {
    const n = counts[c.key];
    const f = floor[c.key] ?? 1;
    if (n === 0) {
      console.error(`  ✗ MISSING: ${c.label} — no mounted route matches`);
      failures++;
    } else if (n < f) {
      console.error(`  ✗ REMOVED: ${c.label} — ${n} mounted, floor is ${f}`);
      failures++;
    } else {
      console.log(`  ✓ ${c.label} — ${n} mounted${n > f ? ` (floor ${f})` : ''}`);
    }
  }

  if (failures === 0) {
    console.log('[guard-contracts] All protected route contracts verified.');
    return;
  }
  console.error(
    `[guard-contracts] ${failures} protected contract(s) missing or reduced. DO NOT deploy.\n` +
      '  If the removal is deliberate, re-freeze in the same commit:\n' +
      '    npm run guard:protected-contracts -- --freeze',
  );
  process.exit(1);
};

main();
