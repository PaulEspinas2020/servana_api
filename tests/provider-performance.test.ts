/**
 * Performance metrics for the provider portal.
 *
 * The rule these lock is that a rate is never invented. With no decided
 * assignments there is no acceptance rate, and the answer is null rather than
 * 0 or 100 — a provider who has done nothing yet must not be shown a figure
 * that looks like a judgement of them.
 */

jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn() },
}));
jest.mock('../src/config', () => ({ db: { schema: 'servana' } }));

import dbQuery from '../src/db/dbQuery';
import { getProviderPerformance, ON_TIME_GRACE_MINUTES } from '../src/services/providerPerformanceService';

const q = dbQuery.query as jest.Mock;

const calls: Array<{ sql: string; params: any[] }> = [];

/** assignment aggregate row, cancelled count, rating row (optional). */
const respond = (assignment: any, cancelled = 0, rating?: any) => {
  calls.length = 0;
  q.mockReset();
  q.mockImplementation((sql: string, params: any[]) => {
    calls.push({ sql, params });
    if (/booking_workers/i.test(sql))            return Promise.resolve({ rows: [assignment] });
    if (/provider_rating_aggregates/i.test(sql)) return Promise.resolve({ rows: rating ? [rating] : [] });
    if (/bookings/i.test(sql))                   return Promise.resolve({ rows: [{ cancelled }] });
    return Promise.resolve({ rows: [] });
  });
};

const EMPTY = { accepted: 0, declined: 0, pending: 0, completed: 0, measured: 0, on_time: 0 };

describe('acceptance rate', () => {
  test('is null, not zero, when nothing has been decided', async () => {
    respond({ ...EMPTY, pending: 3 });
    const r = await getProviderPerformance('w1');
    expect(r.acceptance.rate).toBeNull();
    expect(r.acceptance.total).toBe(0);
  });

  test('counts COMPLETED as accepted — a finished job was not a refusal', async () => {
    // Asserted on the SQL rather than the row: the numerator is computed by the
    // FILTER clause, so `accepted` arrives already including COMPLETED. A
    // fixture that supplied them as separate fields would be testing a row
    // shape the database never produces.
    respond(EMPTY);
    await getProviderPerformance('w1');
    const sql = calls.find(c => /booking_workers/i.test(c.sql))!.sql;
    expect(sql).toMatch(/FILTER \(WHERE bw\.status IN \('ACCEPTED','COMPLETED'\)\)\s+AS accepted/);
    expect(sql).toMatch(/FILTER \(WHERE bw\.status = 'DECLINED'\)/);
  });

  test('rate is accepted over accepted+declined', async () => {
    respond({ ...EMPTY, accepted: 5, declined: 0, completed: 3 });
    const r = await getProviderPerformance('w1');
    expect(r.acceptance.count).toBe(5);
    expect(r.acceptance.rate).toBe(1);
  });

  test('excludes still-pending assignments from the denominator', async () => {
    // 4 accepted, 1 declined, 5 undecided → 0.8, not 4/10.
    respond({ ...EMPTY, accepted: 4, declined: 1, pending: 5 });
    const r = await getProviderPerformance('w1');
    expect(r.acceptance.total).toBe(5);
    expect(r.acceptance.rate).toBe(0.8);
    expect(r.acceptance.pending).toBe(5);
  });

  test('reports the sample size so a 1-of-1 cannot masquerade as a track record', async () => {
    respond({ ...EMPTY, accepted: 1 });
    const r = await getProviderPerformance('w1');
    expect(r.acceptance).toEqual(jasmineLikeObject({ count: 1, total: 1, rate: 1, declined: 0, pending: 0 }));
  });
});

describe('on-time rate', () => {
  test('is null when no job has a recorded start', async () => {
    respond({ ...EMPTY, completed: 2 });
    const r = await getProviderPerformance('w1');
    expect(r.onTime.rate).toBeNull();
    expect(r.onTime.total).toBe(0);
  });

  test('divides by jobs actually measured, not by all jobs', async () => {
    respond({ ...EMPTY, completed: 10, measured: 4, on_time: 3 });
    const r = await getProviderPerformance('w1');
    expect(r.onTime.total).toBe(4);
    expect(r.onTime.rate).toBe(0.75);
  });

  test('applies the grace window in SQL', async () => {
    respond(EMPTY);
    await getProviderPerformance('w1');
    const assignmentCall = calls.find(c => /booking_workers/i.test(c.sql))!;
    expect(assignmentCall.sql).toContain("INTERVAL '1 minute'");
    expect(assignmentCall.params[1]).toBe(ON_TIME_GRACE_MINUTES);
  });
});

describe('rating', () => {
  test('is null when the provider has no aggregate row', async () => {
    respond(EMPTY, 0, undefined);
    const r = await getProviderPerformance('w1');
    expect(r.rating.average).toBeNull();
    expect(r.rating.reviewCount).toBe(0);
  });

  test('a missing rating is null rather than 0 — 0 would render as a 0-star score', async () => {
    respond(EMPTY);
    const r = await getProviderPerformance('w1');
    expect(r.rating.average).not.toBe(0);
    expect(r.rating.average).toBeNull();
  });

  test('numeric strings from pg NUMERIC are coerced', async () => {
    respond(EMPTY, 0, { average_rating: '4.75', review_count: 12 });
    const r = await getProviderPerformance('w1');
    expect(r.rating.average).toBe(4.75);
    expect(r.rating.reviewCount).toBe(12);
  });
});

describe('scoping and status vocabulary', () => {
  test('every query is scoped to the caller uid', async () => {
    respond(EMPTY);
    await getProviderPerformance('worker-42');
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) { expect(c.params[0]).toBe('worker-42'); }
  });

  test('counts BOTH cancellation spellings live in this codebase', async () => {
    // technicianService writes 'CANCELED'; providerAvailabilityEngine matches
    // 'CANCELLED'. Matching one silently under-reports.
    respond(EMPTY, 7);
    const r = await getProviderPerformance('w1');
    const cancelCall = calls.find(c => /status = ANY/i.test(c.sql))!;
    expect(cancelCall.params[1]).toEqual(['CANCELLED', 'CANCELED']);
    expect(r.jobs.cancelled).toBe(7);
  });

  test('tolerates an empty aggregate row without throwing', async () => {
    q.mockReset();
    q.mockImplementation(() => Promise.resolve({ rows: [] }));
    const r = await getProviderPerformance('w1');
    expect(r.acceptance.rate).toBeNull();
    expect(r.jobs.completed).toBe(0);
  });
});

/** Local helper so the object comparison reads as one assertion. */
function jasmineLikeObject<T>(o: T): T { return o; }
