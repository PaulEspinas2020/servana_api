/**
 * THE cross-platform convergence declaration (TAB 13).
 *
 * Six domain tabs each built a capability registry — finance, experiences,
 * messaging, notifications, account, home, reviews — and each one answered the
 * centralization question for its own domain. None of them could answer it for
 * the API, because nothing joined them up and four domains never had a registry
 * at all: auth, catalog, search, and the booking core.
 *
 * This file is that join. It federates every existing registry, declares the
 * missing ones, and turns "similar features call the same canonical endpoint"
 * from a sentence in a document into a function that returns a verdict.
 *
 *   1. `scripts/generate-convergence-docs.ts` EXECUTES it to write the parity
 *      matrix, the canonical call manifest and the deprecation schedule.
 *   2. `tests/cross-platform-convergence.test.ts` ASSERTS against it.
 *   3. `tests/convergence-guard.test.ts` enforces §137 on new endpoints.
 *
 * ## What makes the role-split claim checkable
 *
 * Every contract entry names its `domainService`. So when Provider Mobile posts
 * to `/api/v1/provider/jobs/:id/accept` and Customer Web posts to
 * `/api/v1/bookings/:id/cancel` and Admin posts to
 * `/api/v1/admin/bookings/:id/assign`, the claim "these are one state machine
 * wearing three permissions" is not a promise — all three entries name
 * `services/booking/transitionExecutor.transitionBooking`, and
 * `convergenceOf()` reports SHARED_SERVICE because it compared the strings.
 *
 * A future entry that quietly forks the rules into `providerBookingService`
 * would change that verdict to DIVERGENT and fail the suite. That is the whole
 * mechanism.
 *
 * ## No database handle
 *
 * Same rule as every policy module since TAB 07: pure functions only, so the
 * generated documents are evidence rather than description and the CI check
 * runs without a database.
 */

import {
  V1_CONTRACT,
  V1_PREFIX,
  type ClientName,
  type ContractEntry,
  type Disposition,
  type LegacyMapping,
} from './contract';
import { RETIREMENT_CRITERIA } from './legacyTelemetry';

import { ACCOUNT_CAPABILITIES } from '../../services/account/accountPolicy';
import { EXPERIENCE_CAPABILITIES } from '../../services/booking/experiencePolicy';
import { NOTIFICATION_CAPABILITIES } from '../../services/events/domainEvents';
import { FINANCE_CAPABILITIES } from '../../services/finance/financePolicy';
import { HOME_CAPABILITIES } from '../../services/home/homePolicy';
import { MESSAGING_CAPABILITIES } from '../../services/messaging/messagingPolicy';
import { REVIEW_CAPABILITIES } from '../../services/reviews/reviewPolicy';

// ─── Surfaces ─────────────────────────────────────────────────────────────────

export type ClientSurface = ClientName;

export const CLIENT_SURFACES: readonly ClientSurface[] = Object.freeze([
  'customerMobile',
  'customerWeb',
  'providerMobile',
  'providerWeb',
  'admin',
]);

export const SURFACE_LABEL: Readonly<Record<ClientSurface, string>> = Object.freeze({
  customerMobile: 'Customer Mobile',
  customerWeb: 'Customer Web',
  providerMobile: 'Provider Mobile',
  providerWeb: 'Provider Web',
  admin: 'Admin Web',
});

/**
 * How each surface is corrected when a migration is wrong. This is the ordering
 * principle of the whole migration, so it is data rather than prose.
 *
 * A web client is a git push away from being fixed. A mobile client keeps
 * calling whatever the installed build knows about for as long as the customer
 * leaves the app installed, which is why the retirement window for a mobile
 * alias is measured in months of observed silence rather than in releases.
 */
export const SURFACE_CORRECTION_COST: Readonly<Record<ClientSurface, {
  /** Migration order. 1 moves first. Cheapest to correct, so cheapest to be wrong about. */
  order: number;
  cost: string;
  deploys: string;
  retirementDays: number;
}>> = Object.freeze({
  admin: { order: 1, cost: 'minutes', deploys: 'Netlify from git — the push is the deploy', retirementDays: RETIREMENT_CRITERIA.webZeroTrafficDays },
  providerWeb: { order: 2, cost: 'minutes', deploys: 'push to main is a production deploy', retirementDays: RETIREMENT_CRITERIA.webZeroTrafficDays },
  customerWeb: { order: 3, cost: 'hours', deploys: 'Angular, not yet deployed', retirementDays: RETIREMENT_CRITERIA.webZeroTrafficDays },
  providerMobile: { order: 4, cost: 'days–weeks', deploys: 'Play review, then the installed base updates', retirementDays: RETIREMENT_CRITERIA.mobileZeroTrafficDays },
  customerMobile: { order: 5, cost: 'days–weeks', deploys: 'Play review; the largest installed base', retirementDays: RETIREMENT_CRITERIA.mobileZeroTrafficDays },
});

/**
 * Whether a surface has actually shipped to real users.
 *
 * ## Why retirement needs this and `callers` cannot supply it
 *
 * `callers.<client>` is derived from that client's published manifest, which is
 * generated from that client's own source. It answers "does this client's CODE
 * call the canonical route?" — and that is the only question a client can
 * answer about itself.
 *
 * Retiring a legacy route asks a different question: "is anything in the FIELD
 * still calling it?" Those come apart precisely when a client has rewritten its
 * calls but not shipped them, and the party asserting the migration is then not
 * the party who knows what is installed. A client should not be able to license
 * the deletion of a route by publishing a manifest about its own unreleased
 * code.
 *
 * ## The measured case
 *
 * Landing the worker app's manifest moved 32 entries to
 * `providerMobile: 'migrated'` and, with nothing else changed, made **13 legacy
 * aliases retirable** — `GET /api/worker/job-cards`, the five job-transition
 * routes, the provider document routes. The client that licensed that is a
 * greenfield repository recorded in its own manifest as
 * `"local-only (no remote)"`, with no UI, no release, and its own certification
 * returning NOT_CERTIFIED. Meanwhile the ServanaWorker build those legacy routes
 * were written for publishes no manifest at all — which is exactly the case the
 * migration plan warns about: do not retire a route because no manifest lists
 * it, without checking the clients that publish none.
 *
 * So this is a platform fact, held here, and a manifest cannot assert it.
 */
export const SURFACE_RELEASED: Readonly<Record<ClientSurface, boolean>> = Object.freeze({
  admin: true,
  providerWeb: true,
  // Angular, never deployed — SURFACE_CORRECTION_COST says as much.
  customerWeb: false,
  // The greenfield worker app. Its manifest is real and its calls are real; it
  // has never been released, so it cannot speak for what is installed.
  providerMobile: false,
  customerMobile: true,
});

/** Surfaces in migration order: cheapest to correct first, mobile last. */
export const MIGRATION_ORDER: readonly ClientSurface[] = Object.freeze(
  [...CLIENT_SURFACES].sort(
    (a, b) => SURFACE_CORRECTION_COST[a].order - SURFACE_CORRECTION_COST[b].order,
  ),
);

// ─── The federated capability record ──────────────────────────────────────────

export interface CapabilityRecord {
  key: string;
  title: string;
  /** Which registry this came from, so a reader can go and edit the right one. */
  source: string;
  contractIds: readonly string[];
  /** The ONE domain module the capability's endpoints are expected to share. */
  domainModule: string;
  /** Surfaces that perform this business operation at all. */
  surfaces: readonly ClientSurface[];
  roleSplitRationale: string;
}

/** `ExperienceCapability` carries actors rather than surfaces. This maps them. */
const SURFACES_FOR_ACTOR: Readonly<Record<string, readonly ClientSurface[]>> = Object.freeze({
  customer: Object.freeze(['customerMobile', 'customerWeb'] as ClientSurface[]),
  assigned_provider: Object.freeze(['providerMobile', 'providerWeb'] as ClientSurface[]),
  admin: Object.freeze(['admin'] as ClientSurface[]),
});

const fromActors = (actors: readonly string[]): readonly ClientSurface[] => {
  const out = new Set<ClientSurface>();
  for (const actor of actors) {
    for (const surface of SURFACES_FOR_ACTOR[actor] ?? []) out.add(surface);
  }
  return CLIENT_SURFACES.filter((s) => out.has(s));
};

/**
 * The capabilities the domain tabs never declared, because those domains
 * predate the registry pattern.
 *
 * These are not new endpoints. Every `contractIds` entry below is already
 * mounted and tested; what was missing was the statement of WHICH capability it
 * serves and which surfaces perform it — without which no parity matrix can be
 * built and §137 has nothing to check a new endpoint against.
 */
export const CORE_CAPABILITIES: readonly CapabilityRecord[] = Object.freeze([
  {
    key: 'authCredentials',
    title: 'Register, sign in, and end a session',
    source: 'api/v1/convergence (core)',
    contractIds: ['auth.register', 'auth.login', 'auth.refresh', 'auth.logout'],
    domainModule: 'services/authSessionService',
    surfaces: CLIENT_SURFACES,
    roleSplitRationale:
      'No role split, and this is the one that matters most: all five surfaces post to the ' +
      'SAME /api/v1/auth/login. The role comes back in the session, it is not chosen by the ' +
      'endpoint. A provider-only login route would be a second credential path with its own ' +
      'lockout counter, and an attacker would use whichever one counted more slowly.',
  },
  {
    key: 'authRecovery',
    title: 'Recover an account and verify a contact',
    source: 'api/v1/convergence (core)',
    contractIds: [
      'auth.forgotPassword', 'auth.resetPassword',
      'auth.verifyEmail', 'auth.resendVerification', 'auth.verifyMobile',
    ],
    domainModule: 'services/auth + services/otpService',
    surfaces: CLIENT_SURFACES,
    roleSplitRationale:
      'No role split. Recovery answers identically whatever the account turns out to be — a ' +
      'route that behaved differently for a provider would tell an unauthenticated caller ' +
      'which addresses belong to providers.',
  },
  {
    key: 'catalogBrowse',
    title: 'Browse the service catalog',
    source: 'api/v1/convergence (core)',
    contractIds: [
      'catalog.browse', 'catalog.summary',
      'catalog.categories.list', 'catalog.categories.get', 'catalog.categories.subcategories',
      'catalog.subcategories.get', 'catalog.subcategories.services',
      'catalog.services.list', 'catalog.services.get',
    ],
    domainModule: 'services/catalogPublicService',
    surfaces: CLIENT_SURFACES,
    roleSplitRationale:
      'No role split. The catalog is public product data keyed on services.id — Catalog V2, ' +
      'category → subcategory → service. A provider browsing what they can apply for and a ' +
      'customer browsing what they can book are reading the same tree; a second projection ' +
      'would be the moment service_families crept back in as a parallel identity.',
  },
  {
    key: 'catalogSearch',
    title: 'Search services',
    source: 'api/v1/convergence (core)',
    contractIds: ['search.query', 'catalog.search'],
    domainModule: 'services/catalogSearchService.searchCatalog',
    surfaces: CLIENT_SURFACES,
    roleSplitRationale:
      'No role split. Two paths, ONE service: /api/v1/search is the top-level entry a client ' +
      'expects and /api/v1/catalog/search is its in-domain twin. Both delegate to the same ' +
      'function, which is what stops them ranking differently.',
  },
  {
    key: 'buildProvenance',
    title: 'Ask which commit is serving',
    source: 'api/v1/convergence (core)',
    contractIds: ['health.build'],
    domainModule: 'api/v1/domains/health.readBuildInfo',
    surfaces: CLIENT_SURFACES,
    roleSplitRationale:
      'No role split, and no role at all. The endpoint is public because a provenance check ' +
      'that needs a credential can only be run by somebody who already has one, which is the ' +
      'situation it exists to fix — a deploy whose migration step fails stops short of the PM2 ' +
      'restart, so the old code keeps serving and nothing outward says so. Every surface reads ' +
      'the same four fields from the same stamp; there is no projection to differ on.',
  },
  {
    key: 'clientRecall',
    title: 'Ask whether this client build may still run',
    source: 'api/v1/convergence (core)',
    contractIds: ['clientConfig.read'],
    domainModule: 'api/v1/domains/clientConfig.readClientConfig',
    surfaces: CLIENT_SURFACES,
    roleSplitRationale:
      'No role split, and no role at all — the caller is a BUILD, not a person. The endpoint ' +
      'is public because the client being recalled may be too old to authenticate, and a kill ' +
      'switch reachable only with a credential cannot kill the builds that most need it. ' +
      'Every surface reads the same floor from the same file and applies the same comparison; ' +
      'a per-surface answer would let two clients disagree about whether the same version is ' +
      'supported. The web surfaces are listed because they reload and so are never stranded — ' +
      'they may read it, and it will never block them.',
  },
  {
    key: 'bookingRead',
    title: 'Read a booking',
    source: 'api/v1/convergence (core)',
    contractIds: ['bookings.listMine', 'bookings.get', 'bookings.timeline', 'bookings.transitions'],
    domainModule: 'services/bookingService + services/bookingAccessService',
    surfaces: CLIENT_SURFACES,
    roleSplitRationale:
      'No role split on the READ. `bookings.get` is booking-scoped and authorizes through ' +
      '`bookingAccessService.assertBookingAccess`, so a customer, the assigned provider and ' +
      'an admin all reach it and the SAME function decides what each may see. The ' +
      'differences are projections of one canonical state (toCustomerProjection / ' +
      'toProviderProjection / toAdminProjection), not different truths.',
  },
  {
    key: 'bookingTransitions',
    title: 'Move a booking through its state machine',
    source: 'api/v1/convergence (core)',
    contractIds: [
      'provider.jobs.accept', 'provider.jobs.decline', 'provider.jobs.enroute',
      'provider.jobs.arrived', 'provider.jobs.start', 'provider.jobs.complete',
      'admin.bookings.assign', 'admin.bookings.reassign',
    ],
    domainModule: 'services/booking/transitionExecutor.transitionBooking',
    surfaces: Object.freeze(['providerMobile', 'providerWeb', 'admin'] as ClientSurface[]),
    roleSplitRationale:
      'ROLE-SPLIT, and deliberately so — but over ONE state machine. Eight endpoints across ' +
      'the /provider and /admin families all call `transitionExecutor.transitionBooking` with ' +
      'a different actor verb. The split is real because the AUTHORIZATION differs (a provider ' +
      'may accept a job assigned to them; an admin may assign one to somebody else) and ' +
      'because the actions are different verbs, not one verb behind two doors. What must never ' +
      'differ is the machine, and `convergenceOf` proves it does not by comparing the declared ' +
      'service. The customer side of the same machine is `experiencePolicy:cancel`, which spans ' +
      '/bookings and /provider over the same executor.',
  },
  {
    key: 'providerJobQueue',
    title: "A provider's own job queue",
    source: 'api/v1/convergence (core)',
    contractIds: ['provider.jobs.list', 'provider.jobs.get'],
    domainModule: 'services/technicianService',
    surfaces: Object.freeze(['providerMobile', 'providerWeb'] as ClientSurface[]),
    roleSplitRationale:
      'Genuinely role-specific. "The jobs assigned to me" has no customer equivalent: the ' +
      'query is scoped by worker uid, the card carries earnings and travel fields a customer ' +
      'must never see, and the customer-facing answer to "my bookings" is a different ' +
      'question over a different scope. It reads the same bookings and the same canonical ' +
      'state; it is a provider PROJECTION, not a provider truth.',
  },
  {
    key: 'adminBookingOps',
    title: 'Operate the booking queue',
    source: 'api/v1/convergence (core)',
    contractIds: ['admin.bookings.list', 'admin.bookings.assignmentCandidates'],
    domainModule: 'services/adminBookingService + services/providerEligibilityEngine',
    surfaces: Object.freeze(['admin'] as ClientSurface[]),
    roleSplitRationale:
      'Genuinely role-specific. Listing every booking on the platform and reading the ' +
      'eligible-provider pool are operator actions with no customer or provider equivalent, ' +
      'behind role 1. The ASSIGN action they lead to is not separate: it is in ' +
      '`bookingTransitions` above, over the shared state machine.',
  },
  {
    key: 'refundLifecycle',
    title: 'Resolve a refund review',
    source: 'api/v1/convergence (core)',
    contractIds: ['admin.refunds.markFailed'],
    domainModule: 'services/adminFinanceService',
    surfaces: Object.freeze(['admin'] as ClientSurface[]),
    roleSplitRationale:
      'Genuinely operator-only, and deliberately narrow for now. A customer requests a ' +
      'refund through the booking surface; deciding one is an operator action behind role 1 ' +
      'and a named permission. Only the `failed` terminal is canonical so far: the rest of ' +
      'the lifecycle (open, approve, reject, mark-processed) stays legacy until the ' +
      'disbursement surface is unified, because canonicalising a refund before its payout ' +
      'twin would fix the duplicate rather than remove it. `failed` came first because it ' +
      'did not exist at all — an approved refund the processor rejected had no terminal, so ' +
      'it stayed `approved` and blocked every retry for that booking.',
  },
  {
    key: 'providerPublicProfile',
    title: "Read a provider's public profile",
    source: 'api/v1/convergence (core)',
    contractIds: ['provider.publicProfile.get'],
    domainModule: 'services/account/providerProfileService',
    surfaces: CLIENT_SURFACES,
    roleSplitRationale:
      'No role split. One public projection, and the disclosure rules are the provider ' +
      'disclosure policy — not a per-caller decision made at the route.',
  },
  {
    key: 'bookingOtpStatus',
    title: 'Read booking-code state',
    source: 'api/v1/convergence (core)',
    contractIds: ['bookings.otp.status'],
    domainModule: 'services/booking/bookingOtpService.readCredentialState',
    surfaces: CLIENT_SURFACES,
    roleSplitRationale:
      'No role split. The booking-scoped read beside the OTP writes already declared in ' +
      'EXPERIENCE_CAPABILITIES, over the same service — so what a client is told about a code ' +
      'and what the verify endpoint will accept cannot disagree.',
  },
  {
    key: 'rescheduleHistory',
    title: 'Read the reschedule history of a booking',
    source: 'api/v1/convergence (core)',
    contractIds: ['bookings.reschedule.history'],
    domainModule: 'services/booking/bookingRescheduleService.listRescheduleRequests',
    surfaces: CLIENT_SURFACES,
    roleSplitRationale:
      'No role split. One booking-scoped read; the requesting and deciding endpoints beside it ' +
      'are in EXPERIENCE_CAPABILITIES over the same service.',
  },
  {
    key: 'postServiceSupportRead',
    title: 'Read the support cases I raised on a booking',
    source: 'api/v1/convergence (core)',
    contractIds: ['bookings.supportCases.list'],
    domainModule: 'services/reviews/postServiceSupportService',
    surfaces: Object.freeze(['customerMobile', 'customerWeb'] as ClientSurface[]),
    roleSplitRationale:
      'No role split. The read beside the TAB 12 write, owner-scoped in SQL and over the same ' +
      'service.',
  },
]);

/**
 * Every capability across every domain, normalized to one shape.
 *
 * Federated rather than copied: each domain registry stays the editable source
 * for its own domain, and this reads them. A capability declared twice would be
 * two places to change when a route moves.
 */
export const capabilityRegistry = (): CapabilityRecord[] => {
  const normalized: CapabilityRecord[] = [];

  const adopt = (source: string, caps: readonly any[]) => {
    for (const cap of caps) {
      normalized.push({
        key: `${source.split('/').pop()}:${cap.key}`,
        title: cap.title,
        source,
        contractIds: cap.contractIds,
        domainModule: cap.domainModule,
        surfaces: cap.surfaces ?? fromActors(cap.actors ?? []),
        roleSplitRationale: cap.roleSplitRationale,
      });
    }
  };

  adopt('services/account/accountPolicy', ACCOUNT_CAPABILITIES);
  adopt('services/booking/experiencePolicy', EXPERIENCE_CAPABILITIES);
  adopt('services/events/domainEvents', NOTIFICATION_CAPABILITIES);
  adopt('services/finance/financePolicy', FINANCE_CAPABILITIES);
  adopt('services/home/homePolicy', HOME_CAPABILITIES);
  adopt('services/messaging/messagingPolicy', MESSAGING_CAPABILITIES);
  adopt('services/reviews/reviewPolicy', REVIEW_CAPABILITIES);

  for (const cap of CORE_CAPABILITIES) {
    normalized.push({ ...cap, key: `core:${cap.key}` });
  }

  return normalized;
};

// ─── The convergence verdict ──────────────────────────────────────────────────

/**
 * Reduce a declared domain service to the MODULE it lives in.
 *
 * `transitionExecutor.transitionBooking (PROVIDER_ACCEPT)` and
 * `transitionExecutor.transitionBooking (CUSTOMER_CANCEL)` are the same machine
 * invoked with different verbs, and comparing the raw strings would call that a
 * divergence. Comparing the module says what is actually being asked: is there
 * one implementation behind these routes?
 */
export const domainServiceRoot = (declared: string): string =>
  declared
    .split(/\s*\+\s*/)[0]
    .replace(/\s*\(.*$/, '')
    .split('.')[0]
    .trim();

/**
 * Modules that are a decision layer over another module, not a second writer.
 *
 * Without this the shared-service check reads two module names and calls a
 * DELEGATION a fork. With it applied carelessly, the check would be a list of
 * excuses. So each entry names the file and the import that make it true, and
 * `tests/cross-platform-convergence.test.ts` reads those files and fails if the
 * delegation is not actually there — an exemption that stops being true stops
 * being granted.
 */
export const SERVICE_DELEGATIONS: readonly {
  from: string;
  to: string;
  evidenceFile: string;
  evidenceImport: string;
  why: string;
}[] = Object.freeze([
  {
    from: 'services/events/notificationPreferences',
    to: 'services/notificationService',
    evidenceFile: 'src/services/events/notificationPreferences.ts',
    evidenceImport: "from '../notification.service'",
    why:
      'TAB 09 added a DECISION layer — which categories exist, what the defaults are, whether a ' +
      'category may go out on a channel — over the existing store. It reads and writes through ' +
      '`getNotificationPrefs`/`saveNotificationPrefs` and touches no table itself, because two ' +
      'writers to one preference row is how a provider\'s saved choices get overwritten by a ' +
      'customer-shaped default map. So `/me/notification-preferences` and ' +
      '`/settings/notification-preferences` read ONE table through ONE writer.',
  },
]);

/** Collapse a service root onto the module it delegates to, if any. */
export const resolveDelegation = (root: string): string =>
  SERVICE_DELEGATIONS.find((d) => d.from === root)?.to ?? root;

export type ConvergenceVerdict =
  /** One canonical route family, every surface that needs it calls it. */
  | 'SHARED'
  /** Several route families by role, provably over ONE domain service. */
  | 'ROLE_SPLIT_SHARED_SERVICE'
  /** One surface performs this at all. Nothing to converge. */
  | 'SINGLE_SURFACE'
  /** Role-split route families that name DIFFERENT services. A forked truth. */
  | 'DIVERGENT'
  /** The capability names a contract id that does not exist. */
  | 'BROKEN';

export interface ConvergenceReport {
  capability: CapabilityRecord;
  verdict: ConvergenceVerdict;
  /** The shared module, when there is one. */
  sharedService: string | null;
  /** Every distinct declared service root, for a DIVERGENT explanation. */
  services: string[];
  entries: ContractEntry[];
  missingIds: string[];
  /** Distinct route families the capability spans, e.g. bookings + provider + admin. */
  routeFamilies: string[];
}

const routeFamilyOf = (path: string): string => {
  const head = path.split('/').filter(Boolean)[0] ?? '';
  return head.startsWith(':') ? '/' : `/${head}`;
};

export const convergenceOf = (capability: CapabilityRecord): ConvergenceReport => {
  const entries: ContractEntry[] = [];
  const missingIds: string[] = [];
  for (const id of capability.contractIds) {
    const entry = V1_CONTRACT.find((e) => e.id === id);
    if (entry) entries.push(entry);
    else missingIds.push(id);
  }

  const services = [
    ...new Set(entries.map((e) => resolveDelegation(domainServiceRoot(e.domainService)))),
  ].sort();
  const routeFamilies = [...new Set(entries.map((e) => routeFamilyOf(e.path)))].sort();
  const sharedService = services.length === 1 ? services[0] : null;

  /**
   * The shared-service rule applies to a ROLE SPLIT, which is what §131 is
   * about: the same business operation reached by different roles through
   * different route families must not fork the rules.
   *
   * A capability living in ONE route family whose endpoints name several
   * services is not a fork — it is ordinary composition. `bookings.get` reads
   * through `bookingAccessService` and `bookingService` because authorizing and
   * fetching are different jobs, and calling that a divergence would make the
   * check cry wolf until somebody turned it off.
   */
  const isRoleSplit = routeFamilies.length > 1;

  const verdict: ConvergenceVerdict = missingIds.length
    ? 'BROKEN'
    : capability.surfaces.length <= 1
      ? 'SINGLE_SURFACE'
      : isRoleSplit
        ? services.length > 1
          ? 'DIVERGENT'
          : 'ROLE_SPLIT_SHARED_SERVICE'
        : 'SHARED';

  return { capability, verdict, sharedService, services, entries, missingIds, routeFamilies };
};

/**
 * Capabilities whose declared `domainModule` names something none of their
 * endpoints actually use.
 *
 * ## Why this check exists
 *
 * `domainModule` says "the ONE domain module the capability's endpoints are
 * expected to share". It was declared by hand, published in the parity matrix
 * and the TAB 13 certification as a statement of architecture — and checked by
 * nothing. Five capabilities named a module no endpoint reached, including
 * `services/ratingAggregationService`, which exists but is not what the rating
 * endpoints call. A claim that is plausible, specific and unverified is worse
 * than no claim, because it reads as evidence.
 *
 * ## Containment, not equality
 *
 * Asserts declared ⊆ actual. A capability legitimately touches several services
 * — `bookings.get` authorises through one module and fetches through another —
 * so demanding equality would cry wolf about ordinary composition until someone
 * turned the check off. What must never happen is a declared module that no
 * endpoint reaches at all, which is the case that was silently true here.
 */
export interface DeclaredServiceDrift {
  capability: string;
  declared: string[];
  actual: string[];
  unreached: string[];
}

export const declaredServiceDrift = (): DeclaredServiceDrift[] => {
  const drift: DeclaredServiceDrift[] = [];
  for (const capability of capabilityRegistry()) {
    const report = convergenceOf(capability);
    if (report.verdict === 'BROKEN') continue;

    const declared = [
      ...new Set(
        capability.domainModule
          .split('+')
          .map((part) => resolveDelegation(domainServiceRoot(part.trim())))
          .filter(Boolean),
      ),
    ].sort();
    const actual = report.services.slice().sort();
    const unreached = declared.filter((module) => !actual.includes(module));
    if (unreached.length) {
      drift.push({ capability: capability.key, declared, actual, unreached });
    }
  }
  return drift;
};

// ─── Parity ───────────────────────────────────────────────────────────────────

export type ParityState = 'migrated' | 'legacy' | 'planned' | 'n/a' | 'mixed';

export interface ParityRow {
  capability: CapabilityRecord;
  verdict: ConvergenceVerdict;
  canonicalPaths: string[];
  /** Legacy paths any surface still calls for this capability. */
  legacyPaths: string[];
  surfaces: Record<ClientSurface, ParityState>;
}

/**
 * What each surface does about this capability TODAY.
 *
 * `mixed` is a real answer and not a rounding error: a client that has migrated
 * three of a capability's five endpoints is neither migrated nor legacy, and
 * reporting it as either would make the matrix lie in the direction of whoever
 * wrote it.
 */
export const parityRow = (capability: CapabilityRecord): ParityRow => {
  const report = convergenceOf(capability);

  const surfaces = {} as Record<ClientSurface, ParityState>;
  for (const surface of CLIENT_SURFACES) {
    if (!capability.surfaces.includes(surface)) {
      surfaces[surface] = 'n/a';
      continue;
    }
    const states = new Set(report.entries.map((e) => e.callers[surface]));
    states.delete('n/a');
    if (states.size === 0) surfaces[surface] = 'n/a';
    else if (states.size === 1) surfaces[surface] = [...states][0] as ParityState;
    else surfaces[surface] = 'mixed';
  }

  return {
    capability,
    verdict: report.verdict,
    canonicalPaths: report.entries.map((e) => `${e.method.toUpperCase()} ${V1_PREFIX}${e.path}`),
    legacyPaths: [
      ...new Set(
        report.entries.flatMap((e) =>
          e.legacy
            .filter((l) => l.disposition === 'ALIAS_TEMPORARILY' || l.disposition === 'CANONICALIZE')
            .map((l) => `${l.method.toUpperCase()} ${l.path}`),
        ),
      ),
    ].sort(),
    surfaces,
  };
};

// ─── The canonical call manifest (§133, §138) ─────────────────────────────────

export interface ManifestEntry {
  id: string;
  domain: string;
  capability: string | null;
  method: string;
  path: string;
  auth: string;
  idempotent: boolean;
  domainService: string;
  responseSchema: string;
  surfaces: ClientSurface[];
  callers: Record<ClientSurface, string>;
  supersedes: string[];
}

/**
 * The machine-readable list of every canonical call a client may make.
 *
 * This is the artifact a client team diffs their own call sites against, and
 * the one §138's check compares the OpenAPI document to. It carries only
 * MOUNTED endpoints: a planned entry is documentation, and a client generating
 * a typed client from it would ship calls to a 404.
 */
export const canonicalManifest = (): ManifestEntry[] => {
  const registry = capabilityRegistry();
  const capabilityOf = (id: string): string | null =>
    registry.find((c) => c.contractIds.includes(id))?.key ?? null;

  return V1_CONTRACT.filter((e) => e.status === 'implemented')
    .map((e) => ({
      id: e.id,
      domain: e.domain,
      capability: capabilityOf(e.id),
      method: e.method.toUpperCase(),
      path: `${V1_PREFIX}${e.path}`,
      auth: e.auth,
      idempotent: e.idempotent,
      domainService: e.domainService,
      responseSchema: e.responseSchema,
      surfaces: CLIENT_SURFACES.filter((s) => e.callers[s] !== 'n/a'),
      callers: Object.fromEntries(
        CLIENT_SURFACES.map((s) => [s, e.callers[s]]),
      ) as Record<ClientSurface, string>,
      supersedes: e.legacy.map((l) => `${l.method.toUpperCase()} ${l.path}`),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
};

// ─── Deprecation (§136, §139) ─────────────────────────────────────────────────

export interface DeprecationRow {
  legacy: LegacyMapping;
  canonical: ContractEntry;
  /** Surfaces still recorded as calling a legacy route for this capability. */
  blockingSurfaces: ClientSurface[];
  /** The longest retirement window any blocking surface imposes. */
  earliestWindowDays: number;
  /** Everything that must become true first. Empty means it is retirable. */
  blockedBy: string[];
  retirable: boolean;
}

/**
 * What has to be true before each alias is deleted, computed rather than
 * promised.
 *
 * "We think nobody calls it" is how a path a shipped build depends on gets
 * removed. Every row here names the specific reason it is not retirable yet,
 * and an empty `blockedBy` is the only thing that authorizes deletion — with
 * the observed-traffic window still to run on top.
 */
export const deprecationPlan = (): DeprecationRow[] => {
  const rows: DeprecationRow[] = [];

  for (const entry of V1_CONTRACT) {
    for (const legacy of entry.legacy) {
      if (legacy.disposition === 'KEEP' || legacy.disposition === 'ROLE_SPECIFIC') continue;

      const blockingSurfaces = CLIENT_SURFACES.filter(
        (s) => entry.callers[s] === 'legacy' || entry.callers[s] === 'planned',
      );

      const blockedBy: string[] = [];
      if (RETIREMENT_CRITERIA.requireCanonicalImplemented && entry.status !== 'implemented') {
        blockedBy.push(`the canonical successor \`${entry.id}\` is not mounted yet`);
      }
      if (RETIREMENT_CRITERIA.requireAllCallersMigrated && blockingSurfaces.length) {
        blockedBy.push(
          `${blockingSurfaces.map((s) => SURFACE_LABEL[s]).join(', ')} ` +
            `${blockingSurfaces.length === 1 ? 'has' : 'have'} not migrated`,
        );
      }

      /**
       * A `migrated` mark from a surface that has never shipped does not clear
       * the route for retirement — see SURFACE_RELEASED. The code has moved; the
       * installed base has not, because there is no installed base yet, and the
       * previous build of that client is still whatever it was.
       *
       * Separate from the check above on purpose: "has not migrated" and "has
       * migrated but has not shipped" are different states needing different
       * work, and collapsing them would tell a client team to redo a migration
       * they have already done.
       */
      const unreleasedMigrated = CLIENT_SURFACES.filter(
        (s) => entry.callers[s] === 'migrated' && !SURFACE_RELEASED[s],
      );
      if (unreleasedMigrated.length) {
        blockedBy.push(
          `${unreleasedMigrated.map((s) => SURFACE_LABEL[s]).join(', ')} ` +
            `${unreleasedMigrated.length === 1 ? 'has' : 'have'} migrated in code but ` +
            'not shipped, so nothing yet proves the legacy path is unused in the field',
        );
      }
      if (legacy.disposition === 'CANONICALIZE') {
        blockedBy.push('marked CANONICALIZE — this path is still the canonical one for its callers');
      }

      const earliestWindowDays = blockingSurfaces.length
        ? Math.max(...blockingSurfaces.map((s) => SURFACE_CORRECTION_COST[s].retirementDays))
        : RETIREMENT_CRITERIA.webZeroTrafficDays;

      rows.push({
        legacy,
        canonical: entry,
        blockingSurfaces,
        earliestWindowDays,
        blockedBy,
        retirable: blockedBy.length === 0,
      });
    }
  }

  return rows.sort((a, b) => a.legacy.path.localeCompare(b.legacy.path));
};

// ─── The architecture-review rule (§137) ──────────────────────────────────────

/**
 * The permanent rule the command asks for, written as something enforceable.
 *
 * A rule in a wiki is a rule that is followed until the week somebody is busy.
 * `tests/convergence-guard.test.ts` runs these checks over the whole contract on
 * every CI run, so a new single-client endpoint beside an existing shared one
 * fails the build and arrives at review by itself.
 */
export const ARCHITECTURE_REVIEW_RULE = {
  statement:
    'No new endpoint may be added for a single client if an equivalent shared domain endpoint ' +
    'exists, without architecture review.',
  enforcedBy: 'tests/convergence-guard.test.ts',
  checks: Object.freeze([
    'Every implemented contract entry is claimed by exactly one capability.',
    'A capability serving one surface must carry a roleSplitRationale that says why.',
    'Endpoints of one capability must name ONE domain service module.',
    'Two capabilities must not name the same contract id.',
    'A new route family for an existing capability must be a role split, never a second service.',
  ]),
  exemptionProcess:
    'Add the endpoint to a capability in the owning domain policy, or declare a new capability ' +
    'with a roleSplitRationale naming the authorization, action or payload difference that ' +
    'justifies it. Both are code changes and both arrive at review.',
} as const;

/** Contract ids claimed by no capability. The §137 check, as data. */
export const unclaimedEntries = (): ContractEntry[] => {
  const claimed = new Set(capabilityRegistry().flatMap((c) => c.contractIds));
  return V1_CONTRACT.filter((e) => !claimed.has(e.id));
};

/** Contract ids claimed by more than one capability. */
export const doubleClaimedIds = (): Array<{ id: string; capabilities: string[] }> => {
  const byId = new Map<string, string[]>();
  for (const cap of capabilityRegistry()) {
    for (const id of cap.contractIds) {
      byId.set(id, [...(byId.get(id) ?? []), cap.key]);
    }
  }
  return [...byId.entries()]
    .filter(([, caps]) => caps.length > 1)
    .map(([id, capabilities]) => ({ id, capabilities }));
};

// ─── Convergence summary ──────────────────────────────────────────────────────

export interface ConvergenceSummary {
  capabilities: number;
  implementedEndpoints: number;
  plannedEndpoints: number;
  legacyMappings: number;
  byVerdict: Record<ConvergenceVerdict, number>;
  /** Surfaces × capabilities that still read `legacy`. */
  legacyCallerCells: number;
  migratedCallerCells: number;
  retirableAliases: number;
  blockedAliases: number;
}

export const convergenceSummary = (): ConvergenceSummary => {
  const registry = capabilityRegistry();
  const byVerdict = {
    SHARED: 0, ROLE_SPLIT_SHARED_SERVICE: 0, SINGLE_SURFACE: 0, DIVERGENT: 0, BROKEN: 0,
  } as Record<ConvergenceVerdict, number>;

  let legacyCallerCells = 0;
  let migratedCallerCells = 0;
  for (const cap of registry) {
    const row = parityRow(cap);
    byVerdict[row.verdict] += 1;
    for (const surface of CLIENT_SURFACES) {
      if (row.surfaces[surface] === 'legacy' || row.surfaces[surface] === 'mixed') legacyCallerCells += 1;
      if (row.surfaces[surface] === 'migrated') migratedCallerCells += 1;
    }
  }

  const plan = deprecationPlan();

  return {
    capabilities: registry.length,
    implementedEndpoints: V1_CONTRACT.filter((e) => e.status === 'implemented').length,
    plannedEndpoints: V1_CONTRACT.filter((e) => e.status === 'planned').length,
    legacyMappings: V1_CONTRACT.reduce((n, e) => n + e.legacy.length, 0),
    byVerdict,
    legacyCallerCells,
    migratedCallerCells,
    retirableAliases: plan.filter((r) => r.retirable).length,
    blockedAliases: plan.filter((r) => !r.retirable).length,
  };
};

/** Dispositions grouped, for the schedule's summary line. */
export const dispositionCounts = (): Record<Disposition, number> => {
  const counts = {
    KEEP: 0, ALIAS_TEMPORARILY: 0, CANONICALIZE: 0, ROLE_SPECIFIC: 0, RETIRE: 0,
  } as Record<Disposition, number>;
  for (const entry of V1_CONTRACT) {
    for (const legacy of entry.legacy) counts[legacy.disposition] += 1;
  }
  return counts;
};
