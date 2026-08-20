/**
 * Importing the application composes it and does nothing else (TAB 03).
 *
 * This is the acceptance criterion tested the strong way — by actually
 * importing `src/app.ts` — rather than by reading it as source.
 *
 * ## What had to move first
 *
 * Three separate import-time side effects, found by attempting exactly this:
 *
 *   1. `app.ts` awaited the dependency graph and called `listen()` at module
 *      scope. Now behind `require.main === module`.
 *   2. `db/mongodbQuery.ts` did `new MongoClient(URI)` and `export default
 *      main()`, so importing it CONNECTED — and threw outright when MONGO_URI
 *      was unset, which is the state of a clean checkout. Now a lazy thenable.
 *   3. Five service and ROUTE modules called their own `ensure*Schema()` at
 *      module scope, so importing them issued DDL. None appeared in `app.ts`;
 *      they were found by instrumenting `pg.Pool.prototype.query` during an
 *      import. Now declared in the startup graph.
 *
 * The third was invisible to every source-level check of `app.ts`, which is why
 * this file exists in the form it does.
 */

describe('importing src/app.ts is inert', () => {
  const before = process.env.MONGO_URI;

  beforeAll(() => {
    // A clean checkout has no MONGO_URI. Importing must survive that; it used
    // to throw `Invalid scheme` from the MongoClient constructor.
    delete process.env.MONGO_URI;
  });

  afterAll(() => {
    if (before === undefined) delete process.env.MONGO_URI;
    else process.env.MONGO_URI = before;
    /**
     * Release the module registry this suite populated.
     *
     * Measured with `--logHeapUsage` and `scripts/jest-heap-guard.js`: this
     * suite retained **599 MB** — six times the next worst — because requiring
     * `src/app.ts` pulls the entire application module graph into Jest's
     * registry, and under `--runInBand` every later suite inherits it. On the
     * 961 MB self-hosted runner that single figure is the whole OOM.
     *
     * Importing the app is the point of this suite, so the cost is not
     * avoidable; holding it for the remaining 275 suites is.
     */
    jest.resetModules();
  });

  it('imports without a MONGO_URI and exports the composed app', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const composed = require('../src/app');
    expect(typeof composed.startServer).toBe('function');
    expect(composed.app).toBeDefined();
    expect(composed.httpServer).toBeDefined();
  });

  it('opens no listening socket', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('../src/app');
    /**
     * LISTENING is the property, not merely "a Server object exists".
     *
     * `_getActiveHandles()` is process-wide, and under `--runInBand` a sibling
     * suite's server can still be in that list after it has been closed —
     * `tests/support/httpTestServer.ts` closes correctly, but reaping is not
     * synchronous with `close()`'s callback. Filtering on the object's
     * constructor alone therefore made this assertion depend on suite ORDER:
     * measured failing after `v1-composed-app.test.ts` and passing in
     * isolation, from the same command.
     *
     * `listening` is what the test name has always claimed to check, and it is
     * strictly the harder question — a server app.ts bound at import reads
     * `listening === true` and still fails this. A closed server left over from
     * a neighbour reads false, which is the correct answer to "did importing
     * app.ts open a socket".
     */
    const servers = (process as any)
      ._getActiveHandles()
      .filter((h: any) => h && h.constructor && h.constructor.name === 'Server' && h.listening);
    expect(servers).toHaveLength(0);
  });

  it('exposes startServer separately from module load', () => {
    /**
     * The distinction the whole change rests on: composing is free, starting is
     * explicit. If these ever merge again the first assertion still passes and
     * this one is what notices.
     */
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const composed = require('../src/app');
    expect(composed.startServer.constructor.name).toBe('AsyncFunction');
  });
});
