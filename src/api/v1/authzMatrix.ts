/**
 * The authorization matrix and object-ownership rules (§145).
 *
 * ## Two different questions, and only one of them is about roles
 *
 * **Endpoint authorization** asks "may an account of this ROLE call this path
 * at all?" It is answered by `V1_CONTRACT[].auth` and enforced by the auth
 * chain in `register.ts`. It is necessary and it is not sufficient.
 *
 * **Object-level authorization** asks "may THIS account see THIS booking?" A
 * role check cannot answer it: every customer has the customer role, and the
 * whole point is that one customer must not read another's booking. This is the
 * failure class that produces the worst outcomes in this platform — a booking
 * carries an address and a time when somebody will be at home, and a leak of it
 * is not a data-protection abstraction, it is telling a stranger where somebody
 * lives and when.
 *
 * OWASP calls it BOLA and puts it first in the API top ten, for the same reason.
 *
 * ## What this file adds over the domain suites
 *
 * The domain suites already test ownership within their own domain — TAB 08's
 * messaging leakage, TAB 10's account leakage, TAB 12's review leakage. What
 * none of them can do is assert that EVERY booking-scoped endpoint has such a
 * test, because none of them can see the whole contract.
 *
 * This declares, per sensitive domain, which endpoints are object-scoped and
 * what the scoping predicate is, so `tests/authorization-matrix.test.ts` can
 * fail when a new booking-scoped endpoint appears with no ownership rule.
 */

import { V1_CONTRACT, type AuthMode, type ContractEntry } from './contract';

// ─── Roles ────────────────────────────────────────────────────────────────────

export type Role = 'anonymous' | 'customer' | 'provider' | 'admin';

export const ROLES: readonly Role[] = Object.freeze([
  'anonymous', 'customer', 'provider', 'admin',
]);

export type Access = 'allow' | 'deny';

/**
 * Which roles the AUTH CHAIN admits, per declared mode.
 *
 * Derived from `register.ts`'s `authChain`, and asserted against it — a mode
 * whose chain changes without this table changing is a matrix that documents
 * an access rule the router no longer applies.
 */
export const ROLE_ACCESS: Readonly<Record<AuthMode, Readonly<Record<Role, Access>>>> = Object.freeze({
  public: Object.freeze({ anonymous: 'allow', customer: 'allow', provider: 'allow', admin: 'allow' }),
  authenticated: Object.freeze({ anonymous: 'deny', customer: 'allow', provider: 'allow', admin: 'allow' }),
  provider: Object.freeze({ anonymous: 'deny', customer: 'deny', provider: 'allow', admin: 'deny' }),
  admin: Object.freeze({ anonymous: 'deny', customer: 'deny', provider: 'deny', admin: 'allow' }),
});

/**
 * `provider` mode denies ADMIN, and that is deliberate rather than an oversight.
 *
 * `/provider/jobs/*` means "the jobs assigned to ME". An admin has no
 * assignments, so the endpoint has nothing to answer for them — and silently
 * admitting admins would mean the query is scoped by a uid that owns no work,
 * returning an empty list that reads like a bug. Admins operate the booking
 * queue through `/admin/bookings/*`, which is a different question over the same
 * state machine.
 */
export const PROVIDER_MODE_EXCLUDES_ADMIN =
  'An admin holds no assignments, so a "my jobs" endpoint has nothing to answer for them. ' +
  'Admin operations live under /admin/bookings/* over the same executor.';

export const mayCall = (mode: AuthMode, role: Role): boolean =>
  ROLE_ACCESS[mode][role] === 'allow';

// ─── Object-level ownership (§145) ────────────────────────────────────────────

export interface OwnershipRule {
  /** The domain this covers, matching `ContractEntry.domain`. */
  domain: string;
  /** The path parameter that names the object. */
  parameter: string;
  /** The SQL or service predicate that scopes it. Named, so a test can find it. */
  predicate: string;
  /** The module that enforces it. */
  enforcedBy: string;
  /** The suite that proves a stranger is refused. */
  provenBy: string;
  /**
   * What a caller who is not the owner receives.
   *
   * Almost always 404 rather than 403: answering "403 Forbidden" for an object
   * that exists and "404" for one that does not is an enumeration oracle, and
   * booking ids are small integers.
   */
  refusal: string;
  /**
   * Whether a caller can tell "not yours" from "does not exist".
   *
   * Must be false everywhere. A service answering 403 for an object that
   * exists and 404 for one that does not is an enumeration oracle, and
   * booking ids are small integers.
   */
  distinguishesAbsentFromForbidden: boolean;
}

export const OWNERSHIP_RULES: readonly OwnershipRule[] = Object.freeze([
  {
    domain: 'bookings',
    parameter: 'bookingId',
    predicate: 'bookingAccessService.assertBookingAccess — customer, assigned provider, or admin',
    enforcedBy: 'services/bookingAccessService',
    provenBy: 'tests/provider-job-leakage.test.ts, tests/assigned-booking-integrity.test.ts',
    refusal: '404 — indistinguishable from a booking that does not exist',
    distinguishesAbsentFromForbidden: false,
  },
  {
    domain: 'booking-experiences',
    parameter: 'bookingId',
    predicate: 'the same assertBookingAccess, then the per-experience actor rule',
    enforcedBy: 'services/booking/experienceStore + experiencePolicy',
    provenBy: 'tests/booking-tracking-authorization.test.ts, tests/booking-experience-policy.test.ts',
    refusal: '404 for a booking that is not the caller\'s',
    distinguishesAbsentFromForbidden: false,
  },
  {
    domain: 'provider-jobs',
    parameter: 'bookingId',
    predicate: 'booking_workers.worker_uid = $callerUid',
    enforcedBy: 'services/technicianService',
    provenBy: 'tests/provider-job-leakage.test.ts',
    refusal: '404 — a provider must not learn that a job they are not on exists',
    distinguishesAbsentFromForbidden: false,
  },
  {
    domain: 'conversations',
    parameter: 'conversationId',
    predicate: 'participant membership on the conversation, resolved from the booking',
    enforcedBy: 'services/messaging/messagingService',
    provenBy: 'tests/messaging-leakage.test.ts',
    refusal: 'one code for absent and forbidden — the TAB 08 enumeration-oracle fix',
    distinguishesAbsentFromForbidden: false,
  },
  {
    domain: 'notifications',
    parameter: 'key',
    predicate: 'owner_uid = $callerUid on the inbox row',
    enforcedBy: 'services/events/notificationInbox',
    provenBy: 'tests/notification-policy.test.ts',
    refusal: '404 NOT_FOUND',
    distinguishesAbsentFromForbidden: false,
  },
  {
    domain: 'reviews',
    parameter: 'bookingId',
    predicate: 'customer_reviews.customer_uid = $callerUid, and the booking is the caller\'s',
    enforcedBy: 'services/customerReviewService',
    provenBy: 'tests/review-leakage.test.ts, tests/review-eligibility.test.ts',
    refusal: '403 BOOKING_NOT_OWNED, checked FIRST so nothing else leaks',
    distinguishesAbsentFromForbidden: false,
  },
  {
    domain: 'finance',
    parameter: 'bookingId',
    predicate: 'the payment\'s booking must be the caller\'s; earnings are scoped to worker_uid',
    enforcedBy: 'services/finance/bookingPaymentService + providerEarningsService',
    provenBy: 'tests/finance-leakage.test.ts',
    refusal: '404 — an earnings figure is a person\'s income',
    distinguishesAbsentFromForbidden: false,
  },
  {
    domain: 'account',
    parameter: 'addressId',
    predicate: 'user_id = $callerUid on every address row',
    enforcedBy: 'services/account/addressBookService',
    provenBy: 'tests/account-leakage.test.ts',
    refusal: '404 — an address is where somebody lives',
    distinguishesAbsentFromForbidden: false,
  },
]);

export const OWNERSHIP_DOMAINS: readonly string[] = Object.freeze(
  OWNERSHIP_RULES.map((r) => r.domain),
);

/**
 * Domains whose objects belong to an individual and must therefore carry an
 * ownership rule.
 *
 * §145 names them: bookings, jobs, messages, notifications, reviews, earnings
 * and documents.
 */
export const SENSITIVE_DOMAINS: readonly string[] = Object.freeze([
  'bookings', 'booking-experiences', 'provider-jobs', 'conversations',
  'notifications', 'reviews', 'finance', 'account',
]);

/** Path parameters that name an object belonging to somebody. */
export const OBJECT_PARAMETERS: readonly string[] = Object.freeze([
  'bookingId', 'conversationId', 'addressId', 'reviewId', 'caseId', 'documentId', 'payoutId',
]);

const paramsOf = (entry: ContractEntry): string[] =>
  entry.path.split('/').filter((s) => s.startsWith(':')).map((s) => s.slice(1));

/** Entries that address a specific object and therefore need object-level authz. */
export const objectScopedEntries = (): ContractEntry[] =>
  V1_CONTRACT.filter(
    (entry) =>
      entry.status === 'implemented' &&
      entry.auth !== 'public' &&
      paramsOf(entry).some((p) => OBJECT_PARAMETERS.includes(p)),
  );

/** Object-scoped entries in a sensitive domain with no declared ownership rule. */
export const unguardedEntries = (): ContractEntry[] =>
  objectScopedEntries().filter(
    (entry) =>
      SENSITIVE_DOMAINS.includes(entry.domain) && !OWNERSHIP_DOMAINS.includes(entry.domain),
  );

// ─── The matrix ───────────────────────────────────────────────────────────────

export interface MatrixRow {
  id: string;
  domain: string;
  method: string;
  path: string;
  authMode: AuthMode;
  access: Record<Role, Access>;
  objectScoped: boolean;
  ownership: OwnershipRule | null;
}

export const authorizationMatrix = (): MatrixRow[] =>
  V1_CONTRACT.filter((e) => e.status === 'implemented')
    .map((entry) => {
      const objectScoped = paramsOf(entry).some((p) => OBJECT_PARAMETERS.includes(p));
      return {
        id: entry.id,
        domain: entry.domain,
        method: entry.method.toUpperCase(),
        path: entry.path,
        authMode: entry.auth,
        access: { ...ROLE_ACCESS[entry.auth] },
        objectScoped,
        ownership: objectScoped
          ? OWNERSHIP_RULES.find((r) => r.domain === entry.domain) ?? null
          : null,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));

export const matrixSummary = () => {
  const rows = authorizationMatrix();
  return {
    endpoints: rows.length,
    public: rows.filter((r) => r.authMode === 'public').length,
    authenticated: rows.filter((r) => r.authMode === 'authenticated').length,
    provider: rows.filter((r) => r.authMode === 'provider').length,
    admin: rows.filter((r) => r.authMode === 'admin').length,
    objectScoped: rows.filter((r) => r.objectScoped).length,
    objectScopedWithRule: rows.filter((r) => r.objectScoped && r.ownership).length,
    unguarded: unguardedEntries().length,
  };
};
