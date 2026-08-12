/**
 * THE canonical v1 API contract — one source of truth, four consumers.
 *
 *   1. `register.ts`  mounts the routers FROM this array.
 *   2. `openapi.ts`   generates the OpenAPI document FROM this array.
 *   3. `scripts/generate-api-docs.ts` writes API_ENDPOINT_REGISTRY.md and
 *      LEGACY_ENDPOINT_MIGRATION_MATRIX.md FROM this array.
 *   4. `tests/v1-contract.test.ts` asserts all four agree.
 *
 * Drift between documentation and implementation is the normal failure mode of
 * an API registry: the doc is written once, the routes move, and the doc
 * becomes a confident lie. Here the doc is not written, it is derived — and the
 * router is derived from the same array, so a path can only appear in the docs
 * if it is actually mounted, and can only be mounted if it is documented.
 *
 * ## Adding an endpoint
 *
 * Add the entry, add the handler to the domain module, export it under the same
 * `id`. `register.ts` throws at import time if an implemented entry has no
 * handler or a handler has no entry, so a half-finished endpoint fails the
 * build rather than shipping as a 404 nobody notices.
 *
 * ## `status: 'planned'`
 *
 * A planned entry is documented and NOT mounted. It exists so the migration
 * matrix can name the canonical successor of a legacy route before that
 * successor is built, which is what makes the matrix useful to a client team
 * planning their own release. A planned entry with a handler is an error, and
 * so is a planned entry that any test asserts is reachable.
 */

import { V1ErrorCode } from './errors';

export const V1_PREFIX = '/api/v1';

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** Who may call an endpoint. Enforced by `register.ts`, not by convention. */
export type AuthMode =
  /** No token. Reserved for genuinely public product data. */
  | 'public'
  /** Any verified Firebase identity. */
  | 'authenticated'
  /** Verified identity whose role is a provider role (2 or 4 — see servana_role_map). */
  | 'provider'
  /** Verified identity with role 1. */
  | 'admin';

export type Disposition =
  /** Stays as-is. Not a duplicate of anything canonical. */
  | 'KEEP'
  /** A canonical v1 successor exists; this path stays until callers migrate. */
  | 'ALIAS_TEMPORARILY'
  /** Should become the canonical v1 route; no v1 successor built yet. */
  | 'CANONICALIZE'
  /** Legitimately role-specific: different auth/action/payload, same domain service. */
  | 'ROLE_SPECIFIC'
  /** Has no caller and no successor. Delete once telemetry confirms zero traffic. */
  | 'RETIRE';

export type ClientName =
  | 'customerMobile'
  | 'customerWeb'
  | 'providerMobile'
  | 'providerWeb'
  | 'admin';

export type CallerState =
  /** This client calls the canonical v1 route today. */
  | 'migrated'
  /** This client calls a legacy route that this entry supersedes. */
  | 'legacy'
  /** This client will migrate; it does not call any equivalent today. */
  | 'planned'
  /** This capability does not apply to this client. */
  | 'n/a';

export interface LegacyMapping {
  method: HttpMethod;
  /** Full path including the /api prefix, as mounted today. */
  path: string;
  disposition: Disposition;
  /** Why it is not simply deleted. Required for anything not RETIRE. */
  note: string;
}

export interface ContractEntry {
  /** Stable handler key. Never reused, never renamed. */
  id: string;
  domain: string;
  method: HttpMethod;
  /** Path WITHOUT the /api/v1 prefix. Express param syntax. */
  path: string;
  summary: string;
  auth: AuthMode;
  /**
   * `true` when a repeat of the identical request produces the identical
   * end state. GETs are idempotent by definition; a mutation must say so
   * explicitly.
   */
  idempotent: boolean;
  /**
   * REQUIRED when `idempotent` is false: what stops a replay doing damage.
   *
   * Not every mutation can be made idempotent, and pretending otherwise by
   * bolting an Idempotency-Key onto a credential exchange would be theatre. But
   * "this one is not idempotent" cannot be the end of the sentence either —
   * something has to bound the replay, and if nobody can name it there is
   * nothing there. `tests/v1-contract.test.ts` fails on a non-idempotent entry
   * with no guard named, so a new one cannot slip in unexamined.
   */
  replayGuard?: string;
  /** Name of the response DTO in `openapi.ts`'s component schemas. */
  responseSchema: string;
  /** Every failure code this endpoint can return, beyond the auth defaults. */
  errors: V1ErrorCode[];
  /** Query parameters, for OpenAPI and for the validation contract. */
  query?: Array<{ name: string; type: 'string' | 'integer'; required: boolean; description: string }>;
  params?: Array<{ name: string; type: 'string' | 'integer'; description: string }>;
  requestSchema?: string;
  /** 'implemented' entries are mounted. 'planned' entries are documented only. */
  status: 'implemented' | 'planned';
  /**
   * The domain service(s) this endpoint delegates to. This is the field that
   * makes the "one canonical domain service behind all clients" rule checkable:
   * if a legacy route and its v1 successor name different services, they are
   * two business truths wearing one name.
   */
  domainService: string;
  legacy: LegacyMapping[];
  callers: Record<ClientName, CallerState>;
  /** Who is paged when this endpoint's error rate moves. */
  observability: string;
  notes?: string;
}

const ALL_PLANNED: Record<ClientName, CallerState> = {
  customerMobile: 'planned',
  customerWeb: 'planned',
  providerMobile: 'planned',
  providerWeb: 'planned',
  admin: 'planned',
};

export const V1_CONTRACT: ContractEntry[] = [
  // ───────────────────────────────────────────────────────────────────────────
  // Catalog — Category → Subcategory → Service, keyed on services.id
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'catalog.browse',
    domain: 'catalog',
    method: 'get',
    path: '/catalog',
    summary: 'The full public catalog tree: categories, their subcategories and their services.',
    auth: 'public',
    idempotent: true,
    responseSchema: 'CatalogTree',
    errors: [],
    status: 'implemented',
    domainService: 'services/catalogPublicService.getPublicCatalog + getPublicCatalogSummary',
    legacy: [
      {
        method: 'get',
        path: '/api/catalog',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'Shadowed by booking.routes GET /:id until this command reordered the mounts. ' +
          'Never deployed, has no installed caller, and is superseded by this route — but it ' +
          'stays because the unpushed 2bdaf0d advertised it and removing a path in the same ' +
          'session it was fixed would be two contradictory signals to the Client team.',
      },
      {
        method: 'get',
        path: '/api/services/full',
        disposition: 'CANONICALIZE',
        note:
          'The legacy LEVEL-2/LEVEL-3 projection the customer app reads today. Cannot be ' +
          'retired until ServanaClient migrates: it is the only catalog either Flutter app ' +
          'has ever consumed.',
      },
    ],
    callers: { ...ALL_PLANNED, admin: 'n/a', providerMobile: 'n/a', providerWeb: 'n/a' },
    observability: 'catalog',
  },
  {
    id: 'catalog.summary',
    domain: 'catalog',
    method: 'get',
    path: '/catalog/summary',
    summary: 'Counts and last-updated stamp for the catalog, for cache validation.',
    auth: 'public',
    idempotent: true,
    responseSchema: 'CatalogSummary',
    errors: [],
    status: 'implemented',
    domainService: 'services/catalogPublicService.getPublicCatalogSummary',
    legacy: [
      { method: 'get', path: '/api/catalog/summary', disposition: 'ALIAS_TEMPORARILY', note: 'Same router, superseded by this route.' },
    ],
    callers: { ...ALL_PLANNED, admin: 'n/a', providerMobile: 'n/a', providerWeb: 'n/a' },
    observability: 'catalog',
  },
  {
    id: 'catalog.services.list',
    domain: 'catalog',
    method: 'get',
    path: '/catalog/services',
    summary: 'Flat list of every bookable service, for search and deep links.',
    auth: 'public',
    idempotent: true,
    responseSchema: 'CatalogServiceList',
    errors: [],
    status: 'implemented',
    domainService: 'services/catalogPublicService.listPublicServices',
    legacy: [
      { method: 'get', path: '/api/catalog/services', disposition: 'ALIAS_TEMPORARILY', note: 'Same router, superseded by this route.' },
    ],
    callers: { ...ALL_PLANNED, admin: 'n/a', providerMobile: 'n/a', providerWeb: 'n/a' },
    observability: 'catalog',
  },
  {
    id: 'catalog.services.get',
    domain: 'catalog',
    method: 'get',
    path: '/catalog/services/:serviceId',
    summary: 'One service by its canonical services.id, including its place in the hierarchy.',
    auth: 'public',
    idempotent: true,
    responseSchema: 'CatalogServiceDetail',
    errors: ['VALIDATION_FAILED', 'CATALOG_SERVICE_NOT_FOUND'],
    params: [{ name: 'serviceId', type: 'integer', description: 'Canonical services.id' }],
    status: 'implemented',
    domainService: 'services/catalogPublicService.getServiceDetail',
    legacy: [
      { method: 'get', path: '/api/catalog/services/:serviceId', disposition: 'ALIAS_TEMPORARILY', note: 'Same router, superseded by this route.' },
    ],
    callers: { ...ALL_PLANNED, admin: 'n/a', providerMobile: 'n/a', providerWeb: 'n/a' },
    observability: 'catalog',
    notes:
      'Deliberately NOT status-filtered: an archived deep link resolves to an honest ' +
      '"unavailable" rather than a 404 dead end. `available` folds in subcategory and ' +
      'category status.',
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Identity
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'identity.me',
    domain: 'identity',
    method: 'get',
    path: '/me',
    summary: 'The authenticated caller, whatever their role.',
    auth: 'authenticated',
    idempotent: true,
    responseSchema: 'Identity',
    errors: ['NOT_FOUND'],
    status: 'implemented',
    domainService: 'services/identityService.getIdentity',
    legacy: [
      {
        method: 'get',
        path: '/api/auth/me',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'Provider Web reads this on every session bootstrap. It now delegates to the same ' +
          'identityService.getIdentity this route uses, so the two cannot drift; only the ' +
          'envelope differs.',
      },
      {
        method: 'get',
        path: '/api/user/profile',
        disposition: 'ROLE_SPECIFIC',
        note:
          'Not a duplicate: returns the CUSTOMER profile aggregate (addresses, preferences), ' +
          'not the identity record. Retained; a v1 successor belongs in the customer-profile ' +
          'domain command, not here.',
      },
    ],
    callers: { customerMobile: 'planned', customerWeb: 'planned', providerMobile: 'planned', providerWeb: 'legacy', admin: 'planned' },
    observability: 'identity',
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Bookings — the customer's own
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'bookings.listMine',
    domain: 'bookings',
    method: 'get',
    path: '/bookings',
    summary: "The caller's own bookings. Identity comes from the token, never from a parameter.",
    auth: 'authenticated',
    idempotent: true,
    responseSchema: 'BookingList',
    errors: [],
    query: [
      { name: 'limit', type: 'integer', required: false, description: 'Page size, 1-100, default 20' },
      { name: 'offset', type: 'integer', required: false, description: 'Rows to skip, default 0' },
    ],
    status: 'implemented',
    domainService: 'services/bookingService.getBookingsByUserId + formatBookings',
    legacy: [
      {
        method: 'get',
        path: '/api/users/:userId/bookings',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'Takes the customer uid from the PATH and then asserts it equals the token subject — ' +
          'so the parameter is decoration that has already caused one real BOLA. v1 drops it. ' +
          'ServanaClient and the customer web portal both still call the legacy form.',
      },
    ],
    callers: { customerMobile: 'legacy', customerWeb: 'legacy', providerMobile: 'n/a', providerWeb: 'n/a', admin: 'n/a' },
    observability: 'bookings',
    notes:
      'Paginated at the API boundary. The underlying service returns the whole set, so this ' +
      'bounds the RESPONSE, not the query — noted in the matrix as a follow-up for the ' +
      'bookings domain command.',
  },
  {
    id: 'bookings.get',
    domain: 'bookings',
    method: 'get',
    path: '/bookings/:bookingId',
    summary: 'One booking, if the caller is its customer, its active provider, or an admin.',
    auth: 'authenticated',
    idempotent: true,
    responseSchema: 'Booking',
    errors: ['VALIDATION_FAILED', 'BOOKING_NOT_FOUND', 'BOOKING_ACCESS_DENIED'],
    params: [{ name: 'bookingId', type: 'integer', description: 'bookings.id' }],
    status: 'implemented',
    domainService: 'services/bookingAccessService.assertBookingAccess + bookingService.getBookingById',
    legacy: [
      {
        method: 'get',
        path: '/api/:id',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'A single-segment wildcard at the API root. It is the reason no unknown one-segment ' +
          'GET can 404, and it swallowed GET /api/catalog. It is a live protected-client ' +
          'contract (§5) so it cannot be moved, but every new client must use the v1 form. ' +
          'Retirement is gated on telemetry showing zero non-numeric ids and zero legacy callers.',
      },
    ],
    callers: { customerMobile: 'legacy', customerWeb: 'legacy', providerMobile: 'legacy', providerWeb: 'planned', admin: 'planned' },
    observability: 'bookings',
  },
  {
    id: 'bookings.timeline',
    domain: 'bookings',
    method: 'get',
    path: '/bookings/:bookingId/timeline',
    summary: "A booking's operational history, voiced for the customer.",
    auth: 'authenticated',
    idempotent: true,
    responseSchema: 'BookingTimeline',
    errors: ['VALIDATION_FAILED', 'BOOKING_NOT_FOUND', 'BOOKING_ACCESS_DENIED'],
    params: [{ name: 'bookingId', type: 'integer', description: 'bookings.id' }],
    status: 'implemented',
    domainService: 'services/bookingAccessService.assertBookingAccess + bookingService.getCustomerBookingTimeline',
    legacy: [
      { method: 'get', path: '/api/:id/timeline', disposition: 'ALIAS_TEMPORARILY', note: 'Same handler chain; v1 is the unambiguous path.' },
      {
        method: 'get',
        path: '/api/provider/bookings/:bookingId/timeline',
        disposition: 'ROLE_SPECIFIC',
        note:
          'Genuinely role-specific: the shared builder is written from the provider\'s seat, ' +
          'where "YOU" means the provider. Same domain service, different voicing. Documented ' +
          'rather than merged.',
      },
    ],
    callers: { customerMobile: 'legacy', customerWeb: 'planned', providerMobile: 'n/a', providerWeb: 'n/a', admin: 'n/a' },
    observability: 'bookings',
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Provider jobs
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'provider.jobs.list',
    domain: 'provider-jobs',
    method: 'get',
    path: '/provider/jobs',
    summary: "The authenticated provider's job cards.",
    auth: 'provider',
    idempotent: true,
    responseSchema: 'JobCardList',
    errors: ['PROVIDER_ROLE_REQUIRED'],
    query: [
      { name: 'limit', type: 'integer', required: false, description: 'Page size, 1-100, default 50' },
      { name: 'offset', type: 'integer', required: false, description: 'Rows to skip, default 0' },
    ],
    status: 'implemented',
    domainService: 'services/technicianService.getJobCardsByWorker + controllers/jobCardView.formatJobCard',
    legacy: [
      {
        method: 'get',
        path: '/api/worker/job-cards',
        disposition: 'ALIAS_TEMPORARILY',
        note: 'Provider Web calls this today. Same service, same view function, legacy envelope (a bare array).',
      },
      {
        method: 'get',
        path: '/api/workers/:workerId/job-cards',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'ServanaWorker calls this. Takes the provider uid from the PATH; it is now behind ' +
          'verifyAuth + verifyOwnership, but the parameter remains a BOLA shape that v1 removes. ' +
          'Retirement gated on a ServanaWorker release.',
      },
    ],
    callers: { customerMobile: 'n/a', customerWeb: 'n/a', providerMobile: 'legacy', providerWeb: 'legacy', admin: 'n/a' },
    observability: 'provider-jobs',
    notes:
      'Three paths, one domain service. This is the clearest centralization case in the ' +
      'backend: two clients, two shapes, one query.',
  },
  {
    id: 'provider.jobs.get',
    domain: 'provider-jobs',
    method: 'get',
    path: '/provider/jobs/:bookingId',
    summary: "One job card, scoped to the authenticated provider's own assignment.",
    auth: 'provider',
    idempotent: true,
    responseSchema: 'JobCard',
    errors: ['VALIDATION_FAILED', 'NOT_FOUND', 'PROVIDER_ROLE_REQUIRED'],
    params: [{ name: 'bookingId', type: 'integer', description: 'bookings.id' }],
    status: 'implemented',
    domainService: 'services/technicianService.getJobCardByWorker + controllers/jobCardView.formatJobCard',
    legacy: [
      { method: 'get', path: '/api/worker/job-cards/:bookingId', disposition: 'ALIAS_TEMPORARILY', note: 'Provider Web. Same service and view function.' },
    ],
    callers: { customerMobile: 'n/a', customerWeb: 'n/a', providerMobile: 'planned', providerWeb: 'legacy', admin: 'n/a' },
    observability: 'provider-jobs',
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Notifications
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'notifications.list',
    domain: 'notifications',
    method: 'get',
    path: '/notifications',
    summary: "The caller's notifications.",
    auth: 'authenticated',
    idempotent: true,
    responseSchema: 'NotificationList',
    errors: [],
    query: [
      { name: 'filter', type: 'string', required: false, description: 'Optional service-side filter key' },
      { name: 'limit', type: 'integer', required: false, description: 'Page size, 1-100, default 50' },
      { name: 'offset', type: 'integer', required: false, description: 'Rows to skip, default 0' },
    ],
    status: 'implemented',
    domainService: 'services/notificationService.listCustomerNotifications',
    legacy: [
      { method: 'get', path: '/api/user/notifications', disposition: 'ALIAS_TEMPORARILY', note: 'Customer clients call this today.' },
    ],
    callers: { customerMobile: 'legacy', customerWeb: 'legacy', providerMobile: 'n/a', providerWeb: 'n/a', admin: 'n/a' },
    observability: 'notifications',
  },
  {
    id: 'notifications.unreadCount',
    domain: 'notifications',
    method: 'get',
    path: '/notifications/unread-count',
    summary: 'How many unread notifications the caller has.',
    auth: 'authenticated',
    idempotent: true,
    responseSchema: 'UnreadCount',
    errors: [],
    status: 'implemented',
    domainService: 'services/notificationService.countCustomerUnreadNotifications',
    legacy: [
      {
        method: 'get',
        path: '/api/user/notifications/unread-count',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'Declared before /user/notifications/:key on the legacy router precisely so "unread-count" ' +
          'is not parsed as a notification key. v1 has the same ordering requirement and the ' +
          'shadow test now enforces it.',
      },
    ],
    callers: { customerMobile: 'legacy', customerWeb: 'legacy', providerMobile: 'n/a', providerWeb: 'n/a', admin: 'n/a' },
    observability: 'notifications',
  },
  {
    id: 'notifications.markRead',
    domain: 'notifications',
    method: 'patch',
    path: '/notifications/:key/read',
    summary: 'Marks one notification read. Repeating it is a no-op, not an error.',
    auth: 'authenticated',
    idempotent: true,
    responseSchema: 'NotificationMutation',
    errors: ['VALIDATION_FAILED', 'NOTIFICATION_NOT_FOUND', 'NOTIFICATION_NOT_ACTIONABLE'],
    params: [{ name: 'key', type: 'string', description: 'Opaque notification key' }],
    status: 'implemented',
    domainService: 'services/notificationService.markCustomerNotificationReadByKey',
    legacy: [
      {
        method: 'patch',
        path: '/api/user/notifications/:key/read',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'Same service and the same key validation. The path differs only in the /user prefix, ' +
          'which named the caller rather than the resource.',
      },
    ],
    callers: { customerMobile: 'legacy', customerWeb: 'legacy', providerMobile: 'n/a', providerWeb: 'n/a', admin: 'n/a' },
    observability: 'notifications',
  },
  {
    id: 'notifications.markAllRead',
    domain: 'notifications',
    method: 'post',
    path: '/notifications/read-all',
    summary: 'Marks every notification read. Naturally idempotent.',
    auth: 'authenticated',
    idempotent: true,
    responseSchema: 'NotificationMutation',
    errors: [],
    status: 'implemented',
    domainService: 'services/notificationService.markAllCustomerNotificationsRead',
    legacy: [
      { method: 'post', path: '/api/user/notifications/mark-all-read', disposition: 'ALIAS_TEMPORARILY', note: 'Same service; v1 uses the resource-shaped path.' },
    ],
    callers: { customerMobile: 'legacy', customerWeb: 'legacy', providerMobile: 'n/a', providerWeb: 'n/a', admin: 'n/a' },
    observability: 'notifications',
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Reviews — public provider reputation
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'reviews.provider.list',
    domain: 'reviews',
    method: 'get',
    path: '/reviews/providers/:providerUid',
    summary: "A provider's published reviews. No customer identity is projected.",
    auth: 'public',
    idempotent: true,
    responseSchema: 'ProviderReviewList',
    errors: ['VALIDATION_FAILED'],
    params: [{ name: 'providerUid', type: 'string', description: 'Canonical provider uid' }],
    query: [
      { name: 'limit', type: 'integer', required: false, description: 'Page size, 1-50, default 20' },
      { name: 'offset', type: 'integer', required: false, description: 'Rows to skip, default 0' },
    ],
    status: 'implemented',
    domainService: 'services/customerReviewService.listProviderReviews',
    legacy: [
      {
        method: 'get',
        path: '/api/providers/:providerUid/reviews',
        disposition: 'ALIAS_TEMPORARILY',
        note: 'Same service. The legacy form does not clamp limit/offset; v1 does (BE-10).',
      },
    ],
    callers: { customerMobile: 'planned', customerWeb: 'planned', providerMobile: 'n/a', providerWeb: 'n/a', admin: 'n/a' },
    observability: 'reviews',
  },
  {
    id: 'reviews.provider.rating',
    domain: 'reviews',
    method: 'get',
    path: '/reviews/providers/:providerUid/rating',
    summary: "A provider's aggregate rating.",
    auth: 'public',
    idempotent: true,
    responseSchema: 'ProviderRating',
    errors: ['VALIDATION_FAILED'],
    params: [{ name: 'providerUid', type: 'string', description: 'Canonical provider uid' }],
    status: 'implemented',
    domainService: 'services/customerReviewService.getProviderAggregate',
    legacy: [
      {
        method: 'get',
        path: '/api/providers/:providerUid/rating',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'Same service. Kept because it sits beside the reviews list that a future customer ' +
          'client may already be calling; retiring one without the other would be half a change.',
      },
    ],
    callers: { customerMobile: 'planned', customerWeb: 'planned', providerMobile: 'n/a', providerWeb: 'n/a', admin: 'n/a' },
    observability: 'reviews',
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Settings
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'settings.notificationPreferences.get',
    domain: 'settings',
    method: 'get',
    path: '/settings/notification-preferences',
    summary: "The caller's notification preferences.",
    auth: 'authenticated',
    idempotent: true,
    responseSchema: 'NotificationPreferences',
    errors: [],
    status: 'implemented',
    domainService: 'services/notificationService.getNotificationPrefs',
    legacy: [
      { method: 'get', path: '/api/provider/notification-preferences', disposition: 'ALIAS_TEMPORARILY', note: 'Provider Web. Same uid-keyed service — nothing about it is provider-specific.' },
      { method: 'get', path: '/api/workers/:uid/notification-preferences', disposition: 'ALIAS_TEMPORARILY', note: 'ServanaWorker. Same service, uid taken from the path instead of the token.' },
    ],
    callers: { customerMobile: 'planned', customerWeb: 'planned', providerMobile: 'legacy', providerWeb: 'legacy', admin: 'n/a' },
    observability: 'settings',
    notes:
      'Three legacy paths, one uid-keyed service, and two of the three are gated on a provider ' +
      'role for a preference table that has no role column. The role gate is the accident, not ' +
      'the capability.',
  },
  {
    id: 'settings.notificationPreferences.put',
    domain: 'settings',
    method: 'put',
    path: '/settings/notification-preferences',
    summary: "Replaces the caller's notification preferences. Idempotent by construction.",
    auth: 'authenticated',
    idempotent: true,
    requestSchema: 'NotificationPreferences',
    responseSchema: 'NotificationPreferences',
    errors: ['VALIDATION_FAILED'],
    status: 'implemented',
    domainService: 'services/notificationService.saveNotificationPrefs',
    legacy: [
      { method: 'put', path: '/api/provider/notification-preferences', disposition: 'ALIAS_TEMPORARILY', note: 'Provider Web. Same service.' },
      { method: 'put', path: '/api/workers/:uid/notification-preferences', disposition: 'ALIAS_TEMPORARILY', note: 'ServanaWorker. Same service.' },
    ],
    callers: { customerMobile: 'planned', customerWeb: 'planned', providerMobile: 'legacy', providerWeb: 'legacy', admin: 'n/a' },
    observability: 'settings',
  },

  // ───────────────────────────────────────────────────────────────────────────
  // PLANNED — documented so the migration matrix can name a successor.
  // Not mounted. Each belongs to a later domain command.
  // ───────────────────────────────────────────────────────────────────────────
  // ───────────────────────────────────────────────────────────────────────────
  // Auth and identity
  //
  // Every entry here delegates to the state machine the legacy route already
  // uses; none of them re-implements one. `domainService` names which, and
  // `tests/v1-auth-contract.test.ts` asserts the delegation rather than
  // describing it.
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'auth.register',
    domain: 'auth',
    method: 'post',
    path: '/auth/register',
    summary: 'Creates an account from an email + password, or from a Firebase ID token.',
    auth: 'public',
    idempotent: false,
    replayGuard:
      'Firebase enforces one account per identifier, so a replayed registration collides with the identity it just created rather than making a second account. The 409 is the guard.',
    requestSchema: 'RegisterRequest',
    responseSchema: 'RegisterResult',
    errors: ['VALIDATION_FAILED', 'REGISTRATION_REJECTED', 'WEAK_PASSWORD', 'ACCOUNT_LINK_REQUIRED', 'RATE_LIMITED'],
    status: 'implemented',
    domainService: 'services/auth.service.registerUser | services/firebaseFunctions.service.firebaseProviderRegister',
    legacy: [
      {
        method: 'post',
        path: '/api/auth/signup',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'Email + password registration. Same service; v1 accepts either credential kind on ' +
          'one path instead of splitting them across two routes with two response shapes.',
      },
      {
        method: 'post',
        path: '/api/auth/provider/register',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'Firebase-token registration, provider-shaped. Same service. Its 403 for a non-provider ' +
          'role is preserved in v1 as an audience assertion rather than a separate path.',
      },
      {
        method: 'post',
        path: '/api/auth/add-employees',
        disposition: 'ROLE_SPECIFIC',
        note:
          'Admin bulk-creates provider accounts with generated temporary passwords. Genuinely ' +
          'different: a different actor, a different credential origin, and a partial-success ' +
          'response shape. Retained; it is account PROVISIONING, not registration.',
      },
    ],
    callers: { customerMobile: 'legacy', customerWeb: 'planned', providerMobile: 'legacy', providerWeb: 'legacy', admin: 'n/a' },
    observability: 'auth',
    notes:
      'Registration answers identity only. Provider onboarding, service selection and profile ' +
      'completion are separate domains and are NOT triggered from here beyond the existing ' +
      'non-blocking attribution hooks the legacy path already fires.',
  },
  {
    id: 'auth.login',
    domain: 'auth',
    method: 'post',
    path: '/auth/login',
    summary: 'One sign-in for every identifier and every surface: email or mobile + password, or a Firebase ID token.',
    auth: 'public',
    idempotent: false,
    replayGuard:
      'A replay re-authenticates the same credential and mints another session. Nothing accumulates, and the per-account limiter bounds the rate — an Idempotency-Key here would be theatre on a read-shaped operation that happens to issue a token.',
    requestSchema: 'LoginRequest',
    responseSchema: 'Session',
    errors: [
      'VALIDATION_FAILED',
      'INVALID_CREDENTIALS',
      'ACCOUNT_UNVERIFIED',
      'ACCOUNT_DISABLED',
      'AUDIENCE_MISMATCH',
      'PASSWORD_NOT_AVAILABLE',
      'ACCOUNT_LINK_REQUIRED',
      'RATE_LIMITED',
    ],
    status: 'implemented',
    domainService: 'services/authLoginService → services/auth.service.loggedInUser | firebaseFunctions.firebaseAuthLogin',
    legacy: [
      {
        method: 'post',
        path: '/api/auth/signin',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'Email + password. v1 calls the same `authService.loggedInUser` and adds identifier ' +
          'resolution in front of it, so a mobile number now names the account.',
      },
      {
        method: 'post',
        path: '/api/auth/admin-signin',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'Identical to /auth/signin plus a role-1 gate. The gate is a property of the CALLER, ' +
          'not the credential, so v1 takes it as `audience: "admin"` rather than as a second path.',
      },
      {
        method: 'post',
        path: '/api/auth/firebase-login',
        disposition: 'ALIAS_TEMPORARILY',
        note: 'Firebase ID token, provider-shaped. Same service; v1 expresses the role gate as an audience.',
      },
      {
        method: 'post',
        path: '/api/auth/customer-firebase-login',
        disposition: 'ROLE_SPECIFIC',
        note:
          'NOT collapsed. Its link-collision contract is a 200 carrying `status: "failed"` and no ' +
          'token, because the installed customer app throws on any non-2xx before reading the body ' +
          'and fires onUnauthorized on 401 — either would show "session expired" to somebody who ' +
          'has no session yet. Changing that shape is a client release, so it stays until the ' +
          'customer app migrates.',
      },
    ],
    callers: { customerMobile: 'legacy', customerWeb: 'legacy', providerMobile: 'legacy', providerWeb: 'legacy', admin: 'legacy' },
    observability: 'auth',
    notes:
      'Mobile + password works only for an account that also has an email: Firebase is the ' +
      'password authority and its password grant is keyed on email. An account with a mobile and ' +
      'no email gets PASSWORD_NOT_AVAILABLE and must use the token path — stated, not guessed.',
  },
  {
    id: 'auth.refresh',
    domain: 'auth',
    method: 'post',
    path: '/auth/refresh',
    summary: 'Exchanges a refresh token for a fresh session.',
    auth: 'public',
    idempotent: false,
    replayGuard:
      'Google owns the exchange and decides whether a refresh token is still redeemable. A replay yields another ID token or a refusal; nothing on this side accumulates.',
    requestSchema: 'RefreshRequest',
    responseSchema: 'Session',
    errors: ['VALIDATION_FAILED', 'REFRESH_TOKEN_INVALID', 'REFRESH_UNAVAILABLE', 'RATE_LIMITED'],
    status: 'implemented',
    domainService: 'services/tokenRefreshService.refreshIdToken',
    legacy: [
      {
        method: 'post',
        path: '/api/auth/refresh',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'Same service. Unauthenticated by design on both: the caller is here BECAUSE their ID ' +
          'token expired, so requiring a valid one would be circular. The refresh token is the ' +
          'credential and Google validates it.',
      },
    ],
    callers: { customerMobile: 'legacy', customerWeb: 'legacy', providerMobile: 'legacy', providerWeb: 'legacy', admin: 'legacy' },
    observability: 'auth',
  },
  {
    id: 'auth.logout',
    domain: 'auth',
    method: 'post',
    path: '/auth/logout',
    summary: 'Ends every session for the authenticated account and clears its push token.',
    auth: 'authenticated',
    idempotent: true,
    responseSchema: 'LogoutResult',
    errors: [],
    status: 'implemented',
    domainService: 'services/authSessionService.endAllSessions',
    legacy: [
      {
        method: 'post',
        path: '/api/auth/logout',
        disposition: 'ALIAS_TEMPORARILY',
        note: 'Same effect; both now go through the one session service so the side-effect set is decided once.',
      },
    ],
    callers: { customerMobile: 'legacy', customerWeb: 'legacy', providerMobile: 'legacy', providerWeb: 'legacy', admin: 'legacy' },
    observability: 'auth',
    notes:
      'Ends ALL sessions, not this device only. Firebase has no per-session revocation, and a ' +
      'logout that silently left other devices signed in would be worse than one that says so.',
  },
  {
    id: 'auth.forgotPassword',
    domain: 'auth',
    method: 'post',
    path: '/auth/forgot-password',
    summary: 'Starts password recovery. Always answers the same way, whether or not the account exists.',
    auth: 'public',
    idempotent: true,
    requestSchema: 'ForgotPasswordRequest',
    responseSchema: 'NeutralAck',
    errors: ['VALIDATION_FAILED', 'RATE_LIMITED'],
    status: 'implemented',
    domainService: 'services/auth.service.forgotPassword',
    legacy: [
      {
        method: 'post',
        path: '/api/auth/forgot-password',
        disposition: 'ALIAS_TEMPORARILY',
        note: 'Same service, same neutral acknowledgement, same platform-scoped continue URL.',
      },
    ],
    callers: { customerMobile: 'legacy', customerWeb: 'legacy', providerMobile: 'legacy', providerWeb: 'legacy', admin: 'legacy' },
    observability: 'auth',
    notes:
      'EMAIL ONLY today. Recovery requires a VERIFIED identifier, and mobile recovery would need ' +
      'an SMS sender this platform does not have — so it is refused rather than half-built. The ' +
      'response is identical for an unknown address, an unverified one and a mobile number.',
  },
  {
    id: 'auth.resetPassword',
    domain: 'auth',
    method: 'post',
    path: '/auth/reset-password',
    summary: 'Completes a password reset and ends every existing session.',
    auth: 'public',
    idempotent: false,
    replayGuard:
      'The oobCode is SINGLE-USE and consumed by Firebase on the first successful call. A replay finds it spent and answers RESET_TOKEN_INVALID.',
    requestSchema: 'ResetPasswordRequest',
    responseSchema: 'NeutralAck',
    errors: ['VALIDATION_FAILED', 'RESET_TOKEN_INVALID', 'WEAK_PASSWORD', 'RATE_LIMITED'],
    status: 'implemented',
    domainService: 'services/auth.service.resetPassword → services/authSessionService.endSessionsOnCredentialChange',
    legacy: [
      {
        method: 'post',
        path: '/api/auth/reset-password',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'Same service — and the session revocation added in this command applies to BOTH, ' +
          'because it lives in the service rather than in either handler.',
      },
    ],
    callers: { customerMobile: 'legacy', customerWeb: 'legacy', providerMobile: 'legacy', providerWeb: 'legacy', admin: 'legacy' },
    observability: 'auth',
  },
  {
    id: 'auth.verifyEmail',
    domain: 'auth',
    method: 'post',
    path: '/auth/verify-email',
    summary: 'Verifies an email address with a one-time code issued for registration.',
    auth: 'public',
    idempotent: false,
    replayGuard:
      'The code is consumed by a compare-and-swap UPDATE (services/otpService.consumeOtp), so two concurrent verifications of one code cannot both succeed.',
    requestSchema: 'VerifyEmailRequest',
    responseSchema: 'VerificationResult',
    errors: ['VALIDATION_FAILED', 'OTP_INVALID', 'OTP_EXPIRED', 'RATE_LIMITED'],
    status: 'implemented',
    domainService: 'services/otpService.verifyEmailOtp + services/auth.service.verifyEmailOtp',
    legacy: [
      {
        method: 'post',
        path: '/api/auth/verify-email-otp',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'Same service. v1 scopes the read to the REGISTRATION_VERIFICATION purpose, so a code ' +
          'minted for a different purpose can never satisfy it.',
      },
    ],
    callers: { customerMobile: 'legacy', customerWeb: 'planned', providerMobile: 'legacy', providerWeb: 'planned', admin: 'n/a' },
    observability: 'auth',
  },
  {
    id: 'auth.resendVerification',
    domain: 'auth',
    method: 'post',
    path: '/auth/resend-verification',
    summary: 'Re-sends an email verification code or link. Always answers the same way.',
    auth: 'public',
    idempotent: true,
    requestSchema: 'ResendVerificationRequest',
    responseSchema: 'NeutralAck',
    errors: ['VALIDATION_FAILED', 'RATE_LIMITED'],
    status: 'implemented',
    domainService: 'services/auth.service.resendEmailOtp | getAndSendEmailVerificationLink',
    legacy: [
      {
        method: 'post',
        path: '/api/auth/resend-email-otp',
        disposition: 'ALIAS_TEMPORARILY',
        note: 'Same service. v1 takes `channel: "otp" | "link"` instead of splitting the two across paths.',
      },
      {
        method: 'get',
        path: '/api/auth/resendverification',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'A GET that sends an email — a read path that writes and mails. v1 is a POST. The legacy ' +
          'form stays until both mobile clients move, because it is what they call today.',
      },
    ],
    callers: { customerMobile: 'legacy', customerWeb: 'planned', providerMobile: 'legacy', providerWeb: 'legacy', admin: 'n/a' },
    observability: 'auth',
  },
  {
    id: 'auth.verifyMobile',
    domain: 'auth',
    method: 'post',
    path: '/auth/verify-mobile',
    summary: 'Records a mobile number as verified, proven by a Firebase phone credential.',
    auth: 'authenticated',
    idempotent: true,
    requestSchema: 'VerifyMobileRequest',
    responseSchema: 'VerificationResult',
    errors: ['VALIDATION_FAILED', 'INVALID_CREDENTIALS', 'ACCOUNT_LINK_REQUIRED'],
    status: 'implemented',
    domainService: 'services/identityVerificationSync.provenFrom + recordProvenIdentifiers, guarded by services/accountLinkGuard',
    legacy: [],
    callers: { customerMobile: 'planned', customerWeb: 'planned', providerMobile: 'planned', providerWeb: 'planned', admin: 'n/a' },
    observability: 'auth',
    notes:
      'There is no server-side SMS OTP and this does not add one. The proof is a Firebase ID ' +
      'token whose sign-in provider is `phone`, which Firebase only issues after its own OTP. ' +
      'The number must not already belong to another account — `accountLinkGuard` decides, and a ' +
      'collision is ACCOUNT_LINK_REQUIRED rather than a silent second account.',
  },
  {
    id: 'search.query',
    domain: 'search',
    method: 'get',
    path: '/search',
    summary: 'Search Categories, Subcategories and Services in one ranked result set.',
    auth: 'public',
    idempotent: true,
    responseSchema: 'SearchResults',
    errors: ['VALIDATION_FAILED'],
    query: [
      { name: 'q', type: 'string', required: true, description: 'Search term. Under 2 characters returns an empty result, not an error.' },
      { name: 'types', type: 'string', required: false, description: 'Comma-separated: category,subcategory,service. Default all three.' },
      { name: 'limit', type: 'integer', required: false, description: 'Max hits, 1-50, default 20.' },
    ],
    status: 'implemented',
    domainService: 'services/catalogSearchService.searchCatalog',
    legacy: [
      {
        method: 'get',
        path: '/api/services/full',
        disposition: 'CANONICALIZE',
        note:
          'Not a search endpoint — it is the whole legacy catalog, which ServanaClient downloads ' +
          'and searches ON THE DEVICE. That is why one absent `level2` key emptied the search ' +
          'cache and every query rendered "No services match your search". Retiring it needs the ' +
          'client to move to this route AND to /api/v1/catalog.',
      },
    ],
    callers: { customerMobile: 'legacy', customerWeb: 'planned', providerMobile: 'n/a', providerWeb: 'n/a', admin: 'n/a' },
    observability: 'catalog',
    notes:
      'Every hit carries a qualified `ref` (`service:180`), so a mixed result set is keyable ' +
      'without the client inferring type from which array it arrived in. Aliases widen what a ' +
      'term MATCHES and never what exists — "aircon" and "air conditioning" return the same ' +
      'Services with the same ids.',
  },
  {
    id: 'catalog.search',
    domain: 'catalog',
    method: 'get',
    path: '/catalog/search',
    summary: 'Alias of /search, scoped under the catalog namespace.',
    auth: 'public',
    idempotent: true,
    responseSchema: 'SearchResults',
    errors: ['VALIDATION_FAILED'],
    query: [
      { name: 'q', type: 'string', required: true, description: 'Search term.' },
      { name: 'types', type: 'string', required: false, description: 'Comma-separated entity types.' },
      { name: 'limit', type: 'integer', required: false, description: 'Max hits, 1-50, default 20.' },
    ],
    status: 'implemented',
    domainService: 'services/catalogSearchService.searchCatalog',
    legacy: [],
    callers: { customerMobile: 'planned', customerWeb: 'planned', providerMobile: 'n/a', providerWeb: 'n/a', admin: 'n/a' },
    observability: 'catalog',
    notes:
      'The command named both paths as the target. Both are mounted and both call the SAME ' +
      'function — two paths, one implementation, which is a naming convenience rather than a ' +
      'second search. If it ever becomes two implementations it is a defect, and ' +
      'tests/v1-catalog-contract.test.ts asserts the shared handler.',
  },
  {
    id: 'catalog.categories.list',
    domain: 'catalog',
    method: 'get',
    path: '/catalog/categories',
    summary: 'Lightweight Category summaries with counts, no nested children.',
    auth: 'public',
    idempotent: true,
    responseSchema: 'CategorySummaryList',
    errors: [],
    status: 'implemented',
    domainService: 'services/catalogPublicService.listCategories',
    legacy: [],
    callers: { customerMobile: 'planned', customerWeb: 'planned', providerMobile: 'n/a', providerWeb: 'n/a', admin: 'n/a' },
    observability: 'catalog',
    notes:
      'The counterpart to GET /catalog, which returns the whole tree. A category chooser needing ' +
      'three names should not receive 95 services with prices and images.',
  },
  {
    id: 'catalog.categories.get',
    domain: 'catalog',
    method: 'get',
    path: '/catalog/categories/:categoryId',
    summary: 'One Category by canonical catalog_categories.id.',
    auth: 'public',
    idempotent: true,
    responseSchema: 'CategoryDetail',
    errors: ['VALIDATION_FAILED', 'CATALOG_CATEGORY_NOT_FOUND'],
    params: [{ name: 'categoryId', type: 'integer', description: 'Canonical catalog_categories.id — NOT a service_families.id.' }],
    status: 'implemented',
    domainService: 'services/catalogPublicService.getCategory',
    legacy: [],
    callers: { customerMobile: 'planned', customerWeb: 'planned', providerMobile: 'n/a', providerWeb: 'n/a', admin: 'n/a' },
    observability: 'catalog',
    notes: 'Not status-filtered: a deep link to a deactivated Category lands on an honest `available: false`.',
  },
  {
    id: 'catalog.categories.subcategories',
    domain: 'catalog',
    method: 'get',
    path: '/catalog/categories/:categoryId/subcategories',
    summary: 'The Subcategories of one Category.',
    auth: 'public',
    idempotent: true,
    responseSchema: 'SubcategorySummaryList',
    errors: ['VALIDATION_FAILED', 'CATALOG_CATEGORY_NOT_FOUND'],
    params: [{ name: 'categoryId', type: 'integer', description: 'Canonical catalog_categories.id.' }],
    status: 'implemented',
    domainService: 'services/catalogPublicService.listSubcategoriesOfCategory',
    legacy: [
      {
        method: 'get',
        path: '/api/services/:serviceId/level2',
        disposition: 'CANONICALIZE',
        note:
          'The legacy equivalent, and NOT a rename. Its `:serviceId` is a service_families.id ' +
          'and it returns DISTINCT level_2 STRINGS with no ids at all. This route takes a ' +
          'catalog_categories.id and returns identified Subcategories. Different input, different ' +
          'output, different table.',
      },
    ],
    callers: { customerMobile: 'legacy', customerWeb: 'planned', providerMobile: 'n/a', providerWeb: 'n/a', admin: 'n/a' },
    observability: 'catalog',
    notes: '404s on a missing Category rather than returning an empty list — empty and missing are different facts.',
  },
  {
    id: 'catalog.subcategories.get',
    domain: 'catalog',
    method: 'get',
    path: '/catalog/subcategories/:subcategoryId',
    summary: 'One Subcategory by canonical catalog_subcategories.id.',
    auth: 'public',
    idempotent: true,
    responseSchema: 'SubcategoryDetail',
    errors: ['VALIDATION_FAILED', 'CATALOG_SUBCATEGORY_NOT_FOUND'],
    params: [{ name: 'subcategoryId', type: 'integer', description: 'Canonical catalog_subcategories.id.' }],
    status: 'implemented',
    domainService: 'services/catalogPublicService.getSubcategory',
    legacy: [],
    callers: { customerMobile: 'planned', customerWeb: 'planned', providerMobile: 'n/a', providerWeb: 'n/a', admin: 'n/a' },
    observability: 'catalog',
    notes: '`available` folds in the parent Category, as service detail folds in both ancestors.',
  },
  {
    id: 'catalog.subcategories.services',
    domain: 'catalog',
    method: 'get',
    path: '/catalog/subcategories/:subcategoryId/services',
    summary: 'The Services of one Subcategory.',
    auth: 'public',
    idempotent: true,
    responseSchema: 'CatalogServiceList',
    errors: ['VALIDATION_FAILED', 'CATALOG_SUBCATEGORY_NOT_FOUND'],
    params: [{ name: 'subcategoryId', type: 'integer', description: 'Canonical catalog_subcategories.id.' }],
    status: 'implemented',
    domainService: 'services/catalogPublicService.listServicesOfSubcategory',
    legacy: [
      {
        method: 'get',
        path: '/api/services/:serviceId/options-with-addons',
        disposition: 'CANONICALIZE',
        note:
          'The legacy shape. Its `:serviceId` is a service_families.id and it returns level_2 / ' +
          'level_3 option groups, not Services. ServanaWorker calls the un-prefixed twin ' +
          'instead, which is the only catalog route without the /services/ prefix its ' +
          'neighbours use.',
      },
      {
        method: 'get',
        path: '/api/:serviceId/options-with-addons',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'The original un-prefixed form, and what ServanaWorker calls in production. It cannot ' +
          'be retired until that app moves; the customer app followed the convention instead of ' +
          'the exception and 404d for months as a result.',
      },
    ],
    callers: { customerMobile: 'planned', customerWeb: 'planned', providerMobile: 'legacy', providerWeb: 'n/a', admin: 'n/a' },
    observability: 'catalog',
  },
  {
    id: 'home.feed',
    domain: 'home',
    method: 'get',
    path: '/home',
    summary: 'The composed customer home surface.',
    auth: 'authenticated',
    idempotent: true,
    responseSchema: 'HomeFeed',
    errors: [],
    status: 'planned',
    domainService: 'none yet — composed client-side today',
    legacy: [],
    callers: { ...ALL_PLANNED, admin: 'n/a', providerMobile: 'n/a', providerWeb: 'n/a' },
    observability: 'home',
    notes:
      'No legacy equivalent exists. The customer home surface is assembled on the device from ' +
      'three or four separate calls, so there is nothing to alias — this is a new capability, ' +
      'and building it is a product decision about what home should contain rather than a ' +
      'migration. Listed here so the target architecture is complete.',
  },
  {
    id: 'conversations.list',
    domain: 'conversations',
    method: 'get',
    path: '/conversations',
    summary: "The caller's booking conversations.",
    auth: 'authenticated',
    idempotent: true,
    responseSchema: 'ConversationList',
    errors: [],
    status: 'planned',
    domainService: 'chat/chat.service.listConversations',
    legacy: [
      {
        method: 'get',
        path: '/api/chat/conversations',
        disposition: 'CANONICALIZE',
        note:
          'Chat endpoints do NOT use the {status,data} envelope — the store reads a top-level ' +
          '`conversations` key. Re-enveloping under v1 is a real client change, so it is ' +
          'sequenced with the messaging domain command rather than bundled here.',
      },
    ],
    callers: { customerMobile: 'legacy', customerWeb: 'legacy', providerMobile: 'legacy', providerWeb: 'legacy', admin: 'n/a' },
    observability: 'messaging',
  },
  {
    id: 'provider.earnings.summary',
    domain: 'provider-earnings',
    method: 'get',
    path: '/provider/earnings',
    summary: "The authenticated provider's earnings summary.",
    auth: 'provider',
    idempotent: true,
    responseSchema: 'EarningsSummary',
    errors: ['PROVIDER_ROLE_REQUIRED'],
    status: 'planned',
    domainService: 'services/technicianService (earnings family)',
    legacy: [
      { method: 'get', path: '/api/provider/earnings', disposition: 'CANONICALIZE', note: 'Provider Web reads this.' },
      {
        method: 'get',
        path: '/api/workers/:uid/earnings-history',
        disposition: 'ALIAS_TEMPORARILY',
        note: 'No located caller in any of the five clients. Candidate for RETIRE once telemetry confirms.',
      },
    ],
    callers: { customerMobile: 'n/a', customerWeb: 'n/a', providerMobile: 'planned', providerWeb: 'legacy', admin: 'n/a' },
    observability: 'provider-earnings',
    notes:
      'Money. Deliberately not adapted in a foundation command: the payout window is already ' +
      'documented as 48h in copy and 72h in reality, and a second read path before that is ' +
      'settled would give two answers to "when am I paid".',
  },
  // ───────────────────────────────────────────────────────────────────────────
  // Booking lifecycle actions — Phase A.
  //
  // Every one of these calls `transitionBooking` and NOTHING else. They are the
  // canonical path, built and proven before any legacy write is migrated onto
  // the executor, so the executor is exercised by real traffic shapes before it
  // becomes load-bearing for the field.
  //
  // Discrete actions, never a PATCH of a status field: a caller that names a
  // destination can pick any state the machine happens to allow and bypass the
  // rule that was supposed to get it there.
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'bookings.cancel',
    domain: 'bookings',
    method: 'post',
    path: '/bookings/:bookingId/cancel',
    summary: "Cancels the caller's own booking.",
    auth: 'authenticated',
    idempotent: false,
    replayGuard:
      'An Idempotency-Key replays the original result. Without one, a second ' +
      'cancel finds the booking already terminal and is refused, so a retry ' +
      'cannot cancel twice or produce a second timeline entry.',
    requestSchema: 'BookingActionRequest',
    responseSchema: 'BookingTransitionResult',
    errors: [
      'VALIDATION_FAILED', 'BOOKING_NOT_FOUND', 'BOOKING_ACCESS_DENIED',
      'BOOKING_STATE_CONFLICT', 'BOOKING_TRANSITION_INVALID', 'BOOKING_TERMINAL',
      'IDEMPOTENCY_KEY_INVALID', 'IDEMPOTENCY_KEY_REUSED',
    ],
    params: [{ name: 'bookingId', type: 'integer', description: 'bookings.id' }],
    status: 'implemented',
    domainService: 'services/booking/transitionExecutor.transitionBooking (CUSTOMER_CANCEL)',
    legacy: [
      {
        method: 'post',
        path: '/api/bookings/:id/cancel',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'The live customer cancel. It still writes status directly and is Phase C ' +
          'of the executor migration — deliberately after the provider lifecycle, ' +
          'because cancellation touches fees, refunds and provider compensation and ' +
          'is the worst first test of whether the executor architecture works.',
      },
    ],
    callers: { customerMobile: 'legacy', customerWeb: 'legacy', providerMobile: 'n/a', providerWeb: 'n/a', admin: 'n/a' },
    observability: 'bookings',
  },
  {
    id: 'bookings.transitions',
    domain: 'bookings',
    method: 'get',
    path: '/bookings/:bookingId/transitions',
    summary: 'The canonical transition history: one event per state change, oldest first.',
    auth: 'authenticated',
    idempotent: true,
    responseSchema: 'BookingTransitionList',
    errors: ['VALIDATION_FAILED', 'BOOKING_NOT_FOUND', 'BOOKING_ACCESS_DENIED'],
    params: [{ name: 'bookingId', type: 'integer', description: 'bookings.id' }],
    status: 'implemented',
    domainService: 'services/booking/transitionExecutor.getBookingTimeline',
    legacy: [
      {
        method: 'get',
        path: '/api/:id/timeline',
        disposition: 'KEEP',
        note:
          'NOT a duplicate. The legacy timeline is a re-voiced operational narrative ' +
          'built from per-stage timestamps for the customer to read. This is the ' +
          'append-only event log the executor writes inside each transaction — the ' +
          'evidence, not the story. Admin, Customer and Provider all read THIS to ' +
          'agree on what happened.',
      },
    ],
    callers: { customerMobile: 'planned', customerWeb: 'planned', providerMobile: 'planned', providerWeb: 'planned', admin: 'planned' },
    observability: 'bookings',
    notes:
      'Preserves a reassigned provider\'s full progression — accepted, en route, ' +
      'reassigned — because the current state resetting must not erase history.',
  },
  {
    id: 'provider.jobs.accept',
    domain: 'provider-jobs',
    method: 'post',
    path: '/provider/jobs/:bookingId/accept',
    summary: 'Accepts the assignment.',
    auth: 'provider',
    idempotent: false,
    replayGuard:
      'An Idempotency-Key replays the original result. Without one, the machine ' +
      'refuses the repeat because the booking has already left ASSIGNED.',
    requestSchema: 'BookingActionRequest',
    responseSchema: 'BookingTransitionResult',
    errors: [
      'VALIDATION_FAILED', 'BOOKING_NOT_FOUND', 'BOOKING_ACCESS_DENIED',
      'BOOKING_STATE_CONFLICT', 'BOOKING_TRANSITION_INVALID', 'BOOKING_TERMINAL',
      'PROVIDER_ROLE_REQUIRED',
      'IDEMPOTENCY_KEY_INVALID', 'IDEMPOTENCY_KEY_REUSED',
    ],
    params: [{ name: 'bookingId', type: 'integer', description: 'bookings.id' }],
    status: 'implemented',
    domainService: 'services/booking/transitionExecutor.transitionBooking (PROVIDER_ACCEPT)',
    legacy: [
      {
        method: 'put',
        path: '/api/worker/bookings/:bookingId/accept',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'The live provider action. Still writes status directly via technicianService; ' +
          'Phase B of the executor migration. Authorization is equivalent — both resolve ' +
          'the provider from the token and check the CURRENT assignment.',
      },
    ],
    callers: { customerMobile: 'n/a', customerWeb: 'n/a', providerMobile: 'legacy', providerWeb: 'legacy', admin: 'n/a' },
    observability: 'provider-jobs',
  },
  {
    id: 'provider.jobs.decline',
    domain: 'provider-jobs',
    method: 'post',
    path: '/provider/jobs/:bookingId/decline',
    summary: 'Declines the assignment, returning the booking to the pool.',
    auth: 'provider',
    idempotent: false,
    replayGuard:
      'An Idempotency-Key replays the original result. Without one, the machine ' +
      'refuses the repeat because the booking has already left ASSIGNED.',
    requestSchema: 'BookingActionRequest',
    responseSchema: 'BookingTransitionResult',
    errors: [
      'VALIDATION_FAILED', 'BOOKING_NOT_FOUND', 'BOOKING_ACCESS_DENIED',
      'BOOKING_STATE_CONFLICT', 'BOOKING_TRANSITION_INVALID', 'BOOKING_TERMINAL',
      'PROVIDER_ROLE_REQUIRED',
      'IDEMPOTENCY_KEY_INVALID', 'IDEMPOTENCY_KEY_REUSED',
    ],
    params: [{ name: 'bookingId', type: 'integer', description: 'bookings.id' }],
    status: 'implemented',
    domainService: 'services/booking/transitionExecutor.transitionBooking (PROVIDER_DECLINE)',
    legacy: [
      {
        method: 'put',
        path: '/api/worker/bookings/:bookingId/decline',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'The live provider action. Still writes status directly via technicianService; ' +
          'Phase B of the executor migration. Authorization is equivalent — both resolve ' +
          'the provider from the token and check the CURRENT assignment.',
      },
    ],
    callers: { customerMobile: 'n/a', customerWeb: 'n/a', providerMobile: 'legacy', providerWeb: 'legacy', admin: 'n/a' },
    observability: 'provider-jobs',
  },
  {
    id: 'provider.jobs.enroute',
    domain: 'provider-jobs',
    method: 'post',
    path: '/provider/jobs/:bookingId/en-route',
    summary: 'Marks the provider on the way.',
    auth: 'provider',
    idempotent: false,
    replayGuard:
      'An Idempotency-Key replays the original result. Without one, the machine ' +
      'refuses the repeat because the booking has already left ACCEPTED.',
    requestSchema: 'BookingActionRequest',
    responseSchema: 'BookingTransitionResult',
    errors: [
      'VALIDATION_FAILED', 'BOOKING_NOT_FOUND', 'BOOKING_ACCESS_DENIED',
      'BOOKING_STATE_CONFLICT', 'BOOKING_TRANSITION_INVALID', 'BOOKING_TERMINAL',
      'PROVIDER_ROLE_REQUIRED',
      'IDEMPOTENCY_KEY_INVALID', 'IDEMPOTENCY_KEY_REUSED',
    ],
    params: [{ name: 'bookingId', type: 'integer', description: 'bookings.id' }],
    status: 'implemented',
    domainService: 'services/booking/transitionExecutor.transitionBooking (PROVIDER_EN_ROUTE)',
    legacy: [
      {
        method: 'put',
        path: '/api/worker/bookings/:bookingId/en-route',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'The live provider action. Still writes status directly via technicianService; ' +
          'Phase B of the executor migration. Authorization is equivalent — both resolve ' +
          'the provider from the token and check the CURRENT assignment.',
      },
    ],
    callers: { customerMobile: 'n/a', customerWeb: 'n/a', providerMobile: 'legacy', providerWeb: 'legacy', admin: 'n/a' },
    observability: 'provider-jobs',
  },
  {
    id: 'provider.jobs.arrived',
    domain: 'provider-jobs',
    method: 'post',
    path: '/provider/jobs/:bookingId/arrived',
    summary: 'Marks the provider at the address.',
    auth: 'provider',
    idempotent: false,
    replayGuard:
      'An Idempotency-Key replays the original result. Without one, the machine ' +
      'refuses the repeat because the booking has already left EN_ROUTE.',
    requestSchema: 'BookingActionRequest',
    responseSchema: 'BookingTransitionResult',
    errors: [
      'VALIDATION_FAILED', 'BOOKING_NOT_FOUND', 'BOOKING_ACCESS_DENIED',
      'BOOKING_STATE_CONFLICT', 'BOOKING_TRANSITION_INVALID', 'BOOKING_TERMINAL',
      'PROVIDER_ROLE_REQUIRED',
      'IDEMPOTENCY_KEY_INVALID', 'IDEMPOTENCY_KEY_REUSED',
    ],
    params: [{ name: 'bookingId', type: 'integer', description: 'bookings.id' }],
    status: 'implemented',
    domainService: 'services/booking/transitionExecutor.transitionBooking (PROVIDER_ARRIVED)',
    legacy: [
      {
        method: 'put',
        path: '/api/worker/bookings/:bookingId/arrived',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'The live provider action. Still writes status directly via technicianService; ' +
          'Phase B of the executor migration. Authorization is equivalent — both resolve ' +
          'the provider from the token and check the CURRENT assignment.',
      },
    ],
    callers: { customerMobile: 'n/a', customerWeb: 'n/a', providerMobile: 'legacy', providerWeb: 'legacy', admin: 'n/a' },
    observability: 'provider-jobs',
  },
  {
    id: 'provider.jobs.start',
    domain: 'provider-jobs',
    method: 'post',
    path: '/provider/jobs/:bookingId/start',
    summary: 'Starts the job. Requires the customer worker code.',
    auth: 'provider',
    idempotent: false,
    replayGuard:
      'An Idempotency-Key replays the original result. Without one, the machine ' +
      'refuses the repeat because the booking has already left ARRIVED.',
    requestSchema: 'BookingActionRequest',
    responseSchema: 'BookingTransitionResult',
    errors: [
      'VALIDATION_FAILED', 'BOOKING_NOT_FOUND', 'BOOKING_ACCESS_DENIED',
      'BOOKING_STATE_CONFLICT', 'BOOKING_TRANSITION_INVALID', 'BOOKING_TERMINAL',
      'BOOKING_WORKER_CODE_INVALID', 'PROVIDER_ROLE_REQUIRED',
      'IDEMPOTENCY_KEY_INVALID', 'IDEMPOTENCY_KEY_REUSED',
    ],
    params: [{ name: 'bookingId', type: 'integer', description: 'bookings.id' }],
    status: 'implemented',
    domainService: 'services/booking/transitionExecutor.transitionBooking (PROVIDER_START)',
    legacy: [
      {
        method: 'put',
        path: '/api/worker/bookings/:bookingId/start',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'The live provider action. Still writes status directly via technicianService; ' +
          'Phase B of the executor migration. Authorization is equivalent — both resolve ' +
          'the provider from the token and check the CURRENT assignment.',
      },
    ],
    callers: { customerMobile: 'n/a', customerWeb: 'n/a', providerMobile: 'legacy', providerWeb: 'legacy', admin: 'n/a' },
    observability: 'provider-jobs',
    notes:
      'The worker code is the six-digit secret the CUSTOMER reads out. It is the only '
      + 'gate on starting a chargeable job, so it is rate-limited per provider and is '
      + 'redacted before the timeline records the transition.',
  },
  {
    id: 'provider.jobs.complete',
    domain: 'provider-jobs',
    method: 'post',
    path: '/provider/jobs/:bookingId/complete',
    summary: 'Completes the job.',
    auth: 'provider',
    idempotent: false,
    replayGuard:
      'An Idempotency-Key replays the original result. Without one, the machine ' +
      'refuses the repeat because the booking has already left IN_PROGRESS.',
    requestSchema: 'BookingActionRequest',
    responseSchema: 'BookingTransitionResult',
    errors: [
      'VALIDATION_FAILED', 'BOOKING_NOT_FOUND', 'BOOKING_ACCESS_DENIED',
      'BOOKING_STATE_CONFLICT', 'BOOKING_TRANSITION_INVALID', 'BOOKING_TERMINAL',
      'PROVIDER_ROLE_REQUIRED',
      'IDEMPOTENCY_KEY_INVALID', 'IDEMPOTENCY_KEY_REUSED',
    ],
    params: [{ name: 'bookingId', type: 'integer', description: 'bookings.id' }],
    status: 'implemented',
    domainService: 'services/booking/transitionExecutor.transitionBooking (PROVIDER_COMPLETE)',
    legacy: [
      {
        method: 'put',
        path: '/api/worker/bookings/:bookingId/complete',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'The live provider action. Still writes status directly via technicianService; ' +
          'Phase B of the executor migration. Authorization is equivalent — both resolve ' +
          'the provider from the token and check the CURRENT assignment.',
      },
    ],
    callers: { customerMobile: 'n/a', customerWeb: 'n/a', providerMobile: 'legacy', providerWeb: 'legacy', admin: 'n/a' },
    observability: 'provider-jobs',
  },
  {
    id: 'admin.bookings.list',
    domain: 'admin-bookings',
    method: 'get',
    path: '/admin/bookings',
    summary: 'Admin booking operations list.',
    auth: 'admin',
    idempotent: true,
    responseSchema: 'AdminBookingList',
    errors: ['PERMISSION_REQUIRED'],
    status: 'planned',
    domainService: 'services/adminBookingService.listBookings',
    legacy: [
      {
        method: 'get',
        path: '/api/admin/bookings',
        disposition: 'CANONICALIZE',
        note:
          'The admin portal is the only caller and deploys from git on every push, so it is the ' +
          'cheapest client to migrate — but it is also the only one whose list carries ' +
          'permission-scoped columns, so the DTO needs the permission model resolved first.',
      },
    ],
    callers: { customerMobile: 'n/a', customerWeb: 'n/a', providerMobile: 'n/a', providerWeb: 'n/a', admin: 'legacy' },
    observability: 'admin-bookings',
  },
];

export const IMPLEMENTED = V1_CONTRACT.filter((e) => e.status === 'implemented');
export const PLANNED = V1_CONTRACT.filter((e) => e.status === 'planned');

export const contractById = (id: string): ContractEntry | undefined =>
  V1_CONTRACT.find((e) => e.id === id);

/** Full mounted path, e.g. `/api/v1/catalog/services/:serviceId`. */
export const fullPath = (entry: ContractEntry): string => `${V1_PREFIX}${entry.path}`;
