/**
 * Operational probes are not client API, and must not be field-rewritten.
 *
 * Found by booting the server against an unreachable database, not by reading
 * it. `/readyz` came back with every dependency carrying `serviceName`,
 * `service_name`, `level2` and `level_2`, all set to the dependency's name,
 * because `/healthz` and `/readyz` were not in the parity exemption list.
 *
 * `level2` is a legacy catalog label. On a readiness payload it means nothing,
 * it inflates a response a load balancer polls constantly, and an operator
 * debugging an outage should not find catalog vocabulary in a health response.
 */

import http from 'http';
import express from 'express';
import { startTestServer, request } from './support/httpTestServer';
import { parityMiddleware } from '../src/middleware/parityMiddleware';
import { CANONICAL_CONTRACT_PREFIXES } from '../src/app';

let server: http.Server;
let closeServer: () => Promise<void>;
let base: string;

/** The shape app.ts actually returns from /readyz, minus the live plumbing. */
const readinessLike = () => ({
  phase: 'degraded',
  ready: false,
  live: true,
  dependencies: [
    { name: 'admin-permission-seed', kind: 'required', state: 'failed', durationMs: 7 },
  ],
});

beforeAll(async () => {
  const app = express();

  // Mounted exactly as app.ts mounts it: exempt prefixes bypass, everything
  // else is rewritten.
  app.use((req, res, next) => {
    if (CANONICAL_CONTRACT_PREFIXES.some((p) => req.path.startsWith(p))) return next();
    return parityMiddleware(req, res, next);
  });

  app.get('/readyz', (_req, res) => res.status(503).json(readinessLike()));
  app.get('/healthz', (_req, res) => res.status(200).json({ status: 'alive' }));
  // A legacy route, to prove the middleware is still doing its job elsewhere.
  app.get('/api/legacy/thing', (_req, res) => res.status(200).json(readinessLike()));

  const started = await startTestServer(app);
  server = started.server;
  base = started.base;
  closeServer = started.close;
});

afterAll(async () => {
  await closeServer();
});

const get = (path: string) => request(base, 'GET', path, { headers: {} });

describe('/readyz carries no catalog vocabulary', () => {
  it('does not inject level2 into a dependency status', () => {
    // The exact field that made this visible.
    return get('/readyz').then((res) => {
      const raw = JSON.stringify(res.body);
      expect(raw).not.toMatch(/level2|level_2/);
    });
  });

  it('does not inject serviceName aliases either', async () => {
    const res = await get('/readyz');
    const dep = res.body.dependencies[0];
    expect(dep).not.toHaveProperty('serviceName');
    expect(dep).not.toHaveProperty('service_name');
  });

  it('still reports what an operator needs', async () => {
    // Exempting must not mean emptying: the payload is the diagnostic.
    const res = await get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body.ready).toBe(false);
    expect(res.body.live).toBe(true);
    expect(res.body.dependencies[0].name).toBe('admin-permission-seed');
    expect(res.body.dependencies[0].state).toBe('failed');
  });
});

describe('/healthz stays minimal', () => {
  it('is exactly the liveness answer, with nothing added', async () => {
    const res = await get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'alive' });
  });
});

describe('the exemption is narrow', () => {
  it('legacy routes are STILL rewritten — this did not disable parity', async () => {
    /**
     * The failure mode of a fix like this is over-reach. Legacy clients depend on
     * the aliases, so the middleware must still run everywhere it used to.
     */
    const res = await get('/api/legacy/thing');
    const raw = JSON.stringify(res.body);
    expect(raw).toMatch(/level2|service_name|serviceName/);
  });

  it('the exemption list names both probes', () => {
    expect(CANONICAL_CONTRACT_PREFIXES).toContain('/healthz');
    expect(CANONICAL_CONTRACT_PREFIXES).toContain('/readyz');
  });

  it('and still names the three contract prefixes it protected before', () => {
    expect(CANONICAL_CONTRACT_PREFIXES).toContain('/api/v1');
    expect(CANONICAL_CONTRACT_PREFIXES).toContain('/api/admin/catalog');
    expect(CANONICAL_CONTRACT_PREFIXES).toContain('/api/catalog');
  });
});
