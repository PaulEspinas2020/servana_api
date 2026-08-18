/**
 * TAB 09 — the final Express error middleware.
 *
 * Driven over real HTTP against a composed Express app, per TAB 01: route
 * behaviour is asserted by making a request, not by reading source text. The
 * point of this handler is what a CALLER receives, which source text cannot show.
 */

import http from 'http';
import express from 'express';
import { startTestServer, request } from './support/httpTestServer';
import { terminalErrorHandler } from '../src/middleware/terminalErrorHandler';

let server: http.Server;
let closeServer: () => Promise<void>;
let base: string;

/** A pg-shaped error: the exact leak the acceptance criterion forbids. */
const pgLikeError = () =>
  Object.assign(
    new Error(
      'duplicate key value violates unique constraint ' +
        '"provider_notifications_notification_key_key1"',
    ),
    {
      code: '23505',
      table: 'provider_notifications',
      constraint: 'provider_notifications_notification_key_key1',
      detail: 'Key (notification_key)=(daily_active_bookings_2026-08-18) already exists.',
    },
  );

beforeAll(async () => {
  const app = express();
  app.use(express.json());

  // Mounted exactly as app.ts mounts it: the UUID stamp first, routes, then the
  // terminal handler LAST.
  app.use((req, _res, next) => {
    (req as any).id = 'test-request-id';
    next();
  });

  app.get('/api/v1/boom', () => {
    throw pgLikeError();
  });
  app.get('/api/legacy/boom', () => {
    throw pgLikeError();
  });
  app.get('/api/v1/rejected', async (_req, _res, next) => {
    // An async rejection forwarded by the route, which is how Express 5 and
    // hand-written catch blocks both surface a rejected query.
    next(pgLikeError());
  });
  app.get('/api/legacy/declared', () => {
    throw Object.assign(new Error('Online payment is temporarily unavailable'), {
      statusCode: 503,
      code: 'PAYMONGO_NOT_CONFIGURED',
    });
  });
  app.get('/api/legacy/declared-4xx', () => {
    throw Object.assign(new Error('That booking is not yours'), { statusCode: 403 });
  });
  app.get('/api/legacy/ok', (_req, res) => {
    res.status(200).json({ message: 'fine', legacyField: 'preserved' });
  });
  app.get('/api/legacy/own-error', (_req, res) => {
    // A legacy controller replying with its own error shape. The terminal
    // handler must never see or reshape this.
    res.status(422).json({ error: 'legacy shape', hint: 'unchanged' });
  });
  app.post('/api/legacy/parse', (_req, res) => {
    res.status(200).json({ ok: true });
  });
  app.get('/api/legacy/streamed', (_req, res) => {
    res.status(200);
    res.write('partial');
    throw new Error('failed mid-stream');
  });

  app.use(terminalErrorHandler);

  const started = await startTestServer(app);
  server = started.server;
  base = started.base;
  closeServer = started.close;
});

afterAll(async () => {
  await closeServer();
});

const get = (path: string) => request(base, 'GET', path, { headers: {} });

/**
 * A raw request, for the two cases the shared harness cannot express: sending
 * malformed JSON (it stringifies bodies) and reading a non-JSON reply (it
 * JSON.parses every response).
 */
const raw = (
  method: string,
  path: string,
  body?: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string }> =>
  new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method,
        headers: { connection: 'close', ...headers },
      },
      (res) => {
        let text = '';
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve({ status: res.statusCode ?? 0, text });
        };
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', finish);
        // A destroyed socket emits close WITHOUT end. That is the expected
        // outcome for the half-sent case, so it must resolve rather than hang.
        res.on('close', finish);
        res.on('aborted', finish);
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });

describe('a 5xx exposes nothing about the database', () => {
  it('leaks no stack, SQL, table name or constraint name', async () => {
    const res = await get('/api/v1/boom');
    expect(res.status).toBe(500);

    const raw = JSON.stringify(res.body);
    // The four things the acceptance criterion names, plus the stack.
    expect(raw).not.toMatch(/provider_notifications/);
    expect(raw).not.toMatch(/unique constraint/i);
    expect(raw).not.toMatch(/23505/);
    expect(raw).not.toMatch(/duplicate key/i);
    expect(raw).not.toMatch(/at Object|at Layer|\.ts:\d+/);
  });

  it('says something generic and useful instead', async () => {
    const res = await get('/api/v1/boom');
    expect(res.body.error.message).toMatch(/something went wrong/i);
  });

  it('treats a forwarded async rejection identically', async () => {
    const res = await get('/api/v1/rejected');
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/provider_notifications/);
  });
});

describe('the request id ties the response to the log', () => {
  it('returns it in the body and in X-Request-Id', async () => {
    const res = await get('/api/v1/boom');
    expect(res.body.error.requestId).toBe('test-request-id');
    expect(res.headers.get('x-request-id')).toBe('test-request-id');
  });

  it('is present on the legacy surface too', async () => {
    const res = await get('/api/legacy/boom');
    expect(res.body.requestId).toBe('test-request-id');
    expect(res.headers.get('x-request-id')).toBe('test-request-id');
  });
});

describe('no existing response shape moves', () => {
  it('a successful legacy response is untouched', async () => {
    const res = await get('/api/legacy/ok');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'fine', legacyField: 'preserved' });
  });

  it('a legacy controller that sends its OWN error keeps that shape', async () => {
    // The handler only runs where nothing has replied, so it cannot reshape this.
    const res = await get('/api/legacy/own-error');
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: 'legacy shape', hint: 'unchanged' });
  });

  it('legacy unhandled errors get the minimal legacy shape, NOT the v1 envelope', async () => {
    // Giving legacy clients the v1 envelope would be the breaking change the
    // STOP condition forbids.
    const res = await get('/api/legacy/boom');
    expect(res.body).toHaveProperty('message');
    expect(res.body).not.toHaveProperty('error.code');
  });

  it('v1 unhandled errors get the envelope v1 already documents', async () => {
    const res = await get('/api/v1/boom');
    expect(res.body.error.code).toBe('INTERNAL');
    expect(typeof res.body.error.message).toBe('string');
    expect(typeof res.body.error.requestId).toBe('string');
  });
});

describe('a deliberate status is honoured, so 4xx does not page an operator', () => {
  it('keeps a declared 503 and its own message', async () => {
    // paymentService throws exactly this shape when PayMongo is unconfigured.
    const res = await get('/api/legacy/declared');
    expect(res.status).toBe(503);
    // 5xx still gets the generic text — the status is honoured, the message is not
    // trusted, because a 5xx message is the leak risk.
    expect(res.body.message).toMatch(/something went wrong/i);
  });

  it('keeps a declared 403 AND its message, which was written for the caller', async () => {
    const res = await get('/api/legacy/declared-4xx');
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('That booking is not yours');
  });

  it('reports malformed client JSON as 400, not 500', async () => {
    // Reporting a client's bad JSON as a server fault both misleads the caller
    // and pages an operator for something no operator can fix.
    const res = await raw('POST', '/api/legacy/parse', '{"broken":', {
      'content-type': 'application/json',
    });
    expect(res.status).toBe(400);
    expect(res.text).not.toMatch(/at Object|\.ts:\d+/);
  });
});

describe('a half-sent response is not corrupted', () => {
  it('does not append an error body to a response already streaming', async () => {
    /**
     * Writing JSON into a half-sent body would corrupt it. Express's default
     * handler destroys the socket instead, so the client sees a truncated
     * response — bad, but recoverable, and never mixed content.
     *
     * Either outcome is acceptable; what must NOT happen is our error envelope
     * appended after the partial body.
     */
    const res = await raw('GET', '/api/legacy/streamed').catch(() => null);
    if (res) {
      expect(res.text).not.toMatch(/requestId/);
      expect(res.text).not.toMatch(/Something went wrong/i);
    }
  });
});

describe('a half-sent response delegates instead of replying', () => {
  it('calls next(err) and writes NOTHING when headers are already sent', () => {
    /**
     * Asserted directly on the handler, because over the wire this is
     * indistinguishable: both paths end with a destroyed socket, so an HTTP
     * test cannot tell them apart. Mutation-testing proved that — removing the
     * headersSent guard left the HTTP test green.
     *
     * What differs is the internals. Without the guard, res.set() throws
     * ERR_HTTP_HEADERS_SENT from inside the error handler, which is an error
     * raised while handling an error — the case Express cannot report at all.
     */
    const next = jest.fn();
    const res: any = {
      headersSent: true,
      set: jest.fn(),
      status: jest.fn(() => res),
      json: jest.fn(() => res),
    };
    const err = new Error('failed mid-stream');

    terminalErrorHandler(err, { method: 'GET', path: '/x', originalUrl: '/x' } as any, res, next);

    expect(next).toHaveBeenCalledWith(err);
    expect(res.set).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});

describe('mounted so that it actually catches', () => {
  it('is the LAST app.use in app.ts', () => {
    /**
     * Express selects a 4-arg handler only from middleware registered AFTER the
     * route that threw. Mounted above any route, that route is silently excluded
     * — which looks like "the handler doesn't work for this one endpoint".
     */
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.resolve(__dirname, '../src/app.ts'), 'utf8');

    const mount = src.lastIndexOf('app.use(terminalErrorHandler)');
    expect(mount).toBeGreaterThan(-1);

    const uses = Array.from(src.matchAll(/^app\.use\(/gm)).map((m: any) => m.index);
    expect(Math.max(...uses)).toBe(src.lastIndexOf('\napp.use(terminalErrorHandler)') + 1);
  });
});
