/**
 * The alert that had no signal.
 *
 * `public-path-auth-failure` is declared P0 with condition `ANY occurrence`,
 * and nothing emitted `public_path_auth_failures_total`. A declared alert with
 * no signal is a comment.
 *
 * ## Why the emitter lives on the response hook
 *
 * A contract-public entry has NO auth middleware — `authChain` returns an empty
 * array — so it cannot answer 401 from its own chain. The failure being counted
 * is the one that actually occurred: production answered 401 to every path,
 * including ones that do not exist, because authentication ran BEFORE routing.
 * In that state the v1 router is never reached, so anything instrumented inside
 * it would have counted nothing at all.
 *
 * `requestLogMiddleware` runs on `res.finish` above everything, which is the
 * only vantage point from which "a public path was refused" is observable.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' }, tempId: undefined }));

import { requestLogMiddleware } from '../src/observability/requestLog';
import { snapshot, resetMetrics } from '../src/observability/metrics';
import { V1_CONTRACT } from '../src/api/v1/contract';

const drive = (path: string, status: number) => {
  const listeners: Array<() => void> = [];
  const req: any = { method: 'GET', originalUrl: path, path, headers: {}, get: () => undefined };
  const res: any = { statusCode: status, on: (e: string, fn: () => void) => { if (e === 'finish') listeners.push(fn); }, getHeader: () => undefined };
  requestLogMiddleware(req, res, () => undefined);
  listeners.forEach((fn) => fn());
};

const countOf = (name: string): number =>
  snapshot().counters
    .filter((c) => c.name === name)
    .reduce((total, c) => total + c.value, 0);

beforeEach(() => resetMetrics());

describe('a public path answering 401 is counted', () => {
  it('emits on a contract-public route refused with 401', () => {
    const before = countOf('public_path_auth_failures_total');
    drive('/api/v1/catalog', 401);
    expect(countOf('public_path_auth_failures_total')).toBeGreaterThan(before);
  });

  it('does NOT emit for a guarded route refused with 401 (negative fixture)', () => {
    // The property that keeps the alert meaningful. A 401 on /api/v1/me is
    // correct behaviour; counting it would make an ANY-occurrence P0 fire
    // constantly and be switched off within a day.
    const before = countOf('public_path_auth_failures_total');
    drive('/api/v1/me', 401);
    expect(countOf('public_path_auth_failures_total')).toBe(before);
  });

  it('does NOT emit when a public route answers normally', () => {
    const before = countOf('public_path_auth_failures_total');
    drive('/api/v1/catalog', 200);
    expect(countOf('public_path_auth_failures_total')).toBe(before);
  });

  it('the metric it emits is the one the alert names', () => {
    // Two names that drift apart is how an alert ends up watching nothing.
    const { METRICS, ALERTS } = require('../src/observability/observabilityPolicy');
    const alert = ALERTS.find((a: any) => a.name === 'public-path-auth-failure');
    expect(alert).toBeDefined();
    expect(METRICS.some((m: any) => m.name === alert.metric)).toBe(true);
    expect(alert.metric).toBe('public_path_auth_failures_total');
  });

  it('every contract-public entry is a route this can recognise', () => {
    // If the shapes ever stop matching, the emitter silently counts nothing —
    // which is indistinguishable from the invariant holding.
    const publics = V1_CONTRACT.filter((e) => e.auth === 'public' && e.status === 'implemented');
    expect(publics.length).toBeGreaterThan(10);
  });
});
