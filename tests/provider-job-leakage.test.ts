/**
 * Provider A cannot read Provider B's job.
 *
 * The ACT side of this is already proven at the executor: a provider who is
 * not the current assignment is refused `NOT_AUTHORIZED`, and an identity in
 * the payload is ignored (`booking-transition-executor.test.ts`). The READ side
 * was not, and the two fail differently — a refused write leaves a trail and an
 * angry provider, while a leaked read is silent and complete.
 *
 * Three separate properties, because each can be broken without the others:
 *
 *   1. the QUERY is scoped — both the booking and the assignment row are
 *      pinned to the requesting provider;
 *   2. the HANDLER takes identity from the token and offers no way to name
 *      another provider, whatever the request carries;
 *   3. a job that exists but is not yours is indistinguishable from one that
 *      does not exist, so the endpoint is not an assignment oracle.
 *
 * ## What this suite does NOT cover
 *
 * "Account switch clears the scoped job cache" is a CLIENT property: this
 * backend holds no per-account response cache, so there is nothing here to
 * clear. The backend half of that guarantee is property 2 — a request carrying
 * a different token gets a different provider's jobs and never a stale one —
 * plus the absence of any shared-cache directive on a provider-scoped response,
 * which is asserted below.
 */

jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn() },
}));
jest.mock('../src/config', () => ({
  db: { schema: 'servana' },
  firebaseConfig: {},
}));
// technicianService reaches Mongo at import time for chat/log side effects,
// which this suite never exercises.
jest.mock('../src/db/mongodbQuery', () => ({ __esModule: true, default: {} }));

import dbQuery from '../src/db/dbQuery';
import { getJobCardsByWorker, getJobCardByWorker } from '../src/services/technicianService';
import { handlers } from '../src/api/v1/domains/providerJobs';

const q = dbQuery.query as jest.Mock;

const PROVIDER_A = 'provider-a-uid';
const PROVIDER_B = 'provider-b-uid';

/** B's booking. Present in the table, and never A's to read. */
const BOOKING_OF_B = {
  id: 4242,
  booking_id: 4242,
  worker_uid: PROVIDER_B,
  status: 'ACCEPTED',
  worker_status: 'ACCEPTED',
  has_escalation: false,
  schedule: '2026-09-01T10:00:00.000Z',
  customer_id: 'cust-1',
  first_name: 'Maria',
  last_name: 'Santos',
  phone_number: '+639171234567',
  post_town: 'Makati',
  country: 'PH',
};

/**
 * A database that honours the scoping predicate instead of ignoring it.
 *
 * The row is returned only when the query asks for its owner, which is what
 * PostgreSQL does with `WHERE b.worker_uid = $1`. The SQL assertions below are
 * what prove the predicate is actually in the query — this fake alone would be
 * satisfied by a service that filtered in JavaScript, and the point is that it
 * does not have to.
 */
const mountRows = (rows: Array<Record<string, unknown>>) => {
  q.mockReset();
  q.mockImplementation((sql: string, params: any[] = []) => {
    if (!/FROM servana\.bookings b/.test(sql)) return Promise.resolve({ rows: [], rowCount: 0 });
    const uid = params[0];
    const bookingId = params[1] ?? null;
    const visible = rows
      .filter((r) => r.worker_uid === uid)
      .filter((r) => bookingId === null || r.id === bookingId);
    return Promise.resolve({ rows: visible, rowCount: visible.length });
  });
};

describe('the job-card query is scoped to the requesting provider', () => {
  it('pins BOTH the booking and the assignment row to the caller', async () => {
    mountRows([BOOKING_OF_B]);
    await getJobCardsByWorker(PROVIDER_A);

    const [sql, params] = q.mock.calls[0];
    // Two predicates, not one. The lateral join picks the assignment row, and
    // an unpinned join there would hand back somebody else's assignment status
    // attached to a booking that passed the outer filter.
    expect(sql).toContain('WHERE b.worker_uid = $1');
    expect(sql).toContain('bw1.worker_uid = $1');
    expect(params[0]).toBe(PROVIDER_A);
  });

  it('does not return a booking assigned to another provider', async () => {
    mountRows([BOOKING_OF_B]);
    expect(await getJobCardsByWorker(PROVIDER_A)).toEqual([]);
    expect(await getJobCardsByWorker(PROVIDER_B)).toHaveLength(1);
  });

  it('does not return another provider’s job even when the id is known', async () => {
    // Knowing the booking id is not authorization: ids are identifiers.
    mountRows([BOOKING_OF_B]);
    expect(await getJobCardByWorker(PROVIDER_A, BOOKING_OF_B.id)).toBeNull();
    expect(await getJobCardByWorker(PROVIDER_B, BOOKING_OF_B.id)).toMatchObject({ id: BOOKING_OF_B.id });
  });

  it('a booking id that does not exist looks exactly like one that is not yours', async () => {
    // Both `null`. An endpoint that distinguished them would answer "that
    // booking exists, but not for you" — an assignment oracle.
    mountRows([BOOKING_OF_B]);
    expect(await getJobCardByWorker(PROVIDER_A, BOOKING_OF_B.id)).toBeNull();
    expect(await getJobCardByWorker(PROVIDER_A, 999999)).toBeNull();
  });
});

// ─── The handler, end to end over the same mocked database ────────────────────

interface FakeResponse {
  statusCode: number;
  body: any;
  headers: Record<string, string>;
  set: (k: string, v: string) => FakeResponse;
  status: (c: number) => FakeResponse;
  json: (b: any) => FakeResponse;
}

const fakeRes = (): FakeResponse => {
  const res: FakeResponse = {
    statusCode: 0,
    body: undefined,
    headers: {},
    set(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  return res;
};

const reqAs = (uid: string | undefined, over: Record<string, unknown> = {}): any => ({
  user: uid ? { uid } : undefined,
  params: {},
  query: {},
  body: {},
  id: 'req-1',
  ...over,
});

describe('the v1 handler takes identity from the token and nowhere else', () => {
  it('serves the caller’s own jobs', async () => {
    mountRows([BOOKING_OF_B]);
    const res = fakeRes();
    await handlers['provider.jobs.list'](reqAs(PROVIDER_B), res as any);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.jobs).toHaveLength(1);
    expect(q.mock.calls[0][1][0]).toBe(PROVIDER_B);
  });

  it('ignores a provider id supplied in the path, query or body', async () => {
    /**
     * The BOLA that the legacy `/api/workers/:workerId/job-cards` shape made
     * possible. v1 offers no such parameter, and a request that invents one
     * must not be honoured — otherwise the parameter is back, undocumented.
     */
    mountRows([BOOKING_OF_B]);
    const res = fakeRes();
    await handlers['provider.jobs.list'](reqAs(PROVIDER_A, {
      params: { workerId: PROVIDER_B },
      query: { workerId: PROVIDER_B, uid: PROVIDER_B },
      body: { workerUid: PROVIDER_B, providerUid: PROVIDER_B },
    }), res as any);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.jobs).toEqual([]);
    for (const call of q.mock.calls) expect(call[1][0]).toBe(PROVIDER_A);
  });

  it('answers NOT_FOUND for another provider’s job, in the same words as a missing one', async () => {
    mountRows([BOOKING_OF_B]);

    const notMine = fakeRes();
    await handlers['provider.jobs.get'](
      reqAs(PROVIDER_A, { params: { bookingId: String(BOOKING_OF_B.id) } }), notMine as any);

    const missing = fakeRes();
    await handlers['provider.jobs.get'](
      reqAs(PROVIDER_A, { params: { bookingId: '999999' } }), missing as any);

    expect(notMine.statusCode).toBe(404);
    expect(notMine.body.error.code).toBe('NOT_FOUND');
    // Byte-identical. A different message would answer the question the 404
    // exists to refuse: does that booking exist, and is it somebody else's?
    expect(notMine.body.error.message).toBe(missing.body.error.message);
  });

  it('serves the same booking to the provider it belongs to', async () => {
    // The negative above would also pass if the endpoint were simply broken.
    mountRows([BOOKING_OF_B]);
    const res = fakeRes();
    await handlers['provider.jobs.get'](
      reqAs(PROVIDER_B, { params: { bookingId: String(BOOKING_OF_B.id) } }), res as any);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.bookingId).toBe(BOOKING_OF_B.id);
  });

  it('does not mark a provider-scoped response shareable', async () => {
    /**
     * The backend half of "an account switch clears the scoped job cache".
     * There is no per-account cache in this process, so the only way one
     * provider's jobs could survive a switch is an intermediary keeping them —
     * which requires a shared-cache directive this response must never carry.
     */
    mountRows([BOOKING_OF_B]);
    const res = fakeRes();
    await handlers['provider.jobs.list'](reqAs(PROVIDER_B), res as any);

    const cacheControl = res.headers['Cache-Control'] ?? res.headers['cache-control'] ?? '';
    expect(cacheControl).not.toMatch(/public|max-age|s-maxage/);
  });

  it('refuses an unauthenticated request rather than defaulting to somebody', async () => {
    mountRows([BOOKING_OF_B]);
    const res = fakeRes();
    await handlers['provider.jobs.list'](reqAs(undefined), res as any);

    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    // Fails closed: no query ran at all.
    expect(q).not.toHaveBeenCalled();
  });
});
