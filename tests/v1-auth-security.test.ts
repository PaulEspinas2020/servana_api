/**
 * Auth security properties, driven over a real socket.
 *
 * Four things are checked here that a unit test on a service cannot see:
 *
 *   1. Enumeration — an unknown address and a real one produce identical
 *      responses, including status, body and shape.
 *   2. Secrets — no password, code, token or oobCode reaches a response body,
 *      a telemetry snapshot or a log line.
 *   3. Identity — every authenticated answer comes from the TOKEN, never from
 *      an id in the body, so one caller cannot act as another.
 *   4. Brute force — the per-account limiter fires, and it keys on the account
 *      rather than the address.
 */

import http from 'http';
import express from 'express';
import { AddressInfo } from 'net';

jest.mock('../src/config', () => ({ db: { schema: 'servana' }, tempId: undefined }));
jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
  pool: { connect: jest.fn() },
}));
jest.mock('../src/db/mongodbQuery', () => ({ __esModule: true, default: {} }));
jest.mock('../src/middleware/firebaseApp', () => ({ firebaseAdmin: {}, __esModule: true }));
jest.mock('firebase-admin/auth', () => ({ getAuth: () => ({}) }));

/** The token is the ONLY source of identity. It never reads the body. */
jest.mock('../src/middleware/verifyAuth', () => ({
  __esModule: true,
  default: (req: any, res: any, next: any) => {
    const header = String(req.headers.authorization ?? '');
    if (!header.startsWith('Bearer ')) {
      return res.status(401).json({ status: 'failed', code: 'UNAUTHENTICATED' });
    }
    req.user = { uid: header.slice('Bearer '.length) };
    next();
  },
}));
jest.mock('../src/middleware/requireProviderRole', () => ({
  __esModule: true,
  default: (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../src/middleware/verifyRoles', () => ({
  __esModule: true,
  default: () => (_req: any, _res: any, next: any) => next(),
}));

const KNOWN_EMAIL = 'real-customer@servana.com.ph';
const SECRET_PASSWORD = 'Sup3rSecret-Password!';
const SECRET_CODE = '424242';
const SECRET_OOB = 'oob-code-abcdef123456';
const SECRET_REFRESH = 'refresh-token-zzzz9999';

const forgotPassword = jest.fn();
const resendEmailOtp = jest.fn();

jest.mock('../src/services/auth.service', () => ({
  loggedInUser: jest.fn(async (email: string, password: string) => {
    if (email !== KNOWN_EMAIL || password !== SECRET_PASSWORD) {
      throw Object.assign(new Error('Invalid email or password.'), { statusCode: 401 });
    }
    return { token: 'tok', refreshToken: 'ref', uid: 'uid-real', email, role: 3, isEmailVerified: true };
  }),
  registerUser: jest.fn().mockResolvedValue({ dbRegister: { uid: 'u' }, verificationType: 'otp' }),
  forgotPassword: (...a: unknown[]) => forgotPassword(...a),
  resetPassword: jest.fn(async ({ oobCode }: any) => {
    if (oobCode !== 'valid-oob') {
      throw new Error(`Firebase rejected ${oobCode}`);
    }
    return { message: 'ok' };
  }),
  resendEmailOtp: (...a: unknown[]) => resendEmailOtp(...a),
  getAndSendEmailVerificationLink: jest.fn().mockResolvedValue({ message: 'sent' }),
  updateFcmToken: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/services/firebaseFunctions.service', () => ({
  firebaseAuthLogin: jest.fn().mockResolvedValue({ data: { uid: 'u', role: 2 } }),
  firebaseProviderRegister: jest.fn().mockResolvedValue({ data: { uid: 'u', role: 2 } }),
  getFirebaseUserByEmail: jest.fn().mockResolvedValue({ uid: 'uid-real' }),
  getFirebaseUserByUid: jest.fn(async (uid: string) => ({
    uid,
    phoneNumber: '+639171234567',
    providerData: [{ providerId: 'phone' }],
  })),
  verifyIdTokenStrict: jest.fn(async () => ({ uid: 'proof-uid', firebase: { sign_in_provider: 'phone' } })),
  updateFirebaseEmailVerified: jest.fn().mockResolvedValue(undefined),
  revokeTokenInFirebase: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/services/tokenRefreshService', () => {
  class TokenRefreshError extends Error {
    constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); }
  }
  return {
    TokenRefreshError,
    // Deliberately embeds the token in the error text — this backend really can
    // produce such an error, and the handler must not pass it through.
    refreshIdToken: jest.fn(async (token: string) => {
      throw new Error(`upstream rejected token ${token}`);
    }),
  };
});

const recordProvenIdentifiers = jest.fn().mockResolvedValue(true);
jest.mock('../src/services/identityVerificationSync', () => ({
  provenFrom: () => ({ emailVerified: false, mobileVerified: true }),
  recordProvenIdentifiers: (...a: unknown[]) => recordProvenIdentifiers(...a),
}));
jest.mock('../src/services/accountLinkGuard', () => ({
  findLinkCollision: jest.fn().mockResolvedValue(null),
}));
jest.mock('../src/services/identifierResolver', () => ({
  resolveIdentifier: jest.fn().mockResolvedValue({ type: 'mobile', normalized: null, account: null }),
}));
jest.mock('../src/services/otpService', () => ({
  DEFAULT_PURPOSE: 'REGISTRATION_VERIFICATION',
  verifyEmailOtp: jest.fn(async (_e: string, code: string) =>
    code === '111111' ? { ok: true } : { ok: false, reason: 'OTP_INVALID' },
  ),
}));
jest.mock('../src/services/providerOnboardingService', () => ({
  upsertSourceAttribution: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/constants/platformContinueUrls', () => ({
  continueUrlFor: () => undefined,
  assertContinueUrlsAreUsable: () => {},
}));
jest.mock('../src/services/notification.service', () => ({
  clearFcmToken: jest.fn().mockResolvedValue(undefined),
  getNotificationPrefs: jest.fn().mockResolvedValue({}),
  saveNotificationPrefs: jest.fn().mockResolvedValue({}),
  listCustomerNotifications: jest.fn().mockResolvedValue([]),
  countCustomerUnreadNotifications: jest.fn().mockResolvedValue(0),
  isSafeNotificationKey: () => true,
  markCustomerNotificationReadByKey: jest.fn().mockResolvedValue({ found: true, allowed: true }),
  markAllCustomerNotificationsRead: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/services/identityService', () => ({
  getIdentity: jest.fn(async (uid: string) => ({ uid, id: uid, email: `${uid}@x.co`, role: 3 })),
}));
jest.mock('../src/services/catalogPublicService', () => ({
  getPublicCatalogSummary: jest.fn().mockResolvedValue({ lastUpdatedAt: null }),
  getPublicCatalog: jest.fn().mockResolvedValue([]),
  listPublicServices: jest.fn().mockResolvedValue([]),
  getServiceDetail: jest.fn().mockResolvedValue({}),
}));
jest.mock('../src/services/bookingService', () => ({
  getBookingsByUserId: jest.fn().mockResolvedValue([]),
  getBookingById: jest.fn().mockResolvedValue({ id: 1 }),
  getCustomerBookingTimeline: jest.fn().mockResolvedValue([]),
  formatBooking: (b: any) => b,
  formatBookings: (b: any[]) => b,
}));
jest.mock('../src/services/bookingAccessService', () => ({
  BookingAccessError: class extends Error {},
  assertBookingAccess: jest.fn().mockResolvedValue('customer'),
}));
jest.mock('../src/services/technicianService', () => ({
  getJobCardsByWorker: jest.fn().mockResolvedValue([]),
  getJobCardByWorker: jest.fn().mockResolvedValue(null),
}));
jest.mock('../src/controllers/jobCardView', () => ({ formatJobCard: (j: any) => j }));
jest.mock('../src/services/customerReviewService', () => ({
  listProviderReviews: jest.fn().mockResolvedValue({ reviews: [], total: 0 }),
  getProviderAggregate: jest.fn().mockResolvedValue({}),
}));

import v1Router from '../src/api/v1/register';
import { snapshot as authSnapshot, __resetAuthTelemetry } from '../src/api/v1/authTelemetry';
import { identifierBucket } from '../src/middleware/credentialLimiter';

let server: http.Server;
let base: string;
const consoleLines: string[] = [];

beforeAll(async () => {
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    jest.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      consoleLines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
  }
  const app = express();
  app.use(express.json());
  app.set('trust proxy', true);
  app.use('/api/v1', v1Router);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  jest.restoreAllMocks();
});

beforeEach(() => {
  __resetAuthTelemetry();
  forgotPassword.mockReset().mockResolvedValue({ message: 'sent' });
  resendEmailOtp.mockReset().mockResolvedValue({ message: 'neutral' });
});

const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, raw: text, body: text ? JSON.parse(text) : null };
};

// ─── 1. Enumeration ───────────────────────────────────────────────────────────

describe('an unknown account is indistinguishable from a known one', () => {
  it('forgot-password answers identically for a real address, an unknown one and a mobile', async () => {
    const real = await post('/api/v1/auth/forgot-password', { identifier: KNOWN_EMAIL });
    const unknown = await post('/api/v1/auth/forgot-password', { identifier: 'nobody-here@x.co' });
    const mobile = await post('/api/v1/auth/forgot-password', { identifier: '09171234567' });

    expect(real.status).toBe(200);
    expect(unknown.status).toBe(real.status);
    expect(mobile.status).toBe(real.status);
    expect(unknown.raw).toBe(real.raw.replace(/"requestId":"[^"]*"/, unknown.raw.match(/"requestId":"[^"]*"/)?.[0] ?? ''));
    expect(unknown.body).toEqual(real.body);
    expect(mobile.body).toEqual(real.body);
  });

  it('forgot-password answers the same way even when delivery THROWS', async () => {
    // A 500 on one address and a 200 on another is an enumeration oracle that
    // does not need to read English.
    forgotPassword.mockRejectedValue(new Error('SMTP is down'));
    const failed = await post('/api/v1/auth/forgot-password', { identifier: KNOWN_EMAIL });
    forgotPassword.mockResolvedValue({ message: 'sent' });
    const worked = await post('/api/v1/auth/forgot-password', { identifier: KNOWN_EMAIL });

    expect(failed.status).toBe(200);
    expect(failed.body).toEqual(worked.body);
  });

  it('resend-verification is neutral for an unknown address and for a throw', async () => {
    const known = await post('/api/v1/auth/resend-verification', { identifier: KNOWN_EMAIL });
    resendEmailOtp.mockRejectedValue(new Error('mailer exploded'));
    const broken = await post('/api/v1/auth/resend-verification', { identifier: 'nobody@x.co' });

    expect(known.status).toBe(200);
    expect(broken.status).toBe(200);
    expect(broken.body).toEqual(known.body);
  });

  it('login gives one code whether the account is unknown or the password is wrong', async () => {
    const unknown = await post('/api/v1/auth/login', { identifier: 'nobody@x.co', password: SECRET_PASSWORD });
    const wrongPw = await post('/api/v1/auth/login', { identifier: KNOWN_EMAIL, password: 'wrong-password' });

    expect(unknown.status).toBe(401);
    expect(wrongPw.status).toBe(401);
    expect(unknown.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(wrongPw.body.error.code).toBe(unknown.body.error.code);
    expect(wrongPw.body.error.message).toBe(unknown.body.error.message);
  });
});

// ─── 2. Secrets ───────────────────────────────────────────────────────────────

describe('no secret value reaches a response, a log, or telemetry', () => {
  const SECRETS = [SECRET_PASSWORD, SECRET_CODE, SECRET_OOB, SECRET_REFRESH];

  it('a failed login does not echo the password anywhere', async () => {
    const res = await post('/api/v1/auth/login', { identifier: KNOWN_EMAIL, password: SECRET_PASSWORD + 'x' });
    expect(res.raw).not.toContain(SECRET_PASSWORD);
    expect(JSON.stringify(authSnapshot())).not.toContain(SECRET_PASSWORD);
  });

  it('a rejected OTP does not echo the code', async () => {
    const res = await post('/api/v1/auth/verify-email', { identifier: KNOWN_EMAIL, code: SECRET_CODE });
    expect(res.body.error.code).toBe('OTP_INVALID');
    expect(res.raw).not.toContain(SECRET_CODE);
  });

  it('a rejected reset does not echo the oobCode — even though the service embeds it in the throw', async () => {
    // The mocked service throws `Firebase rejected <oobCode>`, which is the
    // shape a real driver error takes. The handler must map it to a code and
    // discard the text.
    const res = await post('/api/v1/auth/reset-password', { oobCode: SECRET_OOB, newPassword: SECRET_PASSWORD });
    expect(res.body.error.code).toBe('RESET_TOKEN_INVALID');
    expect(res.raw).not.toContain(SECRET_OOB);
  });

  it('a failed refresh does not echo the refresh token — the error text contains it', async () => {
    const res = await post('/api/v1/auth/refresh', { refreshToken: SECRET_REFRESH });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('REFRESH_UNAVAILABLE');
    expect(res.raw).not.toContain(SECRET_REFRESH);
  });

  it('nothing this suite sent appears in any console line', () => {
    const logged = consoleLines.join('\n');
    for (const secret of SECRETS) expect(logged).not.toContain(secret);
  });

  it('telemetry holds outcome codes and client labels, never an identifier', async () => {
    await post('/api/v1/auth/login', { identifier: KNOWN_EMAIL, password: 'nope' }, { 'x-servana-client': 'customer-web' });
    const serialised = JSON.stringify(authSnapshot());
    expect(serialised).toContain('INVALID_CREDENTIALS');
    expect(serialised).toContain('customer-web');
    expect(serialised).not.toContain(KNOWN_EMAIL);
    expect(serialised).not.toContain('servana.com.ph');
  });

  it('counts successes and failures separately, so a failure RATE is computable', async () => {
    await post('/api/v1/auth/login', { identifier: KNOWN_EMAIL, password: SECRET_PASSWORD });
    await post('/api/v1/auth/login', { identifier: KNOWN_EMAIL, password: 'nope' });
    const login = authSnapshot().operations.find((o) => o.operation === 'login');
    expect(login).toBeDefined();
    expect(login!.total).toBe(2);
    expect(login!.failed).toBe(1);
    expect(login!.failureRatePct).toBe(50);
  });
});

// ─── 3. Identity comes from the token ─────────────────────────────────────────

describe('identity is derived from the credential, never from the body', () => {
  it('logout ends the caller\'s OWN sessions, ignoring a uid in the body', async () => {
    const { revokeTokenInFirebase } = require('../src/services/firebaseFunctions.service');
    revokeTokenInFirebase.mockClear();

    await post('/api/v1/auth/logout', { uid: 'victim-uid', userId: 'victim-uid' }, { authorization: 'Bearer attacker-uid' });

    expect(revokeTokenInFirebase).toHaveBeenCalledTimes(1);
    expect(revokeTokenInFirebase).toHaveBeenCalledWith('attacker-uid');
  });

  it('verify-mobile records against the TOKEN uid, not the proof token\'s uid or a body field', async () => {
    // The Firebase proof decodes to `proof-uid`. The number belongs to whoever
    // is SIGNED IN, which is the bearer — otherwise presenting somebody else's
    // phone credential would verify a number onto their account.
    recordProvenIdentifiers.mockClear();
    const res = await post(
      '/api/v1/auth/verify-mobile',
      { idToken: 'phone-proof', uid: 'victim-uid' },
      { authorization: 'Bearer caller-uid' },
    );
    expect(res.status).toBe(200);
    expect(recordProvenIdentifiers).toHaveBeenCalledWith('caller-uid', expect.anything());
  });

  it('two different bearers get two different identities from /me', async () => {
    const a = await fetch(`${base}/api/v1/me`, { headers: { authorization: 'Bearer user-a' } });
    const b = await fetch(`${base}/api/v1/me`, { headers: { authorization: 'Bearer user-b' } });
    const bodyA = (await a.json()) as any;
    const bodyB = (await b.json()) as any;
    expect(bodyA.data.uid).toBe('user-a');
    expect(bodyB.data.uid).toBe('user-b');
  });

  it('an anonymous caller cannot reach any authenticated auth endpoint', async () => {
    for (const path of ['/api/v1/auth/logout', '/api/v1/auth/verify-mobile']) {
      const res = await post(path, { idToken: 'x' });
      expect(res.status).toBe(401);
    }
  });
});

// ─── 4. Brute force ───────────────────────────────────────────────────────────

describe('the per-account limiter keys on the account', () => {
  it('two spellings of one email share a bucket', () => {
    // Otherwise changing the case of a letter buys a fresh budget and the limit
    // protects nothing.
    expect(identifierBucket(' Paul@Example.COM ')).toBe(identifierBucket('paul@example.com'));
  });

  it('two spellings of one mobile share a bucket', () => {
    expect(identifierBucket('0917 123 4567')).toBe(identifierBucket('+639171234567'));
  });

  it('different accounts get different buckets', () => {
    expect(identifierBucket('a@x.co')).not.toBe(identifierBucket('b@x.co'));
  });

  it('the bucket name does not contain the identifier', () => {
    // Rate-limit keys sit in memory and appear in diagnostics; an email address
    // is personal data.
    const bucket = identifierBucket('paul@example.com')!;
    expect(bucket).not.toContain('paul');
    expect(bucket).not.toContain('example.com');
  });

  it('an unparseable identifier has no bucket, so the caller falls back to the IP limiter', () => {
    expect(identifierBucket('not-an-identifier')).toBeNull();
    expect(identifierBucket(undefined)).toBeNull();
  });

  it('repeated wrong passwords for one account are eventually refused with 429', async () => {
    const identifier = 'brute-target@servana.com.ph';
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) {
      const res = await post('/api/v1/auth/login', { identifier, password: `guess-${i}` });
      statuses.push(res.status);
    }
    expect(statuses.filter((s) => s === 401).length).toBeGreaterThan(0);
    expect(statuses).toContain(429);
    // And the wall arrives at the documented budget rather than at some
    // accidental number.
    expect(statuses.indexOf(429)).toBe(10);
  });
});
