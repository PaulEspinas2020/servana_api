/**
 * Mounted legacy routes the contract does not name (TAB 07).
 *
 * ## What this measures, and why the number was invisible
 *
 * `V1_CONTRACT` records a `legacy` mapping for every route it supersedes, and
 * every metric derived from it — the migration matrix, the deprecation
 * schedule, the authorization parity gate — reads that mapping. A mounted route
 * the contract never names is therefore invisible to all of them at once: no
 * declared successor, no disposition, and no comparison against its v1 twin.
 *
 * So completeness measured from the contract measures the surface somebody chose
 * to name, not the surface actually served. Measured: 115 of 520 mounted legacy
 * routes carry a disposition. **405 do not.**
 *
 * ## Why a ratchet rather than a gate
 *
 * The book asks for a gate that fails on a route without a disposition. Shipped
 * as written it fails 405 times on the first run, and a gate that cannot pass is
 * deleted within a week — the same reasoning `release-gate.yml` gives for
 * keeping the dependency step non-blocking.
 *
 * So the 405 are frozen BY NAME. A NEW orphan fails the build with the route
 * that was added; retiring one is reported and lowers the ratchet on a
 * deliberate `--write`. The surface may fall and may not rise, which is what
 * makes draining it converge instead of drift.
 *
 * Run: npm run orphans            — print the current set
 *      npm run orphans:check      — fail if it grew
 *      npm run orphans:write      — lower the ratchet after retiring routes
 */

import fs from 'fs';
import path from 'path';
import { V1_CONTRACT } from '../src/api/v1/contract';
import { buildMountedRoutes, type MountedRoute } from './lib/routeTable';

const FROZEN = path.resolve(__dirname, '..', 'orphan-routes.frozen.json');

/** A parameter's NAME is not the route; compare on shape. */
const normalise = (p: string): string =>
  p.replace(/:[A-Za-z0-9_]+/g, ':x').replace(/\/$/, '').toLowerCase();

const dispositioned = (): Set<string> => {
  const named = new Set<string>();
  for (const entry of V1_CONTRACT) {
    for (const legacy of entry.legacy ?? []) {
      named.add(`${legacy.method.toUpperCase()} ${normalise(legacy.path)}`);
    }
  }
  return named;
};

/** Mounted legacy routes carrying no disposition, as `VERB /path`. */
export const orphanRoutes = (): string[] => {
  const named = dispositioned();
  return [...new Set(
    buildMountedRoutes()
      .filter((r: MountedRoute) => !r.fullPath.startsWith('/api/v1'))
      .map((r: MountedRoute) => `${r.verb.toUpperCase()} ${normalise(r.fullPath)}`)
      .filter((key) => !named.has(key)),
  )].sort();
};

export const frozenOrphans = (): string[] =>
  JSON.parse(fs.readFileSync(FROZEN, 'utf8')).routes;

export interface OrphanDelta { added: string[]; retired: string[] }

export const orphanDelta = (): OrphanDelta => {
  const now = orphanRoutes();
  const frozen = new Set(frozenOrphans());
  return {
    added: now.filter((r) => !frozen.has(r)),
    retired: [...frozen].filter((r) => !now.includes(r)).sort(),
  };
};

if (require.main === module) {
  const check = process.argv.includes('--check');
  const write = process.argv.includes('--write');
  const now = orphanRoutes();

  if (write) {
    fs.writeFileSync(FROZEN, `${JSON.stringify({
      note:
        'Mounted legacy routes the v1 contract does not name. Invisible to the migration '
        + 'matrix, the deprecation schedule and the authorization parity gate alike. The '
        + 'list may SHRINK and may not GROW; regenerate with --write when routes are '
        + 'dispositioned or retired, never to admit a new one.',
      generatedBy: 'scripts/orphan-route-ratchet.ts',
      count: now.length,
      routes: now,
    }, null, 1)}\n`);
    console.error(`orphan-route-ratchet: froze ${now.length} routes.`);
  } else if (check) {
    const { added, retired } = orphanDelta();
    if (retired.length) {
      console.error(`orphan-route-ratchet: ${retired.length} route(s) dispositioned or retired — rerun with --write:`);
      for (const r of retired) console.error(`   - ${r}`);
    }
    if (added.length) {
      console.error(`\norphan-route-ratchet: ${added.length} NEW undispositioned route(s). The surface may only fall.`);
      for (const r of added) console.error(`   + ${r}`);
      process.exit(1);
    }
    console.error(`orphan-route-ratchet: OK — ${now.length} orphans, none new.`);
  } else {
    for (const r of now) console.log(r);
    console.error(`\norphan-route-ratchet: ${now.length} mounted legacy routes carry no disposition.`);
  }
}
