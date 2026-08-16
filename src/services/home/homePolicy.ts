/**
 * THE home composition declaration — one file, four consumers, no database.
 *
 *   1. `homeService.ts` COMPOSES against it.
 *   2. `api/v1/domains/home.ts` reads its cache and shape rules.
 *   3. `scripts/generate-home-docs.ts` EXECUTES it to write `HOME_V1_CONTRACT.md`.
 *   4. `tests/home-*.test.ts` ASSERT against it.
 *
 * ## What the homepage is, and what it must never become
 *
 * A READ MODEL. It aggregates and it owns nothing. Every card it emits is a
 * REFERENCE — a canonical `services.id` from Catalog V2, a canonical
 * `bookings.id` with the canonical state the booking read model derives, a
 * notification count from the one inbox — and the homepage is forbidden from
 * having an opinion about any of them.
 *
 * The failure this exists to prevent is specific and common: a home endpoint
 * grows a `HomeServiceCard` with its own price field, then a
 * `HomeBookingStatus` enum with four values because the real one has eleven, and
 * within two releases the homepage is a third source of truth that disagrees
 * with the catalog on a Tuesday. `SECTION_TYPES` below therefore declares, per
 * section, WHICH canonical service owns the data — and
 * `tests/home-composition.test.ts` asserts every emitted reference resolves.
 *
 * ## Two sections that own nothing because nothing exists yet
 *
 * `banners` and `featuredServices` have no curation source in this database.
 * There is no promotions table and no featured flag. The command is explicit
 * that the homepage must not own promotion truth, so:
 *
 *   - `banners` is declared and serves EMPTY, with the reason on the wire.
 *   - `featuredServices` reuses the catalog's OWN existing curation signal —
 *     `display_order`, which admins already set — rather than inventing a flag.
 *
 * Declaring them empty rather than omitting them is deliberate: a client can
 * build the surface once, and the day a promotions source exists the section
 * fills in without a client release.
 *
 * Nothing here imports anything with a database handle. Every decision function
 * is pure, so the generated contract is evidence rather than description.
 */

// ─── Client surfaces ──────────────────────────────────────────────────────────

export type ClientSurface =
  | 'customerMobile'
  | 'customerWeb'
  | 'providerMobile'
  | 'providerWeb'
  | 'admin';

export const CLIENT_SURFACES: readonly ClientSurface[] = Object.freeze([
  'customerMobile',
  'customerWeb',
  'providerMobile',
  'providerWeb',
  'admin',
]);

// ─── Section registry (§114) ──────────────────────────────────────────────────

/**
 * Whether a section's content depends on WHO is asking.
 *
 * This is the axis that decides caching, and getting it wrong is how one
 * customer's active booking ends up in another customer's response. `public`
 * sections are identical for every caller and may be cached shared; `personal`
 * sections are account-scoped and must never be.
 */
export type SectionAudience = 'public' | 'personal';

/**
 * What a section does when it cannot be built.
 *
 * `optional` — the homepage renders without it. §117: one failed section must
 *   not blank the page.
 * `required` — its failure fails the request. Reserved for sections whose
 *   absence would make the response misleading rather than merely emptier.
 *
 * Nothing is `required` today, and that is the correct default: every section on
 * this page is additive to a page that is still usable without it.
 */
export type SectionFailureMode = 'optional' | 'required';

export interface SectionSpec {
  /** The stable wire name. Append-only; never renamed. */
  type: string;
  audience: SectionAudience;
  failureMode: SectionFailureMode;
  /** WHICH canonical service owns this data. The homepage owns none of it. */
  ownedBy: string;
  /** The canonical id each item in this section carries. */
  referenceId: string | null;
  /** Seconds. 0 means never cache. */
  ttlSeconds: number;
  /** Hard ceiling on items. A bounded payload is a release gate. */
  maxItems: number;
  description: string;
}

/**
 * The seven declared sections.
 *
 * Order is the DEFAULT render order. A client may reorder; the point of
 * declaring one is that two clients showing the same page in different orders is
 * a product inconsistency nobody chose.
 */
export const SECTION_TYPES = {
  categories: {
    type: 'categories',
    audience: 'public',
    failureMode: 'optional',
    ownedBy: 'services/catalogPublicService.listCategories',
    referenceId: 'catalog_categories.id',
    // Long: the category list changes when an admin edits the catalog, which is
    // rare, and a stale category for five minutes costs nothing.
    ttlSeconds: 300,
    maxItems: 24,
    description: 'The Catalog V2 top level. Category → subcategory → service.',
  },
  featuredServices: {
    type: 'featuredServices',
    audience: 'public',
    failureMode: 'optional',
    ownedBy: 'services/catalogPublicService.listPublicServices',
    referenceId: 'services.id',
    ttlSeconds: 300,
    maxItems: 10,
    description:
      'Curated by the catalog\'s OWN display_order, which admins already set. No featured ' +
      'flag is invented: a second curation signal beside display_order would be a second ' +
      'thing to keep in step.',
  },
  popularServices: {
    type: 'popularServices',
    audience: 'public',
    failureMode: 'optional',
    ownedBy: 'services/home/homeService.popularServices (derived from completed bookings)',
    referenceId: 'services.id',
    // Shorter than the catalog: popularity moves with real bookings, and an
    // hour-old ranking is a page recommending what nobody is booking now.
    ttlSeconds: 900,
    maxItems: 10,
    description:
      'Ranked by completed booking count, resolved through the canonical ' +
      '`bookingCanonicalServiceSql` so the ranking keys on services.id and never on a ' +
      'legacy option id or a service family.',
  },
  recentServices: {
    type: 'recentServices',
    audience: 'personal',
    failureMode: 'optional',
    ownedBy: 'services/home/homeService.recentServices (this account\'s own bookings)',
    referenceId: 'services.id',
    ttlSeconds: 0,
    maxItems: 6,
    description: "Services this customer has booked before, most recent first. Account-scoped.",
  },
  activeBooking: {
    type: 'activeBooking',
    audience: 'personal',
    failureMode: 'optional',
    ownedBy: 'services/booking/projections.toCustomerProjection',
    referenceId: 'bookings.id',
    ttlSeconds: 0,
    maxItems: 3,
    description:
      'In-flight bookings with the CANONICAL state, projected by the booking read model. ' +
      'The homepage declares no status vocabulary of its own.',
  },
  banners: {
    type: 'banners',
    audience: 'public',
    failureMode: 'optional',
    ownedBy: 'nothing yet — no promotion source exists in this database',
    referenceId: null,
    ttlSeconds: 300,
    maxItems: 5,
    description:
      'Declared and EMPTY. There is no promotions table, and the command forbids the ' +
      'homepage owning promotion truth — so inventing one here would be the violation, not ' +
      'the fix. The section exists so a client builds the surface once and it fills in the ' +
      'day a promotion source is built.',
  },
  notificationSummary: {
    type: 'notificationSummary',
    audience: 'personal',
    failureMode: 'optional',
    ownedBy: 'services/events/notificationInbox.countUnread',
    referenceId: null,
    ttlSeconds: 0,
    maxItems: 1,
    description:
      'The unread badge, from the ONE inbox TAB 09 built. Not a second count computed here.',
  },
} as const satisfies Record<string, SectionSpec>;

export type SectionType = keyof typeof SECTION_TYPES;

export const SECTION_TYPE_NAMES = Object.freeze(
  Object.keys(SECTION_TYPES),
) as readonly SectionType[];

export const PUBLIC_SECTIONS: readonly SectionType[] = Object.freeze(
  SECTION_TYPE_NAMES.filter((name) => SECTION_TYPES[name].audience === 'public'),
);

export const PERSONAL_SECTIONS: readonly SectionType[] = Object.freeze(
  SECTION_TYPE_NAMES.filter((name) => SECTION_TYPES[name].audience === 'personal'),
);

export const isSectionType = (value: unknown): value is SectionType =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(SECTION_TYPES, value);

// ─── Caching (§115, §116) ─────────────────────────────────────────────────────

/**
 * The response cache header.
 *
 * The rule that matters: a response containing ANY personal section is
 * `private, no-store`, whatever the individual TTLs say. A shared cache holding
 * one customer's active booking and serving it to the next request is the exact
 * leak §115 forbids, and it is a leak the server cannot observe once a proxy is
 * involved.
 *
 * So the decision is taken from the SECTIONS PRESENT, not from the endpoint.
 * Asking for only public sections yields a cacheable response; asking for the
 * default set does not.
 */
export const cacheControlFor = (sections: readonly SectionType[]): string => {
  const hasPersonal = sections.some((s) => SECTION_TYPES[s]?.audience === 'personal');
  if (hasPersonal) return 'private, no-store';

  // The shortest TTL among the requested public sections. A response is only as
  // fresh as its stalest part, and taking the maximum would serve a 15-minute
  // popularity ranking under a 5-minute promise.
  const ttls = sections
    .map((s) => SECTION_TYPES[s]?.ttlSeconds ?? 0)
    .filter((t) => t > 0);
  if (!ttls.length) return 'private, no-store';
  return `public, max-age=${Math.min(...ttls)}`;
};

/**
 * One request instead of a dozen (§116).
 *
 * The whole reason this endpoint exists: the customer app assembles home from
 * three or four serial calls on launch, each with its own round trip on a
 * Philippine mobile network. Every section is composed in PARALLEL server-side,
 * so the page costs one round trip and the slowest section rather than the sum.
 */
export const COMPOSITION_STRATEGY = {
  parallel: true,
  note:
    'Sections are composed with Promise.allSettled. One request, and the latency is the ' +
    'slowest section rather than the sum of all of them.',
} as const;

// ─── Payload budget (§119) ────────────────────────────────────────────────────

/**
 * The bounded-payload gate, as numbers something can check.
 *
 * `maxItems` per section is the real bound; the byte ceiling is the backstop
 * that catches a section whose ITEMS grew rather than whose count did. Both are
 * asserted in `tests/home-performance.test.ts` against a composed response
 * rather than estimated.
 */
export const PAYLOAD_BUDGET = {
  /** Total items across every section. */
  maxTotalItems: SECTION_TYPE_NAMES.reduce((sum, name) => sum + SECTION_TYPES[name].maxItems, 0),
  /** Serialized bytes. Generous, and still a ceiling. */
  maxBytes: 64 * 1024,
  /** Composition must not fan out unboundedly. */
  maxQueriesPerRequest: 12,
  note:
    'A homepage that grows without a ceiling is one that gets slower every release and ' +
    'nobody notices which change did it.',
} as const;

// ─── Partial failure (§117) ───────────────────────────────────────────────────

export type SectionStatus = 'ok' | 'unavailable';

export interface SectionEnvelope<T> {
  type: SectionType;
  status: SectionStatus;
  /** Present when ok. Empty array/null when unavailable — never absent. */
  items: T[];
  /** Present when unavailable. A CODE, never an exception message. */
  reason: string | null;
  ttlSeconds: number;
}

/**
 * Why a section is empty, in a vocabulary a client can branch on.
 *
 * `EMPTY` and `UNAVAILABLE` are different facts and a client should render them
 * differently: an empty recents list is a new customer, and an unavailable one
 * is a backend that failed. Collapsing them means showing "no recent services"
 * to somebody who has ten.
 */
export const SECTION_REASONS = {
  EMPTY: 'The section built successfully and has nothing in it.',
  UNAVAILABLE: 'The section could not be built. The rest of the page is unaffected.',
  NOT_CONFIGURED: 'No source is configured for this section yet.',
  REQUIRES_AUTH: 'The section is account-scoped and the caller is anonymous.',
} as const;

export type SectionReason = keyof typeof SECTION_REASONS;

/**
 * Whether a failed section should fail the whole request.
 *
 * Always false today, because nothing is `required`. Written as a function
 * rather than a constant so that adding a required section is a declaration
 * change rather than an edit to the composition loop.
 */
export const failsRequest = (section: SectionType): boolean =>
  (SECTION_TYPES[section]?.failureMode as SectionFailureMode) === 'required';

// ─── Deep links (§118) ────────────────────────────────────────────────────────

/**
 * Homepage deep links reuse the TAB 09 target vocabulary.
 *
 * They are NOT redeclared here. `services/events/domainEvents.DEEP_LINK_TARGETS`
 * already declares one target per destination keyed on a canonical id, with a
 * projection per client and an authorization-after-navigation rule — and a
 * second deep-link vocabulary for the homepage is precisely the duplication this
 * tab exists to avoid.
 *
 * This names which targets the homepage emits, so the contract can be checked
 * without the homepage owning the definition.
 */
export const HOME_DEEP_LINK_TARGETS: readonly string[] = Object.freeze([
  'BOOKING_DETAIL',
  'NOTIFICATIONS',
]);

/**
 * A service card's destination is the SERVICE, addressed canonically.
 *
 * Not a deep-link target from the TAB 09 catalog, because that catalog is about
 * notifications navigating to a resource. A card carries `serviceId` and the
 * hierarchy context, and the client routes on it — which is what §112 asks for
 * and is more stable than any route name either side could invent.
 */
export const SERVICE_CARD_REFERENCE = {
  idField: 'serviceId',
  idSource: 'services.id',
  hierarchy: ['categoryId', 'categoryName', 'subcategoryId', 'subcategoryName'],
  forbidden: ['serviceFamilyId', 'service_family_id', 'serviceOptionId'],
  note:
    'Catalog V2 is certified with services.id as the canonical specific-service identity. ' +
    'A card keyed on a family or a legacy option id is how the family becomes the bookable ' +
    'identity again.',
} as const;

// ─── Capabilities and the caller matrix ───────────────────────────────────────

export interface HomeCapability {
  key: string;
  title: string;
  contractIds: readonly string[];
  domainModule: string;
  surfaces: readonly ClientSurface[];
  roleSplitRationale: string;
}

export const HOME_CAPABILITIES: readonly HomeCapability[] = Object.freeze([
  {
    key: 'homeFeed',
    title: 'The composed home surface',
    contractIds: ['home.feed'],
    domainModule: 'services/home/homeService',
    surfaces: Object.freeze(['customerMobile', 'customerWeb'] as ClientSurface[]),
    roleSplitRationale:
      'No role split, and no client split — which IS the capability. Customer Web and ' +
      'Customer Mobile receive the identical section set and the identical DTOs from one ' +
      'composition, so "equivalent shared content" is a property of there being one ' +
      'endpoint rather than two implementations kept in step. Providers have a dashboard ' +
      'with genuinely different content and their own endpoint; folding both into one ' +
      'surface would give the response a role branch and two meanings.',
  },
  {
    key: 'homeSections',
    title: 'Which sections exist and what owns each',
    contractIds: ['home.sections'],
    domainModule: 'services/home/homeService',
    surfaces: Object.freeze([
      'customerMobile', 'customerWeb', 'admin',
    ] as ClientSurface[]),
    roleSplitRationale:
      'No role split. The registry is metadata about the page, not content: it says which ' +
      'section types exist, what owns each and how long each may be cached. A client uses it ' +
      'to render unknown sections safely; an admin uses it to see what home is made of ' +
      'without reading the source.',
  },
]);

export const HOME_CAPABILITY_KEYS: readonly string[] = Object.freeze(
  HOME_CAPABILITIES.map((c) => c.key),
);
