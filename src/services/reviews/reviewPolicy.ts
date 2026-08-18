/**
 * THE post-service trust declaration — one file, four consumers, no database.
 *
 *   1. `customerReviewService.ts` ENFORCES it.
 *   2. `postServiceSupportService.ts` ROUTES against it.
 *   3. `scripts/generate-review-docs.ts` EXECUTES it to write
 *      `REVIEWS_V1_CONTRACT.md`.
 *   4. `tests/review-*.test.ts` ASSERT against it.
 *
 * ## What already existed, and what this adds
 *
 * The review layer is substantial and mostly right: `customerReviewService`
 * already takes an advisory transaction lock, replays on `client_request_id`,
 * resolves the provider from the ASSIGNMENT rather than the payload, checks
 * completion and the review window, and refuses a second review. Moderation
 * states, publication states, provider responses, reports and a rating
 * aggregation service all exist.
 *
 * What was missing is a DECLARATION. The eligibility rules lived only as a
 * sequence of `if` statements inside one function, so no document could state
 * them, no test could assert them without driving a database, and the refusal
 * codes were strings at each throw site. This declares them once and the service
 * consults it.
 *
 * ## The defect this declaration exposed
 *
 * `getBookingForReview` resolved a booking's service through
 * `service_options.service_id` — which `catalogPublicService` documents, in its
 * own header, as "a foreign key to **service_families**". Meanwhile
 * `service_review_dimensions.service_id` REFERENCES `servana.services(id)`,
 * the Catalog V2 canonical specific-service identity.
 *
 * Two different id spaces. Service-specific review dimensions were being looked
 * up with a family id against a table keyed on a service id, so they silently
 * never matched and every review fell back to the global dimension set — and if
 * the two id ranges ever overlapped it would have matched the WRONG service's
 * dimensions. It is also exactly the constraint the command names: the family
 * must not become the canonical bookable identity again.
 *
 * `CANONICAL_SERVICE_RESOLUTION` below names the one correct helper.
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

/** Who is asking, relative to the review. A relationship, never a token claim. */
export type ReviewSeat = 'author' | 'provider' | 'public' | 'admin';

export const REVIEW_SEATS: readonly ReviewSeat[] = Object.freeze([
  'author',
  'provider',
  'public',
  'admin',
]);

// ─── Canonical identity (§121, §122) ──────────────────────────────────────────

/**
 * A review is grounded in a BOOKING, and everything else is derived from it.
 *
 * `providerUid` is never accepted from a caller. §122: "Do not accept arbitrary
 * providerId + rating as sufficient authority." The provider comes from the
 * COMPLETED assignment on the booking, so a customer cannot review somebody who
 * never worked their job, and cannot review a provider they have never booked at
 * all.
 */
export const REVIEW_IDENTITY = {
  groundedIn: 'bookings.id',
  authorFrom: 'bookings.user_id',
  providerFrom: 'booking_workers.worker_uid WHERE status = COMPLETED',
  serviceFrom: 'services.id (Catalog V2), via bookingCanonicalServiceSql',
  note:
    'The provider is NEVER taken from the request. A payload that names a provider is a ' +
    'caller asserting an authorization the booking has not granted.',
} as const;

/**
 * How a booking's canonical service id is resolved. THE helper, named once.
 *
 * `COALESCE(b.catalog_service_id, (SELECT cs.id FROM services cs WHERE
 * cs.legacy_service_option_id = b.service_option_id))`
 *
 * NOT `service_options.service_id`, which is a foreign key to
 * `service_families` — legacy coarse provenance, and a different id space from
 * the one `service_review_dimensions` is keyed on.
 */
export const CANONICAL_SERVICE_RESOLUTION = {
  helper: 'services/booking/eligibilityPipeline.bookingCanonicalServiceSql',
  resolvesTo: 'services.id',
  forbidden: 'service_options.service_id (a foreign key to service_families)',
  note:
    'Catalog V2 seeded services.id FROM service_options.id, so the identifier a customer ' +
    'already booked IS its canonical service id. The family id is a different number ' +
    'entirely, and using it to look up dimensions keyed on services.id means they never ' +
    'match — or match the wrong service.',
} as const;

// ─── Eligibility (§121) ───────────────────────────────────────────────────────

/**
 * Every reason a review may be refused, in a vocabulary a client can branch on.
 *
 * One code per distinguishable refusal, for the same reason every other domain
 * in this codebase has several: "you cannot review this" without saying which
 * rule refused leaves a client unable to tell the customer whether to wait, to
 * check a different booking, or that the window has closed for good.
 */
export const ELIGIBILITY_REFUSALS = {
  BOOKING_NOT_OWNED: {
    reason: 'The booking belongs to another account.',
    terminal: true,
    status: 403,
  },
  ACCOUNT_NOT_ELIGIBLE: {
    reason: 'The account is not an active customer account.',
    terminal: true,
    status: 403,
  },
  NO_ASSIGNED_PROVIDER: {
    reason: 'No provider completed this booking, so there is nobody to review.',
    terminal: true,
    status: 422,
  },
  BOOKING_NOT_COMPLETED: {
    reason: 'The booking has not been completed. A review is a statement about work done.',
    terminal: false,
    status: 422,
  },
  COMPLETION_NOT_FINALIZED: {
    reason: 'The completion carries no timestamp, so the review window cannot be computed.',
    terminal: false,
    status: 422,
  },
  REVIEW_WINDOW_CLOSED: {
    reason: 'The review window has closed.',
    terminal: true,
    status: 422,
  },
  REVIEW_ALREADY_EXISTS: {
    reason: 'This booking already has a review.',
    terminal: true,
    status: 409,
  },
} as const;

export type EligibilityRefusal = keyof typeof ELIGIBILITY_REFUSALS;

export const ELIGIBILITY_REFUSAL_CODES = Object.freeze(
  Object.keys(ELIGIBILITY_REFUSALS),
) as readonly EligibilityRefusal[];

/**
 * The review window, in days from completion.
 *
 * Bounded on purpose: a review written a year after the job is not a useful
 * signal about the provider's current work, and an unbounded window means a
 * provider can never be sure their rating has settled.
 */
export const REVIEW_WINDOW_DAYS = 14;

/**
 * How long an author may edit, in hours from creation.
 *
 * Short, because an edit changes a published statement about somebody else's
 * work and the rating it contributed to. `EDITED` is a publication state rather
 * than a silent overwrite, so the change is visible.
 */
export const EDIT_WINDOW_HOURS = 48;

export interface EligibilityInput {
  isOwner: boolean;
  isActiveCustomer: boolean;
  hasCompletedProvider: boolean;
  bookingCompleted: boolean;
  completedAt: string | null;
  hasExistingReview: boolean;
  now?: string;
}

export interface EligibilityVerdict {
  eligible: boolean;
  refusal: EligibilityRefusal | null;
  reason: string | null;
  status: number;
  /** When the window opens and closes, when it can be computed. */
  window: { opensAt: string; closesAt: string } | null;
}

/**
 * THE eligibility decision. Pure, so the generated contract can render the real
 * precedence and the tests can assert it without a database.
 *
 * ## Precedence matters
 *
 * Ownership is checked FIRST and answers the same way as a booking that does not
 * exist. A caller who can tell "not yours" from "no such booking" can enumerate
 * booking ids, and a booking id is a small integer.
 *
 * Completion is checked before the window, because "not finished yet" and "too
 * late" are opposite situations and a client showing the wrong one tells the
 * customer to give up when they should wait.
 */
export const evaluateEligibility = (input: EligibilityInput): EligibilityVerdict => {
  const refuse = (refusal: EligibilityRefusal, window: EligibilityVerdict['window'] = null): EligibilityVerdict => ({
    eligible: false,
    refusal,
    reason: ELIGIBILITY_REFUSALS[refusal].reason,
    status: ELIGIBILITY_REFUSALS[refusal].status,
    window,
  });

  if (!input.isOwner) return refuse('BOOKING_NOT_OWNED');
  if (!input.isActiveCustomer) return refuse('ACCOUNT_NOT_ELIGIBLE');
  if (!input.hasCompletedProvider) return refuse('NO_ASSIGNED_PROVIDER');
  if (!input.bookingCompleted) return refuse('BOOKING_NOT_COMPLETED');
  if (!input.completedAt) return refuse('COMPLETION_NOT_FINALIZED');

  const completed = new Date(input.completedAt);
  if (Number.isNaN(completed.getTime())) return refuse('COMPLETION_NOT_FINALIZED');

  const closes = new Date(completed.getTime() + REVIEW_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const window = { opensAt: completed.toISOString(), closesAt: closes.toISOString() };

  // The duplicate check comes AFTER the window is computed, so a caller who
  // already reviewed still learns when their window closed rather than being
  // told only that they are too late.
  if (input.hasExistingReview) return refuse('REVIEW_ALREADY_EXISTS', window);

  const now = input.now ? new Date(input.now) : new Date();
  if (now > closes) return refuse('REVIEW_WINDOW_CLOSED', window);

  return { eligible: true, refusal: null, reason: null, status: 200, window };
};

// ─── Dimensions (§123) ────────────────────────────────────────────────────────

/**
 * The canonical dimension vocabulary, and its version.
 *
 * Service-specific dimensions live in `service_review_dimensions`, keyed on
 * `services.id` and carrying a `policy_version`. When a service configures none,
 * this global set applies — which is the honest fallback, and is what makes a
 * newly-added service reviewable on the day it is created.
 *
 * The version is on the STORED review, not only on the configuration. A review
 * written under version 1 stays a version-1 review even after the vocabulary
 * moves, because re-interpreting an old rating under a new scale would silently
 * change what somebody said.
 */
export const DIMENSION_POLICY_VERSION = 1;

export const CANONICAL_DIMENSIONS = {
  SERVICE_QUALITY: 'The standard of the work itself.',
  PROFESSIONALISM: 'Conduct and courtesy.',
  PUNCTUALITY: 'Arrival and timekeeping against the agreed schedule.',
  COMMUNICATION: 'Clarity and responsiveness before and during the job.',
  CLEANLINESS: 'Care and cleanliness appropriate to the service.',
  SCOPE_ADHERENCE: 'Delivery of the confirmed service scope.',
} as const;

export type DimensionKey = keyof typeof CANONICAL_DIMENSIONS;

export const DIMENSION_KEYS = Object.freeze(
  Object.keys(CANONICAL_DIMENSIONS),
) as readonly DimensionKey[];

export const RATING_BOUNDS = { min: 1, max: 5 } as const;

export const CONTENT_LIMITS = {
  publicComment: 2000,
  privateFeedback: 2000,
  clientRequestId: 128,
} as const;

/**
 * Where each part of a review may be READ.
 *
 * `privateFeedback` is the one that matters: it is addressed to Servana, not to
 * the provider, and a customer who writes "the provider made me uncomfortable"
 * in it has not consented to that reaching them. It never appears in a provider
 * or public projection.
 */
export const FIELD_VISIBILITY: Readonly<Record<string, readonly ReviewSeat[]>> = Object.freeze({
  overallRating: Object.freeze(['author', 'provider', 'public', 'admin'] as ReviewSeat[]),
  dimensions: Object.freeze(['author', 'provider', 'public', 'admin'] as ReviewSeat[]),
  publicComment: Object.freeze(['author', 'provider', 'public', 'admin'] as ReviewSeat[]),
  privateFeedback: Object.freeze(['author', 'admin'] as ReviewSeat[]),
  authorName: Object.freeze(['author', 'admin'] as ReviewSeat[]),
  authorUid: Object.freeze(['author', 'admin'] as ReviewSeat[]),
  bookingId: Object.freeze(['author', 'admin'] as ReviewSeat[]),
  moderationState: Object.freeze(['admin'] as ReviewSeat[]),
  internalNotes: Object.freeze(['admin'] as ReviewSeat[]),
});

export const mayReadField = (field: string, seat: ReviewSeat): boolean =>
  (FIELD_VISIBILITY[field] ?? []).includes(seat);

/**
 * Never projected to ANY seat, including admin, from a review read.
 *
 * A reviewer's contact details and the booking's address are not part of a
 * review. An admin who needs them uses the booking, which authorizes and audits
 * separately — a review read is not a customer-record read.
 */
export const NEVER_PROJECTED: readonly string[] = Object.freeze([
  'customer_email',
  'customerEmail',
  'customer_phone',
  'customerPhone',
  'address_one',
  'addressOne',
  'password_hash',
  'fcm_token',
]);

// ─── Moderation (§125) ────────────────────────────────────────────────────────

/**
 * Moderation states and whether each contributes to the public rating.
 *
 * The aggregate is derived from this: a review hidden by moderation must stop
 * counting, and a restored one must start again. Deciding that per query is how
 * a provider's displayed rating comes to disagree with the reviews shown beneath
 * it.
 */
export const MODERATION_STATES = {
  NOT_REQUIRED: { publiclyVisible: true, countsToward: true, description: 'No moderation was needed.' },
  AUTOMATED_CHECKS_PASSED: { publiclyVisible: true, countsToward: true, description: 'Automated screening passed.' },
  PENDING_REVIEW: { publiclyVisible: false, countsToward: false, description: 'Held pending a human decision.' },
  APPROVED: { publiclyVisible: true, countsToward: true, description: 'A human approved it.' },
  REPORTED: { publiclyVisible: true, countsToward: true, description: 'Reported and not yet decided. Stays visible until it is.' },
  REJECTED: { publiclyVisible: false, countsToward: false, description: 'A human removed it from public view.' },
  RESTORED: { publiclyVisible: true, countsToward: true, description: 'Removed, then restored on appeal.' },
} as const;

export type ModerationState = keyof typeof MODERATION_STATES;

export const MODERATION_STATE_NAMES = Object.freeze(
  Object.keys(MODERATION_STATES),
) as readonly ModerationState[];

export const countsTowardRating = (state: string): boolean =>
  MODERATION_STATES[state as ModerationState]?.countsToward === true;

export const publiclyVisible = (state: string): boolean =>
  MODERATION_STATES[state as ModerationState]?.publiclyVisible === true;

/**
 * Moderation history is APPEND-ONLY and auditable.
 *
 * The release gate says moderation state must be auditable, and the reason is
 * concrete: a decision that changes what the public can see about a named person
 * has to be attributable afterwards. Overwriting a state loses who decided,
 * when, and on what grounds — and the appeal that follows has nothing to
 * examine.
 */
export const MODERATION_AUDIT = {
  table: 'servana.review_moderation_cases',
  appendOnly: true,
  records: Object.freeze([
    'the state before and after',
    'the effect on public visibility',
    'the deciding admin uid',
    'the decision timestamp',
    'the provider-facing reason code',
    'internal notes, which never leave the admin surface',
  ]),
  note:
    'A moderation change that alters public visibility is retained even when the review is ' +
    'later restored. The history is the evidence an appeal examines.',
} as const;

// ─── Rating summary (§124) ────────────────────────────────────────────────────

/**
 * The rating summary contract every seat consumes.
 *
 * ONE shape. Customer, Provider and Admin read the same fields from the same
 * service, so a provider cannot be shown a different average from the one a
 * customer sees on their card — which is the failure this gate names.
 */
export const RATING_SUMMARY_FIELDS: readonly string[] = Object.freeze([
  'providerUid',
  'averageRating',
  'reviewCount',
  'dimensionAverages',
  'policyVersion',
]);

/**
 * Below this many samples a dimension average is withheld rather than shown.
 *
 * Three reviews is not a measurement, and publishing one as "4.3 punctuality"
 * gives a number an authority it has not earned — and, on a small provider,
 * identifies who wrote it.
 */
export const MIN_DIMENSION_SAMPLE = 5;

export const RATING_AGGREGATION = {
  ownedBy: 'services/ratingAggregationService',
  derivedFrom: 'customer_reviews where the moderation state counts toward the rating',
  note:
    'BACKEND-derived, always. No client computes an average, and no endpoint accepts one - a ' +
    'rating a caller can set is a rating a caller can inflate.',
} as const;

// ─── Post-service support (§126) ──────────────────────────────────────────────

/**
 * Support-case categories for a completed booking, and where each one goes.
 *
 * The routing is the point. A billing dispute is a FINANCE operation with money
 * at stake, an eligibility rule and a processor call; handling it as a support
 * ticket would create a second refund path with weaker rules. So it is accepted
 * here and ROUTED, rather than either refused (which leaves the customer with
 * nowhere to click) or handled (which forks the refund logic).
 */
export const SUPPORT_CATEGORIES = {
  SERVICE_QUALITY: {
    description: 'The work was not to the expected standard.',
    routesTo: 'support',
    handler: 'the support case queue',
  },
  INCOMPLETE_WORK: {
    description: 'Part of the confirmed scope was not delivered.',
    routesTo: 'support',
    handler: 'the support case queue',
  },
  PROPERTY_DAMAGE: {
    description: 'Something was damaged during the job.',
    routesTo: 'support',
    handler: 'the support case queue, at elevated severity',
  },
  SAFETY_CONCERN: {
    description: 'A safety or conduct concern about the visit.',
    routesTo: 'support',
    handler: 'the support case queue, at elevated severity',
  },
  BILLING: {
    description: 'A charge is wrong, unexpected or disputed.',
    routesTo: 'finance',
    handler: 'the refund/dispute domain — POST /api/v1/bookings/:bookingId/refunds',
  },
} as const;

export type SupportCategory = keyof typeof SUPPORT_CATEGORIES;

export const SUPPORT_CATEGORY_NAMES = Object.freeze(
  Object.keys(SUPPORT_CATEGORIES),
) as readonly SupportCategory[];

export type SupportRoute = 'support' | 'finance';

export const routeForCategory = (category: string): SupportRoute | null =>
  (SUPPORT_CATEGORIES[category as SupportCategory]?.routesTo as SupportRoute) ?? null;

/**
 * Categories that raise a case at elevated severity.
 *
 * Damage and safety are not ordinary quality complaints: one has a financial
 * exposure and the other may involve somebody being unsafe in their own home.
 * Both need to reach a human sooner than "the provider was late" does.
 */
export const ELEVATED_CATEGORIES: readonly SupportCategory[] = Object.freeze([
  'PROPERTY_DAMAGE',
  'SAFETY_CONCERN',
]);

export const SUPPORT_CASE_LIMITS = {
  summary: 200,
  detail: 4000,
  /** Open cases per booking. A ceiling, not a feature. */
  maxOpenPerBooking: 3,
} as const;

// ─── Events (§127) ────────────────────────────────────────────────────────────

/**
 * The events this domain publishes, by the TAB 09 name.
 *
 * NOT redeclared here. `services/events/domainEvents.DOMAIN_EVENTS` owns the
 * registry, its payload contract and its projections — a second event catalog
 * for reviews is the duplication TAB 09 exists to prevent. This names which
 * events the review domain is the producer of, so the contract can state it
 * without owning it.
 */
export const REVIEW_EVENTS: readonly string[] = Object.freeze([
  'ReviewCreated',
]);

/**
 * `ReviewUpdated` is NOT published, and that is a decision rather than an
 * omission.
 *
 * An edit inside the 48-hour window changes a rating the provider may already
 * have been notified about. Notifying again on every edit would mean a provider
 * whose customer fixed a typo gets a second "new review" push — and suppressing
 * the notification while still publishing the event would put an event in the
 * registry that projects to nothing, which TAB 09's own test forbids.
 *
 * The rating aggregate IS recalculated on edit, so the number a provider sees is
 * correct; what is withheld is the interruption. Declaring an event for it is
 * queued behind a product decision about what a provider should be told when a
 * review changes.
 */
export const UNPUBLISHED_EVENTS = {
  ReviewUpdated:
    'Not published. An edit would re-notify a provider about a review they were already told ' +
    'about, and an event that projects to nothing is one TAB 09 refuses. The aggregate is ' +
    'still recalculated, so the displayed rating is correct.',
} as const;

// ─── Capabilities and the caller matrix ───────────────────────────────────────

export interface ReviewCapability {
  key: string;
  title: string;
  contractIds: readonly string[];
  domainModule: string;
  surfaces: readonly ClientSurface[];
  roleSplitRationale: string;
}

export const REVIEW_CAPABILITIES: readonly ReviewCapability[] = Object.freeze([
  {
    key: 'writeReview',
    title: 'Review a completed booking',
    contractIds: ['bookings.review.create'],
    domainModule: 'services/customerReviewService.createReview',
    surfaces: Object.freeze(['customerMobile', 'customerWeb'] as ClientSurface[]),
    roleSplitRationale:
      'No role split. Only the booking\'s customer may write, and that is not a role check - ' +
      'it is a relationship resolved from `bookings.user_id`. The provider is taken from the ' +
      'COMPLETED assignment, never from the payload, so there is no shape of request that ' +
      'reviews somebody the customer did not book.',
  },
  {
    key: 'readOwnReview',
    title: 'Read the review I wrote for a booking',
    contractIds: ['bookings.review.get'],
    domainModule: 'services/customerReviewService.getReviewByBooking',
    surfaces: Object.freeze(['customerMobile', 'customerWeb'] as ClientSurface[]),
    roleSplitRationale:
      'No role split. Scoped to the author, and it returns the private feedback the public ' +
      'projection never carries - which is the whole reason it is a separate read rather than ' +
      'a filter on the provider list.',
  },
  {
    key: 'providerReviews',
    title: "Read a provider's published reviews",
    contractIds: ['reviews.provider.list'],
    domainModule: 'services/customerReviewService.listProviderReviews',
    surfaces: Object.freeze([
      'customerMobile', 'customerWeb', 'providerMobile', 'providerWeb', 'admin',
    ] as ClientSurface[]),
    roleSplitRationale:
      'No role split on the shared list, and a genuinely different one for admin: ' +
      '`/admin/providers/:uid/reviews` carries moderation state, internal notes and rejected ' +
      'reviews, all behind a named permission. Same table, different question - and the public ' +
      'route cannot answer it because the projection does not carry those fields at all.',
  },
  {
    key: 'ratingSummary',
    title: "A provider's rating summary",
    contractIds: ['reviews.provider.rating'],
    domainModule: 'services/customerReviewService',
    surfaces: Object.freeze([
      'customerMobile', 'customerWeb', 'providerMobile', 'providerWeb', 'admin',
    ] as ClientSurface[]),
    roleSplitRationale:
      'No role split, and this is the gate: one summary service and one contract, so a ' +
      'provider cannot be shown a different average from the one on their own customer-facing ' +
      'card. Backend-derived throughout - no endpoint accepts a rating, because a rating a ' +
      'caller can set is one a caller can inflate.',
  },
  {
    key: 'postServiceSupport',
    title: 'Raise a support case about a completed booking',
    contractIds: ['bookings.supportCases.create'],
    domainModule: 'services/reviews/postServiceSupportService',
    surfaces: Object.freeze(['customerMobile', 'customerWeb'] as ClientSurface[]),
    roleSplitRationale:
      'No role split. Providers raise support cases through their own endpoint, which is a ' +
      'genuinely different operation: a provider case is about their account or a job they ' +
      'worked, and a customer case is about a booking they paid for. A BILLING category is ' +
      'ROUTED to the finance domain rather than handled here - handling it would fork the ' +
      'refund rules into a second, weaker path.',
  },
]);

export const REVIEW_CAPABILITY_KEYS: readonly string[] = Object.freeze(
  REVIEW_CAPABILITIES.map((c) => c.key),
);
