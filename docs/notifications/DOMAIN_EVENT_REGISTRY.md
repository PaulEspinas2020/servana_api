<!--
  GENERATED FILE - do not edit by hand.
  Source: scripts/generate-notification-docs.ts, derived from
    src/services/events/domainEvents.ts       (the events, projections, deep links, preferences)
    src/services/events/eventOutbox.ts        (the durable publisher)
    src/services/events/deviceTokenService.ts (the device registry)
  Regenerate: npm run notification:docs
-->

# Domain Event Registry

> Every table below is produced by EXECUTING `src/services/events/domainEvents.ts`.
> The projection and preference matrices are built by running the real
> `projectEvent` and `mayDeliver` functions, so they are evidence of the
> behaviour rather than a description of it.

## 1. The event catalog

11 canonical events. Each names a FACT the platform already reaches;
nothing here invents a business moment.

| Event | Version | Required canonical ids | Transactional | Notifies |
| --- | --- | --- | --- | --- |
| `BookingCreated` | v1 | `bookingId`, `customerUid` | — | customer |
| `BookingAssigned` | v1 | `bookingId`, `providerUid` | yes | provider, customer |
| `ProviderAccepted` | v1 | `bookingId`, `providerUid` | yes | customer |
| `JobStarted` | v1 | `bookingId`, `providerUid` | yes | customer |
| `JobCompleted` | v1 | `bookingId`, `providerUid` | yes | customer, provider |
| `BookingCancelled` | v1 | `bookingId` | yes | customer, provider |
| `BookingRescheduled` | v1 | `bookingId` | — | customer, provider |
| `MessageReceived` | v1 | `conversationId`, `messageId`, `bookingId` | — | customer, provider |
| `ProviderApplicationUpdated` | v1 | `applicationId`, `providerUid` | — | provider |
| `PaymentUpdated` | v1 | `bookingId` | — | provider, customer |
| `ReviewCreated` | v1 | `reviewId`, `providerUid` | — | provider |

**Transactional** means the event is written INSIDE the producing transaction, so a rollback
leaves no event and a commit leaves a durable one. The booking state machine has that boundary and
uses it. Producers that commit per statement — messaging, payments, reviews — publish immediately
after their write; the event is still durable and still deduplicated, it just does not inherit the
fact's atomicity. The column says which is which rather than letting the registry overstate the
guarantee.

### What each event means

**`BookingCreated`** — A customer placed a booking. No provider is assigned yet.

Published by `controllers/bookingController.createBooking`.

**`BookingAssigned`** — A provider was assigned to a booking, by an admin or by matching.

Published by `services/booking/transitionExecutor (ADMIN_ASSIGN, AUTO_ASSIGN)`.

**`ProviderAccepted`** — The assigned provider accepted the job.

Published by `services/booking/transitionExecutor (PROVIDER_ACCEPT)`.

**`JobStarted`** — The provider verified the worker code and started the job.

Published by `services/booking/transitionExecutor (PROVIDER_START)`.

**`JobCompleted`** — The provider marked the job complete.

Published by `services/booking/transitionExecutor (PROVIDER_COMPLETE)`.

**`BookingCancelled`** — The booking was cancelled, by whichever party the metadata names.

Published by `services/booking/transitionExecutor (CUSTOMER_CANCEL, PROVIDER_CANCEL, ADMIN_CANCEL)`.

**`BookingRescheduled`** — The booking moved to a new scheduled time.

Published by `services/booking/bookingRescheduleService`.

**`MessageReceived`** — A message was persisted in a booking conversation.

Published by `chat/chat.service.sendMessage`.

**`ProviderApplicationUpdated`** — A provider's service application changed decision state.

Published by `services/serviceApplicationService`.

**`PaymentUpdated`** — A booking payment reached a settled state: captured or refunded.

Published by `services/paymentService (capture, cash, refund)`.

**`ReviewCreated`** — A customer published a review of a completed booking.

Published by `services/customerReviewService`.

## 2. Canonical identifiers

An event payload may carry these and only these. Canonical ids, never a screen name and never a
legacy Level-3 identifier — a screen name is a client's current implementation detail, and an event
that carries one breaks the moment a client renames a route.

| Ref | Resolves to |
| --- | --- |
| `bookingId` | bookings.id |
| `serviceId` | services.id (Catalog V2 canonical specific service) |
| `conversationId` | chat_conversations.id |
| `messageId` | chat_messages.id |
| `reviewId` | customer_reviews.id |
| `applicationId` | service_applications.id |
| `paymentId` | payments.id |
| `providerUid` | user_credentials.uid (provider) |
| `customerUid` | user_credentials.uid (customer) |

### Refused outright

`serviceFamilyId`, `service_family_id`, `screenName`, `routeName`, `level3Id`, `serviceOptionId`

`serviceFamilyId` is on that list deliberately. Catalog V2 is production-certified with
`services.id` as the canonical specific-service identity, and `service_families` is legacy coarse
provenance. Putting a family id in an event payload is how it would quietly become the bookable
identity again. `publishEvent` throws rather than dropping the field, because a silently-stripped
ref is a producer that thinks it sent something.

## 3. Projections

Produced by RUNNING `projectEvent` over a fixture event with every declared id present. If a
template or a key changes, this table changes with it — which is what makes it evidence rather than
description.

The keys below are the deduplication contract. Where a legacy call site already produces the same
notification, the projection reuses its key EXACTLY, so the owner-scoped unique index on
`(owner_uid, notification_key)` collapses the two producers into one row whichever wins the race.
That is what let the event layer become the producer without a flag day.

### `BookingCreated`

| Seat | Type | Category | Title | Idempotency key | Deep link |
| --- | --- | --- | --- | --- | --- |
| customer | `booking_created` | `jobAssigned` | Booking received | `booking_created_75` | `BOOKING_DETAIL` |

### `BookingAssigned`

| Seat | Type | Category | Title | Idempotency key | Deep link |
| --- | --- | --- | --- | --- | --- |
| provider | `assigned_job` | `jobAssigned` | New Job Assigned | `assigned_job_75_provider-uid` | `JOB_DETAIL` |
| customer | `provider_assigned` | `jobAssigned` | Provider assigned | `provider_assigned_75` | `BOOKING_DETAIL` |

### `ProviderAccepted`

| Seat | Type | Category | Title | Idempotency key | Deep link |
| --- | --- | --- | --- | --- | --- |
| customer | `booking_accepted` | `jobAssigned` | Provider confirmed | `booking_accepted_75` | `BOOKING_DETAIL` |

### `JobStarted`

| Seat | Type | Category | Title | Idempotency key | Deep link |
| --- | --- | --- | --- | --- | --- |
| customer | `job_started` | `jobAssigned` | Work started | `job_started_75` | `BOOKING_DETAIL` |

### `JobCompleted`

| Seat | Type | Category | Title | Idempotency key | Deep link |
| --- | --- | --- | --- | --- | --- |
| customer | `job_completed` | `jobAssigned` | Job completed | `job_completed_75` | `BOOKING_DETAIL` |
| provider | `job_completed` | `jobAssigned` | Job completed | `job_completed_provider_75` | `EARNINGS` |

### `BookingCancelled`

| Seat | Type | Category | Title | Idempotency key | Deep link |
| --- | --- | --- | --- | --- | --- |
| customer | `booking_cancelled` | `jobAssigned` | Booking cancelled | `booking_cancelled_75` | `BOOKING_DETAIL` |
| provider | `booking_cancelled` | `jobAssigned` | Job cancelled | `booking_cancelled_provider_75` | `JOB_DETAIL` |

### `BookingRescheduled`

| Seat | Type | Category | Title | Idempotency key | Deep link |
| --- | --- | --- | --- | --- | --- |
| customer | `booking_rescheduled` | `jobAssigned` | Booking rescheduled | `booking_rescheduled_75_1786665600` | `BOOKING_DETAIL` |
| provider | `booking_rescheduled` | `jobAssigned` | Job rescheduled | `booking_rescheduled_provider_75_1786665600` | `JOB_DETAIL` |

### `MessageReceived`

| Seat | Type | Category | Title | Idempotency key | Deep link |
| --- | --- | --- | --- | --- | --- |
| customer | `new_message` | `newMessage` | New message | `chat_msg:4021` | `CONVERSATION` |
| provider | `new_message` | `newMessage` | New message | `chat_msg:4021` | `CONVERSATION` |

### `ProviderApplicationUpdated`

| Seat | Type | Category | Title | Idempotency key | Deep link |
| --- | --- | --- | --- | --- | --- |
| provider | `service_application` | `requirementReview` | Application updated | `svc_app_event_app-1_1786665600` | `APPLICATION` |

### `PaymentUpdated`

| Seat | Type | Category | Title | Idempotency key | Deep link |
| --- | --- | --- | --- | --- | --- |
| provider | `earnings_payout` | `paymentReceived` | Payment Received | `payment_confirmed_75` | `EARNINGS` |
| customer | `payment_updated` | `paymentReceived` | Payment updated | `payment_updated_75_1786665600` | `BOOKING_DETAIL` |

### `ReviewCreated`

| Seat | Type | Category | Title | Idempotency key | Deep link |
| --- | --- | --- | --- | --- | --- |
| provider | `review_received` | `requirementReview` | New review | `review-received:rev-1` | `REVIEW` |

### Which legacy producer each projection supersedes

- `BookingCreated` → customer: bookingController.createBooking (keyless — a retry produced a SECOND row)
- `BookingAssigned` → provider: technicianService + adminBookingService (identical key)
- `BookingAssigned` → customer: technicianService + adminBookingService (identical key)
- `ProviderAccepted` → customer: technicianService.acceptJob (identical key)
- `JobStarted` → customer: **new** — nothing notified this before
- `JobCompleted` → customer: **new** — nothing notified this before
- `JobCompleted` → provider: **new** — nothing notified this before
- `BookingCancelled` → customer: **new** — nothing notified this before
- `BookingCancelled` → provider: **new** — nothing notified this before
- `BookingRescheduled` → customer: **new** — nothing notified this before
- `BookingRescheduled` → provider: **new** — nothing notified this before
- `MessageReceived` → customer: chat.service.notifyMessageRecipients (identical key)
- `MessageReceived` → provider: chat.service.notifyMessageRecipients (identical key)
- `ProviderApplicationUpdated` → provider: serviceApplicationService (five keyed producers, kept — they carry the specific decision)
- `PaymentUpdated` → provider: paymentService.approvePayment / markCashPaid (keyless — a retry produced a SECOND row)
- `PaymentUpdated` → customer: **new** — nothing notified this before
- `ReviewCreated` → provider: customerReviewService (identical key)

## 4. The outbox

`servana.domain_event_outbox`, applied by `scripts/migrations/033-domain-event-outbox.sql` or
lazily by `eventOutbox.ensureOutboxSchema`.

Two failure modes it removes, both of which have occurred here:

- **notify-before-commit** — the notification is written and the transaction then rolls back. The
  provider is told they have a job that does not exist, and there is no way to take it back.
- **commit-then-lose** — the transaction commits and the process dies before the fire-and-forget
  notification runs. The fact happened, nobody was told, and nothing records that a notification
  was owed.

### Idempotency, at two layers

1. **Publish** — `(event_name, dedupe_key)` is unique where a key is supplied, so a retried
   publish of a named fact produces one event.
2. **Delivery** — every projected notification carries a deterministic key under an owner-scoped
   unique index, so even a doubly-projected event writes one row.

The second layer is the one that matters. The first only prevents wasted work; the second prevents
a duplicate reaching a person.

### Dispatch

Claimed with `FOR UPDATE SKIP LOCKED` plus a status compare-and-swap, so two dispatchers take
disjoint sets. A failed dispatch stays `PENDING` and is retried up to **8**
attempts, then becomes `FAILED` — terminal for the dispatcher and visible to an operator.
Retrying forever is how one poison row becomes an infinite loop that starves every event behind it.

## 5. Preferences

One model, one table, every account. `provider_notification_preferences` is keyed on a uid and has
no role column — it has always been capable of serving anyone. Both legacy routes onto it were gated
on a provider role and the customer push path never read it at all, so a customer had no way to
configure notifications and, if they had, nothing would have consulted the answer.

| Category | Label | On by default | May override | Meaning |
| --- | --- | --- | --- | --- |
| `jobAssigned` | Job and booking activity | yes | — | Assignment, acceptance, arrival, start, completion, cancellation. |
| `jobReminder` | Reminders | — | — | Upcoming job reminders. |
| `paymentReceived` | Payments, earnings and payouts | yes | — | Payment confirmed, refund issued, payout released. |
| `newMessage` | Messages | yes | — | A new message in a booking conversation. |
| `promotions` | Promotions | — | — | Marketing. Off by default and never overridable. |
| `requirementReview` | Applications and verification | yes | — | Service application decisions, document review, moderation. |
| `support` | Support and safety | yes | yes | Support case activity and safety notices. |
| `accountSecurity` | Account and security | yes | yes | Sign-in alerts, credential changes, account state. |
| `system` | System | yes | — | Maintenance and platform notices. |

### Channels

A preference governs whether we INTERRUPT somebody. It does not govern whether a fact is recorded.

| Channel | Obeys preference | Why |
| --- | --- | --- |
| `inApp` | — | The in-app inbox is the RECORD, not an interruption. Suppressing it would put holes in the audit trail and make the unread count irreconcilable with the events that produced it. |
| `push` | yes | Push is the interruption. It is what a preference is actually about. |
| `email` | yes | Declared for completeness. This tab routes nothing to it. |
| `sms` | yes | Declared for completeness. This tab routes nothing to it. |

### What happens when a category is turned OFF

Produced by running `mayDeliver` for each category with that category disabled.

| Category | inApp | push | email | sms |
| --- | --- | --- | --- | --- |
| `jobAssigned` | deliver | withheld | withheld | withheld |
| `jobReminder` | deliver | withheld | withheld | withheld |
| `paymentReceived` | deliver | withheld | withheld | withheld |
| `newMessage` | deliver | withheld | withheld | withheld |
| `promotions` | deliver | withheld | withheld | withheld |
| `requirementReview` | deliver | withheld | withheld | withheld |
| `support` | deliver | **override** | **override** | **override** |
| `accountSecurity` | deliver | **override** | **override** | **override** |
| `system` | deliver | withheld | withheld | withheld |

`**override**` is the transactional carve-out: a person cannot opt out of being told their account
or a safety case needs them. `promotions` is deliberately excluded from it, so the carve-out can
never be used to deliver marketing.

## 6. The deep-link contract

One target per destination, each keyed on a CANONICAL id. The two client vocabularies are
projections of it, not separate truths — customer clients read `{ routeKey, resourceId }` and
provider clients read `{ page | screen, bookingId | applicationId }`. Both already exist in shipped
builds and neither can be changed by this backend, so the target is declared once and rendered into
both. A migrating client reads `target` plus the canonical ids and stops parsing either.

Rendered below by running `deepLinkFor` with booking 75.

| Target | Canonical id | Customer clients | Provider clients |
| --- | --- | --- | --- |
| `BOOKING_DETAIL` | `bookingId` | `{"routeKey":"BOOKING_DETAILS","resourceId":"75","target":"BOOKING_DETAIL","requiresAccessCheck":true}` | `{"page":"jobs","bookingId":"75","target":"BOOKING_DETAIL","requiresAccessCheck":true}` |
| `JOB_DETAIL` | `bookingId` | — | `{"page":"jobs","bookingId":"75","target":"JOB_DETAIL","requiresAccessCheck":true}` |
| `CONVERSATION` | `conversationId` | `{"routeKey":"CONVERSATION","resourceId":"75","target":"CONVERSATION","requiresAccessCheck":true}` | `{"page":"messages","target":"CONVERSATION","requiresAccessCheck":true}` |
| `EARNINGS` | `bookingId` | — | `{"page":"earnings","bookingId":"75","target":"EARNINGS","requiresAccessCheck":true}` |
| `APPLICATION` | `applicationId` | — | `{"screen":"ServiceApplication","applicationId":"75","target":"APPLICATION","requiresAccessCheck":true}` |
| `REVIEW` | `reviewId` | — | `{"page":"reputation","target":"REVIEW","requiresAccessCheck":true}` |
| `NOTIFICATIONS` | — | `{"routeKey":"NOTIFICATIONS","target":"NOTIFICATIONS"}` | `{"page":"notifications","target":"NOTIFICATIONS"}` |

### Authorization happens AFTER navigation

Every target that names a resource carries `requiresAccessCheck`. The notification is a POINTER,
not a grant: tapping it navigates, and the screen then calls the canonical endpoint, which
authorizes. A deep link carrying its own authority would be a capability URL sitting in a
notification tray.

A target that needs an id and is not given one renders **null** rather than a route containing the
literal `{id}`. A deep link to "{id}" is worse than no deep link, because the client opens a
screen and then fails to load it.

### CONVERSATION, for providers, deliberately omits the booking id

ServanaWorker's route resolver prefers a booking id over a page name and would open
`JobDetailsView`, which has no chat entry point (PM-257) — so a tap would land the provider on a
screen with no way to reach the message it announced. Without the id it falls back to the tab shell,
where Messages is one tap away. Restore the id once the job screen can open a thread.

## 7. Device tokens

`servana.account_device_tokens` is the canonical registry for every account regardless of role.

Providers had a token TABLE and therefore multi-device push. Customers had a single COLUMN, so a
customer signed in on a phone and a tablet only ever received push on whichever signed in last —
silently, with no error anywhere. Same platform, same feature, two implementations, one broken.

- The **token** is the primary key, not `(uid, token)`. A device can only be signed into one
  account at a time, so registering a token another account holds MOVES it. Keying on the pair
  would let a shared or resold handset accumulate owners and receive both accounts' notifications.
- Both legacy stores are **dual-written and still read**. `tokensFor` returns the union, so a
  device registered through a legacy route before this shipped stays reachable.
- At most **500** devices per send, so a corrupted token store cannot turn one
  notification into an unbounded fan-out.

### Stale tokens

Pruned on exactly these push-provider errors:

- `messaging/registration-token-not-registered`
- `messaging/invalid-registration-token`

Deliberately only these two. Quota, unavailable, timeout and internal are transient, and deleting a
token on a transient failure would un-enroll working devices during exactly the outage that caused
it.

## 8. Observability

Counted per window and reported under `[event-telemetry]`. Codes and counts only — no uid, no
booking id, no notification body. A log that names who was told what has to be protected like the
notification it describes.

| Signal | Detects | Why it is counted |
| --- | --- | --- |
| `EVENT_PUBLISHED` | An event was written to the outbox, by name. | The denominator. A projection rate means nothing without it. |
| `EVENT_PUBLISH_REJECTED` | A publish was refused — unknown name, missing required ref, forbidden ref. | This is the guard working. A rising rate means a producer is passing the wrong shape, which would otherwise surface as notifications that silently never arrive. |
| `EVENT_DISPATCHED` | An outbox row was projected into notifications and marked done. | Published-minus-dispatched is the backlog, and a backlog is a silent outage. |
| `EVENT_DISPATCH_FAILED` | A dispatch attempt threw. The row stays pending and is retried. | A row that fails forever is a notification nobody will ever receive. |
| `NOTIFICATION_DEDUPED` | A projection resolved to a notification key that already existed. | The deduplication working. It is EXPECTED while the legacy producers still run beside the projector — and once they are retired, a non-zero rate means genuine redelivery. |
| `PUSH_SUPPRESSED_BY_PREFERENCE` | The record was written and the interruption was withheld, by category. | Distinguishes "we never told them" from "they asked us not to buzz". Without it, a support report of a missing notification has no way to be answered. |
| `DEVICE_TOKEN_PRUNED` | A token the push provider reported as unregistered was removed. | Stale tokens accumulate silently and every send retries them. A spike is usually an app uninstall wave or a signing-certificate change. |
