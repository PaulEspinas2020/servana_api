# API Endpoint Registry — canonical v1

> GENERATED from `src/api/v1/contract.ts` by `npm run api:docs`. Do not edit by hand —
> `tests/v1-contract.test.ts` fails if this file and the contract disagree.

**34 implemented** · **4 planned** · 38 total.

A `planned` entry is documented and **not mounted**. It exists so the migration matrix can
name a canonical successor before that successor is built. Calling one returns 404.

Caller legend: ✅ migrated · ⏳ still on a legacy route · · planned · — not applicable.

## catalog

| Method | Path | Status | Auth | Request | Response | Idem | Owner |
|---|---|---|---|---|---|---|---|
| `GET` | `/api/v1/catalog` | **live** | public | — | `CatalogTree` | yes | catalog |
| `GET` | `/api/v1/catalog/summary` | **live** | public | — | `CatalogSummary` | yes | catalog |
| `GET` | `/api/v1/catalog/services` | **live** | public | — | `CatalogServiceList` | yes | catalog |
| `GET` | `/api/v1/catalog/services/:serviceId` | **live** | public | — | `CatalogServiceDetail` | yes | catalog |
| `GET` | `/api/v1/catalog/search` | **live** | public | — | `SearchResults` | yes | catalog |
| `GET` | `/api/v1/catalog/categories` | **live** | public | — | `CategorySummaryList` | yes | catalog |
| `GET` | `/api/v1/catalog/categories/:categoryId` | **live** | public | — | `CategoryDetail` | yes | catalog |
| `GET` | `/api/v1/catalog/categories/:categoryId/subcategories` | **live** | public | — | `SubcategorySummaryList` | yes | catalog |
| `GET` | `/api/v1/catalog/subcategories/:subcategoryId` | **live** | public | — | `SubcategoryDetail` | yes | catalog |
| `GET` | `/api/v1/catalog/subcategories/:subcategoryId/services` | **live** | public | — | `CatalogServiceList` | yes | catalog |

### `GET /api/v1/catalog`

The full public catalog tree: categories, their subcategories and their services.

- **Domain service** — `services/catalogPublicService.getPublicCatalog + getPublicCatalogSummary`
- **Error codes** — `INTERNAL`
- **Callers** — Cust Mobile · · Cust Web · · Prov Mobile — · Prov Web — · Admin —
- **Legacy it replaces**
  - `GET /api/catalog` — **ALIAS_TEMPORARILY** — Shadowed by booking.routes GET /:id until this command reordered the mounts. Never deployed, has no installed caller, and is superseded by this route — but it stays because the unpushed 2bdaf0d advertised it and removing a path in the same session it was fixed would be two contradictory signals to the Client team.
  - `GET /api/services/full` — **CANONICALIZE** — The legacy LEVEL-2/LEVEL-3 projection the customer app reads today. Cannot be retired until ServanaClient migrates: it is the only catalog either Flutter app has ever consumed.

### `GET /api/v1/catalog/summary`

Counts and last-updated stamp for the catalog, for cache validation.

- **Domain service** — `services/catalogPublicService.getPublicCatalogSummary`
- **Error codes** — `INTERNAL`
- **Callers** — Cust Mobile · · Cust Web · · Prov Mobile — · Prov Web — · Admin —
- **Legacy it replaces**
  - `GET /api/catalog/summary` — **ALIAS_TEMPORARILY** — Same router, superseded by this route.

### `GET /api/v1/catalog/services`

Flat list of every bookable service, for search and deep links.

- **Domain service** — `services/catalogPublicService.listPublicServices`
- **Error codes** — `INTERNAL`
- **Callers** — Cust Mobile · · Cust Web · · Prov Mobile — · Prov Web — · Admin —
- **Legacy it replaces**
  - `GET /api/catalog/services` — **ALIAS_TEMPORARILY** — Same router, superseded by this route.

### `GET /api/v1/catalog/services/:serviceId`

One service by its canonical services.id, including its place in the hierarchy.

> Deliberately NOT status-filtered: an archived deep link resolves to an honest "unavailable" rather than a 404 dead end. `available` folds in subcategory and category status.

- **Domain service** — `services/catalogPublicService.getServiceDetail`
- **Error codes** — `CATALOG_SERVICE_NOT_FOUND`, `INTERNAL`, `VALIDATION_FAILED`
- **Path params** — `serviceId` (integer) Canonical services.id
- **Callers** — Cust Mobile · · Cust Web · · Prov Mobile — · Prov Web — · Admin —
- **Legacy it replaces**
  - `GET /api/catalog/services/:serviceId` — **ALIAS_TEMPORARILY** — Same router, superseded by this route.

### `GET /api/v1/catalog/search`

Alias of /search, scoped under the catalog namespace.

> The command named both paths as the target. Both are mounted and both call the SAME function — two paths, one implementation, which is a naming convenience rather than a second search. If it ever becomes two implementations it is a defect, and tests/v1-catalog-contract.test.ts asserts the shared handler.

- **Domain service** — `services/catalogSearchService.searchCatalog`
- **Error codes** — `INTERNAL`, `VALIDATION_FAILED`
- **Query** — `q` (string, required) Search term.; `types` (string) Comma-separated entity types.; `limit` (integer) Max hits, 1-50, default 20.
- **Callers** — Cust Mobile · · Cust Web · · Prov Mobile — · Prov Web — · Admin —
- **Legacy it replaces** — none; new capability.

### `GET /api/v1/catalog/categories`

Lightweight Category summaries with counts, no nested children.

> The counterpart to GET /catalog, which returns the whole tree. A category chooser needing three names should not receive 95 services with prices and images.

- **Domain service** — `services/catalogPublicService.listCategories`
- **Error codes** — `INTERNAL`
- **Callers** — Cust Mobile · · Cust Web · · Prov Mobile — · Prov Web — · Admin —
- **Legacy it replaces** — none; new capability.

### `GET /api/v1/catalog/categories/:categoryId`

One Category by canonical catalog_categories.id.

> Not status-filtered: a deep link to a deactivated Category lands on an honest `available: false`.

- **Domain service** — `services/catalogPublicService.getCategory`
- **Error codes** — `CATALOG_CATEGORY_NOT_FOUND`, `INTERNAL`, `VALIDATION_FAILED`
- **Path params** — `categoryId` (integer) Canonical catalog_categories.id — NOT a service_families.id.
- **Callers** — Cust Mobile · · Cust Web · · Prov Mobile — · Prov Web — · Admin —
- **Legacy it replaces** — none; new capability.

### `GET /api/v1/catalog/categories/:categoryId/subcategories`

The Subcategories of one Category.

> 404s on a missing Category rather than returning an empty list — empty and missing are different facts.

- **Domain service** — `services/catalogPublicService.listSubcategoriesOfCategory`
- **Error codes** — `CATALOG_CATEGORY_NOT_FOUND`, `INTERNAL`, `VALIDATION_FAILED`
- **Path params** — `categoryId` (integer) Canonical catalog_categories.id.
- **Callers** — Cust Mobile ⏳ · Cust Web · · Prov Mobile — · Prov Web — · Admin —
- **Legacy it replaces**
  - `GET /api/services/:serviceId/level2` — **CANONICALIZE** — The legacy equivalent, and NOT a rename. Its `:serviceId` is a service_families.id and it returns DISTINCT level_2 STRINGS with no ids at all. This route takes a catalog_categories.id and returns identified Subcategories. Different input, different output, different table.

### `GET /api/v1/catalog/subcategories/:subcategoryId`

One Subcategory by canonical catalog_subcategories.id.

> `available` folds in the parent Category, as service detail folds in both ancestors.

- **Domain service** — `services/catalogPublicService.getSubcategory`
- **Error codes** — `CATALOG_SUBCATEGORY_NOT_FOUND`, `INTERNAL`, `VALIDATION_FAILED`
- **Path params** — `subcategoryId` (integer) Canonical catalog_subcategories.id.
- **Callers** — Cust Mobile · · Cust Web · · Prov Mobile — · Prov Web — · Admin —
- **Legacy it replaces** — none; new capability.

### `GET /api/v1/catalog/subcategories/:subcategoryId/services`

The Services of one Subcategory.

- **Domain service** — `services/catalogPublicService.listServicesOfSubcategory`
- **Error codes** — `CATALOG_SUBCATEGORY_NOT_FOUND`, `INTERNAL`, `VALIDATION_FAILED`
- **Path params** — `subcategoryId` (integer) Canonical catalog_subcategories.id.
- **Callers** — Cust Mobile · · Cust Web · · Prov Mobile ⏳ · Prov Web — · Admin —
- **Legacy it replaces**
  - `GET /api/services/:serviceId/options-with-addons` — **CANONICALIZE** — The legacy shape. Its `:serviceId` is a service_families.id and it returns level_2 / level_3 option groups, not Services. ServanaWorker calls the un-prefixed twin instead, which is the only catalog route without the /services/ prefix its neighbours use.
  - `GET /api/:serviceId/options-with-addons` — **ALIAS_TEMPORARILY** — The original un-prefixed form, and what ServanaWorker calls in production. It cannot be retired until that app moves; the customer app followed the convention instead of the exception and 404d for months as a result.

## identity

| Method | Path | Status | Auth | Request | Response | Idem | Owner |
|---|---|---|---|---|---|---|---|
| `GET` | `/api/v1/me` | **live** | any signed-in | — | `Identity` | yes | identity |

### `GET /api/v1/me`

The authenticated caller, whatever their role.

- **Domain service** — `services/identityService.getIdentity`
- **Error codes** — `INTERNAL`, `NOT_FOUND`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`
- **Callers** — Cust Mobile · · Cust Web · · Prov Mobile · · Prov Web ⏳ · Admin ·
- **Legacy it replaces**
  - `GET /api/auth/me` — **ALIAS_TEMPORARILY** — Provider Web reads this on every session bootstrap. It now delegates to the same identityService.getIdentity this route uses, so the two cannot drift; only the envelope differs.
  - `GET /api/user/profile` — **ROLE_SPECIFIC** — Not a duplicate: returns the CUSTOMER profile aggregate (addresses, preferences), not the identity record. Retained; a v1 successor belongs in the customer-profile domain command, not here.

## bookings

| Method | Path | Status | Auth | Request | Response | Idem | Owner |
|---|---|---|---|---|---|---|---|
| `GET` | `/api/v1/bookings` | **live** | any signed-in | — | `BookingList` | yes | bookings |
| `GET` | `/api/v1/bookings/:bookingId` | **live** | any signed-in | — | `Booking` | yes | bookings |
| `GET` | `/api/v1/bookings/:bookingId/timeline` | **live** | any signed-in | — | `BookingTimeline` | yes | bookings |

### `GET /api/v1/bookings`

The caller's own bookings. Identity comes from the token, never from a parameter.

> Paginated at the API boundary. The underlying service returns the whole set, so this bounds the RESPONSE, not the query — noted in the matrix as a follow-up for the bookings domain command.

- **Domain service** — `services/bookingService.getBookingsByUserId + formatBookings`
- **Error codes** — `INTERNAL`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`
- **Query** — `limit` (integer) Page size, 1-100, default 20; `offset` (integer) Rows to skip, default 0
- **Callers** — Cust Mobile ⏳ · Cust Web ⏳ · Prov Mobile — · Prov Web — · Admin —
- **Legacy it replaces**
  - `GET /api/users/:userId/bookings` — **ALIAS_TEMPORARILY** — Takes the customer uid from the PATH and then asserts it equals the token subject — so the parameter is decoration that has already caused one real BOLA. v1 drops it. ServanaClient and the customer web portal both still call the legacy form.

### `GET /api/v1/bookings/:bookingId`

One booking, if the caller is its customer, its active provider, or an admin.

- **Domain service** — `services/bookingAccessService.assertBookingAccess + bookingService.getBookingById`
- **Error codes** — `BOOKING_ACCESS_DENIED`, `BOOKING_NOT_FOUND`, `INTERNAL`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Path params** — `bookingId` (integer) bookings.id
- **Callers** — Cust Mobile ⏳ · Cust Web ⏳ · Prov Mobile ⏳ · Prov Web · · Admin ·
- **Legacy it replaces**
  - `GET /api/:id` — **ALIAS_TEMPORARILY** — A single-segment wildcard at the API root. It is the reason no unknown one-segment GET can 404, and it swallowed GET /api/catalog. It is a live protected-client contract (§5) so it cannot be moved, but every new client must use the v1 form. Retirement is gated on telemetry showing zero non-numeric ids and zero legacy callers.

### `GET /api/v1/bookings/:bookingId/timeline`

A booking's operational history, voiced for the customer.

- **Domain service** — `services/bookingAccessService.assertBookingAccess + bookingService.getCustomerBookingTimeline`
- **Error codes** — `BOOKING_ACCESS_DENIED`, `BOOKING_NOT_FOUND`, `INTERNAL`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Path params** — `bookingId` (integer) bookings.id
- **Callers** — Cust Mobile ⏳ · Cust Web · · Prov Mobile — · Prov Web — · Admin —
- **Legacy it replaces**
  - `GET /api/:id/timeline` — **ALIAS_TEMPORARILY** — Same handler chain; v1 is the unambiguous path.
  - `GET /api/provider/bookings/:bookingId/timeline` — **ROLE_SPECIFIC** — Genuinely role-specific: the shared builder is written from the provider's seat, where "YOU" means the provider. Same domain service, different voicing. Documented rather than merged.

## provider-jobs

| Method | Path | Status | Auth | Request | Response | Idem | Owner |
|---|---|---|---|---|---|---|---|
| `GET` | `/api/v1/provider/jobs` | **live** | provider (role 2/4) | — | `JobCardList` | yes | provider-jobs |
| `GET` | `/api/v1/provider/jobs/:bookingId` | **live** | provider (role 2/4) | — | `JobCard` | yes | provider-jobs |

### `GET /api/v1/provider/jobs`

The authenticated provider's job cards.

> Three paths, one domain service. This is the clearest centralization case in the backend: two clients, two shapes, one query.

- **Domain service** — `services/technicianService.getJobCardsByWorker + controllers/jobCardView.formatJobCard`
- **Error codes** — `INTERNAL`, `PROVIDER_ROLE_REQUIRED`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`
- **Query** — `limit` (integer) Page size, 1-100, default 50; `offset` (integer) Rows to skip, default 0
- **Callers** — Cust Mobile — · Cust Web — · Prov Mobile ⏳ · Prov Web ⏳ · Admin —
- **Legacy it replaces**
  - `GET /api/worker/job-cards` — **ALIAS_TEMPORARILY** — Provider Web calls this today. Same service, same view function, legacy envelope (a bare array).
  - `GET /api/workers/:workerId/job-cards` — **ALIAS_TEMPORARILY** — ServanaWorker calls this. Takes the provider uid from the PATH; it is now behind verifyAuth + verifyOwnership, but the parameter remains a BOLA shape that v1 removes. Retirement gated on a ServanaWorker release.

### `GET /api/v1/provider/jobs/:bookingId`

One job card, scoped to the authenticated provider's own assignment.

- **Domain service** — `services/technicianService.getJobCardByWorker + controllers/jobCardView.formatJobCard`
- **Error codes** — `INTERNAL`, `NOT_FOUND`, `PROVIDER_ROLE_REQUIRED`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Path params** — `bookingId` (integer) bookings.id
- **Callers** — Cust Mobile — · Cust Web — · Prov Mobile · · Prov Web ⏳ · Admin —
- **Legacy it replaces**
  - `GET /api/worker/job-cards/:bookingId` — **ALIAS_TEMPORARILY** — Provider Web. Same service and view function.

## notifications

| Method | Path | Status | Auth | Request | Response | Idem | Owner |
|---|---|---|---|---|---|---|---|
| `GET` | `/api/v1/notifications` | **live** | any signed-in | — | `NotificationList` | yes | notifications |
| `GET` | `/api/v1/notifications/unread-count` | **live** | any signed-in | — | `UnreadCount` | yes | notifications |
| `PATCH` | `/api/v1/notifications/:key/read` | **live** | any signed-in | — | `NotificationMutation` | yes | notifications |
| `POST` | `/api/v1/notifications/read-all` | **live** | any signed-in | — | `NotificationMutation` | yes | notifications |

### `GET /api/v1/notifications`

The caller's notifications.

- **Domain service** — `services/notificationService.listCustomerNotifications`
- **Error codes** — `INTERNAL`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`
- **Query** — `filter` (string) Optional service-side filter key; `limit` (integer) Page size, 1-100, default 50; `offset` (integer) Rows to skip, default 0
- **Callers** — Cust Mobile ⏳ · Cust Web ⏳ · Prov Mobile — · Prov Web — · Admin —
- **Legacy it replaces**
  - `GET /api/user/notifications` — **ALIAS_TEMPORARILY** — Customer clients call this today.

### `GET /api/v1/notifications/unread-count`

How many unread notifications the caller has.

- **Domain service** — `services/notificationService.countCustomerUnreadNotifications`
- **Error codes** — `INTERNAL`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`
- **Callers** — Cust Mobile ⏳ · Cust Web ⏳ · Prov Mobile — · Prov Web — · Admin —
- **Legacy it replaces**
  - `GET /api/user/notifications/unread-count` — **ALIAS_TEMPORARILY** — Declared before /user/notifications/:key on the legacy router precisely so "unread-count" is not parsed as a notification key. v1 has the same ordering requirement and the shadow test now enforces it.

### `PATCH /api/v1/notifications/:key/read`

Marks one notification read. Repeating it is a no-op, not an error.

- **Domain service** — `services/notificationService.markCustomerNotificationReadByKey`
- **Error codes** — `INTERNAL`, `NOTIFICATION_NOT_ACTIONABLE`, `NOTIFICATION_NOT_FOUND`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Path params** — `key` (string) Opaque notification key
- **Callers** — Cust Mobile ⏳ · Cust Web ⏳ · Prov Mobile — · Prov Web — · Admin —
- **Legacy it replaces**
  - `PATCH /api/user/notifications/:key/read` — **ALIAS_TEMPORARILY** — Same service and the same key validation. The path differs only in the /user prefix, which named the caller rather than the resource.

### `POST /api/v1/notifications/read-all`

Marks every notification read. Naturally idempotent.

- **Domain service** — `services/notificationService.markAllCustomerNotificationsRead`
- **Error codes** — `INTERNAL`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`
- **Callers** — Cust Mobile ⏳ · Cust Web ⏳ · Prov Mobile — · Prov Web — · Admin —
- **Legacy it replaces**
  - `POST /api/user/notifications/mark-all-read` — **ALIAS_TEMPORARILY** — Same service; v1 uses the resource-shaped path.

## reviews

| Method | Path | Status | Auth | Request | Response | Idem | Owner |
|---|---|---|---|---|---|---|---|
| `GET` | `/api/v1/reviews/providers/:providerUid` | **live** | public | — | `ProviderReviewList` | yes | reviews |
| `GET` | `/api/v1/reviews/providers/:providerUid/rating` | **live** | public | — | `ProviderRating` | yes | reviews |

### `GET /api/v1/reviews/providers/:providerUid`

A provider's published reviews. No customer identity is projected.

- **Domain service** — `services/customerReviewService.listProviderReviews`
- **Error codes** — `INTERNAL`, `VALIDATION_FAILED`
- **Path params** — `providerUid` (string) Canonical provider uid
- **Query** — `limit` (integer) Page size, 1-50, default 20; `offset` (integer) Rows to skip, default 0
- **Callers** — Cust Mobile · · Cust Web · · Prov Mobile — · Prov Web — · Admin —
- **Legacy it replaces**
  - `GET /api/providers/:providerUid/reviews` — **ALIAS_TEMPORARILY** — Same service. The legacy form does not clamp limit/offset; v1 does (BE-10).

### `GET /api/v1/reviews/providers/:providerUid/rating`

A provider's aggregate rating.

- **Domain service** — `services/customerReviewService.getProviderAggregate`
- **Error codes** — `INTERNAL`, `VALIDATION_FAILED`
- **Path params** — `providerUid` (string) Canonical provider uid
- **Callers** — Cust Mobile · · Cust Web · · Prov Mobile — · Prov Web — · Admin —
- **Legacy it replaces**
  - `GET /api/providers/:providerUid/rating` — **ALIAS_TEMPORARILY** — Same service. Kept because it sits beside the reviews list that a future customer client may already be calling; retiring one without the other would be half a change.

## settings

| Method | Path | Status | Auth | Request | Response | Idem | Owner |
|---|---|---|---|---|---|---|---|
| `GET` | `/api/v1/settings/notification-preferences` | **live** | any signed-in | — | `NotificationPreferences` | yes | settings |
| `PUT` | `/api/v1/settings/notification-preferences` | **live** | any signed-in | `NotificationPreferences` | `NotificationPreferences` | yes | settings |

### `GET /api/v1/settings/notification-preferences`

The caller's notification preferences.

> Three legacy paths, one uid-keyed service, and two of the three are gated on a provider role for a preference table that has no role column. The role gate is the accident, not the capability.

- **Domain service** — `services/notificationService.getNotificationPrefs`
- **Error codes** — `INTERNAL`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`
- **Callers** — Cust Mobile · · Cust Web · · Prov Mobile ⏳ · Prov Web ⏳ · Admin —
- **Legacy it replaces**
  - `GET /api/provider/notification-preferences` — **ALIAS_TEMPORARILY** — Provider Web. Same uid-keyed service — nothing about it is provider-specific.
  - `GET /api/workers/:uid/notification-preferences` — **ALIAS_TEMPORARILY** — ServanaWorker. Same service, uid taken from the path instead of the token.

### `PUT /api/v1/settings/notification-preferences`

Replaces the caller's notification preferences. Idempotent by construction.

- **Domain service** — `services/notificationService.saveNotificationPrefs`
- **Error codes** — `INTERNAL`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Callers** — Cust Mobile · · Cust Web · · Prov Mobile ⏳ · Prov Web ⏳ · Admin —
- **Legacy it replaces**
  - `PUT /api/provider/notification-preferences` — **ALIAS_TEMPORARILY** — Provider Web. Same service.
  - `PUT /api/workers/:uid/notification-preferences` — **ALIAS_TEMPORARILY** — ServanaWorker. Same service.

## auth

| Method | Path | Status | Auth | Request | Response | Idem | Owner |
|---|---|---|---|---|---|---|---|
| `POST` | `/api/v1/auth/register` | **live** | public | `RegisterRequest` | `RegisterResult` | no | auth |
| `POST` | `/api/v1/auth/login` | **live** | public | `LoginRequest` | `Session` | no | auth |
| `POST` | `/api/v1/auth/refresh` | **live** | public | `RefreshRequest` | `Session` | no | auth |
| `POST` | `/api/v1/auth/logout` | **live** | any signed-in | — | `LogoutResult` | yes | auth |
| `POST` | `/api/v1/auth/forgot-password` | **live** | public | `ForgotPasswordRequest` | `NeutralAck` | yes | auth |
| `POST` | `/api/v1/auth/reset-password` | **live** | public | `ResetPasswordRequest` | `NeutralAck` | no | auth |
| `POST` | `/api/v1/auth/verify-email` | **live** | public | `VerifyEmailRequest` | `VerificationResult` | no | auth |
| `POST` | `/api/v1/auth/resend-verification` | **live** | public | `ResendVerificationRequest` | `NeutralAck` | yes | auth |
| `POST` | `/api/v1/auth/verify-mobile` | **live** | any signed-in | `VerifyMobileRequest` | `VerificationResult` | yes | auth |

### `POST /api/v1/auth/register`

Creates an account from an email + password, or from a Firebase ID token.

> Registration answers identity only. Provider onboarding, service selection and profile completion are separate domains and are NOT triggered from here beyond the existing non-blocking attribution hooks the legacy path already fires.

- **Domain service** — `services/auth.service.registerUser \| services/firebaseFunctions.service.firebaseProviderRegister`
- **Error codes** — `ACCOUNT_LINK_REQUIRED`, `INTERNAL`, `RATE_LIMITED`, `REGISTRATION_REJECTED`, `VALIDATION_FAILED`, `WEAK_PASSWORD`
- **Callers** — Cust Mobile ⏳ · Cust Web · · Prov Mobile ⏳ · Prov Web ⏳ · Admin —
- **Legacy it replaces**
  - `POST /api/auth/signup` — **ALIAS_TEMPORARILY** — Email + password registration. Same service; v1 accepts either credential kind on one path instead of splitting them across two routes with two response shapes.
  - `POST /api/auth/provider/register` — **ALIAS_TEMPORARILY** — Firebase-token registration, provider-shaped. Same service. Its 403 for a non-provider role is preserved in v1 as an audience assertion rather than a separate path.
  - `POST /api/auth/add-employees` — **ROLE_SPECIFIC** — Admin bulk-creates provider accounts with generated temporary passwords. Genuinely different: a different actor, a different credential origin, and a partial-success response shape. Retained; it is account PROVISIONING, not registration.

### `POST /api/v1/auth/login`

One sign-in for every identifier and every surface: email or mobile + password, or a Firebase ID token.

> Mobile + password works only for an account that also has an email: Firebase is the password authority and its password grant is keyed on email. An account with a mobile and no email gets PASSWORD_NOT_AVAILABLE and must use the token path — stated, not guessed.

- **Domain service** — `services/authLoginService → services/auth.service.loggedInUser \| firebaseFunctions.firebaseAuthLogin`
- **Error codes** — `ACCOUNT_DISABLED`, `ACCOUNT_LINK_REQUIRED`, `ACCOUNT_UNVERIFIED`, `AUDIENCE_MISMATCH`, `INTERNAL`, `INVALID_CREDENTIALS`, `PASSWORD_NOT_AVAILABLE`, `RATE_LIMITED`, `VALIDATION_FAILED`
- **Callers** — Cust Mobile ⏳ · Cust Web ⏳ · Prov Mobile ⏳ · Prov Web ⏳ · Admin ⏳
- **Legacy it replaces**
  - `POST /api/auth/signin` — **ALIAS_TEMPORARILY** — Email + password. v1 calls the same `authService.loggedInUser` and adds identifier resolution in front of it, so a mobile number now names the account.
  - `POST /api/auth/admin-signin` — **ALIAS_TEMPORARILY** — Identical to /auth/signin plus a role-1 gate. The gate is a property of the CALLER, not the credential, so v1 takes it as `audience: "admin"` rather than as a second path.
  - `POST /api/auth/firebase-login` — **ALIAS_TEMPORARILY** — Firebase ID token, provider-shaped. Same service; v1 expresses the role gate as an audience.
  - `POST /api/auth/customer-firebase-login` — **ROLE_SPECIFIC** — NOT collapsed. Its link-collision contract is a 200 carrying `status: "failed"` and no token, because the installed customer app throws on any non-2xx before reading the body and fires onUnauthorized on 401 — either would show "session expired" to somebody who has no session yet. Changing that shape is a client release, so it stays until the customer app migrates.

### `POST /api/v1/auth/refresh`

Exchanges a refresh token for a fresh session.

- **Domain service** — `services/tokenRefreshService.refreshIdToken`
- **Error codes** — `INTERNAL`, `RATE_LIMITED`, `REFRESH_TOKEN_INVALID`, `REFRESH_UNAVAILABLE`, `VALIDATION_FAILED`
- **Callers** — Cust Mobile ⏳ · Cust Web ⏳ · Prov Mobile ⏳ · Prov Web ⏳ · Admin ⏳
- **Legacy it replaces**
  - `POST /api/auth/refresh` — **ALIAS_TEMPORARILY** — Same service. Unauthenticated by design on both: the caller is here BECAUSE their ID token expired, so requiring a valid one would be circular. The refresh token is the credential and Google validates it.

### `POST /api/v1/auth/logout`

Ends every session for the authenticated account and clears its push token.

> Ends ALL sessions, not this device only. Firebase has no per-session revocation, and a logout that silently left other devices signed in would be worse than one that says so.

- **Domain service** — `services/authSessionService.endAllSessions`
- **Error codes** — `INTERNAL`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`
- **Callers** — Cust Mobile ⏳ · Cust Web ⏳ · Prov Mobile ⏳ · Prov Web ⏳ · Admin ⏳
- **Legacy it replaces**
  - `POST /api/auth/logout` — **ALIAS_TEMPORARILY** — Same effect; both now go through the one session service so the side-effect set is decided once.

### `POST /api/v1/auth/forgot-password`

Starts password recovery. Always answers the same way, whether or not the account exists.

> EMAIL ONLY today. Recovery requires a VERIFIED identifier, and mobile recovery would need an SMS sender this platform does not have — so it is refused rather than half-built. The response is identical for an unknown address, an unverified one and a mobile number.

- **Domain service** — `services/auth.service.forgotPassword`
- **Error codes** — `INTERNAL`, `RATE_LIMITED`, `VALIDATION_FAILED`
- **Callers** — Cust Mobile ⏳ · Cust Web ⏳ · Prov Mobile ⏳ · Prov Web ⏳ · Admin ⏳
- **Legacy it replaces**
  - `POST /api/auth/forgot-password` — **ALIAS_TEMPORARILY** — Same service, same neutral acknowledgement, same platform-scoped continue URL.

### `POST /api/v1/auth/reset-password`

Completes a password reset and ends every existing session.

- **Domain service** — `services/auth.service.resetPassword → services/authSessionService.endSessionsOnCredentialChange`
- **Error codes** — `INTERNAL`, `RATE_LIMITED`, `RESET_TOKEN_INVALID`, `VALIDATION_FAILED`, `WEAK_PASSWORD`
- **Callers** — Cust Mobile ⏳ · Cust Web ⏳ · Prov Mobile ⏳ · Prov Web ⏳ · Admin ⏳
- **Legacy it replaces**
  - `POST /api/auth/reset-password` — **ALIAS_TEMPORARILY** — Same service — and the session revocation added in this command applies to BOTH, because it lives in the service rather than in either handler.

### `POST /api/v1/auth/verify-email`

Verifies an email address with a one-time code issued for registration.

- **Domain service** — `services/otpService.verifyEmailOtp + services/auth.service.verifyEmailOtp`
- **Error codes** — `INTERNAL`, `OTP_EXPIRED`, `OTP_INVALID`, `RATE_LIMITED`, `VALIDATION_FAILED`
- **Callers** — Cust Mobile ⏳ · Cust Web · · Prov Mobile ⏳ · Prov Web · · Admin —
- **Legacy it replaces**
  - `POST /api/auth/verify-email-otp` — **ALIAS_TEMPORARILY** — Same service. v1 scopes the read to the REGISTRATION_VERIFICATION purpose, so a code minted for a different purpose can never satisfy it.

### `POST /api/v1/auth/resend-verification`

Re-sends an email verification code or link. Always answers the same way.

- **Domain service** — `services/auth.service.resendEmailOtp \| getAndSendEmailVerificationLink`
- **Error codes** — `INTERNAL`, `RATE_LIMITED`, `VALIDATION_FAILED`
- **Callers** — Cust Mobile ⏳ · Cust Web · · Prov Mobile ⏳ · Prov Web ⏳ · Admin —
- **Legacy it replaces**
  - `POST /api/auth/resend-email-otp` — **ALIAS_TEMPORARILY** — Same service. v1 takes `channel: "otp" \| "link"` instead of splitting the two across paths.
  - `GET /api/auth/resendverification` — **ALIAS_TEMPORARILY** — A GET that sends an email — a read path that writes and mails. v1 is a POST. The legacy form stays until both mobile clients move, because it is what they call today.

### `POST /api/v1/auth/verify-mobile`

Records a mobile number as verified, proven by a Firebase phone credential.

> There is no server-side SMS OTP and this does not add one. The proof is a Firebase ID token whose sign-in provider is `phone`, which Firebase only issues after its own OTP. The number must not already belong to another account — `accountLinkGuard` decides, and a collision is ACCOUNT_LINK_REQUIRED rather than a silent second account.

- **Domain service** — `services/identityVerificationSync.provenFrom + recordProvenIdentifiers, guarded by services/accountLinkGuard`
- **Error codes** — `ACCOUNT_LINK_REQUIRED`, `INTERNAL`, `INVALID_CREDENTIALS`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Callers** — Cust Mobile · · Cust Web · · Prov Mobile · · Prov Web · · Admin —
- **Legacy it replaces** — none; new capability.

## search

| Method | Path | Status | Auth | Request | Response | Idem | Owner |
|---|---|---|---|---|---|---|---|
| `GET` | `/api/v1/search` | **live** | public | — | `SearchResults` | yes | catalog |

### `GET /api/v1/search`

Search Categories, Subcategories and Services in one ranked result set.

> Every hit carries a qualified `ref` (`service:180`), so a mixed result set is keyable without the client inferring type from which array it arrived in. Aliases widen what a term MATCHES and never what exists — "aircon" and "air conditioning" return the same Services with the same ids.

- **Domain service** — `services/catalogSearchService.searchCatalog`
- **Error codes** — `INTERNAL`, `VALIDATION_FAILED`
- **Query** — `q` (string, required) Search term. Under 2 characters returns an empty result, not an error.; `types` (string) Comma-separated: category,subcategory,service. Default all three.; `limit` (integer) Max hits, 1-50, default 20.
- **Callers** — Cust Mobile ⏳ · Cust Web · · Prov Mobile — · Prov Web — · Admin —
- **Legacy it replaces**
  - `GET /api/services/full` — **CANONICALIZE** — Not a search endpoint — it is the whole legacy catalog, which ServanaClient downloads and searches ON THE DEVICE. That is why one absent `level2` key emptied the search cache and every query rendered "No services match your search". Retiring it needs the client to move to this route AND to /api/v1/catalog.

## home

| Method | Path | Status | Auth | Request | Response | Idem | Owner |
|---|---|---|---|---|---|---|---|
| `GET` | `/api/v1/home` | _planned_ | any signed-in | — | `HomeFeed` | yes | home |

### `GET /api/v1/home`

The composed customer home surface.

> No legacy equivalent exists. The customer home surface is assembled on the device from three or four separate calls, so there is nothing to alias — this is a new capability, and building it is a product decision about what home should contain rather than a migration. Listed here so the target architecture is complete.

- **Domain service** — `none yet — composed client-side today`
- **Error codes** — `INTERNAL`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`
- **Callers** — Cust Mobile · · Cust Web · · Prov Mobile — · Prov Web — · Admin —
- **Legacy it replaces** — none; new capability.

## conversations

| Method | Path | Status | Auth | Request | Response | Idem | Owner |
|---|---|---|---|---|---|---|---|
| `GET` | `/api/v1/conversations` | _planned_ | any signed-in | — | `ConversationList` | yes | messaging |

### `GET /api/v1/conversations`

The caller's booking conversations.

- **Domain service** — `chat/chat.service.listConversations`
- **Error codes** — `INTERNAL`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`
- **Callers** — Cust Mobile ⏳ · Cust Web ⏳ · Prov Mobile ⏳ · Prov Web ⏳ · Admin —
- **Legacy it replaces**
  - `GET /api/chat/conversations` — **CANONICALIZE** — Chat endpoints do NOT use the {status,data} envelope — the store reads a top-level `conversations` key. Re-enveloping under v1 is a real client change, so it is sequenced with the messaging domain command rather than bundled here.

## provider-earnings

| Method | Path | Status | Auth | Request | Response | Idem | Owner |
|---|---|---|---|---|---|---|---|
| `GET` | `/api/v1/provider/earnings` | _planned_ | provider (role 2/4) | — | `EarningsSummary` | yes | provider-earnings |

### `GET /api/v1/provider/earnings`

The authenticated provider's earnings summary.

> Money. Deliberately not adapted in a foundation command: the payout window is already documented as 48h in copy and 72h in reality, and a second read path before that is settled would give two answers to "when am I paid".

- **Domain service** — `services/technicianService (earnings family)`
- **Error codes** — `INTERNAL`, `PROVIDER_ROLE_REQUIRED`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`
- **Callers** — Cust Mobile — · Cust Web — · Prov Mobile · · Prov Web ⏳ · Admin —
- **Legacy it replaces**
  - `GET /api/provider/earnings` — **CANONICALIZE** — Provider Web reads this.
  - `GET /api/workers/:uid/earnings-history` — **ALIAS_TEMPORARILY** — No located caller in any of the five clients. Candidate for RETIRE once telemetry confirms.

## admin-bookings

| Method | Path | Status | Auth | Request | Response | Idem | Owner |
|---|---|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/bookings` | _planned_ | admin (role 1) | — | `AdminBookingList` | yes | admin-bookings |

### `GET /api/v1/admin/bookings`

Admin booking operations list.

- **Domain service** — `services/adminBookingService.listBookings`
- **Error codes** — `INTERNAL`, `PERMISSION_REQUIRED`, `ROLE_REQUIRED`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`
- **Callers** — Cust Mobile — · Cust Web — · Prov Mobile — · Prov Web — · Admin ⏳
- **Legacy it replaces**
  - `GET /api/admin/bookings` — **CANONICALIZE** — The admin portal is the only caller and deploys from git on every push, so it is the cheapest client to migrate — but it is also the only one whose list carries permission-scoped columns, so the DTO needs the permission model resolved first.

## Cross-client caller matrix

| Endpoint | Cust Mobile | Cust Web | Prov Mobile | Prov Web | Admin |
|---|---|---|---|---|---|
| `GET /api/v1/catalog` | · | · | — | — | — |
| `GET /api/v1/catalog/summary` | · | · | — | — | — |
| `GET /api/v1/catalog/services` | · | · | — | — | — |
| `GET /api/v1/catalog/services/:serviceId` | · | · | — | — | — |
| `GET /api/v1/me` | · | · | · | ⏳ | · |
| `GET /api/v1/bookings` | ⏳ | ⏳ | — | — | — |
| `GET /api/v1/bookings/:bookingId` | ⏳ | ⏳ | ⏳ | · | · |
| `GET /api/v1/bookings/:bookingId/timeline` | ⏳ | · | — | — | — |
| `GET /api/v1/provider/jobs` | — | — | ⏳ | ⏳ | — |
| `GET /api/v1/provider/jobs/:bookingId` | — | — | · | ⏳ | — |
| `GET /api/v1/notifications` | ⏳ | ⏳ | — | — | — |
| `GET /api/v1/notifications/unread-count` | ⏳ | ⏳ | — | — | — |
| `PATCH /api/v1/notifications/:key/read` | ⏳ | ⏳ | — | — | — |
| `POST /api/v1/notifications/read-all` | ⏳ | ⏳ | — | — | — |
| `GET /api/v1/reviews/providers/:providerUid` | · | · | — | — | — |
| `GET /api/v1/reviews/providers/:providerUid/rating` | · | · | — | — | — |
| `GET /api/v1/settings/notification-preferences` | · | · | ⏳ | ⏳ | — |
| `PUT /api/v1/settings/notification-preferences` | · | · | ⏳ | ⏳ | — |
| `POST /api/v1/auth/register` | ⏳ | · | ⏳ | ⏳ | — |
| `POST /api/v1/auth/login` | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| `POST /api/v1/auth/refresh` | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| `POST /api/v1/auth/logout` | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| `POST /api/v1/auth/forgot-password` | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| `POST /api/v1/auth/reset-password` | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| `POST /api/v1/auth/verify-email` | ⏳ | · | ⏳ | · | — |
| `POST /api/v1/auth/resend-verification` | ⏳ | · | ⏳ | ⏳ | — |
| `POST /api/v1/auth/verify-mobile` | · | · | · | · | — |
| `GET /api/v1/search` | ⏳ | · | — | — | — |
| `GET /api/v1/catalog/search` | · | · | — | — | — |
| `GET /api/v1/catalog/categories` | · | · | — | — | — |
| `GET /api/v1/catalog/categories/:categoryId` | · | · | — | — | — |
| `GET /api/v1/catalog/categories/:categoryId/subcategories` | ⏳ | · | — | — | — |
| `GET /api/v1/catalog/subcategories/:subcategoryId` | · | · | — | — | — |
| `GET /api/v1/catalog/subcategories/:subcategoryId/services` | · | · | ⏳ | — | — |
| `GET /api/v1/home` | · | · | — | — | — |
| `GET /api/v1/conversations` | ⏳ | ⏳ | ⏳ | ⏳ | — |
| `GET /api/v1/provider/earnings` | — | — | · | ⏳ | — |
| `GET /api/v1/admin/bookings` | — | — | — | — | ⏳ |
