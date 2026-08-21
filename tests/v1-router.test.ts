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

/**
 * The active-provider gate, wired as a pass-through.
 *
 * `requireActiveProvider` reads `user_credentials.account_status` from the
 * database. This suite drives the router with a fake identity and no database,
 * so leaving it real means every provider action stops at the middleware and
 * the executor is never reached — which is what happened when the job actions
 * first declared `activeProvider: true`.
 *
 * Mocked open rather than removed from the chain: whether the middleware is
 * MOUNTED is asserted by `tests/legacy-authz-parity.test.ts`, which compares the
 * contract's `activeProvider` flag against the legacy route's own chain, and
 * whether it REFUSES is asserted by the middleware's own suite. What this suite
 * is for is routing and executor wiring, and a real gate here would only test
 * the database fixture.
 */
jest.mock('../src/middleware/requireActiveProvider', () => ({
  __esModule: true,
  default: (_req: any, _res: any, next: any) => next(),
}));

/**
 * The admin permission gate. TAB 07's reconciliation route carries
 * `requirePermission('reconciliation.view')` on top of its role check, so this
 * suite has to have it WIRED for the route to answer at all — which is the
 * property that matters: a v1 admin route mounted without the permission its
 * legacy predecessor required would fail here.
 */
jest.mock('../src/middleware/requirePermission', () => ({
  __esModule: true,
  requirePermission: (permission: string) => (req: any, res: any, next: any) => {
    if (req.headers['x-test-permission'] !== permission) {
      return res.status(403).json({ status: 'failed', code: 'PERMISSION_REQUIRED' });
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
      // The experience handlers derive the ACTOR from this relationship rather
      // than from a role claim, so the fixture needs a booking whose caller is
      // the provider: additional work may only be raised by the provider
      // working the job. Booking 8 is that booking.
      if (bookingId === 8) return 'provider';
      return 'customer';
    }),
  };
});
jest.mock('../src/services/technicianService', () => ({
  // TAB 06.
  upsertWorkerLocation: jest.fn().mockResolvedValue(undefined),
  // TAB 05.
  pauseService: jest.fn().mockResolvedValue({ service_id: 7, status: 'paused', pause_reason: 'Away' }),
  reactivateService: jest.fn().mockResolvedValue({ service_id: 7, status: 'active', pause_reason: null }),
  getJobCardsByWorker: jest.fn().mockResolvedValue([{ id: 1 }, { id: 2 }]),
  getJobCardByWorker: jest.fn(async (_uid: string, bookingId: number) => (bookingId === 404 ? null : { id: bookingId })),
}));
// -- TAB 06 booking experiences. Mocked for the same reason every other domain
//    service here is: the subject under test is routing and composition, and
//    each of these is exercised against its own fake in its own suite.
jest.mock('../src/services/booking/bookingOtpService', () => {
  const actual = jest.requireActual('../src/services/booking/bookingOtpService');
  return {
    // `parsePurpose` is pure validation and part of what the route contract
    // promises, so it is NOT faked.
    parsePurpose: actual.parsePurpose,
    BookingOtpError: actual.BookingOtpError,
    requestBookingOtp: jest.fn(async ({ bookingId, purpose }: any) => ({
      bookingId, purpose, delivery: 'email', recipient: 'customer',
      expiresAt: '2026-08-20T10:00:00.000Z',
      resendAvailableAt: '2026-08-20T09:01:00.000Z',
      issuesRemaining: 9, attemptsRemaining: 5,
    })),
    verifyBookingOtp: jest.fn(async ({ bookingId, purpose }: any) => ({
      bookingId, purpose, attemptsRemaining: 5,
      transition: {
        bookingId, action: 'CUSTOMER_CONFIRM_OTP',
        fromState: 'PENDING_OTP', toState: 'AWAITING_ASSIGNMENT',
        idempotentReplay: false, stateChanged: true,
      },
    })),
    readCredentialState: jest.fn(async () => ({
      purpose: 'BOOKING_CONFIRMATION', present: true,
      issuedAt: new Date('2026-08-20T09:00:00.000Z'),
      expiresAt: new Date('2026-08-20T10:00:00.000Z'),
      expired: false, failedAttempts: 0, attemptsRemaining: 5,
      issueCount: 1, cooldownRemainingSeconds: 0,
    })),
  };
});
jest.mock('../src/services/booking/bookingTrackingService', () => ({
  getBookingTracking: jest.fn(async (bookingId: number) => ({
    bookingId, state: 'EN_ROUTE', steps: [],
    assignedProvider: { assigned: true, location: null },
    visibility: {
      visibility: 'WITHHELD', reason: 'NO_POSITION_REPORTED',
      trackableStates: ['EN_ROUTE', 'ARRIVED', 'IN_PROGRESS'], windowClosesAt: null,
    },
    policy: { trackableStates: ['EN_ROUTE', 'ARRIVED', 'IN_PROGRESS'], maxHoursSinceMovement: 12 },
  })),
}));
jest.mock('../src/services/booking/bookingRescheduleService', () => {
  const actual = jest.requireActual('../src/services/booking/bookingRescheduleService');
  return {
    RescheduleError: actual.RescheduleError,
    rescheduleBooking: jest.fn(async ({ bookingId, scheduledAt }: any) => ({
      bookingId, requestId: 1, status: 'ACCEPTED',
      previousSchedule: null, scheduledAt, reasonCode: null,
      appliedImmediately: true,
      verdict: { allowed: true, refusal: null, noticeCutoff: null, noticeHours: 24, reasons: [] },
    })),
    listRescheduleRequests: jest.fn(async () => []),
  };
});
jest.mock('../src/services/booking/bookingDisputeService', () => {
  const actual = jest.requireActual('../src/services/booking/bookingDisputeService');
  return {
    DisputeError: actual.DisputeError,
    openDispute: jest.fn(async ({ bookingId, category }: any) => ({
      id: 1, bookingId, category, severity: 'normal', state: 'OPEN',
      openedByRole: 'customer', openedByYou: true,
      openedAt: '2026-08-20T09:00:00.000Z', resolvedAt: null, stateSnapshot: null,
    })),
    listDisputes: jest.fn(async () => []),
  };
});
jest.mock('../src/services/additional.service', () => ({
  additionalService: {
    createRequest: jest.fn(async (bookingId: number) => ({
      id: 21, booking_id: bookingId, status: 'PENDING_ADMIN_APPROVAL', total_amount: 500,
    })),
    getByBooking: jest.fn(async () => []),
  },
}));
jest.mock('../src/services/booking/experienceEvents', () => ({
  emitExperienceEvent: jest.fn(async () => undefined),
}));

// -- TAB 07 finance. Same reasoning: each of these is exercised against its own
//    fake in its own suite, and what this file proves is that the PATH reaches
//    the handler with the right auth mode.
jest.mock('../src/services/finance/bookingPaymentService', () => {
  const actual = jest.requireActual('../src/services/finance/bookingPaymentService');
  return {
    // The error class and the per-actor projection are pure and are part of what
    // the route contract promises, so they are NOT faked.
    BookingPaymentError: actual.BookingPaymentError,
    projectFor: actual.projectFor,
    startPaymentIntent: jest.fn(async (bookingId: number) => ({
      bookingId, checkoutUrl: 'https://checkout.paymongo.com/cs_test', reused: false,
    })),
    getBookingPayment: jest.fn(async (bookingId: number) => ({
      bookingId, currency: 'PHP', state: 'PAID', captured: true,
      method: 'paymongo', paidAt: '2026-08-20T09:00:00.000Z',
      breakdown: { gross: 1500, grossMinor: 150000, basePrice: 1500, additionalWork: 0 },
      refund: { refundedAmount: 0, refundedAt: null, refundable: 1500, refundableMinor: 150000 },
    })),
    refundBookingPayment: jest.fn(async ({ bookingId, trigger }: any) => ({
      bookingId, outcome: 'requested', trigger, amount: 1500, amountMinor: 150000,
      currency: 'PHP', reference: 'SVN-RF-B000007', refundReviewId: 3,
      reversesProviderEarning: true,
    })),
  };
});
jest.mock('../src/services/finance/providerEarningsService', () => {
  const actual = jest.requireActual('../src/services/finance/providerEarningsService');
  return {
    EarningsRangeError: actual.EarningsRangeError,
    getEarningsSummary: jest.fn(async () => ({
      economicModel: 'EXTERNAL_PROVIDER', withheldReason: null,
      totalEarned: 1200, totalPaid: 1200, totalPending: 0, totalFailed: 0, totalRefunded: 0,
      pendingRecordedAmount: 0, pendingEstimatedAmount: 0, pendingIsEstimate: false,
      estimatedJobsCount: 0, jobsCount: 1, periodLabel: 'All time',
      currency: 'PHP', payoutWindowHours: 72,
    })),
    listEarningsTransactions: jest.fn(async () => []),
    listProviderPayouts: jest.fn(async () => []),
  };
});
/**
 * TAB 06 wave 1 — the admin booking domain.
 *
 * Stubbed at the DOMAIN SERVICE, never at the handler. The point of this suite
 * is that the real router, the real auth chain and the real permission
 * middleware are exercised over a real socket; replacing the handler would
 * leave the wiring untested, which is the only thing this file can actually
 * prove.
 */
/**
 * The refund executor, faked to a bare success.
 *
 * This suite tests ROUTING: does the path reach the handler, is the declared
 * auth mode actually mounted, does the envelope come back in the v1 shape. The
 * executor's own rules — the approved-only state guard, the missing-versus-
 * wrong-status distinction, the audit — are proven against a real PostgreSQL in
 * `npm run refunds:segregation` and against a fake engine in
 * `tests/refund-segregation-of-duties.test.ts`.
 *
 * Left unmocked it reached the blanket dbQuery fake, got zero rows and answered
 * 404, which is the executor behaving correctly and this suite asking the wrong
 * question.
 */
jest.mock('../src/services/adminFinanceService', () => ({
  __esModule: true,
  markRefundFailed: async () => undefined,
}));

jest.mock('../src/services/adminBookingService', () => ({
  __esModule: true,
  isBookingState: (s: string) => ['PENDING', 'ASSIGNED', 'COMPLETED'].includes(s),
  getAdminBookings: async () => ({ bookings: [], total: 0, page: 1, limit: 25 }),
  adminAssignProvider: async (bookingId: number, providerUid: string) => ({
    bookingId,
    providerUid,
    state: 'ASSIGNED',
  }),
  adminReassignProvider: async (bookingId: number, toProviderUid: string) => ({
    bookingId,
    providerUid: toProviderUid,
    state: 'ASSIGNED',
  }),
  ensureBookingOpsSchema: async () => undefined,
}));

jest.mock('../src/services/providerEligibilityEngine', () => ({
  __esModule: true,
  listAssignmentCandidatePool: async () => ({
    candidates: [{ uid: 'provider-under-test', eligible: true }],
    diagnostics: { poolSize: 1, blockedBy: {} },
  }),
}));

jest.mock('../src/services/adminAuditService', () => ({
  __esModule: true,
  auditFire: () => undefined,
  ensureAuditSchema: async () => undefined,
}));

jest.mock('../src/services/finance/financeReconciliationService', () => ({
  LEDGER_INTEGRITY_CHECKS: [],
  getReconciliationReport: jest.fn(async () => ({
    generatedAt: '2026-08-20T09:00:00.000Z',
    checks: [], totals: {
      openBreaks: 0, criticalBreaks: 0, capturedAmount: 0, refundedAmount: 0,
      accruedProviderEarnings: 0, releasedPayouts: 0, internalFixerRevenue: 0,
      outstandingProviderLiability: 0,
    },
    breaks: [], balanced: true,
  })),
  getBookingReconciliation: jest.fn(async () => null),
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
  deleteCustomerNotificationByKey: jest.fn(async (_uid: string, key: string) => ({
    found: key !== 'missing',
    allowed: key !== 'locked',
  })),
  deleteNotificationByKey: jest.fn(async () => ({ found: true, allowed: true })),
  getNotificationPrefs: jest.fn().mockResolvedValue({ jobAssigned: true }),
  saveNotificationPrefs: jest.fn(async (_uid: string, body: any) => ({ ...body, saved: true })),
  clearFcmToken: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/services/customerReviewService', () => ({
  listProviderReviews: jest.fn().mockResolvedValue({ reviews: [{ id: 'r1' }], total: 1 }),
  getProviderAggregate: jest.fn().mockResolvedValue({ providerUid: 'p', average: 4.5, count: 2 }),
  // -- TAB 12. The eligibility and duplicate rules are exercised against a real
  //    fake database in `review-eligibility.test.ts`; here the subject is routing.
  createReview: jest.fn().mockResolvedValue({
    reviewId: 'rev-1', bookingId: '7', overallRating: 5, dimensions: {},
    publicComment: 'Great work.', privateFeedback: null, visibility: 'PUBLIC',
    publicationState: 'PUBLISHED', createdAt: null, editedAt: null, editableUntil: null,
  }),
  getReviewByBooking: jest.fn().mockResolvedValue(null),
  getReviewEligibility: jest.fn().mockResolvedValue({
    bookingId: '7', eligible: true, reason: null, reviewId: null,
    reviewWindow: { opensAt: '2026-08-01T00:00:00.000Z', closesAt: '2026-08-15T00:00:00.000Z' },
    editableUntil: null, availableActions: ['create'],
  }),
}));
jest.mock('../src/services/reviews/postServiceSupportService', () => {
  const actual = jest.requireActual('../src/services/reviews/postServiceSupportService');
  return {
    SupportCaseError: actual.SupportCaseError,
    ensureSupportSchema: jest.fn().mockResolvedValue(undefined),
    createSupportCase: jest.fn(async (input: any) => ({
      caseId: '1', bookingId: input.bookingId, category: input.category,
      severity: 'normal', routedTo: input.category === 'BILLING' ? 'finance' : 'support',
      state: 'OPEN', summary: input.summary, createdAt: null,
      nextEndpoint: input.category === 'BILLING'
        ? 'POST /api/v1/bookings/:bookingId/refunds' : null,
    })),
    listSupportCases: jest.fn().mockResolvedValue([]),
    __resetSupportSchema: jest.fn(),
  };
});

// ── Auth. `firebaseApp` initialises the Admin SDK from a service-account file
//    at import time, so it has to be stubbed before anything in the auth chain
//    is pulled in — otherwise the suite fails to LOAD, which reads as a broken
//    test rather than a missing credential.
jest.mock('../src/middleware/firebaseApp', () => ({ getFirebaseAdmin: () => ({}), __esModule: true }));
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

// -- TAB 08 messaging. Mocked for the same reason as every other domain service
//    here: the subject is routing and composition. The conversation handlers are
//    driven against a real fake database in `messaging-contract.test.ts`.
jest.mock('../src/services/messaging/messagingService', () => {
  const actual = jest.requireActual('../src/services/messaging/messagingService');
  const conversation = (id: number) => ({
    id, kind: 'BOOKING', bookingId: 7, bookingCode: 'SVN-000007', status: 'ACTIVE',
    isClosed: false, viewerSeat: 'customer', canSend: true, cannotSendReason: null,
    unreadCount: 2, isParticipant: true,
    createdAt: null, updatedAt: null, lastMessageAt: null,
    participants: [], lastMessage: null,
  });
  return {
    // The refusal class is real: the error translation in the domain module is
    // part of what these routes promise, so faking it would prove nothing.
    MessagingError: actual.MessagingError,
    openConversation: jest.fn(async (_actor: any, bookingId: number) => ({
      conversation: { ...conversation(11), bookingId },
      created: true,
    })),
    listConversations: jest.fn(async () => [conversation(11), conversation(12)]),
    getConversation: jest.fn(async (_actor: any, id: number) => conversation(id)),
    listMessages: jest.fn(async (_actor: any, id: number, opts: any = {}) => ({
      conversationId: id,
      messages: [],
      nextCursor: null,
      hasMore: false,
      limit: opts.limit ?? 30,
    })),
    sendMessage: jest.fn(async (_actor: any, id: number) => ({
      id: 99, conversationId: id, bookingId: 7, type: 'text', body: 'hi',
      senderSeat: 'customer', senderUid: 'uid-under-test', isMine: true, isSystem: false,
      clientMsgId: 'client-message-id-0001', sentAt: '2026-08-13T00:00:00.000Z',
      editedAt: null, deletedAt: null, isDeleted: false,
      readByCount: 0, readByAll: false, attachments: [], metadata: {},
    })),
    markRead: jest.fn(async (_actor: any, id: number, lastReadMessageId: number) => ({
      conversationId: id, lastReadMessageId, unreadCount: 0, isParticipant: true,
    })),
    uploadAttachment: jest.fn(async () => ({
      attachmentId: 'uid-under-test_0000', previewUrl: 'https://example.test/a.png',
      fileName: 'shot.png', mimeType: 'image/png', sizeBytes: 68,
    })),
    reportMessage: jest.fn(async () => ({ reportId: '5' })),
  };
});

// -- TAB 09 notifications. The inbox, preference and device services are
//    exercised against a real fake database in their own suites.
jest.mock('../src/services/events/notificationInbox', () => ({
  storeForRole: jest.requireActual('../src/services/events/notificationInbox').storeForRole,
  listNotifications: jest.fn().mockResolvedValue([
    { notificationKey: 'n1', type: 'booking_created', severity: 'info', title: 'Booking received',
      body: 'Placed.', contextLabel: 'SVN-000007', createdAt: null, readAt: null, isRead: false,
      expiresAt: null, target: 'BOOKING_DETAIL', route: { routeKey: 'BOOKING_DETAILS', resourceId: '7' },
      canOpenDetail: true, canMarkRead: true },
  ]),
  // The counts and the missing/locked keys mirror the legacy service mock above,
  // because the assertions they feed are about ROUTE behaviour and are unchanged
  // by the inbox moving behind one service.
  countUnread: jest.fn().mockResolvedValue(4),
  markRead: jest.fn(async (_actor: any, key: string) => ({
    found: key !== 'missing',
    allowed: key !== 'locked',
    changed: key !== 'missing' && key !== 'locked',
    unreadCount: 4,
  })),
  markAllRead: jest.fn().mockResolvedValue({ unreadCount: 0 }),
  // Same missing/locked keys as markRead, plus `supported` — the third refusal.
  // A store with no dismiss at all answers NOTIFICATION_NOT_ACTIONABLE rather
  // than a fabricated miss, and the route has to keep those apart.
  dismiss: jest.fn(async (_actor: any, key: string) => ({
    found: key !== 'missing',
    allowed: key !== 'locked',
    changed: key !== 'missing' && key !== 'locked',
    supported: key !== 'unsupported',
    unreadCount: 4,
  })),
}));
jest.mock('../src/services/events/notificationPreferences', () => {
  const actual = jest.requireActual('../src/services/events/notificationPreferences');
  return {
    PreferenceError: actual.PreferenceError,
    getPreferences: jest.fn().mockResolvedValue({
      jobAssigned: true, jobReminder: false, paymentReceived: true, newMessage: true,
      promotions: false, requirementReview: true, support: true, accountSecurity: true, system: true,
    }),
    patchPreferences: jest.fn(async (_uid: string, patch: any) => ({
      jobAssigned: true, jobReminder: false, paymentReceived: true, newMessage: true,
      promotions: false, requirementReview: true, support: true, accountSecurity: true,
      system: true, ...patch,
    })),
  };
});
jest.mock('../src/services/events/deviceTokenService', () => ({
  registerDevice: jest.fn(async (_uid: string, token: unknown) =>
    (typeof token === 'string' && token.length >= 10
      ? { registered: true, deviceCount: 2 }
      : { registered: false, deviceCount: 1 })),
  releaseDevice: jest.fn().mockResolvedValue(undefined),
  countDevices: jest.fn().mockResolvedValue(1),
}));

// -- TAB 10 account domain. Mocked for the same reason as every other domain
//    service here: the subject is routing and composition. The account, address
//    and provider-profile services are exercised against a real fake database in
//    their own suites.
jest.mock('../src/services/account/accountService', () => {
  const actual = jest.requireActual('../src/services/account/accountService');
  const account = {
    uid: 'uid-under-test', email: 'a@b.c', phoneNumber: null,
    firstName: 'A', lastName: 'B', displayName: 'A B', photoUrl: null,
    role: 3, accountStatus: 'active', isEmailVerified: true, isPhoneVerified: false,
    profiles: [{ kind: 'customer', endpoint: '/api/v1/customer/profile' }],
  };
  return {
    AccountError: actual.AccountError,
    seatFor: actual.seatFor,
    roleKindOf: actual.roleKindOf,
    getAccount: jest.fn().mockResolvedValue(account),
    patchAccount: jest.fn().mockResolvedValue(account),
    getCustomerProfile: jest.fn().mockResolvedValue({
      uid: 'uid-under-test', birthDate: null, gender: null, photoUrl: null,
      defaultAddressId: 'CAD001', addressCount: 1,
    }),
    patchCustomerProfile: jest.fn().mockResolvedValue({
      uid: 'uid-under-test', birthDate: '1990-01-01', gender: null, photoUrl: null,
      defaultAddressId: 'CAD001', addressCount: 1,
    }),
  };
});
jest.mock('../src/services/account/addressBookService', () => {
  const actual = jest.requireActual('../src/services/account/addressBookService');
  const address = {
    addressId: 'CAD001', label: 'Home', addressOne: '1 Street', addressTwo: null,
    postTown: 'Taytay', zipCode: null, country: 'PH', locationId: null,
    isDefault: true, createdAt: null, coordinates: null,
  };
  return {
    AddressError: actual.AddressError,
    listAddresses: jest.fn().mockResolvedValue([address]),
    getAddress: jest.fn().mockResolvedValue(address),
    createAddress: jest.fn().mockResolvedValue(address),
    updateAddress: jest.fn().mockResolvedValue(address),
    deleteAddress: jest.fn().mockResolvedValue({ deleted: true, promotedAddressId: null }),
    setDefaultAddress: jest.fn().mockResolvedValue(address),
    countAddresses: jest.fn().mockResolvedValue(1),
    countDefaults: jest.fn().mockResolvedValue(1),
  };
});
jest.mock('../src/services/account/providerProfileService', () => {
  const actual = jest.requireActual('../src/services/account/providerProfileService');
  return {
    ProviderProfileError: actual.ProviderProfileError,
    getProviderProfile: jest.fn(async (uid: string, seat: string) => ({
      uid, seat, visibleFields: ['displayName'], fields: { displayName: 'A Provider' },
      verification: {
        accountStatus: seat === 'otherCustomer' ? null : 'active',
        isEmailVerified: true, documentsAccepted: 0, documentsRequired: 0, documentsComplete: false,
      },
    })),
    patchProviderProfile: jest.fn().mockResolvedValue({ submitted: ['biography'], status: 'PENDING_REVIEW' }),
    listDocuments: jest.fn().mockResolvedValue([
      { requirementId: 'missing:valid_id', documentType: 'valid_id', name: 'Valid Government ID',
        category: 'identity', required: true, status: 'missing',
        submittedAt: null, expiresAt: null, reviewNote: null },
    ]),
    getAvailability: jest.fn().mockResolvedValue({
      timezone: 'Asia/Manila', weeklySchedule: [], version: 1, updatedAt: null, hasUsableSchedule: false,
    }),
    listServices: jest.fn().mockResolvedValue([
      { serviceId: 15, name: 'Pimple Facial', status: 'active', isActive: true },
    ]),
    PROVIDER_FIELD_COUNT: actual.PROVIDER_FIELD_COUNT,
  };
});
// The document WRITES live in the compliance service, not in
// providerProfileService. Only the list is served by the latter, which is a
// split that predates v1.
jest.mock('../src/services/providerProfileComplianceService', () => {
  const actual = jest.requireActual('../src/services/providerProfileComplianceService');
  return {
    ...actual,
    uploadDocument: jest.fn().mockResolvedValue({
      requirementId: '5', documentType: 'gov_id', status: 'submitted',
      submittedAt: '2026-08-18T00:00:00.000Z', expiresAt: null, reviewNote: null,
    }),
    getDocumentPreview: jest.fn().mockResolvedValue({
      url: 'https://example.test/signed', expiresAt: '2026-08-18T00:15:00.000Z',
      mimeType: 'image/png',
    }),
    deleteDocument: jest.fn().mockResolvedValue(undefined),
    // TAB 04. `listCertifications` and `getVerificationTimeline` map rows to an
    // array and answer [] against the empty fake, so they are left REAL — the
    // routing is what this suite proves, and a mock there would prove less.
    // These two throw 404/400 on an empty database instead, so they are faked.
    getPublicProfile: jest.fn().mockResolvedValue({
      providerProfileId: 'uid-under-test', displayName: 'Ana R.', photoUrl: null,
      biography: null, skills: [], languages: [], experienceSummary: null,
      publicRating: null, version: 1, pendingRevision: null,
    }),
    submitCertification: jest.fn().mockResolvedValue({
      id: '5', certificationType: 'electrical', issuingAuthority: 'TESDA',
      credentialMask: null, issueDate: null, expiresAt: null, state: 'under_review',
      relatedDocumentId: '1', renewalOfId: null, providerReasonCode: null,
      providerReasonDetail: null, version: 1,
      createdAt: '2026-08-21T00:00:00.000Z', updatedAt: '2026-08-21T00:00:00.000Z',
    }),
  };
});

/**
 * TAB 04. The contact-change flow needs the DECODED token for
 * `assertRecentAuth`, which this suite's fake auth does not mint — and a real
 * `assertRecentAuth` would refuse every request here for want of an `auth_time`.
 *
 * Mocked at the SERVICE, not by removing the check: that the handler passes the
 * decoded token rather than the bare uid is asserted in
 * `tests/provider-contact-change-v1.test.ts`, which is where the precondition
 * belongs. This suite proves routing.
 */
jest.mock('../src/services/providerContactChangeService', () => ({
  __esModule: true,
  requestContactChange: jest.fn().mockResolvedValue({
    requestId: '1', kind: 'email', expiresAt: '2026-08-21T00:15:00.000Z',
  }),
  confirmContactChange: jest.fn().mockResolvedValue({ kind: 'email', confirmed: true }),
  assertRecentAuth: jest.fn(),
}));

jest.mock('../src/services/providerActivationService', () => ({
  __esModule: true,
  acknowledgeProviderPolicy: jest.fn().mockResolvedValue({
    acknowledgedAt: '2026-08-21T00:00:00.000Z', policyVersion: 'v1',
  }),
  previewActivationEligibility: jest.fn().mockResolvedValue('ACTIVE'),
  getActivationRequirements: jest.fn().mockResolvedValue([]),
  refreshActivationEligibility: jest.fn().mockResolvedValue('ACTIVE'),
}));
/**
 * TAB 05. These reach real queries that 404 or 409 against the empty fake, so
 * the routing this suite exists to prove would never be reached. Mocked at the
 * SERVICE — the behaviour they encode (pause is not idempotent, resubmit needs
 * expectedVersion) is asserted in `tests/provider-services-v1.test.ts`.
 */
jest.mock('../src/services/serviceApplicationService', () => ({
  __esModule: true,
  getProviderServicesOverview: jest.fn().mockResolvedValue({ services: [], applications: [] }),
  evaluateApplicationEligibility: jest.fn().mockResolvedValue({
    eligible: true, code: 'ELIGIBLE', message: 'ok', nextAction: 'APPLY',
    service: { id: 7, name: 'Aircon Cleaning', category: null, catalogVersion: 1 },
    applicationId: null, requirementsVersion: 1, requirements: [],
  }),
  getApplicationsByWorker: jest.fn().mockResolvedValue([]),
  getApplicationByWorker: jest.fn().mockResolvedValue({ id: 'app-1', status: 'submitted', version: 1 }),
  submitApplication: jest.fn().mockResolvedValue({ id: 'app-1', status: 'submitted', version: 1 }),
  resubmitApplication: jest.fn().mockResolvedValue({ id: 'app-1', status: 'submitted', version: 2 }),
  cancelApplication: jest.fn().mockResolvedValue({ id: 'app-1', status: 'cancelled', version: 2 }),
}));

/**
 * TAB 06. Presence and safety reach MongoDB, which this suite has no connection
 * to. Mocked at the SERVICE — the behaviour they encode (the location ping
 * cannot flip presence, an incident replay is not an error) is asserted in
 * `tests/provider-presence-safety-v1.test.ts`.
 */
jest.mock('../src/services/providerOperationalAvailabilityService', () => ({
  __esModule: true,
  getStatus: jest.fn().mockResolvedValue({
    availabilityStatus: 'online', availabilitySource: 'provider_explicit',
    changedByUid: null, changedByRole: null, changedAt: null, reason: null,
    version: 1, updatedAt: null,
  }),
  setOnline: jest.fn().mockResolvedValue(undefined),
  setOffline: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/services/providerSafetyService', () => {
  const actual = jest.requireActual('../src/services/providerSafetyService');
  return {
    ...actual,
    submitIncident: jest.fn().mockResolvedValue({
      incidentId: 'inc-1', providerSafeReference: 'SAF-2026-ABCDE',
      state: 'submitted', replayed: false,
    }),
    listIncidents: jest.fn().mockResolvedValue([]),
    recordCheckIn: jest.fn().mockResolvedValue({
      bookingId: '4242', stage: 'arrived', checkedInAt: '2026-08-21T00:00:00.000Z',
    }),
  };
});

/**
 * TAB 07. Evidence, cancellation eligibility and cash settlement all reach the
 * database and object storage. Mocked at the SERVICE — the guarantees they
 * encode (a retried upload returns the original, a customer cannot settle) are
 * asserted in `tests/provider-evidence-cash-v1.test.ts`.
 */
jest.mock('../src/services/booking/providerBookingOwnership', () => ({
  __esModule: true,
  assertOwnBooking: jest.fn().mockResolvedValue('ACCEPTED'),
  loadCancellationContext: jest.fn().mockResolvedValue({
    worker_status: 'ACCEPTED', schedule: '2026-09-01T02:00:00.000Z',
  }),
}));

jest.mock('../src/services/bookingEvidenceService', () => {
  const actual = jest.requireActual('../src/services/bookingEvidenceService');
  return {
    ...actual,
    listEvidence: jest.fn().mockResolvedValue([]),
    removeEvidence: jest.fn().mockResolvedValue(true),
    submitEvidence: jest.fn().mockResolvedValue({
      id: '7', requirementCode: 'BEFORE_PHOTO', stage: 'BEFORE_SERVICE',
      state: 'UPLOADED', mimeType: 'image/png', bytes: 3,
      createdAt: '2026-08-21T00:00:00.000Z', reviewNote: null, replayed: false,
    }),
  };
});

jest.mock('../src/services/paymentService', () => ({
  __esModule: true,
  markCashPaid: jest.fn().mockResolvedValue({
    status: 'PAID', method: 'CASH', paid_at: '2026-08-21T00:00:00.000Z',
  }),
}));

jest.mock('../src/services/providerAutoOnlineEngine', () => ({
  // Fire-and-forget on the upload and delete paths. Mocked so the router suite
  // does not reach the real engine; that it RUNS at all is asserted in
  // `tests/provider-documents-v1.test.ts`, because carrying a side effect into
  // v1 is only worth anything if it happens.
  evaluateProvider: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/services/account/accountSettingsService', () => {
  const actual = jest.requireActual('../src/services/account/accountSettingsService');
  const settings = {
    locale: { locale: 'en-PH', timeZone: 'Asia/Manila' },
    privacy: { profileDiscoverable: true, shareUsageAnalytics: false },
    security: { twoFactorEnabled: false },
    notifications: { endpoint: '/api/v1/me/notification-preferences', categories: { jobAssigned: true } },
  };
  return {
    SettingsError: actual.SettingsError,
    ensureSettingsSchema: jest.fn().mockResolvedValue(undefined),
    getSettings: jest.fn().mockResolvedValue(settings),
    patchSettings: jest.fn().mockResolvedValue(settings),
    getSecurity: jest.fn().mockResolvedValue({
      emailVerified: true, phoneVerified: false, twoFactorEnabled: false,
      passwordUpdatedAt: null, activeDeviceCount: 1, actions: {},
    }),
    __resetSettingsSchema: jest.fn(),
  };
});
// The availability ENGINE, which the canonical PATCH delegates to. Mocked here
// because the subject is routing; the engine has its own suites.
jest.mock('../src/services/providerAvailabilityEngine', () => ({
  getAvailabilityProfile: jest.fn().mockResolvedValue({
    timezone: 'Asia/Manila', weeklySchedule: [], version: 1, updatedAt: null,
  }),
  saveWeeklySchedule: jest.fn().mockResolvedValue({ updatedAt: null, version: 2 }),
  listTimeOff: jest.fn().mockResolvedValue([
    { id: 3, status: 'active', startDate: '2026-09-01', endDate: '2026-09-02',
      allDay: true, startTime: null, endTime: null, reason: 'sick', note: null,
      createdAt: null },
  ]),
  createTimeOff: jest.fn().mockResolvedValue({
    id: 3, startDate: '2026-09-01', endDate: '2026-09-02', allDay: true,
    startTime: null, endTime: null, reason: 'sick', note: null, createdAt: null,
    bookingConflicts: [],
  }),
  cancelTimeOff: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/services/account/profileCompletionService', () => ({
  getCompletion: jest.fn().mockResolvedValue({
    uid: 'uid-under-test', role: 'customer', percent: 75, isComplete: false,
    canProceed: true, satisfied: ['name', 'contact', 'address'], missing: ['photo'],
    blockedBy: [], next: { photo: 'PATCH /api/v1/me' },
  }),
}));

// -- TAB 11 home composition. Mocked for the same reason as every other domain
//    service here: the subject is routing and composition-layer wiring. The
//    composition itself is exercised against a real fake database in
//    `home-composition.test.ts`.
jest.mock('../src/services/home/homeService', () => {
  const actual = jest.requireActual('../src/services/home/homeService');
  return {
    ...actual,
    composeHome: jest.fn(async (_viewer: any, requested?: string[]) => {
      const sections = requested ?? ['categories', 'activeBooking'];
      return {
        sections: sections.map((type: string) => ({
          type, status: 'ok', items: [], reason: 'EMPTY', ttlSeconds: 0,
        })),
        meta: {
          requested: sections,
          unavailable: [],
          personalized: sections.includes('activeBooking'),
          generatedAt: '2026-08-14T00:00:00.000Z',
        },
      };
    }),
    describeSections: jest.fn(() => actual.describeSections()),
  };
});

import v1Router from '../src/api/v1/register';
import { startTestServer, request } from './support/httpTestServer';
import { IMPLEMENTED, PLANNED, fullPath } from '../src/api/v1/contract';

// ─── Harness ──────────────────────────────────────────────────────────────────

let server: http.Server;
let closeServer: () => Promise<void>;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Mounted exactly as app.ts mounts it.
  app.use('/api/v1', v1Router);
  // Shared harness: raised keep-alive plus Connection: close, so the server's
  // 5-second idle timer cannot close a pooled socket under a later request.
  // See tests/support/httpTestServer.ts.
  const started = await startTestServer(app);
  server = started.server;
  base = started.base;
  closeServer = started.close;
});

afterAll(async () => {
  await closeServer();
});

type Call = { status: number; body: any; headers: Headers };

const call = async (
  method: string,
  path: string,
  opts: {
    auth?: boolean;
    role?: 'provider' | 'admin';
    /** The fine-grained admin permission, for routes that carry one. */
    permission?: string;
    body?: unknown;
  } = {},
): Promise<Call> => {
  const headers: Record<string, string> = {};
  if (opts.auth !== false) headers.authorization = 'Bearer test';
  if (opts.role) headers['x-test-role'] = opts.role;
  if (opts.permission) headers['x-test-permission'] = opts.permission;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';

  const res = await request(base, method, path, { headers, body: opts.body });
  return { status: res.status, body: res.body, headers: res.headers };
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
    'health.build': () => call('GET', '/api/v1/health', { auth: false }),
    // AUTHENTICATED, unlike health.build. Build provenance is four fields and
    // exists to be checkable by someone holding no credential; a full API
    // surface is a map, and every client that wants it already has a token.
    'health.contract': () => call('GET', '/api/v1/openapi.json'),
    // auth: false is the assertion, not a convenience. The client this answers
    // may be too old to authenticate — it is the one being recalled.
    'clientConfig.read': () => call('GET', '/api/v1/client-config', { auth: false }),
    // A minimal well-formed batch. The scrubbing is asserted in
    // tests/telemetry-ingest.test.ts; this only proves the route is reachable.
    'telemetry.ingest': () => call('POST', '/api/v1/telemetry', { body: { events: [{ event: 'jobOffered' }] } }),
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
    'notifications.dismiss': () => call('DELETE', '/api/v1/notifications/n1'),
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
    'provider.jobs.cancel': () =>
      call('POST', '/api/v1/provider/jobs/7/cancel', {
        role: 'provider', body: { reason: 'Vehicle broke down', reasonCode: 'TRANSPORT_UNAVAILABLE' },
      }),

    // -- TAB 06 booking experiences --
    'bookings.tracking': () => call('GET', '/api/v1/bookings/7/tracking'),
    'bookings.otp.request': () =>
      call('POST', '/api/v1/bookings/7/otp/request', { body: { purpose: 'BOOKING_CONFIRMATION' } }),
    'bookings.otp.verify': () =>
      call('POST', '/api/v1/bookings/7/otp/verify', { body: { code: '246813' } }),
    'bookings.otp.status': () => call('GET', '/api/v1/bookings/7/otp/status'),
    'bookings.reschedule': () =>
      call('POST', '/api/v1/bookings/7/reschedule', { body: { scheduledAt: '2026-09-01T09:00:00.000Z' } }),
    'bookings.reschedule.history': () => call('GET', '/api/v1/bookings/7/reschedule'),
    // Booking 8 is the one whose caller is the assigned PROVIDER - only they may
    // raise additional work on a job.
    'bookings.additionalWork.create': () =>
      call('POST', '/api/v1/bookings/8/additional-work', {
        role: 'provider', body: { items: [{ quantity: 1, unitPrice: 500 }] },
      }),
    'bookings.additionalWork.list': () => call('GET', '/api/v1/bookings/7/additional-work'),
    'bookings.disputes.open': () =>
      call('POST', '/api/v1/bookings/7/disputes', {
        body: { category: 'SERVICE_QUALITY', reason: 'The work was not finished.' },
      }),
    'bookings.disputes.list': () => call('GET', '/api/v1/bookings/7/disputes'),

    // -- TAB 07 finance --
    'bookings.payments.intent': () => call('POST', '/api/v1/bookings/7/payment-intents', { body: {} }),
    'bookings.payments.get': () => call('GET', '/api/v1/bookings/7/payment'),
    'bookings.refunds.create': () =>
      call('POST', '/api/v1/bookings/7/refunds', { body: { trigger: 'CUSTOMER_CANCELLED' } }),
    'provider.earnings.summary': () =>
      call('GET', '/api/v1/provider/earnings/summary', { role: 'provider' }),
    'provider.earnings.transactions': () =>
      call('GET', '/api/v1/provider/earnings/transactions', { role: 'provider' }),
    'provider.earnings.payouts': () =>
      call('GET', '/api/v1/provider/earnings/payouts', { role: 'provider' }),
    'admin.finance.reconciliation': () =>
      call('GET', '/api/v1/admin/finance/reconciliation', {
        role: 'admin', permission: 'reconciliation.view',
      }),

    // -- TAB 06 wave 1: the v1 admin booking domain --
    //
    // Each carries the SAME named permission its legacy twin demands. Passing
    // the permission header here is not a convenience: it is what proves the
    // route actually consults one, because omitting it must 403.
    'admin.bookings.list': () =>
      call('GET', '/api/v1/admin/bookings', {
        role: 'admin', permission: 'bookings.view',
      }),
    'admin.bookings.assignmentCandidates': () =>
      call('GET', '/api/v1/admin/bookings/7/assignment-candidates', {
        role: 'admin', permission: 'bookings.assign_provider',
      }),
    'admin.bookings.assign': () =>
      call('POST', '/api/v1/admin/bookings/7/assign', {
        role: 'admin', permission: 'bookings.assign_provider',
        body: { providerUid: 'provider-under-test' },
      }),
    'admin.bookings.reassign': () =>
      call('POST', '/api/v1/admin/bookings/7/reassign', {
        role: 'admin', permission: 'bookings.reassign_provider',
        body: { toProviderUid: 'provider-under-test', reason: 'operator override' },
      }),

    // -- refund lifecycle --
    'admin.refunds.markFailed': () =>
      call('POST', '/api/v1/admin/refunds/7/mark-failed', {
        role: 'admin', permission: 'refunds.mark_failed',
        body: { failureReason: 'gcash wallet closed' },
      }),

    // -- TAB 08 messaging --
    'conversations.create': () => call('POST', '/api/v1/conversations', { body: { bookingId: 7 } }),
    'conversations.list': () => call('GET', '/api/v1/conversations'),
    'conversations.get': () => call('GET', '/api/v1/conversations/11'),
    'conversations.messages.list': () => call('GET', '/api/v1/conversations/11/messages'),
    'conversations.messages.create': () =>
      call('POST', '/api/v1/conversations/11/messages', {
        body: { body: 'hi', clientMsgId: 'client-message-id-0001' },
      }),
    'conversations.attachments.create': () =>
      call('POST', '/api/v1/conversations/7/attachments', {
        body: { file: 'data:image/png;base64,iVBORw0KGgo=', name: 'shot.png' },
      }),
    'conversations.messages.report': () =>
      call('POST', '/api/v1/conversations/7/messages/11/report', {
        body: { category: 'harassment' },
      }),
    'conversations.read': () =>
      call('POST', '/api/v1/conversations/11/read', { body: { lastReadMessageId: 42 } }),

    // -- TAB 09 notifications --
    'me.notificationPreferences.get': () => call('GET', '/api/v1/me/notification-preferences'),
    'me.notificationPreferences.patch': () =>
      call('PATCH', '/api/v1/me/notification-preferences', { body: { promotions: true } }),
    'me.devices.register': () =>
      call('POST', '/api/v1/me/devices', { body: { token: 'a-device-token-value', platform: 'ios' } }),
    'me.devices.release': () => call('DELETE', '/api/v1/me/devices', { body: {} }),

    // -- TAB 10 account domain --
    'me.patch': () => call('PATCH', '/api/v1/me', { body: { firstName: 'A' } }),
    'me.settings.get': () => call('GET', '/api/v1/me/settings'),
    'me.settings.patch': () => call('PATCH', '/api/v1/me/settings', { body: { locale: 'en-PH' } }),
    'me.security.get': () => call('GET', '/api/v1/me/security'),
    'me.completion.get': () => call('GET', '/api/v1/me/completion'),
    'customer.profile.get': () => call('GET', '/api/v1/customer/profile'),
    'customer.profile.patch': () =>
      call('PATCH', '/api/v1/customer/profile', { body: { birthDate: '1990-01-01' } }),
    'customer.addresses.list': () => call('GET', '/api/v1/customer/addresses'),
    'customer.addresses.create': () =>
      call('POST', '/api/v1/customer/addresses', { body: { addressOne: '1 Street' } }),
    'customer.addresses.update': () =>
      call('PATCH', '/api/v1/customer/addresses/CAD001', { body: { label: 'Home' } }),
    'customer.addresses.delete': () => call('DELETE', '/api/v1/customer/addresses/CAD001'),
    'customer.addresses.setDefault': () =>
      call('POST', '/api/v1/customer/addresses/CAD001/default', { body: {} }),
    'provider.profile.get': () => call('GET', '/api/v1/provider/profile', { role: 'provider' }),
    'provider.activation.get': () =>
      call('GET', '/api/v1/provider/activation', { role: 'provider' }),
    'provider.services.overview': () =>
      call('GET', '/api/v1/provider/services/overview', { role: 'provider' }),
    'provider.presence.get': () =>
      call('GET', '/api/v1/provider/presence', { role: 'provider' }),
    'provider.jobs.evidence.list': () =>
      call('GET', '/api/v1/provider/jobs/4242/evidence', { role: 'provider' }),
    'provider.jobs.evidence.create': () =>
      call('POST', '/api/v1/provider/jobs/4242/evidence', {
        role: 'provider',
        body: {
          requirementCode: 'BEFORE_PHOTO',
          file: 'data:image/png;base64,AAAA',
          clientRequestId: 'client-request-id-000001',
        },
      }),
    'provider.jobs.evidence.delete': () =>
      call('DELETE', '/api/v1/provider/jobs/4242/evidence/7', { role: 'provider' }),
    'provider.jobs.cancellationEligibility': () =>
      call('GET', '/api/v1/provider/jobs/4242/cancellation-eligibility', { role: 'provider' }),
    'bookings.payments.cashCollected': () =>
      // Booking 8 is the fixture whose caller is the PROVIDER. Any other id
      // resolves to 'customer', and this route refuses a customer — which is
      // the authorization working, not a fixture problem.
      call('POST', '/api/v1/bookings/8/cash-collected', { role: 'provider' }),
    'provider.presence.goOnline': () =>
      call('POST', '/api/v1/provider/presence/online', {
        role: 'provider', body: { latitude: 14.5547, longitude: 121.0245 },
      }),
    'provider.presence.goOffline': () =>
      call('POST', '/api/v1/provider/presence/offline', { role: 'provider' }),
    'provider.location.report': () =>
      call('POST', '/api/v1/provider/location', {
        role: 'provider', body: { latitude: 14.5547, longitude: 121.0245 },
      }),
    'provider.safety.emergencyConfig': () =>
      call('GET', '/api/v1/provider/safety/emergency-config', { role: 'provider' }),
    'provider.safety.checkIn': () =>
      call('POST', '/api/v1/provider/safety/check-in', {
        role: 'provider', body: { bookingId: '4242', stage: 'arrived' },
      }),
    'provider.safety.incidents.list': () =>
      call('GET', '/api/v1/provider/safety/incidents', { role: 'provider' }),
    'provider.safety.incidents.create': () =>
      call('POST', '/api/v1/provider/safety/incidents', {
        role: 'provider',
        body: {
          clientIncidentId: 'inc-client-0001',
          category: 'aggression',
          severity: 'level_2',
          description: 'Customer became aggressive on arrival.',
        },
      }),
    'provider.services.eligibility': () =>
      call('GET', '/api/v1/provider/services/7/eligibility', { role: 'provider' }),
    'provider.services.pause': () =>
      call('PATCH', '/api/v1/provider/services/7/pause', { role: 'provider', body: { reason: 'Away' } }),
    'provider.services.reactivate': () =>
      call('PATCH', '/api/v1/provider/services/7/reactivate', { role: 'provider' }),
    'provider.serviceApplications.list': () =>
      call('GET', '/api/v1/provider/service-applications', { role: 'provider' }),
    'provider.serviceApplications.get': () =>
      call('GET', '/api/v1/provider/service-applications/app-1', { role: 'provider' }),
    'provider.serviceApplications.create': () =>
      call('POST', '/api/v1/provider/service-applications', {
        role: 'provider',
        body: { serviceId: 7, requirementsVersion: 1, clientRequestId: 'client-request-id-000001' },
      }),
    'provider.serviceApplications.resubmit': () =>
      call('POST', '/api/v1/provider/service-applications/app-1/resubmit', {
        role: 'provider',
        body: { expectedVersion: 1, clientRequestId: 'client-request-id-000001' },
      }),
    'provider.serviceApplications.withdraw': () =>
      call('DELETE', '/api/v1/provider/service-applications/app-1', { role: 'provider' }),
    'provider.activation.acknowledgePolicy': () =>
      call('POST', '/api/v1/provider/activation/policy-acknowledgement', {
        role: 'provider',
        body: { policyVersion: 'v1' },
      }),
    'provider.fieldRegistry.get': () =>
      call('GET', '/api/v1/provider/profile-fields', { role: 'provider' }),
    'provider.publicProfile.preview': () =>
      call('GET', '/api/v1/provider/public-profile', { role: 'provider' }),
    'provider.certifications.list': () =>
      call('GET', '/api/v1/provider/certifications', { role: 'provider' }),
    'provider.certifications.create': () =>
      call('POST', '/api/v1/provider/certifications', {
        role: 'provider',
        body: {
          certificationType: 'electrical',
          issuingAuthority: 'TESDA',
          relatedDocumentId: 1,
          clientRequestId: 'client-request-id-000001',
        },
      }),
    'provider.verificationTimeline.get': () =>
      call('GET', '/api/v1/provider/verification-timeline', { role: 'provider' }),
    'provider.contactChanges.request': () =>
      call('POST', '/api/v1/provider/contact-changes', {
        role: 'provider',
        body: { kind: 'email', target: 'new@example.com', clientRequestId: 'client-request-id-000001' },
      }),
    'provider.contactChanges.confirm': () =>
      call('POST', '/api/v1/provider/contact-changes/confirm', {
        role: 'provider',
        body: { requestId: '1', code: '123456' },
      }),
    'provider.profile.patch': () =>
      call('PATCH', '/api/v1/provider/profile', {
        role: 'provider',
        body: { clientRequestId: 'client-request-id-000001', biography: 'Hello.' },
      }),
    'provider.publicProfile.get': () => call('GET', '/api/v1/providers/provider-uid-1/profile'),
    'provider.documents.list': () => call('GET', '/api/v1/provider/documents', { role: 'provider' }),
    'provider.documents.types': () =>
      call('GET', '/api/v1/provider/document-types', { role: 'provider' }),
    'provider.documents.create': () =>
      call('POST', '/api/v1/provider/documents', {
        role: 'provider',
        body: {
          documentTypeId: 'gov_id', fileName: 'id.png',
          file: 'data:image/png;base64,iVBORw0KGgo=', clientRequestId: 'req-1',
        },
      }),
    'provider.documents.preview': () =>
      call('GET', '/api/v1/provider/documents/5/preview', { role: 'provider' }),
    'provider.documents.delete': () =>
      call('DELETE', '/api/v1/provider/documents/5', { role: 'provider' }),
    'provider.availability.get': () => call('GET', '/api/v1/provider/availability', { role: 'provider' }),
    'provider.availability.patch': () =>
      call('PATCH', '/api/v1/provider/availability', { role: 'provider', body: { slots: [] } }),
    'provider.timeOff.list': () =>
      call('GET', '/api/v1/provider/time-off', { role: 'provider' }),
    'provider.timeOff.create': () =>
      call('POST', '/api/v1/provider/time-off', {
        role: 'provider',
        body: { startDate: '2026-09-01', endDate: '2026-09-02', reason: 'sick' },
      }),
    'provider.timeOff.cancel': () =>
      call('DELETE', '/api/v1/provider/time-off/3', { role: 'provider' }),
    'provider.services.list': () => call('GET', '/api/v1/provider/services', { role: 'provider' }),

    // -- TAB 11 home composition --
    'home.feed': () => call('GET', '/api/v1/home'),
    'home.sections': () => call('GET', '/api/v1/home/sections'),

    // -- TAB 12 post-service trust --
    'bookings.review.create': () =>
      call('POST', '/api/v1/bookings/7/review', {
        body: { overallRating: 5, publicComment: 'Great work.' },
      }),
    'bookings.review.get': () => call('GET', '/api/v1/bookings/7/review'),
    'bookings.supportCases.create': () =>
      call('POST', '/api/v1/bookings/7/support-cases', {
        body: { category: 'SERVICE_QUALITY', summary: 'The work was unfinished.' },
      }),
    'bookings.supportCases.list': () => call('GET', '/api/v1/bookings/7/support-cases'),
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
      // TAB 08: the contract digest rides on EVERY v1 response, so a client
      // detects a stale pin with one cheap request and no parsing — rather than
      // fetching 330 kB of document to learn whether it needed to.
      expect(res.headers.get('x-contract-sha256')).toMatch(/^[0-9a-f]{64}$/);
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
  // TAB 07 mounted the first implemented `admin` entry. The totals assertion
  // below is what forced this set to be added rather than letting a new auth
  // mode ship unexercised.
  const ADMIN = IMPLEMENTED.filter((e) => e.auth === 'admin');

  it('every entry falls into a mode this suite exercises', () => {
    expect(PUBLIC.length + AUTHED.length + PROVIDER.length + ADMIN.length).toBe(IMPLEMENTED.length);
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

  it.each(ADMIN.map((e) => [e.id, e.method.toUpperCase(), fullPath(e)]))(
    '%s — %s %s refuses a signed-in non-admin',
    async (_id, method, path) => {
      const concrete = String(path).replace(/:(\w+)/g, '7');
      // A PROVIDER token, not merely an anonymous one: the interesting failure
      // is an admin route that any authenticated caller can reach, and an
      // anonymous request would be refused by verifyAuth before the role check.
      const res = await call(String(method), concrete, { role: 'provider' });
      expect(res.status).toBe(403);
    },
  );

  /**
   * Role 1 is not the whole of the admin authorization model.
   *
   * The legacy admin finance routes gate on a named permission as well as the
   * role, and a v1 successor that dropped it would be a QUIETER route to the
   * same data — privilege escalation by migration. `V1_PERMISSIONS` in
   * `register.ts` carries the mapping; this proves it is mounted.
   */
  it('admin.finance.reconciliation refuses an admin without reconciliation.view', async () => {
    const res = await call('GET', '/api/v1/admin/finance/reconciliation', { role: 'admin' });
    expect(res.status).toBe(403);
  });

  it('admin.finance.reconciliation answers an admin who holds it', async () => {
    const res = await call('GET', '/api/v1/admin/finance/reconciliation', {
      role: 'admin', permission: 'reconciliation.view',
    });
    expect(res.status).toBe(200);
  });
});

// ─── Planned entries are documented, not mounted ──────────────────────────────

describe('planned entries are not reachable', () => {
  /**
   * TAB 06 wave 1 emptied the backlog: the four `admin.bookings.*` entries were
   * the last `planned` ones and are now implemented.
   *
   * `it.each([])` is a Jest error rather than a vacuous pass, which is the right
   * default — but here an empty backlog is the desired state, not a missing
   * fixture. The rule itself is asserted at build time in
   * `tests/v1-contract.test.ts`: supplying a handler for an entry that is not
   * implemented throws, so an endpoint cannot half-ship as a documented 404.
   */
  if (!PLANNED.length) {
    it('the backlog is empty — every documented entry is built', () => {
      expect(PLANNED).toEqual([]);
    });
    return;
  }

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
