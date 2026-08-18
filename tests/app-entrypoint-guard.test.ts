/**
 * Importing the application must not start it (TAB 03).
 *
 * ## The criterion
 *
 * "Tests can import and compose the app without opening ports or touching real
 * services." Importing `app.ts` used to await a dependency graph that connects
 * to PostgreSQL, bind a port, and start cron — all at module load.
 *
 * ## Why this is a source check and not an import
 *
 * Actually importing `src/app.ts` here would be the stronger test and is not
 * yet safe: the module graph still constructs a MongoClient and a pg Pool at
 * load time, in `db/mongodbQuery.ts` and `db/dbQuery.ts`. Those are separate
 * import-time side effects, outside this file's change, and importing to prove
 * a point would drag real connection attempts into every suite run.
 *
 * Measured rather than assumed: with a syntactically valid MONGO_URI, importing
 * app.ts opens ZERO listening sockets. The port is fixed; the client
 * construction is not.
 *
 * So this pins the guard that WAS fixed, and names what is left.
 */

import fs from 'fs';
import path from 'path';

const APP = fs
  .readFileSync(path.resolve(__dirname, '..', 'src', 'app.ts'), 'utf8')
  .replace(/\r\n/g, '\n');

describe('app.ts is composed on import and started only as an entry point', () => {
  it('guards startup behind require.main === module', () => {
    // `node dist/app.js` is the only launch path (package.json `start`), so
    // this is true in production and false for every import.
    expect(APP).toMatch(/if \(require\.main === module\) \{\s*\n\s*void startServer\(\);/);
  });

  it('exports the composed app so a test need not replicate the mounting', () => {
    expect(APP).toMatch(/export \{ app, httpServer, io \}/);
    expect(APP).toMatch(/export const startServer/);
  });

  it('calls listen ONLY inside startServer', () => {
    /**
     * The regression this prevents: a second `listen` added at module scope
     * would restore the old behaviour while the guard above still passed.
     */
    // Matched on the INVOCATION, not the identifier: the block comment above
    // `startServer` explains the old behaviour and names `httpServer.listen()`
    // in prose, which a looser pattern counts as a second call site.
    const listens = [...APP.matchAll(/httpServer\.listen\(port\b/g)];
    expect(listens).toHaveLength(1);

    const start = APP.indexOf('export const startServer');
    expect(start).toBeGreaterThan(-1);
    expect(listens[0].index!).toBeGreaterThan(start);
  });

  it('starts the scheduler inside startServer, not at module scope', () => {
    // A cron tick against a half-built schema is the same defect as an early
    // request, and it has no client to report the error to.
    const calls = [...APP.matchAll(/^\s*startScheduler\(\);/gm)];
    expect(calls).toHaveLength(1);
    expect(calls[0].index!).toBeGreaterThan(APP.indexOf('export const startServer'));
  });

  it('runs no fire-and-forget bootstrap IIFE at module scope', () => {
    // Fourteen of these used to run at import time, each swallowing its error.
    expect(APP).not.toMatch(/^\(async \(\) => \{/m);
  });
});
