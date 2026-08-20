/**
 * Authorization parity — routes that reach the same domain capability must be
 * guarded the same way (TAB 01).
 *
 * ## The class of defect this closes
 *
 * `POST /api/admin/disbursements/:id/retry` and
 * `POST /api/admin/finance/payouts/:id/retry` operated the same disbursement
 * rows. One required `payouts.retry_failed` and wrote an audit record; the
 * other required nothing and wrote nothing. Every individual route looked
 * reasonable. The bypass only exists in the RELATIONSHIP between them, which is
 * exactly the shape no per-route review catches.
 *
 * A guard is only as strong as the weakest path to the capability behind it, so
 * the property worth asserting is not "this route has a permission" but "every
 * route that can reach this domain function demands the same permission".
 *
 * ## Why this derives the mapping instead of restating it
 *
 * The obvious implementation is a hand-written table of route → permission,
 * checked against the routes. That table is a SECOND statement of the same
 * fact, and a reassembled predicate can be wider than the real one — it would
 * describe a system that does not exist and go green while doing it.
 *
 * So everything here is read out of the source that Express actually uses:
 *
 *   route table   →  `buildMountedRoutes()`, the same reader `authz:legacy` and
 *                    the shadowed-route gate already trust
 *   permissions   →  the literal inside `requirePermission('…')` in the route's
 *                    own handler chain
 *   capability    →  route → controller export → the service functions that
 *                    export's body actually calls
 *
 * If somebody adds a third route to `retryPayout`, this finds it without being
 * told, because nothing here contains a list of routes.
 *
 * ## What it deliberately cannot see
 *
 * Authorization performed INSIDE a handler, permissions resolved through a
 * variable rather than a literal, and service calls made through a value rather
 * than a namespaced call expression. Each would make a route look LESS guarded
 * than it is, so the failure mode is a false alarm a reader can dismiss, never
 * a bypass that slips through. That asymmetry is the design, not a limitation
 * to be apologised for.
 */

import fs from 'fs';
import path from 'path';
import { buildMountedRoutes, REPO_ROOT, type MountedRoute } from './routeTable';

const read = (abs: string): string => fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');

/** `import * as alias from './rel'` and `import alias from './rel'`. */
function namespaceImports(source: string, fromFileAbs: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /import\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const [, alias, spec] = m;
    if (!spec.startsWith('.')) continue;
    const abs = path.resolve(path.dirname(fromFileAbs), spec);
    out.set(alias, abs);
  }
  return out;
}

/** Resolve a module path with no extension to a real `.ts` file. */
function resolveTs(absNoExt: string): string | null {
  for (const cand of [`${absNoExt}.ts`, path.join(absNoExt, 'index.ts')]) {
    if (fs.existsSync(cand)) return cand;
  }
  return null;
}

/**
 * The body of one exported controller function.
 *
 * Bounded by the next top-level `export` (column 0) rather than by brace
 * counting, because brace counting over source containing strings, regexes and
 * template literals is its own bug surface — and the boundary only has to be
 * good enough to attribute calls to the right export.
 */
function exportBody(source: string, name: string): string | null {
  const patterns = [
    new RegExp(`^export\\s+const\\s+${name}\\s*=`, 'm'),
    new RegExp(`^export\\s+(?:async\\s+)?function\\s+${name}\\s*[(<]`, 'm'),
  ];
  for (const p of patterns) {
    const m = p.exec(source);
    if (!m) continue;
    const start = m.index;
    const rest = source.slice(start + m[0].length);
    const nextExport = rest.search(/^export\s/m);
    return nextExport === -1 ? rest : rest.slice(0, nextExport);
  }
  return null;
}

export interface RouteCapability {
  verb: string;
  fullPath: string;
  routeFile: string;
  line: number;
  /** Permission literals demanded in the handler chain, sorted. */
  permissions: string[];
  /** `services/foo.ts#bar` for every domain function the handler can reach. */
  capabilities: string[];
  /** Present when the controller could not be resolved — reported, not hidden. */
  unresolved?: string;
}

const PERM_RE = /requirePermission\(\s*['"]([^'"]+)['"]\s*\)/g;
const ANY_PERM_RE = /requireAnyPermission\(\s*\[([^\]]*)\]/g;
const ALL_PERM_RE = /requireAllPermissions\(\s*\[([^\]]*)\]/g;

function permissionsOf(handlers: string[]): string[] {
  const chain = handlers.join(' , ');
  const found = new Set<string>();
  for (const re of [PERM_RE, ANY_PERM_RE, ALL_PERM_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(chain))) {
      for (const lit of m[1].match(/['"]([^'"]+)['"]/g) ?? [`'${m[1]}'`]) {
        found.add(lit.replace(/['"]/g, ''));
      }
    }
  }
  return [...found].sort();
}

/** Which service modules count as a domain capability worth policing. */
export const DOMAIN_DIRS = ['src/services/'];

export function buildRouteCapabilities(
  routes: MountedRoute[] = buildMountedRoutes()
): RouteCapability[] {
  const controllerCache = new Map<string, { src: string; imports: Map<string, string> }>();

  return routes.map((r): RouteCapability => {
    const base: RouteCapability = {
      verb: r.verb,
      fullPath: r.fullPath,
      routeFile: r.file,
      line: r.line,
      permissions: permissionsOf(r.handlers),
      capabilities: [],
    };

    // The handler is the last chain entry that looks like `alias.member`.
    const handlerExpr = [...r.handlers].reverse().find((h) => /^[A-Za-z_$][\w$]*\.[\w$]+$/.test(h));
    if (!handlerExpr) return { ...base, unresolved: 'no namespaced handler expression' };

    const [alias, fnName] = handlerExpr.split('.');
    const routeAbs = path.join(REPO_ROOT, r.file);
    const routeSrc = read(routeAbs);
    const ctrlNoExt = namespaceImports(routeSrc, routeAbs).get(alias);
    if (!ctrlNoExt) return { ...base, unresolved: `no import for '${alias}'` };

    const ctrlAbs = resolveTs(ctrlNoExt);
    if (!ctrlAbs) return { ...base, unresolved: `unresolved module for '${alias}'` };

    let entry = controllerCache.get(ctrlAbs);
    if (!entry) {
      const src = read(ctrlAbs);
      entry = { src, imports: namespaceImports(src, ctrlAbs) };
      controllerCache.set(ctrlAbs, entry);
    }

    const body = exportBody(entry.src, fnName);
    if (body === null) return { ...base, unresolved: `no export '${fnName}' in controller` };

    // Namespaced service calls inside the export body.
    const caps = new Set<string>();
    for (const [svcAlias, svcNoExt] of entry.imports) {
      const svcAbs = resolveTs(svcNoExt);
      if (!svcAbs) continue;
      const svcRel = path.relative(REPO_ROOT, svcAbs).split(path.sep).join('/');
      if (!DOMAIN_DIRS.some((d) => svcRel.startsWith(d))) continue;

      const callRe = new RegExp(`\\b${svcAlias}\\.([\\w$]+)\\s*\\(`, 'g');
      let c: RegExpExecArray | null;
      while ((c = callRe.exec(body))) caps.add(`${svcRel}#${c[1]}`);
    }

    return { ...base, capabilities: [...caps].sort() };
  });
}

export interface Divergence {
  capability: string;
  routes: Array<{ verb: string; fullPath: string; permissions: string[] }>;
}

/**
 * Capabilities reached by two or more routes whose permission sets disagree.
 *
 * Set EQUALITY, not overlap. A route demanding a superset is still a different
 * answer to "who may do this", and the looser of the two is the one that gets
 * used.
 */
export function findDivergences(caps: RouteCapability[] = buildRouteCapabilities()): Divergence[] {
  const byCapability = new Map<string, RouteCapability[]>();
  for (const rc of caps) {
    for (const cap of rc.capabilities) {
      const list = byCapability.get(cap) ?? [];
      list.push(rc);
      byCapability.set(cap, list);
    }
  }

  const out: Divergence[] = [];
  for (const [capability, list] of byCapability) {
    if (list.length < 2) continue;
    const shapes = new Set(list.map((r) => r.permissions.join('+')));
    if (shapes.size === 1) continue;
    out.push({
      capability,
      routes: list.map((r) => ({ verb: r.verb, fullPath: r.fullPath, permissions: r.permissions })),
    });
  }
  return out.sort((a, b) => a.capability.localeCompare(b.capability));
}

// ── Permission closure ───────────────────────────────────────────────────────

/**
 * The catalogue's `requires` chain, read from source.
 *
 * Permission-set EQUALITY is the wrong predicate, and the first run of this
 * analyzer proved it by flagging a pair that is not a defect:
 *
 *   POST /api/admin/disbursements/:id/retry        payouts.retry_failed
 *   GET  /api/admin/finance/payouts/:disbursementId payouts.details.view
 *
 * Both reach `getPayoutDetail`, with different permissions — but the catalogue
 * declares `payouts.retry_failed` as `requires: ['payouts.view',
 * 'payouts.details.view']`, so nobody can hold the first without the second.
 * The sets differ; the ACCESS does not. Comparing raw sets would have made this
 * gate cry wolf on its first day, which is how a gate gets switched off.
 *
 * Read statically rather than imported: `adminPermissionService` constructs a
 * pg Pool at module load, and an analyzer that reads source must not open a
 * database to answer a question about a text file.
 */
export function permissionRequires(): Map<string, string[]> {
  const src = read(path.join(REPO_ROOT, 'src', 'services', 'adminPermissionService.ts'));
  const out = new Map<string, string[]>();
  const seedRe = /\{\s*key:\s*'([^']+)'[^}]*?requires:\s*\[([^\]]*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = seedRe.exec(src))) {
    const deps = (m[2].match(/'([^']+)'/g) ?? []).map((d) => d.replace(/'/g, ''));
    out.set(m[1], deps);
  }
  return out;
}

/** A permission plus everything holding it necessarily implies. */
export function closureOf(permissions: string[], requires = permissionRequires()): Set<string> {
  const seen = new Set<string>();
  const stack = [...permissions];
  while (stack.length) {
    const key = stack.pop() as string;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const dep of requires.get(key) ?? []) stack.push(dep);
  }
  return seen;
}

// ── The two properties this gate asserts ─────────────────────────────────────

/** Modules where reaching a function means touching money. */
export const MONEY_MODULES = [
  'src/services/disbursement.service.ts',
  'src/services/adminFinanceService.ts',
  'src/services/finance/',
];

export const touchesMoney = (rc: RouteCapability): boolean =>
  rc.capabilities.some((c) => MONEY_MODULES.some((m) => c.startsWith(m)));

/**
 * PROPERTY A — deny by default on money.
 *
 * Every route that can reach a money-domain function must demand at least one
 * named permission. This is the property F-01 actually violated: the four
 * disbursement routes reached `processPendingDisbursements` and `manualRetry`
 * behind a role check and nothing else.
 *
 * Stated as "at least one named permission" rather than "the right one",
 * because which permission is right is a judgement and whether there is one at
 * all is not.
 */
export function moneyRoutesWithoutPermission(
  caps: RouteCapability[] = buildRouteCapabilities()
): RouteCapability[] {
  return caps.filter((rc) => touchesMoney(rc) && rc.permissions.length === 0);
}

export interface IncomparablePair {
  capability: string;
  a: { verb: string; fullPath: string; permissions: string[] };
  b: { verb: string; fullPath: string; permissions: string[] };
}

/**
 * PROPERTY B — two routes to one money capability must be ordered.
 *
 * For every money-domain function reached by more than one route, one route's
 * permission closure must CONTAIN the other's. Containment, not equality: a
 * mutation that reads its own row back legitimately demands more than the plain
 * read does, and that is a stricter guard rather than a divergent one.
 *
 * What this refuses is INCOMPARABLE guards — each demanding something the other
 * does not — because then each is a way around the other and there is no answer
 * to "who may do this" that both agree on.
 */
export function incomparableMoneyGuards(
  caps: RouteCapability[] = buildRouteCapabilities()
): IncomparablePair[] {
  const requires = permissionRequires();
  const byCapability = new Map<string, RouteCapability[]>();

  for (const rc of caps) {
    if (!touchesMoney(rc)) continue;
    for (const cap of rc.capabilities) {
      if (!MONEY_MODULES.some((m) => cap.startsWith(m))) continue;
      const list = byCapability.get(cap) ?? [];
      list.push(rc);
      byCapability.set(cap, list);
    }
  }

  const out: IncomparablePair[] = [];
  for (const [capability, list] of byCapability) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const ca = closureOf(list[i].permissions, requires);
        const cb = closureOf(list[j].permissions, requires);
        const aContainsB = [...cb].every((p) => ca.has(p));
        const bContainsA = [...ca].every((p) => cb.has(p));
        if (aContainsB || bContainsA) continue;
        out.push({
          capability,
          a: { verb: list[i].verb, fullPath: list[i].fullPath, permissions: list[i].permissions },
          b: { verb: list[j].verb, fullPath: list[j].fullPath, permissions: list[j].permissions },
        });
      }
    }
  }
  return out;
}

// ── Guard detection for the admin matrix (TAB 10) ────────────────────────────

/**
 * Every form of authorization a route chain can carry.
 *
 * The first version of `permissionsOf` read only `requirePermission('…')`, and
 * on the admin surface that under-reported protection on eleven routes: the
 * whole permission-GRANTING path is guarded by `requireSuperAdmin`, which is
 * strictly stricter than any named permission — super admins bypass
 * `requirePermission`, so demanding super-admin status is the stronger claim.
 *
 * The book warns about exactly this: *a route-auth detector that only reads the
 * route line under-reports protection and over-reports gaps*. A matrix that
 * called the grant path unguarded would send somebody to "fix" the strictest
 * routes in the application.
 */
export interface RouteGuards {
  /** `verifyRoles([...])` present. */
  roleGuard: boolean;
  /** Named permissions demanded. */
  permissions: string[];
  /** `requireSuperAdmin` — stricter than any named permission. */
  superAdmin: boolean;
  /** `verifyAuth` present. */
  authenticated: boolean;
}

export function guardsOf(handlers: string[], routeFileSource: string): RouteGuards {
  // `...adminOnly` and friends hide the guards in a module-local array.
  const expanded = handlers.flatMap((h) => {
    const spread = /^\.\.\.([A-Za-z_$][\w$]*)$/.exec(h.trim());
    if (!spread) return [h.trim()];
    const decl = new RegExp(`const\\s+${spread[1]}\\s*=\\s*\\[`).exec(routeFileSource);
    if (!decl) return [h.trim()];
    let depth = 1;
    let i = decl.index + decl[0].length;
    const open = i;
    for (; i < routeFileSource.length && depth > 0; i += 1) {
      const c = routeFileSource[i];
      if (c === '[' || c === '(') depth += 1;
      else if (c === ']' || c === ')') depth -= 1;
    }
    return routeFileSource.slice(open, i - 1).split(',').map((p) => p.trim()).filter(Boolean);
  });

  const chain = expanded.join(' , ');
  return {
    roleGuard: /verifyRoles\s*\(/.test(chain),
    permissions: permissionsOf(expanded),
    superAdmin: /requireSuperAdmin/.test(chain),
    authenticated: /verifyAuth/.test(chain),
  };
}
