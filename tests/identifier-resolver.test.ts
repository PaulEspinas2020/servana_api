/**
 * One sign-in field, either identifier (Command 5 §7, §8, §19).
 *
 * Sign-in took an `email` field and looked it up directly, so a provider who
 * registered with a mobile number had no way in.
 *
 * The enumeration tests matter as much as the resolution ones: the difference
 * between "that email is not registered" and "wrong password" is a free
 * membership check for anyone holding a list of addresses.
 */

jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn() },
}));
jest.mock('../src/config', () => ({ db: { schema: 'servana' } }));

import dbQuery from '../src/db/dbQuery';
import { resolveIdentifier, isIdentifierVerified } from '../src/services/identifierResolver';

const q = dbQuery.query as jest.Mock;

const row = (over: Record<string, unknown> = {}) => ({
  uid: 'uid-1', email: 'juan@gmail.com', email_normalized: 'juan@gmail.com',
  phone_normalized: '+639171234567', role: 2, account_status: 'active',
  is_email_verified: true, is_mobile_verified: false, ...over,
});

beforeEach(() => {
  q.mockReset();
  q.mockResolvedValue({ rows: [] });
});

describe('email', () => {
  test('resolves however it was typed', async () => {
    q.mockResolvedValue({ rows: [row()] });
    for (const input of ['juan@gmail.com', 'JUAN@GMAIL.COM', '  Juan@Gmail.com  ']) {
      const r = await resolveIdentifier(input);
      expect(r.type).toBe('email');
      expect(r.normalized).toBe('juan@gmail.com');
      expect(r.account?.uid).toBe('uid-1');
    }
  });

  test('falls back to the raw column, case-insensitively', async () => {
    // For rows written before normalization existed. Case-insensitive because
    // that IS the duplicate-account bug normalization prevents, and it must not
    // reappear in the fallback.
    q.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [row()] });
    const r = await resolveIdentifier('JUAN@gmail.com');
    expect(r.account?.uid).toBe('uid-1');
    expect(q.mock.calls[1][0]).toMatch(/LOWER\(email\)/);
  });
});

describe('mobile', () => {
  test('resolves every spelling to one account', async () => {
    q.mockResolvedValue({ rows: [row()] });
    for (const input of ['09171234567', '+639171234567', '0917 123 4567', '9171234567']) {
      const r = await resolveIdentifier(input);
      expect(r.type).toBe('mobile');
      expect(r.normalized).toBe('+639171234567');
    }
  });

  test('queries the NORMALIZED column, never the raw one', async () => {
    // phone_number holds whatever anyone ever typed, in any format. Matching
    // against it would either miss the row or match the WRONG one — and
    // matching the wrong row on a sign-in lookup is how one provider ends up
    // in another's account.
    await resolveIdentifier('09171234567');
    expect(q.mock.calls[0][0]).toMatch(/phone_normalized = \$1/);
    expect(q.mock.calls[0][0]).not.toMatch(/phone_number/);
  });

  test('has no raw-column fallback', async () => {
    q.mockResolvedValue({ rows: [] });
    await resolveIdentifier('09171234567');
    // Exactly one query. A legacy row with no normalized form cannot be used to
    // sign in until the backfill reaches it — the safe failure.
    expect(q).toHaveBeenCalledTimes(1);
  });
});

describe('enumeration resistance', () => {
  test('unknown account and malformed identifier are indistinguishable', async () => {
    q.mockResolvedValue({ rows: [] });
    const missing = await resolveIdentifier('nobody@gmail.com');
    const malformed = await resolveIdentifier('not-an-identifier');
    // Both yield no account. The caller renders one message for both.
    expect(missing.account).toBeNull();
    expect(malformed.account).toBeNull();
  });

  test('a malformed identifier does not throw', async () => {
    // Throwing would answer "your format is wrong" — confirming that the format
    // check is the only thing between the caller and an answer.
    for (const v of ['', '   ', '@@@', null, undefined, 42]) {
      await expect(resolveIdentifier(v)).resolves.toBeDefined();
    }
  });

  test('an unknown identifier type costs no query at all', async () => {
    await resolveIdentifier('nonsense');
    expect(q).not.toHaveBeenCalled();
  });
});

describe('verification', () => {
  test('checks the identifier that was actually used', async () => {
    q.mockResolvedValue({ rows: [row({ is_email_verified: true, is_mobile_verified: false })] });
    expect(isIdentifierVerified(await resolveIdentifier('juan@gmail.com'))).toBe(true);
    expect(isIdentifierVerified(await resolveIdentifier('09171234567'))).toBe(false);
  });

  test('an unresolved identifier is never verified', async () => {
    q.mockResolvedValue({ rows: [] });
    expect(isIdentifierVerified(await resolveIdentifier('nobody@gmail.com'))).toBe(false);
  });
});
