/**
 * Legacy traffic has to be countable before an alias can be retired.
 *
 * The migration matrix marks 22 routes ALIAS_TEMPORARILY. "Temporarily" is a
 * promise nobody can keep without numbers, and the wrong way to get them is a
 * second hand-maintained list of paths — that list drifts from the matrix, and
 * then the route you delete is the one nobody was counting.
 *
 * These tests check the two things that make the counting trustworthy: the
 * watch list is DERIVED from the contract, and the middleware records no PII.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' }, tempId: undefined }));
jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
  pool: { connect: jest.fn() },
}));

import express from 'express';
import http from 'http';
import { AddressInfo } from 'net';
import {
  legacyContractTelemetry,
  snapshot,
  clientLabel,
  buildWatchList,
  __resetLegacyContractTelemetry,
} from '../src/api/v1/legacyTelemetry';
import { V1_CONTRACT } from '../src/api/v1/contract';

let server: http.Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(legacyContractTelemetry);
  app.all('/{*any}', (_req, res) => { res.json({ ok: true }); });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  // Node's global fetch keeps sockets alive through undici's agent, so close()
  // alone leaves the handle open and jest reports a worker that would not exit.
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => __resetLegacyContractTelemetry());

const hit = (method: string, path: string, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method, headers });

describe('the watch list is derived, not maintained', () => {
  it('watches every legacy mapping the contract declares and nothing else', () => {
    const declared = new Set<string>();
    for (const e of V1_CONTRACT) for (const l of e.legacy) declared.add(`${l.method} ${l.path}`);
    const watched = new Set(buildWatchList().map((w) => `${w.method} ${w.path}`));
    expect([...watched].sort()).toEqual([...declared].sort());
  });

  it('attributes each watched route to a canonical successor', () => {
    for (const w of buildWatchList()) {
      expect(V1_CONTRACT.some((e) => e.id === w.canonical)).toBe(true);
    }
  });

  it('is not empty — an empty watch list would pass every other assertion here', () => {
    expect(buildWatchList().length).toBeGreaterThan(15);
  });
});

describe('counting', () => {
  it('records a hit on a watched legacy route', async () => {
    await hit('GET', '/api/auth/me');
    const rows = snapshot().routes;
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe('GET /api/auth/me');
    expect(rows[0].hits).toBe(1);
    expect(rows[0].canonical).toBe('identity.me');
  });

  it('matches a parameterised legacy path against a concrete request', async () => {
    await hit('GET', '/api/users/firebase-uid-abc/bookings');
    expect(snapshot().routes[0].key).toBe('GET /api/users/:userId/bookings');
  });

  it('does not count a path that merely starts the same way', async () => {
    await hit('GET', '/api/users/firebase-uid-abc/bookings/7');
    expect(snapshot().routes).toHaveLength(0);
  });

  it('does not count the canonical v1 route as legacy traffic', async () => {
    await hit('GET', '/api/v1/me');
    expect(snapshot().routes).toHaveLength(0);
  });

  it('distinguishes verbs — a POST to a watched GET path is not a hit', async () => {
    await hit('POST', '/api/auth/me');
    expect(snapshot().routes).toHaveLength(0);
  });

  it('separates callers that present a bearer token from those that do not', async () => {
    await hit('GET', '/api/auth/me', { authorization: 'Bearer x' });
    await hit('GET', '/api/auth/me');
    const row = snapshot().routes[0];
    expect(row.hits).toBe(2);
    expect(row.withBearer).toBe(1);
  });

  it('breaks hits down by declared client and version', async () => {
    await hit('GET', '/api/auth/me', { 'x-servana-client': 'provider-web', 'x-servana-client-version': '2.4.1' });
    await hit('GET', '/api/auth/me', { 'x-servana-client': 'provider-web', 'x-servana-client-version': '2.4.1' });
    await hit('GET', '/api/auth/me', { 'x-servana-client': 'provider-mobile' });
    expect(snapshot().routes[0].clients).toEqual({ 'provider-web@2.4.1': 2, 'provider-mobile': 1 });
  });

  it('never blocks a request, even for a route it does not recognise', async () => {
    const res = await hit('GET', '/api/something-unwatched');
    expect(res.status).toBe(200);
  });
});

describe('what it refuses to record (§58)', () => {
  it('keeps the path PARAMETER out of the key — a uid must not land in a log', async () => {
    await hit('GET', '/api/users/a-real-customer-uid/bookings');
    const serialised = JSON.stringify(snapshot());
    expect(serialised).not.toContain('a-real-customer-uid');
    expect(serialised).toContain('/api/users/:userId/bookings');
  });

  it('does not record the raw User-Agent, which carries device and OS build', () => {
    const req: any = { get: (h: string) => (h === 'user-agent' ? 'Dart/3.4 (dart:io) Android 14; SM-S918B' : undefined) };
    expect(clientLabel(req)).toBe('ua:dart');
  });

  it('ignores a client label it does not recognise rather than logging it verbatim', () => {
    const req: any = { get: (h: string) => (h === 'x-servana-client' ? 'attacker-supplied-<script>' : undefined) };
    expect(clientLabel(req)).toBe('unknown');
  });

  it('ignores a malformed version string', () => {
    const req: any = {
      get: (h: string) =>
        h === 'x-servana-client' ? 'provider-web' : h === 'x-servana-client-version' ? 'a'.repeat(200) : undefined,
    };
    expect(clientLabel(req)).toBe('provider-web');
  });

  it('records no query string and no body', async () => {
    await hit('GET', '/api/auth/me?token=super-secret');
    expect(JSON.stringify(snapshot())).not.toContain('super-secret');
  });
});
