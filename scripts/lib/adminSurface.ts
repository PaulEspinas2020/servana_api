/**
 * The legacy admin surface, derived — never authored.
 *
 * ## Why this exists
 *
 * The Admin API Master Command (TAB 01) reports that the admin portal reaches
 * "51+ admin endpoints" and calls that a floor, because seventeen of its call
 * sites build their URL in a way a static scan could not resolve. Measured from
 * this side — the routers themselves rather than one client's call sites — the
 * surface is 251 operations. The book's floor was a floor on what ONE CLIENT
 * COULD BE SEEN TO CALL, which is a different quantity, and its acceptance
 * criterion of "at least 51" would have certified a surface 80% of which is
 * still undocumented.
 *
 * So the count is derived here, from `buildMountedRoutes()`, and no number in
 * this programme is written down by hand.
 *
 * ## Why the admin surface is NOT documented in openapi.v1.json
 *
 * `src/app.ts` exempts exactly six prefixes from `parityMiddleware`:
 * `/api/v1`, `/api/admin/catalog`, `/api/catalog`, `/healthz`, `/readyz`,
 * `/health`. Everything else — the large majority of the admin operations — has
 * alias keys INJECTED into its response on the way out: `first_name`,
 * `providerUid`, `level2`, `photoURL` and some forty more.
 *
 * app.ts already states the consequence, in the comment that justifies the v1
 * exemption: a middleware that adds keys to every response *"makes that document
 * false the moment it runs — the wire would carry fields the contract does not
 * declare, and a client generated from the spec would be reading a shape nobody
 * wrote down."*
 *
 * `openapi.v1.json`'s own description promises "the shapes below are exactly
 * what the wire carries". Folding the parity-rewritten operations into that
 * document would make that sentence false for the majority of it — and it is a
 * sentence five other clients generate code against. The admin surface
 * therefore gets its OWN document, which states the parity fact per operation
 * instead of hiding it.
 *
 * ## What is derived and what is declared
 *
 * DERIVED (cannot drift, because nothing hand-writes it):
 *   path, method, area, source file and line, the middleware chain,
 *   the guard ladder, the named permission, whether parity rewrites it.
 *
 * DECLARED (authored, and each one carries a reason):
 *   response schemas — see `src/api/admin/adminResponses.ts`
 *   handler-enforced guards the chain cannot show — `HANDLER_GUARDS` below.
 *
 * ## The guard ladder, and why `requireSuperAdmin` is on it
 *
 * A first version of this reader classified by `requirePermission` alone and
 * reported 17 admin operations as unguarded, 11 of them under
 * `/api/admin/admin-users/*` — the routes that create admins and grant
 * permissions. That reading was wrong. Those eleven carry `requireSuperAdmin`,
 * which is STRICTER than any named permission, and the detector simply had no
 * word for it. A gate with no word for a guard reports its absence.
 */

import fs from 'fs';
import path from 'path';
import { buildMountedRoutes, MountedRoute, REPO_ROOT, splitTopLevelArgs } from './routeTable';

export const ADMIN_PREFIX = '/api/admin';

export type AdminGuard =
  /** `requireSuperAdmin`. Stricter than any named permission. */
  | 'super-admin'
  /** Role 1 plus a named permission the chain declares. */
  | 'permission'
  /** Role 1, no named permission on the chain. */
  | 'admin-role'
  /** A verified identity only. The handler is then the sole authority. */
  | 'authenticated';

export interface AdminOperation {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  /** Full path as mounted, including `/api`. */
  path: string;
  /** Second path segment after /api/admin — the blast-radius bucket. */
  area: string;
  /** Repo-relative source, with line. */
  source: string;
  guard: AdminGuard;
  /** The named permission, when the chain declares one. */
  permission?: string;
  /** Middleware chain, spreads resolved, whitespace-collapsed. */
  chain: string[];
  /** The controller expression that terminates the chain. */
  handler: string;
  /**
   * True when `parityMiddleware` injects alias keys into this response, so the
   * wire carries fields no schema declares.
   */
  parityRewritten: boolean;
  /** Set when the chain understates the real guard. See HANDLER_GUARDS. */
  handlerGuard?: string;
  /** The response envelope the handler writes, read from its body. */
  envelope: AdminEnvelope;
  /** Repo-relative controller module the handler resolves to. */
  controller?: string;
  /**
   * Top-level keys of the 2xx body, minus the wrapper key itself.
   *
   * `GET /api/admin/disbursements` answers `{ success: true, disbursements: […] }`
   * — not `data`. A caller reading `body.data` gets undefined, and nothing
   * anywhere says so today.
   */
  payloadKeys: string[];
}

/**
 * Routes whose middleware chain is WEAKER than what the handler enforces.
 *
 * Every entry here was found by reading the handler, not by reading the chain,
 * and each states what the handler actually does. A route may only appear here
 * with a reason, because the whole point of the derived table is that a guard
 * cannot be asserted into existence — this is the one place where a claim is
 * authored, so it is the one place that needs review.
 */
export const HANDLER_GUARDS: Record<string, string> = {
  'POST /api/admin/admin-users/bootstrap-super-admin':
    'Fail-closed in adminPermissionService.bootstrapSuperAdmin: one transaction behind ' +
    'pg_advisory_xact_lock, refuses when ANY super admin row exists (status-independent), ' +
    'and when admin_users is non-empty requires the caller to already be one of those ' +
    'admins. Denials are audited. It CANNOT carry a role gate: the first Super Admin ' +
    'cannot already be an admin, which is the chicken-and-egg the service documents.',
  'GET /api/admin/me/permissions':
    'Reads only the CALLER own permission set, keyed by req.user.uid. There is no ' +
    'target parameter, so a non-admin caller learns their own empty set and nothing else.',
};

const VERBS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/**
 * The prefixes `src/app.ts` exempts from `parityMiddleware`, read from the
 * source rather than imported.
 *
 * Importing `src/app.ts` starts an HTTP listener, opens a pg pool, initialises
 * Firebase Admin and registers cron jobs — the same reason `routeTable.ts`
 * reads source instead of requiring the app. Reading the literal keeps ONE
 * definition: if somebody edits the array, this reader follows it, and
 * `tests/admin-surface.test.ts` asserts the parse found a non-empty list that
 * still contains `/api/v1`.
 */
export function parityExemptPrefixes(
  appTsPath = path.join(REPO_ROOT, 'src', 'app.ts'),
): string[] {
  const src = fs.readFileSync(appTsPath, 'utf8');
  const m = /export const CANONICAL_CONTRACT_PREFIXES\s*=\s*\[([\s\S]*?)\]/.exec(src);
  if (!m) {
    throw new Error(
      'adminSurface: CANONICAL_CONTRACT_PREFIXES not found in src/app.ts. ' +
        'The parity-exemption list moved or was renamed; this reader must follow it ' +
        'rather than keep a stale copy.',
    );
  }
  return [...m[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map((x) => x[1] ?? x[2]);
}

/**
 * Local `const adminOnly = [...]` style arrays, so a `...adminOnly` spread in a
 * chain resolves to the middleware it actually names.
 *
 * Resolved PER FILE on purpose. Every admin router happens to define
 * `adminOnly` as `[verifyAuth, verifyRoles([1]), adminRateLimit]` today, and a
 * reader that assumed that would keep reporting role-1 for a file that quietly
 * changed its own definition.
 */
export function localChainConsts(absPath: string): Record<string, string[]> {
  const src = fs.readFileSync(absPath, 'utf8');
  const out: Record<string, string[]> = {};
  for (const m of src.matchAll(/const\s+(\w+)\s*=\s*\[/g)) {
    const open = m.index! + m[0].length - 1;
    const close = matchingBracket(src, open);
    if (close < 0) continue;
    const parts = splitTopLevelArgs(src.slice(open + 1, close))
      .map((s) => s.trim().replace(/\s+/g, ' '))
      .filter(Boolean);
    if (parts.length) out[m[1]] = parts;
  }
  return out;
}

/**
 * Index of the `]` closing the `[` at `open`, counting nesting and skipping
 * string literals.
 *
 * The first version of `localChainConsts` used `\[([^\]]*)\]` and was WRONG for
 * every admin router in the repository. `const adminOnly = [verifyAuth,
 * verifyRoles([1]), adminRateLimit]` contains a `]` inside `verifyRoles([1])`,
 * so the lazy character class stopped there and the spread resolved to
 * `['verifyAuth', 'verifyRoles([1']`. The truncated chain no longer matched
 * `verifyRoles(\[\s*1\s*\])`, and four role-1 routes — including the admin
 * notification list — were classified `authenticated`, i.e. reachable by any
 * signed-in customer.
 *
 * They are not. Reading `adminNotification.routes.ts` shows `...adminOnly` on
 * all three. The routes were correctly guarded and the READER was broken, which
 * is the more dangerous direction only because the opposite mistake is louder:
 * a generated document asserting "authenticated" over a role-1 route teaches
 * every client the wrong thing about who may call it.
 */
export function matchingBracket(src: string, open: number): number {
  const CLOSER: Record<string, string> = { '[': ']', '(': ')', '{': '}' };
  const want = CLOSER[src[open]];
  if (!want) return -1;

  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '[' || c === '(' || c === '{') depth++;
    else if (c === ']' || c === ')' || c === '}') {
      depth--;
      // Depth zero means this closer belongs to `open`. If it is the wrong
      // KIND of closer the source does not parse, so say "not found" rather
      // than hand back an index that means nothing.
      if (depth === 0) return c === want ? i : -1;
    }
  }
  return -1;
}

function resolveChain(route: MountedRoute): string[] {
  const consts = localChainConsts(path.join(REPO_ROOT, route.file));
  const out: string[] = [];
  for (const h of route.handlers) {
    const spread = /^\.\.\.(\w+)$/.exec(h.trim());
    if (spread && consts[spread[1]]) out.push(...consts[spread[1]]);
    else out.push(h.trim());
  }
  return out;
}

function classify(chain: string[]): { guard: AdminGuard; permission?: string } {
  const joined = chain.join(' ; ');
  const perm = /requirePermission\(\s*['"`]([^'"`]+)['"`]/.exec(joined);
  if (/\brequireSuperAdmin\b/.test(joined)) {
    return { guard: 'super-admin', permission: perm ? perm[1] : undefined };
  }
  const roleOne = /verifyRoles\(\s*\[\s*1\s*\]/.test(joined);
  if (perm) return { guard: 'permission', permission: perm[1] };
  if (roleOne) return { guard: 'admin-role' };
  return { guard: 'authenticated' };
}

export function buildAdminSurface(routes = buildMountedRoutes()): AdminOperation[] {
  const exempt = parityExemptPrefixes();
  const ops: AdminOperation[] = [];

  for (const r of routes) {
    const full = r.prefix + r.path;
    if (!full.startsWith(ADMIN_PREFIX)) continue;
    if (!(VERBS as readonly string[]).includes(r.verb)) continue;

    const chain = resolveChain(r);
    const { guard, permission } = classify(chain);
    const key = `${r.verb.toUpperCase()} ${full}`;
    const handler = chain.length ? chain[chain.length - 1] : '(none)';
    const { envelope, controller, payloadKeys } = deriveEnvelope(
      path.join(REPO_ROOT, r.file),
      handler,
    );

    ops.push({
      method: r.verb as AdminOperation['method'],
      path: full,
      area: full.split('/')[3] ?? '(root)',
      source: `${r.file}:${r.line}`,
      guard,
      permission,
      chain,
      handler,
      parityRewritten: !exempt.some((p) => full.startsWith(p)),
      handlerGuard: HANDLER_GUARDS[key],
      envelope,
      controller,
      payloadKeys,
    });
  }

  ops.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  return ops;
}

/** `METHOD /path` — the key every authored table in this programme uses. */
export const opKey = (o: Pick<AdminOperation, 'method' | 'path'>): string =>
  `${o.method.toUpperCase()} ${o.path}`;

// ─── envelope derivation ──────────────────────────────────────────────────────

/**
 * The success wrapper an admin handler writes.
 *
 * There are TWO in this tree, and the difference is not cosmetic: a client that
 * unwraps `body.data` reads `undefined` from every `success-flag` route, and a
 * client that branches on `body.status === 'success'` reads `undefined` from
 * every one of them too. Both are silent — no error, no exception, just an
 * empty screen. The document names which per operation so a caller does not
 * have to guess from the path.
 */
export type AdminEnvelope =
  /** `{ status: 'success', data: X }` — the dominant admin shape. */
  | 'status-success'
  /** `{ success: true, … }` — a BOOLEAN flag, and the payload key varies. */
  | 'success-flag'
  /** A 2xx body with neither wrapper. */
  | 'bare'
  /** Both wrappers appear on the 2xx paths of one handler. */
  | 'mixed'
  /**
   * The 2xx is not JSON at all. `POST /api/admin/communications/export` sets
   * `Content-Type: text/csv` and answers `res.send(csv)`. Calling that
   * "unknown" would invite a client to generate a JSON type for a CSV
   * download; naming it is the whole difference between a gap and a fact.
   */
  | 'non-json'
  /** The handler writes its 2xx through something this reader cannot follow. */
  | 'unknown';

/** `import * as ctrl from '../controllers/x'` / `import ctrl from …`, per file. */
export function controllerImports(absPath: string): Record<string, string> {
  const src = fs.readFileSync(absPath, 'utf8');
  const out: Record<string, string> = {};
  const re = /import\s+(?:\*\s+as\s+(\w+)|(\w+))\s+from\s+['"]([^'"]+)['"]/g;
  for (const m of src.matchAll(re)) {
    const alias = m[1] ?? m[2];
    if (alias && m[3].includes('controller')) out[alias] = m[3];
  }
  return out;
}

/**
 * The envelope a handler actually writes, read from the function body.
 *
 * Derived rather than assumed because the admin tree is NOT uniform: sixteen of
 * the seventeen admin controllers wrap every response as
 * `{ status: 'success', data }`, and `adminBookingDraftController` wraps none of
 * its fourteen. A document that declared one envelope for the whole surface
 * would be wrong for a whole area, and wrong in the direction that makes a
 * client unwrap a field that is not there.
 */
export function deriveEnvelope(
  routeFileAbs: string,
  handler: string,
): { envelope: AdminEnvelope; controller?: string; payloadKeys: string[] } {
  const m = /^(\w+)\.(\w+)$/.exec(handler.trim());
  if (!m) return { envelope: 'unknown', payloadKeys: [] };
  const [, alias, fnName] = m;

  const imports = controllerImports(routeFileAbs);
  const rel = imports[alias];
  if (!rel) return { envelope: 'unknown', payloadKeys: [] };

  const abs = path.resolve(path.dirname(routeFileAbs), rel) + '.ts';
  if (!fs.existsSync(abs)) return { envelope: 'unknown', payloadKeys: [] };

  const src = fs.readFileSync(abs, 'utf8');
  const fnRe = new RegExp(
    `export\\s+(?:async\\s+)?(?:function\\s+${fnName}\\b|const\\s+${fnName}\\s*[:=])`,
  );
  const start = src.search(fnRe);
  if (start < 0) return { envelope: 'unknown', controller: `${rel}.ts`, payloadKeys: [] };

  // To the next top-level `export` — good enough to bound one handler, and it
  // never reads bytes at fixed offsets, so a CRLF checkout cannot shift it.
  const rest = src.slice(start + 1);
  const next = rest.search(/\nexport\s/);
  const body = next < 0 ? rest : rest.slice(0, next);

  let statusSuccess = 0;
  let successFlag = 0;
  let bare = 0;
  const payloadKeys = new Set<string>();

  const account = (shape: string): void => {
    if (/status:\s*['"`]success['"`]/.test(shape)) statusSuccess++;
    else if (/success:\s*true\b/.test(shape)) successFlag++;
    else bare++;
    for (const k of topLevelKeys(shape)) {
      if (k !== 'status' && k !== 'success') payloadKeys.add(k);
    }
  };

  for (const shape of directJsonShapes(body)) account(shape);

  // A handler that never touches `res.json` itself may still answer through a
  // module-local responder. `adminAuditController` declares
  // `const ok = (res, data, meta) => res.status(200).json({ status: 'success', … })`
  // and all seven of its handlers return `ok(res, …)`. Reading only direct
  // `res.json` calls reported all seven as `unknown` — the envelope was there,
  // one call away, and the reader stopped at the first hop.
  if (!statusSuccess && !successFlag && !bare) {
    for (const [name, shape] of Object.entries(localResponders(src))) {
      if (new RegExp(`\\b${name}\\s*\\(\\s*res\\b`).test(body)) account(shape);
    }
  }

  const total = statusSuccess + successFlag + bare;
  if (!total) {
    // A non-JSON 2xx is a fact, not an absence. Detect it before giving up.
    if (/res\.send\(/.test(body) && /res\.setHeader\(\s*['"`]Content-Type/i.test(body)) {
      const ct = /res\.setHeader\(\s*['"`]Content-Type['"`]\s*,\s*['"`]([^'"`]+)/i.exec(body);
      return {
        envelope: 'non-json',
        controller: `${rel}.ts`,
        payloadKeys: ct ? [ct[1]] : [],
      };
    }
    return { envelope: 'unknown', controller: `${rel}.ts`, payloadKeys: [] };
  }
  const kinds = [statusSuccess, successFlag, bare].filter((n) => n > 0).length;
  const envelope: AdminEnvelope =
    kinds > 1
      ? 'mixed'
      : statusSuccess
        ? 'status-success'
        : successFlag
          ? 'success-flag'
          : 'bare';
  return { envelope, controller: `${rel}.ts`, payloadKeys: [...payloadKeys].sort() };
}

/**
 * Top-level keys of an object-literal source, ignoring nested objects.
 *
 * Shorthand counts. `res.json({ status: 'success', data })` is the single most
 * common success line in this tree, and a reader that required `key:` returned
 * `['status']` for it — so 239 operations reported an EMPTY payload key list
 * while the payload key was sitting right there. An always-empty field reads as
 * "there is nothing here", which is the opposite of what it meant.
 */
export function topLevelKeys(objectSrc: string): string[] {
  const body = objectSrc.trim().replace(/^\{/, '').replace(/\}$/, '');
  const out: string[] = [];
  for (const part of splitTopLevelArgs(body)) {
    const withColon = /^\s*(?:\.\.\.)?\s*['"`]?([A-Za-z_$][\w$]*)['"`]?\s*:/.exec(part);
    if (withColon) {
      out.push(withColon[1]);
      continue;
    }
    // `{ data }` — shorthand. `{ ...spread }` is deliberately not a key.
    const shorthand = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(part);
    if (shorthand) out.push(shorthand[1]);
  }
  return out;
}

/**
 * The argument source of every SUCCESS-path `res[.status(n)].json(<arg>)`.
 *
 * ## Why the status code has to be read
 *
 * The first version of this counted every `res.json` in the handler and
 * reported 37 operations as `mixed` — a single handler answering with two
 * different envelopes, which would be a genuine client-breaking hazard.
 *
 * It was a detector artifact. 28 of the 37 were in `providerCatalogController`,
 * whose handlers are perfectly consistent:
 *
 *     return res.status(200).json({ status: "success", data });
 *     return res.status(500).json({ status: "failed", message: … });
 *
 * The second line is the ERROR envelope. Counting it as a competing success
 * shape made a uniform controller look inconsistent, and would have put a
 * fabricated warning in front of every client team reading the document.
 *
 * A 4xx/5xx response, or an explicit `status: 'failed'` body, is therefore
 * excluded. Errors are a separate contract; TAB 09 is where they are described.
 */
function directJsonShapes(body: string): string[] {
  const out: string[] = [];
  for (const call of body.matchAll(/res\s*(?:\.status\(\s*(\d{3})?[^)]*\))?\s*\.json\(/g)) {
    const code = call[1] ? Number(call[1]) : 200;
    if (code >= 400) continue;
    const open = call.index! + call[0].length - 1;
    const close = matchingBracket(body, open);
    const arg = close > 0 ? body.slice(open + 1, close) : '';
    // A statusless error body is still an error body. `adminBookingDraft`
    // answers `res.json({ success: false, error: { message } })` with no
    // `.status()` call at all, so the code alone does not filter it out.
    if (/status:\s*['"`](failed|error)['"`]/.test(arg)) continue;
    if (/success:\s*false\b/.test(arg)) continue;
    out.push(arg);
  }
  return out;
}

/**
 * Module-local `const name = (res, …) => res….json(…)` responders, and the
 * envelope each writes.
 *
 * Only SUCCESS responders are useful here. Error helpers such as `fail` in
 * `adminAuditController` delegate to `adminError` rather than calling
 * `res.json` themselves, so they never appear — which is the wanted behaviour:
 * this function answers "what shape does a 2xx carry", and an error envelope
 * would pollute that answer.
 */
export function localResponders(controllerSrc: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of controllerSrc.matchAll(/(?:^|\n)\s*(?:export\s+)?const\s+(\w+)\s*=\s*\(/g)) {
    const open = m.index! + m[0].length - 1;
    const close = matchingBracket(controllerSrc, open);
    if (close < 0) continue;
    // Bound the helper at the next top-level declaration.
    const after = controllerSrc.slice(close);
    const stop = after.search(/\n\s*(?:export\s+)?const\s+\w+\s*=|\n\s*export\s+/);
    const decl = stop < 0 ? after : after.slice(0, stop);
    const shapes = directJsonShapes(decl);
    if (!shapes.length) continue;
    // Keep the SHAPE, not a verdict: the caller needs the payload keys too.
    out[m[1]] = shapes[0];
  }
  return out;
}
