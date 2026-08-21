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
 * what the scoping predicate is, so `tests/route-health-and-authz.test.ts` can
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
 * Asserted against `register.ts`'s `authChain` by
 * `tests/authz-matrix-behaviour.test.ts`, which EXECUTES the real chain for
 * every mode x role and compares the outcome to this table.
 *
 * That check did not exist until it was noticed missing. This comment used to
 * claim it did, while the only checks were a source-text regex and a presence
 * check — so widening `verifyRoles([1])` to `verifyRoles([1, 4])` would have
 * left SECURITY_AUTHZ_MATRIX.md publishing `provider: deny` with nothing
 * failing. Role 4 is a provider role, so that edit is plausible, not contrived.
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
  /**
   * `provider-support` — the provider's OWN cases and the reviews naming them.
   *
   * Two object families share this domain and one rule covers both because they
   * are scoped identically: every service function takes the caller uid as its
   * FIRST argument and puts it in the WHERE clause beside the object id. A case
   * id or a review id belonging to somebody else matches no row.
   *
   * That ordering matters more than it looks. Passing the id alone and comparing
   * ownership afterwards would be a check somebody can forget to make; passing
   * both into one statement is a scope that cannot be forgotten because there is
   * no query without it.
   *
   * The v1 handlers additionally refuse a malformed id BEFORE any query, and
   * they refuse it as NOT_FOUND rather than VALIDATION_FAILED — telling a caller
   * which ids are well-formed is half of telling them which ones exist.
   */
  {
    domain: 'provider-support',
    parameter: 'caseId | reviewId',
    predicate: 'provider_uid = $1 AND id = $2 (the caller uid is the FIRST argument to every service function)',
    enforcedBy: 'services/providerSupportCaseService + services/providerReputationService',
    provenBy: 'tests/provider-support-reviews-v1.test.ts',
    refusal: '404 NOT_FOUND',
    distinguishesAbsentFromForbidden: false,
  },

  /**
   * `admin-bookings` — and the honest answer is that there is NO ownership
   * relationship (TAB 06).
   *
   * The other rules in this list scope an object to a person: the customer who
   * booked it, the provider assigned to it. An admin is neither. Authority here
   * comes from role 1 plus a named permission, which is a different kind of
   * claim entirely — not "this is yours" but "you are allowed to act on anyone's".
   *
   * §145 still requires the rule to exist, and it is right to. An endpoint that
   * addresses `:bookingId` and declares nothing is indistinguishable, to every
   * later reader and to `safetyDrift()`, from one whose ownership check was
   * simply forgotten. Saying "none, and here is what replaces it" is the
   * difference between a considered exemption and an omission.
   *
   * `distinguishesAbsentFromForbidden: false` is TRUE here, and for a reason
   * worth stating rather than inheriting: `requirePermission` runs BEFORE the
   * handler reads anything, so an admin lacking the permission gets 403 whether
   * the booking exists or not. There is no oracle because the object is never
   * consulted. That is a stronger position than the 404-for-everything the
   * relationship-scoped rules rely on.
   */
  {
    domain: 'admin-bookings',
    parameter: 'bookingId',
    predicate:
      'none — an admin is not scoped to a booking by relationship. Authority is role 1 ' +
      'plus the named permission on the contract entry (bookings.view, ' +
      'bookings.assign_provider, bookings.reassign_provider), mounted by ' +
      'api/v1/register from ContractEntry.permission.',
    enforcedBy: 'middleware/requirePermission',
    provenBy:
      'tests/v1-admin-permission-parity.test.ts, tests/v1-router.test.ts, tests/authz-parity.test.ts',
    refusal:
      '403 PERMISSION_REQUIRED, decided before the booking is read — so it is identical ' +
      'for a booking that does not exist',
    distinguishesAbsentFromForbidden: false,
  },
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
