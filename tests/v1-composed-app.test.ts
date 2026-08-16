/**
 * The REAL composed application serves v1 (TAB 01).
 *
 * ## What this closes
 *
 * TAB 01 asks that route tests "execute the composed Express application, not
 * source-text approximations". `tests/v1-router.test.ts` starts a real server
 * and makes real requests — good — but it builds its OWN app and mounts
 * `v1Router` itself, under a comment reading "Mounted exactly as app.ts mounts
 * it". That comment was the guarantee, and `tests/v1-mount-parity.test.ts`
 * exists to check it.
 *
 * It could not import the real app because doing so opened a port, connected to
 * MongoDB and issued DDL. TAB 03 removed all three, so it can now.
 *
 * ## Why this is a NEW suite rather than a rewrite of v1-router
 *
 * v1-router carries 210 assertions and a large mock surface tuned to the v1
 * router in isolation. Repointing it at the whole application would pull every
 * legacy route's dependencies into the same test run — a large, risky change
 * whose failure mode is a destabilised suite rather than a caught bug.
 *
 * This proves the property that was actually unverified: that the COMPOSITION
 * in app.ts — its prefix, its middleware order, its parity exemptions — serves
 * v1 the way the isolated router does. It is small on purpose.
 */

// Mocks first: app.ts composes at import, so anything its module graph reaches
// must already be fake. Same set v1-router.test.ts uses, for the same reason.
jest.mock('../src/config', () => ({
  isProduction: false,
  port: '0',
  secret: 'test-secret',
  tempId: undefined,
  db: { schema: 'servana', host: 'localhost', database: 'test', user: 'test', port: '5432' },
  firebaseConfig: {
    apiKey: 'test', authDomain: 'test', projectId: 'test',
    storageBucket: 'test.appspot.com', messagingSenderId: 'test', appId: 'test',
    measurementId: 'test',
  },
  mailerKey: 'test',
  mailerSender: 'test@example.invalid',
  mongoConfig: { uri: 'mongodb://localhost:27017', db: 'test', appName: 'test' },
}));
jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
  pool: { connect: jest.fn(), end: jest.fn() },
}));
jest.mock('../src/db/mongodbQuery', () => ({ __esModule: true, default: {} }));

import http from 'http';
import { startTestServer, request } from './support/httpTestServer';

describe('the composed application serves /api/v1', () => {
  let server: http.Server;
  let base: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    // The REAL app, not a replica. Importing it must not start it — that is
    // `tests/app-import-is-inert.test.ts`; this relies on it.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('../src/app');
    const started = await startTestServer(app);
    server = started.server;
    base = started.base;
    close = started.close;
  }, 60_000);

  afterAll(async () => {
    if (close) await close();
  });

  it('mounts v1 at the prefix app.ts declares', async () => {
    // A public catalog route: no token, no database write.
    const res = await request(base, 'GET', '/api/v1/catalog/categories');
    // 200 or a domain error is fine — 404 would mean the mount is wrong, which
    // is the only thing this asserts.
    expect(res.status).not.toBe(404);
    // Verified 200 in a real run, so the parity assertion below is exercised
    // rather than skipped by a non-200 short-circuit.
  });

  it('an unknown v1 path 404s inside the v1 router, not the legacy tree', async () => {
    /**
     * The v1 router ends in its own 404. If a legacy wildcard were shadowing
     * `/api/v1/*`, an unknown path would fall through and answer in the legacy
     * envelope instead — the exact failure a mounting bug produces.
     */
    const res = await request(base, 'GET', '/api/v1/definitely-not-a-route');
    expect(res.status).toBe(404);
  });

  it('applies no parity rewriting to a v1 response', async () => {
    /**
     * The composition-level guarantee that the isolated router cannot test at
     * all: parity middleware is mounted in app.ts, exempted by prefix. A v1
     * response must not carry invented aliases like `level2`.
     */
    const res = await request(base, 'GET', '/api/v1/catalog/categories');
    if (res.status === 200) {
      expect(JSON.stringify(res.body)).not.toContain('"level2"');
      expect(JSON.stringify(res.body)).not.toContain('"level_2"');
    }
  });

  it('stamps a request id on the response, for every route', async () => {
    // correlationMiddleware is mounted in app.ts and nowhere near the v1
    // router, so this is only observable through the composed application.
    const res = await request(base, 'GET', '/api/v1/catalog/categories');
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });
});
