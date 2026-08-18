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
  /**
   * `DELETE /api/provider/notifications/:key` → `DELETE /api/v1/notifications/:key`.
   *
   * Read before listing, because an exemption granted on the strength of a
   * pattern is how a real loosening gets waved through:
   *
   *   - the handler takes no account identifier. `actorOf(req)` resolves the
   *     uid from the verified token and the role from `user_credentials`; no
   *     path, query or body field names whose inbox is being touched.
   *   - `notificationInbox.dismiss` picks the STORE from that role, and both
   *     statements are owner-predicated —
   *     `WHERE notification_key = $1 AND worker_uid = $2` for a provider,
   *     `... AND user_uid = $2` for a customer.
   *
   * So `provider` on the successor would not protect anything; it would refuse
   * a CUSTOMER the ability to dismiss their own notification — which they have
   * never had, because the legacy route is provider-only and reaches
   * `provider_notifications` directly.
   *
   * Its four siblings — list, unread-count, markRead, markAllRead — are already
   * `authenticated` and equally self-scoped. They do not appear here only
   * because their `legacy[]` names the `/api/user/...` spelling, which was
   * `authenticated` too. This entry names the PROVIDER route because that is
   * the one Worker Mobile actually calls and the one being retired.
   *
   * Proven by `tests/notification-dismiss-store.test.ts`, which asserts the
   * store routing per role and that no other store is touched on the way.
   */
  'notifications.dismiss',
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

/**
 * Capabilities the legacy chain demands, by NAME.
 *
 * ## Why the ladder alone could not see this
 *
 * `authOf` reports a chain at its strictest ROLE rung, and its vocabulary is
 * `verifyRoles`, `requireProviderRole`, `verifyAuth`. `requireCapability` is not
 * in it, so a chain of
 *
 *   [verifyAuth, requireProviderRole, requireCapability("canViewEarnings")]
 *
 * resolves to `provider` — indistinguishable from a v1 entry declaring
 * `auth: 'provider'` and nothing else. `STRICTNESS[legacy] <= STRICTNESS[v1]`
 * is then true, the comparison short-circuits, and a removed enforcement point
 * reads as parity.
 *
 * That is not a hypothetical: the three v1 earnings endpoints were mounted
 * without the capability their live legacy aliases require, and this gate
 * reported zero loosenings throughout.
 *
 * A capability is ORTHOGONAL to the role ladder rather than another rung on it —
 * a request can be required to be a provider AND to hold a capability — so it is
 * compared as its own dimension instead of being folded into STRICTNESS, which
 * would have lost which capability was dropped.
 */
const CAPABILITY_CALL = /\brequireCapability\s*\(\s*["'`]([A-Za-z0-9_]+)["'`]/g;

export const capabilitiesOf = (route: MountedRoute): string[] => {
  const chain = route.handlers.join(' ');
  const found = new Set<string>();
  for (const match of chain.matchAll(CAPABILITY_CALL)) found.add(match[1]);
  return [...found].sort();
};

export interface CapabilityLoosening {
  legacyPath: string;
  legacyCapabilities: string[];
  v1Id: string;
  v1Path: string;
  v1Capability: string | null;
  dropped: string[];
}

/**
 * v1 entries whose superseded legacy route demanded a capability they do not.
 *
 * The same supersession rule as `loosenings()`: `ROLE_SPECIFIC` and `KEEP` are
 * not supersessions, so they are not compared.
 */
export const capabilityLoosenings = (): CapabilityLoosening[] => {
  const mounted = buildMountedRoutes();
  const byPath = new Map<string, MountedRoute>();
  for (const route of mounted) {
    const key = `${route.verb.toUpperCase()} ${normalise(route.fullPath)}`;
    if (!byPath.has(key)) byPath.set(key, route);
  }

  const found: CapabilityLoosening[] = [];
  for (const entry of V1_CONTRACT) {
    for (const legacy of entry.legacy ?? []) {
      if (legacy.disposition === 'ROLE_SPECIFIC' || legacy.disposition === 'KEEP') continue;

      const route = byPath.get(`${legacy.method.toUpperCase()} ${normalise(legacy.path)}`);
      if (!route) continue;

      const legacyCapabilities = capabilitiesOf(route);
      if (!legacyCapabilities.length) continue;

      const declared = (entry as { capability?: string }).capability ?? null;
      const dropped = legacyCapabilities.filter((c) => c !== declared);
      if (!dropped.length) continue;

      found.push({
        legacyPath: `${legacy.method.toUpperCase()} ${legacy.path}`,
        legacyCapabilities,
        v1Id: entry.id,
        v1Path: `${entry.method.toUpperCase()} /api/v1${entry.path}`,
        v1Capability: declared,
        dropped,
      });
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

  const capLoose = capabilityLoosenings();
  log(`\n  v1 successors that DROPPED a capability the legacy route requires: ${capLoose.length}`);
  for (const l of capLoose) {
    log(`    ${l.legacyPath}  requires ${l.legacyCapabilities.join(', ')}`);
    log(`      -> ${l.v1Path}  declares ${l.v1Capability ?? 'none'}   [${l.v1Id}]`);
    log(`         DROPPED: ${l.dropped.join(', ')}`);
  }

  process.exitCode = loose.length || capLoose.length ? 1 : 0;
}
