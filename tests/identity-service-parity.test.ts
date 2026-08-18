/**
 * `/api/auth/me` must not have moved.
 *
 * This command extracted the identity projection out of `providerController.getMe`
 * into `services/identityService.getIdentity`, so that `/api/v1/me` and the
 * legacy route answer from one query rather than two copies of the same one
 * (§10). De-duplication is the only intended effect — Provider Web reads
 * `data.role` on every session bootstrap and a shape change there logs every
 * provider out.
 *
 * There was no test on this endpoint before, so "the shape is unchanged" was a
 * claim rather than evidence. This is the evidence.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' }, tempId: undefined }));

const query = jest.fn();
jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: (...args: unknown[]) => query(...args) },
  pool: { connect: jest.fn() },
}));

import { getIdentity } from '../src/services/identityService';

/** The row shape `user_credentials` actually returns — snake_case, from pg. */
const ROW = {
  uid: 'firebase-uid-1',
  email: 'provider@servana.com.ph',
  first_name: 'Juan',
  last_name: 'Dela Cruz',
  role: 2,
  is_email_verified: true,
  phone_number: '+639171234567',
};

beforeEach(() => query.mockReset());

describe('identityService.getIdentity', () => {
  it('returns exactly the keys the legacy /api/auth/me projection returned', async () => {
    query.mockResolvedValue({ rows: [ROW], rowCount: 1 });

    const identity = await getIdentity('firebase-uid-1');

    // Key SET, not just key presence: an extra field on this endpoint is a
    // §58 question, and a missing one logs a provider out.
    expect(Object.keys(identity!).sort()).toEqual(
      ['email', 'firstName', 'id', 'isEmailVerified', 'lastName', 'phoneNumber', 'role', 'uid'].sort(),
    );
    expect(identity).toEqual({
      id: 'firebase-uid-1',
      uid: 'firebase-uid-1',
      email: 'provider@servana.com.ph',
      firstName: 'Juan',
      lastName: 'Dela Cruz',
      role: 2,
      isEmailVerified: true,
      phoneNumber: '+639171234567',
    });
  });

  it('carries `id` as well as `uid` — Provider Web keys on one and the apps on the other', async () => {
    query.mockResolvedValue({ rows: [ROW], rowCount: 1 });
    const identity = await getIdentity('firebase-uid-1');
    expect(identity!.id).toBe(identity!.uid);
  });

  it('returns null rather than throwing when no credential row exists', async () => {
    // Real, and not a 500: a Firebase user can exist before upsertFirebaseUser
    // has run, which is the window a fresh phone sign-in passes through.
    query.mockResolvedValue({ rows: [], rowCount: 0 });
    expect(await getIdentity('brand-new-uid')).toBeNull();
  });

  it('scopes the read to the uid it was given, as a bound parameter', async () => {
    query.mockResolvedValue({ rows: [ROW], rowCount: 1 });
    await getIdentity('firebase-uid-1');

    const [sql, params] = query.mock.calls[0];
    expect(params).toEqual(['firebase-uid-1']);
    expect(sql).toMatch(/WHERE uid = \$1/);
    expect(sql).toMatch(/LIMIT 1/);
  });

  it('selects no credential material — no password hash, no FCM token (§58)', async () => {
    query.mockResolvedValue({ rows: [ROW], rowCount: 1 });
    await getIdentity('firebase-uid-1');

    const [sql] = query.mock.calls[0];
    for (const forbidden of ['password', 'fcm', 'token', 'secret', 'provider_id']) {
      expect(String(sql).toLowerCase()).not.toContain(forbidden);
    }
  });
});

describe('the legacy controller delegates rather than duplicating', () => {
  it('providerController.getMe calls identityService and keeps the legacy envelope', () => {
    // Read as source: importing providerController pulls in Firebase Admin,
    // Mongo and a dozen services. What needs proving is that the inline query
    // is gone and the shared service is called — which is a property of the
    // text, and the reason the two paths cannot drift.
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const src = fs
      .readFileSync(path.resolve(__dirname, '..', 'src', 'controllers', 'providerController.ts'), 'utf8')
      .replace(/\r\n/g, '\n');

    const start = src.indexOf('export const getMe');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n};', start));

    expect(body).toContain('await getIdentity(uid)');
    // The inline projection is gone: no direct query, no snake_case mapping.
    expect(body).not.toContain('dbQuery.query');
    expect(body).not.toContain('first_name');
    // And the legacy envelope is untouched.
    expect(body).toContain('{ status: "success", data: user }');
  });
});
