/**
 * One-time codes: purpose scoping, single-use consumption, and the degradation
 * path when the schema is not there.
 *
 * The degradation path gets as much attention as the happy one, because an
 * unexercised fallback is a fallback that does not work — and this one runs
 * only when a DDL statement fails, which is precisely the condition nobody
 * reproduces by accident.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' } }));

const query = jest.fn();
jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: (...args: unknown[]) => query(...args) },
  pool: { connect: jest.fn() },
}));

import bcrypt from 'bcryptjs';
import * as otp from '../src/services/otpService';

/** Answers statements by matching their SQL, recording everything issued. */
let issued: Array<{ sql: string; params: unknown[] }>;

const respond = (rules: Array<[RegExp, unknown[]]>, opts: { ddlFails?: boolean } = {}) => {
  query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    issued.push({ sql, params });
    if (/ALTER TABLE|CREATE INDEX/i.test(sql)) {
      if (opts.ddlFails) throw new Error('permission denied for table email_otps');
      return { rows: [], rowCount: 0 };
    }
    for (const [re, rows] of rules) if (re.test(sql)) return { rows, rowCount: rows.length };
    return { rows: [], rowCount: 0 };
  });
};

beforeEach(() => {
  issued = [];
  query.mockReset();
  otp.__resetOtpEnsure();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

const sqlFor = (re: RegExp) => issued.filter((i) => re.test(i.sql));

describe('purpose is written and read', () => {
  it('issues a code carrying its purpose', async () => {
    respond([]);
    const result = await otp.issueEmailOtp('Person@Example.com', 'REGISTRATION_VERIFICATION');

    expect(result.code).toMatch(/^\d{6}$/);
    const insert = sqlFor(/INSERT INTO/)[0];
    expect(insert.sql).toContain('purpose');
    expect(insert.params).toContain('REGISTRATION_VERIFICATION');
    // Normalised: the address is stored lower-cased, or two spellings become
    // two independent code streams for one person.
    expect(insert.params[0]).toBe('person@example.com');
  });

  it('never stores the plaintext code', async () => {
    respond([]);
    const { code } = await otp.issueEmailOtp('a@x.co');
    const insert = sqlFor(/INSERT INTO/)[0];
    expect(insert.params).not.toContain(code);
    // What IS stored is a bcrypt hash of it.
    expect(await bcrypt.compare(code, String(insert.params[1]))).toBe(true);
  });

  it('scopes the read to the purpose', async () => {
    respond([[/SELECT \* FROM/, []]]);
    await otp.findValidOtp('a@x.co', 'PASSWORD_RESET');
    const select = sqlFor(/SELECT \* FROM/)[0];
    expect(select.sql).toContain('AND purpose = $2');
    expect(select.params).toEqual(['a@x.co', 'PASSWORD_RESET']);
  });

  it('a code issued for one purpose does not satisfy another', async () => {
    // The whole point of the model, expressed as the query it produces: a
    // PASSWORD_RESET lookup never sees a REGISTRATION_VERIFICATION row.
    respond([[/SELECT \* FROM/, []]]);
    const outcome = await otp.verifyEmailOtp('a@x.co', '123456', 'PASSWORD_RESET');
    expect(outcome).toEqual({ ok: false, reason: 'OTP_INVALID' });
    expect(sqlFor(/SELECT \* FROM/)[0].params).toContain('PASSWORD_RESET');
  });
});

describe('verification outcomes', () => {
  const withStoredCode = async (code: string) => {
    const hash = await bcrypt.hash(code, 10);
    respond([
      [/SELECT \* FROM/, [{ id: 7, code_hash: hash }]],
      [/UPDATE/, [{ id: 7 }]],
    ]);
  };

  it('accepts the right code and claims it', async () => {
    await withStoredCode('123456');
    expect(await otp.verifyEmailOtp('a@x.co', '123456')).toEqual({ ok: true });
    const update = sqlFor(/UPDATE/)[0];
    // Compare-and-swap: the UPDATE re-checks `used` and `expires_at`, so two
    // concurrent verifications of one code cannot both succeed.
    expect(update.sql).toContain('used = FALSE');
    expect(update.sql).toContain('expires_at > NOW()');
  });

  it('rejects the wrong code without claiming anything', async () => {
    await withStoredCode('123456');
    expect(await otp.verifyEmailOtp('a@x.co', '999999')).toEqual({ ok: false, reason: 'OTP_INVALID' });
    expect(sqlFor(/UPDATE/)).toHaveLength(0);
  });

  it('reports OTP_INVALID — not "no such account" — when no code exists at all', async () => {
    respond([[/SELECT \* FROM/, []], [/SELECT 1 FROM/, []]]);
    expect(await otp.verifyEmailOtp('nobody@x.co', '123456')).toEqual({ ok: false, reason: 'OTP_INVALID' });
  });

  it('reports OTP_EXPIRED only when a real code for this address and purpose timed out', async () => {
    respond([[/SELECT \* FROM/, []], [/SELECT 1 FROM/, [{ '?column?': 1 }]]]);
    expect(await otp.verifyEmailOtp('a@x.co', '123456')).toEqual({ ok: false, reason: 'OTP_EXPIRED' });
  });

  it('rejects a code of the wrong shape before touching the database', async () => {
    respond([]);
    expect(await otp.verifyEmailOtp('a@x.co', '12345')).toEqual({ ok: false, reason: 'OTP_INVALID' });
    expect(await otp.verifyEmailOtp('a@x.co', 'abcdef')).toEqual({ ok: false, reason: 'OTP_INVALID' });
    expect(sqlFor(/SELECT/)).toHaveLength(0);
  });

  it('a code claimed by somebody else first does not verify twice', async () => {
    const hash = await bcrypt.hash('123456', 10);
    respond([
      [/SELECT \* FROM/, [{ id: 7, code_hash: hash }]],
      [/UPDATE/, []], // the compare-and-swap matched no row — another request won
    ]);
    expect(await otp.verifyEmailOtp('a@x.co', '123456')).toEqual({ ok: false, reason: 'OTP_INVALID' });
  });
});

describe('the ensure is memoised', () => {
  it('runs the DDL once, not on every code', async () => {
    respond([]);
    await otp.issueEmailOtp('a@x.co');
    await otp.issueEmailOtp('b@x.co');
    await otp.findValidOtp('a@x.co');
    expect(sqlFor(/ALTER TABLE/)).toHaveLength(1);
  });
});

describe('degradation when the column cannot be created', () => {
  it('reports the column as absent rather than throwing', async () => {
    respond([], { ddlFails: true });
    expect(await otp.ensureOtpPurposeColumn()).toBe(false);
  });

  it('says so loudly, naming the migration to run', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    respond([], { ddlFails: true });
    await otp.ensureOtpPurposeColumn();
    const logged = spy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('026-otp-purpose.sql');
    expect(logged).toContain('UNSCOPED');
  });

  it('registration verification KEEPS WORKING — unscoped, which is identical today', async () => {
    // This is the property the fallback exists for. A schema nicety must not be
    // able to take out sign-up.
    const hash = await bcrypt.hash('123456', 10);
    respond([[/SELECT \* FROM/, [{ id: 7, code_hash: hash }]], [/UPDATE/, [{ id: 7 }]]], { ddlFails: true });

    await otp.issueEmailOtp('a@x.co');
    expect(sqlFor(/INSERT INTO/)[0].sql).not.toContain('purpose');

    expect(await otp.verifyEmailOtp('a@x.co', '123456')).toEqual({ ok: true });
    expect(sqlFor(/SELECT \* FROM/)[0].sql).not.toContain('purpose');
  });

  it('REFUSES to issue a second purpose, which is what makes the fallback self-limiting', async () => {
    // Without the column, a PASSWORD_RESET code would be stored
    // indistinguishable from a registration code — the exact ambiguity this
    // module exists to prevent, reached by another route. Refusing keeps the
    // degraded mode equivalent to today rather than worse than it.
    respond([], { ddlFails: true });
    await expect(otp.issueEmailOtp('a@x.co', 'PASSWORD_RESET')).rejects.toThrow(/could not be told apart/);
    expect(sqlFor(/INSERT INTO/)).toHaveLength(0);
  });
});
