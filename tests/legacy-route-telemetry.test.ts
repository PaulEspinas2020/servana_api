/**
 * Telemetry over the unauthenticated legacy `/api/workers/*` family.
 *
 * Step 4 of docs/WORKER_ROUTE_MIGRATION.md — deleting those 36 routes — is
 * gated on their traffic reaching zero, and that is not a judgement anyone can
 * make without numbers. This produces them, and flags the enumeration pattern
 * the missing auth allows: a caller claiming many distinct workerUids is doing
 * what no genuine worker app does, since a real one only ever sends its own.
 *
 * Two properties matter more than the counting: it must log no PII (§58), and
 * it must never take a request down. It sits in front of routes a live app
 * depends on.
 */

import {
  legacyRouteTelemetry,
  __resetLegacyTelemetry,
  __distinctUidsFor,
} from '../src/middleware/legacyRouteTelemetry';

const WORKER_UID = 'firebase-uid-abcdef123456';
const SOURCE = '203.0.113.7';

function call(overrides: any = {}) {
  const req: any = {
    method: 'GET',
    path: '/workers/x/job-cards',
    query: {},
    params: {},
    headers: { 'x-forwarded-for': SOURCE },
    socket: { remoteAddress: SOURCE },
    ...overrides,
  };
  const next = jest.fn();
  legacyRouteTelemetry(req, {} as any, next);
  return next;
}

let info: jest.SpyInstance;
let warn: jest.SpyInstance;

beforeEach(() => {
  __resetLegacyTelemetry();
  info = jest.spyOn(console, 'info').mockImplementation(() => {});
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

const logged = () =>
  [...info.mock.calls, ...warn.mock.calls].map((c) => String(c[0])).join('\n');

describe('never interferes with the request', () => {
  it('always calls next()', () => {
    expect(call()).toHaveBeenCalledTimes(1);
  });

  it('calls next() even when the request object is malformed', () => {
    // A logging bug must not become an outage on a route the live app needs.
    const next = jest.fn();
    legacyRouteTelemetry({} as any, {} as any, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('logs no personal data', () => {
  it('never writes a raw worker uid', () => {
    call({ query: { workerUid: WORKER_UID } });
    expect(logged()).not.toContain(WORKER_UID);
  });

  it('never writes a raw source address', () => {
    call({ query: { workerUid: WORKER_UID } });
    expect(logged()).not.toContain(SOURCE);
  });

  it('still records that a uid was claimed', () => {
    // Redaction must not make the signal useless.
    call({ query: { workerUid: WORKER_UID } });
    expect(logged()).toContain('claimsUid=');
    expect(logged()).not.toContain('claimsUid=no');
  });

  it('records whether a bearer token was present', () => {
    call({ headers: { authorization: 'Bearer x', 'x-forwarded-for': SOURCE } });
    expect(logged()).toContain('bearer=yes');
    info.mockClear();
    call();
    expect(logged()).toContain('bearer=no');
  });
});

describe('enumeration detection', () => {
  it('stays quiet for one worker calling repeatedly about itself', () => {
    for (let i = 0; i < 20; i++) call({ query: { workerUid: WORKER_UID } });
    expect(__distinctUidsFor(SOURCE)).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once a source claims many distinct uids', () => {
    for (let i = 0; i < 5; i++) call({ query: { workerUid: `uid-${i}` } });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('distinct workerUids');
  });

  it('warns only once per source, not once per request', () => {
    // A scanner should produce one line, not thousands.
    for (let i = 0; i < 50; i++) call({ query: { workerUid: `uid-${i}` } });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('reads the uid from the path when it is not a query param', () => {
    call({ params: { uid: 'uid-a' } });
    call({ params: { workerId: 'uid-b' } });
    expect(__distinctUidsFor(SOURCE)).toBe(2);
  });

  it('tracks sources independently', () => {
    for (let i = 0; i < 4; i++) {
      call({ query: { workerUid: `uid-${i}` } });
    }
    call({
      query: { workerUid: 'other' },
      headers: { 'x-forwarded-for': '198.51.100.9' },
      socket: { remoteAddress: '198.51.100.9' },
    });
    expect(__distinctUidsFor(SOURCE)).toBe(4);
    expect(__distinctUidsFor('198.51.100.9')).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });
});
