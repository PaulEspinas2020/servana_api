/**
 * No route in the composed app may eclipse another.
 *
 * ## The defect this exists for
 *
 * `booking.routes` registers `GET /:id`. Mounted at `/api`, that matches every
 * single-segment GET. `catalogPublic.routes` was mounted ten routers later, so
 * `GET /api/catalog` resolved to the booking getter: 401 for the anonymous
 * customer app the route was written for, 400 "Invalid booking id" for anyone
 * with a token. The three deeper `/catalog/*` paths were unaffected, which is
 * why it survived a full green suite — every catalog test called the service
 * layer directly and none of them resolved a URL.
 *
 * ## Positive and negative fixtures
 *
 * A detector that only ever reports "clean" is indistinguishable from a
 * detector that is broken. The first block below feeds the scanner the PRE-FIX
 * ordering and requires it to find the shadow; the second runs it over the real
 * app and requires none. Both have to hold, or the passing half means nothing.
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import {
  buildMountedRoutes,
  findShadowedRoutes,
  parseMountOrder,
  parseRouteFile,
  sampleFor,
  pathMatcher,
  REPO_ROOT,
} from '../scripts/lib/routeTable';

describe('the scanner detects a shadow when one exists (positive fixture)', () => {
  it('reproduces the pre-fix mount order and finds GET /api/catalog eaten by GET /api/:id', () => {
    // The exact shape app.ts had before this command: bookings mounted before
    // the public catalog. Expressed as data rather than by editing app.ts, so
    // the fixture cannot rot into the thing it is meant to detect.
    const routes = [
      { file: 'booking.routes.ts', line: 44, verb: 'get' as const, path: '/:id', handlers: [], router: 'router', prefix: '/api', order: 5, fullPath: '/api/:id' },
      { file: 'catalogPublic.routes.ts', line: 27, verb: 'get' as const, path: '/catalog', handlers: [], router: 'router', prefix: '/api', order: 15, fullPath: '/api/catalog' },
      { file: 'catalogPublic.routes.ts', line: 28, verb: 'get' as const, path: '/catalog/summary', handlers: [], router: 'router', prefix: '/api', order: 15, fullPath: '/api/catalog/summary' },
    ];

    const shadows = findShadowedRoutes(routes);

    expect(shadows).toHaveLength(1);
    expect(shadows[0].victim.fullPath).toBe('/api/catalog');
    expect(shadows[0].eatenBy.fullPath).toBe('/api/:id');
    expect(shadows[0].kind).toBe('SHADOWED');
  });

  it('finds a duplicate registration of the same verb and path', () => {
    const routes = [
      { file: 'a.ts', line: 1, verb: 'post' as const, path: '/thing', handlers: [], router: 'router', prefix: '/api', order: 0, fullPath: '/api/thing' },
      { file: 'b.ts', line: 1, verb: 'post' as const, path: '/thing', handlers: [], router: 'router', prefix: '/api', order: 1, fullPath: '/api/thing' },
    ];
    expect(findShadowedRoutes(routes).map((s) => s.kind)).toEqual(['DUPLICATE']);
  });

  it('does not report a deeper path as shadowed by a shallower wildcard', () => {
    // /api/:id must NOT be reported as eating /api/catalog/summary — it cannot,
    // and a detector that says so would bury the real finding in noise.
    const routes = [
      { file: 'a.ts', line: 1, verb: 'get' as const, path: '/:id', handlers: [], router: 'router', prefix: '/api', order: 0, fullPath: '/api/:id' },
      { file: 'b.ts', line: 1, verb: 'get' as const, path: '/catalog/summary', handlers: [], router: 'router', prefix: '/api', order: 1, fullPath: '/api/catalog/summary' },
    ];
    expect(findShadowedRoutes(routes)).toHaveLength(0);
  });

  it('does not report across different verbs', () => {
    const routes = [
      { file: 'a.ts', line: 1, verb: 'get' as const, path: '/:id', handlers: [], router: 'router', prefix: '/api', order: 0, fullPath: '/api/:id' },
      { file: 'b.ts', line: 1, verb: 'post' as const, path: '/catalog', handlers: [], router: 'router', prefix: '/api', order: 1, fullPath: '/api/catalog' },
    ];
    expect(findShadowedRoutes(routes)).toHaveLength(0);
  });
});

describe('the parser reads the real tree (so a clean result means something)', () => {
  it('reads the mount order out of app.ts', () => {
    const mounts = parseMountOrder();
    expect(mounts.length).toBeGreaterThan(25);

    const files = mounts.map((m) => m.file);
    expect(files).toContain('src/routes/booking.routes.ts');
    expect(files).toContain('src/routes/catalogPublic.routes.ts');
    expect(files).toContain('src/api/v1/register.ts');
  });

  it('mounts the canonical v1 namespace before every legacy router', () => {
    const mounts = parseMountOrder();
    const v1 = mounts.find((m) => m.file === 'src/api/v1/register.ts');
    expect(v1).toBeDefined();
    expect(v1!.prefix).toBe('/api/v1');
    expect(v1!.order).toBe(Math.min(...mounts.map((m) => m.order)));
  });

  it('mounts the public catalog BEFORE the booking wildcard — the fix, pinned', () => {
    const mounts = parseMountOrder();
    const catalog = mounts.find((m) => m.file === 'src/routes/catalogPublic.routes.ts');
    const booking = mounts.find((m) => m.file === 'src/routes/booking.routes.ts');
    expect(catalog).toBeDefined();
    expect(booking).toBeDefined();
    expect(catalog!.order).toBeLessThan(booking!.order);
  });

  it('parses multi-line router.get( declarations', () => {
    // technician.routes.ts declares /workers/:workerId/job-cards across four
    // lines. A single-line regex misses it, which is how an earlier pass
    // reported seven endpoints as missing that were not.
    const rows = parseRouteFile(path.join(REPO_ROOT, 'src', 'routes', 'technician.routes.ts'));
    expect(rows.map((r) => r.path)).toContain('/workers/:workerId/job-cards');
  });

  it('finds every route the app serves', () => {
    const routes = buildMountedRoutes();
    expect(routes.length).toBeGreaterThan(500);
    expect(routes.some((r) => r.fullPath === '/api/v1/catalog')).toBe(true);
    expect(routes.some((r) => r.fullPath === '/api/catalog')).toBe(true);
  });

  it('is not confused by CRLF checkouts', () => {
    // Windows checkouts have CRLF on disk. A parser that counts bytes rather
    // than lines reports different results on the two platforms — a whole class
    // of source-introspection test fails exactly this way.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'servana-crlf-'));
    const file = path.join(tmp, 'crlf.routes.ts');
    fs.writeFileSync(
      file,
      ['import x from "y";', 'const router = Router();', 'router.get(', '  "/thing/:id",', '  handler,', ');'].join('\r\n'),
    );
    try {
      const rows = parseRouteFile(file);
      expect(rows).toHaveLength(1);
      expect(rows[0].path).toBe('/thing/:id');
      expect(rows[0].line).toBe(3);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('the real app has no shadowed route (negative fixture)', () => {
  it('no route is eclipsed by an earlier one', () => {
    const shadows = findShadowedRoutes();
    const rendered = shadows.map(
      (s) =>
        `${s.kind}: ${s.victim.verb.toUpperCase()} ${s.victim.fullPath} (${s.victim.file}:${s.victim.line}) ` +
        `is answered by ${s.eatenBy.verb.toUpperCase()} ${s.eatenBy.fullPath} (${s.eatenBy.file}:${s.eatenBy.line})`,
    );
    expect(rendered).toEqual([]);
  });

  it('GET /api/catalog resolves to the catalog router, not to the booking wildcard', () => {
    const routes = buildMountedRoutes();
    const sample = sampleFor('/api/catalog');
    const winner = routes.find((r) => r.verb === 'get' && pathMatcher(r.fullPath).test(sample));
    expect(winner).toBeDefined();
    expect(winner!.file).toBe('src/routes/catalogPublic.routes.ts');
  });

  it('the booking wildcard still answers a numeric booking id — the fix broke nothing', () => {
    const routes = buildMountedRoutes();
    const winner = routes.find((r) => r.verb === 'get' && pathMatcher(r.fullPath).test('/api/104'));
    expect(winner).toBeDefined();
    expect(winner!.file).toBe('src/routes/booking.routes.ts');
    expect(winner!.fullPath).toBe('/api/:id');
  });
});
