/**
 * One provider, one account.
 *
 * Firebase issues a uid per identifier, so signing in by mobile after
 * registering by email arrives as a different uid. upsertFirebaseUser keys on
 * uid, so the old behaviour was to create a second row and let the person land
 * in an empty portal with nothing having errored.
 */

jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn() },
}));
jest.mock('../src/config', () => ({ db: { schema: 'servana' } }));

import dbQuery from '../src/db/dbQuery';
import { findLinkCollision, AccountLinkRequiredError } from '../src/services/accountLinkGuard';

const q = dbQuery.query as jest.Mock;

/** Records the SQL/params each call received so the lookup itself can be asserted. */
const calls: Array<{ sql: string; params: any[] }> = [];
const respond = (...results: Array<any[]>) => {
  calls.length = 0;
  let i = 0;
  q.mockReset();
  q.mockImplementation((sql: string, params: any[]) => {
    calls.push({ sql, params });
    return Promise.resolve({ rows: results[i++] ?? [] });
  });
};

describe('detecting an identifier that already belongs to someone', () => {
  test('a mobile matching another account is reported', async () => {
    respond([{ uid: 'existing-1' }]);
    expect(await findLinkCollision('new-uid', null, '+639171234901')).toEqual({
      existingUid: 'existing-1',
      via: 'mobile',
    });
  });

  test('an email matching another account is reported', async () => {
    // Only ONE query runs here: with no phone number the mobile lookup is
    // skipped entirely, so the email lookup is the first call.
    respond([{ uid: 'existing-2' }]);
    expect(await findLinkCollision('new-uid', 'Juan@Gmail.com', null)).toEqual({
      existingUid: 'existing-2',
      via: 'email',
    });
  });

  test('no match is not a collision', async () => {
    respond([], []);
    expect(await findLinkCollision('new-uid', 'nobody@example.com', '+639171234901')).toBeNull();
  });
});

describe('the lookup itself', () => {
  test('excludes the caller so a returning user never collides with themselves', async () => {
    respond([]);
    await findLinkCollision('me', null, '+639171234901');
    expect(calls[0].sql).toMatch(/uid\s*<>\s*\$1/);
    expect(calls[0].params[0]).toBe('me');
  });

  test('falls back to the RAW column, so it works before the backfill', async () => {
    // Without this the guard is inert on exactly the legacy accounts that can
    // hit this today: their phone_normalized is still NULL.
    respond([]);
    await findLinkCollision('new-uid', null, '09171234901');
    expect(calls[0].sql).toMatch(/phone_normalized IS NULL/);
    expect(calls[0].sql).toMatch(/regexp_replace/);
    expect(calls[0].params).toContain('9171234901'); // last 10, strict PH mobile
  });

  test('email comparison is case-insensitive on both sides', async () => {
    respond([]);
    await findLinkCollision('new-uid', '  JUAN@Gmail.COM ', null);
    expect(calls[0].params[1]).toBe('juan@gmail.com');
    expect(calls[0].sql).toMatch(/lower\(btrim\(email\)\)/);
  });

  test('an unparseable mobile is not looked up at all', async () => {
    // A number nobody can receive an SMS at must never become a lookup key —
    // a loose match here hands someone another provider's account.
    respond([], []);
    await findLinkCollision('new-uid', null, 'notaphone');
    expect(calls.every((c) => !/phone_normalized/.test(c.sql))).toBe(true);
  });

  test('a non-PH-mobile shape is rejected rather than loosely matched', async () => {
    respond([], []);
    await findLinkCollision('new-uid', null, '+12025550123');
    expect(calls.every((c) => !/phone_normalized/.test(c.sql))).toBe(true);
  });
});

describe('the error it raises', () => {
  test('carries a stable code and says which identifier to use instead', async () => {
    const e = new AccountLinkRequiredError('mobile');
    expect(e.code).toBe('ACCOUNT_LINK_REQUIRED');
    // "Authentication failed" makes someone retry the same way forever.
    expect(e.message).toMatch(/email/i);
    expect(new AccountLinkRequiredError('email').message).toMatch(/mobile/i);
  });
});
