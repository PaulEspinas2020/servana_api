# API Endpoint Registry — canonical v1

> GENERATED from `src/api/v1/contract.ts` by `npm run api:docs`. Do not edit by hand —
> `tests/v1-contract.test.ts` fails if this file and the contract disagree.

**114 implemented** · **0 planned** · 114 total.

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

## telemetry

| Method | Path | Status | Auth | Request | Response | Idem | Owner |
|---|---|---|---|---|---|---|---|
| `POST` | `/api/v1/telemetry` | **live** | any signed-in | `TelemetryIngestRequest` | `TelemetryIngestResult` | no | platform |

### `POST /api/v1/telemetry`

Accept a small, closed set of scrubbed worker-app events. No free text, ever.

> FIRST-PARTY by decision, not by default — see docs/TELEMETRY_DECISION.md. The worker app scrubs to an allowlist carrying no name, phone, location or token, but it still carries bookingRef, and RA 10173 s3(g) makes information personal when identity can be "reasonably and directly ascertained by the entity holding the information". Servana holds the bookings table. So the scrubbed payload is still personal data in our hands, and a foreign sink would be a cross-border transfer engaging s21 accountability, NPC model contractual clauses, and registration above 1,000 data subjects. The server re-scrubs from its own allowlist rather than trusting the client: a server that trusts a client's scrubbing has one control, not two.

- **Domain service** — `services/telemetryService.recordTelemetryEvents`
- **Error codes** — `INTERNAL`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Callers** — Cust Mobile — · Cust Web — · Prov Mobile · · Prov Web · · Admin —
- **Legacy it replaces** — none; new capability.

## health

| Method | Path | Status | Auth | Request | Response | Idem | Owner |
|---|---|---|---|---|---|---|---|
| `GET` | `/api/v1/client-config` | **live** | public | — | `ClientConfig` | yes | platform |
| `GET` | `/api/v1/health` | **live** | public | — | `BuildInfo` | yes | platform |
| `GET` | `/api/v1/openapi.json` | **live** | any signed-in | — | `OpenApiDocument` | yes | platform |

### `GET /api/v1/client-config`

The minimum client version that may run, per platform. The only recall a released mobile build has.

> Public because the client being recalled may be too old to authenticate, and a kill switch reachable only with a credential cannot kill the builds that most need it. Served from a JSON file, not the database: a recall is pulled during an incident, and the incident this platform actually had was every database-backed read returning 500 for six days. Editing the file takes effect within ~2 minutes with no restart and no deploy. The server fails OPEN — a missing or malformed file serves a permissive 0.0.0 floor — because the client fails CLOSED, and two closed halves would let one deleted file brick every installed app at once.

- **Domain service** — `api/v1/domains/clientConfig.readClientConfig`
- **Error codes** — `INTERNAL`
- **Callers** — Cust Mobile · · Cust Web — · Prov Mobile · · Prov Web — · Admin —
- **Legacy it replaces** — none; new capability.

### `GET /api/v1/health`

The commit this build was made from. Public, and carries nothing else.

> Reads dist/BUILD_INFO.json, which deploy.yml stamps on every deploy. It answers the one question a deploy cannot otherwise be asked from outside: which commit is actually serving. A deploy whose migration step fails stops short of the PM2 restart, so the old code keeps serving and nothing outward says so.

- **Domain service** — `api/v1/domains/health.readBuildInfo`
- **Error codes** — `INTERNAL`
- **Callers** — Cust Mobile — · Cust Web — · Prov Mobile — · Prov Web — · Admin —
- **Legacy it replaces** — none; new capability.

### `GET /api/v1/openapi.json`

The OpenAPI document this process implements, with its sha256 in a header.

> TAB 08. Before this the document was served at no path at all, so a client could only compare its pin against a git CHECKOUT — a statement about a repository, not about a server. The portal reported its pin going stale twice in one session and could not tell a shape change from an annotation-only one without diffing 530 kB by hand. AUTHENTICATED, not public, unlike health.build. Build provenance is four fields and exists to be checkable by someone who has no credential; a full API surface is a map, and every client that needs it already holds a token. `health.build` stays public because a provenance check that needs a credential can only be run by someone who already has one — that argument does not transfer to the whole contract. Every /api/v1 response also carries the same digest in x-contract-sha256, so a client detects staleness with one cheap request and no parsing, which is what the book asked for. This endpoint is for when the answer is yes and it wants the document. Answers in the usual v1 envelope. A bare document would be marginally more convenient for a generator pointed straight at the URL, and it would be the only endpoint of ninety-five that did not answer { data } — an exception to that shape is how the shape stops being relied upon.

- **Domain service** — `api/v1/domains/health.servedContract`
- **Error codes** — `INTERNAL`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`
- **Callers** — Cust Mobile · · Cust Web · · Prov Mobile · · Prov Web · · Admin ·
- **Legacy it replaces** — none; new capability.

## identity

| Method | Path | Status | Auth | Request | Response | Idem | Owner |
|---|---|---|---|---|---|---|---|
| `GET` | `/api/v1/me` | **live** | any signed-in | — | `Identity` | yes | identity |

### `GET /api/v1/me`

The authenticated caller, whatever their role.

- **Domain service** — `services/identityService.getIdentity`
- **Error codes** — `INTERNAL`, `NOT_FOUND`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`
- **Callers** — Cust Mobile · · Cust Web · · Prov Mobile ✅ · Prov Web ✅ · Admin ·
- **Legacy it replaces**
  - `GET /api/auth/me` — **ALIAS_TEMPORARILY** — Provider Web reads this on every session bootstrap. It now delegates to the same identityService.getIdentity this route uses, so the two cannot drift; only the envelope differs.
  - `GET /api/user/profile` — **ROLE_SPECIFIC** — Not a duplicate: returns the CUSTOMER profile aggregate (addresses, preferences), not the identity record. Retained; a v1 successor belongs in the customer-profile domain command, not here.

## bookings

| Method | Path | Status | Auth | Request | Response | Idem | Owner |
|---|---|---|---|---|---|---|---|
| `GET` | `/api/v1/bookings` | **live** | any signed-in | — | `BookingList` | yes | bookings |
| `GET` | `/api/v1/bookings/:bookingId` | **live** | any signed-in | — | `Booking` | yes | bookings |
| `GET` | `/api/v1/bookings/:bookingId/timeline` | **live** | any signed-in | — | `BookingTimeline` | yes | bookings |
| `POST` | `/api/v1/bookings/:bookingId/cancel` | **live** | any signed-in | `BookingActionRequest` | `BookingTransitionResult` | no | bookings |
| `GET` | `/api/v1/bookings/:bookingId/transitions` | **live** | any signed-in | — | `BookingTransitionList` | yes | bookings |

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

### `POST /api/v1/bookings/:bookingId/cancel`

Cancels the caller's own booking.

- **Domain service** — `services/booking/transitionExecutor.transitionBooking (CUSTOMER_CANCEL)`
- **Error codes** — `BOOKING_ACCESS_DENIED`, `BOOKING_NOT_FOUND`, `BOOKING_STATE_CONFLICT`, `BOOKING_TERMINAL`, `BOOKING_TRANSITION_INVALID`, `IDEMPOTENCY_KEY_INVALID`, `IDEMPOTENCY_KEY_REUSED`, `INTERNAL`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Path params** — `bookingId` (integer) bookings.id
- **Callers** — Cust Mobile ⏳ · Cust Web ⏳ · Prov Mobile — · Prov Web — · Admin —
- **Legacy it replaces**
  - `POST /api/bookings/:id/cancel` — **ALIAS_TEMPORARILY** — The live customer cancel. It still writes status directly and is Phase C of the executor migration — deliberately after the provider lifecycle, because cancellation touches fees, refunds and provider compensation and is the worst first test of whether the executor architecture works.

### `GET /api/v1/bookings/:bookingId/transitions`

The canonical transition history: one event per state change, oldest first.

> Preserves a reassigned provider's full progression — accepted, en route, reassigned — because the current state resetting must not erase history.

- **Domain service** — `services/booking/transitionExecutor.getBookingTimeline`
- **Error codes** — `BOOKING_ACCESS_DENIED`, `BOOKING_NOT_FOUND`, `INTERNAL`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Path params** — `bookingId` (integer) bookings.id
- **Callers** — Cust Mobile · · Cust Web · · Prov Mobile ✅ · Prov Web · · Admin ·
- **Legacy it replaces**
  - `GET /api/:id/timeline` — **KEEP** — NOT a duplicate. The legacy timeline is a re-voiced operational narrative built from per-stage timestamps for the customer to read. This is the append-only event log the executor writes inside each transaction — the evidence, not the story. Admin, Customer and Provider all read THIS to agree on what happened.

## provider-jobs

| Method | Path | Status | Auth | Request | Response | Idem | Owner |
|---|---|---|---|---|---|---|---|
| `GET` | `/api/v1/provider/jobs` | **live** | provider (role 2/4) | — | `JobCardList` | yes | provider-jobs |
| `GET` | `/api/v1/provider/jobs/:bookingId` | **live** | provider (role 2/4) | — | `JobCard` | yes | provider-jobs |
| `POST` | `/api/v1/provider/jobs/:bookingId/accept` | **live** | provider (role 2/4) | `BookingActionRequest` | `BookingTransitionResult` | no | provider-jobs |
| `POST` | `/api/v1/provider/jobs/:bookingId/decline` | **live** | provider (role 2/4) | `BookingActionRequest` | `BookingTransitionResult` | no | provider-jobs |
| `POST` | `/api/v1/provider/jobs/:bookingId/en-route` | **live** | provider (role 2/4) | `BookingActionRequest` | `BookingTransitionResult` | no | provider-jobs |
| `POST` | `/api/v1/provider/jobs/:bookingId/arrived` | **live** | provider (role 2/4) | `BookingActionRequest` | `BookingTransitionResult` | no | provider-jobs |
| `POST` | `/api/v1/provider/jobs/:bookingId/start` | **live** | provider (role 2/4) | `BookingActionRequest` | `BookingTransitionResult` | no | provider-jobs |
| `POST` | `/api/v1/provider/jobs/:bookingId/complete` | **live** | provider (role 2/4) | `BookingActionRequest` | `BookingTransitionResult` | no | provider-jobs |
| `POST` | `/api/v1/provider/jobs/:bookingId/cancel` | **live** | provider (role 2/4) | `BookingActionRequest` | `BookingTransitionResult` | no | provider-jobs |

### `GET /api/v1/provider/jobs`

The authenticated provider's job cards.

> Three paths, one domain service. This is the clearest centralization case in the backend: two clients, two shapes, one query.

- **Domain service** — `services/technicianService.getJobCardsByWorker + controllers/jobCardView.formatJobCard`
- **Error codes** — `INTERNAL`, `PROVIDER_ROLE_REQUIRED`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`
- **Query** — `limit` (integer) Page size, 1-100, default 50; `offset` (integer) Rows to skip, default 0
- **Callers** — Cust Mobile — · Cust Web — · Prov Mobile ✅ · Prov Web ✅ · Admin —
- **Legacy it replaces**
  - `GET /api/worker/job-cards` — **ALIAS_TEMPORARILY** — Provider Web calls this today. Same service, same view function, legacy envelope (a bare array).
  - `GET /api/workers/:workerId/job-cards` — **ALIAS_TEMPORARILY** — ServanaWorker calls this. Takes the provider uid from the PATH; it is now behind verifyAuth + verifyOwnership, but the parameter remains a BOLA shape that v1 removes. Retirement gated on a ServanaWorker release.

### `GET /api/v1/provider/jobs/:bookingId`

One job card, scoped to the authenticated provider's own assignment.

- **Domain service** — `services/technicianService.getJobCardByWorker + controllers/jobCardView.formatJobCard`
- **Error codes** — `INTERNAL`, `NOT_FOUND`, `PROVIDER_ROLE_REQUIRED`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Path params** — `bookingId` (integer) bookings.id
- **Callers** — Cust Mobile — · Cust Web — · Prov Mobile ✅ · Prov Web ✅ · Admin —
- **Legacy it replaces**
  - `GET /api/worker/job-cards/:bookingId` — **ALIAS_TEMPORARILY** — Provider Web. Same service and view function.

### `POST /api/v1/provider/jobs/:bookingId/accept`

Accepts the assignment.

- **Domain service** — `services/booking/transitionExecutor.transitionBooking (PROVIDER_ACCEPT)`
- **Error codes** — `BOOKING_ACCESS_DENIED`, `BOOKING_NOT_FOUND`, `BOOKING_STATE_CONFLICT`, `BOOKING_TERMINAL`, `BOOKING_TRANSITION_INVALID`, `IDEMPOTENCY_KEY_INVALID`, `IDEMPOTENCY_KEY_REUSED`, `INTERNAL`, `PROVIDER_ROLE_REQUIRED`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Path params** — `bookingId` (integer) bookings.id
- **Callers** — Cust Mobile — · Cust Web — · Prov Mobile ✅ · Prov Web ✅ · Admin —
- **Legacy it replaces**
  - `PUT /api/worker/bookings/:bookingId/accept` — **ALIAS_TEMPORARILY** — The live provider action. Still writes status directly via technicianService; Phase B of the executor migration. Authorization is equivalent — both resolve the provider from the token and check the CURRENT assignment.

### `POST /api/v1/provider/jobs/:bookingId/decline`

Declines the assignment, returning the booking to the pool.

- **Domain service** — `services/booking/transitionExecutor.transitionBooking (PROVIDER_DECLINE)`
- **Error codes** — `BOOKING_ACCESS_DENIED`, `BOOKING_NOT_FOUND`, `BOOKING_STATE_CONFLICT`, `BOOKING_TERMINAL`, `BOOKING_TRANSITION_INVALID`, `IDEMPOTENCY_KEY_INVALID`, `IDEMPOTENCY_KEY_REUSED`, `INTERNAL`, `PROVIDER_ROLE_REQUIRED`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Path params** — `bookingId` (integer) bookings.id
- **Callers** — Cust Mobile — · Cust Web — · Prov Mobile ✅ · Prov Web ✅ · Admin —
- **Legacy it replaces**
  - `PUT /api/worker/bookings/:bookingId/decline` — **ALIAS_TEMPORARILY** — The live provider action. Still writes status directly via technicianService; Phase B of the executor migration. Authorization is equivalent — both resolve the provider from the token and check the CURRENT assignment.

### `POST /api/v1/provider/jobs/:bookingId/en-route`

Marks the provider on the way.

- **Domain service** — `services/booking/transitionExecutor.transitionBooking (PROVIDER_EN_ROUTE)`
- **Error codes** — `BOOKING_ACCESS_DENIED`, `BOOKING_NOT_FOUND`, `BOOKING_STATE_CONFLICT`, `BOOKING_TERMINAL`, `BOOKING_TRANSITION_INVALID`, `IDEMPOTENCY_KEY_INVALID`, `IDEMPOTENCY_KEY_REUSED`, `INTERNAL`, `PROVIDER_ROLE_REQUIRED`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Path params** — `bookingId` (integer) bookings.id
- **Callers** — Cust Mobile — · Cust Web — · Prov Mobile ✅ · Prov Web ✅ · Admin —
- **Legacy it replaces**
  - `PUT /api/worker/bookings/:bookingId/en-route` — **ALIAS_TEMPORARILY** — The live provider action. Still writes status directly via technicianService; Phase B of the executor migration. Authorization is equivalent — both resolve the provider from the token and check the CURRENT assignment.

### `POST /api/v1/provider/jobs/:bookingId/arrived`

Marks the provider at the address.

- **Domain service** — `services/booking/transitionExecutor.transitionBooking (PROVIDER_ARRIVED)`
- **Error codes** — `BOOKING_ACCESS_DENIED`, `BOOKING_NOT_FOUND`, `BOOKING_STATE_CONFLICT`, `BOOKING_TERMINAL`, `BOOKING_TRANSITION_INVALID`, `IDEMPOTENCY_KEY_INVALID`, `IDEMPOTENCY_KEY_REUSED`, `INTERNAL`, `PROVIDER_ROLE_REQUIRED`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Path params** — `bookingId` (integer) bookings.id
- **Callers** — Cust Mobile — · Cust Web — · Prov Mobile ✅ · Prov Web ✅ · Admin —
- **Legacy it replaces**
  - `PUT /api/worker/bookings/:bookingId/arrived` — **ALIAS_TEMPORARILY** — The live provider action. Still writes status directly via technicianService; Phase B of the executor migration. Authorization is equivalent — both resolve the provider from the token and check the CURRENT assignment.

### `POST /api/v1/provider/jobs/:bookingId/start`

Starts the job. Requires the customer worker code.

> The worker code is the six-digit secret the CUSTOMER reads out. It is the only gate on starting a chargeable job, so it is rate-limited per provider and is redacted before the timeline records the transition.

- **Domain service** — `services/booking/transitionExecutor.transitionBooking (PROVIDER_START)`
- **Error codes** — `BOOKING_ACCESS_DENIED`, `BOOKING_NOT_FOUND`, `BOOKING_STATE_CONFLICT`, `BOOKING_TERMINAL`, `BOOKING_TRANSITION_INVALID`, `BOOKING_WORKER_CODE_INVALID`, `IDEMPOTENCY_KEY_INVALID`, `IDEMPOTENCY_KEY_REUSED`, `INTERNAL`, `PROVIDER_ROLE_REQUIRED`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Path params** — `bookingId` (integer) bookings.id
- **Callers** — Cust Mobile — · Cust Web — · Prov Mobile ✅ · Prov Web ⏳ · Admin —
- **Legacy it replaces**
  - `PUT /api/worker/bookings/:bookingId/start` — **ALIAS_TEMPORARILY** — The live provider action. Still writes status directly via technicianService; Phase B of the executor migration. Authorization is equivalent — both resolve the provider from the token and check the CURRENT assignment.

### `POST /api/v1/provider/jobs/:bookingId/complete`

Completes the job.

- **Domain service** — `services/booking/transitionExecutor.transitionBooking (PROVIDER_COMPLETE)`
- **Error codes** — `BOOKING_ACCESS_DENIED`, `BOOKING_NOT_FOUND`, `BOOKING_STATE_CONFLICT`, `BOOKING_TERMINAL`, `BOOKING_TRANSITION_INVALID`, `IDEMPOTENCY_KEY_INVALID`, `IDEMPOTENCY_KEY_REUSED`, `INTERNAL`, `PROVIDER_ROLE_REQUIRED`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Path params** — `bookingId` (integer) bookings.id
- **Callers** — Cust Mobile — · Cust Web — · Prov Mobile ✅ · Prov Web ✅ · Admin —
- **Legacy it replaces**
  - `PUT /api/worker/bookings/:bookingId/complete` — **ALIAS_TEMPORARILY** — The live provider action. Still writes status directly via technicianService; Phase B of the executor migration. Authorization is equivalent — both resolve the provider from the token and check the CURRENT assignment.

### `POST /api/v1/provider/jobs/:bookingId/cancel`

Cancels a job the provider had already accepted, subject to the notice policy.

> Completes the cancellation triad. Customer, provider and admin cancellation are three actions with three guards on ONE state machine — see §3 of BOOKING_EXPERIENCES_V1_CONTRACT.md.

- **Domain service** — `services/booking/transitionExecutor.transitionBooking (PROVIDER_CANCEL)`
- **Error codes** — `BOOKING_ACCESS_DENIED`, `BOOKING_NOT_FOUND`, `BOOKING_POLICY_REFUSED`, `BOOKING_PROVIDER_CANCEL_REASON_INVALID`, `BOOKING_PROVIDER_CANCEL_SCHEDULE_UNKNOWN`, `BOOKING_PROVIDER_CANCEL_STAGE_INVALID`, `BOOKING_PROVIDER_CANCEL_WINDOW_EXPIRED`, `BOOKING_STATE_CONFLICT`, `BOOKING_TERMINAL`, `BOOKING_TRANSITION_INVALID`, `IDEMPOTENCY_KEY_INVALID`, `IDEMPOTENCY_KEY_REUSED`, `INTERNAL`, `PROVIDER_ROLE_REQUIRED`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Path params** — `bookingId` (integer) bookings.id
- **Callers** — Cust Mobile — · Cust Web — · Prov Mobile ✅ · Prov Web ✅ · Admin —
- **Legacy it replaces**
  - `POST /api/provider/bookings/:bookingId/cancel` — **ALIAS_TEMPORARILY** — The live Provider Web / Provider Mobile cancel. It ALREADY runs the executor and the same providerCancellationWindow guard — this entry gives it a canonical path and a v1 error vocabulary, it does not give it a second implementation.
  - `GET /api/provider/bookings/:bookingId/cancellation-eligibility` — **KEEP** — NOT a duplicate. It answers "may I cancel, and until when" without cancelling, from the same evaluateCancellation function. The canonical successor for that question is the availableActions block on GET /bookings/:id/transitions.

## notifications

| Method | Path | Status | Auth | Request | Response | Idem | Owner |
|---|---|---|---|---|---|---|---|
| `GET` | `/api/v1/notifications` | **live** | any signed-in | — | `NotificationList` | yes | notifications |
| `GET` | `/api/v1/notifications/unread-count` | **live** | any signed-in | — | `UnreadCount` | yes | notifications |
| `PATCH` | `/api/v1/notifications/:key/read` | **live** | any signed-in | — | `NotificationMutation` | yes | notifications |
| `DELETE` | `/api/v1/notifications/:key` | **live** | any signed-in | — | `NotificationMutation` | yes | notifications |
| `POST` | `/api/v1/notifications/read-all` | **live** | any signed-in | — | `NotificationMutation` | yes | notifications |
| `GET` | `/api/v1/me/notification-preferences` | **live** | any signed-in | — | `NotificationPreferences` | yes | notifications |
| `PATCH` | `/api/v1/me/notification-preferences` | **live** | any signed-in | `NotificationPreferencePatch` | `NotificationPreferences` | yes | notifications |
| `POST` | `/api/v1/me/devices` | **live** | any signed-in | `DeviceRegistration` | `DeviceRegistrationResult` | no | notifications |
| `DELETE` | `/api/v1/me/devices` | **live** | any signed-in | `DeviceRelease` | `DeviceReleaseResult` | yes | notifications |

### `GET /api/v1/notifications`

The caller's notifications.

- **Domain service** — `services/events/notificationInbox.listNotifications`
- **Error codes** — `INTERNAL`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`
- **Query** — `filter` (string) Optional service-side filter key; `limit` (integer) Page size, 1-100, default 50; `offset` (integer) Rows to skip, default 0
- **Callers** — Cust Mobile ⏳ · Cust Web ⏳ · Prov Mobile ⏳ · Prov Web ✅ · Admin ·
- **Legacy it replaces**
  - `GET /api/user/notifications` — **ALIAS_TEMPORARILY** — Customer clients call this today.

### `GET /api/v1/notifications/unread-count`

How many unread notifications the caller has.

- **Domain service** — `services/events/notificationInbox.countUnread`
- **Error codes** — `INTERNAL`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`
- **Callers** — Cust Mobile ⏳ · Cust Web ⏳ · Prov Mobile ⏳ · Prov Web ✅ · Admin ·
- **Legacy it replaces**
  - `GET /api/user/notifications/unread-count` — **ALIAS_TEMPORARILY** — Declared before /user/notifications/:key on the legacy router precisely so "unread-count" is not parsed as a notification key. v1 has the same ordering requirement and the shadow test now enforces it.

### `PATCH /api/v1/notifications/:key/read`

Marks one notification read. Repeating it is a no-op, not an error.

- **Domain service** — `services/events/notificationInbox.markRead`
- **Error codes** — `INTERNAL`, `NOTIFICATION_NOT_ACTIONABLE`, `NOTIFICATION_NOT_FOUND`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Path params** — `key` (string) Opaque notification key
- **Callers** — Cust Mobile ⏳ · Cust Web ⏳ · Prov Mobile ⏳ · Prov Web ✅ · Admin ·
- **Legacy it replaces**
  - `PATCH /api/user/notifications/:key/read` — **ALIAS_TEMPORARILY** — Same service and the same key validation. The path differs only in the /user prefix, which named the caller rather than the resource.

### `DELETE /api/v1/notifications/:key`

Dismisses one notification. Repeating it is a no-op, not an error.

- **Domain service** — `services/events/notificationInbox.dismiss`
- **Error codes** — `INTERNAL`, `NOTIFICATION_NOT_ACTIONABLE`, `NOTIFICATION_NOT_FOUND`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Path params** — `key` (string) Opaque notification key
- **Callers** — Cust Mobile · · Cust Web · · Prov Mobile · · Prov Web ✅ · Admin —
- **Legacy it replaces**
  - `DELETE /api/provider/notifications/:key` — **CANONICALIZE** — The provider inbox had list, read, read-all and dismiss; v1 took the first three and left dismiss behind, so every provider client kept one legacy call for one verb. The legacy route is provider-only and reaches provider_notifications directly; this one resolves the store from the caller, so a CUSTOMER can dismiss for the first time.

### `POST /api/v1/notifications/read-all`

Marks every notification read. Naturally idempotent.

- **Domain service** — `services/events/notificationInbox.markAllRead`
- **Error codes** — `INTERNAL`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`
- **Callers** — Cust Mobile ⏳ · Cust Web ⏳ · Prov Mobile ⏳ · Prov Web ✅ · Admin ·
- **Legacy it replaces**
  - `POST /api/user/notifications/mark-all-read` — **ALIAS_TEMPORARILY** — Same service; v1 uses the resource-shaped path.

### `GET /api/v1/me/notification-preferences`

The caller's notification preferences, every declared category.

> Returns every category declared in `domainEvents.NOTIFICATION_CATEGORIES`, filled from the account's row or the category default. A client never has to decide what a missing key means, which is the decision that produces two different answers in two clients.

- **Domain service** — `services/events/notificationPreferences.getPreferences`
- **Error codes** — `INTERNAL`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`
- **Callers** — Cust Mobile · · Cust Web · · Prov Mobile ⏳ · Prov Web ✅ · Admin ·
- **Legacy it replaces**
  - `GET /api/provider/notification-preferences` — **ALIAS_TEMPORARILY** — Provider Web. Same uid-keyed table - nothing about it is provider-specific, and the role gate on this path is the reason customers had no way to configure notifications they were already receiving.

### `PATCH /api/v1/me/notification-preferences`

Changes named categories. Unnamed ones keep their value.

> PATCH rather than PUT, deliberately. A full replace means a client that knows about seven categories silently resets the two it has never heard of every time the backend adds one. `/settings/notification-preferences` keeps PUT for the shipped clients.

- **Domain service** — `services/events/notificationPreferences.patchPreferences`
- **Error codes** — `INTERNAL`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Callers** — Cust Mobile · · Cust Web · · Prov Mobile ⏳ · Prov Web ✅ · Admin ·
- **Legacy it replaces**
  - `PUT /api/provider/notification-preferences` — **ALIAS_TEMPORARILY** — Provider Web sends a full replace. Both shapes reach one writer, so a provider who has not migrated keeps the exact behaviour they have.

### `POST /api/v1/me/devices`

Registers this device for push, for the authenticated account.

> Account-scoped by construction: the row is upserted ON THE TOKEN, so registering a handset another account holds MOVES it rather than adding a second owner. A resold or shared device receiving two accounts of notifications is a cross-account leak with a lock screen attached.

- **Domain service** — `services/events/deviceTokenService.registerDevice`
- **Error codes** — `INTERNAL`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Callers** — Cust Mobile ⏳ · Cust Web · · Prov Mobile ✅ · Prov Web ✅ · Admin —
- **Legacy it replaces**
  - `POST /api/provider/fcm-token` — **ALIAS_TEMPORARILY** — ServanaWorker and Provider Web. Multi-device already, and dual-written by the canonical service so a device registered either way stays reachable.
  - `POST /api/user/fcm-token` — **ALIAS_TEMPORARILY** — ServanaClient. Wrote a SINGLE column, so a customer with a phone and a tablet only ever received push on whichever signed in last - silently. The canonical route gives customers the multi-device behaviour providers already had.

### `DELETE /api/v1/me/devices`

Releases this device, or every device for the account.

> Omitting the token releases EVERY device, which is what a sign-out-everywhere wants. Passing one releases that handset only - signing out of a phone must not un-enroll the tablet still signed in.

- **Domain service** — `services/events/deviceTokenService.releaseDevice`
- **Error codes** — `INTERNAL`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`
- **Callers** — Cust Mobile ⏳ · Cust Web · · Prov Mobile ✅ · Prov Web ✅ · Admin —
- **Legacy it replaces**
  - `DELETE /api/provider/fcm-token` — **ALIAS_TEMPORARILY** — Same operation, provider-gated. Both reach one service.
  - `DELETE /api/user/fcm-token` — **ALIAS_TEMPORARILY** — Same operation for customers, against the single legacy column.

## account

| Method | Path | Status | Auth | Request | Response | Idem | Owner |
|---|---|---|---|---|---|---|---|
| `PATCH` | `/api/v1/me` | **live** | any signed-in | `AccountPatch` | `Account` | yes | account |
| `GET` | `/api/v1/me/settings` | **live** | any signed-in | — | `AccountSettings` | yes | account |
| `PATCH` | `/api/v1/me/settings` | **live** | any signed-in | `AccountSettingsPatch` | `AccountSettings` | yes | account |
| `GET` | `/api/v1/me/security` | **live** | any signed-in | — | `AccountSecurity` | yes | account |
| `GET` | `/api/v1/me/completion` | **live** | any signed-in | — | `ProfileCompletion` | yes | account |
| `GET` | `/api/v1/customer/profile` | **live** | any signed-in | — | `CustomerProfile` | yes | account |
| `PATCH` | `/api/v1/customer/profile` | **live** | any signed-in | `CustomerProfilePatch` | `CustomerProfile` | yes | account |
| `GET` | `/api/v1/customer/addresses` | **live** | any signed-in | — | `AddressList` | yes | account |
| `POST` | `/api/v1/customer/addresses` | **live** | any signed-in | `AddressInput` | `Address` | no | account |
| `PATCH` | `/api/v1/customer/addresses/:addressId` | **live** | any signed-in | `AddressInput` | `Address` | yes | account |
| `DELETE` | `/api/v1/customer/addresses/:addressId` | **live** | any signed-in | — | `AddressDeleteResult` | yes | account |
| `POST` | `/api/v1/customer/addresses/:addressId/default` | **live** | any signed-in | — | `Address` | yes | account |
| `GET` | `/api/v1/provider/profile` | **live** | provider (role 2/4) | — | `ProviderProfile` | yes | account |
| `PATCH` | `/api/v1/provider/profile` | **live** | provider (role 2/4) | `ProviderProfilePatch` | `ProviderProfileRevision` | no | account |
| `GET` | `/api/v1/providers/:providerUid/profile` | **live** | any signed-in | — | `ProviderProfile` | yes | account |
| `GET` | `/api/v1/provider/documents` | **live** | provider (role 2/4) | — | `ProviderDocumentList` | yes | account |
| `GET` | `/api/v1/provider/document-types` | **live** | provider (role 2/4) | — | `ProviderDocumentTypeCatalog` | yes | account |
| `POST` | `/api/v1/provider/documents` | **live** | provider (role 2/4) | `ProviderDocumentUpload` | `ProviderDocument` | no | account |
| `GET` | `/api/v1/provider/documents/:documentId/preview` | **live** | provider (role 2/4) | — | `ProviderDocumentPreview` | yes | account |
| `DELETE` | `/api/v1/provider/documents/:documentId` | **live** | provider (role 2/4) | — | `ProviderDocumentMutation` | yes | account |
| `GET` | `/api/v1/provider/availability` | **live** | provider (role 2/4) | — | `ProviderAvailability` | yes | account |
| `PATCH` | `/api/v1/provider/availability` | **live** | provider (role 2/4) | `ProviderAvailabilityPatch` | `ProviderAvailability` | yes | account |
| `GET` | `/api/v1/provider/time-off` | **live** | provider (role 2/4) | — | `ProviderTimeOffList` | yes | account |
| `POST` | `/api/v1/provider/time-off` | **live** | provider (role 2/4) | `ProviderTimeOffRequest` | `ProviderTimeOff` | no | account |
| `DELETE` | `/api/v1/provider/time-off/:timeOffId` | **live** | provider (role 2/4) | — | `ProviderTimeOffMutation` | yes | account |
| `GET` | `/api/v1/provider/services` | **live** | provider (role 2/4) | — | `ProviderServiceList` | yes | account |

### `PATCH /api/v1/me`

Changes the caller's own account record.

> Verified identifiers - email and mobile - are NOT writable here. Changing one needs the re-verification workflow, and a PATCH that accepted them would be a way to move a verified identifier without proving possession of the new one.

- **Domain service** — `services/account/accountService.patchAccount`
- **Error codes** — `ACCOUNT_FIELD_NOT_WRITABLE`, `INTERNAL`, `NOT_FOUND`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Callers** — Cust Mobile ⏳ · Cust Web ⏳ · Prov Mobile ⏳ · Prov Web ⏳ · Admin ·
- **Legacy it replaces**
  - `PUT /api/user/updateprofile` — **ALIAS_TEMPORARILY** — The live profile write for every client. Same writer - this entry delegates to `user.service.updateUserProfile` rather than touching the columns, so the two paths cannot grow different rules. It additionally REFUSES unwritable fields by name instead of stripping them silently.

### `GET /api/v1/me/settings`

The caller's settings: locale, privacy, security posture and a notification pointer.

> There was no server-side settings store before this. Locale and privacy choices were held per-client, so Customer Web and Customer Mobile each remembered a different language for the same person and neither could tell the backend. Notification preferences are a POINTER to the TAB 09 model, never a second copy of it.

- **Domain service** — `services/account/accountSettingsService.getSettings`
- **Error codes** — `INTERNAL`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`
- **Callers** — Cust Mobile · · Cust Web · · Prov Mobile ✅ · Prov Web · · Admin ·
- **Legacy it replaces** — none; new capability.

### `PATCH /api/v1/me/settings`

Changes named settings. Unnamed ones keep their value.

> PATCH rather than PUT: a full replace means a client that knows about four settings silently resets the one it has never heard of every time the backend adds another. An unknown key is REFUSED rather than ignored, so two clients cannot come to disagree about what a person chose.

- **Domain service** — `services/account/accountSettingsService.patchSettings`
- **Error codes** — `ACCOUNT_FIELD_NOT_WRITABLE`, `INTERNAL`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Callers** — Cust Mobile · · Cust Web · · Prov Mobile ✅ · Prov Web · · Admin ·
- **Legacy it replaces** — none; new capability.

### `GET /api/v1/me/security`

The caller's security posture, and where each security action lives.

> READ-ONLY, deliberately. Every security ACTION already has a dedicated endpoint with its own proof of possession; folding them into a settings PATCH would put credential changes behind a JSON body - including turning two-factor OFF from a session that should not be able to. The response names where each action lives so a client need not hardcode it.

- **Domain service** — `services/account/accountSettingsService.getSecurity`
- **Error codes** — `INTERNAL`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`
- **Callers** — Cust Mobile · · Cust Web · · Prov Mobile · · Prov Web · · Admin ·
- **Legacy it replaces** — none; new capability.

### `GET /api/v1/me/completion`

What is left before this account is usable. Backend-derived.

> `percent` counts every requirement including the cosmetic ones, because that is what a progress bar means to a person. `canProceed` counts only the BLOCKING ones, because that is what the product gates on. Conflating them is how a client shows "80% complete" next to a button that does not work.

- **Domain service** — `services/account/profileCompletionService.getCompletion`
- **Error codes** — `INTERNAL`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`
- **Callers** — Cust Mobile · · Cust Web · · Prov Mobile ✅ · Prov Web · · Admin —
- **Legacy it replaces**
  - `GET /api/provider/account-state` — **KEEP** — NOT a duplicate. Account state answers "what may this provider do RIGHT NOW" - suspended, pending, active - and is what gates the app. Completion answers "what is left to fill in". A suspended provider can be 100% complete, and a pending one can be active-eligible and missing a photo.

### `GET /api/v1/customer/profile`

The caller's customer profile extension.

- **Domain service** — `services/account/accountService.getCustomerProfile`
- **Error codes** — `INTERNAL`, `NOT_FOUND`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`
- **Callers** — Cust Mobile ⏳ · Cust Web ⏳ · Prov Mobile — · Prov Web — · Admin ·
- **Legacy it replaces**
  - `GET /api/user/profile` — **ALIAS_TEMPORARILY** — The live customer profile aggregate. It returns the credential row joined to the profile row; this entry returns the customer EXTENSION only, because the identity half is `/me` and duplicating it is how two endpoints come to disagree about a name.

### `PATCH /api/v1/customer/profile`

Changes the customer profile extension.

> The default address is NOT writable here. It is set through the address book, so the flag and the address that carries it cannot disagree.

- **Domain service** — `services/account/accountService.patchCustomerProfile`
- **Error codes** — `ACCOUNT_FIELD_NOT_WRITABLE`, `INTERNAL`, `NOT_FOUND`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Callers** — Cust Mobile ⏳ · Cust Web ⏳ · Prov Mobile — · Prov Web — · Admin ·
- **Legacy it replaces**
  - `PUT /api/user/updateprofile` — **ALIAS_TEMPORARILY** — One legacy route wrote both halves. Same writer underneath; the split is in the DTO.

### `GET /api/v1/customer/addresses`

The caller's saved addresses, default first.

> `meta.defaultAddressId` is surfaced so checkout needs one call rather than scanning the list for the first `isDefault` it finds.

- **Domain service** — `services/account/addressBookService.listAddresses`
- **Error codes** — `INTERNAL`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`
- **Callers** — Cust Mobile ⏳ · Cust Web ⏳ · Prov Mobile — · Prov Web — · Admin —
- **Legacy it replaces**
  - `GET /api/user/alluseraddresses` — **ALIAS_TEMPORARILY** — The live list for Customer Web and Mobile. It branches on role inside the service and returns EVERY customer address to an admin; the canonical route is owner-scoped in SQL with no role branch, and admin address access belongs on an admin route.
  - `GET /api/user/:userId/addresses` — **ROLE_SPECIFIC** — The provider portal reading a booking customer's address. A genuinely different authorization question - it is answered from the booking relationship, not from ownership - and it stays on its own route rather than becoming a uid parameter here.

### `POST /api/v1/customer/addresses`

Saves a new address. The first one becomes the default.

- **Domain service** — `services/account/addressBookService.createAddress`
- **Error codes** — `ADDRESS_LIMIT_REACHED`, `INTERNAL`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Callers** — Cust Mobile ⏳ · Cust Web ⏳ · Prov Mobile — · Prov Web — · Admin —
- **Legacy it replaces**
  - `POST /api/user/adduseraddress` — **ALIAS_TEMPORARILY** — A create verb that doubles as an update when the body happens to carry an addressId. The canonical pair splits them, and both reach the same writer so the MongoDB geocode sync has one caller.

### `PATCH /api/v1/customer/addresses/:addressId`

Changes a saved address.

> An absent field means "leave it alone", never "clear it". Treating absence as a clear would let a client that sends one field wipe the rest of somebody's address.

- **Domain service** — `services/account/addressBookService.updateAddress`
- **Error codes** — `ADDRESS_NOT_FOUND`, `INTERNAL`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Path params** — `addressId` (string) user_address.address_id
- **Callers** — Cust Mobile ⏳ · Cust Web ⏳ · Prov Mobile — · Prov Web — · Admin —
- **Legacy it replaces**
  - `POST /api/user/adduseraddress` — **ALIAS_TEMPORARILY** — The same legacy route, taking the update branch when the body carries an addressId.

### `DELETE /api/v1/customer/addresses/:addressId`

Removes a saved address, promoting a successor if it was the default.

- **Domain service** — `services/account/addressBookService.deleteAddress`
- **Error codes** — `ADDRESS_NOT_FOUND`, `INTERNAL`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Path params** — `addressId` (string) user_address.address_id
- **Callers** — Cust Mobile ⏳ · Cust Web ⏳ · Prov Mobile — · Prov Web — · Admin —
- **Legacy it replaces**
  - `DELETE /api/user/deleteaddress` — **ALIAS_TEMPORARILY** — Takes the id in a query string and leaves the account with NO default when the primary is removed - a checkout screen with nothing selected and no way to tell why.

### `POST /api/v1/customer/addresses/:addressId/default`

Promotes one address to default. Atomic.

> Demote-then-promote inside ONE transaction. That order never transiently satisfies "exactly one" by having zero rather than two, which a reader mid-transaction could otherwise observe.

- **Domain service** — `services/account/addressBookService.setDefaultAddress`
- **Error codes** — `ADDRESS_NOT_FOUND`, `INTERNAL`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Path params** — `addressId` (string) user_address.address_id
- **Callers** — Cust Mobile ⏳ · Cust Web ⏳ · Prov Mobile — · Prov Web — · Admin —
- **Legacy it replaces**
  - `PUT /api/user/makeaddressprimary` — **ALIAS_TEMPORARILY** — TWO statements with no transaction - set the new default, then clear the others. A failure between them leaves the account with two primaries, and every reader picks whichever the planner returned first, including checkout.

### `GET /api/v1/provider/profile`

The caller's own provider profile, field-scoped by seat.

> `visibleFields` is on the wire, so a client can tell a public view from its own rather than inferring it from which keys happen to be missing.

- **Domain service** — `services/account/providerProfileService.getProviderProfile`
- **Error codes** — `INTERNAL`, `NOT_FOUND`, `PROVIDER_ROLE_REQUIRED`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`
- **Callers** — Cust Mobile — · Cust Web — · Prov Mobile ⏳ · Prov Web ✅ · Admin ·
- **Legacy it replaces**
  - `GET /api/provider/profile` — **ALIAS_TEMPORARILY** — The live provider profile, built inline in a controller with a hand-written column list. Safe only for as long as nobody adds a column; the canonical route emits the fields the policy says this seat may read.
  - `GET /api/provider/profile-center` — **ROLE_SPECIFIC** — The compliance view: revision history, review state, field-level edit affordances. A genuinely different question, and it already reads the same field registry this entry projects from.

### `PATCH /api/v1/provider/profile`

Proposes a change to a reviewable public profile field.

> Not a write. A provider does not edit their public profile; they propose a change and it is reviewed. Identifier fields and operational fields are refused by name, with the message naming where each is actually changed.

- **Domain service** — `services/account/providerProfileService.patchProviderProfile`
- **Error codes** — `ACCOUNT_FIELD_NOT_WRITABLE`, `INTERNAL`, `PROVIDER_ROLE_REQUIRED`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Callers** — Cust Mobile — · Cust Web — · Prov Mobile ⏳ · Prov Web ✅ · Admin —
- **Legacy it replaces**
  - `POST /api/provider/public-profile-revisions` — **ALIAS_TEMPORARILY** — The live revision submit. IDENTICAL domain call - this is a second URL onto one workflow.

### `GET /api/v1/providers/:providerUid/profile`

A provider's PUBLIC profile, as a customer sees it.

> The ONE endpoint in this domain that names another account, and the only one that needs to. What a stranger receives is decided by `providerFieldsVisibleTo`, which requires the classification AND the registry's own customerVisible flag to agree - either can veto, so a private field cannot arrive by being forgotten. Document state and account status are withheld entirely at this seat.

- **Domain service** — `services/account/providerProfileService.getProviderProfile`
- **Error codes** — `INTERNAL`, `NOT_FOUND`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Path params** — `providerUid` (string) Canonical provider uid
- **Callers** — Cust Mobile · · Cust Web · · Prov Mobile — · Prov Web — · Admin ·
- **Legacy it replaces** — none; new capability.

### `GET /api/v1/provider/documents`

Document and requirement REVIEW STATE. Never content.

> Driven by the document CATALOG rather than by the stored rows, so a required document that has never been submitted appears as `missing`. A list built from rows alone shows an empty screen to a provider who has everything left to do. No URL and no storage path appears; the preview endpoint mints a short-lived signed URL after re-authorizing.

- **Domain service** — `services/account/providerProfileService.listDocuments`
- **Error codes** — `INTERNAL`, `PROVIDER_ROLE_REQUIRED`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`
- **Callers** — Cust Mobile — · Cust Web — · Prov Mobile ⏳ · Prov Web ✅ · Admin —
- **Legacy it replaces**
  - `GET /api/provider/documents` — **ALIAS_TEMPORARILY** — The live document list. Same `worker_requirements` model - the command is explicit that provider_documents must not be invented, and it does not exist.

### `GET /api/v1/provider/document-types`

The document catalog: what may be submitted, and which are required.

> Provider-scoped rather than public even though the payload is static policy: the requirement set is part of how onboarding works, and a public catalog invites building the checklist screen against an endpoint nobody has to be signed in to read.

- **Domain service** — `services/providerProfileComplianceService.DOCUMENT_TYPE_CATALOG`
- **Error codes** — `INTERNAL`, `PROVIDER_ROLE_REQUIRED`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`
- **Callers** — Cust Mobile — · Cust Web — · Prov Mobile ✅ · Prov Web ⏳ · Admin —
- **Legacy it replaces**
  - `GET /api/provider/document-types` — **ALIAS_TEMPORARILY** — The same static catalog constant. No per-caller data of any kind.

### `POST /api/v1/provider/documents`

Submits one document for review.

> The file is a data URI validated by SIGNATURE against an allowlist and a size ceiling, so a renamed executable is refused on its contents. The response is review STATE; no storage path is ever projected.

- **Domain service** — `services/providerProfileComplianceService.uploadDocument`
- **Error codes** — `CONFLICT`, `INTERNAL`, `NOT_FOUND`, `PROVIDER_ROLE_REQUIRED`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Callers** — Cust Mobile — · Cust Web — · Prov Mobile ✅ · Prov Web ✅ · Admin —
- **Legacy it replaces**
  - `POST /api/provider/documents` — **ALIAS_TEMPORARILY** — The live submit for both provider clients. IDENTICAL domain call, and it carries the same post-commit `autoOnlineEngine.evaluateProvider` — submitting the last outstanding requirement is what makes a provider eligible to go online, so an endpoint that stored the file without re-evaluating would leave them blocked.

### `GET /api/v1/provider/documents/:documentId/preview`

A short-lived signed URL for one document the caller owns.

> A malformed id and an id belonging to another provider answer the SAME 404. A 422 for the first would let a caller enumerate which document ids exist.

- **Domain service** — `services/providerProfileComplianceService.getDocumentPreview`
- **Error codes** — `INTERNAL`, `NOT_FOUND`, `PROVIDER_ROLE_REQUIRED`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`
- **Path params** — `documentId` (integer) worker_requirements.id
- **Callers** — Cust Mobile — · Cust Web — · Prov Mobile ✅ · Prov Web ✅ · Admin —
- **Legacy it replaces**
  - `GET /api/provider/documents/:documentId/preview` — **ALIAS_TEMPORARILY** — Same authorization and the same short-lived grant. The `Cache-Control: private, no-store` and `Pragma: no-cache` headers are set by the handler rather than the route, so they travel with the only v1 response that contains a private storage URL.

### `DELETE /api/v1/provider/documents/:documentId`

Withdraws one document.

- **Domain service** — `services/providerProfileComplianceService.deleteDocument`
- **Error codes** — `CONFLICT`, `INTERNAL`, `NOT_FOUND`, `PROVIDER_ROLE_REQUIRED`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`
- **Path params** — `documentId` (integer) worker_requirements.id
- **Callers** — Cust Mobile — · Cust Web — · Prov Mobile ✅ · Prov Web ✅ · Admin —
- **Legacy it replaces**
  - `DELETE /api/provider/documents/:documentId` — **ALIAS_TEMPORARILY** — IDENTICAL domain call, and it re-evaluates online eligibility for the same reason the upload does: withdrawing a requirement can make a provider ineligible, and skipping it would leave someone online against a document they just removed.

### `GET /api/v1/provider/availability`

The caller's weekly availability - the same source matching consumes.

> The release gate: a provider editing one source while matching reads another is a provider who is unbookable for reasons nobody can see. Both read `providerAvailabilityEngine`.

- **Domain service** — `services/providerAvailabilityEngine.getAvailabilityProfile`
- **Error codes** — `INTERNAL`, `PROVIDER_ROLE_REQUIRED`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`
- **Callers** — Cust Mobile — · Cust Web — · Prov Mobile ⏳ · Prov Web ⏳ · Admin —
- **Legacy it replaces**
  - `GET /api/worker/availability` — **ALIAS_TEMPORARILY** — The live provider availability read. Same engine; the legacy shape bridges it to a web schedule.

### `PATCH /api/v1/provider/availability`

Replaces the weekly availability. Optimistic concurrency on version.

> Idempotent because it REPLACES the week rather than appending to it: the same body twice reaches the same schedule. `expectedVersion` is what stops two devices silently overwriting each other.

- **Domain service** — `services/providerAvailabilityEngine.saveWeeklySchedule`
- **Error codes** — `INTERNAL`, `PROVIDER_ROLE_REQUIRED`, `STALE_STATE`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Callers** — Cust Mobile — · Cust Web — · Prov Mobile ⏳ · Prov Web ⏳ · Admin —
- **Legacy it replaces**
  - `PUT /api/worker/availability` — **ALIAS_TEMPORARILY** — The live write. IDENTICAL engine call, including its expectedVersion check.

### `GET /api/v1/provider/time-off`

The ACTIVE time-off periods belonging to the caller.

- **Domain service** — `services/providerAvailabilityEngine.listTimeOff`
- **Error codes** — `INTERNAL`, `PROVIDER_ROLE_REQUIRED`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`
- **Callers** — Cust Mobile — · Cust Web — · Prov Mobile ✅ · Prov Web ⏳ · Admin —
- **Legacy it replaces**
  - `GET /api/worker/time-off` — **ALIAS_TEMPORARILY** — Same engine, same active-only filter. A cancelled period is history rather than a commitment and appears in neither.

### `POST /api/v1/provider/time-off`

Books time off, and reports the confirmed bookings it collides with.

> The response reports what was STORED, never the request. A response assembled from the body agrees with the client by construction, which is how the partial-day defect survived: the portal sent startTime/endTime, nothing persisted them, and the reply said allDay.

- **Domain service** — `services/providerAvailabilityEngine.createTimeOff`
- **Error codes** — `INTERNAL`, `PROVIDER_ROLE_REQUIRED`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Callers** — Cust Mobile — · Cust Web — · Prov Mobile ✅ · Prov Web ⏳ · Admin —
- **Legacy it replaces**
  - `POST /api/worker/time-off` — **ALIAS_TEMPORARILY** — IDENTICAL engine call, and it carries the same bookingConflicts and conflictNotice. Time off is created even when it overlaps confirmed work - a provider who is ill must be able to record it - but the work is still theirs, and a response that did not say so would leave them assuming leave cancels their jobs.

### `DELETE /api/v1/provider/time-off/:timeOffId`

Cancels one time-off period.

> A malformed id answers 404, the same as one belonging to another provider - a 422 for the first would let a caller enumerate which periods exist.

- **Domain service** — `services/providerAvailabilityEngine.cancelTimeOff`
- **Error codes** — `INTERNAL`, `NOT_FOUND`, `PROVIDER_ROLE_REQUIRED`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`
- **Path params** — `timeOffId` (integer) provider_time_off.id
- **Callers** — Cust Mobile — · Cust Web — · Prov Mobile ✅ · Prov Web ⏳ · Admin —
- **Legacy it replaces**
  - `DELETE /api/worker/time-off/:id` — **ALIAS_TEMPORARILY** — IDENTICAL engine call. Cancels rather than deletes; the row survives as history.

### `GET /api/v1/provider/services`

The services the caller is approved for, keyed on services.id.

> Keyed on `services.id` - the Catalog V2 canonical specific-service identity - never on a service family. `service_families` is legacy coarse provenance, and a provider service list keyed on a family is how the family becomes the bookable identity again.

- **Domain service** — `services/account/providerProfileService.listServices`
- **Error codes** — `INTERNAL`, `PROVIDER_ROLE_REQUIRED`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`
- **Callers** — Cust Mobile — · Cust Web — · Prov Mobile ✅ · Prov Web · · Admin —
- **Legacy it replaces**
  - `GET /api/worker/services-overview` — **ALIAS_TEMPORARILY** — The live provider services screen. Same `employee_services` qualification; the canonical entry projects it keyed on services.id with the active flag matching actually selects on.
  - `GET /api/worker/service-applications` — **KEEP** — NOT a duplicate. An application is the REQUEST to be approved for a service and carries its own lifecycle; this entry is the resulting qualification. A provider can have a pending application and no qualification, which is exactly the state the two endpoints exist to tell apart.

## reviews

| Method | Path | Status | Auth | Request | Response | Idem | Owner |
|---|---|---|---|---|---|---|---|
| `GET` | `/api/v1/reviews/providers/:providerUid` | **live** | public | — | `ProviderReviewList` | yes | reviews |
| `GET` | `/api/v1/reviews/providers/:providerUid/rating` | **live** | public | — | `ProviderRating` | yes | reviews |
| `POST` | `/api/v1/bookings/:bookingId/review` | **live** | any signed-in | `ReviewInput` | `Review` | no | reviews |
| `GET` | `/api/v1/bookings/:bookingId/review` | **live** | any signed-in | — | `ReviewOrEligibility` | yes | reviews |
| `POST` | `/api/v1/bookings/:bookingId/support-cases` | **live** | any signed-in | `SupportCaseInput` | `SupportCase` | no | reviews |
| `GET` | `/api/v1/bookings/:bookingId/support-cases` | **live** | any signed-in | — | `SupportCaseList` | yes | reviews |

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

### `POST /api/v1/bookings/:bookingId/review`

Reviews a completed booking. The provider comes from the assignment.

> Nothing in the body names a provider, an author or a rating subject. The provider is resolved from the booking's COMPLETED assignment, so a payload that named one would have nothing to attach it to.

- **Domain service** — `services/customerReviewService.createReview`
- **Error codes** — `INTERNAL`, `REVIEW_ALREADY_EXISTS`, `REVIEW_FORBIDDEN`, `REVIEW_NOT_ELIGIBLE`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Path params** — `bookingId` (integer) bookings.id
- **Callers** — Cust Mobile ⏳ · Cust Web ⏳ · Prov Mobile — · Prov Web — · Admin —
- **Legacy it replaces**
  - `POST /api/bookings/:bookingId/reviews` — **ALIAS_TEMPORARILY** — The live customer review write. IDENTICAL domain call - this is a second URL onto one write, and the legacy route keeps its role guard and its response shape.

### `GET /api/v1/bookings/:bookingId/review`

The caller's own review for a booking, or the eligibility verdict when there is none.

> Carries the private feedback, which the provider and public projections never do - that is why it is a separate read rather than a filter over the provider list.

- **Domain service** — `services/customerReviewService.getReviewByBooking`
- **Error codes** — `INTERNAL`, `REVIEW_FORBIDDEN`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Path params** — `bookingId` (integer) bookings.id
- **Callers** — Cust Mobile ⏳ · Cust Web ⏳ · Prov Mobile — · Prov Web — · Admin —
- **Legacy it replaces**
  - `GET /api/bookings/:bookingId/reviews` — **ALIAS_TEMPORARILY** — The live read. Same service; the canonical entry folds in the eligibility verdict.
  - `GET /api/bookings/:bookingId/review-eligibility` — **ALIAS_TEMPORARILY** — A SECOND call the client makes to decide whether to show the form. Folded into the read above, because asking twice means a screen that offers a form the next call refuses.

### `POST /api/v1/bookings/:bookingId/support-cases`

Raises a support case about a concluded booking.

> A BILLING category is accepted and ROUTED to the finance domain: the response carries routedTo: finance and names the refund endpoint. Handling it here would fork the refund rules into a second, weaker path beside the one reconciliation checks.

- **Domain service** — `services/reviews/postServiceSupportService.createSupportCase`
- **Error codes** — `INTERNAL`, `SUPPORT_BOOKING_NOT_ELIGIBLE`, `SUPPORT_CASE_LIMIT_REACHED`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Path params** — `bookingId` (integer) bookings.id
- **Callers** — Cust Mobile · · Cust Web · · Prov Mobile — · Prov Web — · Admin —
- **Legacy it replaces**
  - `POST /api/support/tickets` — **ROLE_SPECIFIC** — The general customer contact surface. It carries no bookingId, so a quality complaint raised through it arrives with no way to see which visit it is about. Kept for contact that is genuinely not about a booking.

### `GET /api/v1/bookings/:bookingId/support-cases`

The cases the caller raised on this booking.

> Owner-scoped in SQL. There is no parameter naming another account, which is what makes the isolation test a statement about the code rather than about today's routes.

- **Domain service** — `services/reviews/postServiceSupportService.listSupportCases`
- **Error codes** — `INTERNAL`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Path params** — `bookingId` (integer) bookings.id
- **Callers** — Cust Mobile · · Cust Web · · Prov Mobile — · Prov Web — · Admin —
- **Legacy it replaces** — none; new capability.

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
- **Callers** — Cust Mobile ⏳ · Cust Web ⏳ · Prov Mobile ⏳ · Prov Web ✅ · Admin ⏳
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
- **Callers** — Cust Mobile · · Cust Web · · Prov Mobile ✅ · Prov Web · · Admin —
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
| `GET` | `/api/v1/home` | **live** | any signed-in | — | `HomeFeed` | yes | home |
| `GET` | `/api/v1/home/sections` | **live** | any signed-in | — | `HomeSectionRegistry` | yes | home |

### `GET /api/v1/home`

The composed customer home surface. A read model; it owns nothing.

> A COMPOSITION endpoint. It aggregates and owns nothing: every service card carries services.id from Catalog V2, every booking card carries bookings.id with the canonical state the booking read model derives, and the unread count comes from the one inbox. The response Cache-Control is derived from the SECTIONS PRESENT rather than from the route, so a public-only selection is cacheable and anything personal is no-store.

- **Domain service** — `services/home/homeService.composeHome`
- **Error codes** — `INTERNAL`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Query** — `sections` (string) Comma-separated section types. Omit for the default set. An unknown name is IGNORED, never refused - the registry is append-only, and refusing would make adding a section a breaking change for every older client.
- **Callers** — Cust Mobile · · Cust Web · · Prov Mobile — · Prov Web — · Admin —
- **Legacy it replaces**
  - `GET /api/catalog` — **KEEP** — NOT superseded. The customer app calls it directly for the category browse, and it remains the canonical catalog read. Home REFERENCES it - the categories section delegates to the same service - rather than replacing it.
  - `GET /api/user/notifications/unread-count` — **KEEP** — NOT superseded. Home carries the unread count as one section so a launch costs one round trip; the standalone endpoint is still what a client polls when only the badge changed.

### `GET /api/v1/home/sections`

The section registry: what the page is made of and what owns each part.

> METADATA, not content - it names no account and no resource, so it caches like the catalog it describes. A client uses it to render an unknown section safely rather than crashing on it, which is what makes the registry append-only in practice as well as in principle.

- **Domain service** — `services/home/homeService.describeSections`
- **Error codes** — `INTERNAL`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`
- **Callers** — Cust Mobile · · Cust Web · · Prov Mobile — · Prov Web — · Admin ·
- **Legacy it replaces** — none; new capability.

## conversations

| Method | Path | Status | Auth | Request | Response | Idem | Owner |
|---|---|---|---|---|---|---|---|
| `POST` | `/api/v1/conversations` | **live** | any signed-in | `ConversationCreateRequest` | `Conversation` | no | messaging |
| `GET` | `/api/v1/conversations` | **live** | any signed-in | — | `ConversationList` | yes | messaging |
| `GET` | `/api/v1/conversations/:conversationId` | **live** | any signed-in | — | `Conversation` | yes | messaging |
| `GET` | `/api/v1/conversations/:conversationId/messages` | **live** | any signed-in | — | `MessagePage` | yes | messaging |
| `POST` | `/api/v1/conversations/:conversationId/messages` | **live** | any signed-in | `SendMessageRequest` | `Message` | no | messaging |
| `POST` | `/api/v1/conversations/:conversationId/attachments` | **live** | any signed-in | `ChatAttachmentUpload` | `ChatAttachment` | no | messaging |
| `POST` | `/api/v1/conversations/:conversationId/messages/:messageId/report` | **live** | any signed-in | `MessageReportRequest` | `MessageReport` | no | messaging |
| `POST` | `/api/v1/conversations/:conversationId/read` | **live** | any signed-in | `MarkReadRequest` | `ConversationReadState` | yes | messaging |

### `POST /api/v1/conversations`

Opens, or resolves, the conversation for a booking.

> Support may open a conversation on a booking with no provider; the parties may not. That is `mayOpenConversation` in the policy, not an `if` in the handler, so the rule is the same one the generated contract document tabulates.

- **Domain service** — `services/messaging/messagingService.openConversation`
- **Error codes** — `BOOKING_NOT_FOUND`, `CONVERSATION_ACCESS_DENIED`, `CONVERSATION_NOT_AVAILABLE`, `INTERNAL`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Callers** — Cust Mobile ⏳ · Cust Web ⏳ · Prov Mobile ⏳ · Prov Web ✅ · Admin ⏳
- **Legacy it replaces**
  - `GET /api/bookings/:bookingId/conversation` — **ALIAS_TEMPORARILY** — The live resolve-by-booking call. It is a GET that never creates, and the customer app already maps its 404 to "no conversation yet". This entry adds the explicit open, gated by the same rule: a booking conversation exists because a provider was confirmed, not because somebody opened a screen.

### `GET /api/v1/conversations`

The caller's booking conversations, with unread counts.

> An admin receives the oversight list from the same handler and gets no unread counts — they hold no read pointer on a booking they merely supervise, so any number would be invented. `meta.unreadTotal` is the badge total, summed from the same per-conversation numbers the list carries.

- **Domain service** — `services/messaging/messagingService.listConversations`
- **Error codes** — `INTERNAL`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`
- **Callers** — Cust Mobile ⏳ · Cust Web ⏳ · Prov Mobile ⏳ · Prov Web ✅ · Admin ⏳
- **Legacy it replaces**
  - `GET /api/chat/conversations` — **ALIAS_TEMPORARILY** — The live inbox for all four apps. Chat routes do NOT use an envelope — the stores read a top-level `conversations` key — so the legacy shape is kept exactly and this entry adds the canonical one alongside. Both now read the same unread expression.
  - `GET /api/admin/communications/conversations` — **ROLE_SPECIFIC** — The admin oversight list carries a named permission and a booking filter, and joins moderation state this route has no business publishing to a customer. Same tables, same conversation ids; a genuinely different question.

### `GET /api/v1/conversations/:conversationId`

One conversation: state, participants, and the caller's unread count.

> Participant contact columns are never published. `listParticipants` joins user_credentials and user_profile, and the DTO names a display name and an avatar rather than copying the row — a subtractive projection would disclose every column somebody forgets to strip. Departed participants are shown to support only.

- **Domain service** — `services/messaging/messagingService.getConversation`
- **Error codes** — `CONVERSATION_ACCESS_DENIED`, `INTERNAL`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Path params** — `conversationId` (integer) chat_conversations.id
- **Callers** — Cust Mobile ⏳ · Cust Web ⏳ · Prov Mobile ⏳ · Prov Web ✅ · Admin ⏳
- **Legacy it replaces**
  - `GET /api/chat/conversations/:id` — **ALIAS_TEMPORARILY** — The live detail call. Same authorization; the canonical shape adds the seat, the send capability with its reason, the unread count and a last-message preview built through the caller's own read floor.
  - `GET /api/admin/communications/conversations/:id` — **ROLE_SPECIFIC** — The admin detail view, permissioned, and carrying report and moderation state. Different fields, different authorization, same conversation id.

### `GET /api/v1/conversations/:conversationId/messages`

A page of the transcript, newest first, cursor-paged.

> A replacement provider reads from THEIR assignment forward, never the previous provider's transcript, and an assignment with no usable timestamp fails closed. Cursor paging rather than offset: rows arrive at the end while a reader pages, so an offset scan silently repeats or skips messages.

- **Domain service** — `services/messaging/messagingService.listMessages`
- **Error codes** — `CONVERSATION_ACCESS_DENIED`, `INTERNAL`, `MESSAGE_HISTORY_UNAVAILABLE`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Path params** — `conversationId` (integer) chat_conversations.id
- **Query** — `limit` (integer) Default 30, clamped to 100.; `cursor` (integer) A message id. Returns messages strictly OLDER than it.
- **Callers** — Cust Mobile ⏳ · Cust Web ⏳ · Prov Mobile ⏳ · Prov Web ✅ · Admin ⏳
- **Legacy it replaces**
  - `GET /api/chat/conversations/:id/messages` — **ALIAS_TEMPORARILY** — The live transcript read, now a narrower projection of the SAME page reader — same authorization, same read floor, same builder. Its cursor parameter is called `before`; the canonical one is `cursor`, and both mean the same message id.
  - `GET /api/admin/communications/conversations/:id/messages` — **ROLE_SPECIFIC** — The permissioned admin transcript. It reads the whole thread by design — the audit trail is the point — where this route applies the caller's own read floor.

### `POST /api/v1/conversations/:conversationId/messages`

Sends a message. The sender is the authenticated caller.

> Nothing in the body names a sender. `sender_uid` is written from the actor the handler built out of the verified token, and there is no path, query or body parameter that can name another one.

- **Domain service** — `chat/chat.service.sendMessage`
- **Error codes** — `CONVERSATION_ACCESS_DENIED`, `CONVERSATION_NOT_WRITABLE`, `INTERNAL`, `MESSAGE_ATTACHMENT_REJECTED`, `MESSAGE_IDEMPOTENCY_KEY_INVALID`, `MESSAGE_INVALID`, `RATE_LIMITED`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Path params** — `conversationId` (integer) chat_conversations.id
- **Callers** — Cust Mobile ⏳ · Cust Web ⏳ · Prov Mobile ⏳ · Prov Web ✅ · Admin ⏳
- **Legacy it replaces**
  - `POST /api/chat/conversations/:id/messages` — **ALIAS_TEMPORARILY** — The live send for all four apps. IDENTICAL domain call — this entry is a second URL onto one write, not a second write path.
  - `POST /api/admin/communications/conversations/:id/messages` — **ROLE_SPECIFIC** — The admin send. Permissioned and audited, and it already delegates to `chat.service.sendMessage`, so an admin message obeys the same idempotency, validation and attachment rules as anyone else's.

### `POST /api/v1/conversations/:conversationId/attachments`

Stores one attachment for a conversation the caller may write to.

> The MIME allowlist and the 10 MB ceiling are checked by SIGNATURE, not by the declared content type, and the stored filename is sanitised rather than echoed.

- **Domain service** — `chat/chat.service.uploadAttachment`
- **Error codes** — `CONVERSATION_ACCESS_DENIED`, `CONVERSATION_NOT_WRITABLE`, `INTERNAL`, `MESSAGE_ATTACHMENT_REJECTED`, `RATE_LIMITED`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Path params** — `conversationId` (integer) chat_conversations.id
- **Callers** — Cust Mobile · · Cust Web · · Prov Mobile · · Prov Web · · Admin ·
- **Legacy it replaces**
  - `POST /api/chat/attachments/upload` — **CANONICALIZE** — The legacy route takes the conversation as an OPTIONAL body field and checks access only when it is present, so omitting it stored a file and returned a URL with no conversation consulted. This route carries the id in its path, so the check cannot be declined. Same validation, same storage call — `chat.service.uploadAttachment` is now the one implementation and the legacy controller delegates to it.

### `POST /api/v1/conversations/:conversationId/messages/:messageId/report`

Reports one message in this conversation to moderation.

> The reporter is the token subject. Nothing in the path or body can name a different one, which is what stops a report being filed as somebody else.

- **Domain service** — `chat/chat.service.reportMessage`
- **Error codes** — `CONVERSATION_ACCESS_DENIED`, `INTERNAL`, `MESSAGE_INVALID`, `MESSAGE_NOT_FOUND`, `RATE_LIMITED`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Path params** — `conversationId` (integer) chat_conversations.id; `messageId` (integer) chat_messages.id
- **Callers** — Cust Mobile · · Cust Web · · Prov Mobile · · Prov Web · · Admin —
- **Legacy it replaces**
  - `POST /api/chat/conversations/:id/messages/:msgId/report` — **ALIAS_TEMPORARILY** — IDENTICAL domain call. This entry is a second URL onto one write, in the resource shape the rest of the conversations domain already uses.

### `POST /api/v1/conversations/:conversationId/read`

Advances the caller's read pointer and returns the resulting unread count.

> A POST that is genuinely idempotent: the pointer is a monotonic high-water mark, only ever advanced, and only to a message that exists in THIS conversation and is visible to this participant — both enforced in SQL, so an out-of-order client cannot un-read a conversation or point at somebody else's thread.

- **Domain service** — `services/messaging/messagingService.markRead`
- **Error codes** — `CONVERSATION_ACCESS_DENIED`, `INTERNAL`, `READ_POINTER_INVALID`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Path params** — `conversationId` (integer) chat_conversations.id
- **Callers** — Cust Mobile ⏳ · Cust Web ⏳ · Prov Mobile ⏳ · Prov Web ✅ · Admin ⏳
- **Legacy it replaces**
  - `POST /api/chat/conversations/:id/read` — **ALIAS_TEMPORARILY** — The live read-pointer call, which answers `{ success: true }` and nothing else. The canonical one returns the resulting unread count, so a client stops having to guess what its badge should now say.

## booking-experiences

| Method | Path | Status | Auth | Request | Response | Idem | Owner |
|---|---|---|---|---|---|---|---|
| `GET` | `/api/v1/bookings/:bookingId/tracking` | **live** | any signed-in | — | `BookingTracking` | yes | booking-experiences |
| `POST` | `/api/v1/bookings/:bookingId/otp/request` | **live** | any signed-in | `BookingOtpRequest` | `BookingOtpIssued` | no | booking-experiences |
| `POST` | `/api/v1/bookings/:bookingId/otp/verify` | **live** | any signed-in | `BookingOtpVerifyRequest` | `BookingTransitionResult` | no | booking-experiences |
| `GET` | `/api/v1/bookings/:bookingId/otp/status` | **live** | any signed-in | — | `BookingOtpStatus` | yes | booking-experiences |
| `POST` | `/api/v1/bookings/:bookingId/reschedule` | **live** | any signed-in | `BookingRescheduleRequest` | `BookingRescheduleResult` | no | booking-experiences |
| `GET` | `/api/v1/bookings/:bookingId/reschedule` | **live** | any signed-in | — | `BookingRescheduleHistory` | yes | booking-experiences |
| `POST` | `/api/v1/bookings/:bookingId/additional-work` | **live** | provider (role 2/4) | `BookingAdditionalWorkRequest` | `BookingAdditionalWorkResult` | no | booking-experiences |
| `GET` | `/api/v1/bookings/:bookingId/additional-work` | **live** | any signed-in | — | `BookingAdditionalWorkList` | yes | booking-experiences |
| `POST` | `/api/v1/bookings/:bookingId/disputes` | **live** | any signed-in | `BookingDisputeRequest` | `BookingDisputeResult` | no | booking-experiences |
| `GET` | `/api/v1/bookings/:bookingId/disputes` | **live** | any signed-in | — | `BookingDisputeList` | yes | booking-experiences |

### `GET /api/v1/bookings/:bookingId/tracking`

Tracking history, canonical state, and the provider's position when the policy permits it.

> A withheld position is a 200 with visibility.reason, never a 403: the caller is entitled to the booking and simply not to a live location for it yet. The unauthenticated GET /api/workers/location/:uid is NOT listed as legacy here because it no longer exists — it was retired with the rest of the worker-lookup family (docs/WORKER_ROUTE_MIGRATION.md). Naming a deleted route as a live alias would put a phantom row in the migration matrix and in the telemetry watch list.

- **Domain service** — `services/booking/bookingTrackingService.getBookingTracking`
- **Error codes** — `BOOKING_ACCESS_DENIED`, `BOOKING_NOT_FOUND`, `INTERNAL`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Path params** — `bookingId` (integer) bookings.id
- **Callers** — Cust Mobile ⏳ · Cust Web ⏳ · Prov Mobile ✅ · Prov Web ✅ · Admin ·
- **Legacy it replaces**
  - `GET /api/:id/tracking` — **ALIAS_TEMPORARILY** — The live customer tracking call. It returns the raw booking_tracking rows through formatBookings and applies NO state or time-window rule to the provider position, because it never returned one — the position came from a separate route.
  - `GET /api/booking/:bookingId/provider-location` — **ALIAS_TEMPORARILY** — The authenticated position route. Booking-scoped already, but answers in EVERY state — a customer could watch their provider on a booking cancelled last week. This entry adds the state and time-window rules §64 requires.

### `POST /api/v1/bookings/:bookingId/otp/request`

Issues a booking code for one purpose. The code is never in the response.

- **Domain service** — `services/booking/bookingOtpService.requestBookingOtp`
- **Error codes** — `BOOKING_ACCESS_DENIED`, `BOOKING_NOT_FOUND`, `BOOKING_OTP_ACTOR_NOT_PERMITTED`, `BOOKING_OTP_NOT_APPLICABLE`, `BOOKING_OTP_PURPOSE_INVALID`, `BOOKING_OTP_RESEND_COOLDOWN`, `BOOKING_OTP_RESEND_LIMIT`, `INTERNAL`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Path params** — `bookingId` (integer) bookings.id
- **Callers** — Cust Mobile ⏳ · Cust Web · · Prov Mobile — · Prov Web — · Admin ·
- **Legacy it replaces**
  - `POST /api/:bookingId/resend-otp` — **ALIAS_TEMPORARILY** — The OTP screen's Resend button. It rotates the code with no cooldown and no issue ceiling; it now delegates to the same service, so the legacy path inherits the policy rather than remaining an unlimited rotation oracle.

### `POST /api/v1/bookings/:bookingId/otp/verify`

Presents a booking code. Success is a state transition performed by the executor.

> Purpose-scoped. BOOKING_CONFIRMATION is presented by the customer and checked against otp_code; SERVICE_START is presented by the assigned provider and checked against worker_code. A code cannot satisfy the other purpose — different column, different permitted actor.

- **Domain service** — `services/booking/bookingOtpService.verifyBookingOtp`
- **Error codes** — `BOOKING_ACCESS_DENIED`, `BOOKING_NOT_FOUND`, `BOOKING_OTP_ACTOR_NOT_PERMITTED`, `BOOKING_OTP_ATTEMPTS_EXHAUSTED`, `BOOKING_OTP_EXPIRED`, `BOOKING_OTP_INVALID`, `BOOKING_OTP_NOT_APPLICABLE`, `BOOKING_OTP_NOT_ISSUED`, `BOOKING_OTP_PURPOSE_INVALID`, `BOOKING_STATE_CONFLICT`, `BOOKING_TERMINAL`, `BOOKING_TRANSITION_INVALID`, `BOOKING_WORKER_CODE_INVALID`, `IDEMPOTENCY_KEY_INVALID`, `IDEMPOTENCY_KEY_REUSED`, `INTERNAL`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Path params** — `bookingId` (integer) bookings.id
- **Callers** — Cust Mobile ⏳ · Cust Web · · Prov Mobile · · Prov Web ✅ · Admin ·
- **Legacy it replaces**
  - `POST /api/:id/confirm-otp` — **ALIAS_TEMPORARILY** — The live customer confirmation. Already on the executor since Phase C; it now delegates through the OTP service so expiry and the attempt limit apply to it too. Accepts the code in the query string for builds that cannot be changed.

### `GET /api/v1/bookings/:bookingId/otp/status`

Code lifetime, attempts left and resend availability, without spending an attempt.

> Exists so a client renders "resend in 42s" and "2 attempts left" from the backend rather than from its own copy of the policy — the same argument availableActions makes for buttons.

- **Domain service** — `services/booking/bookingOtpService.readCredentialState`
- **Error codes** — `BOOKING_ACCESS_DENIED`, `BOOKING_NOT_FOUND`, `BOOKING_OTP_PURPOSE_INVALID`, `INTERNAL`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Path params** — `bookingId` (integer) bookings.id
- **Query** — `purpose` (string) BOOKING_CONFIRMATION (default) or SERVICE_START.
- **Callers** — Cust Mobile · · Cust Web · · Prov Mobile ✅ · Prov Web ✅ · Admin ·
- **Legacy it replaces** — none; new capability.

### `POST /api/v1/bookings/:bookingId/reschedule`

Moves a booking. One endpoint for the customer and the admin.

> The provider is not a party (C18 §14/§24) and is refused with BOOKING_ACCESS_DENIED; they are notified of the outcome. A move that would collide with the assigned provider's calendar is refused, never silently released.

- **Domain service** — `services/booking/bookingRescheduleService.rescheduleBooking`
- **Error codes** — `BOOKING_ACCESS_DENIED`, `BOOKING_NOT_FOUND`, `BOOKING_NOT_RESCHEDULABLE`, `BOOKING_RESCHEDULE_NOTICE_REQUIRED`, `BOOKING_RESCHEDULE_PROVIDER_CONFLICT`, `BOOKING_RESCHEDULE_REASON_INVALID`, `BOOKING_SCHEDULE_CHANGED`, `BOOKING_SCHEDULE_INVALID`, `INTERNAL`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Path params** — `bookingId` (integer) bookings.id
- **Callers** — Cust Mobile · · Cust Web · · Prov Mobile — · Prov Web — · Admin ⏳
- **Legacy it replaces**
  - `POST /api/admin/bookings/:id/reschedule` — **ALIAS_TEMPORARILY** — The admin-only predecessor, and the only reschedule that has ever existed. A bare UPDATE with no optimistic concurrency and no provider-calendar check — two admins moving one booking produced a silent winner. Kept until the portal migrates.

### `GET /api/v1/bookings/:bookingId/reschedule`

Every attempt to move this booking, accepted or refused.

> What makes "no silent overwrite" observable to a client rather than only true in the database. The proposer's uid is not projected — the role is.

- **Domain service** — `services/booking/bookingRescheduleService.listRescheduleRequests`
- **Error codes** — `BOOKING_ACCESS_DENIED`, `BOOKING_NOT_FOUND`, `INTERNAL`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Path params** — `bookingId` (integer) bookings.id
- **Callers** — Cust Mobile · · Cust Web · · Prov Mobile · · Prov Web ✅ · Admin ·
- **Legacy it replaces** — none; new capability.

### `POST /api/v1/bookings/:bookingId/additional-work`

Raises a change order against the booking, as a child request awaiting approval.

> Additional work was ALREADY a child-request model (booking_additional_requests + booking_additional_items with its own approval/payment states). This gives it a booking-scoped canonical path; it does not re-model it.

- **Domain service** — `services/additional.service.additionalService.createRequest`
- **Error codes** — `BOOKING_ACCESS_DENIED`, `BOOKING_ADDITIONAL_WORK_INVALID`, `BOOKING_ADDITIONAL_WORK_NOT_IN_PROGRESS`, `BOOKING_NOT_FOUND`, `INTERNAL`, `PROVIDER_ROLE_REQUIRED`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Path params** — `bookingId` (integer) bookings.id
- **Callers** — Cust Mobile — · Cust Web — · Prov Mobile ✅ · Prov Web ✅ · Admin —
- **Legacy it replaces**
  - `POST /api/additional/request/:userId` — **ALIAS_TEMPORARILY** — The live Provider Web call. Its :userId segment is legacy and has never been treated as identity — the provider comes from the token in both paths, and both call the same additionalService instance.

### `GET /api/v1/bookings/:bookingId/additional-work`

The change orders on this booking, for anyone entitled to the booking.

- **Domain service** — `services/additional.service.additionalService.getByBooking`
- **Error codes** — `BOOKING_ACCESS_DENIED`, `BOOKING_NOT_FOUND`, `INTERNAL`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Path params** — `bookingId` (integer) bookings.id
- **Callers** — Cust Mobile · · Cust Web · · Prov Mobile ✅ · Prov Web ⏳ · Admin ·
- **Legacy it replaces**
  - `GET /api/additional/booking/:bookingId` — **ALIAS_TEMPORARILY** — Already booking-scoped and already the same service. The canonical path differs only in living under the booking it belongs to, which is what §60 asks for.

### `POST /api/v1/bookings/:bookingId/disputes`

Opens a dispute against the booking, with the service and financial state at that moment.

> One record for all three actors. A second dispute table would have given admin, provider and customer different answers to "is this booking disputed?" — the admin portal, deriveCanonicalState and the payout hold all read booking_escalations.

- **Domain service** — `services/booking/bookingDisputeService.openDispute`
- **Error codes** — `BOOKING_ACCESS_DENIED`, `BOOKING_DISPUTE_ALREADY_OPEN`, `BOOKING_DISPUTE_CATEGORY_INVALID`, `BOOKING_DISPUTE_NOT_ACTIONABLE`, `BOOKING_NOT_FOUND`, `INTERNAL`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Path params** — `bookingId` (integer) bookings.id
- **Callers** — Cust Mobile · · Cust Web · · Prov Mobile ✅ · Prov Web ✅ · Admin ⏳
- **Legacy it replaces**
  - `POST /api/admin/bookings/:id/escalate` — **ALIAS_TEMPORARILY** — The admin-only predecessor, and the only way to open a dispute before this. Writes the same booking_escalations row; it does not record a category, the opening role or the state snapshot §66 requires. Kept until the portal migrates.
  - `GET /api/provider/bookings/:bookingId/dispute-status` — **ROLE_SPECIFIC** — Provider-facing eligibility summary, shipped as "entry point only; opening is later". It reads the same table and the same categories. It stays because it answers "may I open one" for a live client that has no other way to ask.

### `GET /api/v1/bookings/:bookingId/disputes`

The disputes on this booking. Investigation notes are never projected.

> `reason`, `assigned_team` and `actor_uid` are withheld from every caller: free text one party typed about another, internal routing, and a person. Only `openedByYou` varies by caller.

- **Domain service** — `services/booking/bookingDisputeService.listDisputes`
- **Error codes** — `BOOKING_ACCESS_DENIED`, `BOOKING_NOT_FOUND`, `INTERNAL`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Path params** — `bookingId` (integer) bookings.id
- **Callers** — Cust Mobile · · Cust Web · · Prov Mobile ✅ · Prov Web ✅ · Admin ·
- **Legacy it replaces** — none; new capability.

## admin-finance

| Method | Path | Status | Auth | Request | Response | Idem | Owner |
|---|---|---|---|---|---|---|---|
| `POST` | `/api/v1/admin/refunds/:refundId/mark-failed` | **live** | admin (role 1) | `RefundFailureRequest` | `RefundTransitionResult` | no | admin-finance |

### `POST /api/v1/admin/refunds/:refundId/mark-failed`

Record that an approved refund did not go through.

> Distinct from reject: rejected means a human decided against the refund, failed means everyone agreed and the money did not move. Only the second is worth retrying.

- **Domain service** — `services/adminFinanceService.markRefundFailed`
- **Error codes** — `CONFLICT`, `INTERNAL`, `NOT_FOUND`, `PERMISSION_REQUIRED`, `ROLE_REQUIRED`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Path params** — `refundId` (integer) finance_refund_reviews.id
- **Callers** — Cust Mobile — · Cust Web — · Prov Mobile — · Prov Web — · Admin ⏳
- **Legacy it replaces**
  - `POST /api/admin/finance/refunds/:refundId/mark-failed` — **CANONICALIZE** — Mounted in the same change as this entry rather than inherited. The transition did not exist before — an approved refund the processor refused had no terminal, so it stayed `approved` and BLOCKED every retry for that booking, because openRefundReview refuses a second review while one is requested or approved. Both surfaces call the same executor; neither carries a copy of the rule.

## admin-bookings

| Method | Path | Status | Auth | Request | Response | Idem | Owner |
|---|---|---|---|---|---|---|---|
| `GET` | `/api/v1/admin/bookings` | **live** | admin (role 1) | — | `AdminBookingList` | yes | admin-bookings |
| `GET` | `/api/v1/admin/bookings/:bookingId/assignment-candidates` | **live** | admin (role 1) | — | `AssignmentCandidatePool` | yes | admin-bookings |
| `POST` | `/api/v1/admin/bookings/:bookingId/assign` | **live** | admin (role 1) | `AdminAssignRequest` | `AdminBookingActionResult` | no | admin-bookings |
| `POST` | `/api/v1/admin/bookings/:bookingId/reassign` | **live** | admin (role 1) | `AdminReassignRequest` | `AdminBookingActionResult` | no | admin-bookings |

### `GET /api/v1/admin/bookings`

Admin booking operations list.

- **Domain service** — `services/adminBookingService.listBookings`
- **Error codes** — `INTERNAL`, `PERMISSION_REQUIRED`, `ROLE_REQUIRED`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`
- **Callers** — Cust Mobile — · Cust Web — · Prov Mobile — · Prov Web — · Admin ⏳
- **Legacy it replaces**
  - `GET /api/admin/bookings` — **CANONICALIZE** — The admin portal is the only caller and deploys from git on every push, so it is the cheapest client to migrate — but it is also the only one whose list carries permission-scoped columns, so the DTO needs the permission model resolved first.

### `GET /api/v1/admin/bookings/:bookingId/assignment-candidates`

Providers who could take this booking, ranked, each with its blocking reasons — and a diagnosis of the pool itself.

> Read-only, but it is the preview of a mutation, so it must qualify providers with the predicate the assign call commits with. It does: both run PROVIDER_CAPABILITY_SQL. A preview narrower than its committer does not fail safe — it hides assignable providers.

- **Domain service** — `services/providerEligibilityEngine.listAssignmentCandidatePool`
- **Error codes** — `INTERNAL`, `NOT_FOUND`, `PERMISSION_REQUIRED`, `ROLE_REQUIRED`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Path params** — `bookingId` (integer) bookings.id
- **Callers** — Cust Mobile — · Cust Web — · Prov Mobile — · Prov Web — · Admin ⏳
- **Legacy it replaces**
  - `GET /api/admin/bookings/:id/assignment-candidates` — **CANONICALIZE** — Live, and the only caller is the admin portal. Already returns the canonical pool plus its diagnostics; the diagnostics are a sibling key so the array under `data` stays exactly what the portal parses today.

### `POST /api/v1/admin/bookings/:bookingId/assign`

Assign a provider to an unassigned booking.

> Role-specific by AUTHORIZATION, not by truth: only an admin may name another actor as the provider. A provider accepting their own job goes through provider.jobs.accept, which derives identity from the token and can never name somebody else.

- **Domain service** — `services/booking/transitionExecutor.transitionBooking (ADMIN_ASSIGN)`
- **Error codes** — `BOOKING_STATE_CONFLICT`, `CONFLICT`, `INTERNAL`, `NOT_FOUND`, `PERMISSION_REQUIRED`, `ROLE_REQUIRED`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Path params** — `bookingId` (integer) bookings.id
- **Callers** — Cust Mobile — · Cust Web — · Prov Mobile — · Prov Web — · Admin ⏳
- **Legacy it replaces**
  - `POST /api/admin/bookings/:id/assign` — **CANONICALIZE** — Live admin portal route, already on the canonical executor. Path-only migration: the business rules, locks and events do not move with it.

### `POST /api/v1/admin/bookings/:bookingId/reassign`

Move an assigned booking from one provider to another, with an audited reason.

> The override record — actor, reason, previous provider, new provider — is written by the executor, not by the controller, so it cannot be skipped by a caller that forgets to audit. Reassignment preserves the outgoing provider's progression rather than erasing it.

- **Domain service** — `services/booking/transitionExecutor.transitionBooking (ADMIN_REASSIGN)`
- **Error codes** — `BOOKING_STATE_CONFLICT`, `CONFLICT`, `INTERNAL`, `NOT_FOUND`, `PERMISSION_REQUIRED`, `ROLE_REQUIRED`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Path params** — `bookingId` (integer) bookings.id
- **Callers** — Cust Mobile — · Cust Web — · Prov Mobile — · Prov Web — · Admin ⏳
- **Legacy it replaces**
  - `POST /api/admin/bookings/:id/reassign` — **CANONICALIZE** — Live admin portal route, already on the canonical executor. A separate permission from assign (bookings.reassign_provider), which is the reason it stays a separate endpoint rather than an assign with a different body.

## finance

| Method | Path | Status | Auth | Request | Response | Idem | Owner |
|---|---|---|---|---|---|---|---|
| `POST` | `/api/v1/bookings/:bookingId/payment-intents` | **live** | any signed-in | `PaymentIntentRequest` | `PaymentIntent` | no | finance-payments |
| `GET` | `/api/v1/bookings/:bookingId/payment` | **live** | any signed-in | — | `BookingPayment` | yes | finance-payments |
| `POST` | `/api/v1/bookings/:bookingId/refunds` | **live** | any signed-in | `RefundRequest` | `RefundResult` | no | finance-refunds |
| `GET` | `/api/v1/provider/earnings/summary` | **live** | provider (role 2/4) | — | `ProviderEarningsSummary` | yes | finance-earnings |
| `GET` | `/api/v1/provider/earnings/transactions` | **live** | provider (role 2/4) | — | `ProviderEarningsTransactions` | yes | finance-earnings |
| `GET` | `/api/v1/provider/earnings/payouts` | **live** | provider (role 2/4) | — | `ProviderPayouts` | yes | finance-payouts |
| `GET` | `/api/v1/admin/finance/reconciliation` | **live** | admin (role 1) | — | `FinanceReconciliation` | yes | finance-reconciliation |

### `POST /api/v1/bookings/:bookingId/payment-intents`

Starts or resumes the customer checkout for a booking.

> The return origin is chosen from a server-side allowlist, never from a caller-supplied string — a stored session encodes the URLs it was built with, so handing one back to a caller resolving to another origin would return the payer to a different application.

- **Domain service** — `services/finance/bookingPaymentService.startPaymentIntent`
- **Error codes** — `BOOKING_ACCESS_DENIED`, `BOOKING_NOT_FOUND`, `INTERNAL`, `PAYMENT_ACTOR_NOT_PERMITTED`, `PAYMENT_PROCESSOR_UNAVAILABLE`, `PAYMENT_STATE_CONFLICT`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Path params** — `bookingId` (integer) bookings.id
- **Callers** — Cust Mobile ⏳ · Cust Web ⏳ · Prov Mobile — · Prov Web — · Admin ·
- **Legacy it replaces**
  - `POST /api/:bookingId/paymongo/create` — **ALIAS_TEMPORARILY** — The live customer checkout call. Identical domain service — this entry adds the booking-scoped authorization and refuses a provider, which the legacy route does not do. Kept until Customer Web and Customer Mobile migrate.

### `GET /api/v1/bookings/:bookingId/payment`

A booking's payment state and price breakdown, scoped to the caller's seat.

> One endpoint, three explicit DTOs. The provider is shown the gross their share is a percentage of and never the customer refund position or the processor reference; the customer is shown what they paid and never the provider share. The CALCULATION is the same object for all three, so no two seats can be told different totals.

- **Domain service** — `services/finance/bookingPaymentService.getBookingPayment`
- **Error codes** — `BOOKING_ACCESS_DENIED`, `BOOKING_NOT_FOUND`, `INTERNAL`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Path params** — `bookingId` (integer) bookings.id
- **Callers** — Cust Mobile · · Cust Web · · Prov Mobile ✅ · Prov Web · · Admin ·
- **Legacy it replaces**
  - `GET /api/admin/finance/ledger/booking/:bookingId` — **ROLE_SPECIFIC** — The admin revenue-recognition view over finance_ledger_entries. It answers a different question (what was recognised, when, by whom) and carries its own permission. Both now read the same underlying capture events.

### `POST /api/v1/bookings/:bookingId/refunds`

Requests a refund (customer) or issues one (admin).

> One rule, two outcomes. A customer REQUESTS (a review row, no processor call) and an admin ISSUES (money moves). Both run evaluateRefundEligibility first, so a request can never be accepted for a booking an issue would refuse.

- **Domain service** — `services/finance/bookingPaymentService.refundBookingPayment`
- **Error codes** — `BOOKING_ACCESS_DENIED`, `BOOKING_NOT_FOUND`, `INTERNAL`, `PAYMENT_ACTOR_NOT_PERMITTED`, `PAYMENT_NOT_FOUND`, `REFUND_ALREADY_SETTLED`, `REFUND_EXCEEDS_CAPTURED`, `REFUND_IN_PROGRESS`, `REFUND_OUTCOME_NOT_REFUNDABLE`, `REFUND_PAYMENT_NOT_CAPTURED`, `REFUND_TRIGGER_INVALID`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`, `VALIDATION_FAILED`
- **Path params** — `bookingId` (integer) bookings.id
- **Callers** — Cust Mobile · · Cust Web · · Prov Mobile — · Prov Web — · Admin ⏳
- **Legacy it replaces**
  - `POST /api/admin/finance/refunds` — **ALIAS_TEMPORARILY** — The admin portal opens refund reviews here today. Same table, same eligibility rule once migrated; this entry adds the customer-initiated path, which had no route at all.

### `GET /api/v1/provider/earnings/summary`

The provider's own earnings totals, with pending split from failed and estimated.

> Totalled from the SAME per-booking calculator the transaction list uses, not from a parallel aggregate query. The previous aggregate drifted from the list in three ways before anyone noticed. An INTERNAL_FIXER receives zeroes and a withheldReason, never an estimate of money that will not arrive.

- **Domain service** — `services/finance/providerEarningsService.getEarningsSummary`
- **Error codes** — `EARNINGS_RANGE_INVALID`, `INTERNAL`, `PROVIDER_ROLE_REQUIRED`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`
- **Query** — `startDate` (string) ISO date. Must be sent with endDate.; `endDate` (string) ISO date. Must be sent with startDate.
- **Callers** — Cust Mobile — · Cust Web — · Prov Mobile ⏳ · Prov Web ✅ · Admin —
- **Legacy it replaces**
  - `GET /api/provider/earnings/summary` — **ALIAS_TEMPORARILY** — The live provider portal call, now delegating to the same domain service so the two paths return identical figures during migration rather than merely similar ones.

### `GET /api/v1/provider/earnings/transactions`

One row per completed job with its gross, the provider's share and its payout state.

> The gross includes PAID additional work, which is charged through its own checkout and never written back to bookings.final_price — a reader treating final_price as the gross shows a booking amount the provider share is visibly not 80% of.

- **Domain service** — `services/finance/providerEarningsService.listEarningsTransactions`
- **Error codes** — `EARNINGS_RANGE_INVALID`, `INTERNAL`, `PROVIDER_ROLE_REQUIRED`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`
- **Query** — `startDate` (string) ISO date. Must be sent with endDate.; `endDate` (string) ISO date. Must be sent with startDate.
- **Callers** — Cust Mobile — · Cust Web — · Prov Mobile ⏳ · Prov Web ✅ · Admin —
- **Legacy it replaces**
  - `GET /api/provider/earnings` — **ALIAS_TEMPORARILY** — The live earnings list. Same domain service now; the v1 shape adds the economic model, the payout block reason and minor-unit amounts.
  - `GET /api/provider/ledger` — **ALIAS_TEMPORARILY** — A THIRD reading of the same columns, which used to hardcode every completed booking as "settled" and report failed payouts as money in hand. Superseded entirely.
  - `GET /api/workers/:uid/earnings-history` — **RETIRE** — Takes the provider uid from the URL and has no auth, so it answers for anybody. No located caller in any of the five clients. Carried over from the planned placeholder this entry replaces; delete once telemetry confirms zero traffic.

### `GET /api/v1/provider/earnings/payouts`

The provider's own payouts, with the 72-hour window's expected arrival date.

> The expected arrival date is computed by the backend from the SAME constant the release scheduler uses. Provider Web previously recomputed it as 48 hours against a scheduler that releases at 72, telling providers their money was due a day early.

- **Domain service** — `services/finance/providerEarningsService.listProviderPayouts`
- **Error codes** — `INTERNAL`, `PROVIDER_ROLE_REQUIRED`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`
- **Callers** — Cust Mobile — · Cust Web — · Prov Mobile ⏳ · Prov Web ✅ · Admin —
- **Legacy it replaces**
  - `GET /api/provider/payouts` — **ALIAS_TEMPORARILY** — The live payouts list, now delegating to the same domain service. Both exclude the processor id, servana_share, payout_error and the admin hold fields by projection.

### `GET /api/v1/admin/finance/reconciliation`

Ledger reconciliation: every check, its open breaks, and the platform money totals.

> READ-ONLY. It does not run the checks — running them writes rows, and a GET that mutates is one somebody eventually puts behind a dashboard refresh timer. POST /api/admin/finance/reconciliation/run remains the way to produce a fresh set.

- **Domain service** — `services/finance/financeReconciliationService.getReconciliationReport`
- **Error codes** — `INTERNAL`, `PERMISSION_REQUIRED`, `ROLE_REQUIRED`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHENTICATED`
- **Query** — `status` (string) Exception status. Defaults to 'open'.; `severity` (string) info \| warning \| critical.; `limit` (integer) Breaks returned. Max 200.
- **Callers** — Cust Mobile — · Cust Web — · Prov Mobile — · Prov Web — · Admin ⏳
- **Legacy it replaces**
  - `GET /api/admin/finance/reconciliation/exceptions` — **ALIAS_TEMPORARILY** — The paged exception list the admin portal reads today. This entry adds the check catalog, the money totals and the outstanding provider liability, so an admin can see that the ledger balances rather than only that a page of rows exists.

## Cross-client caller matrix

| Endpoint | Cust Mobile | Cust Web | Prov Mobile | Prov Web | Admin |
|---|---|---|---|---|---|
| `GET /api/v1/catalog` | · | · | — | — | — |
| `POST /api/v1/telemetry` | — | — | · | · | — |
| `GET /api/v1/client-config` | · | — | · | — | — |
| `GET /api/v1/health` | — | — | — | — | — |
| `GET /api/v1/openapi.json` | · | · | · | · | · |
| `GET /api/v1/catalog/summary` | · | · | — | — | — |
| `GET /api/v1/catalog/services` | · | · | — | — | — |
| `GET /api/v1/catalog/services/:serviceId` | · | · | — | — | — |
| `GET /api/v1/me` | · | · | ✅ | ✅ | · |
| `GET /api/v1/bookings` | ⏳ | ⏳ | — | — | — |
| `GET /api/v1/bookings/:bookingId` | ⏳ | ⏳ | ⏳ | · | · |
| `GET /api/v1/bookings/:bookingId/timeline` | ⏳ | · | — | — | — |
| `GET /api/v1/provider/jobs` | — | — | ✅ | ✅ | — |
| `GET /api/v1/provider/jobs/:bookingId` | — | — | ✅ | ✅ | — |
| `GET /api/v1/notifications` | ⏳ | ⏳ | ⏳ | ✅ | · |
| `GET /api/v1/notifications/unread-count` | ⏳ | ⏳ | ⏳ | ✅ | · |
| `PATCH /api/v1/notifications/:key/read` | ⏳ | ⏳ | ⏳ | ✅ | · |
| `DELETE /api/v1/notifications/:key` | · | · | · | ✅ | — |
| `POST /api/v1/notifications/read-all` | ⏳ | ⏳ | ⏳ | ✅ | · |
| `GET /api/v1/me/notification-preferences` | · | · | ⏳ | ✅ | · |
| `PATCH /api/v1/me/notification-preferences` | · | · | ⏳ | ✅ | · |
| `POST /api/v1/me/devices` | ⏳ | · | ✅ | ✅ | — |
| `DELETE /api/v1/me/devices` | ⏳ | · | ✅ | ✅ | — |
| `PATCH /api/v1/me` | ⏳ | ⏳ | ⏳ | ⏳ | · |
| `GET /api/v1/me/settings` | · | · | ✅ | · | · |
| `PATCH /api/v1/me/settings` | · | · | ✅ | · | · |
| `GET /api/v1/me/security` | · | · | · | · | · |
| `GET /api/v1/me/completion` | · | · | ✅ | · | — |
| `GET /api/v1/customer/profile` | ⏳ | ⏳ | — | — | · |
| `PATCH /api/v1/customer/profile` | ⏳ | ⏳ | — | — | · |
| `GET /api/v1/customer/addresses` | ⏳ | ⏳ | — | — | — |
| `POST /api/v1/customer/addresses` | ⏳ | ⏳ | — | — | — |
| `PATCH /api/v1/customer/addresses/:addressId` | ⏳ | ⏳ | — | — | — |
| `DELETE /api/v1/customer/addresses/:addressId` | ⏳ | ⏳ | — | — | — |
| `POST /api/v1/customer/addresses/:addressId/default` | ⏳ | ⏳ | — | — | — |
| `GET /api/v1/provider/profile` | — | — | ⏳ | ✅ | · |
| `PATCH /api/v1/provider/profile` | — | — | ⏳ | ✅ | — |
| `GET /api/v1/providers/:providerUid/profile` | · | · | — | — | · |
| `GET /api/v1/provider/documents` | — | — | ⏳ | ✅ | — |
| `GET /api/v1/provider/document-types` | — | — | ✅ | ⏳ | — |
| `POST /api/v1/provider/documents` | — | — | ✅ | ✅ | — |
| `GET /api/v1/provider/documents/:documentId/preview` | — | — | ✅ | ✅ | — |
| `DELETE /api/v1/provider/documents/:documentId` | — | — | ✅ | ✅ | — |
| `GET /api/v1/provider/availability` | — | — | ⏳ | ⏳ | — |
| `PATCH /api/v1/provider/availability` | — | — | ⏳ | ⏳ | — |
| `GET /api/v1/provider/time-off` | — | — | ✅ | ⏳ | — |
| `POST /api/v1/provider/time-off` | — | — | ✅ | ⏳ | — |
| `DELETE /api/v1/provider/time-off/:timeOffId` | — | — | ✅ | ⏳ | — |
| `GET /api/v1/provider/services` | — | — | ✅ | · | — |
| `GET /api/v1/reviews/providers/:providerUid` | · | · | — | — | — |
| `GET /api/v1/reviews/providers/:providerUid/rating` | · | · | — | — | — |
| `POST /api/v1/bookings/:bookingId/review` | ⏳ | ⏳ | — | — | — |
| `GET /api/v1/bookings/:bookingId/review` | ⏳ | ⏳ | — | — | — |
| `POST /api/v1/bookings/:bookingId/support-cases` | · | · | — | — | — |
| `GET /api/v1/bookings/:bookingId/support-cases` | · | · | — | — | — |
| `GET /api/v1/settings/notification-preferences` | · | · | ⏳ | ⏳ | — |
| `PUT /api/v1/settings/notification-preferences` | · | · | ⏳ | ⏳ | — |
| `POST /api/v1/auth/register` | ⏳ | · | ⏳ | ⏳ | — |
| `POST /api/v1/auth/login` | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| `POST /api/v1/auth/refresh` | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| `POST /api/v1/auth/logout` | ⏳ | ⏳ | ⏳ | ✅ | ⏳ |
| `POST /api/v1/auth/forgot-password` | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| `POST /api/v1/auth/reset-password` | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| `POST /api/v1/auth/verify-email` | ⏳ | · | ⏳ | · | — |
| `POST /api/v1/auth/resend-verification` | ⏳ | · | ⏳ | ⏳ | — |
| `POST /api/v1/auth/verify-mobile` | · | · | ✅ | · | — |
| `GET /api/v1/search` | ⏳ | · | — | — | — |
| `GET /api/v1/catalog/search` | · | · | — | — | — |
| `GET /api/v1/catalog/categories` | · | · | — | — | — |
| `GET /api/v1/catalog/categories/:categoryId` | · | · | — | — | — |
| `GET /api/v1/catalog/categories/:categoryId/subcategories` | ⏳ | · | — | — | — |
| `GET /api/v1/catalog/subcategories/:subcategoryId` | · | · | — | — | — |
| `GET /api/v1/catalog/subcategories/:subcategoryId/services` | · | · | ⏳ | — | — |
| `GET /api/v1/home` | · | · | — | — | — |
| `GET /api/v1/home/sections` | · | · | — | — | · |
| `POST /api/v1/conversations` | ⏳ | ⏳ | ⏳ | ✅ | ⏳ |
| `GET /api/v1/conversations` | ⏳ | ⏳ | ⏳ | ✅ | ⏳ |
| `GET /api/v1/conversations/:conversationId` | ⏳ | ⏳ | ⏳ | ✅ | ⏳ |
| `GET /api/v1/conversations/:conversationId/messages` | ⏳ | ⏳ | ⏳ | ✅ | ⏳ |
| `POST /api/v1/conversations/:conversationId/messages` | ⏳ | ⏳ | ⏳ | ✅ | ⏳ |
| `POST /api/v1/conversations/:conversationId/attachments` | · | · | · | · | · |
| `POST /api/v1/conversations/:conversationId/messages/:messageId/report` | · | · | · | · | — |
| `POST /api/v1/conversations/:conversationId/read` | ⏳ | ⏳ | ⏳ | ✅ | ⏳ |
| `POST /api/v1/bookings/:bookingId/cancel` | ⏳ | ⏳ | — | — | — |
| `GET /api/v1/bookings/:bookingId/transitions` | · | · | ✅ | · | · |
| `POST /api/v1/provider/jobs/:bookingId/accept` | — | — | ✅ | ✅ | — |
| `POST /api/v1/provider/jobs/:bookingId/decline` | — | — | ✅ | ✅ | — |
| `POST /api/v1/provider/jobs/:bookingId/en-route` | — | — | ✅ | ✅ | — |
| `POST /api/v1/provider/jobs/:bookingId/arrived` | — | — | ✅ | ✅ | — |
| `POST /api/v1/provider/jobs/:bookingId/start` | — | — | ✅ | ⏳ | — |
| `POST /api/v1/provider/jobs/:bookingId/complete` | — | — | ✅ | ✅ | — |
| `POST /api/v1/provider/jobs/:bookingId/cancel` | — | — | ✅ | ✅ | — |
| `GET /api/v1/bookings/:bookingId/tracking` | ⏳ | ⏳ | ✅ | ✅ | · |
| `POST /api/v1/bookings/:bookingId/otp/request` | ⏳ | · | — | — | · |
| `POST /api/v1/bookings/:bookingId/otp/verify` | ⏳ | · | · | ✅ | · |
| `GET /api/v1/bookings/:bookingId/otp/status` | · | · | ✅ | ✅ | · |
| `POST /api/v1/bookings/:bookingId/reschedule` | · | · | — | — | ⏳ |
| `GET /api/v1/bookings/:bookingId/reschedule` | · | · | · | ✅ | · |
| `POST /api/v1/bookings/:bookingId/additional-work` | — | — | ✅ | ✅ | — |
| `GET /api/v1/bookings/:bookingId/additional-work` | · | · | ✅ | ⏳ | · |
| `POST /api/v1/bookings/:bookingId/disputes` | · | · | ✅ | ✅ | ⏳ |
| `GET /api/v1/bookings/:bookingId/disputes` | · | · | ✅ | ✅ | · |
| `POST /api/v1/admin/refunds/:refundId/mark-failed` | — | — | — | — | ⏳ |
| `GET /api/v1/admin/bookings` | — | — | — | — | ⏳ |
| `GET /api/v1/admin/bookings/:bookingId/assignment-candidates` | — | — | — | — | ⏳ |
| `POST /api/v1/admin/bookings/:bookingId/assign` | — | — | — | — | ⏳ |
| `POST /api/v1/admin/bookings/:bookingId/reassign` | — | — | — | — | ⏳ |
| `POST /api/v1/bookings/:bookingId/payment-intents` | ⏳ | ⏳ | — | — | · |
| `GET /api/v1/bookings/:bookingId/payment` | · | · | ✅ | · | · |
| `POST /api/v1/bookings/:bookingId/refunds` | · | · | — | — | ⏳ |
| `GET /api/v1/provider/earnings/summary` | — | — | ⏳ | ✅ | — |
| `GET /api/v1/provider/earnings/transactions` | — | — | ⏳ | ✅ | — |
| `GET /api/v1/provider/earnings/payouts` | — | — | ⏳ | ✅ | — |
| `GET /api/v1/admin/finance/reconciliation` | — | — | — | — | ⏳ |
