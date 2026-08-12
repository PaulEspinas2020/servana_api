/**
 * Contract-wide routing coverage for /api/v1 — over a real socket.
 *
 * Until today no test in this repository resolved a URL. `src/app.ts` was only
 * ever read as TEXT, `express()` appeared zero times under `tests/`,
 * `supertest` was mentioned twice in comments and was not a dependency, and the
 * only two files that made real HTTP requests were named in `jest.config.js`
 * `testPathIgnorePatterns`. 2,993 tests passed and not one proved a path
 * reached a handler — which is exactly how `GET /api/catalog` shipped
 * unreachable with a green gate.
 *
 * `catalog-route-shadow.test.ts` landed the same day and closes that gap for
 * the catalog mount order specifically. This file closes it for the canonical
 * contract as a whole: it mounts the REAL v1 router — the one `app.ts` mounts,
 * built by the real composition layer from the real contract — and drives every
 * implemented entry, every planned entry and every declared auth mode.
 *
 * ## What is mocked, and why that is not cheating
 *
 * Auth middleware and the domain services are mocked. The subject under test is
 * routing and composition: does this path reach this handler, does the declared
 * auth mode actually gate it, does an unknown path 404 in the v1 shape. Booting
 * Firebase Admin and Postgres would test those instead, and would need
 * credentials CI does not have. The mocked auth middleware still has to be
 * WIRED for the auth assertions to pass, which is the property that matters:
 * a route documented as authenticated and mounted as public fails here.
 */

import http from 'http';
import express from 'express';
import { AddressInfo } from 'net';

// ── Mocks. Declared before the router is imported: register.ts composes at
//    import time, so anything the domain modules pull in must already be fake.
jest.mock('../src/config', () => ({ db: { schema: 'servana' }, tempId: undefined }));
jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
  pool: { connect: jest.fn() },
}));
jest.mock('../src/db/mongodbQuery', () => ({ __esModule: true, default: {} }));

/** Presence of a bearer token is the only thing the fake auth checks. */
jest.mock('../src/middleware/verifyAuth', () => ({
  __esModule: true,
  default: (req: any, res: any, next: any) => {
    if (!req.headers.authorization) {
      return res.status(401).json({ status: 'failed', code: 'UNAUTHENTICATED' });
    }
    req.user = { uid: 'uid-under-test' };
    next();
  },
}));

jest.mock('../src/middleware/requireProviderRole', () => ({
  __esModule: true,
  default: (req: any, res: any, next: any) => {
    if (req.headers['x-test-role'] !== 'provider') {
      return res.status(403).json({ status: 'failed', code: 'ROLE_NOT_PERMITTED' });
    }
    next();
  },
}));

jest.mock('../src/middleware/verifyRoles', () => ({
  __esModule: true,
  default: () => (req: any, res: any, next: any) => {
    if (req.headers['x-test-role'] !== 'admin') {
      return res.status(403).json({ status: 'failed', code: 'FORBIDDEN_ROLE' });
    }
    next();
  },
}));

// ── Domain services. Each returns a marker the assertions can recognise, so a
//    200 proves the RIGHT handler ran, not merely that something answered.
jest.mock('../src/services/catalogPublicService', () => {
  const notFound = (what: string) => {
    const e: any = new Error(`${what} not found`);
    e.statusCode = 404;
    return e;
  };
  return {
    // `makeRef`/`parseRef` are pure and are NOT mocked — the ref format is part
    // of what these tests check, so faking it would prove nothing.
    REF_TYPES: ['category', 'subcategory', 'service', 'addon'],
    makeRef: (t: string, id: number | string) => `${t}:${id}`,
    parseRef: jest.requireActual('../src/services/catalogPublicService').parseRef,
    getPublicCatalogSummary: jest.fn().mockResolvedValue({ categories: 3, subcategories: 12, services: 95, lastUpdatedAt: null }),
    getPublicCatalog: jest.fn().mockResolvedValue([{ ref: 'category:3', id: 3, name: 'Personal Care', subcategories: [] }]),
    listPublicServices: jest.fn().mockResolvedValue([{ ref: 'service:15', id: 15, name: 'Pimple Facial' }]),
    getServiceDetail: jest.fn(async (id: number) => {
      if (id === 999) throw notFound('Service');
      return { ref: `service:${id}`, id, name: 'Pimple Facial', available: true };
    }),
    listCategories: jest.fn().mockResolvedValue([
      { ref: 'category:3', id: 3, name: 'Personal Care', subcategoryCount: 4, serviceCount: 30 },
    ]),
    getCategory: jest.fn(async (id: number) => {
      if (id === 999) throw notFound('Category');
      return { ref: `category:${id}`, id, name: 'Personal Care', available: true };
    }),
    listSubcategoriesOfCategory: jest.fn(async (id: number) => {
      if (id === 999) throw notFound('Category');
      return [{ ref: 'subcategory:7', id: 7, categoryId: id, name: 'Facial', serviceCount: 5 }];
    }),
    getSubcategory: jest.fn(async (id: number) => {
      if (id === 999) throw notFound('Subcategory');
      return { ref: `subcategory:${id}`, id, categoryId: 3, name: 'Facial', available: true };
    }),
    listServicesOfSubcategory: jest.fn(async (id: number) => {
      if (id === 999) throw notFound('Subcategory');
      return [{ ref: 'service:15', id: 15, subcategoryId: id, name: 'Pimple Facial' }];
    }),
  };
});
jest.mock('../src/services/catalogSearchService', () => ({
  searchCatalog: jest.fn(async (q: string, opts: any = {}) => ({
    query: q,
    expandedTerms: [q],
    total: 1,
    hits: [{ ref: 'service:15', type: 'service', id: 15, name: 'Pimple Facial', score: 4, matchedTerm: q }],
    counts: { category: 0, subcategory: 0, service: 1 },
    __types: opts.types,
  })),
}));
jest.mock('../src/services/identityService', () => ({
  getIdentity: jest.fn(async (uid: string) => (uid === 'uid-under-test' ? { uid, id: uid, email: 'a@b.c', role: 3 } : null)),
}));
jest.mock('../src/services/bookingService', () => ({
  getBookingsByUserId: jest.fn().mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }]),
  getBookingById: jest.fn().mockResolvedValue({ id: 7 }),
  getCustomerBookingTimeline: jest.fn().mockResolvedValue([{ step: 'created' }]),
  formatBooking: (raw: any) => ({ ...raw, formatted: true }),
  formatBookings: (rows: any[]) => rows.map((r) => ({ ...r, formatted: true })),
}));
jest.mock('../src/services/bookingAccessService', () => {
  class BookingAccessError extends Error {
    constructor(message: string, readonly statusCode: 403 | 404, readonly code: 'BOOKING_NOT_FOUND' | 'BOOKING_ACCESS_DENIED') {
      super(message);
    }
  }
  return {
    BookingAccessError,
    assertBookingAccess: jest.fn(async (bookingId: number) => {
      if (bookingId === 404) throw new BookingAccessError('gone', 404, 'BOOKING_NOT_FOUND');
      if (bookingId === 403) throw new BookingAccessError('not yours', 403, 'BOOKING_ACCESS_DENIED');
      return 'customer';
    }),
  };
});
jest.mock('../src/services/technicianService', () => ({
  getJobCardsByWorker: jest.fn().mockResolvedValue([{ id: 1 }, { id: 2 }]),
  getJobCardByWorker: jest.fn(async (_uid: string, bookingId: number) => (bookingId === 404 ? null : { id: bookingId })),
}));
jest.mock('../src/controllers/jobCardView', () => ({ formatJobCard: (j: any) => ({ ...j, card: true }) }));
jest.mock('../src/services/notification.service', () => ({
  listCustomerNotifications: jest.fn().mockResolvedValue([{ key: 'n1' }, { key: 'n2' }]),
  countCustomerUnreadNotifications: jest.fn().mockResolvedValue(4),
  isSafeNotificationKey: (k: string) => /^[A-Za-z0-9_.:-]+$/.test(k ?? ''),
  markCustomerNotificationReadByKey: jest.fn(async (_uid: string, key: string) => ({
    found: key !== 'missing',
    allowed: key !== 'locked',
  })),
  markAllCustomerNotificationsRead: jest.fn().mockResolvedValue(undefined),
  getNotificationPrefs: jest.fn().mockResolvedValue({ jobAssigned: true }),
  saveNotificationPrefs: jest.fn(async (_uid: string, body: any) => ({ ...body, saved: true })),
  clearFcmToken: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/services/customerReviewService', () => ({
  listProviderReviews: jest.fn().mockResolvedValue({ reviews: [{ id: 'r1' }], total: 1 }),
  getProviderAggregate: jest.fn().mockResolvedValue({ providerUid: 'p', average: 4.5, count: 2 }),
}));

// ── Auth. `firebaseApp` initialises the Admin SDK from a service-account file
//    at import time, so it has to be stubbed before anything in the auth chain
//    is pulled in — otherwise the suite fails to LOAD, which reads as a broken
//    test rather than a missing credential.
jest.mock('../src/middleware/firebaseApp', () => ({ firebaseAdmin: {}, __esModule: true }));
jest.mock('firebase-admin/auth', () => ({ getAuth: () => ({}) }));
jest.mock('../src/services/firebaseFunctions.service', () => ({
  firebaseAuthLogin: jest.fn().mockResolvedValue({
    data: { token: 'tok', refreshToken: 'ref', uid: 'uid-token', email: 't@x.co', role: 2, isEmailVerified: true },
  }),
  firebaseProviderRegister: jest.fn().mockResolvedValue({ data: { uid: 'uid-new', role: 2 } }),
  getFirebaseUserByEmail: jest.fn().mockResolvedValue({ uid: 'uid-under-test' }),
  getFirebaseUserByUid: jest.fn().mockResolvedValue({ uid: 'uid-under-test', phoneNumber: '+639171234567', providerData: [{ providerId: 'phone' }] }),
  verifyIdTokenStrict: jest.fn().mockResolvedValue({ uid: 'uid-under-test', firebase: { sign_in_provider: 'phone' } }),
  updateFirebaseEmailVerified: jest.fn().mockResolvedValue(undefined),
  revokeTokenInFirebase: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/services/auth.service', () => ({
  loggedInUser: jest.fn(async (email: string, password: string) => {
    if (password !== 'correct-horse') {
      throw Object.assign(new Error('Invalid email or password.'), { statusCode: 401 });
    }
    if (email === 'unverified@x.co') {
      throw Object.assign(new Error('Email not verified.'), { statusCode: 403 });
    }
    return { token: 'tok', refreshToken: 'ref', uid: 'uid-pw', email, role: 3, firstName: 'A', lastName: 'B', isEmailVerified: true };
  }),
  registerUser: jest.fn().mockResolvedValue({ dbRegister: { uid: 'uid-reg' }, verificationType: 'otp', otpDeliveryPending: false }),
  forgotPassword: jest.fn().mockResolvedValue({ message: 'sent' }),
  resetPassword: jest.fn(async ({ oobCode }: any) => {
    if (oobCode === 'spent') throw new Error('invalid oob');
    return { message: 'ok' };
  }),
  resendEmailOtp: jest.fn().mockResolvedValue({ message: 'neutral' }),
  getAndSendEmailVerificationLink: jest.fn().mockResolvedValue({ message: 'sent' }),
  updateFcmToken: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/services/tokenRefreshService', () => {
  class TokenRefreshError extends Error {
    constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); }
  }
  return {
    TokenRefreshError,
    refreshIdToken: jest.fn(async (token: string) => {
      if (token === 'bad') throw new TokenRefreshError(401, 'REFRESH_TOKEN_INVALID', 'nope');
      if (token === 'down') throw new TokenRefreshError(503, 'REFRESH_UNAVAILABLE', 'upstream');
      return { token: 'fresh', refreshToken: 'ref2', uid: 'uid-pw' };
    }),
  };
});
jest.mock('../src/services/otpService', () => ({
  DEFAULT_PURPOSE: 'REGISTRATION_VERIFICATION',
  verifyEmailOtp: jest.fn(async (_email: string, code: string) => {
    if (code === '111111') return { ok: true };
    if (code === '222222') return { ok: false, reason: 'OTP_EXPIRED' };
    return { ok: false, reason: 'OTP_INVALID' };
  }),
}));
jest.mock('../src/services/identifierResolver', () => ({
  resolveIdentifier: jest.fn(async (raw: unknown) => {
    // +639170000000 is the mobile of an account whose email is known.
    if (String(raw).includes('9170000000')) {
      return { type: 'mobile', normalized: '+639170000000', account: { uid: 'uid-pw', email: 'mobile-user@x.co' } };
    }
    // +639179999999 exists but has no email — no password to check.
    if (String(raw).includes('9179999999')) {
      return { type: 'mobile', normalized: '+639179999999', account: { uid: 'uid-nopw', email: null } };
    }
    return { type: 'mobile', normalized: null, account: null };
  }),
}));
jest.mock('../src/services/accountLinkGuard', () => ({
  findLinkCollision: jest.fn(async (_uid: string, _email: unknown, phone: string | null) =>
    phone === '+639170000001' ? { existingUid: 'someone-else', via: 'mobile' } : null,
  ),
}));
jest.mock('../src/services/providerOnboardingService', () => ({
  upsertSourceAttribution: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/constants/platformContinueUrls', () => ({
  continueUrlFor: () => undefined,
  assertContinueUrlsAreUsable: () => {},
}));

jest.mock('../src/services/booking/transitionExecutor', () => {
  class TransitionError extends Error {
    constructor(readonly code: string, message: string, readonly detail?: unknown) { super(message); }
  }
  return {
    TransitionError,
    transitionBooking: jest.fn(async (input: any) => ({
      bookingId: input.bookingId,
      action: input.action,
      fromState: 'ASSIGNED',
      toState: 'ACCEPTED',
      idempotentReplay: false,
      correlationId: 'corr-1',
      timelineEventId: 1,
    })),
    getBookingTimeline: jest.fn(async (bookingId: number) => [
      {
        id: 1, bookingId, action: 'PROVIDER_ACCEPT', fromState: 'ASSIGNED', toState: 'ACCEPTED',
        actorRole: 'assigned_provider', providerUid: 'p1', reason: null,
        correlationId: 'corr-1', occurredAt: '2026-08-12T00:00:00.000Z',
      },
    ]),
    // Evaluated by the SAME guards the executor enforces, so the transitions
    // endpoint tells a client exactly what the executor would allow.
    getAvailableActions: jest.fn(async () => [
      { action: 'PROVIDER_EN_ROUTE', allowed: true },
      {
        action: 'PROVIDER_CANCEL',
        allowed: false,
        reasonCode: 'BOOKING_PROVIDER_CANCEL_WINDOW_EXPIRED',
        detail: { allowedUntil: '2026-08-10T09:00:00.000Z', noticeHours: 48, hoursUntilStart: 3 },
      },
    ]),
  };
});

import v1Router from '../src/api/v1/register';
import { IMPLEMENTED, PLANNED, fullPath } from '../src/api/v1/contract';

// ─── Harness ──────────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Mounted exactly as app.ts mounts it.
  app.use('/api/v1', v1Router);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  // Node's global fetch keeps sockets alive through undici's agent, so close()
  // alone leaves the handle open and jest reports a worker that would not exit.
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

type Call = { status: number; body: any; headers: Headers };

const call = async (
  method: string,
  path: string,
  opts: { auth?: boolean; role?: 'provider' | 'admin'; body?: unknown } = {},
): Promise<Call> => {
  const headers: Record<string, string> = {};
  if (opts.auth !== false) headers.authorization = 'Bearer test';
  if (opts.role) headers['x-test-role'] = opts.role;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';

  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
};

// ─── Reachability ─────────────────────────────────────────────────────────────

describe('every implemented contract entry is reachable at its declared path', () => {
  /**
   * A concrete request per entry, with params filled and auth satisfied. If an
   * entry is added to the contract without a case here the final test in this
   * block fails, so coverage cannot quietly lapse.
   */
  const CASES: Record<string, () => Promise<Call>> = {
    'catalog.browse': () => call('GET', '/api/v1/catalog', { auth: false }),
    'catalog.summary': () => call('GET', '/api/v1/catalog/summary', { auth: false }),
    'catalog.services.list': () => call('GET', '/api/v1/catalog/services', { auth: false }),
    'catalog.services.get': () => call('GET', '/api/v1/catalog/services/15', { auth: false }),
    'identity.me': () => call('GET', '/api/v1/me'),
    'bookings.listMine': () => call('GET', '/api/v1/bookings'),
    'bookings.get': () => call('GET', '/api/v1/bookings/7'),
    'bookings.timeline': () => call('GET', '/api/v1/bookings/7/timeline'),
    'provider.jobs.list': () => call('GET', '/api/v1/provider/jobs', { role: 'provider' }),
    'provider.jobs.get': () => call('GET', '/api/v1/provider/jobs/7', { role: 'provider' }),
    'notifications.list': () => call('GET', '/api/v1/notifications'),
    'notifications.unreadCount': () => call('GET', '/api/v1/notifications/unread-count'),
    'notifications.markRead': () => call('PATCH', '/api/v1/notifications/n1/read'),
    'notifications.markAllRead': () => call('POST', '/api/v1/notifications/read-all'),
    'reviews.provider.list': () => call('GET', '/api/v1/reviews/providers/provider-uid-1', { auth: false }),
    'reviews.provider.rating': () => call('GET', '/api/v1/reviews/providers/provider-uid-1/rating', { auth: false }),
    'settings.notificationPreferences.get': () => call('GET', '/api/v1/settings/notification-preferences'),
    'settings.notificationPreferences.put': () =>
      call('PUT', '/api/v1/settings/notification-preferences', { body: { jobAssigned: false } }),
    'auth.register': () =>
      call('POST', '/api/v1/auth/register', {
        auth: false,
        body: { email: 'new@x.co', password: 'correct-horse', firstName: 'A', lastName: 'B', role: 3 },
      }),
    'auth.login': () =>
      call('POST', '/api/v1/auth/login', {
        auth: false,
        body: { identifier: 'a@x.co', password: 'correct-horse' },
      }),
    'auth.refresh': () => call('POST', '/api/v1/auth/refresh', { auth: false, body: { refreshToken: 'good' } }),
    'auth.logout': () => call('POST', '/api/v1/auth/logout'),
    'auth.forgotPassword': () =>
      call('POST', '/api/v1/auth/forgot-password', { auth: false, body: { identifier: 'a@x.co' } }),
    'auth.resetPassword': () =>
      call('POST', '/api/v1/auth/reset-password', {
        auth: false,
        body: { oobCode: 'fresh', newPassword: 'correct-horse' },
      }),
    'auth.verifyEmail': () =>
      call('POST', '/api/v1/auth/verify-email', { auth: false, body: { identifier: 'a@x.co', code: '111111' } }),
    'auth.resendVerification': () =>
      call('POST', '/api/v1/auth/resend-verification', { auth: false, body: { identifier: 'a@x.co' } }),
    'auth.verifyMobile': () => call('POST', '/api/v1/auth/verify-mobile', { body: { idToken: 'phone-token' } }),
    'catalog.categories.list': () => call('GET', '/api/v1/catalog/categories', { auth: false }),
    'catalog.categories.get': () => call('GET', '/api/v1/catalog/categories/3', { auth: false }),
    'catalog.categories.subcategories': () =>
      call('GET', '/api/v1/catalog/categories/3/subcategories', { auth: false }),
    'catalog.subcategories.get': () => call('GET', '/api/v1/catalog/subcategories/7', { auth: false }),
    'catalog.subcategories.services': () =>
      call('GET', '/api/v1/catalog/subcategories/7/services', { auth: false }),
    'search.query': () => call('GET', '/api/v1/search?q=facial', { auth: false }),
    'catalog.search': () => call('GET', '/api/v1/catalog/search?q=facial', { auth: false }),
    'bookings.cancel': () => call('POST', '/api/v1/bookings/7/cancel', { body: {} }),
    'bookings.transitions': () => call('GET', '/api/v1/bookings/7/transitions'),
    'provider.jobs.accept': () => call('POST', '/api/v1/provider/jobs/7/accept', { role: 'provider', body: {} }),
    'provider.jobs.decline': () => call('POST', '/api/v1/provider/jobs/7/decline', { role: 'provider', body: {} }),
    'provider.jobs.enroute': () => call('POST', '/api/v1/provider/jobs/7/en-route', { role: 'provider', body: {} }),
    'provider.jobs.arrived': () => call('POST', '/api/v1/provider/jobs/7/arrived', { role: 'provider', body: {} }),
    'provider.jobs.start': () =>
      call('POST', '/api/v1/provider/jobs/7/start', { role: 'provider', body: { workerCode: '123456' } }),
    'provider.jobs.complete': () => call('POST', '/api/v1/provider/jobs/7/complete', { role: 'provider', body: {} }),
  };

  it('has a live request case for every implemented entry, and no more', () => {
    expect(Object.keys(CASES).sort()).toEqual(IMPLEMENTED.map((e) => e.id).sort());
  });

  for (const entry of IMPLEMENTED) {
    it(`${entry.method.toUpperCase()} ${fullPath(entry)} answers 2xx in the v1 success shape`, async () => {
      const res = await CASES[entry.id]();
      // 200 or 201 — registration creates a resource and says so. Pinning 200
      // would force every creation to lie about what it did.
      expect([200, 201]).toContain(res.status);
      expect(res.body).toHaveProperty('data');
      // The v1 success body must NOT carry a second, independently-settable
      // success signal — that is how `{ success: true }` ends up on a 500.
      expect(res.body).not.toHaveProperty('status');
      expect(res.body).not.toHaveProperty('success');
      expect(res.headers.get('x-request-id')).toBeTruthy();
    });
  }
});

// ─── The regression that motivated all of this ────────────────────────────────

describe('the browse root is reachable — the GET /api/catalog defect, in v1 form', () => {
  it('GET /api/v1/catalog returns the catalog and not something else', async () => {
    const res = await call('GET', '/api/v1/catalog', { auth: false });
    expect(res.status).toBe(200);
    expect(res.body.data.categories[0].name).toBe('Personal Care');
    expect(res.body.meta.summary.services).toBe(95);
  });

  it('a literal segment beats a parameter at the same position', async () => {
    // '/notifications/unread-count' must not bind 'unread-count' as :key.
    const res = await call('GET', '/api/v1/notifications/unread-count');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ count: 4 });
  });
});

// ─── Auth is derived from the contract, not from convention ───────────────────

describe('declared auth mode is the mounted auth mode', () => {
  const PUBLIC = IMPLEMENTED.filter((e) => e.auth === 'public');
  const AUTHED = IMPLEMENTED.filter((e) => e.auth === 'authenticated');
  const PROVIDER = IMPLEMENTED.filter((e) => e.auth === 'provider');

  it('every entry falls into a mode this suite exercises', () => {
    expect(PUBLIC.length + AUTHED.length + PROVIDER.length).toBe(IMPLEMENTED.length);
  });

  it('public routes answer without a token', async () => {
    const res = await call('GET', '/api/v1/catalog/summary', { auth: false });
    expect(res.status).toBe(200);
  });

  it.each(AUTHED.map((e) => [e.id, e.method.toUpperCase(), fullPath(e)]))(
    '%s — %s %s refuses an anonymous caller',
    async (_id, method, path) => {
      const concrete = String(path).replace(/:(\w+)/g, '7');
      const res = await call(String(method), concrete, { auth: false });
      expect(res.status).toBe(401);
    },
  );

  it.each(PROVIDER.map((e) => [e.id, e.method.toUpperCase(), fullPath(e)]))(
    '%s — %s %s refuses a signed-in non-provider',
    async (_id, method, path) => {
      const concrete = String(path).replace(/:(\w+)/g, '7');
      const res = await call(String(method), concrete);
      expect(res.status).toBe(403);
    },
  );
});

// ─── Planned entries are documented, not mounted ──────────────────────────────

describe('planned entries are not reachable', () => {
  it.each(PLANNED.map((e) => [e.id, e.method.toUpperCase(), fullPath(e)]))(
    '%s — %s %s is documented but returns 404',
    async (_id, method, path) => {
      const concrete = String(path).replace(/:(\w+)/g, '7');
      const res = await call(String(method), concrete);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    },
  );
});

// ─── The error standard ───────────────────────────────────────────────────────

describe('failures use the one v1 error shape', () => {
  it('an unknown v1 path 404s and says so, instead of falling through to the legacy tree', async () => {
    const res = await call('GET', '/api/v1/not-a-real-endpoint');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.requestId).toBeTruthy();
    expect(res.body).not.toHaveProperty('data');
  });

  it('a validation failure carries VALIDATION_FAILED, not a driver message', async () => {
    const res = await call('GET', '/api/v1/catalog/services/not-a-number', { auth: false });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('a service 404 becomes the domain code, not a generic one', async () => {
    const res = await call('GET', '/api/v1/catalog/services/999', { auth: false });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CATALOG_SERVICE_NOT_FOUND');
  });

  it('booking access errors keep their own codes across the envelope change', async () => {
    expect((await call('GET', '/api/v1/bookings/404')).body.error.code).toBe('BOOKING_NOT_FOUND');
    expect((await call('GET', '/api/v1/bookings/403')).body.error.code).toBe('BOOKING_ACCESS_DENIED');
  });

  it('a missing notification is NOT_FOUND and a locked one is NOT_ACTIONABLE', async () => {
    expect((await call('PATCH', '/api/v1/notifications/missing/read')).body.error.code)
      .toBe('NOTIFICATION_NOT_FOUND');
    expect((await call('PATCH', '/api/v1/notifications/locked/read')).body.error.code)
      .toBe('NOTIFICATION_NOT_ACTIONABLE');
  });

  it('a provider asking for a booking that is not theirs gets 404, not a leak', async () => {
    const res = await call('GET', '/api/v1/provider/jobs/404', { role: 'provider' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

// ─── Pagination ───────────────────────────────────────────────────────────────

describe('pagination is clamped at the boundary', () => {
  it('reports page meta on a list', async () => {
    const res = await call('GET', '/api/v1/bookings?limit=2&offset=0');
    expect(res.body.data.bookings).toHaveLength(2);
    expect(res.body.meta.page).toEqual({ limit: 2, offset: 0, total: 3, hasMore: true });
  });

  it('a negative offset does not reach the service — the legacy review route 500s on this', async () => {
    const res = await call('GET', '/api/v1/bookings?offset=-1');
    expect(res.status).toBe(200);
    expect(res.body.meta.page.offset).toBe(0);
  });

  it('a non-numeric limit falls back to the default rather than becoming NaN', async () => {
    const res = await call('GET', '/api/v1/bookings?limit=abc');
    expect(res.status).toBe(200);
    expect(res.body.meta.page.limit).toBe(20);
  });

  it('limit is capped at the endpoint maximum', async () => {
    const res = await call('GET', '/api/v1/reviews/providers/provider-uid-1?limit=5000', { auth: false });
    expect(res.body.meta.page.limit).toBe(50);
  });
});

// ─── Catalog hierarchy routing ───────────────────────────────────────────────

describe('the catalog hierarchy resolves to the right level', () => {
  it('a literal segment beats a parameter: /catalog/categories is not a service id', async () => {
    const res = await call('GET', '/api/v1/catalog/categories', { auth: false });
    expect(res.status).toBe(200);
    expect(res.body.data.categories[0].ref).toBe('category:3');
  });

  it('/catalog/search is not parsed as a service id', async () => {
    // `/catalog/services/:serviceId` and `/catalog/search` share a prefix, and
    // the composition layer's specificity sort is what keeps "search" a literal.
    const res = await call('GET', '/api/v1/catalog/search?q=facial', { auth: false });
    expect(res.status).toBe(200);
    expect(res.body.data.hits[0].ref).toBe('service:15');
  });

  it('each hierarchy level reports its OWN not-found code', async () => {
    expect((await call('GET', '/api/v1/catalog/categories/999', { auth: false })).body.error.code)
      .toBe('CATALOG_CATEGORY_NOT_FOUND');
    expect((await call('GET', '/api/v1/catalog/subcategories/999', { auth: false })).body.error.code)
      .toBe('CATALOG_SUBCATEGORY_NOT_FOUND');
    expect((await call('GET', '/api/v1/catalog/services/999', { auth: false })).body.error.code)
      .toBe('CATALOG_SERVICE_NOT_FOUND');
  });

  it('a missing parent 404s rather than returning an empty child list', async () => {
    // Empty and missing are different facts; a client rendering "no
    // subcategories yet" for a deleted id is showing a page that should not exist.
    const res = await call('GET', '/api/v1/catalog/categories/999/subcategories', { auth: false });
    expect(res.status).toBe(404);
  });

  it('rejects a non-numeric id at every level with the same code', async () => {
    for (const path of [
      '/api/v1/catalog/categories/abc',
      '/api/v1/catalog/subcategories/abc',
      '/api/v1/catalog/services/abc',
    ]) {
      const res = await call('GET', path, { auth: false });
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    }
  });

  it('every entity in every catalog response carries a qualified ref', async () => {
    const cats = await call('GET', '/api/v1/catalog/categories', { auth: false });
    const subs = await call('GET', '/api/v1/catalog/categories/3/subcategories', { auth: false });
    const svcs = await call('GET', '/api/v1/catalog/subcategories/7/services', { auth: false });

    expect(cats.body.data.categories.every((c: any) => /^category:\d+$/.test(c.ref))).toBe(true);
    expect(subs.body.data.subcategories.every((x: any) => /^subcategory:\d+$/.test(x.ref))).toBe(true);
    expect(svcs.body.data.services.every((x: any) => /^service:\d+$/.test(x.ref))).toBe(true);
  });
});

describe('booking lifecycle actions route to the executor', () => {
  const executor = () => require('../src/services/booking/transitionExecutor');

  beforeEach(() => executor().transitionBooking.mockClear());

  it('each action endpoint names its OWN action, never a destination state', async () => {
    const expected: Array<[string, string]> = [
      ['/api/v1/provider/jobs/7/accept', 'PROVIDER_ACCEPT'],
      ['/api/v1/provider/jobs/7/decline', 'PROVIDER_DECLINE'],
      ['/api/v1/provider/jobs/7/en-route', 'PROVIDER_EN_ROUTE'],
      ['/api/v1/provider/jobs/7/arrived', 'PROVIDER_ARRIVED'],
      ['/api/v1/provider/jobs/7/complete', 'PROVIDER_COMPLETE'],
    ];
    for (const [path, action] of expected) {
      executor().transitionBooking.mockClear();
      await call('POST', path, { role: 'provider', body: {} });
      expect(executor().transitionBooking).toHaveBeenCalledWith(
        expect.objectContaining({ action, bookingId: 7 }),
      );
    }
  });

  it('takes the actor from the TOKEN, never from the body', async () => {
    await call('POST', '/api/v1/provider/jobs/7/accept', {
      role: 'provider',
      body: { actorUid: 'someone-else', workerUid: 'someone-else', providerUid: 'someone-else' },
    });
    const arg = executor().transitionBooking.mock.calls[0][0];
    expect(arg.actorUid).toBe('uid-under-test');
    expect(arg.metadata).not.toHaveProperty('workerUid');
    expect(arg.metadata).not.toHaveProperty('providerUid');
  });

  it('passes expectedState through for optimistic concurrency', async () => {
    await call('POST', '/api/v1/provider/jobs/7/en-route', {
      role: 'provider',
      body: { expectedState: 'accepted' },
    });
    expect(executor().transitionBooking.mock.calls[0][0].expectedState).toBe('ACCEPTED');
  });

  it('reads the Idempotency-Key from the HEADER', async () => {
    const res = await fetch(`${base}/api/v1/provider/jobs/7/accept`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test',
        'x-test-role': 'provider',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefgh1234',
      },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(executor().transitionBooking.mock.calls[0][0].idempotencyKey).toBe('abcdefgh1234');
  });

  it('rejects a malformed Idempotency-Key rather than ignoring it', async () => {
    // Silently ignoring it is worse than refusing: the caller believes the
    // retry is protected and it is not.
    const res = await fetch(`${base}/api/v1/provider/jobs/7/accept`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test',
        'x-test-role': 'provider',
        'content-type': 'application/json',
        'idempotency-key': 'short',
      },
      body: '{}',
    });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error.code).toBe('IDEMPOTENCY_KEY_INVALID');
  });

  it('returns the caller-appropriate projection alongside the result', async () => {
    const provider = await call('POST', '/api/v1/provider/jobs/7/accept', { role: 'provider', body: {} });
    expect(provider.body.data.state.canonicalState).toBe('ACCEPTED');
    expect(provider.body.data.state.nextAction).toBe('markEnRoute');

    const customer = await call('POST', '/api/v1/bookings/7/cancel', { body: {} });
    expect(customer.body.data.state.label).toBe('Confirmed');
  });

  it('the transitions endpoint returns the canonical event log', async () => {
    const res = await call('GET', '/api/v1/bookings/7/transitions');
    expect(res.status).toBe(200);
    expect(res.body.data.currentState).toBe('ACCEPTED');
    expect(res.body.data.events[0].action).toBe('PROVIDER_ACCEPT');
  });

  it('a provider action refuses a signed-in non-provider', async () => {
    const res = await call('POST', '/api/v1/provider/jobs/7/accept', { body: {} });
    expect(res.status).toBe(403);
  });

  it('rejects a non-numeric bookingId', async () => {
    const res = await call('POST', '/api/v1/provider/jobs/abc/accept', { role: 'provider', body: {} });
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('search', () => {
  it('/search and /catalog/search return the same body', async () => {
    const a = await call('GET', '/api/v1/search?q=facial', { auth: false });
    const b = await call('GET', '/api/v1/catalog/search?q=facial', { auth: false });
    expect(a.body.data).toEqual(b.body.data);
  });

  it('passes a valid type filter through', async () => {
    const res = await call('GET', '/api/v1/search?q=facial&types=service,category', { auth: false });
    expect(res.status).toBe(200);
    expect(res.body.data.__types).toEqual(['service', 'category']);
  });

  it('refuses an unrecognised type instead of silently narrowing', async () => {
    // Answering with services for `types=provider` would tell a client that
    // providers are searchable.
    const res = await call('GET', '/api/v1/search?q=facial&types=provider', { auth: false });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('every hit carries a ref, so a mixed result set is keyable', async () => {
    const res = await call('GET', '/api/v1/search?q=facial', { auth: false });
    expect(res.body.data.hits.every((h: any) => typeof h.ref === 'string' && h.ref.includes(':'))).toBe(true);
  });
});
