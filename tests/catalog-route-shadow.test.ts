/**
 * Route-shadow guard for the canonical catalog.
 *
 * ## The defect this exists for
 *
 * `booking.routes` registers `GET /:id` at the `/api` root, which matches any
 * single-segment GET. With the catalog router mounted after it,
 * `GET /api/catalog` never reached the catalog handler at all — it bound
 * `id = "catalog"` and answered 401 to the unauthenticated customer app the
 * route was built for.
 *
 * The three deeper paths (`/catalog/summary`, `/catalog/services`,
 * `/catalog/services/:id`) were unaffected, so the surface looked healthy. And
 * the contract tests could not see it: they call `catalogPublicService`
 * directly, so they exercise the projection and never the routing. A service
 * the router never reaches passes every one of them.
 *
 * So this test drives a real Express instance in the real mount order and
 * asserts which handler answers. That is the only kind of assertion that can
 * catch a shadow — see `feedback_run_the_built_artefact`.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

/**
 * Minimal GET against a real listening server.
 *
 * Deliberately not supertest: adding a dependency to prove a mount order is a
 * poor trade, and driving the actual HTTP stack is closer to what production
 * does than an in-process injector anyway.
 */
const get = (app: express.Express, path: string): Promise<{ status: number; body: any }> =>
  new Promise((resolve, reject) => {
    const server = http.createServer(app).listen(0, () => {
      const { port } = server.address() as AddressInfo;
      http
        .get({ port, path }, (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            server.close();
            let body: any = {};
            try { body = JSON.parse(data); } catch { /* non-JSON is a failure the assertion will show */ }
            resolve({ status: res.statusCode ?? 0, body });
          });
        })
        .on('error', (err) => { server.close(); reject(err); });
    });
  });

/**
 * Mounts routers in a given order and reports which one answered.
 *
 * Handlers are stand-ins rather than the real controllers on purpose: the
 * question is purely which router Express selects, and wiring the real ones
 * would drag in the database and hide the answer behind a connection error.
 */
const buildApp = (order: 'catalog-first' | 'booking-first') => {
  const booking = express.Router();
  booking.get('/:id', (_req, res) => res.json({ handler: 'booking' }));

  const catalog = express.Router();
  catalog.get('/catalog', (_req, res) => res.json({ handler: 'catalog' }));
  catalog.get('/catalog/summary', (_req, res) => res.json({ handler: 'catalog.summary' }));
  catalog.get('/catalog/services', (_req, res) => res.json({ handler: 'catalog.services' }));
  catalog.get('/catalog/services/:serviceId', (_req, res) =>
    res.json({ handler: 'catalog.service', id: _req.params.serviceId }));

  const app = express();
  if (order === 'catalog-first') {
    app.use('/api', catalog);
    app.use('/api', booking);
  } else {
    app.use('/api', booking);
    app.use('/api', catalog);
  }
  return app;
};

describe('canonical catalog route reachability', () => {
  const app = buildApp('catalog-first');

  it.each([
    ['/api/catalog', 'catalog'],
    ['/api/catalog/summary', 'catalog.summary'],
    ['/api/catalog/services', 'catalog.services'],
  ])('%s is answered by the catalog router', async (path, handler) => {
    const res = await get(app, path);
    expect(res.status).toBe(200);
    expect(res.body.handler).toBe(handler);
  });

  it('/api/catalog/services/:id resolves the id', async () => {
    const res = await get(app, '/api/catalog/services/15');
    expect(res.body).toEqual({ handler: 'catalog.service', id: '15' });
  });

  it('a real booking id still reaches the booking router', async () => {
    // The hoist must not cost bookings anything. It cannot: no booking id is
    // the literal string "catalog".
    const res = await get(app, '/api/112');
    expect(res.body.handler).toBe('booking');
  });

  it('reproduces the shadow when the order is reversed', async () => {
    // Pins the mechanism rather than trusting the explanation. If this ever
    // stops reproducing, the reasoning behind the mount order has changed and
    // the comment in app.ts is stale.
    const res = await get(buildApp('booking-first'), '/api/catalog');
    expect(res.body.handler).toBe('booking');
  });
});

/**
 * ⚠ COUPLED TO THE app.ts HOIST.
 *
 * The block above proves the mechanism against synthetic routers and is
 * self-contained. This one reads the real `src/app.ts`, and the hoist it checks
 * was made in a parallel session's working tree — `app.ts` could not be staged
 * with these tests because it also imports `./api/v1/register`, which is
 * untracked, so committing it alone would break the build.
 *
 * If this fails on a clean checkout, the fix is not to weaken it: it means the
 * app.ts hoist has not landed and `GET /api/catalog` is shadowed again.
 */
describe('app.ts mount order', () => {
  const appSrc = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'app.ts'), 'utf8');

  it('mounts catalogPublicRoutes before bookingRoutes', () => {
    const catalogAt = appSrc.indexOf('catalogPublicRoutes);');
    const bookingAt = appSrc.indexOf('bookingRoutes);');
    expect(catalogAt).toBeGreaterThan(-1);
    expect(bookingAt).toBeGreaterThan(-1);
    expect(catalogAt).toBeLessThan(bookingAt);
  });
});
