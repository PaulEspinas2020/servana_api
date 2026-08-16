/**
 * Socket-level contract tests (§144).
 *
 * ## What this covers that `v1-router.test.ts` does not
 *
 * That suite proves ROUTING over a real socket: does this path reach this
 * handler, does the declared auth mode gate it. This one proves SERIALIZATION
 * and MIDDLEWARE over a real socket: what actually arrives on the wire after
 * everything in `app.ts` has had a turn.
 *
 * §144 names the three mutations to catch, and each is a thing that has already
 * happened in this codebase or nearly did:
 *
 *   - **parity** — `parityMiddleware` maps `name` onto `level2`, so a canonical
 *     Service once came back claiming its own name as its subcategory. v1 is
 *     exempt. A service-layer test cannot see the exemption because the
 *     middleware is not in the call path; only a real response can.
 *   - **timestamps** — a value that leaves the service as a `Date` and reaches
 *     the client as a local-offset string is the same instant and a different
 *     cache key. `JSON.stringify` is where that happens, so the assertion has
 *     to be on the bytes.
 *   - **middleware** — headers, status and envelope are set by layers the
 *     domain never sees.
 *
 * The app under test therefore mounts the REAL parity middlewares in the REAL
 * order from `app.ts`, plus the TAB 14 correlation and deprecation layers, and
 * asserts on raw response text rather than on a parsed object wherever the
 * distinction matters.
 */

import http from 'http';
import express from 'express';
import { AddressInfo } from 'net';

jest.mock('../src/config', () => ({ db: { schema: 'servana' }, tempId: undefined }));
jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
  pool: { connect: jest.fn() },
}));
jest.mock('../src/db/mongodbQuery', () => ({ __esModule: true, default: {} }));

import { parityMiddleware } from '../src/middleware/parityMiddleware';
import { requestParityMiddleware } from '../src/middleware/requestParityMiddleware';
import { correlationMiddleware, requestLogMiddleware, __resetRequestLog, __lastRequestLogLine } from '../src/observability/requestLog';
import { deprecationHeaders, __notices } from '../src/api/v1/deprecation';
import { ok, created, fail } from '../src/api/v1/envelope';
import { resetMetrics, snapshot } from '../src/observability/metrics';
import { CANONICAL_SERVICE, CANONICAL_TIMESTAMP_PATTERN } from './fixtures/canonicalContracts';

// ─── A server shaped like app.ts ──────────────────────────────────────────────

/** The exemption list, copied from `app.ts` so a drift here is visible. */
const CANONICAL_CONTRACT_PREFIXES = ['/api/v1', '/api/admin/catalog', '/api/catalog'];

const buildApp = () => {
  const app = express();
  app.set('trust proxy', 1);

  app.use((req, _res, next) => { (req as any).id = 'generated-uuid-placeholder'; next(); });
  app.use(correlationMiddleware);
  app.use(requestLogMiddleware);
  app.use(express.json());

  // Request parity — exempt under /api/v1, exactly as app.ts does it.
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/v1')) return next();
    return requestParityMiddleware(req, res, next);
  });
  // Response parity — exempt for the canonical contract prefixes.
  app.use((req, res, next) => {
    if (CANONICAL_CONTRACT_PREFIXES.some((p) => req.path.startsWith(p))) return next();
    return parityMiddleware(req, res, next);
  });

  app.use(deprecationHeaders);

  // A v1 endpoint that republishes a canonical Service verbatim.
  app.get('/api/v1/catalog/services/:serviceId', (req, res) =>
    ok(res, req, { service: CANONICAL_SERVICE, fetchedAt: '2026-03-09T01:30:00.000Z' }),
  );
  app.post('/api/v1/bookings/:bookingId/cancel', (req, res) =>
    created(res, req, { bookingId: Number(req.params.bookingId), body: req.body }),
  );
  app.get('/api/v1/broken', (req, res) => fail(res, req, 'INTERNAL'));
  app.get('/api/v1/missing', (req, res) => fail(res, req, 'NOT_FOUND', 'No such thing.'));

  // A LEGACY endpoint serving the same object, so the two can be compared.
  app.get('/api/services/:serviceId/level2', (_req, res) =>
    res.status(200).json({ status: 'success', data: { service: CANONICAL_SERVICE } }),
  );
  // A legacy alias that the contract declares a successor for.
  const alias = __notices[0];
  if (alias) {
    (app as any)[alias.method](alias.path, (_req: any, res: any) => res.status(200).json({ ok: true }));
  }

  return app;
};

interface Res { status: number; headers: Record<string, string>; text: string; body: any }

const request = (
  base: string, method: string, path: string,
  opts: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<Res> =>
  new Promise((resolve, reject) => {
    const url = new URL(base + path);
    const payload = opts.body === undefined ? null : JSON.stringify(opts.body);
    const req = http.request(
      {
        hostname: url.hostname, port: url.port, path: url.pathname + url.search, method,
        headers: {
          ...(opts.headers ?? {}),
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          let body: any = null;
          try { body = text ? JSON.parse(text) : null; } catch { body = null; }
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string>,
            text,
            body,
          });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

let server: http.Server;
let base: string;

beforeAll(async () => {
  server = http.createServer(buildApp());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

beforeEach(() => { resetMetrics(); __resetRequestLog(); });

// ─── Parity mutation ──────────────────────────────────────────────────────────

describe('the parity middleware does not touch a v1 response', () => {
  it('a v1 Service carries no level2 in the raw bytes', async () => {
    /**
     * The defect in its original form: parity maps `name` → `level2`, and in
     * the legacy model `level2` means the SUBCATEGORY. A canonical Service came
     * back claiming its own name as its subcategory — a key whose established
     * meaning is contradicted by its value, on the contract the Flutter clients
     * are migrating onto.
     *
     * Asserted on the TEXT. A parsed object would let a duplicate or
     * differently-cased key slip through.
     */
    const res = await request(base, 'GET', '/api/v1/catalog/services/180');
    expect(res.status).toBe(200);
    expect(res.text).not.toMatch(/level2|level_2/i);
    expect(res.text).not.toMatch(/serviceName|service_name/);
  });

  it('the SAME object served by a legacy route DOES get parity keys', async () => {
    /**
     * The control. Without this the previous test would pass just as well if
     * parity were broken, uninstalled, or never reached — and the exemption
     * would be proving nothing.
     */
    const res = await request(base, 'GET', '/api/services/180/level2');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/level2|level_2|serviceName|service_name/i);
  });

  it('v1 receives exactly the keys the handler wrote, and no others', async () => {
    const res = await request(base, 'GET', '/api/v1/catalog/services/180');
    expect(Object.keys(res.body.data.service).sort())
      .toEqual(Object.keys(CANONICAL_SERVICE).sort());
  });

  it('the request half of parity is exempt too', async () => {
    // Request parity invents body keys. A v1 endpoint declares the body it
    // accepts, so a middleware adding keys means the declared shape is not the
    // shape the handler reads.
    const res = await request(base, 'POST', '/api/v1/bookings/84213/cancel', {
      body: { reason: 'customer changed plans' },
    });
    expect(res.status).toBe(201);
    expect(Object.keys(res.body.data.body)).toEqual(['reason']);
  });
});

// ─── Timestamps ───────────────────────────────────────────────────────────────

describe('timestamps survive serialization unchanged', () => {
  it('arrives as UTC ISO-8601 with milliseconds and a Z', async () => {
    const res = await request(base, 'GET', '/api/v1/catalog/services/180');
    expect(res.body.data.fetchedAt).toMatch(CANONICAL_TIMESTAMP_PATTERN);
  });

  it('carries no local-offset form anywhere in the raw response', async () => {
    // Same instant, different string: a cache key that no longer matches and a
    // "today" filter that is wrong for eight hours a day in Manila.
    const res = await request(base, 'GET', '/api/v1/catalog/services/180');
    expect(res.text).not.toMatch(/\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/);
  });

  it('a price is not reformatted on the way out', async () => {
    const res = await request(base, 'GET', '/api/v1/catalog/services/180');
    expect(res.text).toContain('1234.56');
    expect(res.body.data.service.basePrice).toBe(1234.56);
    expect(typeof res.body.data.service.basePrice).toBe('number');
  });

  it('an integer id stays an integer on the wire', async () => {
    const res = await request(base, 'GET', '/api/v1/catalog/services/180');
    expect(res.text).toMatch(/"id":180/);
    expect(res.text).not.toMatch(/"id":"180"/);
  });
});

// ─── Envelope ─────────────────────────────────────────────────────────────────

describe('the envelope on the wire is the envelope the contract declares', () => {
  it('success is { data } with no status flag', async () => {
    const res = await request(base, 'GET', '/api/v1/catalog/services/180');
    expect(Object.keys(res.body)).toEqual(['data']);
    expect(res.body).not.toHaveProperty('success');
    expect(res.body).not.toHaveProperty('status');
  });

  it('failure is { error: { code, message, requestId } } with the declared status', async () => {
    const res = await request(base, 'GET', '/api/v1/missing');
    expect(res.status).toBe(404);
    expect(Object.keys(res.body)).toEqual(['error']);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.requestId).toBeTruthy();
  });

  it('an INTERNAL failure carries no exception text', async () => {
    // §21 on the wire: the caller gets a code and a request id, the detail goes
    // to the log.
    const res = await request(base, 'GET', '/api/v1/broken');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL');
    expect(res.text).not.toMatch(/at Object\.|node_modules|\.ts:\d+/);
  });

  it('every response carries X-Request-Id as a header, parseable body or not', async () => {
    // A proxy 502 leaves a client unable to read the body; the header still
    // gives support something to search on.
    for (const path of ['/api/v1/catalog/services/180', '/api/v1/missing', '/api/v1/broken']) {
      const res = await request(base, 'GET', path);
      expect(res.headers['x-request-id']).toBeTruthy();
    }
  });
});

// ─── Correlation over the wire ────────────────────────────────────────────────

describe('correlation is end to end', () => {
  it('adopts a caller-supplied id and echoes it back', async () => {
    const res = await request(base, 'GET', '/api/v1/catalog/services/180', {
      headers: { 'x-request-id': 'client-trace-0001' },
    });
    expect(res.headers['x-request-id']).toBe('client-trace-0001');
  });

  it('puts the adopted id in the error envelope too', async () => {
    const res = await request(base, 'GET', '/api/v1/missing', {
      headers: { 'x-correlation-id': 'client-trace-0002' },
    });
    expect(res.body.error.requestId).toBe('client-trace-0002');
  });

  it('refuses an id that would forge a log line, and falls back to its own', async () => {
    /**
     * A caller-controlled value reaching a line-delimited log can inject a
     * whole fake entry. Rejected at the boundary, and the request still
     * succeeds — a bad header is not the caller's problem to fix.
     */
    const res = await request(base, 'GET', '/api/v1/catalog/services/180', {
      headers: { 'x-request-id': 'aaaaaaaa bbbb"cccc' },
    });
    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBe('generated-uuid-placeholder');
  });

  it('the emitted log line names the route TEMPLATE, not the id', async () => {
    await request(base, 'GET', '/api/v1/catalog/services/180');
    const line = __lastRequestLogLine();
    expect(line).not.toBeNull();
    expect(line!.route).toBe('/api/v1/catalog/services/:id');
    expect(line!.route).not.toContain('180');
    expect(line!.namespace).toBe('v1');
    expect(line!.status).toBe(200);
    expect(typeof line!.durationMs).toBe('number');
  });

  it('the log line carries a role and never an actor identity', async () => {
    await request(base, 'GET', '/api/v1/catalog/services/180');
    const line = __lastRequestLogLine()!;
    expect(line.actorRole).toBe('anonymous');

    // Asserted on the KEYS. A substring search over the serialized line is the
    // wrong instrument: "uid" is a substring of "uuid", so a request id would
    // fail a test that was looking for a user id.
    const keys = Object.keys(line);
    for (const forbidden of ['uid', 'userId', 'user_id', 'actorId', 'customerUid', 'workerUid']) {
      expect(keys).not.toContain(forbidden);
    }
    expect(Object.keys(line.entity ?? {})).toEqual(['serviceId']);
  });

  it('the whole line serializes to JSON without a secret in it', async () => {
    await request(base, 'GET', '/api/v1/catalog/services/180', {
      headers: { authorization: 'Bearer super-secret-token-value' },
    });
    const serialized = JSON.stringify(__lastRequestLogLine());
    expect(serialized).not.toContain('super-secret-token-value');
    expect(serialized).not.toContain('Bearer');
  });
});

// ─── Metrics ──────────────────────────────────────────────────────────────────

describe('every request is counted', () => {
  it('records the request with a templated route label', async () => {
    await request(base, 'GET', '/api/v1/catalog/services/180');
    const counter = snapshot().counters.find((c) => c.name === 'http_requests_total');
    expect(counter).toBeDefined();
    expect(counter!.labels.route).toBe('/api/v1/catalog/services/:id');
    expect(counter!.labels.statusClass).toBe('2xx');
  });

  it('two different ids collapse to ONE series', async () => {
    // Cardinality: a metric keyed on the concrete path is one series per
    // booking, which is how a monitoring bill and an outage arrive together.
    await request(base, 'GET', '/api/v1/catalog/services/180');
    await request(base, 'GET', '/api/v1/catalog/services/999');
    const series = snapshot().counters.filter((c) => c.name === 'http_requests_total');
    expect(series).toHaveLength(1);
    expect(series[0].value).toBe(2);
  });

  it('observes latency into the histogram', async () => {
    await request(base, 'GET', '/api/v1/catalog/services/180');
    const histogram = snapshot().histograms.find((h) => h.name === 'http_request_duration_ms');
    expect(histogram).toBeDefined();
    expect(histogram!.count).toBe(1);
    expect(histogram!.p50).not.toBeNull();
  });

  it('separates a failure into its own status class', async () => {
    await request(base, 'GET', '/api/v1/catalog/services/180');
    await request(base, 'GET', '/api/v1/missing');
    const classes = snapshot()
      .counters.filter((c) => c.name === 'http_requests_total')
      .map((c) => c.labels.statusClass)
      .sort();
    expect(classes).toEqual(['2xx', '4xx']);
  });
});

// ─── Deprecation headers ──────────────────────────────────────────────────────

describe('legacy aliases announce their successor', () => {
  const alias = __notices[0];

  it('there is at least one alias to announce', () => {
    expect(__notices.length).toBeGreaterThan(0);
  });

  it('carries Deprecation and a successor Link', async () => {
    const res = await request(base, alias.method.toUpperCase(), alias.path.replace(/:\w+/g, '123'));
    expect(res.headers.deprecation).toBe('true');
    expect(res.headers.link).toContain('rel="successor-version"');
    expect(res.headers.link).toContain(alias.successor);
  });

  it('does NOT change the status or the body', async () => {
    /**
     * The property that makes this safe to ship in front of five live clients.
     * A deprecation notice that alters a response is not a notice.
     */
    const res = await request(base, alias.method.toUpperCase(), alias.path.replace(/:\w+/g, '123'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('emits no Sunset date, because none is currently keepable', async () => {
    // A date the platform cannot keep teaches client teams to ignore the
    // header, and then the route that really is going away is ignored too.
    const res = await request(base, alias.method.toUpperCase(), alias.path.replace(/:\w+/g, '123'));
    expect(res.headers.sunset).toBeUndefined();
  });

  it('a canonical v1 route is never marked deprecated', async () => {
    const res = await request(base, 'GET', '/api/v1/catalog/services/180');
    expect(res.headers.deprecation).toBeUndefined();
    expect(res.headers.link).toBeUndefined();
  });
});
