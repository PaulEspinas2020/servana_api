/**
 * A suspension has to mean something on the server (Command 4 §34).
 *
 * It used to be a client-side state: the app resolved account_status into an
 * AppStartState and routed a suspended provider to a status screen, while their
 * Firebase token stayed valid, verifyAuth kept passing, and the backend kept
 * serving. Anyone holding that token — including the suspended provider with
 * any HTTP client — could still accept bookings, start jobs and move location.
 *
 * Routing is not authorization.
 */

jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn() },
}));
jest.mock('../src/config', () => ({ db: { schema: 'servana' } }));

import dbQuery from '../src/db/dbQuery';
import requireActiveProvider from '../src/middleware/requireActiveProvider';

const q = dbQuery.query as jest.Mock;

const run = async (status: string | null | undefined, uid: string | null = 'w-1') => {
  q.mockReset();
  if (status === undefined) q.mockRejectedValue(new Error('db down'));
  else q.mockResolvedValue({ rows: status === null ? [] : [{ account_status: status }] });

  const req: any = { user: uid ? { uid } : undefined };
  const body: any = {};
  let code = 0;
  const res: any = {
    status: (c: number) => { code = c; return res; },
    json: (b: any) => { Object.assign(body, b); return res; },
  };
  let passed = false;
  await requireActiveProvider(req, res, () => { passed = true; });
  return { passed, code, body };
};

describe('providers who may work', () => {
  test.each(['active', 'approved', 'ACTIVE'])('%s passes', async (s) => {
    expect((await run(s)).passed).toBe(true);
  });
});

describe('providers who may not', () => {
  test.each([
    ['suspended', 'PROVIDER_SUSPENDED'],
    ['rejected', 'PROVIDER_REJECTED'],
    ['pending', 'PROVIDER_NOT_APPROVED'],
    ['under_review', 'PROVIDER_NOT_APPROVED'],
  ])('%s is denied with %s', async (status, code) => {
    const r = await run(status);
    expect(r.passed).toBe(false);
    expect(r.code).toBe(403);
    expect(r.body.error.code).toBe(code);
  });

  test('the denial does not echo the raw status back', () => {
    // The client routes on the code; the message is shown to a person, and an
    // internal status vocabulary is not something to leak into a UI string.
    return run('suspended').then((r) => {
      expect(r.body.error.message).not.toMatch(/suspended/i);
    });
  });
});

describe('fails closed', () => {
  test('an unknown status is denied, not allowed', async () => {
    // A value nobody anticipated must not become a way to work.
    const r = await run('some_new_state');
    expect(r.passed).toBe(false);
    expect(r.body.error.code).toBe('PROVIDER_NOT_APPROVED');
  });

  test('a missing row is denied', async () => {
    expect((await run(null)).passed).toBe(false);
  });

  test('a database error is denied, not waved through', async () => {
    // The alternative is that one transient outage grants operational access to
    // every suspended account at once.
    const r = await run(undefined);
    expect(r.passed).toBe(false);
    expect(r.code).toBe(403);
    expect(r.body.error.retryable).toBe(true);
  });

  test('no authenticated user is 401, not 403', async () => {
    const r = await run('active', null);
    expect(r.passed).toBe(false);
    expect(r.code).toBe(401);
  });
});

describe('scope', () => {
  test('the status is read for the TOKEN uid, never a request field', async () => {
    await run('active');
    expect(q.mock.calls[0][1]).toEqual(['w-1']);
  });
});

/**
 * The gap that let a production outage ship.
 *
 * The `run` helper above maps a null status to `rows: []` — a MISSING ROW. So
 * every case in this file was either "no row" or "a row with a real status",
 * and the third possibility was never expressed: a row that EXISTS whose
 * account_status was never written.
 *
 * That is not a hypothetical. upsertFirebaseUser does not set the column, and
 * Firebase issues a uid per identifier — so signing in by mobile creates a new
 * row with a NULL status. Those providers got 403 on every operational route
 * from their first request, while the whole suite stayed green.
 *
 * These cases talk to the mock directly rather than through `run`, because the
 * helper cannot represent the state that broke.
 */
describe('a row whose status was never set', () => {
  const call = async (row: Record<string, unknown>) => {
    q.mockReset();
    q.mockResolvedValue({ rows: [row] });
    const req: any = { user: { uid: 'w-1' } };
    let code = 0;
    const body: any = {};
    const res: any = {
      status: (c: number) => { code = c; return res; },
      json: (b: any) => { Object.assign(body, b); return res; },
    };
    let passed = false;
    await requireActiveProvider(req, res, () => { passed = true; });
    return { passed, code, body };
  };

  test.each([
    ['NULL', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['whitespace', '   '],
  ])('%s is a legacy account and PASSES', async (_label, value) => {
    // Absence is not denial. Nothing was ever written here, and this account
    // worked before the middleware existed.
    expect((await call({ account_status: value })).passed).toBe(true);
  });

  test('an UNRECOGNISED status still fails closed', async () => {
    // The distinction that makes the above safe: a value somebody wrote
    // deliberately and this code does not understand must still deny, or the
    // fix would have turned a lockout into a hole.
    const r = await call({ account_status: 'frozen_pending_review' });
    expect(r.passed).toBe(false);
    expect(r.code).toBe(403);
  });

  test('suspension is unaffected by the NULL allowance', async () => {
    const r = await call({ account_status: 'suspended' });
    expect(r.passed).toBe(false);
    expect(r.body.error.code).toBe('PROVIDER_SUSPENDED');
  });
});
