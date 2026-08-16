<!--
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

> Post-service trust: reviews, provider rating projections and support cases,
> all grounded in a completed canonical booking. The eligibility, visibility and
> moderation tables are produced by RUNNING the real decision functions, so they
> are evidence rather than description.

## 1. What a review is grounded in

| Part | Resolved from |
| --- | --- |
| The review | `bookings.id` |
| The author | `bookings.user_id` |
| The provider | `booking_workers.worker_uid WHERE status = COMPLETED` |
| The service | `services.id (Catalog V2), via bookingCanonicalServiceSql` |

The provider is NEVER taken from the request. A payload that names a provider is a caller asserting an authorization the booking has not granted.

There is no `providerId` field on the create payload. That is not a validation
rule that could be relaxed later — it is the absence of a field, so a caller has
nothing to send and the handler has nothing to trust.

### The canonical service id

- helper: `services/booking/eligibilityPipeline.bookingCanonicalServiceSql`
- resolves to: `services.id`
- **never**: `service_options.service_id (a foreign key to service_families)`

Catalog V2 seeded services.id FROM service_options.id, so the identifier a customer already booked IS its canonical service id. The family id is a different number entirely, and using it to look up dimensions keyed on services.id means they never match — or match the wrong service.

This tab CORRECTED a live defect here. The booking's service was resolved through
`service_options.service_id` — a family id — and looked up against
`service_review_dimensions`, which is keyed on `services.id`. Two id spaces, so
service-specific dimensions silently never matched and every review fell back to the
global set. The fix is a query change; no schema change and no backfill, because
reviews do not store a service id of their own.

## 2. Eligibility

A review always references an ELIGIBLE booking. The table below is produced by
running `evaluateEligibility` over one baseline with a single field changed each
time, and printing what it returned.

| Situation | Eligible | Refusal | HTTP | Window reported |
| --- | --- | --- | --- | --- |
| everything in order | **yes** | — | 200 | yes |
| the booking belongs to someone else | no | `BOOKING_NOT_OWNED` | 403 | no |
| the account is not an active customer | no | `ACCOUNT_NOT_ELIGIBLE` | 403 | no |
| nobody completed the booking | no | `NO_ASSIGNED_PROVIDER` | 422 | no |
| the booking has not been completed | no | `BOOKING_NOT_COMPLETED` | 422 | no |
| the completion carries no timestamp | no | `COMPLETION_NOT_FINALIZED` | 422 | no |
| a review already exists | no | `REVIEW_ALREADY_EXISTS` | 409 | yes |
| more than 14 days after completion | no | `REVIEW_WINDOW_CLOSED` | 422 | yes |
| not the owner AND everything else also wrong | no | `BOOKING_NOT_OWNED` | 403 | no |

The last row is the one that matters for privacy. When everything is wrong at once
the answer is `BOOKING_NOT_OWNED` and **no window** — ownership is checked first, so a
caller cannot learn whether somebody else's booking exists, was completed, or was
already reviewed. A booking id is a small integer, and a service that answers
differently for a real one is an enumeration oracle.

### Every refusal

| Code | HTTP | Kind | Reason |
| --- | --- | --- | --- |
| `BOOKING_NOT_OWNED` | 403 | terminal | The booking belongs to another account. |
| `ACCOUNT_NOT_ELIGIBLE` | 403 | terminal | The account is not an active customer account. |
| `NO_ASSIGNED_PROVIDER` | 422 | terminal | No provider completed this booking, so there is nobody to review. |
| `BOOKING_NOT_COMPLETED` | 422 | retryable | The booking has not been completed. A review is a statement about work done. |
| `COMPLETION_NOT_FINALIZED` | 422 | retryable | The completion carries no timestamp, so the review window cannot be computed. |
| `REVIEW_WINDOW_CLOSED` | 422 | terminal | The review window has closed. |
| `REVIEW_ALREADY_EXISTS` | 409 | terminal | This booking already has a review. |

`terminal` means waiting will not help. The distinction is the difference between a
client telling a customer "come back when the job is finished" and "this can no
longer be reviewed" — showing the wrong one is the failure this vocabulary exists to
prevent.

### The window

- opens at completion, closes **14 days** later
- an author may edit for **48 hours** after writing

Bounded on purpose. A review written a year later is not a signal about the
provider's current work, and an unbounded window means a provider's rating can never
settle. The edit window is short because an edit changes a published statement about
somebody else's work — and it is recorded as `EDITED` rather than applied silently.

### One booking, one review

Enforced in three places, deliberately:

1. an advisory transaction lock on `review:{customerUid}:{bookingId}`, so two
   devices submitting at once serialise rather than both passing the check;
2. the existing-review check runs INSIDE that transaction, on the same connection;
3. `clientRequestId` replays the original review rather than writing a second.

A check taken before the lock is a check two concurrent submissions both pass.

## 3. What a review carries

Overall rating: **1–5**, integer. Dimension scores use the same scale.

| Limit | Characters |
| --- | --- |
| `publicComment` | 2000 |
| `privateFeedback` | 2000 |
| `clientRequestId` | 128 |

### The canonical dimensions (policy version 1)

Service-specific dimensions live in `service_review_dimensions`, keyed on
`services.id`. When a service configures none, this global set applies — which is
what makes a service reviewable on the day it is created.

| Key | Meaning |
| --- | --- |
| `SERVICE_QUALITY` | The standard of the work itself. |
| `PROFESSIONALISM` | Conduct and courtesy. |
| `PUNCTUALITY` | Arrival and timekeeping against the agreed schedule. |
| `COMMUNICATION` | Clarity and responsiveness before and during the job. |
| `CLEANLINESS` | Care and cleanliness appropriate to the service. |
| `SCOPE_ADHERENCE` | Delivery of the confirmed service scope. |

The policy version is stored on the REVIEW, not only on the configuration. A review
written under version 1 stays a version-1 review after the vocabulary moves,
because re-interpreting an old rating under a new scale silently changes what
somebody said.

## 4. Who may read what

Produced by running `mayReadField` for every declared field against every seat.

| Field | author | provider | public | admin |
| --- | --- | --- | --- | --- |
| `overallRating` | read | read | read | read |
| `dimensions` | read | read | read | read |
| `publicComment` | read | read | read | read |
| `privateFeedback` | read | — | — | read |
| `authorName` | read | — | — | read |
| `authorUid` | read | — | — | read |
| `bookingId` | read | — | — | read |
| `moderationState` | — | — | — | read |
| `internalNotes` | — | — | — | read |

A **seat** is a relationship to the review, not a role claim on a token: the author
is `customer_reviews.customer_uid`, the provider is the one the review is about, and
`public` is everybody else.

`privateFeedback` is the load-bearing row. It is addressed to Servana, not to the
provider — a customer who writes "he made me uncomfortable" there has not consented
to that reaching him. It appears in the author's own read and nowhere else.

`bookingId` is withheld from the public and from the provider for a quieter reason:
a booking id with a provider and a date is enough to work out who was at which
address on which day.

### Projected to nobody, including admin

`customer_email`, `customerEmail`, `customer_phone`, `customerPhone`, `address_one`, `addressOne`, `password_hash`, `fcm_token`

An admin who needs a customer's contact details reads the CUSTOMER record, which
authorizes and audits separately. A review read is not a customer-record read, and
letting it become one is how a support tool turns into a directory.

## 5. Moderation, and what counts toward the rating

| State | Public | Rating | Meaning |
| --- | --- | --- | --- |
| `NOT_REQUIRED` | visible | counts | No moderation was needed. |
| `AUTOMATED_CHECKS_PASSED` | visible | counts | Automated screening passed. |
| `PENDING_REVIEW` | hidden | excluded | Held pending a human decision. |
| `APPROVED` | visible | counts | A human approved it. |
| `REPORTED` | visible | counts | Reported and not yet decided. Stays visible until it is. |
| `REJECTED` | hidden | excluded | A human removed it from public view. |
| `RESTORED` | visible | counts | Removed, then restored on appeal. |

The invariant, asserted in `tests/review-eligibility.test.ts`: **no state is hidden
and counted**. A review the public cannot see that still moves the average is a
provider's displayed rating disagreeing with the reviews shown beneath it, and no
support agent can explain the difference.

`REPORTED` stays visible and keeps counting. Hiding on report would make the report
button a censorship button — one complaint from a competitor would remove a review
before anybody looked at it.

### The audit

`servana.review_moderation_cases`, append-only. Each entry records:

- the state before and after
- the effect on public visibility
- the deciding admin uid
- the decision timestamp
- the provider-facing reason code
- internal notes, which never leave the admin surface

A moderation change that alters public visibility is retained even when the review is later restored. The history is the evidence an appeal examines.

### The rating summary

Owned by `services/ratingAggregationService`, derived from customer_reviews where the moderation state counts toward the rating.

BACKEND-derived, always. No client computes an average, and no endpoint accepts one - a rating a caller can set is a rating a caller can inflate.

One shape, read by every seat, so a provider cannot be shown a different average from
the one on their own customer-facing card.

A dimension average is withheld below **5 samples** and the response says
`lowVolume` rather than hiding the number entirely. A provider with no reviews gets
`averageRating: null` and an explanation — never `0.0`, which reads as "rated badly"
rather than "not yet rated".

## 6. Post-service support

A case is attached to a CONCLUDED booking — `COMPLETED`, `REVIEWED` or `CANCELLED`.
A complaint about a booking that has not happened is not a post-service case; it is a
cancellation or a schedule question, and both have their own paths.

| Category | Routed to | Severity | Meaning |
| --- | --- | --- | --- |
| `SERVICE_QUALITY` | support | normal | The work was not to the expected standard. |
| `INCOMPLETE_WORK` | support | normal | Part of the confirmed scope was not delivered. |
| `PROPERTY_DAMAGE` | support | **elevated** | Something was damaged during the job. |
| `SAFETY_CONCERN` | support | **elevated** | A safety or conduct concern about the visit. |
| `BILLING` | finance | normal | A charge is wrong, unexpected or disputed. |

**`BILLING` is stored here and RESOLVED elsewhere.** the refund/dispute domain — POST /api/v1/bookings/:bookingId/refunds.
Handling it here would mean a second refund path with its own eligibility rules beside
the one `bookingPaymentService` enforces, and a refund granted under different rules
from the ones reconciliation checks is a break nobody can close. Refusing it outright
would be worse in the other direction: the customer has a real problem and no button.
So the case is created, marked `routedTo: "finance"`, and the response names the
endpoint that actually issues refunds. This table never moves money.

Damage and safety are raised at elevated severity: one has financial exposure and the
other may involve somebody being unsafe in their own home. Both need a human sooner
than "the provider was late" does.

| Bound | Value |
| --- | --- |
| Summary | 200 characters |
| Detail | 4000 characters |
| Open cases per booking | 3 |

The ceiling counts OPEN cases only, so resolving one frees a slot, and it is per
booking rather than per customer — a cap on how much trouble one customer is allowed
to have would be the wrong instrument.

The free-text `detail` is stored for a human handler and is **never projected back**.
It can carry anything the customer typed, including other people's names and what
happened inside their home.

## 7. Events

Published by this domain, using the TAB 09 registry rather than a second catalog:

- `ReviewCreated`

The event is published INSIDE the review's transaction, through the outbox, so a
review that exists always has its event and a rolled-back review has neither.

### Deliberately not published

**`ReviewUpdated`** — Not published. An edit would re-notify a provider about a review they were already told about, and an event that projects to nothing is one TAB 09 refuses. The aggregate is still recalculated, so the displayed rating is correct.

## 8. Canonical endpoints

| Endpoint | Auth | Domain service |
| --- | --- | --- |
| `GET /api/v1/reviews/providers/:providerUid` | public | `services/customerReviewService.listProviderReviews` |
| `GET /api/v1/reviews/providers/:providerUid/rating` | public | `services/customerReviewService.getProviderAggregate` |
| `POST /api/v1/bookings/:bookingId/review` | authenticated | `services/customerReviewService.createReview` |
| `GET /api/v1/bookings/:bookingId/review` | authenticated | `services/customerReviewService.getReviewByBooking` |
| `POST /api/v1/bookings/:bookingId/support-cases` | authenticated | `services/reviews/postServiceSupportService.createSupportCase` |
| `GET /api/v1/bookings/:bookingId/support-cases` | authenticated | `services/reviews/postServiceSupportService.listSupportCases` |

`GET /api/v1/bookings/:bookingId/review` returns `{ review, eligibility }` together.
A client that must ask "may I review this?" and "did I already?" in two calls will
render a review button from a stale answer to the first.

### Naming

The command names `/providers/:providerId/reviews` and `/rating-summary`. The
canonical routes are `/api/v1/reviews/providers/:providerUid` and
`.../rating`, which SHIPPED in TAB 01 and which client surfaces already call. They
are the same resources under a path that groups by domain rather than by subject;
renaming them now would break migrated callers to gain nothing, so they are reused
rather than duplicated under a second path.

### Legacy routes, aliased

| Route | Disposition | Canonical entry | Why |
| --- | --- | --- | --- |
| `GET /api/providers/:providerUid/reviews` | ALIAS_TEMPORARILY | `reviews.provider.list` | Same service. The legacy form does not clamp limit/offset; v1 does (BE-10). |
| `GET /api/providers/:providerUid/rating` | ALIAS_TEMPORARILY | `reviews.provider.rating` | Same service. Kept because it sits beside the reviews list that a future customer client may already be calling; retiring one without the other would be half a change. |
| `POST /api/bookings/:bookingId/reviews` | ALIAS_TEMPORARILY | `bookings.review.create` | The live customer review write. IDENTICAL domain call - this is a second URL onto one write, and the legacy route keeps its role guard and its response shape. |
| `GET /api/bookings/:bookingId/reviews` | ALIAS_TEMPORARILY | `bookings.review.get` | The live read. Same service; the canonical entry folds in the eligibility verdict. |
| `GET /api/bookings/:bookingId/review-eligibility` | ALIAS_TEMPORARILY | `bookings.review.get` | A SECOND call the client makes to decide whether to show the form. Folded into the read above, because asking twice means a screen that offers a form the next call refuses. |
| `POST /api/support/tickets` | ROLE_SPECIFIC | `bookings.supportCases.create` | The general customer contact surface. It carries no bookingId, so a quality complaint raised through it arrives with no way to see which visit it is about. Kept for contact that is genuinely not about a booking. |

## 9. Cross-platform caller matrix

`migrated` — this client calls the canonical v1 route today.
`legacy` — this client calls a legacy route the canonical entry supersedes.
`planned` — this client will migrate; it calls no equivalent today.
`—` — the capability does not apply to this client.

| Capability | Customer Mobile | Customer Web | Provider Mobile | Provider Web | Admin Web |
| --- | --- | --- | --- | --- | --- |
| Review a completed booking | legacy | legacy | — | — | — |
| Read the review I wrote for a booking | legacy | legacy | — | — | — |
| Read a provider's published reviews | planned | planned | — | — | — |
| A provider's rating summary | planned | planned | — | — | — |
| Raise a support case about a completed booking | planned | planned | — | — | — |

### Why each capability is or is not role-split

**Review a completed booking** (`services/customerReviewService.createReview`)

No role split. Only the booking's customer may write, and that is not a role check - it is a relationship resolved from `bookings.user_id`. The provider is taken from the COMPLETED assignment, never from the payload, so there is no shape of request that reviews somebody the customer did not book.

**Read the review I wrote for a booking** (`services/customerReviewService.getReviewByBooking`)

No role split. Scoped to the author, and it returns the private feedback the public projection never carries - which is the whole reason it is a separate read rather than a filter on the provider list.

**Read a provider's published reviews** (`services/customerReviewService.listProviderReviews`)

No role split on the shared list, and a genuinely different one for admin: `/admin/providers/:uid/reviews` carries moderation state, internal notes and rejected reviews, all behind a named permission. Same table, different question - and the public route cannot answer it because the projection does not carry those fields at all.

**A provider's rating summary** (`services/ratingAggregationService.getPublicRatingSummary`)

No role split, and this is the gate: one summary service and one contract, so a provider cannot be shown a different average from the one on their own customer-facing card. Backend-derived throughout - no endpoint accepts a rating, because a rating a caller can set is one a caller can inflate.

**Raise a support case about a completed booking** (`services/reviews/postServiceSupportService`)

No role split. Providers raise support cases through their own endpoint, which is a genuinely different operation: a provider case is about their account or a job they worked, and a customer case is about a booking they paid for. A BILLING category is ROUTED to the finance domain rather than handled here - handling it would fork the refund rules into a second, weaker path.
