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
