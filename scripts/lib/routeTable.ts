/**
 * Static route table for the whole Express app — mount order included.
 *
 * ## Why static analysis and not `require('../src/app')`
 *
 * Importing `app.ts` starts an HTTP listener, opens a pg pool, initialises
 * Firebase Admin from a service-account file and registers cron jobs. A test
 * that does that is an integration test needing credentials, which is precisely
 * why this repo has 2,993 unit tests and none of them had ever resolved a URL —
 * and why `GET /api/catalog` could be unreachable with the gate green.
 *
 * Reading the source gets the one property that matters here — which router is
 * mounted before which, and what paths each one declares — with no side
 * effects, no credentials and no network. It is the same technique that found
 * the shadow.
 *
 * ## What it does NOT prove
 *
 * That a handler works, that a guard fires, or that a response has a given
 * shape. It proves reachability and ordering. `tests/v1-router.test.ts` mounts
 * the real v1 router against real Express for the behavioural half.
 *
 * ## Windows
 *
 * Everything here works on lines and regexes, never on byte offsets into the
 * file. A fixed-window read over source is what makes this class of test fail
 * on CRLF checkouts and pass on LF ones.
 */

import fs from 'fs';
import path from 'path';

export const REPO_ROOT = path.resolve(__dirname, '..', '..');

export type Verb = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'all' | 'use';

export interface RouteRow {
  /** Repo-relative, forward slashes. */
  file: string;
  line: number;
  verb: Verb;
  /** Path as declared inside the router, without the mount prefix. */
  path: string;
  /** Middleware/handler expressions, whitespace-collapsed. */
  handlers: string[];
  /**
   * The router VARIABLE the route was declared on.
   *
   * A module can export two routers — `accountDeletion.routes.ts` exports the
   * `/api` router as default and `accountDeletionPageRouter` separately, and
   * app.ts mounts the second at the root with no prefix. Attributing every
   * route in the file to every mount of the file reports `/api/account-deletion`
   * as a shadowed route, and that path does not exist.
   */
  router: string;
}

export interface MountRow {
  /** Repo-relative path of the router module. */
  file: string;
  /** Mount prefix, e.g. '/api' or '/api/v1'. '' means the app root. */
  prefix: string;
  /** Position in app.ts. Lower wins when two routes both match. */
  order: number;
  /** Which export of the module was mounted: 'default' or a named export. */
  exportName: string;
}

export interface MountedRoute extends RouteRow {
  prefix: string;
  order: number;
  /** Full path a client would call. */
  fullPath: string;
}

const read = (abs: string): string => fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
const rel = (abs: string): string => path.relative(REPO_ROOT, abs).split(path.sep).join('/');

/** Splits an argument list on top-level commas, respecting nesting and strings. */
export function splitTopLevelArgs(source: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  let quote: string | null = null;

  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === '\\') { current += c + (source[i + 1] ?? ''); i++; continue; }
      if (c === quote) quote = null;
      current += c;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; current += c; continue; }
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) { out.push(current.trim()); current = ''; continue; }
    current += c;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** Index of the paren that closes the one opened at `openIndex - 1`. */
function matchingParen(source: string, openIndex: number): number {
  let depth = 1;
  let quote: string | null = null;
  let i = openIndex;
  while (i < source.length && depth > 0) {
    const c = source[i];
    if (quote) {
      if (c === '\\') { i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; i++; continue; }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    i++;
  }
  return i - 1;
}

const VERBS: Verb[] = ['get', 'post', 'put', 'patch', 'delete', 'all', 'use'];

/**
 * Every `<router>.<verb>('<path>', …)` in a file.
 *
 * Handles multi-line calls — seven of eight "missing endpoints" in an earlier
 * pass were single-line regexes missing `router.get(\n  "/x",`.
 */
export function parseRouteFile(absPath: string): RouteRow[] {
  const src = read(absPath);
  const rows: RouteRow[] = [];
  const re = new RegExp(`(\\w+)\\s*\\.\\s*(${VERBS.join('|')})\\s*\\(`, 'g');

  let match: RegExpExecArray | null;
  while ((match = re.exec(src)) !== null) {
    const verb = match[2] as Verb;
    const close = matchingParen(src, re.lastIndex);
    const args = splitTopLevelArgs(src.slice(re.lastIndex, close));
    if (!args.length) continue;

    const first = args[0];
    if (!/^["'`]/.test(first)) continue; // pathless router.use(mw) — not a route
    rows.push({
      file: rel(absPath),
      line: src.slice(0, match.index).split('\n').length,
      verb,
      path: first.slice(1, -1),
      handlers: args.slice(1).map((a) => a.replace(/\s+/g, ' ')),
      router: match[1],
    });
  }
  return rows;
}

/**
 * Which router variable each export of a route module refers to.
 *
 * `export default router`            → { default: 'router' }
 * `export const pageRouter = Router()` → { pageRouter: 'pageRouter' }
 */
export function parseRouterExports(absPath: string): Record<string, string> {
  const src = read(absPath);
  const out: Record<string, string> = {};

  const def = /export\s+default\s+(\w+)\s*;/.exec(src);
  if (def) out.default = def[1];

  const namedRe = /export\s+const\s+(\w+)\s*=\s*(?:express\s*\.\s*)?Router\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = namedRe.exec(src)) !== null) out[m[1]] = m[1];

  return out;
}

/**
 * Mount order, read from app.ts.
 *
 * Matches `app.use("<prefix>", …, <identifier>)` and `app.use(<identifier>)`,
 * resolving the identifier back to the module it was imported from. Only
 * imports from `./routes/*` and `./api/*` and `./chat/*` count as routers;
 * everything else `app.use`s a middleware, which does not own paths.
 */
export function parseMountOrder(appTsPath = path.join(REPO_ROOT, 'src', 'app.ts')): MountRow[] {
  const src = read(appTsPath);

  // localName -> { module, exportName }. Both default and named bindings, because
  // `import r, { pageRouter } from './routes/x'` mounts two different routers.
  const importOf = new Map<string, { module: string; exportName: string }>();
  const importRe = /import\s+(?:(\w+)\s*)?(?:,?\s*\{([^}]*)\}\s*)?from\s*["']([^"']+)["']/g;
  let im: RegExpExecArray | null;
  while ((im = importRe.exec(src)) !== null) {
    const [, defaultName, namedBlock, moduleName] = im;
    if (defaultName) importOf.set(defaultName, { module: moduleName, exportName: 'default' });
    if (namedBlock) {
      for (const piece of namedBlock.split(',')) {
        const parts = piece.trim().split(/\s+as\s+/);
        const imported = parts[0]?.trim();
        const local = (parts[1] ?? parts[0])?.trim();
        if (imported && local) importOf.set(local, { module: moduleName, exportName: imported });
      }
    }
  }

  const mounts: MountRow[] = [];
  const useRe = /app\s*\.\s*use\s*\(/g;
  let um: RegExpExecArray | null;
  let order = 0;

  while ((um = useRe.exec(src)) !== null) {
    const close = matchingParen(src, useRe.lastIndex);
    const args = splitTopLevelArgs(src.slice(useRe.lastIndex, close));
    if (!args.length) continue;

    let prefix = '';
    let rest = args;
    if (/^["']/.test(args[0])) {
      prefix = args[0].slice(1, -1);
      rest = args.slice(1);
    }

    for (const arg of rest) {
      const ident = arg.trim();
      if (!/^\w+$/.test(ident)) continue;
      const source = importOf.get(ident);
      if (!source) continue;
      if (!/^\.\/(routes|chat|api)\//.test(source.module)) continue;
      const file = `src/${source.module.replace(/^\.\//, '')}.ts`;
      mounts.push({ file, prefix, order: order++, exportName: source.exportName });
    }
  }
  return mounts;
}

/**
 * Routers whose paths are not literals in their own source.
 *
 * `src/api/v1/register.ts` builds its routes from `V1_CONTRACT`, so there is no
 * `router.get("/catalog", …)` to read. The contract IS the declaration, so the
 * scanner reads it directly — which also means a v1 route can never be invisible
 * to the shadow check just because it was registered programmatically.
 */
function dynamicRoutesFor(file: string): RouteRow[] | null {
  if (file !== 'src/api/v1/register.ts') return null;
  // Imported lazily and by relative path: contract.ts pulls in only errors.ts,
  // so this costs no database, no Firebase and no side effects.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { IMPLEMENTED } = require('../../src/api/v1/contract') as typeof import('../../src/api/v1/contract');
  return IMPLEMENTED.map((entry) => ({
    file,
    line: 0,
    verb: entry.method as Verb,
    path: entry.path,
    handlers: [entry.id],
    router: 'default',
  }));
}

/**
 * Every route the app serves, in the order Express will try them.
 *
 * Routers not reachable from app.ts are excluded on purpose: a route file
 * nobody mounts serves nothing, and including it would report shadows that
 * cannot happen.
 */
export function buildMountedRoutes(): MountedRoute[] {
  const mounts = parseMountOrder();
  const out: MountedRoute[] = [];

  for (const mount of mounts) {
    const abs = path.join(REPO_ROOT, mount.file);
    if (!fs.existsSync(abs)) continue;

    const dynamic = dynamicRoutesFor(mount.file);
    // Attribute routes to the router variable this mount actually references.
    // Without this a module exporting two routers has every one of its routes
    // counted under both mounts, inventing paths the app does not serve.
    // NOT named `exports` — this file compiles to CommonJS, where that is a
    // module-level binding, and shadowing it throws "Cannot access 'exports'
    // before initialization" at the top of the function.
    const routerExports = dynamic ? null : parseRouterExports(abs);
    const wantedRouter = routerExports ? routerExports[mount.exportName] : 'default';
    const rows = dynamic ?? parseRouteFile(abs);

    for (const row of rows) {
      if (row.verb === 'use') continue;
      if (wantedRouter && row.router !== wantedRouter) continue;
      /**
       * A route with NO handler is not a route.
       *
       * The parser keys on `.get('…')`, and `req.get('x-servana-client')` has
       * that exact shape. Three header reads in `api/v1/legacyTelemetry.ts` were
       * being emitted as mounted GET routes — `/user-agent`,
       * `/x-servana-client`, `/x-servana-client-version` — inflating every count
       * derived from this table.
       *
       * That is not cosmetic. `authOf` classifies a chain by the middleware
       * NAMES in it, so an empty chain matches no rung and resolves to `public`,
       * the weakest. Three phantom public routes sat in the authorization
       * inventory, and an orphan ratchet built on this table would have frozen
       * them as real surface to drain.
       *
       * Discriminating rather than blunt: every genuine route carries at least
       * one handler, and a header read carries none.
       */
      if (!row.handlers || row.handlers.length === 0) continue;
      const joined = `${mount.prefix}${row.path.startsWith('/') ? '' : '/'}${row.path}`;
      out.push({
        ...row,
        prefix: mount.prefix,
        order: mount.order,
        fullPath: joined.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1'),
      });
    }
  }

  return out.sort((a, b) => a.order - b.order || a.line - b.line);
}

/** A concrete path that a route matches, with each param filled by a literal. */
export const sampleFor = (fullPath: string): string =>
  '/' +
  fullPath
    .split('/')
    .filter(Boolean)
    .map((s) => (s.startsWith(':') ? '7' : s))
    .join('/');

export const pathMatcher = (fullPath: string): RegExp =>
  new RegExp(
    '^' +
      fullPath
        .split('/')
        .filter(Boolean)
        .map((s) => (s.startsWith(':') ? '[^/]+' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
        .map((s) => '/' + s)
        .join('') +
      '$',
  );

export interface Shadow {
  victim: MountedRoute;
  eatenBy: MountedRoute;
  kind: 'SHADOWED' | 'DUPLICATE';
}

/**
 * Routes an earlier-registered route will answer for.
 *
 * A DUPLICATE is the same verb and the same literal path twice. A SHADOWED
 * route is one whose own concrete sample path is matched by something declared
 * earlier — `GET /api/catalog` against `GET /api/:id`.
 */
export function findShadowedRoutes(routes = buildMountedRoutes()): Shadow[] {
  const found: Shadow[] = [];
  for (let i = 0; i < routes.length; i++) {
    const victim = routes[i];
    const sample = sampleFor(victim.fullPath);
    for (let j = 0; j < i; j++) {
      const earlier = routes[j];
      if (earlier.verb !== victim.verb && earlier.verb !== 'all') continue;
      if (earlier.fullPath === victim.fullPath) {
        found.push({ victim, eatenBy: earlier, kind: 'DUPLICATE' });
        break;
      }
      if (pathMatcher(earlier.fullPath).test(sample)) {
        found.push({ victim, eatenBy: earlier, kind: 'SHADOWED' });
        break;
      }
    }
  }
  return found;
}
