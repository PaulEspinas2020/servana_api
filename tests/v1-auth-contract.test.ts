/**
 * The canonical auth surface, and the proof that it did not fork the platform.
 *
 * The risk in centralising auth is not that the new endpoint is wrong — it is
 * that it is subtly RIGHT IN A DIFFERENT WAY, so two sign-in paths diverge and
 * only one of them gets a fix. These tests assert delegation rather than
 * behaviour wherever the behaviour already exists: v1 must call the function
 * the legacy route calls, with the arguments the legacy route passes.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' }, tempId: undefined }));
jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
  pool: { connect: jest.fn() },
}));
jest.mock('../src/middleware/firebaseApp', () => ({ getFirebaseAdmin: () => ({}), __esModule: true }));
jest.mock('firebase-admin/auth', () => ({ getAuth: () => ({}) }));

const loggedInUser = jest.fn();
jest.mock('../src/services/auth.service', () => ({
  loggedInUser: (...args: unknown[]) => loggedInUser(...args),
}));

const firebaseAuthLogin = jest.fn();
jest.mock('../src/services/firebaseFunctions.service', () => ({
  firebaseAuthLogin: (...args: unknown[]) => firebaseAuthLogin(...args),
}));

const resolveIdentifier = jest.fn();
jest.mock('../src/services/identifierResolver', () => ({
  resolveIdentifier: (...args: unknown[]) => resolveIdentifier(...args),
}));

import fs from 'fs';
import path from 'path';
import {
  loginWithPassword,
  loginWithFirebaseToken,
  assertAudience,
  AuthLoginError,
} from '../src/services/authLoginService';
import { V1_CONTRACT, IMPLEMENTED } from '../src/api/v1/contract';
import { ACCOUNT_BUCKETS, BUCKETS, V1_RATE_LIMITS } from '../src/api/v1/rateLimitPolicy';
import { V1_ERROR_STATUS, isV1ErrorCode } from '../src/api/v1/errors';
import { AUTH_ERRORS } from '../src/errors/authErrors';

const SESSION = {
  token: 'tok',
  refreshToken: 'ref',
  uid: 'uid-1',
  email: 'a@x.co',
  role: 3,
  firstName: 'A',
  lastName: 'B',
  isEmailVerified: true,
};

beforeEach(() => {
  loggedInUser.mockReset().mockResolvedValue(SESSION);
  firebaseAuthLogin.mockReset().mockResolvedValue({ data: { ...SESSION, role: 2 } });
  resolveIdentifier.mockReset();
});

describe('one password state machine, reached two ways', () => {
  it('an email identifier goes straight to authService.loggedInUser — the function /api/auth/signin calls', async () => {
    await loginWithPassword({ identifier: 'a@x.co', password: 'pw' });
    expect(loggedInUser).toHaveBeenCalledTimes(1);
    expect(loggedInUser).toHaveBeenCalledWith('a@x.co', 'pw');
    // No resolution needed for an email — the legacy path did not do one either.
    expect(resolveIdentifier).not.toHaveBeenCalled();
  });

  it('a mobile identifier resolves to the account, then uses THAT account email for the same call', async () => {
    // This is the capability `identifierResolver` was written for in Command 5
    // and never wired to: its only caller until now was account deletion.
    resolveIdentifier.mockResolvedValue({
      type: 'mobile',
      normalized: '+639171234567',
      account: { uid: 'uid-1', email: 'resolved@x.co' },
    });

    const session = await loginWithPassword({ identifier: '0917 123 4567', password: 'pw' });

    expect(resolveIdentifier).toHaveBeenCalledWith('0917 123 4567');
    expect(loggedInUser).toHaveBeenCalledWith('resolved@x.co', 'pw');
    expect(session.identifierType).toBe('mobile');
  });

  it('a mobile number nobody holds is INVALID_CREDENTIALS, not "no such account"', async () => {
    resolveIdentifier.mockResolvedValue({ type: 'mobile', normalized: '+639170000000', account: null });
    await expect(loginWithPassword({ identifier: '09170000000', password: 'pw' })).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    expect(loggedInUser).not.toHaveBeenCalled();
  });

  it('an account with a mobile and no email says so, instead of failing as bad credentials forever', async () => {
    // Firebase is the password authority and its password grant is keyed on
    // email. Reporting INVALID_CREDENTIALS here would send somebody to retype a
    // password that cannot ever be checked.
    resolveIdentifier.mockResolvedValue({
      type: 'mobile',
      normalized: '+639179999999',
      account: { uid: 'u2', email: null },
    });
    await expect(loginWithPassword({ identifier: '09179999999', password: 'pw' })).rejects.toMatchObject({
      code: 'PASSWORD_NOT_AVAILABLE',
    });
  });

  it('an identifier that is neither an email nor a mobile fails as bad credentials', async () => {
    // A format complaint would confirm that the format check is the only thing
    // standing between the caller and an answer. `detectIdentifierType` calls
    // anything with an "@" an email and anything matching a PH mobile a mobile;
    // everything else lands here and must be indistinguishable from a wrong
    // password.
    await expect(loginWithPassword({ identifier: 'not-an-identifier', password: 'pw' })).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    expect(loggedInUser).not.toHaveBeenCalled();
  });

  it('a malformed EMAIL is rejected by the shared service, and still surfaces as bad credentials', async () => {
    // '@@@' contains an "@" so it is routed as an email — which is correct, and
    // is why the rejection has to come from `loggedInUser`'s own validation
    // rather than from a format check here. Either way the caller cannot tell
    // it apart from a wrong password.
    loggedInUser.mockRejectedValue(new Error('Please enter a valid Email or Password'));
    await expect(loginWithPassword({ identifier: '@@@', password: 'pw' })).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
  });

  it('every credential failure produces the SAME code, whatever went wrong underneath', async () => {
    // Four different underlying causes. One outcome. Anything else is a
    // membership check for somebody holding a list of addresses.
    const causes = [
      new Error('Invalid email or password.'),
      Object.assign(new Error('Invalid email or password.'), { statusCode: 401 }),
      new Error('Please enter a valid Email or Password'),
      'a bare string throw, which this service really does',
    ];
    for (const cause of causes) {
      loggedInUser.mockReset().mockRejectedValue(cause);
      const error = await loginWithPassword({ identifier: 'a@x.co', password: 'pw' }).catch((e) => e);
      expect(error.code).toBe('INVALID_CREDENTIALS');
      expect(error.message).toBe('Invalid credentials.');
    }
  });

  it('a correct password on an unverified account is 403 ACCOUNT_UNVERIFIED, never 401', async () => {
    loggedInUser.mockRejectedValue(Object.assign(new Error('Email not verified.'), { statusCode: 403 }));
    const error = await loginWithPassword({ identifier: 'a@x.co', password: 'pw' }).catch((e) => e);
    expect(error).toBeInstanceOf(AuthLoginError);
    expect(error.code).toBe('ACCOUNT_UNVERIFIED');
    expect(V1_ERROR_STATUS.ACCOUNT_UNVERIFIED).toBe(403);
  });

  it('a disabled account is distinguished from an unverified one', async () => {
    loggedInUser.mockRejectedValue(
      Object.assign(new Error('Your account has been disabled.'), { statusCode: 403 }),
    );
    await expect(loginWithPassword({ identifier: 'a@x.co', password: 'pw' })).rejects.toMatchObject({
      code: 'ACCOUNT_DISABLED',
    });
  });

  it('the token path delegates to firebaseAuthLogin — the function /api/auth/firebase-login calls', async () => {
    await loginWithFirebaseToken({ idToken: 'tok', role: '2' });
    expect(firebaseAuthLogin).toHaveBeenCalledWith('tok', '2');
  });

  it('rejects a role value that is neither provider nor customer', async () => {
    await expect(loginWithFirebaseToken({ idToken: 'tok', role: '1' })).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    expect(firebaseAuthLogin).not.toHaveBeenCalled();
  });
});

describe('audience replaces /auth/admin-signin', () => {
  it('accepts an admin on the admin surface', () => {
    expect(() => assertAudience(1, 'admin')).not.toThrow();
  });

  it('refuses a customer on the admin surface', () => {
    expect(() => assertAudience(3, 'admin')).toThrow(AuthLoginError);
  });

  it('treats role 4 as a provider — role 2 alone is the bug servana_role_map warns about', () => {
    expect(() => assertAudience(4, 'provider')).not.toThrow();
    expect(() => assertAudience(2, 'provider')).not.toThrow();
    expect(() => assertAudience(3, 'provider')).toThrow();
  });

  it('"any" accepts every role, including an unknown one', () => {
    for (const role of [1, 2, 3, 4, 99]) expect(() => assertAudience(role, 'any')).not.toThrow();
  });

  it('a null role fails every named audience rather than defaulting open', () => {
    for (const audience of ['admin', 'provider', 'customer'] as const) {
      expect(() => assertAudience(null, audience)).toThrow();
    }
  });

  it('the assertion runs AFTER authentication, so it cannot be an existence oracle', async () => {
    // Proof by call order: a wrong-audience sign-in still consumed the
    // credential check. If the audience were asserted first, an attacker could
    // learn which addresses are admins without knowing any password.
    loggedInUser.mockResolvedValue({ ...SESSION, role: 3 });
    await expect(
      loginWithPassword({ identifier: 'a@x.co', password: 'pw', audience: 'admin' }),
    ).rejects.toMatchObject({ code: 'AUDIENCE_MISMATCH' });
    expect(loggedInUser).toHaveBeenCalledTimes(1);
  });
});

describe('the two error vocabularies mean the same things', () => {
  const SHARED = ['INVALID_CREDENTIALS', 'ACCOUNT_LINK_REQUIRED'] as const;

  it.each(SHARED)('%s exists in both catalogues with the same HTTP status', (code) => {
    expect(isV1ErrorCode(code)).toBe(true);
    expect(V1_ERROR_STATUS[code]).toBe((AUTH_ERRORS as any)[code].status);
  });

  it('every auth error code an endpoint declares is a real v1 code', () => {
    for (const entry of V1_CONTRACT.filter((e) => e.domain === 'auth')) {
      for (const code of entry.errors) expect(isV1ErrorCode(code)).toBe(true);
    }
  });

  it('ACCOUNT_UNVERIFIED is 403 and INVALID_CREDENTIALS is 401 — the distinction the legacy catalogue makes too', () => {
    // The legacy `IDENTIFIER_NOT_VERIFIED` carries the same reasoning: the
    // credential was correct, so routing this to a login screen makes people
    // retype a password that was never the problem.
    expect(V1_ERROR_STATUS.ACCOUNT_UNVERIFIED).toBe(403);
    expect(V1_ERROR_STATUS.INVALID_CREDENTIALS).toBe(401);
    expect(AUTH_ERRORS.IDENTIFIER_NOT_VERIFIED.status).toBe(403);
    expect(AUTH_ERRORS.INVALID_CREDENTIALS.status).toBe(401);
  });
});

describe('the auth contract is complete', () => {
  const AUTH_ENTRIES = V1_CONTRACT.filter((e) => e.domain === 'auth');

  it('covers every endpoint the command names as the target architecture', () => {
    const paths = AUTH_ENTRIES.map((e) => e.path).sort();
    expect(paths).toEqual(
      [
        '/auth/register',
        '/auth/login',
        '/auth/refresh',
        '/auth/logout',
        '/auth/forgot-password',
        '/auth/reset-password',
        '/auth/verify-email',
        '/auth/verify-mobile',
        '/auth/resend-verification',
      ].sort(),
    );
  });

  it('mounts all of them — none is documented-but-planned', () => {
    for (const entry of AUTH_ENTRIES) expect(entry.status).toBe('implemented');
  });

  it('every auth entry names the domain service it delegates to', () => {
    for (const entry of AUTH_ENTRIES) {
      expect(entry.domainService).toMatch(/services\//);
    }
  });

  it('the legacy auth routes are all claimed by a canonical successor', () => {
    const claimed = new Set<string>();
    for (const entry of V1_CONTRACT) {
      for (const l of entry.legacy) claimed.add(`${l.method.toUpperCase()} ${l.path}`);
    }
    // Every auth-shaped path the app mounts, from the sweep of auth.route.ts.
    for (const legacy of [
      'POST /api/auth/signup',
      'POST /api/auth/signin',
      'POST /api/auth/admin-signin',
      'POST /api/auth/refresh',
      'POST /api/auth/firebase-login',
      'POST /api/auth/customer-firebase-login',
      'POST /api/auth/provider/register',
      'POST /api/auth/forgot-password',
      'POST /api/auth/reset-password',
      'POST /api/auth/logout',
      'POST /api/auth/verify-email-otp',
      'POST /api/auth/resend-email-otp',
      'GET /api/auth/resendverification',
      'POST /api/auth/add-employees',
      'GET /api/auth/me',
    ]) {
      expect(claimed.has(legacy)).toBe(true);
    }
  });

  it('/api/auth/me was not double-claimed when the auth domain landed', () => {
    // It belongs to `identity.me`, not to an auth entry. Two canonical
    // successors for one legacy route is exactly the ambiguity the matrix exists
    // to remove.
    const owners = V1_CONTRACT.filter((e) => e.legacy.some((l) => l.path === '/api/auth/me'));
    expect(owners.map((e) => e.id)).toEqual(['identity.me']);
  });
});

describe('the composition layer enforces what the contract declares', () => {
  /**
   * These assertions used to read `register.ts` as TEXT and check a hand-listed
   * five ids. That enforced nothing about the sixth: an auth endpoint added with
   * one limiter, or none, passed in silence — which is how `refresh`,
   * `verify-mobile` and `logout` came to contradict the documented "every
   * credential endpoint carries two limiters" with the whole suite green.
   *
   * Now they read the policy the router is actually built from, and the check is
   * over every implemented auth endpoint rather than a list somebody remembered
   * to extend.
   */
  const authEndpoints = IMPLEMENTED.filter((e) => e.domain === 'auth');

  it('every implemented auth endpoint has a declared rate-limit policy', () => {
    const undeclared = authEndpoints.map((e) => e.id).filter((id) => !V1_RATE_LIMITS[id]);
    expect(undeclared).toEqual([]);
  });

  it('an endpoint with no per-account bucket states why', () => {
    // Per-account alone lets a spray across many accounts through; per-IP alone
    // locks out a carrier NAT. Where only one is present, the reason is part of
    // the declaration — so leaving the account bucket off is a decision somebody
    // wrote down, not an omission.
    for (const e of authEndpoints) {
      const policy = V1_RATE_LIMITS[e.id];
      const hasAccountBucket = policy.buckets.some((b) => ACCOUNT_BUCKETS.includes(b));
      if (!hasAccountBucket) {
        expect(policy.noAccountBucket?.trim()).toBeTruthy();
      } else {
        expect(policy.noAccountBucket).toBeUndefined();
      }
    }
  });

  it('every password or code endpoint carries both a per-account and a per-IP bucket', () => {
    // The endpoints where a secret is submitted for checking. These are the ones
    // the pair of limiters exists for, and none may drop to a single bucket.
    for (const id of [
      'auth.login',
      'auth.register',
      'auth.verifyEmail',
      'auth.forgotPassword',
      'auth.resetPassword',
      'auth.resendVerification',
    ]) {
      const policy = V1_RATE_LIMITS[id];
      expect(policy).toBeDefined();
      expect(policy.buckets.some((b) => ACCOUNT_BUCKETS.includes(b))).toBe(true);
      expect(policy.buckets).toContain('perIp');
    }
  });

  it('rate limiters are declared for endpoints that exist', () => {
    // `buildV1Router` throws on a limiter naming an unimplemented entry. A
    // limiter that is configured and not mounted is worse than none, because it
    // reads as protection.
    const implemented = new Set(IMPLEMENTED.map((e) => e.id));
    const declared = Object.keys(V1_RATE_LIMITS);
    expect(declared.length).toBeGreaterThan(5);
    for (const id of declared) expect(implemented.has(id)).toBe(true);
  });

  it('every bucket a policy names is a bucket that exists', () => {
    for (const [id, policy] of Object.entries(V1_RATE_LIMITS)) {
      for (const bucket of policy.buckets) {
        expect(Object.keys(BUCKETS)).toContain(bucket);
        expect(BUCKETS[bucket].max).toBeGreaterThan(0);
        expect(id).toBeTruthy();
      }
    }
  });
});
