/**
 * The route harness composes a REPLICA of the application. This pins it.
 *
 * ## The gap
 *
 * TAB 01 asks that route tests "execute the composed Express application, not
 * source-text approximations". `tests/v1-router.test.ts` is not a source-text
 * approximation — it starts a real server and makes real requests, which is far
 * better — but it builds its own app and mounts `v1Router` itself, with a
 * comment saying "Mounted exactly as app.ts mounts it."
 *
 * That comment is the whole guarantee. If `app.ts` changed its prefix, added a
 * middleware ahead of the router, or mounted it twice, 210 route tests would
 * keep passing against a composition production no longer uses.
 *
 * ## Why the harness cannot just import the app
 *
 * `src/app.ts` has import-time side effects — it calls `startScheduler()` and
 * listens — so importing it in a test opens ports and starts cron. Fixing that
 * is TAB 03 ("build an atomic startup lifecycle", move `httpServer.listen` and
 * scheduler startup out of module import scope). Until it lands, the harness has
 * to replicate, and the replication needs a second source.
 *
 * So this asserts the properties the harness depends on, and records the one
 * place the two genuinely differ. When TAB 03 lands and the harness can import
 * `createApp()`, this file should be deleted rather than maintained.
 */

import fs from 'fs';
import path from 'path';

const APP_SOURCE = fs.readFileSync(
  path.resolve(__dirname, '..', 'src', 'app.ts'),
  'utf8',
);

/** Read as lines rather than fixed-byte windows — the file is CRLF on Windows. */
const APP_LINES = APP_SOURCE.split(/\r?\n/);

describe('app.ts mounts v1 the way the route harness assumes', () => {
  const mountLines = APP_LINES.filter((line) =>
    /app\.use\(\s*["']\/api\/v1["']/.test(line),
  );

  it('mounts the v1 router exactly once', () => {
    // Two mounts would make request handling order-dependent, and the harness
    // would only ever exercise one of them.
    expect(mountLines).toHaveLength(1);
  });

  it('mounts it at /api/v1, the prefix the harness uses', () => {
    expect(mountLines[0]).toMatch(/app\.use\(\s*["']\/api\/v1["']/);
    expect(mountLines[0]).toContain('v1Router');
  });

  it('exempts /api/v1 from both parity middlewares', () => {
    /**
     * The canonical DTO guarantee. A middleware that invents request or
     * response keys means the declared shape is not the shape the handler reads
     * — and the harness, which mounts neither, would never see the difference.
     */
    // Two different spellings, on purpose: the REQUEST side tests the literal
    // prefix, the RESPONSE side tests CANONICAL_CONTRACT_PREFIXES, which
    // carries the catalog prefixes too. Matching only the literal form reported
    // one exemption and looked like a missing guarantee.
    const literal = APP_LINES.filter((line) =>
      /req\.path\.startsWith\(\s*['"]\/api\/v1['"]\s*\)/.test(line),
    );
    const viaPrefixList = APP_LINES.filter((line) =>
      /CANONICAL_CONTRACT_PREFIXES\.some\(/.test(line),
    );

    expect(literal.length).toBeGreaterThanOrEqual(1);
    expect(viaPrefixList.length).toBeGreaterThanOrEqual(1);
    expect(APP_SOURCE).toMatch(/CANONICAL_CONTRACT_PREFIXES\s*=\s*\[[^\]]*'\/api\/v1'/);
  });

  it('records the ONE middleware the harness does not replicate', () => {
    /**
     * `cors` sits between the prefix and the router in production and is absent
     * from the harness. That is acceptable — CORS decides whether a BROWSER may
     * read a response, and it changes no route resolution, status code or body
     * that these tests assert on.
     *
     * It is asserted rather than assumed so that a SECOND middleware appearing
     * there fails this test. The next one might not be so harmless.
     */
    const between = /app\.use\(\s*["']\/api\/v1["']\s*,\s*(.+?),\s*v1Router\s*\)/.exec(
      mountLines[0],
    );
    const layers = between ? between[1].split(',').map((s) => s.trim()) : [];
    expect(layers).toEqual(['cors(corsOptionsDelegate)']);
  });

  it('the harness has not silently started importing the real app', () => {
    /**
     * If someone wires `src/app.ts` into the harness before TAB 03 removes its
     * import-time `listen()` and `startScheduler()`, the suite will open ports
     * and start cron jobs. Better to fail here with the reason than to debug a
     * hung test run.
     */
    const harness = fs.readFileSync(
      path.resolve(__dirname, 'v1-router.test.ts'),
      'utf8',
    );
    expect(harness).not.toMatch(/from\s+['"]\.\.\/src\/app['"]/);
  });
});
