/**
 * Authorization for every LEGACY route, and whether v1 loosened it (TAB 04).
 *
 * ## The gap
 *
 * TAB 04's acceptance includes "every route has a machine-readable access rule"
 * and "no v1 successor is less restrictive than its legacy endpoint". The first
 * is true of v1 — `ContractEntry.auth` — and false of the legacy tree, where
 * authorization is whatever middleware happens to sit in the handler chain.
 *
 * The second was therefore uncheckable: `LegacyMapping` records method, path,
 * disposition and a note, and nothing about who may call it. So a v1 endpoint
 * could be `public` while the legacy route it supersedes required a provider
 * role, and no gate anywhere would notice.
 *
 * This derives the legacy rule from the mounted handler chain and compares.
 *
 * ## How the rule is derived
 *
 * From the middleware NAMES in the chain, which is how Express actually decides:
 *
 *   verifyRoles([1])        admin
 *   requireProviderRole     provider
 *   verifyAuth              authenticated
 *   none of the above       public
 *
 * A chain carrying several is reported at its STRICTEST, because that is what
 * the request has to survive.
 *
 * ## What it cannot see
 *
 * Authorization performed INSIDE a handler — an ownership check against
 * `req.user.uid`, a capability lookup — is invisible here. So `public` means
 * "no auth middleware", not "unprotected", and the report says so rather than
 * implying a vulnerability it has not established.
 *
 * Run: npm run authz:legacy
 */

import { buildMountedRoutes, type MountedRoute } from './lib/routeTable';
import { V1_CONTRACT, V1_PREFIX, type AuthMode } from '../src/api/v1/contract';
import { objectScopedEntries } from '../src/api/v1/authzMatrix';

/** Entries the authz matrix already knows carry an object identifier. */
const OBJECT_SCOPED_IDS = new Set(objectScopedEntries().map((e) => e.id));

/**
 * Self-scoped entries whose PATH does not say so.
 *
 * `/me/...` announces self-scoping in the path and is exempted by shape. These
 * do the same thing from `/settings/...`: the handler resolves the subject with
 * `actorOf(req)`, so an authenticated caller reads and writes only their own
 * row and the `provider` bar the legacy route carried would merely refuse a
 * customer their own settings.
 *
 * Listed by id rather than by widening the path rule, because "starts with
 * /settings" is a guess about every future entry and this is a statement about
 * two that were read.
 */
const SELF_SCOPED_IDS = new Set([
  'settings.notificationPreferences.get',
  'settings.notificationPreferences.put',
]);

/** Strictest first. A chain is reported at the lowest index it matches. */
const LADDER: Array<{ mode: AuthMode; matches: RegExp }> = [
  { mode: 'admin', matches: /\bverifyRoles\s*\(\s*\[\s*1\b/ },
  { mode: 'provider', matches: /\brequireProviderRole\b/ },
  { mode: 'authenticated', matches: /\bverifyAuth\b/ },
];

const STRICTNESS: Record<AuthMode, number> = {
  public: 0,
  authenticated: 1,
  provider: 2,
  admin: 3,
};

export const authOf = (route: MountedRoute): AuthMode => {
  const chain = route.handlers.join(' ');
  for (const rung of LADDER) if (rung.matches.test(chain)) return rung.mode;
  return 'public';
};

/** Path shapes differ between the trees; a parameter's NAME is not the route. */
const normalise = (p: string): string =>
  p.replace(/:[A-Za-z0-9_]+/g, ':x').replace(/\/$/, '').toLowerCase();

export interface Loosening {
  legacyPath: string;
  legacyAuth: AuthMode;
  v1Id: string;
  v1Path: string;
  v1Auth: AuthMode;
}

/** v1 entries whose superseded legacy route demanded MORE than they do. */
export const loosenings = (): Loosening[] => {
  const mounted = buildMountedRoutes();
  const byPath = new Map<string, MountedRoute>();
  for (const route of mounted) {
    // First mount wins, matching Express resolution order.
    const key = `${route.verb.toUpperCase()} ${normalise(route.fullPath)}`;
    if (!byPath.has(key)) byPath.set(key, route);
  }

  const found: Loosening[] = [];
  for (const entry of V1_CONTRACT) {
    for (const legacy of entry.legacy ?? []) {
      /**
       * Only a SUPERSESSION can be a loosening.
       *
       * `ROLE_SPECIFIC` means the legacy route is retained precisely because it
       * is a different operation — `POST /api/auth/add-employees` is an admin
       * bulk-PROVISIONING route whose note says so, and comparing its `admin`
       * bar against public self-registration reads as a privilege escalation
       * that does not exist. `KEEP` is not a supersession either.
       */
      if (legacy.disposition === 'ROLE_SPECIFIC' || legacy.disposition === 'KEEP') continue;

      const key = `${legacy.method.toUpperCase()} ${normalise(legacy.path)}`;
      const route = byPath.get(key);
      if (!route) continue; // Not mounted today — nothing to compare against.

      const legacyAuth = authOf(route);
      if (STRICTNESS[legacyAuth] <= STRICTNESS[entry.auth]) continue;

      /**
       * A lower ROLE bar is not automatically a loosening.
       *
       * The convergence this command asks for turns role-scoped legacy routes
       * into self- or object-scoped canonical ones: `/api/provider/
       * notification-preferences` (provider only) becomes `/api/v1/me/
       * notification-preferences` (any authenticated caller, scoped to their
       * own uid). Demanding `provider` there would refuse a customer their own
       * settings, which is the opposite of the goal.
       *
       * So a successor is exempt when it is scoped by something other than
       * role:
       *
       *   /me/…            self-scoped by the authenticated uid
       *   object-scoped    carries a :bookingId or similar, and the domain
       *                    service asserts access to THAT object
       *
       * What remains is the real case: a v1 route that dropped the role bar and
       * put nothing in its place.
       */
      const selfScoped =
        entry.path.startsWith('/me/') || entry.path === '/me' || SELF_SCOPED_IDS.has(entry.id);
      const objectScoped = OBJECT_SCOPED_IDS.has(entry.id);
      if (selfScoped || objectScoped) continue;

      {
        found.push({
          legacyPath: `${legacy.method.toUpperCase()} ${legacy.path}`,
          legacyAuth,
          v1Id: entry.id,
          v1Path: `${entry.method.toUpperCase()} ${V1_PREFIX}${entry.path}`,
          v1Auth: entry.auth,
        });
      }
    }
  }
  return found;
};

if (require.main === module) {
  const mounted = buildMountedRoutes();
  const counts = new Map<AuthMode, number>();
  for (const route of mounted) {
    const mode = authOf(route);
    counts.set(mode, (counts.get(mode) ?? 0) + 1);
  }

  // eslint-disable-next-line no-console
  const log = console.log;
  log('Legacy authorization inventory (TAB 04)\n');
  log(`  mounted legacy routes    ${mounted.length}`);
  for (const mode of ['public', 'authenticated', 'provider', 'admin'] as AuthMode[]) {
    log(`    ${mode.padEnd(15)} ${counts.get(mode) ?? 0}`);
  }
  log('\n  "public" means no auth MIDDLEWARE. A handler may still check');
  log('  ownership internally, which this cannot see.\n');

  const loose = loosenings();
  log(`  v1 successors LESS restrictive than the route they supersede: ${loose.length}`);
  for (const l of loose) {
    log(`    ${l.legacyPath}  (${l.legacyAuth})`);
    log(`      -> ${l.v1Path}  (${l.v1Auth})   [${l.v1Id}]`);
  }

  process.exitCode = loose.length ? 1 : 0;
}
