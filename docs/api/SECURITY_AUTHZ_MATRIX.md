<!--
  GENERATED FILE - do not edit by hand.
  Source: scripts/generate-release-safety-docs.ts, derived from
    src/api/v1/authzMatrix.ts   (roles, object ownership)
    src/api/v1/routeHealth.ts   (proof strength, smoke accounts)
    src/api/v1/contract.ts      (the declared auth mode per endpoint)
  Regenerate: npm run safety:docs
-->

# Security and authorization matrix

> Two questions, and only one of them is about roles.

## 1. Summary

| | |
| --- | --- |
| Mounted endpoints | 95 |
| `public` | 20 |
| `authenticated` | 55 |
| `provider` | 19 |
| `admin` | 1 |
| Object-scoped | 36 |
| Object-scoped WITH an ownership rule | 36 |
| **Unguarded** | **0** |

## 2. Role access, by declared mode

| Mode | anonymous | customer | provider | admin |
| --- | --- | --- | --- | --- |
| `public` | allow | allow | allow | allow |
| `authenticated` | — | allow | allow | allow |
| `provider` | — | — | allow | — |
| `admin` | — | — | — | allow |

Derived from the auth chain in `register.ts` and asserted against it, so a mode
whose chain changes without this table changing fails the build.

**`provider` denies admin, deliberately.** An admin holds no assignments, so a "my jobs" endpoint has nothing to answer for them. Admin operations live under /admin/bookings/* over the same executor.

## 3. Object-level authorization is the one that matters

A role check is necessary and not sufficient. Every customer holds the customer
role; the whole point is that one customer must not read another's booking.

A booking carries an address and a time when somebody will be at home. A leak of
it is not a data-protection abstraction — it is telling a stranger where a person
lives and when they will be there. OWASP puts this first in the API top ten.

### `bookings` — `:bookingId`

- predicate: bookingAccessService.assertBookingAccess — customer, assigned provider, or admin
- enforced by: `services/bookingAccessService`
- proven by: `tests/provider-job-leakage.test.ts, tests/assigned-booking-integrity.test.ts`
- a non-owner receives: 404 — indistinguishable from a booking that does not exist
- distinguishes absent from forbidden: **no**

### `booking-experiences` — `:bookingId`

- predicate: the same assertBookingAccess, then the per-experience actor rule
- enforced by: `services/booking/experienceStore + experiencePolicy`
- proven by: `tests/booking-tracking-authorization.test.ts, tests/booking-experience-policy.test.ts`
- a non-owner receives: 404 for a booking that is not the caller's
- distinguishes absent from forbidden: **no**

### `provider-jobs` — `:bookingId`

- predicate: booking_workers.worker_uid = $callerUid
- enforced by: `services/technicianService`
- proven by: `tests/provider-job-leakage.test.ts`
- a non-owner receives: 404 — a provider must not learn that a job they are not on exists
- distinguishes absent from forbidden: **no**

### `conversations` — `:conversationId`

- predicate: participant membership on the conversation, resolved from the booking
- enforced by: `services/messaging/messagingService`
- proven by: `tests/messaging-leakage.test.ts`
- a non-owner receives: one code for absent and forbidden — the TAB 08 enumeration-oracle fix
- distinguishes absent from forbidden: **no**

### `notifications` — `:key`

- predicate: owner_uid = $callerUid on the inbox row
- enforced by: `services/events/notificationInbox`
- proven by: `tests/notification-policy.test.ts`
- a non-owner receives: 404 NOT_FOUND
- distinguishes absent from forbidden: **no**

### `reviews` — `:bookingId`

- predicate: customer_reviews.customer_uid = $callerUid, and the booking is the caller's
- enforced by: `services/customerReviewService`
- proven by: `tests/review-leakage.test.ts, tests/review-eligibility.test.ts`
- a non-owner receives: 403 BOOKING_NOT_OWNED, checked FIRST so nothing else leaks
- distinguishes absent from forbidden: **no**

### `finance` — `:bookingId`

- predicate: the payment's booking must be the caller's; earnings are scoped to worker_uid
- enforced by: `services/finance/bookingPaymentService + providerEarningsService`
- proven by: `tests/finance-leakage.test.ts`
- a non-owner receives: 404 — an earnings figure is a person's income
- distinguishes absent from forbidden: **no**

### `account` — `:addressId`

- predicate: user_id = $callerUid on every address row
- enforced by: `services/account/addressBookService`
- proven by: `tests/account-leakage.test.ts`
- a non-owner receives: 404 — an address is where somebody lives
- distinguishes absent from forbidden: **no**

### Why almost every refusal is a 404

Answering 403 for an object that exists and 404 for one that does not is an
enumeration oracle, and booking ids are small integers. Every rule above is
asserted NOT to distinguish the two cases.

## 4. The matrix

Columns are anonymous, customer, provider, admin. `●` = the auth chain admits that role.

| Endpoint | Route | Mode | A C P A | Object rule |
| --- | --- | --- | --- | --- |
| `admin.finance.reconciliation` | GET /admin/finance/reconciliation | `admin` | · · · ● | — |
| `auth.forgotPassword` | POST /auth/forgot-password | `public` | ● ● ● ● | — |
| `auth.login` | POST /auth/login | `public` | ● ● ● ● | — |
| `auth.logout` | POST /auth/logout | `authenticated` | · ● ● ● | — |
| `auth.refresh` | POST /auth/refresh | `public` | ● ● ● ● | — |
| `auth.register` | POST /auth/register | `public` | ● ● ● ● | — |
| `auth.resendVerification` | POST /auth/resend-verification | `public` | ● ● ● ● | — |
| `auth.resetPassword` | POST /auth/reset-password | `public` | ● ● ● ● | — |
| `auth.verifyEmail` | POST /auth/verify-email | `public` | ● ● ● ● | — |
| `auth.verifyMobile` | POST /auth/verify-mobile | `authenticated` | · ● ● ● | — |
| `bookings.additionalWork.create` | POST /bookings/:bookingId/additional-work | `provider` | · · ● · | ✔ bookingId |
| `bookings.additionalWork.list` | GET /bookings/:bookingId/additional-work | `authenticated` | · ● ● ● | ✔ bookingId |
| `bookings.cancel` | POST /bookings/:bookingId/cancel | `authenticated` | · ● ● ● | ✔ bookingId |
| `bookings.disputes.list` | GET /bookings/:bookingId/disputes | `authenticated` | · ● ● ● | ✔ bookingId |
| `bookings.disputes.open` | POST /bookings/:bookingId/disputes | `authenticated` | · ● ● ● | ✔ bookingId |
| `bookings.get` | GET /bookings/:bookingId | `authenticated` | · ● ● ● | ✔ bookingId |
| `bookings.listMine` | GET /bookings | `authenticated` | · ● ● ● | — |
| `bookings.otp.request` | POST /bookings/:bookingId/otp/request | `authenticated` | · ● ● ● | ✔ bookingId |
| `bookings.otp.status` | GET /bookings/:bookingId/otp/status | `authenticated` | · ● ● ● | ✔ bookingId |
| `bookings.otp.verify` | POST /bookings/:bookingId/otp/verify | `authenticated` | · ● ● ● | ✔ bookingId |
| `bookings.payments.get` | GET /bookings/:bookingId/payment | `authenticated` | · ● ● ● | ✔ bookingId |
| `bookings.payments.intent` | POST /bookings/:bookingId/payment-intents | `authenticated` | · ● ● ● | ✔ bookingId |
| `bookings.refunds.create` | POST /bookings/:bookingId/refunds | `authenticated` | · ● ● ● | ✔ bookingId |
| `bookings.reschedule` | POST /bookings/:bookingId/reschedule | `authenticated` | · ● ● ● | ✔ bookingId |
| `bookings.reschedule.history` | GET /bookings/:bookingId/reschedule | `authenticated` | · ● ● ● | ✔ bookingId |
| `bookings.review.create` | POST /bookings/:bookingId/review | `authenticated` | · ● ● ● | ✔ bookingId |
| `bookings.review.get` | GET /bookings/:bookingId/review | `authenticated` | · ● ● ● | ✔ bookingId |
| `bookings.supportCases.create` | POST /bookings/:bookingId/support-cases | `authenticated` | · ● ● ● | ✔ bookingId |
| `bookings.supportCases.list` | GET /bookings/:bookingId/support-cases | `authenticated` | · ● ● ● | ✔ bookingId |
| `bookings.timeline` | GET /bookings/:bookingId/timeline | `authenticated` | · ● ● ● | ✔ bookingId |
| `bookings.tracking` | GET /bookings/:bookingId/tracking | `authenticated` | · ● ● ● | ✔ bookingId |
| `bookings.transitions` | GET /bookings/:bookingId/transitions | `authenticated` | · ● ● ● | ✔ bookingId |
| `catalog.browse` | GET /catalog | `public` | ● ● ● ● | — |
| `catalog.categories.get` | GET /catalog/categories/:categoryId | `public` | ● ● ● ● | — |
| `catalog.categories.list` | GET /catalog/categories | `public` | ● ● ● ● | — |
| `catalog.categories.subcategories` | GET /catalog/categories/:categoryId/subcategories | `public` | ● ● ● ● | — |
| `catalog.search` | GET /catalog/search | `public` | ● ● ● ● | — |
| `catalog.services.get` | GET /catalog/services/:serviceId | `public` | ● ● ● ● | — |
| `catalog.services.list` | GET /catalog/services | `public` | ● ● ● ● | — |
| `catalog.subcategories.get` | GET /catalog/subcategories/:subcategoryId | `public` | ● ● ● ● | — |
| `catalog.subcategories.services` | GET /catalog/subcategories/:subcategoryId/services | `public` | ● ● ● ● | — |
| `catalog.summary` | GET /catalog/summary | `public` | ● ● ● ● | — |
| `conversations.create` | POST /conversations | `authenticated` | · ● ● ● | — |
| `conversations.get` | GET /conversations/:conversationId | `authenticated` | · ● ● ● | ✔ conversationId |
| `conversations.list` | GET /conversations | `authenticated` | · ● ● ● | — |
| `conversations.messages.create` | POST /conversations/:conversationId/messages | `authenticated` | · ● ● ● | ✔ conversationId |
| `conversations.messages.list` | GET /conversations/:conversationId/messages | `authenticated` | · ● ● ● | ✔ conversationId |
| `conversations.read` | POST /conversations/:conversationId/read | `authenticated` | · ● ● ● | ✔ conversationId |
| `customer.addresses.create` | POST /customer/addresses | `authenticated` | · ● ● ● | — |
| `customer.addresses.delete` | DELETE /customer/addresses/:addressId | `authenticated` | · ● ● ● | ✔ addressId |
| `customer.addresses.list` | GET /customer/addresses | `authenticated` | · ● ● ● | — |
| `customer.addresses.setDefault` | POST /customer/addresses/:addressId/default | `authenticated` | · ● ● ● | ✔ addressId |
| `customer.addresses.update` | PATCH /customer/addresses/:addressId | `authenticated` | · ● ● ● | ✔ addressId |
| `customer.profile.get` | GET /customer/profile | `authenticated` | · ● ● ● | — |
| `customer.profile.patch` | PATCH /customer/profile | `authenticated` | · ● ● ● | — |
| `home.feed` | GET /home | `authenticated` | · ● ● ● | — |
| `home.sections` | GET /home/sections | `authenticated` | · ● ● ● | — |
| `identity.me` | GET /me | `authenticated` | · ● ● ● | — |
| `me.completion.get` | GET /me/completion | `authenticated` | · ● ● ● | — |
| `me.devices.register` | POST /me/devices | `authenticated` | · ● ● ● | — |
| `me.devices.release` | DELETE /me/devices | `authenticated` | · ● ● ● | — |
| `me.notificationPreferences.get` | GET /me/notification-preferences | `authenticated` | · ● ● ● | — |
| `me.notificationPreferences.patch` | PATCH /me/notification-preferences | `authenticated` | · ● ● ● | — |
| `me.patch` | PATCH /me | `authenticated` | · ● ● ● | — |
| `me.security.get` | GET /me/security | `authenticated` | · ● ● ● | — |
| `me.settings.get` | GET /me/settings | `authenticated` | · ● ● ● | — |
| `me.settings.patch` | PATCH /me/settings | `authenticated` | · ● ● ● | — |
| `notifications.list` | GET /notifications | `authenticated` | · ● ● ● | — |
| `notifications.markAllRead` | POST /notifications/read-all | `authenticated` | · ● ● ● | — |
| `notifications.markRead` | PATCH /notifications/:key/read | `authenticated` | · ● ● ● | — |
| `notifications.unreadCount` | GET /notifications/unread-count | `authenticated` | · ● ● ● | — |
| `provider.availability.get` | GET /provider/availability | `provider` | · · ● · | — |
| `provider.availability.patch` | PATCH /provider/availability | `provider` | · · ● · | — |
| `provider.documents.list` | GET /provider/documents | `provider` | · · ● · | — |
| `provider.earnings.payouts` | GET /provider/earnings/payouts | `provider` | · · ● · | — |
| `provider.earnings.summary` | GET /provider/earnings/summary | `provider` | · · ● · | — |
| `provider.earnings.transactions` | GET /provider/earnings/transactions | `provider` | · · ● · | — |
| `provider.jobs.accept` | POST /provider/jobs/:bookingId/accept | `provider` | · · ● · | ✔ bookingId |
| `provider.jobs.arrived` | POST /provider/jobs/:bookingId/arrived | `provider` | · · ● · | ✔ bookingId |
| `provider.jobs.cancel` | POST /provider/jobs/:bookingId/cancel | `provider` | · · ● · | ✔ bookingId |
| `provider.jobs.complete` | POST /provider/jobs/:bookingId/complete | `provider` | · · ● · | ✔ bookingId |
| `provider.jobs.decline` | POST /provider/jobs/:bookingId/decline | `provider` | · · ● · | ✔ bookingId |
| `provider.jobs.enroute` | POST /provider/jobs/:bookingId/en-route | `provider` | · · ● · | ✔ bookingId |
| `provider.jobs.get` | GET /provider/jobs/:bookingId | `provider` | · · ● · | ✔ bookingId |
| `provider.jobs.list` | GET /provider/jobs | `provider` | · · ● · | — |
| `provider.jobs.start` | POST /provider/jobs/:bookingId/start | `provider` | · · ● · | ✔ bookingId |
| `provider.profile.get` | GET /provider/profile | `provider` | · · ● · | — |
| `provider.profile.patch` | PATCH /provider/profile | `provider` | · · ● · | — |
| `provider.publicProfile.get` | GET /providers/:providerUid/profile | `authenticated` | · ● ● ● | — |
| `provider.services.list` | GET /provider/services | `provider` | · · ● · | — |
| `reviews.provider.list` | GET /reviews/providers/:providerUid | `public` | ● ● ● ● | — |
| `reviews.provider.rating` | GET /reviews/providers/:providerUid/rating | `public` | ● ● ● ● | — |
| `search.query` | GET /search | `public` | ● ● ● ● | — |
| `settings.notificationPreferences.get` | GET /settings/notification-preferences | `authenticated` | · ● ● ● | — |
| `settings.notificationPreferences.put` | PUT /settings/notification-preferences | `authenticated` | · ● ● ● | — |

## 5. What counts as proof that a route is protected (§143)

> A 401 from global auth middleware must never be considered route proof.

`GET /api/catalog` shipped unreachable. It was shadowed by `GET /api/:id`, and
every check that touched it saw a plausible response and concluded the route was
fine — because in the legacy tree an unknown single-segment path is parsed as a
booking id and answers 401 or 400, which is exactly what a protected route also
answers.

`classifyProbe` therefore returns a proof STRENGTH:

| Verdict | Meaning |
| --- | --- |
| `HANDLER_REACHED` | The handler produced the response. The only positive proof. |
| `ROUTE_ABSENT` | The v1 router's own terminal 404. Definitive absence. |
| `INCONCLUSIVE` | A bare 401/403, an HTML body, a proxy error. Proves nothing. |

An `INCONCLUSIVE` result **fails** a smoke step. It is not a pass.

## 6. Smoke credentials (§150)

51 of 95 endpoints are probeable; the other
44 are writes and are never probed, because a POST to
`/bookings/:id/cancel` on production enters the same state machine a real
customer's booking uses.

### `smoke-customer`

- auth mode: `authenticated` · credential: `$SMOKE_CUSTOMER_TOKEN` · rotate every 30 days
- privilege: Read-only customer. Owns one seeded booking in a terminal state.

- Never a real customer account.
- Its booking is terminal, so no smoke call can move a live job.
- Cannot reach any /admin route; the contract gates those on role 1.

### `smoke-provider`

- auth mode: `provider` · credential: `$SMOKE_PROVIDER_TOKEN` · rotate every 30 days
- privilege: Read-only provider. Assigned to nothing.

- PROVIDER RECORDS ARE LIVE. This account is a dedicated seed, never an existing provider.
- Assigned to no booking, so no transition endpoint can be exercised against real work.
- Read probes only — a write would enter the same state machine live jobs use.

### `smoke-admin`

- auth mode: `admin` · credential: `$SMOKE_ADMIN_TOKEN` · rotate every 14 days
- privilege: Admin with READ permissions only. No assignment, no finance mutation.

- Holds no permission that assigns work, moves money or edits a provider.
- Rotated fastest because it is the account with the widest read.
- Its permission set is asserted before the run, not assumed.

### Rules

- **storage** — Environment variables on the smoke runner only. Never in the repository, never in CI logs.
- **rotation** — Rotated on the cadence above, and immediately after any run whose logs were shared.
- **personal accounts** — Forbidden. An automation running as a named engineer produces an audit trail attributing machine actions to a person, survives their departure, and cannot be revoked without locking a human out.
- **least privilege** — Each account holds the narrowest role that can prove the endpoints it probes, and no account can perform a state transition on live work.
- **on failure** — A smoke failure reports the endpoint and the request id. It never echoes the token.

There is no field on `SmokeAccount` that can hold a secret. "No secrets in
tests" is a property of the type rather than of somebody's care.
