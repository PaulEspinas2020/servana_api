/**
 * Writes the generated TAB 12 document.
 *
 *   docs/reviews/REVIEWS_V1_CONTRACT.md
 *
 * Run: npm run review:docs        (rewrite)
 *      npm run review:docs:check  (fail if the committed file is stale)
 *
 * ## Why this is GENERATED
 *
 * The dangerous table here is the ELIGIBILITY one. A document that says "a review
 * needs a completed booking" while the code also requires an assignment, a
 * timestamp and a window is a document a client team builds the wrong error
 * screens from — and the mismatch is invisible from reading either file.
 *
 * So the eligibility table is produced by RUNNING `evaluateEligibility` over
 * inputs that differ in one field each, and printing what it actually returned.
 * The refusal precedence in section 2 is not a description of the function; it is
 * the function's output. Same for the moderation/rating table, which is
 * `countsTowardRating` and `publiclyVisible` executed over every declared state.
 */

import fs from 'fs';
import path from 'path';

import {
  CANONICAL_DIMENSIONS,
  CANONICAL_SERVICE_RESOLUTION,
  CLIENT_SURFACES,
  CONTENT_LIMITS,
  DIMENSION_KEYS,
  DIMENSION_POLICY_VERSION,
  EDIT_WINDOW_HOURS,
  ELEVATED_CATEGORIES,
  ELIGIBILITY_REFUSALS,
  ELIGIBILITY_REFUSAL_CODES,
  FIELD_VISIBILITY,
  MIN_DIMENSION_SAMPLE,
  MODERATION_AUDIT,
  MODERATION_STATES,
  MODERATION_STATE_NAMES,
  NEVER_PROJECTED,
  RATING_AGGREGATION,
  RATING_BOUNDS,
  REVIEW_CAPABILITIES,
  REVIEW_EVENTS,
  REVIEW_IDENTITY,
  REVIEW_SEATS,
  REVIEW_WINDOW_DAYS,
  SUPPORT_CASE_LIMITS,
  SUPPORT_CATEGORIES,
  SUPPORT_CATEGORY_NAMES,
  UNPUBLISHED_EVENTS,
  evaluateEligibility,
  mayReadField,
  type ClientSurface,
  type EligibilityInput,
} from '../src/services/reviews/reviewPolicy';
import { V1_CONTRACT, V1_PREFIX, type ContractEntry } from '../src/api/v1/contract';

const OUT_DIR = path.resolve(__dirname, '..', 'docs', 'reviews');

const HEADER = `<!--
  GENERATED FILE - do not edit by hand.
  Source: scripts/generate-review-docs.ts, derived from
    src/services/reviews/reviewPolicy.ts               (eligibility, visibility, moderation, support)
    src/services/customerReviewService.ts              (the write path)
    src/services/ratingAggregationService.ts           (the aggregate)
    src/services/reviews/postServiceSupportService.ts  (post-service cases)
    src/api/v1/contract.ts                             (the canonical endpoints)
  Regenerate: npm run review:docs
-->

# Reviews v1 Contract
`;

const SURFACE_LABEL: Record<ClientSurface, string> = {
  customerMobile: 'Customer Mobile',
  customerWeb: 'Customer Web',
  providerMobile: 'Provider Mobile',
  providerWeb: 'Provider Web',
  admin: 'Admin Web',
};

// ─── 1. Identity ──────────────────────────────────────────────────────────────

function identitySection(): string {
  return `## 1. What a review is grounded in

| Part | Resolved from |
| --- | --- |
| The review | \`${REVIEW_IDENTITY.groundedIn}\` |
| The author | \`${REVIEW_IDENTITY.authorFrom}\` |
| The provider | \`${REVIEW_IDENTITY.providerFrom}\` |
| The service | \`${REVIEW_IDENTITY.serviceFrom}\` |

${REVIEW_IDENTITY.note}

There is no \`providerId\` field on the create payload. That is not a validation
rule that could be relaxed later — it is the absence of a field, so a caller has
nothing to send and the handler has nothing to trust.

### The canonical service id

- helper: \`${CANONICAL_SERVICE_RESOLUTION.helper}\`
- resolves to: \`${CANONICAL_SERVICE_RESOLUTION.resolvesTo}\`
- **never**: \`${CANONICAL_SERVICE_RESOLUTION.forbidden}\`

${CANONICAL_SERVICE_RESOLUTION.note}

This tab CORRECTED a live defect here. The booking's service was resolved through
\`service_options.service_id\` — a family id — and looked up against
\`service_review_dimensions\`, which is keyed on \`services.id\`. Two id spaces, so
service-specific dimensions silently never matched and every review fell back to the
global set. The fix is a query change; no schema change and no backfill, because
reviews do not store a service id of their own.
`;
}

// ─── 2. Eligibility ───────────────────────────────────────────────────────────

/** One eligible baseline, then one field spoiled at a time. EVIDENCE, not prose. */
const BASELINE: EligibilityInput = {
  isOwner: true,
  isActiveCustomer: true,
  hasCompletedProvider: true,
  bookingCompleted: true,
  completedAt: '2026-08-01T00:00:00.000Z',
  hasExistingReview: false,
  now: '2026-08-02T00:00:00.000Z',
};

const SCENARIOS: Array<{ label: string; input: EligibilityInput }> = [
  { label: 'everything in order', input: BASELINE },
  { label: 'the booking belongs to someone else', input: { ...BASELINE, isOwner: false } },
  { label: 'the account is not an active customer', input: { ...BASELINE, isActiveCustomer: false } },
  { label: 'nobody completed the booking', input: { ...BASELINE, hasCompletedProvider: false } },
  { label: 'the booking has not been completed', input: { ...BASELINE, bookingCompleted: false } },
  { label: 'the completion carries no timestamp', input: { ...BASELINE, completedAt: null } },
  { label: 'a review already exists', input: { ...BASELINE, hasExistingReview: true } },
  { label: `more than ${REVIEW_WINDOW_DAYS} days after completion`, input: { ...BASELINE, now: '2026-09-01T00:00:00.000Z' } },
  {
    label: 'not the owner AND everything else also wrong',
    input: {
      isOwner: false,
      isActiveCustomer: false,
      hasCompletedProvider: false,
      bookingCompleted: false,
      completedAt: null,
      hasExistingReview: true,
    },
  },
];

function eligibilitySection(): string {
  const rows = SCENARIOS.map(({ label, input }) => {
    const verdict = evaluateEligibility(input);
    return `| ${label} | ${verdict.eligible ? '**yes**' : 'no'} | ${
      verdict.refusal ? `\`${verdict.refusal}\`` : '—'
    } | ${verdict.status} | ${verdict.window ? 'yes' : 'no'} |`;
  }).join('\n');

  const refusals = ELIGIBILITY_REFUSAL_CODES.map((code) => {
    const spec = ELIGIBILITY_REFUSALS[code];
    return `| \`${code}\` | ${spec.status} | ${spec.terminal ? 'terminal' : 'retryable'} | ${spec.reason} |`;
  }).join('\n');

  return `## 2. Eligibility

A review always references an ELIGIBLE booking. The table below is produced by
running \`evaluateEligibility\` over one baseline with a single field changed each
time, and printing what it returned.

| Situation | Eligible | Refusal | HTTP | Window reported |
| --- | --- | --- | --- | --- |
${rows}

The last row is the one that matters for privacy. When everything is wrong at once
the answer is \`BOOKING_NOT_OWNED\` and **no window** — ownership is checked first, so a
caller cannot learn whether somebody else's booking exists, was completed, or was
already reviewed. A booking id is a small integer, and a service that answers
differently for a real one is an enumeration oracle.

### Every refusal

| Code | HTTP | Kind | Reason |
| --- | --- | --- | --- |
${refusals}

\`terminal\` means waiting will not help. The distinction is the difference between a
client telling a customer "come back when the job is finished" and "this can no
longer be reviewed" — showing the wrong one is the failure this vocabulary exists to
prevent.

### The window

- opens at completion, closes **${REVIEW_WINDOW_DAYS} days** later
- an author may edit for **${EDIT_WINDOW_HOURS} hours** after writing

Bounded on purpose. A review written a year later is not a signal about the
provider's current work, and an unbounded window means a provider's rating can never
settle. The edit window is short because an edit changes a published statement about
somebody else's work — and it is recorded as \`EDITED\` rather than applied silently.

### One booking, one review

Enforced in three places, deliberately:

1. an advisory transaction lock on \`review:{customerUid}:{bookingId}\`, so two
   devices submitting at once serialise rather than both passing the check;
2. the existing-review check runs INSIDE that transaction, on the same connection;
3. \`clientRequestId\` replays the original review rather than writing a second.

A check taken before the lock is a check two concurrent submissions both pass.
`;
}

// ─── 3. Content ───────────────────────────────────────────────────────────────

function contentSection(): string {
  const dims = DIMENSION_KEYS.map(
    (key) => `| \`${key}\` | ${CANONICAL_DIMENSIONS[key]} |`,
  ).join('\n');

  return `## 3. What a review carries

Overall rating: **${RATING_BOUNDS.min}–${RATING_BOUNDS.max}**, integer. Dimension scores use the same scale.

| Limit | Characters |
| --- | --- |
| \`publicComment\` | ${CONTENT_LIMITS.publicComment} |
| \`privateFeedback\` | ${CONTENT_LIMITS.privateFeedback} |
| \`clientRequestId\` | ${CONTENT_LIMITS.clientRequestId} |

### The canonical dimensions (policy version ${DIMENSION_POLICY_VERSION})

Service-specific dimensions live in \`service_review_dimensions\`, keyed on
\`services.id\`. When a service configures none, this global set applies — which is
what makes a service reviewable on the day it is created.

| Key | Meaning |
| --- | --- |
${dims}

The policy version is stored on the REVIEW, not only on the configuration. A review
written under version ${DIMENSION_POLICY_VERSION} stays a version-${DIMENSION_POLICY_VERSION} review after the vocabulary moves,
because re-interpreting an old rating under a new scale silently changes what
somebody said.
`;
}

// ─── 4. Visibility ────────────────────────────────────────────────────────────

function visibilitySection(): string {
  const head = `| Field | ${REVIEW_SEATS.join(' | ')} |`;
  const divider = `| --- | ${REVIEW_SEATS.map(() => '---').join(' | ')} |`;
  const rows = Object.keys(FIELD_VISIBILITY)
    .map((field) => {
      const cells = REVIEW_SEATS.map((seat) => (mayReadField(field, seat) ? 'read' : '—'));
      return `| \`${field}\` | ${cells.join(' | ')} |`;
    })
    .join('\n');

  return `## 4. Who may read what

Produced by running \`mayReadField\` for every declared field against every seat.

${head}
${divider}
${rows}

A **seat** is a relationship to the review, not a role claim on a token: the author
is \`customer_reviews.customer_uid\`, the provider is the one the review is about, and
\`public\` is everybody else.

\`privateFeedback\` is the load-bearing row. It is addressed to Servana, not to the
provider — a customer who writes "he made me uncomfortable" there has not consented
to that reaching him. It appears in the author's own read and nowhere else.

\`bookingId\` is withheld from the public and from the provider for a quieter reason:
a booking id with a provider and a date is enough to work out who was at which
address on which day.

### Projected to nobody, including admin

${NEVER_PROJECTED.map((f) => `\`${f}\``).join(', ')}

An admin who needs a customer's contact details reads the CUSTOMER record, which
authorizes and audits separately. A review read is not a customer-record read, and
letting it become one is how a support tool turns into a directory.
`;
}

// ─── 5. Moderation and the rating ─────────────────────────────────────────────

function moderationSection(): string {
  const rows = MODERATION_STATE_NAMES.map((state) => {
    const spec = MODERATION_STATES[state];
    return `| \`${state}\` | ${spec.publiclyVisible ? 'visible' : 'hidden'} | ${
      spec.countsToward ? 'counts' : 'excluded'
    } | ${spec.description} |`;
  }).join('\n');

  return `## 5. Moderation, and what counts toward the rating

| State | Public | Rating | Meaning |
| --- | --- | --- | --- |
${rows}

The invariant, asserted in \`tests/review-eligibility.test.ts\`: **no state is hidden
and counted**. A review the public cannot see that still moves the average is a
provider's displayed rating disagreeing with the reviews shown beneath it, and no
support agent can explain the difference.

\`REPORTED\` stays visible and keeps counting. Hiding on report would make the report
button a censorship button — one complaint from a competitor would remove a review
before anybody looked at it.

### The audit

\`${MODERATION_AUDIT.table}\`, append-only. Each entry records:

${MODERATION_AUDIT.records.map((r) => `- ${r}`).join('\n')}

${MODERATION_AUDIT.note}

### The rating summary

Owned by \`${RATING_AGGREGATION.ownedBy}\`, derived from ${RATING_AGGREGATION.derivedFrom}.

${RATING_AGGREGATION.note}

One shape, read by every seat, so a provider cannot be shown a different average from
the one on their own customer-facing card.

A dimension average is withheld below **${MIN_DIMENSION_SAMPLE} samples** and the response says
\`lowVolume\` rather than hiding the number entirely. A provider with no reviews gets
\`averageRating: null\` and an explanation — never \`0.0\`, which reads as "rated badly"
rather than "not yet rated".
`;
}

// ─── 6. Support ───────────────────────────────────────────────────────────────

function supportSection(): string {
  const rows = SUPPORT_CATEGORY_NAMES.map((name) => {
    const spec = SUPPORT_CATEGORIES[name];
    const severity = ELEVATED_CATEGORIES.includes(name) ? '**elevated**' : 'normal';
    return `| \`${name}\` | ${spec.routesTo} | ${severity} | ${spec.description} |`;
  }).join('\n');

  return `## 6. Post-service support

A case is attached to a CONCLUDED booking — \`COMPLETED\`, \`REVIEWED\` or \`CANCELLED\`.
A complaint about a booking that has not happened is not a post-service case; it is a
cancellation or a schedule question, and both have their own paths.

| Category | Routed to | Severity | Meaning |
| --- | --- | --- | --- |
${rows}

**\`BILLING\` is stored here and RESOLVED elsewhere.** ${SUPPORT_CATEGORIES.BILLING.handler}.
Handling it here would mean a second refund path with its own eligibility rules beside
the one \`bookingPaymentService\` enforces, and a refund granted under different rules
from the ones reconciliation checks is a break nobody can close. Refusing it outright
would be worse in the other direction: the customer has a real problem and no button.
So the case is created, marked \`routedTo: "finance"\`, and the response names the
endpoint that actually issues refunds. This table never moves money.

Damage and safety are raised at elevated severity: one has financial exposure and the
other may involve somebody being unsafe in their own home. Both need a human sooner
than "the provider was late" does.

| Bound | Value |
| --- | --- |
| Summary | ${SUPPORT_CASE_LIMITS.summary} characters |
| Detail | ${SUPPORT_CASE_LIMITS.detail} characters |
| Open cases per booking | ${SUPPORT_CASE_LIMITS.maxOpenPerBooking} |

The ceiling counts OPEN cases only, so resolving one frees a slot, and it is per
booking rather than per customer — a cap on how much trouble one customer is allowed
to have would be the wrong instrument.

The free-text \`detail\` is stored for a human handler and is **never projected back**.
It can carry anything the customer typed, including other people's names and what
happened inside their home.
`;
}

// ─── 7. Events ────────────────────────────────────────────────────────────────

function eventSection(): string {
  return `## 7. Events

Published by this domain, using the TAB 09 registry rather than a second catalog:

${REVIEW_EVENTS.map((e) => `- \`${e}\``).join('\n')}

The event is published INSIDE the review's transaction, through the outbox, so a
review that exists always has its event and a rolled-back review has neither.

### Deliberately not published

${Object.entries(UNPUBLISHED_EVENTS)
  .map(([name, why]) => `**\`${name}\`** — ${why}`)
  .join('\n\n')}
`;
}

// ─── 8. Endpoints ─────────────────────────────────────────────────────────────

function endpointSection(): string {
  const entries = V1_CONTRACT.filter((e) => e.domain === 'reviews');
  const rows = entries
    .map(
      (e: ContractEntry) =>
        `| \`${e.method.toUpperCase()} ${V1_PREFIX}${e.path}\` | ${e.auth} | \`${e.domainService}\` |`,
    )
    .join('\n');

  const legacy = entries
    .flatMap((e) => e.legacy.map((l) => ({ entry: e, legacy: l })))
    .map(
      ({ entry, legacy: l }) =>
        `| \`${l.method.toUpperCase()} ${l.path}\` | ${l.disposition} | \`${entry.id}\` | ${l.note} |`,
    )
    .join('\n');

  return `## 8. Canonical endpoints

| Endpoint | Auth | Domain service |
| --- | --- | --- |
${rows}

\`GET ${V1_PREFIX}/bookings/:bookingId/review\` returns \`{ review, eligibility }\` together.
A client that must ask "may I review this?" and "did I already?" in two calls will
render a review button from a stale answer to the first.

### Naming

The command names \`/providers/:providerId/reviews\` and \`/rating-summary\`. The
canonical routes are \`${V1_PREFIX}/reviews/providers/:providerUid\` and
\`.../rating\`, which SHIPPED in TAB 01 and which client surfaces already call. They
are the same resources under a path that groups by domain rather than by subject;
renaming them now would break migrated callers to gain nothing, so they are reused
rather than duplicated under a second path.

### Legacy routes, aliased

| Route | Disposition | Canonical entry | Why |
| --- | --- | --- | --- |
${legacy}
`;
}

// ─── 9. Caller matrix ─────────────────────────────────────────────────────────

function callerMatrixSection(): string {
  const head = `| Capability | ${CLIENT_SURFACES.map((s) => SURFACE_LABEL[s]).join(' | ')} |`;
  const divider = `| --- | ${CLIENT_SURFACES.map(() => '---').join(' | ')} |`;

  const rows = REVIEW_CAPABILITIES.map((capability) => {
    const cells = CLIENT_SURFACES.map((surface) => {
      if (!capability.surfaces.includes(surface)) return '—';
      const states = capability.contractIds
        .map((id) => V1_CONTRACT.find((e) => e.id === id)?.callers[surface])
        .filter(Boolean);
      if (!states.length) return '·';
      if (states.every((s) => s === 'migrated')) return 'migrated';
      if (states.some((s) => s === 'legacy')) return 'legacy';
      if (states.every((s) => s === 'n/a')) return '—';
      return 'planned';
    });
    return `| ${capability.title} | ${cells.join(' | ')} |`;
  }).join('\n');

  const rationale = REVIEW_CAPABILITIES.map(
    (c) => `**${c.title}** (\`${c.domainModule}\`)\n\n${c.roleSplitRationale}`,
  ).join('\n\n');

  return `## 9. Cross-platform caller matrix

\`migrated\` — this client calls the canonical v1 route today.
\`legacy\` — this client calls a legacy route the canonical entry supersedes.
\`planned\` — this client will migrate; it calls no equivalent today.
\`—\` — the capability does not apply to this client.

${head}
${divider}
${rows}

### Why each capability is or is not role-split

${rationale}
`;
}

// ─── Composition ──────────────────────────────────────────────────────────────

export function reviewContractDoc(): string {
  return [
    HEADER,
    '> Post-service trust: reviews, provider rating projections and support cases,',
    '> all grounded in a completed canonical booking. The eligibility, visibility and',
    '> moderation tables are produced by RUNNING the real decision functions, so they',
    '> are evidence rather than description.',
    '',
    identitySection(),
    eligibilitySection(),
    contentSection(),
    visibilitySection(),
    moderationSection(),
    supportSection(),
    eventSection(),
    endpointSection(),
    callerMatrixSection(),
  ].join('\n');
}

export function generateAll(): Array<{ relPath: string; content: string }> {
  return [{ relPath: 'docs/reviews/REVIEWS_V1_CONTRACT.md', content: reviewContractDoc() }];
}

/** Compares generated content with what is on disk. Newline-normalised for Windows checkouts. */
export function staleFiles(): string[] {
  const repoRoot = path.resolve(__dirname, '..');
  const stale: string[] = [];
  for (const file of generateAll()) {
    const abs = path.join(repoRoot, file.relPath);
    if (!fs.existsSync(abs)) {
      stale.push(file.relPath);
      continue;
    }
    const onDisk = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
    if (onDisk !== file.content.replace(/\r\n/g, '\n')) stale.push(file.relPath);
  }
  return stale;
}

if (require.main === module) {
  if (process.argv.includes('--check')) {
    const stale = staleFiles();
    if (stale.length) {
      console.error(`Review docs are stale — run "npm run review:docs":\n  ${stale.join('\n  ')}`);
      process.exitCode = 1;
    } else {
      console.log('Review docs are up to date.');
    }
  } else {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    for (const file of generateAll()) {
      const abs = path.resolve(__dirname, '..', file.relPath);
      fs.writeFileSync(abs, file.content, 'utf8');
      console.log(`wrote ${file.relPath}`);
    }
  }
}
