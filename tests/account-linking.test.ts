/**
 * Merging grants full access to an account holding someone's earnings.
 *
 * These tests exist for the REFUSALS. A merge that works is easy to notice; a
 * merge that fires when it should not is how one provider signs into another's
 * account, and nothing about that is visible until the money is wrong.
 */

const deleteUser = jest.fn();
const updateUser = jest.fn();
const createCustomToken = jest.fn().mockResolvedValue('CUSTOM');

jest.mock('../src/middleware/firebaseApp', () => ({ getFirebaseAdmin: () => ({}) }));
jest.mock('firebase-admin/auth', () => ({
  getAuth: () => ({ deleteUser, updateUser, createCustomToken }),
}));
jest.mock('../src/db/dbQuery', () => ({ __esModule: true, default: { query: jest.fn() } }));
jest.mock('../src/config', () => ({ db: { schema: 'servana' } }));

import dbQuery from '../src/db/dbQuery';
import { mergePhoneIntoExistingAccount } from '../src/services/accountLinking';

const q = dbQuery.query as jest.Mock;

const PHONE = '+639171234901';
const base = {
  incomingUid: 'new-uid',
  signInProvider: 'phone',
  phoneNumber: PHONE,
  canonicalUid: 'old-uid',
};

/** ownRows = what the incoming uid owns; claimants = who claims the number. */
const setup = (ownRows: any[], claimants: any[]) => {
  deleteUser.mockReset().mockResolvedValue(undefined);
  updateUser.mockReset().mockResolvedValue(undefined);
  q.mockReset();
  let i = 0;
  q.mockImplementation(() => Promise.resolve({ rows: [ownRows, claimants, []][i++] ?? [] }));
};

const OK = [{ uid: 'old-uid', is_archived: false }];

describe('it refuses unless the number was proven by THIS sign-in', () => {
  test.each([['password'], ['google.com'], ['facebook.com'], [undefined]])(
    'sign_in_provider=%s does not merge',
    async (provider) => {
      setup([], OK);
      const r = await mergePhoneIntoExistingAccount({ ...base, signInProvider: provider as any });
      expect(r.merged).toBe(false);
      // An email sign-in that merely mentions a phone number proves nothing
      // about who is holding that phone.
      expect(deleteUser).not.toHaveBeenCalled();
    }
  );
});

describe('it refuses when the number is not a real PH mobile', () => {
  test.each([['notaphone'], ['+12025550123'], [null], ['09171234']])('%s does not merge', async (p) => {
    setup([], OK);
    const r = await mergePhoneIntoExistingAccount({ ...base, phoneNumber: p as any });
    expect(r.merged).toBe(false);
    expect(deleteUser).not.toHaveBeenCalled();
  });
});

describe('it refuses when merging would destroy or misplace data', () => {
  test('the incoming uid already owns a row', async () => {
    setup([{ x: 1 }], OK);
    const r = await mergePhoneIntoExistingAccount(base);
    expect(r).toMatchObject({ merged: false });
    // Moving an account that has its own history is a data migration, not
    // something a login endpoint decides.
    expect(deleteUser).not.toHaveBeenCalled();
  });

  test('two accounts claim the number — ambiguous ownership is not resolved by guessing', async () => {
    setup([], [{ uid: 'a', is_archived: false }, { uid: 'b', is_archived: false }]);
    const r = await mergePhoneIntoExistingAccount(base);
    expect(r).toMatchObject({ merged: false });
    expect(deleteUser).not.toHaveBeenCalled();
  });

  test('nobody claims the number', async () => {
    setup([], []);
    expect((await mergePhoneIntoExistingAccount(base)).merged).toBe(false);
    expect(deleteUser).not.toHaveBeenCalled();
  });

  test('the claimant is not the account we resolved', async () => {
    setup([], [{ uid: 'somebody-else', is_archived: false }]);
    expect((await mergePhoneIntoExistingAccount(base)).merged).toBe(false);
    expect(deleteUser).not.toHaveBeenCalled();
  });

  test('the surviving account is archived', async () => {
    setup([], [{ uid: 'old-uid', is_archived: true }]);
    expect((await mergePhoneIntoExistingAccount(base)).merged).toBe(false);
    expect(deleteUser).not.toHaveBeenCalled();
  });

  test('incoming and canonical are the same account', async () => {
    setup([], OK);
    const r = await mergePhoneIntoExistingAccount({ ...base, canonicalUid: 'new-uid' });
    expect(r.merged).toBe(false);
    expect(deleteUser).not.toHaveBeenCalled();
  });
});

describe('when every condition holds', () => {
  test('the orphan is deleted BEFORE the number is attached', async () => {
    setup([], OK);
    const order: string[] = [];
    deleteUser.mockImplementation(async () => { order.push('delete'); });
    updateUser.mockImplementation(async () => { order.push('attach'); });

    const r = await mergePhoneIntoExistingAccount(base);

    expect(r).toEqual({ merged: true, canonicalUid: 'old-uid', customToken: 'CUSTOM' });
    // Firebase refuses to attach a number another user still holds, so the
    // reverse order cannot even be attempted.
    expect(order).toEqual(['delete', 'attach']);
    expect(deleteUser).toHaveBeenCalledWith('new-uid');
    expect(updateUser).toHaveBeenCalledWith('old-uid', { phoneNumber: PHONE });
  });

  test('a custom token is issued so no second OTP is needed', async () => {
    setup([], OK);
    const r = await mergePhoneIntoExistingAccount(base);
    expect(r).toMatchObject({ merged: true, customToken: 'CUSTOM' });
  });

  test('the number is normalised to E.164 before being stored', async () => {
    setup([], OK);
    await mergePhoneIntoExistingAccount({ ...base, phoneNumber: '0917 123 4901' });
    expect(updateUser).toHaveBeenCalledWith('old-uid', { phoneNumber: PHONE });
  });
});
