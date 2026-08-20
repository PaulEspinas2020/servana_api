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
// `import type` — erased at compile time, so naming the capability set here
// cannot create a runtime cycle between the contract and the services it
// describes. One source for the names; a typo fails the build.
import type { Capabilities } from '../../services/providerAccountStateService';

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

/**
 * How a replay is stopped from doing damage. Closed on purpose: a free-form tag
 * would drift back into prose, and the point of this field is that a gate can
 * enumerate it.
 *
 * Derived by reading all 34 non-idempotent entries, not invented in advance.
 */
export type ReplayMechanism =
  /** The handler reads the caller's `Idempotency-Key` and replays the stored result. */
  | 'client-idempotency-key'
  /** A key is DERIVED for a downstream processor. The caller's own key is not read. */
  | 'processor-idempotency-key'
  /** A caller-supplied `clientRequestId` / `clientMsgId` deduplicates the write. */
  | 'client-request-id'
  /** A unique or partial-unique index collapses the repeat. */
  | 'unique-constraint'
  /** The write is an upsert on the primary key, so a repeat updates one row. */
  | 'upsert-primary-key'
  /** The UPDATE's own WHERE clause matches nothing on the second run. */
  | 'state-predicate'
  /** The booking state machine refuses the repeat: the entity has left that state. */
  | 'state-machine'
  /** A postgres advisory lock serialises concurrent attempts. */
  | 'advisory-lock'
  /** A row lock (`FOR UPDATE`) serialises concurrent attempts. */
  | 'row-lock'
  /** The credential is consumed on first use (oobCode, compare-and-swap OTP). */
  | 'single-use-token'
  /** An external identity provider owns the outcome and refuses or repeats it safely. */
  | 'external-authority'
  /** A cooldown, issue ceiling or attempt budget bounds the repeat. */
  | 'rate-limit'
  /** Arithmetic refuses it: the remaining ceiling computes to zero. */
  | 'arithmetic-ceiling'
  /** NONE, deliberately. A replay creates a second effect and that is accepted, with a reason. */
  | 'none-accepted';

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
   * The named permission this endpoint additionally demands.
   *
   * REQUIRED for every `auth: 'admin'` entry. `register.ts` throws at import
   * time when one is missing, so this cannot be a field somebody forgot.
   *
   * ## Why it is on the contract and not only in register.ts
   *
   * It used to live only in a `V1_PERMISSIONS` map inside `register.ts`, whose
   * docblock made a fair objection to putting it here: *a permission key
   * sitting unused in a data file reads as protection that is not mounted*.
   *
   * That objection is answered by making "unused" impossible rather than by
   * moving the data. `register.ts` now builds its permission middleware FROM
   * this field and refuses to start if an admin entry declares none — the same
   * discipline it already applies to handlers, where a key naming no
   * implemented entry is a throw and not a silent no-op.
   *
   * With that in place, the contract is the better home. `auth: 'admin'` proves
   * role 1 and nothing else, and the legacy admin routes gate on a named
   * permission as well. A v1 successor that dropped it would be a QUIETER route
   * to the same data — privilege escalation arriving as a migration. Declaring
   * it beside the route it guards is what lets a test compare the two surfaces
   * without reading Express middleware chains.
   */
  permission?: string;
  /**
   * A provider CAPABILITY the caller must also hold, beyond the role in `auth`.
   *
   * The provider-side twin of `permission` above, and it exists for the reason
   * that field's docblock already names: a v1 successor that drops a check the
   * legacy route enforces is *privilege escalation arriving as a migration*.
   *
   * ## The measured case
   *
   * The legacy earnings routes carry
   * `requireCapability("canViewEarnings")` on top of `requireProviderRole`,
   * because a provider whose application is not APPROVED holds the role but must
   * not read earnings. The contract had no way to say that, so the three v1
   * earnings successors were mounted with the role check alone. Both trees are
   * live and the legacy mappings are `ALIAS_TEMPORARILY`, so `/api/v1/provider/
   * earnings/summary` was a strictly weaker route to the same data than
   * `/api/provider/earnings/summary`.
   *
   * ## Why no gate caught it
   *
   * `scripts/legacy-authz-inventory.ts` derives the legacy rule from middleware
   * NAMES, and its ladder knows only `verifyRoles`, `requireProviderRole` and
   * `verifyAuth`. A chain carrying `requireCapability` resolved to plain
   * `provider`, which equals the v1 entry's `provider`, so the strictness
   * comparison short-circuited and reported parity. The gate had no word for the
   * thing that was removed. `capabilityLoosenings()` now compares this field
   * against the mounted chain and fails when a supersession drops one.
   *
   * Orthogonal to `auth` rather than another rung on it: a request can be
   * required to be a provider AND to hold a capability, and folding them
   * together would lose which capability was demanded.
   */
  capability?: keyof Capabilities;
  /**
   * The caller must additionally survive `middleware/requireActiveProvider`.
   *
   * ## Why this is not a capability
   *
   * The first version of this fix declared `capability: 'canAcceptJobs'` on the
   * job actions, reasoning that it was the capability the legacy chain enforced.
   * It is not, and the difference denies real providers.
   *
   *   `requireActiveProvider` reads ONE column, `user_credentials.account_status`,
   *   and is deliberately permissive: a null, undefined or blank status calls
   *   `next()`, because "it means nothing was ever written, and yesterday that
   *   account worked". Only an explicitly blocked status refuses.
   *
   *   `canAcceptJobs` is `fullyActive && complianceCurrent`, where `fullyActive`
   *   is `activation === 'ACTIVE' && operational === 'ACTIVE'`. A provider whose
   *   status column is blank, or who is mid-activation, or who has zero active
   *   services — `operational === 'NO_ACTIVE_SERVICE'` — fails that and passes
   *   the middleware.
   *
   * So the capability is STRICTER than the route it was meant to restore, and
   * this TAB puts widening the model out of scope: the fix declares parity with
   * the legacy chain, not a new policy. Silently adding an enforcement point is
   * the same class of error as silently removing one, and this one would refuse
   * providers their work.
   *
   * The fix is to call the production predicate rather than reassemble it.
   * `register.ts` appends the real `requireActiveProvider`, so there is one
   * definition of "may this provider work" and it cannot drift from itself.
   */
  activeProvider?: true;
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

  /**
   * The SAME guarantee as `replayGuard`, in a closed vocabulary a gate can read.
   *
   * ## Why prose was not enough
   *
   * `replayGuard` is the honest explanation and must stay — a reviewer needs the
   * reasoning, not a tag. But no static check can read it. An attempt to build
   * that gate from the prose flagged **10 of 11 entries wrongly**, and the reason
   * is visible in the strings themselves: `auth.login` and
   * `bookings.payments.intent` both contain the words "Idempotency-Key", and
   * NEITHER honours a client-supplied one. The first says it would be theatre on
   * a read-shaped operation; the second derives a key for the PROCESSOR from the
   * payment row. Keyword-matching cannot tell those from the nine that really do
   * replay a caller's key, and a gate with that false-positive rate gets deleted.
   *
   * Two fields, one truth: the prose says why, the vocabulary says what, and
   * `tests/v1-replay-mechanism.test.ts` fails when they disagree about the one
   * thing that is machine-checkable — whether the handler reads the header.
   */
  replayMechanism?: readonly ReplayMechanism[];
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
    id: 'telemetry.ingest',
    domain: 'telemetry',
    method: 'post',
    path: '/telemetry',
    summary: 'Accept a small, closed set of scrubbed worker-app events. No free text, ever.',
    auth: 'authenticated',
    idempotent: false,
    replayGuard:
      'NONE, and accepted deliberately. A replayed batch double-counts an event in a chart, '
      + 'which is the cheapest failure in this contract. The alternative — an idempotency key '
      + 'per batch, stored and compared — would cost a write and a lookup on every telemetry '
      + 'call to protect a number nobody bills from. The events carry no money, no state '
      + 'transition and no side effect beyond a row.',
    replayMechanism: ['none-accepted'],
    responseSchema: 'TelemetryIngestResult',
    requestSchema: 'TelemetryIngestRequest',
    errors: ['VALIDATION_FAILED'],
    status: 'implemented',
    domainService: 'services/telemetryService.recordTelemetryEvents',
    legacy: [],
    callers: { ...ALL_PLANNED, customerMobile: 'n/a', customerWeb: 'n/a', admin: 'n/a' },
    observability: 'platform',
    notes:
      'FIRST-PARTY by decision, not by default — see docs/TELEMETRY_DECISION.md. The worker '
      + 'app scrubs to an allowlist carrying no name, phone, location or token, but it still '
      + 'carries bookingRef, and RA 10173 s3(g) makes information personal when identity can be '
      + '"reasonably and directly ascertained by the entity holding the information". Servana '
      + 'holds the bookings table. So the scrubbed payload is still personal data in our hands, '
      + 'and a foreign sink would be a cross-border transfer engaging s21 accountability, NPC '
      + 'model contractual clauses, and registration above 1,000 data subjects. The server '
      + 're-scrubs from its own allowlist rather than trusting the client: a server that trusts '
      + 'a client\'s scrubbing has one control, not two.',
  },
  {
    id: 'clientConfig.read',
    domain: 'health',
    method: 'get',
    path: '/client-config',
    summary: 'The minimum client version that may run, per platform. The only recall a released mobile build has.',
    auth: 'public',
    idempotent: true,
    responseSchema: 'ClientConfig',
    errors: [],
    status: 'implemented',
    domainService: 'api/v1/domains/clientConfig.readClientConfig',
    legacy: [],
    callers: { ...ALL_PLANNED, customerWeb: 'n/a', providerWeb: 'n/a', admin: 'n/a' },
    observability: 'platform',
    notes:
      'Public because the client being recalled may be too old to authenticate, and a kill '
      + 'switch reachable only with a credential cannot kill the builds that most need it. '
      + 'Served from a JSON file, not the database: a recall is pulled during an incident, '
      + 'and the incident this platform actually had was every database-backed read '
      + 'returning 500 for six days. Editing the file takes effect within ~2 minutes with '
      + 'no restart and no deploy. The server fails OPEN — a missing or malformed file '
      + 'serves a permissive 0.0.0 floor — because the client fails CLOSED, and two closed '
      + 'halves would let one deleted file brick every installed app at once.',
  },
  {
    id: 'health.build',
    domain: 'health',
    method: 'get',
    path: '/health',
    summary: 'The commit this build was made from. Public, and carries nothing else.',
    auth: 'public',
    idempotent: true,
    responseSchema: 'BuildInfo',
    errors: [],
    status: 'implemented',
    domainService: 'api/v1/domains/health.readBuildInfo',
    legacy: [],
    callers: { ...ALL_PLANNED, customerMobile: 'n/a', customerWeb: 'n/a', providerMobile: 'n/a', providerWeb: 'n/a', admin: 'n/a' },
    observability: 'platform',
    notes:
      'Reads dist/BUILD_INFO.json, which deploy.yml stamps on every deploy. It answers '
      + 'the one question a deploy cannot otherwise be asked from outside: which commit '
      + 'is actually serving. A deploy whose migration step fails stops short of the PM2 '
      + 'restart, so the old code keeps serving and nothing outward says so.',
  },
  {
    id: 'health.contract',
    domain: 'health',
    method: 'get',
    path: '/openapi.json',
    summary: 'The OpenAPI document this process implements, with its sha256 in a header.',
    auth: 'authenticated',
    idempotent: true,
    responseSchema: 'OpenApiDocument',
    errors: [],
    status: 'implemented',
    domainService: 'api/v1/domains/health.servedContract',
    legacy: [],
    callers: { ...ALL_PLANNED, admin: 'planned' },
    observability: 'platform',
    notes:
      'TAB 08. Before this the document was served at no path at all, so a client could only '
      + 'compare its pin against a git CHECKOUT — a statement about a repository, not about a '
      + 'server. The portal reported its pin going stale twice in one session and could not '
      + 'tell a shape change from an annotation-only one without diffing 530 kB by hand.'
      + ' '
      + 'AUTHENTICATED, not public, unlike health.build. Build provenance is four fields and '
      + 'exists to be checkable by someone who has no credential; a full API surface is a map, '
      + 'and every client that needs it already holds a token. `health.build` stays public '
      + 'because a provenance check that needs a credential can only be run by someone who '
      + 'already has one — that argument does not transfer to the whole contract.'
      + ' '
      + 'Every /api/v1 response also carries the same digest in x-contract-sha256, so a client '
      + 'detects staleness with one cheap request and no parsing, which is what the book asked '
      + 'for. This endpoint is for when the answer is yes and it wants the document.'
      + ' '
      + 'Answers in the usual v1 envelope. A bare document would be marginally more '
      + 'convenient for a generator pointed straight at the URL, and it would be the only '
      + 'endpoint of ninety-five that did not answer { data } — an exception to that shape '
      + 'is how the shape stops being relied upon.',
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
    id: 'catalog.services.serviceability',
    domain: 'catalog',
    method: 'get',
    path: '/catalog/services/:serviceId/serviceability',
    summary:
      'Whether a service can be booked at a given point, before the customer fills in a form.',
    auth: 'public',
    idempotent: true,
    responseSchema: 'CatalogServiceability',
    errors: ['VALIDATION_FAILED'],
    params: [
      { name: 'serviceId', type: 'integer', description: 'Canonical services.id' },
    ],
    query: [
      {
        name: 'lat',
        type: 'string',
        required: true,
        description: 'Latitude of the service address, as a decimal degree',
      },
      {
        name: 'lon',
        type: 'string',
        required: true,
        description: 'Longitude of the service address, as a decimal degree',
      },
    ],
    status: 'planned',
    domainService: 'services/catalogPublicService.getServiceability',
    legacy: [
      {
        method: 'get',
        path: '/api/catalog/services/:serviceId/serviceability',
        disposition: 'CANONICALIZE',
        note:
          'Mounted on the public catalog router alongside the read it belongs to. ' +
          'Should become the canonical v1 route; no v1 successor built yet.',
      },
    ],
    callers: { ...ALL_PLANNED, admin: 'n/a', providerMobile: 'n/a', providerWeb: 'n/a' },
    observability: 'catalog',
    notes:
      'The verdict createBooking would reach, offered before the journey rather ' +
      'than at the end of it: today a customer picks an address, a date and a ' +
      'payment method and only then learns "Service not available in your area." ' +
      'It resolves the service family with the statement createBooking uses, so the ' +
      'pre-check cannot promise a booking the server will refuse. It answers a ' +
      'verdict and never the coverage discs or the legacy id, which ' +
      'catalogPublicService withholds deliberately (§11, §58).',
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
    callers: { customerMobile: 'planned', customerWeb: 'planned', providerMobile: 'migrated', providerWeb: 'migrated', admin: 'planned' },
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
    callers: { customerMobile: 'n/a', customerWeb: 'n/a', providerMobile: 'migrated', providerWeb: 'migrated', admin: 'n/a' },
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
    callers: { customerMobile: 'n/a', customerWeb: 'n/a', providerMobile: 'migrated', providerWeb: 'migrated', admin: 'n/a' },
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
    domainService: 'services/events/notificationInbox.listNotifications',
    legacy: [
      { method: 'get', path: '/api/user/notifications', disposition: 'ALIAS_TEMPORARILY', note: 'Customer clients call this today.' },
    ],
    callers: { customerMobile: 'legacy', customerWeb: 'legacy', providerMobile: 'legacy', providerWeb: 'migrated', admin: 'planned' },
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
    domainService: 'services/events/notificationInbox.countUnread',
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
    callers: { customerMobile: 'legacy', customerWeb: 'legacy', providerMobile: 'legacy', providerWeb: 'migrated', admin: 'planned' },
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
    domainService: 'services/events/notificationInbox.markRead',
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
    callers: { customerMobile: 'legacy', customerWeb: 'legacy', providerMobile: 'legacy', providerWeb: 'migrated', admin: 'planned' },
    observability: 'notifications',
  },
  {
    id: 'notifications.dismiss',
    domain: 'notifications',
    method: 'delete',
    path: '/notifications/:key',
    summary: 'Dismisses one notification. Repeating it is a no-op, not an error.',
    auth: 'authenticated',
    // A second DELETE of the same key finds nothing and changes nothing. The
    // end state after one call and after five is identical, which is the test
    // `idempotent` names — not "the first one is safe".
    idempotent: true,
    responseSchema: 'NotificationMutation',
    errors: ['VALIDATION_FAILED', 'NOTIFICATION_NOT_FOUND', 'NOTIFICATION_NOT_ACTIONABLE'],
    params: [{ name: 'key', type: 'string', description: 'Opaque notification key' }],
    status: 'implemented',
    domainService: 'services/events/notificationInbox.dismiss',
    legacy: [
      {
        method: 'delete',
        path: '/api/provider/notifications/:key',
        disposition: 'CANONICALIZE',
        note:
          'The provider inbox had list, read, read-all and dismiss; v1 took the first three ' +
          'and left dismiss behind, so every provider client kept one legacy call for one ' +
          'verb. The legacy route is provider-only and reaches provider_notifications ' +
          'directly; this one resolves the store from the caller, so a CUSTOMER can dismiss ' +
          'for the first time.',
      },
    ],
    callers: { customerMobile: 'planned', customerWeb: 'planned', providerMobile: 'planned', providerWeb: 'migrated', admin: 'n/a' },
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
    domainService: 'services/events/notificationInbox.markAllRead',
    legacy: [
      { method: 'post', path: '/api/user/notifications/mark-all-read', disposition: 'ALIAS_TEMPORARILY', note: 'Same service; v1 uses the resource-shaped path.' },
    ],
    callers: { customerMobile: 'legacy', customerWeb: 'legacy', providerMobile: 'legacy', providerWeb: 'migrated', admin: 'planned' },
    observability: 'notifications',
  },

  {
    id: 'me.notificationPreferences.get',
    domain: 'notifications',
    method: 'get',
    path: '/me/notification-preferences',
    summary: "The caller's notification preferences, every declared category.",
    auth: 'authenticated',
    idempotent: true,
    responseSchema: 'NotificationPreferences',
    errors: [],
    status: 'implemented',
    domainService: 'services/events/notificationPreferences.getPreferences',
    legacy: [
      {
        method: 'get',
        path: '/api/provider/notification-preferences',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'Provider Web. Same uid-keyed table - nothing about it is provider-specific, and the ' +
          'role gate on this path is the reason customers had no way to configure ' +
          'notifications they were already receiving.',
      },
    ],
    callers: { customerMobile: 'planned', customerWeb: 'planned', providerMobile: 'legacy', providerWeb: 'migrated', admin: 'planned' },
    observability: 'notifications',
    notes:
      'Returns every category declared in `domainEvents.NOTIFICATION_CATEGORIES`, filled from ' +
      "the account's row or the category default. A client never has to decide what a missing " +
      'key means, which is the decision that produces two different answers in two clients.',
  },
  {
    id: 'me.notificationPreferences.patch',
    domain: 'notifications',
    method: 'patch',
    path: '/me/notification-preferences',
    summary: 'Changes named categories. Unnamed ones keep their value.',
    auth: 'authenticated',
    idempotent: true,
    requestSchema: 'NotificationPreferencePatch',
    responseSchema: 'NotificationPreferences',
    errors: ['VALIDATION_FAILED'],
    status: 'implemented',
    domainService: 'services/events/notificationPreferences.patchPreferences',
    legacy: [
      {
        method: 'put',
        path: '/api/provider/notification-preferences',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'Provider Web sends a full replace. Both shapes reach one writer, so a provider who ' +
          'has not migrated keeps the exact behaviour they have.',
      },
    ],
    callers: { customerMobile: 'planned', customerWeb: 'planned', providerMobile: 'legacy', providerWeb: 'migrated', admin: 'planned' },
    observability: 'notifications',
    notes:
      'PATCH rather than PUT, deliberately. A full replace means a client that knows about ' +
      'seven categories silently resets the two it has never heard of every time the backend ' +
      'adds one. `/settings/notification-preferences` keeps PUT for the shipped clients.',
  },
  {
    id: 'me.devices.register',
    domain: 'notifications',
    method: 'post',
    path: '/me/devices',
    summary: 'Registers this device for push, for the authenticated account.',
    auth: 'authenticated',
    idempotent: false,
    replayMechanism: ['upsert-primary-key'],
    replayGuard:
      'The device token is the primary key and the write is an upsert, so a repeat updates ' +
      'the same row rather than adding a second. Re-registering is the normal case - clients ' +
      'do it on every launch.',
    requestSchema: 'DeviceRegistration',
    responseSchema: 'DeviceRegistrationResult',
    errors: ['VALIDATION_FAILED'],
    status: 'implemented',
    domainService: 'services/events/deviceTokenService.registerDevice',
    legacy: [
      {
        method: 'post',
        path: '/api/provider/fcm-token',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'ServanaWorker and Provider Web. Multi-device already, and dual-written by the ' +
          'canonical service so a device registered either way stays reachable.',
      },
      {
        method: 'post',
        path: '/api/user/fcm-token',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'ServanaClient. Wrote a SINGLE column, so a customer with a phone and a tablet only ' +
          'ever received push on whichever signed in last - silently. The canonical route ' +
          'gives customers the multi-device behaviour providers already had.',
      },
    ],
    callers: { customerMobile: 'legacy', customerWeb: 'planned', providerMobile: 'migrated', providerWeb: 'migrated', admin: 'n/a' },
    observability: 'notifications',
    notes:
      'Account-scoped by construction: the row is upserted ON THE TOKEN, so registering a ' +
      'handset another account holds MOVES it rather than adding a second owner. A resold or ' +
      'shared device receiving two accounts of notifications is a cross-account leak with a ' +
      'lock screen attached.',
  },
  {
    id: 'me.devices.release',
    domain: 'notifications',
    method: 'delete',
    path: '/me/devices',
    summary: 'Releases this device, or every device for the account.',
    auth: 'authenticated',
    idempotent: true,
    requestSchema: 'DeviceRelease',
    responseSchema: 'DeviceReleaseResult',
    errors: [],
    status: 'implemented',
    domainService: 'services/events/deviceTokenService.releaseDevice',
    legacy: [
      {
        method: 'delete',
        path: '/api/provider/fcm-token',
        disposition: 'ALIAS_TEMPORARILY',
        note: 'Same operation, provider-gated. Both reach one service.',
      },
      {
        method: 'delete',
        path: '/api/user/fcm-token',
        disposition: 'ALIAS_TEMPORARILY',
        note: 'Same operation for customers, against the single legacy column.',
      },
    ],
    callers: { customerMobile: 'legacy', customerWeb: 'planned', providerMobile: 'migrated', providerWeb: 'migrated', admin: 'n/a' },
    observability: 'notifications',
    notes:
      'Omitting the token releases EVERY device, which is what a sign-out-everywhere wants. ' +
      'Passing one releases that handset only - signing out of a phone must not un-enroll the ' +
      'tablet still signed in.',
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Account domain — profile, settings, addresses, provider profile (TAB 10)
  //
  // `/me` is identity, contact and a verification summary, and carries a POINTER
  // to which role extension exists rather than its contents. A `/me` that
  // carried the provider compliance state and the customer address book would be
  // fetched by every screen, used by almost none, and cached everywhere.
  //
  // Sensitivity is declared once in `services/account/accountPolicy` and applied
  // by the services. The public provider projection requires a field's
  // classification AND its `customerVisible` flag to agree, so a private field
  // cannot reach a customer by being forgotten in a query.
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'me.patch',
    domain: 'account',
    method: 'patch',
    path: '/me',
    summary: "Changes the caller's own account record.",
    auth: 'authenticated',
    idempotent: true,
    requestSchema: 'AccountPatch',
    responseSchema: 'Account',
    errors: ['VALIDATION_FAILED', 'ACCOUNT_FIELD_NOT_WRITABLE', 'NOT_FOUND'],
    status: 'implemented',
    domainService: 'services/account/accountService.patchAccount',
    legacy: [
      {
        method: 'put',
        path: '/api/user/updateprofile',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'The live profile write for every client. Same writer - this entry delegates to ' +
          '`user.service.updateUserProfile` rather than touching the columns, so the two paths ' +
          'cannot grow different rules. It additionally REFUSES unwritable fields by name ' +
          'instead of stripping them silently.',
      },
    ],
    callers: { customerMobile: 'legacy', customerWeb: 'legacy', providerMobile: 'legacy', providerWeb: 'legacy', admin: 'planned' },
    observability: 'account',
    notes:
      'Verified identifiers - email and mobile - are NOT writable here. Changing one needs the ' +
      're-verification workflow, and a PATCH that accepted them would be a way to move a ' +
      'verified identifier without proving possession of the new one.',
  },
  {
    id: 'me.settings.get',
    domain: 'account',
    method: 'get',
    path: '/me/settings',
    summary: "The caller's settings: locale, privacy, security posture and a notification pointer.",
    auth: 'authenticated',
    idempotent: true,
    responseSchema: 'AccountSettings',
    errors: [],
    status: 'implemented',
    domainService: 'services/account/accountSettingsService.getSettings',
    legacy: [],
    callers: { customerMobile: 'planned', customerWeb: 'planned', providerMobile: 'migrated', providerWeb: 'planned', admin: 'planned' },
    observability: 'account',
    notes:
      'There was no server-side settings store before this. Locale and privacy choices were held ' +
      'per-client, so Customer Web and Customer Mobile each remembered a different language for ' +
      'the same person and neither could tell the backend. Notification preferences are a ' +
      'POINTER to the TAB 09 model, never a second copy of it.',
  },
  {
    id: 'me.settings.patch',
    domain: 'account',
    method: 'patch',
    path: '/me/settings',
    summary: 'Changes named settings. Unnamed ones keep their value.',
    auth: 'authenticated',
    idempotent: true,
    requestSchema: 'AccountSettingsPatch',
    responseSchema: 'AccountSettings',
    errors: ['VALIDATION_FAILED', 'ACCOUNT_FIELD_NOT_WRITABLE'],
    status: 'implemented',
    domainService: 'services/account/accountSettingsService.patchSettings',
    legacy: [],
    callers: { customerMobile: 'planned', customerWeb: 'planned', providerMobile: 'migrated', providerWeb: 'planned', admin: 'planned' },
    observability: 'account',
    notes:
      'PATCH rather than PUT: a full replace means a client that knows about four settings ' +
      'silently resets the one it has never heard of every time the backend adds another. ' +
      'An unknown key is REFUSED rather than ignored, so two clients cannot come to disagree ' +
      'about what a person chose.',
  },
  {
    id: 'me.security.get',
    domain: 'account',
    method: 'get',
    path: '/me/security',
    summary: "The caller's security posture, and where each security action lives.",
    auth: 'authenticated',
    idempotent: true,
    responseSchema: 'AccountSecurity',
    errors: [],
    status: 'implemented',
    domainService: 'services/account/accountSettingsService.getSecurity',
    legacy: [],
    callers: { customerMobile: 'planned', customerWeb: 'planned', providerMobile: 'planned', providerWeb: 'planned', admin: 'planned' },
    observability: 'account',
    notes:
      'READ-ONLY, deliberately. Every security ACTION already has a dedicated endpoint with its ' +
      'own proof of possession; folding them into a settings PATCH would put credential changes ' +
      'behind a JSON body - including turning two-factor OFF from a session that should not be ' +
      'able to. The response names where each action lives so a client need not hardcode it.',
  },
  {
    id: 'me.completion.get',
    domain: 'account',
    method: 'get',
    path: '/me/completion',
    summary: 'What is left before this account is usable. Backend-derived.',
    auth: 'authenticated',
    idempotent: true,
    responseSchema: 'ProfileCompletion',
    errors: [],
    status: 'implemented',
    domainService: 'services/account/profileCompletionService.getCompletion',
    legacy: [
      {
        method: 'get',
        path: '/api/provider/account-state',
        disposition: 'KEEP',
        note:
          'NOT a duplicate. Account state answers "what may this provider do RIGHT NOW" - ' +
          'suspended, pending, active - and is what gates the app. Completion answers "what is ' +
          'left to fill in". A suspended provider can be 100% complete, and a pending one can be ' +
          'active-eligible and missing a photo.',
      },
    ],
    callers: { customerMobile: 'planned', customerWeb: 'planned', providerMobile: 'migrated', providerWeb: 'planned', admin: 'n/a' },
    observability: 'account',
    notes:
      '`percent` counts every requirement including the cosmetic ones, because that is what a ' +
      'progress bar means to a person. `canProceed` counts only the BLOCKING ones, because that ' +
      'is what the product gates on. Conflating them is how a client shows "80% complete" next ' +
      'to a button that does not work.',
  },
  {
    id: 'customer.profile.get',
    domain: 'account',
    method: 'get',
    path: '/customer/profile',
    summary: "The caller's customer profile extension.",
    auth: 'authenticated',
    idempotent: true,
    responseSchema: 'CustomerProfile',
    errors: ['NOT_FOUND'],
    status: 'implemented',
    domainService: 'services/account/accountService.getCustomerProfile',
    legacy: [
      {
        method: 'get',
        path: '/api/user/profile',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'The live customer profile aggregate. It returns the credential row joined to the ' +
          'profile row; this entry returns the customer EXTENSION only, because the identity ' +
          'half is `/me` and duplicating it is how two endpoints come to disagree about a name.',
      },
    ],
    callers: { customerMobile: 'legacy', customerWeb: 'legacy', providerMobile: 'n/a', providerWeb: 'n/a', admin: 'planned' },
    observability: 'account',
  },
  {
    id: 'customer.profile.patch',
    domain: 'account',
    method: 'patch',
    path: '/customer/profile',
    summary: 'Changes the customer profile extension.',
    auth: 'authenticated',
    idempotent: true,
    requestSchema: 'CustomerProfilePatch',
    responseSchema: 'CustomerProfile',
    errors: ['VALIDATION_FAILED', 'ACCOUNT_FIELD_NOT_WRITABLE', 'NOT_FOUND'],
    status: 'implemented',
    domainService: 'services/account/accountService.patchCustomerProfile',
    legacy: [
      {
        method: 'put',
        path: '/api/user/updateprofile',
        disposition: 'ALIAS_TEMPORARILY',
        note: 'One legacy route wrote both halves. Same writer underneath; the split is in the DTO.',
      },
    ],
    callers: { customerMobile: 'legacy', customerWeb: 'legacy', providerMobile: 'n/a', providerWeb: 'n/a', admin: 'planned' },
    observability: 'account',
    notes:
      'The default address is NOT writable here. It is set through the address book, so the ' +
      'flag and the address that carries it cannot disagree.',
  },
  {
    id: 'customer.addresses.list',
    domain: 'account',
    method: 'get',
    path: '/customer/addresses',
    summary: "The caller's saved addresses, default first.",
    auth: 'authenticated',
    idempotent: true,
    responseSchema: 'AddressList',
    errors: [],
    status: 'implemented',
    domainService: 'services/account/addressBookService.listAddresses',
    legacy: [
      {
        method: 'get',
        path: '/api/user/alluseraddresses',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'The live list for Customer Web and Mobile. It branches on role inside the service and ' +
          'returns EVERY customer address to an admin; the canonical route is owner-scoped in ' +
          'SQL with no role branch, and admin address access belongs on an admin route.',
      },
      {
        method: 'get',
        path: '/api/user/:userId/addresses',
        disposition: 'ROLE_SPECIFIC',
        note:
          'The provider portal reading a booking customer\'s address. A genuinely different ' +
          'authorization question - it is answered from the booking relationship, not from ' +
          'ownership - and it stays on its own route rather than becoming a uid parameter here.',
      },
    ],
    callers: { customerMobile: 'legacy', customerWeb: 'legacy', providerMobile: 'n/a', providerWeb: 'n/a', admin: 'n/a' },
    observability: 'account',
    notes:
      '`meta.defaultAddressId` is surfaced so checkout needs one call rather than scanning the ' +
      'list for the first `isDefault` it finds.',
  },
  {
    id: 'customer.addresses.create',
    domain: 'account',
    method: 'post',
    path: '/customer/addresses',
    summary: 'Saves a new address. The first one becomes the default.',
    auth: 'authenticated',
    idempotent: false,
    replayMechanism: ['none-accepted'],
    replayGuard:
      'None beyond validation, and that is stated rather than claimed: a repeated POST creates a ' +
      'second address. Two identical addresses is a cosmetic problem a customer can fix, and an ' +
      'idempotency key on an address book is a key clients would have to invent per keystroke. ' +
      'The address CEILING bounds the damage.',
    requestSchema: 'AddressInput',
    responseSchema: 'Address',
    errors: ['VALIDATION_FAILED', 'ADDRESS_LIMIT_REACHED'],
    status: 'implemented',
    domainService: 'services/account/addressBookService.createAddress',
    legacy: [
      {
        method: 'post',
        path: '/api/user/adduseraddress',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'A create verb that doubles as an update when the body happens to carry an addressId. ' +
          'The canonical pair splits them, and both reach the same writer so the MongoDB geocode ' +
          'sync has one caller.',
      },
    ],
    callers: { customerMobile: 'legacy', customerWeb: 'legacy', providerMobile: 'n/a', providerWeb: 'n/a', admin: 'n/a' },
    observability: 'account',
  },
  {
    id: 'customer.addresses.update',
    domain: 'account',
    method: 'patch',
    path: '/customer/addresses/:addressId',
    summary: 'Changes a saved address.',
    auth: 'authenticated',
    idempotent: true,
    requestSchema: 'AddressInput',
    responseSchema: 'Address',
    errors: ['VALIDATION_FAILED', 'ADDRESS_NOT_FOUND'],
    params: [{ name: 'addressId', type: 'string', description: 'user_address.address_id' }],
    status: 'implemented',
    domainService: 'services/account/addressBookService.updateAddress',
    legacy: [
      {
        method: 'post',
        path: '/api/user/adduseraddress',
        disposition: 'ALIAS_TEMPORARILY',
        note: 'The same legacy route, taking the update branch when the body carries an addressId.',
      },
    ],
    callers: { customerMobile: 'legacy', customerWeb: 'legacy', providerMobile: 'n/a', providerWeb: 'n/a', admin: 'n/a' },
    observability: 'account',
    notes:
      'An absent field means "leave it alone", never "clear it". Treating absence as a clear ' +
      'would let a client that sends one field wipe the rest of somebody\'s address.',
  },
  {
    id: 'customer.addresses.delete',
    domain: 'account',
    method: 'delete',
    path: '/customer/addresses/:addressId',
    summary: 'Removes a saved address, promoting a successor if it was the default.',
    auth: 'authenticated',
    idempotent: true,
    responseSchema: 'AddressDeleteResult',
    errors: ['VALIDATION_FAILED', 'ADDRESS_NOT_FOUND'],
    params: [{ name: 'addressId', type: 'string', description: 'user_address.address_id' }],
    status: 'implemented',
    domainService: 'services/account/addressBookService.deleteAddress',
    legacy: [
      {
        method: 'delete',
        path: '/api/user/deleteaddress',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'Takes the id in a query string and leaves the account with NO default when the ' +
          'primary is removed - a checkout screen with nothing selected and no way to tell why.',
      },
    ],
    callers: { customerMobile: 'legacy', customerWeb: 'legacy', providerMobile: 'n/a', providerWeb: 'n/a', admin: 'n/a' },
    observability: 'account',
  },
  {
    id: 'customer.addresses.setDefault',
    domain: 'account',
    method: 'post',
    path: '/customer/addresses/:addressId/default',
    summary: 'Promotes one address to default. Atomic.',
    auth: 'authenticated',
    idempotent: true,
    responseSchema: 'Address',
    errors: ['VALIDATION_FAILED', 'ADDRESS_NOT_FOUND'],
    params: [{ name: 'addressId', type: 'string', description: 'user_address.address_id' }],
    status: 'implemented',
    domainService: 'services/account/addressBookService.setDefaultAddress',
    legacy: [
      {
        method: 'put',
        path: '/api/user/makeaddressprimary',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'TWO statements with no transaction - set the new default, then clear the others. A ' +
          'failure between them leaves the account with two primaries, and every reader picks ' +
          'whichever the planner returned first, including checkout.',
      },
    ],
    callers: { customerMobile: 'legacy', customerWeb: 'legacy', providerMobile: 'n/a', providerWeb: 'n/a', admin: 'n/a' },
    observability: 'account',
    notes:
      'Demote-then-promote inside ONE transaction. That order never transiently satisfies ' +
      '"exactly one" by having zero rather than two, which a reader mid-transaction could ' +
      'otherwise observe.',
  },
  {
    id: 'provider.profile.get',
    domain: 'account',
    method: 'get',
    path: '/provider/profile',
    summary: "The caller's own provider profile, field-scoped by seat.",
    auth: 'provider',
    idempotent: true,
    responseSchema: 'ProviderProfile',
    errors: ['NOT_FOUND'],
    status: 'implemented',
    domainService: 'services/account/providerProfileService.getProviderProfile',
    legacy: [
      {
        method: 'get',
        path: '/api/provider/profile',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'The live provider profile, built inline in a controller with a hand-written column ' +
          'list. Safe only for as long as nobody adds a column; the canonical route emits the ' +
          'fields the policy says this seat may read.',
      },
      {
        method: 'get',
        path: '/api/provider/profile-center',
        disposition: 'ROLE_SPECIFIC',
        note:
          'The compliance view: revision history, review state, field-level edit affordances. A ' +
          'genuinely different question, and it already reads the same field registry this ' +
          'entry projects from.',
      },
    ],
    callers: { customerMobile: 'n/a', customerWeb: 'n/a', providerMobile: 'legacy', providerWeb: 'migrated', admin: 'planned' },
    observability: 'account',
    notes:
      '`visibleFields` is on the wire, so a client can tell a public view from its own rather ' +
      'than inferring it from which keys happen to be missing.',
  },
  {
    id: 'provider.profile.patch',
    domain: 'account',
    method: 'patch',
    path: '/provider/profile',
    summary: 'Proposes a change to a reviewable public profile field.',
    auth: 'provider',
    idempotent: false,
    replayMechanism: ['client-request-id'],
    replayGuard:
      'A REQUIRED clientRequestId, which the compliance service dedupes revisions on. Without ' +
      'it a provider on a flaky connection would queue three copies of one biography change for ' +
      'a human to review.',
    requestSchema: 'ProviderProfilePatch',
    responseSchema: 'ProviderProfileRevision',
    errors: ['VALIDATION_FAILED', 'ACCOUNT_FIELD_NOT_WRITABLE'],
    status: 'implemented',
    domainService: 'services/account/providerProfileService.patchProviderProfile',
    legacy: [
      {
        method: 'post',
        path: '/api/provider/public-profile-revisions',
        disposition: 'ALIAS_TEMPORARILY',
        note: 'The live revision submit. IDENTICAL domain call - this is a second URL onto one workflow.',
      },
    ],
    callers: { customerMobile: 'n/a', customerWeb: 'n/a', providerMobile: 'legacy', providerWeb: 'migrated', admin: 'n/a' },
    observability: 'account',
    notes:
      'Not a write. A provider does not edit their public profile; they propose a change and it ' +
      'is reviewed. Identifier fields and operational fields are refused by name, with the ' +
      'message naming where each is actually changed.',
  },
  {
    id: 'provider.publicProfile.get',
    domain: 'account',
    method: 'get',
    path: '/providers/:providerUid/profile',
    summary: "A provider's PUBLIC profile, as a customer sees it.",
    auth: 'authenticated',
    idempotent: true,
    responseSchema: 'ProviderProfile',
    errors: ['VALIDATION_FAILED', 'NOT_FOUND'],
    params: [{ name: 'providerUid', type: 'string', description: 'Canonical provider uid' }],
    status: 'implemented',
    domainService: 'services/account/providerProfileService.getProviderProfile',
    legacy: [],
    callers: { customerMobile: 'planned', customerWeb: 'planned', providerMobile: 'n/a', providerWeb: 'n/a', admin: 'planned' },
    observability: 'account',
    notes:
      'The ONE endpoint in this domain that names another account, and the only one that needs ' +
      'to. What a stranger receives is decided by `providerFieldsVisibleTo`, which requires the ' +
      'classification AND the registry\'s own customerVisible flag to agree - either can veto, ' +
      'so a private field cannot arrive by being forgotten. Document state and account status ' +
      'are withheld entirely at this seat.',
  },
  {
    id: 'provider.documents.list',
    domain: 'account',
    method: 'get',
    path: '/provider/documents',
    summary: 'Document and requirement REVIEW STATE. Never content.',
    auth: 'provider',
    idempotent: true,
    responseSchema: 'ProviderDocumentList',
    errors: [],
    status: 'implemented',
    domainService: 'services/account/providerProfileService.listDocuments',
    legacy: [
      {
        method: 'get',
        path: '/api/provider/documents',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'The live document list. Same `worker_requirements` model - the command is explicit ' +
          'that provider_documents must not be invented, and it does not exist.',
      },
    ],
    callers: { customerMobile: 'n/a', customerWeb: 'n/a', providerMobile: 'legacy', providerWeb: 'migrated', admin: 'n/a' },
    observability: 'account',
    notes:
      'Driven by the document CATALOG rather than by the stored rows, so a required document ' +
      'that has never been submitted appears as `missing`. A list built from rows alone shows an ' +
      'empty screen to a provider who has everything left to do. No URL and no storage path ' +
      'appears; the preview endpoint mints a short-lived signed URL after re-authorizing.',
  },
  {
    id: 'provider.documents.types',
    domain: 'account',
    method: 'get',
    path: '/provider/document-types',
    summary: 'The document catalog: what may be submitted, and which are required.',
    auth: 'provider',
    idempotent: true,
    responseSchema: 'ProviderDocumentTypeCatalog',
    errors: [],
    status: 'implemented',
    domainService: 'services/providerProfileComplianceService.DOCUMENT_TYPE_CATALOG',
    legacy: [
      {
        method: 'get',
        path: '/api/provider/document-types',
        disposition: 'ALIAS_TEMPORARILY',
        note: 'The same static catalog constant. No per-caller data of any kind.',
      },
    ],
    callers: { customerMobile: 'n/a', customerWeb: 'n/a', providerMobile: 'migrated', providerWeb: 'legacy', admin: 'n/a' },
    observability: 'account',
    notes:
      'Provider-scoped rather than public even though the payload is static policy: the ' +
      'requirement set is part of how onboarding works, and a public catalog invites building ' +
      'the checklist screen against an endpoint nobody has to be signed in to read.',
  },
  {
    id: 'provider.documents.create',
    domain: 'account',
    method: 'post',
    path: '/provider/documents',
    summary: 'Submits one document for review.',
    auth: 'provider',
    idempotent: false,
    replayMechanism: ['client-request-id'],
    replayGuard:
      'A REQUIRED clientRequestId, unique per provider. A retried submit returns the ORIGINAL ' +
      'row rather than queueing a second copy of the same passport for review.',
    requestSchema: 'ProviderDocumentUpload',
    responseSchema: 'ProviderDocument',
    errors: ['VALIDATION_FAILED', 'NOT_FOUND', 'CONFLICT'],
    status: 'implemented',
    domainService: 'services/providerProfileComplianceService.uploadDocument',
    legacy: [
      {
        method: 'post',
        path: '/api/provider/documents',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'The live submit for both provider clients. IDENTICAL domain call, and it carries the ' +
          'same post-commit `autoOnlineEngine.evaluateProvider` — submitting the last ' +
          'outstanding requirement is what makes a provider eligible to go online, so an ' +
          'endpoint that stored the file without re-evaluating would leave them blocked.',
      },
    ],
    callers: { customerMobile: 'n/a', customerWeb: 'n/a', providerMobile: 'migrated', providerWeb: 'migrated', admin: 'n/a' },
    observability: 'account',
    notes:
      'The file is a data URI validated by SIGNATURE against an allowlist and a size ceiling, ' +
      'so a renamed executable is refused on its contents. The response is review STATE; no ' +
      'storage path is ever projected.',
  },
  {
    id: 'provider.documents.preview',
    domain: 'account',
    method: 'get',
    path: '/provider/documents/:documentId/preview',
    summary: 'A short-lived signed URL for one document the caller owns.',
    auth: 'provider',
    idempotent: true,
    responseSchema: 'ProviderDocumentPreview',
    errors: ['NOT_FOUND'],
    params: [{ name: 'documentId', type: 'integer', description: 'worker_requirements.id' }],
    status: 'implemented',
    domainService: 'services/providerProfileComplianceService.getDocumentPreview',
    legacy: [
      {
        method: 'get',
        path: '/api/provider/documents/:documentId/preview',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'Same authorization and the same short-lived grant. The `Cache-Control: private, ' +
          'no-store` and `Pragma: no-cache` headers are set by the handler rather than the ' +
          'route, so they travel with the only v1 response that contains a private storage URL.',
      },
    ],
    callers: { customerMobile: 'n/a', customerWeb: 'n/a', providerMobile: 'migrated', providerWeb: 'migrated', admin: 'n/a' },
    observability: 'account',
    notes:
      'A malformed id and an id belonging to another provider answer the SAME 404. A 422 for ' +
      'the first would let a caller enumerate which document ids exist.',
  },
  {
    id: 'provider.documents.delete',
    domain: 'account',
    method: 'delete',
    path: '/provider/documents/:documentId',
    summary: 'Withdraws one document.',
    auth: 'provider',
    idempotent: true,
    responseSchema: 'ProviderDocumentMutation',
    errors: ['NOT_FOUND', 'CONFLICT'],
    params: [{ name: 'documentId', type: 'integer', description: 'worker_requirements.id' }],
    status: 'implemented',
    domainService: 'services/providerProfileComplianceService.deleteDocument',
    legacy: [
      {
        method: 'delete',
        path: '/api/provider/documents/:documentId',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'IDENTICAL domain call, and it re-evaluates online eligibility for the same reason ' +
          'the upload does: withdrawing a requirement can make a provider ineligible, and ' +
          'skipping it would leave someone online against a document they just removed.',
      },
    ],
    callers: { customerMobile: 'n/a', customerWeb: 'n/a', providerMobile: 'migrated', providerWeb: 'migrated', admin: 'n/a' },
    observability: 'account',
  },
  {
    id: 'provider.availability.get',
    domain: 'account',
    method: 'get',
    path: '/provider/availability',
    summary: "The caller's weekly availability - the same source matching consumes.",
    auth: 'provider',
    idempotent: true,
    responseSchema: 'ProviderAvailability',
    errors: [],
    status: 'implemented',
    domainService: 'services/providerAvailabilityEngine.getAvailabilityProfile',
    legacy: [
      {
        method: 'get',
        path: '/api/worker/availability',
        disposition: 'ALIAS_TEMPORARILY',
        note: 'The live provider availability read. Same engine; the legacy shape bridges it to a web schedule.',
      },
    ],
    callers: { customerMobile: 'n/a', customerWeb: 'n/a', providerMobile: 'legacy', providerWeb: 'legacy', admin: 'n/a' },
    observability: 'account',
    notes:
      'The release gate: a provider editing one source while matching reads another is a ' +
      'provider who is unbookable for reasons nobody can see. Both read ' +
      '`providerAvailabilityEngine`.',
  },
  {
    id: 'provider.availability.patch',
    domain: 'account',
    method: 'patch',
    path: '/provider/availability',
    summary: 'Replaces the weekly availability. Optimistic concurrency on version.',
    auth: 'provider',
    idempotent: true,
    requestSchema: 'ProviderAvailabilityPatch',
    responseSchema: 'ProviderAvailability',
    errors: ['VALIDATION_FAILED', 'STALE_STATE'],
    status: 'implemented',
    domainService: 'services/providerAvailabilityEngine.saveWeeklySchedule',
    legacy: [
      {
        method: 'put',
        path: '/api/worker/availability',
        disposition: 'ALIAS_TEMPORARILY',
        note: 'The live write. IDENTICAL engine call, including its expectedVersion check.',
      },
    ],
    callers: { customerMobile: 'n/a', customerWeb: 'n/a', providerMobile: 'legacy', providerWeb: 'legacy', admin: 'n/a' },
    observability: 'account',
    notes:
      'Idempotent because it REPLACES the week rather than appending to it: the same body twice ' +
      'reaches the same schedule. `expectedVersion` is what stops two devices silently ' +
      'overwriting each other.',
  },
  {
    id: 'provider.timeOff.list',
    domain: 'account',
    method: 'get',
    path: '/provider/time-off',
    summary: 'The ACTIVE time-off periods belonging to the caller.',
    auth: 'provider',
    idempotent: true,
    responseSchema: 'ProviderTimeOffList',
    errors: [],
    status: 'implemented',
    domainService: 'services/providerAvailabilityEngine.listTimeOff',
    legacy: [
      {
        method: 'get',
        path: '/api/worker/time-off',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'Same engine, same active-only filter. A cancelled period is history rather than a ' +
          'commitment and appears in neither.',
      },
    ],
    callers: { customerMobile: 'n/a', customerWeb: 'n/a', providerMobile: 'migrated', providerWeb: 'legacy', admin: 'n/a' },
    observability: 'account',
  },
  {
    id: 'provider.timeOff.create',
    domain: 'account',
    method: 'post',
    path: '/provider/time-off',
    summary: 'Books time off, and reports the confirmed bookings it collides with.',
    auth: 'provider',
    idempotent: false,
    replayMechanism: ['none-accepted'],
    replayGuard:
      'None, and the honest reason is that the engine offers none. A repeat creates a second ' +
      'overlapping period, which is visible and cancellable - and harmless next to the ' +
      'alternative, which is refusing a provider who is ill because their first attempt ' +
      'timed out.',
    requestSchema: 'ProviderTimeOffRequest',
    responseSchema: 'ProviderTimeOff',
    errors: ['VALIDATION_FAILED'],
    status: 'implemented',
    domainService: 'services/providerAvailabilityEngine.createTimeOff',
    legacy: [
      {
        method: 'post',
        path: '/api/worker/time-off',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'IDENTICAL engine call, and it carries the same bookingConflicts and conflictNotice. ' +
          'Time off is created even when it overlaps confirmed work - a provider who is ill ' +
          'must be able to record it - but the work is still theirs, and a response that did ' +
          'not say so would leave them assuming leave cancels their jobs.',
      },
    ],
    callers: { customerMobile: 'n/a', customerWeb: 'n/a', providerMobile: 'migrated', providerWeb: 'legacy', admin: 'n/a' },
    observability: 'account',
    notes:
      'The response reports what was STORED, never the request. A response assembled from the ' +
      'body agrees with the client by construction, which is how the partial-day defect ' +
      'survived: the portal sent startTime/endTime, nothing persisted them, and the reply ' +
      'said allDay.',
  },
  {
    id: 'provider.timeOff.cancel',
    domain: 'account',
    method: 'delete',
    path: '/provider/time-off/:timeOffId',
    summary: 'Cancels one time-off period.',
    auth: 'provider',
    idempotent: true,
    responseSchema: 'ProviderTimeOffMutation',
    errors: ['NOT_FOUND'],
    params: [{ name: 'timeOffId', type: 'integer', description: 'provider_time_off.id' }],
    status: 'implemented',
    domainService: 'services/providerAvailabilityEngine.cancelTimeOff',
    legacy: [
      {
        method: 'delete',
        path: '/api/worker/time-off/:id',
        disposition: 'ALIAS_TEMPORARILY',
        note: 'IDENTICAL engine call. Cancels rather than deletes; the row survives as history.',
      },
    ],
    callers: { customerMobile: 'n/a', customerWeb: 'n/a', providerMobile: 'migrated', providerWeb: 'legacy', admin: 'n/a' },
    observability: 'account',
    notes:
      'A malformed id answers 404, the same as one belonging to another provider - a 422 for ' +
      'the first would let a caller enumerate which periods exist.',
  },
  {
    id: 'provider.services.list',
    domain: 'account',
    method: 'get',
    path: '/provider/services',
    summary: 'The services the caller is approved for, keyed on services.id.',
    auth: 'provider',
    idempotent: true,
    responseSchema: 'ProviderServiceList',
    errors: [],
    status: 'implemented',
    domainService: 'services/account/providerProfileService.listServices',
    legacy: [
      {
        method: 'get',
        path: '/api/worker/services-overview',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'The live provider services screen. Same `employee_services` qualification; the ' +
          'canonical entry projects it keyed on services.id with the active flag matching ' +
          'actually selects on.',
      },
      {
        method: 'get',
        path: '/api/worker/service-applications',
        disposition: 'KEEP',
        note:
          'NOT a duplicate. An application is the REQUEST to be approved for a service and ' +
          'carries its own lifecycle; this entry is the resulting qualification. A provider can ' +
          'have a pending application and no qualification, which is exactly the state the two ' +
          'endpoints exist to tell apart.',
      },
    ],
    callers: { customerMobile: 'n/a', customerWeb: 'n/a', providerMobile: 'migrated', providerWeb: 'planned', admin: 'n/a' },
    observability: 'account',
    notes:
      'Keyed on `services.id` - the Catalog V2 canonical specific-service identity - never on a ' +
      'service family. `service_families` is legacy coarse provenance, and a provider service ' +
      'list keyed on a family is how the family becomes the bookable identity again.',
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
  // Post-service trust — reviews and quality support (TAB 12)
  //
  // A review is GROUNDED in a booking. The author comes from `bookings.user_id`
  // and the provider from the COMPLETED assignment, so there is no shape of
  // request that reviews somebody the customer did not book. That is not a
  // validation rule: there is no provider field to validate.
  //
  // `reviews.provider.list` and `reviews.provider.rating` above are the routes
  // the command names as /providers/:providerId/reviews and /rating-summary.
  // They already existed and are reused rather than duplicated.
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'bookings.review.create',
    domain: 'reviews',
    method: 'post',
    path: '/bookings/:bookingId/review',
    summary: 'Reviews a completed booking. The provider comes from the assignment.',
    auth: 'authenticated',
    idempotent: false,
    replayMechanism: ['advisory-lock', 'client-request-id', 'state-predicate'],
    replayGuard:
      'An advisory transaction lock on (customer, booking), a clientRequestId replay inside ' +
      'that transaction, and an existing-review check in the same transaction. Two devices ' +
      'submitting at once produce ONE review, and a retry returns the original.',
    requestSchema: 'ReviewInput',
    responseSchema: 'Review',
    errors: [
      'VALIDATION_FAILED', 'REVIEW_FORBIDDEN', 'REVIEW_NOT_ELIGIBLE', 'REVIEW_ALREADY_EXISTS',
    ],
    params: [{ name: 'bookingId', type: 'integer', description: 'bookings.id' }],
    status: 'implemented',
    domainService: 'services/customerReviewService.createReview',
    legacy: [
      {
        method: 'post',
        path: '/api/bookings/:bookingId/reviews',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'The live customer review write. IDENTICAL domain call - this is a second URL onto ' +
          'one write, and the legacy route keeps its role guard and its response shape.',
      },
    ],
    callers: { customerMobile: 'legacy', customerWeb: 'legacy', providerMobile: 'n/a', providerWeb: 'n/a', admin: 'n/a' },
    observability: 'reviews',
    notes:
      'Nothing in the body names a provider, an author or a rating subject. The provider is ' +
      'resolved from the booking\'s COMPLETED assignment, so a payload that named one would ' +
      'have nothing to attach it to.',
  },
  {
    id: 'bookings.review.get',
    domain: 'reviews',
    method: 'get',
    path: '/bookings/:bookingId/review',
    summary: "The caller's own review for a booking, or the eligibility verdict when there is none.",
    auth: 'authenticated',
    idempotent: true,
    responseSchema: 'ReviewOrEligibility',
    errors: ['VALIDATION_FAILED', 'REVIEW_FORBIDDEN'],
    params: [{ name: 'bookingId', type: 'integer', description: 'bookings.id' }],
    status: 'implemented',
    domainService: 'services/customerReviewService.getReviewByBooking',
    legacy: [
      {
        method: 'get',
        path: '/api/bookings/:bookingId/reviews',
        disposition: 'ALIAS_TEMPORARILY',
        note: 'The live read. Same service; the canonical entry folds in the eligibility verdict.',
      },
      {
        method: 'get',
        path: '/api/bookings/:bookingId/review-eligibility',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'A SECOND call the client makes to decide whether to show the form. Folded into the ' +
          'read above, because asking twice means a screen that offers a form the next call ' +
          'refuses.',
      },
    ],
    callers: { customerMobile: 'legacy', customerWeb: 'legacy', providerMobile: 'n/a', providerWeb: 'n/a', admin: 'n/a' },
    observability: 'reviews',
    notes:
      'Carries the private feedback, which the provider and public projections never do - that ' +
      'is why it is a separate read rather than a filter over the provider list.',
  },
  {
    id: 'bookings.supportCases.create',
    domain: 'reviews',
    method: 'post',
    path: '/bookings/:bookingId/support-cases',
    summary: 'Raises a support case about a concluded booking.',
    auth: 'authenticated',
    idempotent: false,
    replayMechanism: ['advisory-lock', 'client-request-id', 'unique-constraint'],
    replayGuard:
      'An advisory transaction lock on (customer, booking) plus a partial unique index on ' +
      '(customer_uid, client_request_id). A retry on a flaky connection returns the original ' +
      'case rather than opening a third for one complaint.',
    requestSchema: 'SupportCaseInput',
    responseSchema: 'SupportCase',
    errors: [
      'VALIDATION_FAILED', 'SUPPORT_BOOKING_NOT_ELIGIBLE', 'SUPPORT_CASE_LIMIT_REACHED',
    ],
    params: [{ name: 'bookingId', type: 'integer', description: 'bookings.id' }],
    status: 'implemented',
    domainService: 'services/reviews/postServiceSupportService.createSupportCase',
    legacy: [
      {
        method: 'post',
        path: '/api/support/tickets',
        disposition: 'ROLE_SPECIFIC',
        note:
          'The general customer contact surface. It carries no bookingId, so a quality ' +
          'complaint raised through it arrives with no way to see which visit it is about. ' +
          'Kept for contact that is genuinely not about a booking.',
      },
    ],
    callers: { customerMobile: 'planned', customerWeb: 'planned', providerMobile: 'n/a', providerWeb: 'n/a', admin: 'n/a' },
    observability: 'reviews',
    notes:
      'A BILLING category is accepted and ROUTED to the finance domain: the response carries ' +
      'routedTo: finance and names the refund endpoint. Handling it here would fork the refund ' +
      'rules into a second, weaker path beside the one reconciliation checks.',
  },
  {
    id: 'bookings.supportCases.list',
    domain: 'reviews',
    method: 'get',
    path: '/bookings/:bookingId/support-cases',
    summary: 'The cases the caller raised on this booking.',
    auth: 'authenticated',
    idempotent: true,
    responseSchema: 'SupportCaseList',
    errors: ['VALIDATION_FAILED'],
    params: [{ name: 'bookingId', type: 'integer', description: 'bookings.id' }],
    status: 'implemented',
    domainService: 'services/reviews/postServiceSupportService.listSupportCases',
    legacy: [],
    callers: { customerMobile: 'planned', customerWeb: 'planned', providerMobile: 'n/a', providerWeb: 'n/a', admin: 'n/a' },
    observability: 'reviews',
    notes:
      'Owner-scoped in SQL. There is no parameter naming another account, which is what makes ' +
      'the isolation test a statement about the code rather than about today\'s routes.',
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
    replayMechanism: ['external-authority'],
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
    replayMechanism: ['external-authority', 'rate-limit'],
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
    replayMechanism: ['external-authority'],
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
    callers: { customerMobile: 'legacy', customerWeb: 'legacy', providerMobile: 'legacy', providerWeb: 'migrated', admin: 'legacy' },
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
    replayMechanism: ['single-use-token'],
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
    replayMechanism: ['single-use-token'],
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
    callers: { customerMobile: 'planned', customerWeb: 'planned', providerMobile: 'migrated', providerWeb: 'planned', admin: 'n/a' },
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
    summary: 'The composed customer home surface. A read model; it owns nothing.',
    auth: 'authenticated',
    idempotent: true,
    responseSchema: 'HomeFeed',
    errors: ['VALIDATION_FAILED'],
    query: [
      {
        name: 'sections',
        type: 'string',
        required: false,
        description:
          'Comma-separated section types. Omit for the default set. An unknown name is ' +
          'IGNORED, never refused - the registry is append-only, and refusing would make ' +
          'adding a section a breaking change for every older client.',
      },
    ],
    status: 'implemented',
    domainService: 'services/home/homeService.composeHome',
    legacy: [
      {
        method: 'get',
        path: '/api/catalog',
        disposition: 'KEEP',
        note:
          'NOT superseded. The customer app calls it directly for the category browse, and it ' +
          'remains the canonical catalog read. Home REFERENCES it - the categories section ' +
          'delegates to the same service - rather than replacing it.',
      },
      {
        method: 'get',
        path: '/api/user/notifications/unread-count',
        disposition: 'KEEP',
        note:
          'NOT superseded. Home carries the unread count as one section so a launch costs one ' +
          'round trip; the standalone endpoint is still what a client polls when only the ' +
          'badge changed.',
      },
    ],
    callers: { customerMobile: 'planned', customerWeb: 'planned', providerMobile: 'n/a', providerWeb: 'n/a', admin: 'n/a' },
    observability: 'home',
    notes:
      'A COMPOSITION endpoint. It aggregates and owns nothing: every service card carries ' +
      'services.id from Catalog V2, every booking card carries bookings.id with the canonical ' +
      'state the booking read model derives, and the unread count comes from the one inbox. ' +
      'The response Cache-Control is derived from the SECTIONS PRESENT rather than from the ' +
      'route, so a public-only selection is cacheable and anything personal is no-store.',
  },
  {
    id: 'home.sections',
    domain: 'home',
    method: 'get',
    path: '/home/sections',
    summary: 'The section registry: what the page is made of and what owns each part.',
    auth: 'authenticated',
    idempotent: true,
    responseSchema: 'HomeSectionRegistry',
    errors: [],
    status: 'implemented',
    domainService: 'services/home/homeService.describeSections',
    legacy: [],
    callers: { customerMobile: 'planned', customerWeb: 'planned', providerMobile: 'n/a', providerWeb: 'n/a', admin: 'planned' },
    observability: 'home',
    notes:
      'METADATA, not content - it names no account and no resource, so it caches like the ' +
      'catalog it describes. A client uses it to render an unknown section safely rather than ' +
      'crashing on it, which is what makes the registry append-only in practice as well as in ' +
      'principle.',
  },
  // ───────────────────────────────────────────────────────────────────────────
  // Messaging — one booking-aware conversation resource for all five surfaces.
  //
  // Every entry below delegates to `services/messaging/messagingService`, which
  // delegates every ACCESS question to `chat/chat.service` — the same resolver
  // the legacy `/api/chat/...` routes and the Socket.IO gateway already use. So
  // "one canonical domain service behind all clients" is not an aspiration for
  // this domain: the canonical routes and the legacy routes are the same
  // authorization and the same write path, reached by two URLs.
  //
  // The DTO is the part that is new. `services/messaging/conversationDto`
  // builds ONE message object carrying both the legacy keys the four shipped
  // clients read and the canonical keys v1 publishes, and the realtime emit
  // sends that same object — which is what makes the realtime payload and the
  // REST row for a given message id the same message rather than two renderings
  // of it.
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'conversations.create',
    domain: 'conversations',
    method: 'post',
    path: '/conversations',
    summary: "Opens, or resolves, the conversation for a booking.",
    auth: 'authenticated',
    idempotent: false,
    replayMechanism: ['unique-constraint'],
    replayGuard:
      'One conversation per booking, enforced by a unique constraint on booking_id and an ' +
      'ON CONFLICT insert. A repeat returns the SAME conversation rather than opening a ' +
      'second thread, so there is nothing for a retry to duplicate.',
    requestSchema: 'ConversationCreateRequest',
    responseSchema: 'Conversation',
    errors: [
      'VALIDATION_FAILED', 'BOOKING_NOT_FOUND',
      'CONVERSATION_ACCESS_DENIED', 'CONVERSATION_NOT_AVAILABLE',
    ],
    status: 'implemented',
    domainService: 'services/messaging/messagingService.openConversation',
    legacy: [
      {
        method: 'get',
        path: '/api/bookings/:bookingId/conversation',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'The live resolve-by-booking call. It is a GET that never creates, and the customer ' +
          'app already maps its 404 to "no conversation yet". This entry adds the explicit ' +
          'open, gated by the same rule: a booking conversation exists because a provider was ' +
          'confirmed, not because somebody opened a screen.',
      },
    ],
    callers: { customerMobile: 'legacy', customerWeb: 'legacy', providerMobile: 'legacy', providerWeb: 'migrated', admin: 'legacy' },
    observability: 'messaging',
    notes:
      'Support may open a conversation on a booking with no provider; the parties may not. ' +
      'That is `mayOpenConversation` in the policy, not an `if` in the handler, so the rule ' +
      'is the same one the generated contract document tabulates.',
  },
  {
    id: 'conversations.list',
    domain: 'conversations',
    method: 'get',
    path: '/conversations',
    summary: "The caller's booking conversations, with unread counts.",
    auth: 'authenticated',
    idempotent: true,
    responseSchema: 'ConversationList',
    errors: [],
    status: 'implemented',
    domainService: 'services/messaging/messagingService.listConversations',
    legacy: [
      {
        method: 'get',
        path: '/api/chat/conversations',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'The live inbox for all four apps. Chat routes do NOT use an envelope — the stores ' +
          'read a top-level `conversations` key — so the legacy shape is kept exactly and this ' +
          'entry adds the canonical one alongside. Both now read the same unread expression.',
      },
      {
        method: 'get',
        path: '/api/admin/communications/conversations',
        disposition: 'ROLE_SPECIFIC',
        note:
          'The admin oversight list carries a named permission and a booking filter, and joins ' +
          'moderation state this route has no business publishing to a customer. Same tables, ' +
          'same conversation ids; a genuinely different question.',
      },
    ],
    callers: { customerMobile: 'legacy', customerWeb: 'legacy', providerMobile: 'legacy', providerWeb: 'migrated', admin: 'legacy' },
    observability: 'messaging',
    notes:
      'An admin receives the oversight list from the same handler and gets no unread counts — ' +
      'they hold no read pointer on a booking they merely supervise, so any number would be ' +
      'invented. `meta.unreadTotal` is the badge total, summed from the same per-conversation ' +
      'numbers the list carries.',
  },
  {
    id: 'conversations.get',
    domain: 'conversations',
    method: 'get',
    path: '/conversations/:conversationId',
    summary: 'One conversation: state, participants, and the caller\'s unread count.',
    auth: 'authenticated',
    idempotent: true,
    responseSchema: 'Conversation',
    errors: ['VALIDATION_FAILED', 'CONVERSATION_ACCESS_DENIED'],
    params: [{ name: 'conversationId', type: 'integer', description: 'chat_conversations.id' }],
    status: 'implemented',
    domainService: 'services/messaging/messagingService.getConversation',
    legacy: [
      {
        method: 'get',
        path: '/api/chat/conversations/:id',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'The live detail call. Same authorization; the canonical shape adds the seat, the ' +
          'send capability with its reason, the unread count and a last-message preview built ' +
          'through the caller\'s own read floor.',
      },
      {
        method: 'get',
        path: '/api/admin/communications/conversations/:id',
        disposition: 'ROLE_SPECIFIC',
        note:
          'The admin detail view, permissioned, and carrying report and moderation state. ' +
          'Different fields, different authorization, same conversation id.',
      },
    ],
    callers: { customerMobile: 'legacy', customerWeb: 'legacy', providerMobile: 'legacy', providerWeb: 'migrated', admin: 'legacy' },
    observability: 'messaging',
    notes:
      'Participant contact columns are never published. `listParticipants` joins ' +
      'user_credentials and user_profile, and the DTO names a display name and an avatar ' +
      'rather than copying the row — a subtractive projection would disclose every column ' +
      'somebody forgets to strip. Departed participants are shown to support only.',
  },
  {
    id: 'conversations.messages.list',
    domain: 'conversations',
    method: 'get',
    path: '/conversations/:conversationId/messages',
    summary: 'A page of the transcript, newest first, cursor-paged.',
    auth: 'authenticated',
    idempotent: true,
    responseSchema: 'MessagePage',
    errors: [
      'VALIDATION_FAILED', 'CONVERSATION_ACCESS_DENIED', 'MESSAGE_HISTORY_UNAVAILABLE',
    ],
    params: [{ name: 'conversationId', type: 'integer', description: 'chat_conversations.id' }],
    query: [
      { name: 'limit', type: 'integer', required: false, description: 'Default 30, clamped to 100.' },
      { name: 'cursor', type: 'integer', required: false, description: 'A message id. Returns messages strictly OLDER than it.' },
    ],
    status: 'implemented',
    domainService: 'services/messaging/messagingService.listMessages',
    legacy: [
      {
        method: 'get',
        path: '/api/chat/conversations/:id/messages',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'The live transcript read, now a narrower projection of the SAME page reader — same ' +
          'authorization, same read floor, same builder. Its cursor parameter is called ' +
          '`before`; the canonical one is `cursor`, and both mean the same message id.',
      },
      {
        method: 'get',
        path: '/api/admin/communications/conversations/:id/messages',
        disposition: 'ROLE_SPECIFIC',
        note:
          'The permissioned admin transcript. It reads the whole thread by design — the audit ' +
          'trail is the point — where this route applies the caller\'s own read floor.',
      },
    ],
    callers: { customerMobile: 'legacy', customerWeb: 'legacy', providerMobile: 'legacy', providerWeb: 'migrated', admin: 'legacy' },
    observability: 'messaging',
    notes:
      'A replacement provider reads from THEIR assignment forward, never the previous ' +
      'provider\'s transcript, and an assignment with no usable timestamp fails closed. ' +
      'Cursor paging rather than offset: rows arrive at the end while a reader pages, so an ' +
      'offset scan silently repeats or skips messages.',
  },
  {
    id: 'conversations.messages.create',
    domain: 'conversations',
    method: 'post',
    path: '/conversations/:conversationId/messages',
    summary: 'Sends a message. The sender is the authenticated caller.',
    auth: 'authenticated',
    idempotent: false,
    replayMechanism: ['client-request-id', 'unique-constraint'],
    replayGuard:
      'A REQUIRED clientMsgId, unique per (conversation, sender) by partial index. A retried ' +
      'send returns the ORIGINAL message rather than creating a second one, and the pre-read ' +
      'plus the index together close the two-device race.',
    requestSchema: 'SendMessageRequest',
    responseSchema: 'Message',
    errors: [
      'VALIDATION_FAILED', 'CONVERSATION_ACCESS_DENIED', 'CONVERSATION_NOT_WRITABLE',
      'MESSAGE_INVALID', 'MESSAGE_IDEMPOTENCY_KEY_INVALID',
      'MESSAGE_ATTACHMENT_REJECTED', 'RATE_LIMITED',
    ],
    params: [{ name: 'conversationId', type: 'integer', description: 'chat_conversations.id' }],
    status: 'implemented',
    domainService: 'chat/chat.service.sendMessage',
    legacy: [
      {
        method: 'post',
        path: '/api/chat/conversations/:id/messages',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'The live send for all four apps. IDENTICAL domain call — this entry is a second URL ' +
          'onto one write, not a second write path.',
      },
      {
        method: 'post',
        path: '/api/admin/communications/conversations/:id/messages',
        disposition: 'ROLE_SPECIFIC',
        note:
          'The admin send. Permissioned and audited, and it already delegates to ' +
          '`chat.service.sendMessage`, so an admin message obeys the same idempotency, ' +
          'validation and attachment rules as anyone else\'s.',
      },
    ],
    callers: { customerMobile: 'legacy', customerWeb: 'legacy', providerMobile: 'legacy', providerWeb: 'migrated', admin: 'legacy' },
    observability: 'messaging',
    notes:
      'Nothing in the body names a sender. `sender_uid` is written from the actor the handler ' +
      'built out of the verified token, and there is no path, query or body parameter that ' +
      'can name another one.',
  },
  {
    id: 'conversations.attachments.create',
    domain: 'conversations',
    method: 'post',
    path: '/conversations/:conversationId/attachments',
    summary: 'Stores one attachment for a conversation the caller may write to.',
    auth: 'authenticated',
    idempotent: false,
    replayMechanism: ['none-accepted'],
    replayGuard:
      'None, and none is claimed: a repeat stores a SECOND object under a fresh uuid key. ' +
      'That is wasted storage, not damage — an attachment is inert until a message ' +
      'references it, and the send that does reference it carries the idempotency. Bounding ' +
      'it is the upload rate limit and the 10 MB ceiling, both enforced before any write.',
    requestSchema: 'ChatAttachmentUpload',
    responseSchema: 'ChatAttachment',
    errors: [
      'VALIDATION_FAILED', 'CONVERSATION_ACCESS_DENIED', 'CONVERSATION_NOT_WRITABLE',
      'MESSAGE_ATTACHMENT_REJECTED', 'RATE_LIMITED',
    ],
    params: [{ name: 'conversationId', type: 'integer', description: 'chat_conversations.id' }],
    status: 'implemented',
    domainService: 'chat/chat.service.uploadAttachment',
    legacy: [
      {
        method: 'post',
        path: '/api/chat/attachments/upload',
        disposition: 'CANONICALIZE',
        note:
          'The legacy route takes the conversation as an OPTIONAL body field and checks access ' +
          'only when it is present, so omitting it stored a file and returned a URL with no ' +
          'conversation consulted. This route carries the id in its path, so the check cannot ' +
          'be declined. Same validation, same storage call — `chat.service.uploadAttachment` ' +
          'is now the one implementation and the legacy controller delegates to it.',
      },
    ],
    callers: { customerMobile: 'planned', customerWeb: 'planned', providerMobile: 'planned', providerWeb: 'planned', admin: 'planned' },
    observability: 'messaging',
    notes:
      'The MIME allowlist and the 10 MB ceiling are checked by SIGNATURE, not by the declared ' +
      'content type, and the stored filename is sanitised rather than echoed.',
  },
  {
    id: 'conversations.messages.report',
    domain: 'conversations',
    method: 'post',
    path: '/conversations/:conversationId/messages/:messageId/report',
    summary: 'Reports one message in this conversation to moderation.',
    auth: 'authenticated',
    idempotent: false,
    replayMechanism: ['none-accepted'],
    replayGuard:
      'None. A second report by the same reporter files a second row, which is a moderation ' +
      'queue concern rather than a correctness one — the alternative, silently swallowing a ' +
      'repeat, tells someone reporting an escalating exchange that nothing happened.',
    requestSchema: 'MessageReportRequest',
    responseSchema: 'MessageReport',
    errors: [
      'VALIDATION_FAILED', 'CONVERSATION_ACCESS_DENIED', 'MESSAGE_NOT_FOUND',
      'MESSAGE_INVALID', 'RATE_LIMITED',
    ],
    params: [
      { name: 'conversationId', type: 'integer', description: 'chat_conversations.id' },
      { name: 'messageId', type: 'integer', description: 'chat_messages.id' },
    ],
    status: 'implemented',
    domainService: 'chat/chat.service.reportMessage',
    legacy: [
      {
        method: 'post',
        path: '/api/chat/conversations/:id/messages/:msgId/report',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'IDENTICAL domain call. This entry is a second URL onto one write, in the resource ' +
          'shape the rest of the conversations domain already uses.',
      },
    ],
    callers: { customerMobile: 'planned', customerWeb: 'planned', providerMobile: 'planned', providerWeb: 'planned', admin: 'n/a' },
    observability: 'messaging',
    notes:
      'The reporter is the token subject. Nothing in the path or body can name a different ' +
      'one, which is what stops a report being filed as somebody else.',
  },
  {
    id: 'conversations.read',
    domain: 'conversations',
    method: 'post',
    path: '/conversations/:conversationId/read',
    summary: "Advances the caller's read pointer and returns the resulting unread count.",
    auth: 'authenticated',
    idempotent: true,
    responseSchema: 'ConversationReadState',
    errors: [
      'VALIDATION_FAILED', 'CONVERSATION_ACCESS_DENIED', 'READ_POINTER_INVALID',
    ],
    params: [{ name: 'conversationId', type: 'integer', description: 'chat_conversations.id' }],
    requestSchema: 'MarkReadRequest',
    status: 'implemented',
    domainService: 'services/messaging/messagingService.markRead',
    legacy: [
      {
        method: 'post',
        path: '/api/chat/conversations/:id/read',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'The live read-pointer call, which answers `{ success: true }` and nothing else. The ' +
          'canonical one returns the resulting unread count, so a client stops having to guess ' +
          'what its badge should now say.',
      },
    ],
    callers: { customerMobile: 'legacy', customerWeb: 'legacy', providerMobile: 'legacy', providerWeb: 'migrated', admin: 'legacy' },
    observability: 'messaging',
    notes:
      'A POST that is genuinely idempotent: the pointer is a monotonic high-water mark, only ' +
      'ever advanced, and only to a message that exists in THIS conversation and is visible ' +
      'to this participant — both enforced in SQL, so an out-of-order client cannot un-read a ' +
      'conversation or point at somebody else\'s thread.',
  },
  // `provider.earnings.summary` was a PLANNED placeholder here until TAB 07.
  // It deferred earnings explicitly — "the payout window is already documented
  // as 48h in copy and 72h in reality, and a second read path before that is
  // settled would give two answers to 'when am I paid'". That is now settled:
  // `payoutStatus.PROVIDER_RELEASE_HOURS` is the single 72, the backend computes
  // the arrival date from it, and the implemented entry lives with the rest of
  // the finance domain at the bottom of this file.
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
    replayMechanism: ['client-idempotency-key', 'state-machine'],
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
    callers: { customerMobile: 'planned', customerWeb: 'planned', providerMobile: 'migrated', providerWeb: 'planned', admin: 'planned' },
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
    activeProvider: true,
    idempotent: false,
    replayMechanism: ['client-idempotency-key', 'state-machine'],
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
    callers: { customerMobile: 'n/a', customerWeb: 'n/a', providerMobile: 'migrated', providerWeb: 'migrated', admin: 'n/a' },
    observability: 'provider-jobs',
  },
  {
    id: 'provider.jobs.decline',
    domain: 'provider-jobs',
    method: 'post',
    path: '/provider/jobs/:bookingId/decline',
    summary: 'Declines the assignment, returning the booking to the pool.',
    auth: 'provider',
    activeProvider: true,
    idempotent: false,
    replayMechanism: ['client-idempotency-key', 'state-machine'],
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
    callers: { customerMobile: 'n/a', customerWeb: 'n/a', providerMobile: 'migrated', providerWeb: 'migrated', admin: 'n/a' },
    observability: 'provider-jobs',
  },
  {
    id: 'provider.jobs.enroute',
    domain: 'provider-jobs',
    method: 'post',
    path: '/provider/jobs/:bookingId/en-route',
    summary: 'Marks the provider on the way.',
    auth: 'provider',
    activeProvider: true,
    idempotent: false,
    replayMechanism: ['client-idempotency-key', 'state-machine'],
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
    callers: { customerMobile: 'n/a', customerWeb: 'n/a', providerMobile: 'migrated', providerWeb: 'migrated', admin: 'n/a' },
    observability: 'provider-jobs',
  },
  {
    id: 'provider.jobs.arrived',
    domain: 'provider-jobs',
    method: 'post',
    path: '/provider/jobs/:bookingId/arrived',
    summary: 'Marks the provider at the address.',
    auth: 'provider',
    activeProvider: true,
    idempotent: false,
    replayMechanism: ['client-idempotency-key', 'state-machine'],
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
    callers: { customerMobile: 'n/a', customerWeb: 'n/a', providerMobile: 'migrated', providerWeb: 'migrated', admin: 'n/a' },
    observability: 'provider-jobs',
  },
  {
    id: 'provider.jobs.start',
    domain: 'provider-jobs',
    method: 'post',
    path: '/provider/jobs/:bookingId/start',
    summary: 'Starts the job. Requires the customer worker code.',
    auth: 'provider',
    activeProvider: true,
    idempotent: false,
    replayMechanism: ['client-idempotency-key', 'state-machine'],
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
    callers: { customerMobile: 'n/a', customerWeb: 'n/a', providerMobile: 'migrated', providerWeb: 'legacy', admin: 'n/a' },
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
    activeProvider: true,
    idempotent: false,
    replayMechanism: ['client-idempotency-key', 'state-machine'],
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
    callers: { customerMobile: 'n/a', customerWeb: 'n/a', providerMobile: 'migrated', providerWeb: 'migrated', admin: 'n/a' },
    observability: 'provider-jobs',
  },
  {
    id: 'provider.jobs.cancel',
    domain: 'provider-jobs',
    method: 'post',
    path: '/provider/jobs/:bookingId/cancel',
    summary: 'Cancels a job the provider had already accepted, subject to the notice policy.',
    auth: 'provider',
    activeProvider: true,
    idempotent: false,
    replayMechanism: ['client-idempotency-key', 'state-machine'],
    replayGuard:
      'An Idempotency-Key replays the original result. Without one, the repeat ' +
      'finds the booking back at AWAITING_ASSIGNMENT with no assignment for this ' +
      'provider, so the machine refuses it as not theirs.',
    requestSchema: 'BookingActionRequest',
    responseSchema: 'BookingTransitionResult',
    errors: [
      'VALIDATION_FAILED', 'BOOKING_NOT_FOUND', 'BOOKING_ACCESS_DENIED',
      'BOOKING_STATE_CONFLICT', 'BOOKING_TRANSITION_INVALID', 'BOOKING_TERMINAL',
      'PROVIDER_ROLE_REQUIRED',
      'BOOKING_POLICY_REFUSED',
      'BOOKING_PROVIDER_CANCEL_WINDOW_EXPIRED', 'BOOKING_PROVIDER_CANCEL_STAGE_INVALID',
      'BOOKING_PROVIDER_CANCEL_SCHEDULE_UNKNOWN', 'BOOKING_PROVIDER_CANCEL_REASON_INVALID',
      'IDEMPOTENCY_KEY_INVALID', 'IDEMPOTENCY_KEY_REUSED',
    ],
    params: [{ name: 'bookingId', type: 'integer', description: 'bookings.id' }],
    status: 'implemented',
    domainService: 'services/booking/transitionExecutor.transitionBooking (PROVIDER_CANCEL)',
    legacy: [
      {
        method: 'post',
        path: '/api/provider/bookings/:bookingId/cancel',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'The live Provider Web / Provider Mobile cancel. It ALREADY runs the executor ' +
          'and the same providerCancellationWindow guard — this entry gives it a canonical ' +
          'path and a v1 error vocabulary, it does not give it a second implementation.',
      },
      {
        method: 'get',
        path: '/api/provider/bookings/:bookingId/cancellation-eligibility',
        disposition: 'KEEP',
        note:
          'NOT a duplicate. It answers "may I cancel, and until when" without cancelling, ' +
          'from the same evaluateCancellation function. The canonical successor for that ' +
          'question is the availableActions block on GET /bookings/:id/transitions.',
      },
    ],
    callers: { customerMobile: 'n/a', customerWeb: 'n/a', providerMobile: 'migrated', providerWeb: 'migrated', admin: 'n/a' },
    observability: 'provider-jobs',
    notes:
      'Completes the cancellation triad. Customer, provider and admin cancellation are ' +
      'three actions with three guards on ONE state machine — see §3 of ' +
      'BOOKING_EXPERIENCES_V1_CONTRACT.md.',
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Booking experiences — tracking, codes, reschedule, additional work,
  // disputes. Every one is booking-scoped: `bookingId` is the parent identity
  // and no related resource carries a lifecycle of its own (§60).
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'bookings.tracking',
    domain: 'booking-experiences',
    method: 'get',
    path: '/bookings/:bookingId/tracking',
    summary: "Tracking history, canonical state, and the provider's position when the policy permits it.",
    auth: 'authenticated',
    idempotent: true,
    responseSchema: 'BookingTracking',
    errors: ['VALIDATION_FAILED', 'BOOKING_NOT_FOUND', 'BOOKING_ACCESS_DENIED'],
    params: [{ name: 'bookingId', type: 'integer', description: 'bookings.id' }],
    status: 'implemented',
    domainService: 'services/booking/bookingTrackingService.getBookingTracking',
    legacy: [
      {
        method: 'get',
        path: '/api/:id/tracking',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'The live customer tracking call. It returns the raw booking_tracking rows through ' +
          'formatBookings and applies NO state or time-window rule to the provider position, ' +
          'because it never returned one — the position came from a separate route.',
      },
      {
        method: 'get',
        path: '/api/booking/:bookingId/provider-location',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'The authenticated position route. Booking-scoped already, but answers in EVERY ' +
          'state — a customer could watch their provider on a booking cancelled last week. ' +
          'This entry adds the state and time-window rules §64 requires.',
      },
    ],
    callers: { customerMobile: 'legacy', customerWeb: 'legacy', providerMobile: 'migrated', providerWeb: 'migrated', admin: 'planned' },
    observability: 'booking-experiences',
    notes:
      'A withheld position is a 200 with visibility.reason, never a 403: the caller is ' +
      'entitled to the booking and simply not to a live location for it yet. ' +
      'The unauthenticated GET /api/workers/location/:uid is NOT listed as legacy here ' +
      'because it no longer exists — it was retired with the rest of the worker-lookup ' +
      'family (docs/WORKER_ROUTE_MIGRATION.md). Naming a deleted route as a live alias ' +
      'would put a phantom row in the migration matrix and in the telemetry watch list.',
  },
  {
    id: 'bookings.otp.request',
    domain: 'booking-experiences',
    method: 'post',
    path: '/bookings/:bookingId/otp/request',
    summary: 'Issues a booking code for one purpose. The code is never in the response.',
    auth: 'authenticated',
    idempotent: false,
    replayMechanism: ['rate-limit', 'state-machine'],
    replayGuard:
      'A resend cooldown, an issue ceiling per booking and purpose, and a state ' +
      'rule. A replay inside the cooldown is refused with the seconds remaining ' +
      'rather than minting a second code and invalidating the first.',
    requestSchema: 'BookingOtpRequest',
    responseSchema: 'BookingOtpIssued',
    errors: [
      'VALIDATION_FAILED', 'BOOKING_NOT_FOUND', 'BOOKING_ACCESS_DENIED',
      'BOOKING_OTP_PURPOSE_INVALID', 'BOOKING_OTP_NOT_APPLICABLE',
      'BOOKING_OTP_ACTOR_NOT_PERMITTED', 'BOOKING_OTP_RESEND_COOLDOWN',
      'BOOKING_OTP_RESEND_LIMIT',
    ],
    params: [{ name: 'bookingId', type: 'integer', description: 'bookings.id' }],
    status: 'implemented',
    domainService: 'services/booking/bookingOtpService.requestBookingOtp',
    legacy: [
      {
        method: 'post',
        path: '/api/:bookingId/resend-otp',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'The OTP screen\'s Resend button. It rotates the code with no cooldown and no ' +
          'issue ceiling; it now delegates to the same service, so the legacy path inherits ' +
          'the policy rather than remaining an unlimited rotation oracle.',
      },
    ],
    callers: { customerMobile: 'legacy', customerWeb: 'planned', providerMobile: 'n/a', providerWeb: 'n/a', admin: 'planned' },
    observability: 'booking-experiences',
  },
  {
    id: 'bookings.otp.verify',
    domain: 'booking-experiences',
    method: 'post',
    path: '/bookings/:bookingId/otp/verify',
    summary: 'Presents a booking code. Success is a state transition performed by the executor.',
    auth: 'authenticated',
    idempotent: false,
    replayMechanism: ['client-idempotency-key', 'state-machine', 'rate-limit'],
    replayGuard:
      'An Idempotency-Key replays the original result. Without one, the attempt ' +
      'budget bounds it and the machine refuses a repeat because the booking has ' +
      'already left the state the code applied to.',
    requestSchema: 'BookingOtpVerifyRequest',
    responseSchema: 'BookingTransitionResult',
    errors: [
      'VALIDATION_FAILED', 'BOOKING_NOT_FOUND', 'BOOKING_ACCESS_DENIED',
      'BOOKING_OTP_PURPOSE_INVALID', 'BOOKING_OTP_NOT_APPLICABLE',
      'BOOKING_OTP_ACTOR_NOT_PERMITTED', 'BOOKING_OTP_EXPIRED',
      'BOOKING_OTP_ATTEMPTS_EXHAUSTED', 'BOOKING_OTP_NOT_ISSUED',
      'BOOKING_OTP_INVALID', 'BOOKING_WORKER_CODE_INVALID',
      'BOOKING_STATE_CONFLICT', 'BOOKING_TRANSITION_INVALID', 'BOOKING_TERMINAL',
      'IDEMPOTENCY_KEY_INVALID', 'IDEMPOTENCY_KEY_REUSED',
    ],
    params: [{ name: 'bookingId', type: 'integer', description: 'bookings.id' }],
    status: 'implemented',
    domainService: 'services/booking/bookingOtpService.verifyBookingOtp',
    legacy: [
      {
        method: 'post',
        path: '/api/:id/confirm-otp',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'The live customer confirmation. Already on the executor since Phase C; it now ' +
          'delegates through the OTP service so expiry and the attempt limit apply to it ' +
          'too. Accepts the code in the query string for builds that cannot be changed.',
      },
    ],
    callers: { customerMobile: 'legacy', customerWeb: 'planned', providerMobile: 'planned', providerWeb: 'migrated', admin: 'planned' },
    observability: 'booking-experiences',
    notes:
      'Purpose-scoped. BOOKING_CONFIRMATION is presented by the customer and checked ' +
      'against otp_code; SERVICE_START is presented by the assigned provider and checked ' +
      'against worker_code. A code cannot satisfy the other purpose — different column, ' +
      'different permitted actor.',
  },
  {
    id: 'bookings.otp.status',
    domain: 'booking-experiences',
    method: 'get',
    path: '/bookings/:bookingId/otp/status',
    summary: 'Code lifetime, attempts left and resend availability, without spending an attempt.',
    auth: 'authenticated',
    idempotent: true,
    responseSchema: 'BookingOtpStatus',
    errors: [
      'VALIDATION_FAILED', 'BOOKING_NOT_FOUND', 'BOOKING_ACCESS_DENIED',
      'BOOKING_OTP_PURPOSE_INVALID',
    ],
    params: [{ name: 'bookingId', type: 'integer', description: 'bookings.id' }],
    query: [{ name: 'purpose', type: 'string', required: false, description: 'BOOKING_CONFIRMATION (default) or SERVICE_START.' }],
    status: 'implemented',
    domainService: 'services/booking/bookingOtpService.readCredentialState',
    legacy: [],
    callers: { customerMobile: 'planned', customerWeb: 'planned', providerMobile: 'migrated', providerWeb: 'migrated', admin: 'planned' },
    observability: 'booking-experiences',
    notes:
      'Exists so a client renders "resend in 42s" and "2 attempts left" from the backend ' +
      'rather than from its own copy of the policy — the same argument availableActions ' +
      'makes for buttons.',
  },
  {
    id: 'bookings.reschedule',
    domain: 'booking-experiences',
    method: 'post',
    path: '/bookings/:bookingId/reschedule',
    summary: 'Moves a booking. One endpoint for the customer and the admin.',
    auth: 'authenticated',
    idempotent: false,
    replayMechanism: ['state-predicate'],
    replayGuard:
      'The write carries `schedule IS NOT DISTINCT FROM <expected>`, so a repeat ' +
      'of an applied move finds the schedule already changed and is refused with ' +
      'BOOKING_SCHEDULE_CHANGED rather than moving the booking a second time.',
    requestSchema: 'BookingRescheduleRequest',
    responseSchema: 'BookingRescheduleResult',
    errors: [
      'VALIDATION_FAILED', 'BOOKING_NOT_FOUND', 'BOOKING_ACCESS_DENIED',
      'BOOKING_NOT_RESCHEDULABLE', 'BOOKING_SCHEDULE_INVALID',
      'BOOKING_RESCHEDULE_NOTICE_REQUIRED', 'BOOKING_RESCHEDULE_REASON_INVALID',
      'BOOKING_RESCHEDULE_PROVIDER_CONFLICT', 'BOOKING_SCHEDULE_CHANGED',
    ],
    params: [{ name: 'bookingId', type: 'integer', description: 'bookings.id' }],
    status: 'implemented',
    domainService: 'services/booking/bookingRescheduleService.rescheduleBooking',
    legacy: [
      {
        method: 'post',
        path: '/api/admin/bookings/:id/reschedule',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'The admin-only predecessor, and the only reschedule that has ever existed. A bare ' +
          'UPDATE with no optimistic concurrency and no provider-calendar check — two admins ' +
          'moving one booking produced a silent winner. Kept until the portal migrates.',
      },
    ],
    callers: { customerMobile: 'planned', customerWeb: 'planned', providerMobile: 'n/a', providerWeb: 'n/a', admin: 'legacy' },
    observability: 'booking-experiences',
    notes:
      'The provider is not a party (C18 §14/§24) and is refused with BOOKING_ACCESS_DENIED; ' +
      'they are notified of the outcome. A move that would collide with the assigned ' +
      "provider's calendar is refused, never silently released.",
  },
  {
    id: 'bookings.reschedule.history',
    domain: 'booking-experiences',
    method: 'get',
    path: '/bookings/:bookingId/reschedule',
    summary: 'Every attempt to move this booking, accepted or refused.',
    auth: 'authenticated',
    idempotent: true,
    responseSchema: 'BookingRescheduleHistory',
    errors: ['VALIDATION_FAILED', 'BOOKING_NOT_FOUND', 'BOOKING_ACCESS_DENIED'],
    params: [{ name: 'bookingId', type: 'integer', description: 'bookings.id' }],
    status: 'implemented',
    domainService: 'services/booking/bookingRescheduleService.listRescheduleRequests',
    legacy: [],
    callers: { customerMobile: 'planned', customerWeb: 'planned', providerMobile: 'planned', providerWeb: 'migrated', admin: 'planned' },
    observability: 'booking-experiences',
    notes:
      'What makes "no silent overwrite" observable to a client rather than only true in ' +
      'the database. The proposer\'s uid is not projected — the role is.',
  },
  {
    id: 'bookings.additionalWork.create',
    domain: 'booking-experiences',
    method: 'post',
    path: '/bookings/:bookingId/additional-work',
    summary: 'Raises a change order against the booking, as a child request awaiting approval.',
    auth: 'provider',
    activeProvider: true,
    idempotent: false,
    replayMechanism: ['none-accepted'],
    replayGuard:
      'The write requires an IN_PROGRESS assignment row held under FOR UPDATE, ' +
      'and each accepted request is a distinct priced child record — a repeat ' +
      'creates a second visible change order rather than mutating the first.',
    requestSchema: 'BookingAdditionalWorkRequest',
    responseSchema: 'BookingAdditionalWorkResult',
    errors: [
      'VALIDATION_FAILED', 'BOOKING_NOT_FOUND', 'BOOKING_ACCESS_DENIED',
      'PROVIDER_ROLE_REQUIRED',
      'BOOKING_ADDITIONAL_WORK_INVALID', 'BOOKING_ADDITIONAL_WORK_NOT_IN_PROGRESS',
    ],
    params: [{ name: 'bookingId', type: 'integer', description: 'bookings.id' }],
    status: 'implemented',
    domainService: 'services/additional.service.additionalService.createRequest',
    legacy: [
      {
        method: 'post',
        path: '/api/additional/request/:userId',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'The live Provider Web call. Its :userId segment is legacy and has never been ' +
          'treated as identity — the provider comes from the token in both paths, and both ' +
          'call the same additionalService instance.',
      },
    ],
    callers: { customerMobile: 'n/a', customerWeb: 'n/a', providerMobile: 'migrated', providerWeb: 'migrated', admin: 'n/a' },
    observability: 'booking-experiences',
    notes:
      'Additional work was ALREADY a child-request model (booking_additional_requests + ' +
      'booking_additional_items with its own approval/payment states). This gives it a ' +
      'booking-scoped canonical path; it does not re-model it.',
  },
  {
    id: 'bookings.additionalWork.list',
    domain: 'booking-experiences',
    method: 'get',
    path: '/bookings/:bookingId/additional-work',
    summary: 'The change orders on this booking, for anyone entitled to the booking.',
    auth: 'authenticated',
    idempotent: true,
    responseSchema: 'BookingAdditionalWorkList',
    errors: ['VALIDATION_FAILED', 'BOOKING_NOT_FOUND', 'BOOKING_ACCESS_DENIED'],
    params: [{ name: 'bookingId', type: 'integer', description: 'bookings.id' }],
    status: 'implemented',
    domainService: 'services/additional.service.additionalService.getByBooking',
    legacy: [
      {
        method: 'get',
        path: '/api/additional/booking/:bookingId',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'Already booking-scoped and already the same service. The canonical path differs ' +
          'only in living under the booking it belongs to, which is what §60 asks for.',
      },
    ],
    callers: { customerMobile: 'planned', customerWeb: 'planned', providerMobile: 'migrated', providerWeb: 'legacy', admin: 'planned' },
    observability: 'booking-experiences',
  },
  {
    id: 'bookings.disputes.open',
    domain: 'booking-experiences',
    method: 'post',
    path: '/bookings/:bookingId/disputes',
    summary: 'Opens a dispute against the booking, with the service and financial state at that moment.',
    auth: 'authenticated',
    idempotent: false,
    replayMechanism: ['unique-constraint', 'state-predicate'],
    replayGuard:
      'At most one unresolved escalation per booking, enforced by a partial ' +
      'unique index as well as by the policy check — so two simultaneous reports ' +
      'produce one record and one BOOKING_DISPUTE_ALREADY_OPEN, not two disputes.',
    requestSchema: 'BookingDisputeRequest',
    responseSchema: 'BookingDisputeResult',
    errors: [
      'VALIDATION_FAILED', 'BOOKING_NOT_FOUND', 'BOOKING_ACCESS_DENIED',
      'BOOKING_DISPUTE_ALREADY_OPEN', 'BOOKING_DISPUTE_NOT_ACTIONABLE',
      'BOOKING_DISPUTE_CATEGORY_INVALID',
    ],
    params: [{ name: 'bookingId', type: 'integer', description: 'bookings.id' }],
    status: 'implemented',
    domainService: 'services/booking/bookingDisputeService.openDispute',
    legacy: [
      {
        method: 'post',
        path: '/api/admin/bookings/:id/escalate',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'The admin-only predecessor, and the only way to open a dispute before this. Writes ' +
          'the same booking_escalations row; it does not record a category, the opening role ' +
          'or the state snapshot §66 requires. Kept until the portal migrates.',
      },
      {
        method: 'get',
        path: '/api/provider/bookings/:bookingId/dispute-status',
        disposition: 'ROLE_SPECIFIC',
        note:
          'Provider-facing eligibility summary, shipped as "entry point only; opening is ' +
          'later". It reads the same table and the same categories. It stays because it ' +
          'answers "may I open one" for a live client that has no other way to ask.',
      },
    ],
    callers: { customerMobile: 'planned', customerWeb: 'planned', providerMobile: 'migrated', providerWeb: 'migrated', admin: 'legacy' },
    observability: 'booking-experiences',
    notes:
      'One record for all three actors. A second dispute table would have given admin, ' +
      'provider and customer different answers to "is this booking disputed?" — the admin ' +
      'portal, deriveCanonicalState and the payout hold all read booking_escalations.',
  },
  {
    id: 'bookings.disputes.list',
    domain: 'booking-experiences',
    method: 'get',
    path: '/bookings/:bookingId/disputes',
    summary: 'The disputes on this booking. Investigation notes are never projected.',
    auth: 'authenticated',
    idempotent: true,
    responseSchema: 'BookingDisputeList',
    errors: ['VALIDATION_FAILED', 'BOOKING_NOT_FOUND', 'BOOKING_ACCESS_DENIED'],
    params: [{ name: 'bookingId', type: 'integer', description: 'bookings.id' }],
    status: 'implemented',
    domainService: 'services/booking/bookingDisputeService.listDisputes',
    legacy: [],
    callers: { customerMobile: 'planned', customerWeb: 'planned', providerMobile: 'migrated', providerWeb: 'migrated', admin: 'planned' },
    observability: 'booking-experiences',
    notes:
      '`reason`, `assigned_team` and `actor_uid` are withheld from every caller: free text ' +
      'one party typed about another, internal routing, and a person. Only `openedByYou` ' +
      'varies by caller.',
  },
  {
    id: 'admin.refunds.markFailed',
    domain: 'admin-finance',
    method: 'post',
    path: '/admin/refunds/:refundId/mark-failed',
    summary: 'Record that an approved refund did not go through.',
    auth: 'admin',
    /**
     * The same named permission the legacy twin demands.
     *
     * `auth: 'admin'` proves role 1 and nothing more. Its `requires` chain is
     * `refunds.mark_failed -> refunds.approve -> refunds.review.open`, which is
     * also why the approver-is-not-the-requester rule cannot be a permission:
     * the closure GUARANTEES that everybody who can approve can also request.
     * That rule lives in the executor, as a predicate in the write.
     */
    permission: 'refunds.mark_failed',
    idempotent: false,
    replayMechanism: ['state-predicate'],
    replayGuard:
      'The state predicate, in the write itself: the UPDATE matches only ' +
      '`status = \'approved\'`, so a replay finds the row already `failed` and ' +
      'affects nothing. That is a stronger bound than an idempotency key here, ' +
      'because it also refuses a SECOND operator submitting a different reason ' +
      'for the same refund minutes later — which a per-client key would happily ' +
      'let through as a distinct request. No payments row is written on this ' +
      'path, so a replay cannot move money even in principle.',
    requestSchema: 'RefundFailureRequest',
    responseSchema: 'RefundTransitionResult',
    errors: ['PERMISSION_REQUIRED', 'VALIDATION_FAILED', 'NOT_FOUND', 'CONFLICT'],
    params: [{ name: 'refundId', type: 'integer', description: 'finance_refund_reviews.id' }],
    status: 'implemented',
    domainService: 'services/adminFinanceService.markRefundFailed',
    legacy: [
      {
        method: 'post',
        path: '/api/admin/finance/refunds/:refundId/mark-failed',
        disposition: 'CANONICALIZE',
        note:
          'Mounted in the same change as this entry rather than inherited. The transition ' +
          'did not exist before — an approved refund the processor refused had no terminal, ' +
          'so it stayed `approved` and BLOCKED every retry for that booking, because ' +
          'openRefundReview refuses a second review while one is requested or approved. ' +
          'Both surfaces call the same executor; neither carries a copy of the rule.',
      },
    ],
    callers: {
      customerMobile: 'n/a',
      customerWeb: 'n/a',
      providerMobile: 'n/a',
      providerWeb: 'n/a',
      admin: 'legacy',
    },
    observability: 'admin-finance',
    notes:
      'Distinct from reject: rejected means a human decided against the refund, failed means ' +
      'everyone agreed and the money did not move. Only the second is worth retrying.',
  },
  {
    id: 'admin.bookings.list',
    domain: 'admin-bookings',
    method: 'get',
    path: '/admin/bookings',
    summary: 'Admin booking operations list.',
    auth: 'admin',
    permission: 'bookings.view',
    idempotent: true,
    responseSchema: 'AdminBookingList',
    errors: ['PERMISSION_REQUIRED'],
    status: 'implemented',
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

  // ───────────────────────────────────────────────────────────────────────────
  // Admin assignment
  //
  // Declared, not built. The legacy routes are live and correct — since TAB 04
  // they commit through `transitionBooking`, the same executor and the same
  // state machine the provider actions above use, so there is no second
  // operational truth to unify. What is missing is the canonical PATH, and
  // moving a live Admin route before its DTO is settled buys nothing.
  //
  // Registering them here is what makes them visible to the generated endpoint
  // registry and migration matrix, so the successor is named rather than
  // remembered.
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'admin.bookings.assignmentCandidates',
    domain: 'admin-bookings',
    method: 'get',
    path: '/admin/bookings/:bookingId/assignment-candidates',
    summary: 'Providers who could take this booking, ranked, each with its blocking reasons — and a diagnosis of the pool itself.',
    auth: 'admin',
    permission: 'bookings.assign_provider',
    idempotent: true,
    responseSchema: 'AssignmentCandidatePool',
    errors: ['PERMISSION_REQUIRED', 'VALIDATION_FAILED', 'NOT_FOUND'],
    params: [{ name: 'bookingId', type: 'integer', description: 'bookings.id' }],
    status: 'implemented',
    domainService: 'services/providerEligibilityEngine.listAssignmentCandidatePool',
    legacy: [
      {
        method: 'get',
        path: '/api/admin/bookings/:id/assignment-candidates',
        disposition: 'CANONICALIZE',
        note:
          'Live, and the only caller is the admin portal. Already returns the canonical pool ' +
          'plus its diagnostics; the diagnostics are a sibling key so the array under `data` ' +
          'stays exactly what the portal parses today.',
      },
    ],
    callers: { customerMobile: 'n/a', customerWeb: 'n/a', providerMobile: 'n/a', providerWeb: 'n/a', admin: 'legacy' },
    observability: 'admin-bookings',
    notes:
      'Read-only, but it is the preview of a mutation, so it must qualify providers with the ' +
      'predicate the assign call commits with. It does: both run PROVIDER_CAPABILITY_SQL. A ' +
      'preview narrower than its committer does not fail safe — it hides assignable providers.',
  },
  {
    id: 'admin.bookings.assign',
    domain: 'admin-bookings',
    method: 'post',
    path: '/admin/bookings/:bookingId/assign',
    summary: 'Assign a provider to an unassigned booking.',
    auth: 'admin',
    permission: 'bookings.assign_provider',
    idempotent: false,
    replayMechanism: ['row-lock', 'advisory-lock', 'state-machine'],
    replayGuard:
      'The executor locks the booking row and takes a provider-scoped advisory lock, then ' +
      'revalidates the commit-critical stages. A replayed assign of the SAME provider is ' +
      'refused as a no-op transition; a different provider requires the reassign action.',
    responseSchema: 'AdminBookingActionResult',
    requestSchema: 'AdminAssignRequest',
    errors: ['PERMISSION_REQUIRED', 'VALIDATION_FAILED', 'NOT_FOUND', 'BOOKING_STATE_CONFLICT', 'CONFLICT'],
    params: [{ name: 'bookingId', type: 'integer', description: 'bookings.id' }],
    status: 'implemented',
    domainService: 'services/booking/transitionExecutor.transitionBooking (ADMIN_ASSIGN)',
    legacy: [
      {
        method: 'post',
        path: '/api/admin/bookings/:id/assign',
        disposition: 'CANONICALIZE',
        note:
          'Live admin portal route, already on the canonical executor. Path-only migration: the ' +
          'business rules, locks and events do not move with it.',
      },
    ],
    callers: { customerMobile: 'n/a', customerWeb: 'n/a', providerMobile: 'n/a', providerWeb: 'n/a', admin: 'legacy' },
    observability: 'admin-bookings',
    notes:
      'Role-specific by AUTHORIZATION, not by truth: only an admin may name another actor as ' +
      'the provider. A provider accepting their own job goes through provider.jobs.accept, ' +
      'which derives identity from the token and can never name somebody else.',
  },
  {
    id: 'admin.bookings.reassign',
    domain: 'admin-bookings',
    method: 'post',
    path: '/admin/bookings/:bookingId/reassign',
    summary: 'Move an assigned booking from one provider to another, with an audited reason.',
    auth: 'admin',
    permission: 'bookings.reassign_provider',
    idempotent: false,
    replayMechanism: ['row-lock', 'advisory-lock', 'state-machine'],
    replayGuard:
      'Same two locks as assign. The outgoing assignment row is closed inside the transaction ' +
      'and stamped with when it closed, so a replay finds no open assignment for the previous ' +
      'provider and cannot double-close it.',
    responseSchema: 'AdminBookingActionResult',
    requestSchema: 'AdminReassignRequest',
    errors: ['PERMISSION_REQUIRED', 'VALIDATION_FAILED', 'NOT_FOUND', 'BOOKING_STATE_CONFLICT', 'CONFLICT'],
    params: [{ name: 'bookingId', type: 'integer', description: 'bookings.id' }],
    status: 'implemented',
    domainService: 'services/booking/transitionExecutor.transitionBooking (ADMIN_REASSIGN)',
    legacy: [
      {
        method: 'post',
        path: '/api/admin/bookings/:id/reassign',
        disposition: 'CANONICALIZE',
        note:
          'Live admin portal route, already on the canonical executor. A separate permission ' +
          'from assign (bookings.reassign_provider), which is the reason it stays a separate ' +
          'endpoint rather than an assign with a different body.',
      },
    ],
    callers: { customerMobile: 'n/a', customerWeb: 'n/a', providerMobile: 'n/a', providerWeb: 'n/a', admin: 'legacy' },
    observability: 'admin-bookings',
    notes:
      'The override record — actor, reason, previous provider, new provider — is written by the ' +
      'executor, not by the controller, so it cannot be skipped by a caller that forgets to ' +
      'audit. Reassignment preserves the outgoing provider\'s progression rather than erasing it.',
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Finance — payments, refunds, provider earnings, payouts, reconciliation
  //
  // Every entry below names a domain service under `services/finance/`, and all
  // of them project from ONE calculator (`financeLedger.computeBookingFinance`).
  // That is the property the tab's release gate depends on: Provider Web and
  // Provider Mobile "matching exactly" is not two implementations agreeing, it
  // is one implementation serving both.
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'bookings.payments.intent',
    domain: 'finance',
    method: 'post',
    path: '/bookings/:bookingId/payment-intents',
    summary: 'Starts or resumes the customer checkout for a booking.',
    auth: 'authenticated',
    idempotent: false,
    replayMechanism: ['advisory-lock', 'processor-idempotency-key'],
    replayGuard:
      'An advisory transaction lock on the booking, plus reuse of a live session for the same ' +
      'return origin instead of minting a second, plus a processor Idempotency-Key derived from ' +
      'the payment row and its attempt counter. A replay returns the SAME checkout URL rather ' +
      'than creating a second payable session.',
    requestSchema: 'PaymentIntentRequest',
    responseSchema: 'PaymentIntent',
    errors: [
      'VALIDATION_FAILED', 'BOOKING_NOT_FOUND', 'BOOKING_ACCESS_DENIED',
      'PAYMENT_ACTOR_NOT_PERMITTED', 'PAYMENT_STATE_CONFLICT', 'PAYMENT_PROCESSOR_UNAVAILABLE',
    ],
    params: [{ name: 'bookingId', type: 'integer', description: 'bookings.id' }],
    status: 'implemented',
    domainService: 'services/finance/bookingPaymentService.startPaymentIntent',
    legacy: [
      {
        method: 'post',
        path: '/api/:bookingId/paymongo/create',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'The live customer checkout call. Identical domain service — this entry adds the ' +
          'booking-scoped authorization and refuses a provider, which the legacy route does ' +
          'not do. Kept until Customer Web and Customer Mobile migrate.',
      },
    ],
    callers: { customerMobile: 'legacy', customerWeb: 'legacy', providerMobile: 'n/a', providerWeb: 'n/a', admin: 'planned' },
    observability: 'finance-payments',
    notes:
      'The return origin is chosen from a server-side allowlist, never from a caller-supplied ' +
      'string — a stored session encodes the URLs it was built with, so handing one back to a ' +
      'caller resolving to another origin would return the payer to a different application.',
  },
  {
    id: 'bookings.payments.get',
    domain: 'finance',
    method: 'get',
    path: '/bookings/:bookingId/payment',
    summary: "A booking's payment state and price breakdown, scoped to the caller's seat.",
    auth: 'authenticated',
    idempotent: true,
    responseSchema: 'BookingPayment',
    errors: ['VALIDATION_FAILED', 'BOOKING_NOT_FOUND', 'BOOKING_ACCESS_DENIED'],
    params: [{ name: 'bookingId', type: 'integer', description: 'bookings.id' }],
    status: 'implemented',
    domainService: 'services/finance/bookingPaymentService.getBookingPayment',
    legacy: [
      {
        method: 'get',
        path: '/api/admin/finance/ledger/booking/:bookingId',
        disposition: 'ROLE_SPECIFIC',
        note:
          'The admin revenue-recognition view over finance_ledger_entries. It answers a ' +
          'different question (what was recognised, when, by whom) and carries its own ' +
          'permission. Both now read the same underlying capture events.',
      },
    ],
    callers: { customerMobile: 'planned', customerWeb: 'planned', providerMobile: 'migrated', providerWeb: 'planned', admin: 'planned' },
    observability: 'finance-payments',
    notes:
      'One endpoint, three explicit DTOs. The provider is shown the gross their share is a ' +
      'percentage of and never the customer refund position or the processor reference; the ' +
      'customer is shown what they paid and never the provider share. The CALCULATION is the ' +
      'same object for all three, so no two seats can be told different totals.',
  },
  {
    id: 'bookings.refunds.create',
    domain: 'finance',
    method: 'post',
    path: '/bookings/:bookingId/refunds',
    summary: 'Requests a refund (customer) or issues one (admin).',
    auth: 'authenticated',
    idempotent: false,
    replayMechanism: ['arithmetic-ceiling', 'state-predicate'],
    replayGuard:
      'Eligibility is evaluated against captured-minus-already-refunded, so a second full ' +
      'refund computes a ceiling of zero and is refused by arithmetic. A customer repeat ' +
      'returns the SAME open review row rather than opening a second, and the admin path ' +
      'claims the payment row with a compare-and-swap to REFUNDING before calling the processor.',
    requestSchema: 'RefundRequest',
    responseSchema: 'RefundResult',
    errors: [
      'VALIDATION_FAILED', 'BOOKING_NOT_FOUND', 'BOOKING_ACCESS_DENIED', 'PAYMENT_NOT_FOUND',
      'PAYMENT_ACTOR_NOT_PERMITTED', 'REFUND_PAYMENT_NOT_CAPTURED', 'REFUND_ALREADY_SETTLED',
      'REFUND_IN_PROGRESS', 'REFUND_EXCEEDS_CAPTURED', 'REFUND_TRIGGER_INVALID',
      'REFUND_OUTCOME_NOT_REFUNDABLE',
    ],
    params: [{ name: 'bookingId', type: 'integer', description: 'bookings.id' }],
    status: 'implemented',
    domainService: 'services/finance/bookingPaymentService.refundBookingPayment',
    legacy: [
      {
        method: 'post',
        path: '/api/admin/finance/refunds',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'The admin portal opens refund reviews here today. Same table, same eligibility rule ' +
          'once migrated; this entry adds the customer-initiated path, which had no route at all.',
      },
    ],
    callers: { customerMobile: 'planned', customerWeb: 'planned', providerMobile: 'n/a', providerWeb: 'n/a', admin: 'legacy' },
    observability: 'finance-refunds',
    notes:
      'One rule, two outcomes. A customer REQUESTS (a review row, no processor call) and an ' +
      'admin ISSUES (money moves). Both run evaluateRefundEligibility first, so a request can ' +
      'never be accepted for a booking an issue would refuse.',
  },
  {
    id: 'provider.earnings.summary',
    domain: 'finance',
    method: 'get',
    path: '/provider/earnings/summary',
    summary: "The provider's own earnings totals, with pending split from failed and estimated.",
    auth: 'provider',
    capability: 'canViewEarnings',
    idempotent: true,
    responseSchema: 'ProviderEarningsSummary',
    errors: ['EARNINGS_RANGE_INVALID'],
    query: [
      { name: 'startDate', type: 'string', required: false, description: 'ISO date. Must be sent with endDate.' },
      { name: 'endDate', type: 'string', required: false, description: 'ISO date. Must be sent with startDate.' },
    ],
    status: 'implemented',
    domainService: 'services/finance/providerEarningsService.getEarningsSummary',
    legacy: [
      {
        method: 'get',
        path: '/api/provider/earnings/summary',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'The live provider portal call, now delegating to the same domain service so the two ' +
          'paths return identical figures during migration rather than merely similar ones.',
      },
    ],
    callers: { customerMobile: 'n/a', customerWeb: 'n/a', providerMobile: 'legacy', providerWeb: 'migrated', admin: 'n/a' },
    observability: 'finance-earnings',
    notes:
      'Totalled from the SAME per-booking calculator the transaction list uses, not from a ' +
      'parallel aggregate query. The previous aggregate drifted from the list in three ways ' +
      'before anyone noticed. An INTERNAL_FIXER receives zeroes and a withheldReason, never ' +
      'an estimate of money that will not arrive.',
  },
  {
    id: 'provider.earnings.transactions',
    domain: 'finance',
    method: 'get',
    path: '/provider/earnings/transactions',
    summary: "One row per completed job with its gross, the provider's share and its payout state.",
    auth: 'provider',
    capability: 'canViewEarnings',
    idempotent: true,
    responseSchema: 'ProviderEarningsTransactions',
    errors: ['EARNINGS_RANGE_INVALID'],
    query: [
      { name: 'startDate', type: 'string', required: false, description: 'ISO date. Must be sent with endDate.' },
      { name: 'endDate', type: 'string', required: false, description: 'ISO date. Must be sent with startDate.' },
    ],
    status: 'implemented',
    domainService: 'services/finance/providerEarningsService.listEarningsTransactions',
    legacy: [
      {
        method: 'get',
        path: '/api/provider/earnings',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'The live earnings list. Same domain service now; the v1 shape adds the economic ' +
          'model, the payout block reason and minor-unit amounts.',
      },
      {
        method: 'get',
        path: '/api/provider/ledger',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'A THIRD reading of the same columns, which used to hardcode every completed booking ' +
          'as "settled" and report failed payouts as money in hand. Superseded entirely.',
      },
      {
        method: 'get',
        path: '/api/workers/:uid/earnings-history',
        disposition: 'RETIRE',
        note:
          'Takes the provider uid from the URL and has no auth, so it answers for anybody. No ' +
          'located caller in any of the five clients. Carried over from the planned placeholder ' +
          'this entry replaces; delete once telemetry confirms zero traffic.',
      },
    ],
    callers: { customerMobile: 'n/a', customerWeb: 'n/a', providerMobile: 'legacy', providerWeb: 'migrated', admin: 'n/a' },
    observability: 'finance-earnings',
    notes:
      'The gross includes PAID additional work, which is charged through its own checkout and ' +
      'never written back to bookings.final_price — a reader treating final_price as the gross ' +
      'shows a booking amount the provider share is visibly not 80% of.',
  },
  {
    id: 'provider.earnings.payouts',
    domain: 'finance',
    method: 'get',
    path: '/provider/earnings/payouts',
    summary: "The provider's own payouts, with the 72-hour window's expected arrival date.",
    auth: 'provider',
    capability: 'canViewEarnings',
    idempotent: true,
    responseSchema: 'ProviderPayouts',
    errors: [],
    status: 'implemented',
    domainService: 'services/finance/providerEarningsService.listProviderPayouts',
    legacy: [
      {
        method: 'get',
        path: '/api/provider/payouts',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'The live payouts list, now delegating to the same domain service. Both exclude the ' +
          'processor id, servana_share, payout_error and the admin hold fields by projection.',
      },
    ],
    callers: { customerMobile: 'n/a', customerWeb: 'n/a', providerMobile: 'legacy', providerWeb: 'migrated', admin: 'n/a' },
    observability: 'finance-payouts',
    notes:
      'The expected arrival date is computed by the backend from the SAME constant the release ' +
      'scheduler uses. Provider Web previously recomputed it as 48 hours against a scheduler ' +
      'that releases at 72, telling providers their money was due a day early.',
  },
  {
    id: 'admin.finance.reconciliation',
    domain: 'finance',
    method: 'get',
    path: '/admin/finance/reconciliation',
    summary: 'Ledger reconciliation: every check, its open breaks, and the platform money totals.',
    auth: 'admin',
    permission: 'reconciliation.view',
    idempotent: true,
    responseSchema: 'FinanceReconciliation',
    errors: ['PERMISSION_REQUIRED'],
    query: [
      { name: 'status', type: 'string', required: false, description: "Exception status. Defaults to 'open'." },
      { name: 'severity', type: 'string', required: false, description: 'info | warning | critical.' },
      { name: 'limit', type: 'integer', required: false, description: 'Breaks returned. Max 200.' },
    ],
    status: 'implemented',
    domainService: 'services/finance/financeReconciliationService.getReconciliationReport',
    legacy: [
      {
        method: 'get',
        path: '/api/admin/finance/reconciliation/exceptions',
        disposition: 'ALIAS_TEMPORARILY',
        note:
          'The paged exception list the admin portal reads today. This entry adds the check ' +
          'catalog, the money totals and the outstanding provider liability, so an admin can ' +
          'see that the ledger balances rather than only that a page of rows exists.',
      },
    ],
    callers: { customerMobile: 'n/a', customerWeb: 'n/a', providerMobile: 'n/a', providerWeb: 'n/a', admin: 'legacy' },
    observability: 'finance-reconciliation',
    notes:
      'READ-ONLY. It does not run the checks — running them writes rows, and a GET that mutates ' +
      'is one somebody eventually puts behind a dashboard refresh timer. ' +
      'POST /api/admin/finance/reconciliation/run remains the way to produce a fresh set.',
  },
];

export const IMPLEMENTED = V1_CONTRACT.filter((e) => e.status === 'implemented');
export const PLANNED = V1_CONTRACT.filter((e) => e.status === 'planned');

export const contractById = (id: string): ContractEntry | undefined =>
  V1_CONTRACT.find((e) => e.id === id);

/** Full mounted path, e.g. `/api/v1/catalog/services/:serviceId`. */
export const fullPath = (entry: ContractEntry): string => `${V1_PREFIX}${entry.path}`;
