# Cross-client migration plan — legacy → `/api/v1`

Per-client, phased, and ordered by how cheaply a client can be corrected if the
migration is wrong. Nothing here requires a backend change; every canonical
route named as `live` is mounted and tested today.

Companion documents: [`API_V1_CONTRACT.md`](API_V1_CONTRACT.md) (the rules),
[`API_ENDPOINT_REGISTRY.md`](API_ENDPOINT_REGISTRY.md) (the endpoints),
[`LEGACY_ENDPOINT_MIGRATION_MATRIX.md`](LEGACY_ENDPOINT_MIGRATION_MATRIX.md)
(every route, classified).

> **This document is the ARGUMENT. The work list is derived.**
>
> This file argues the migration ORDER and records which capabilities were
> deliberately left for a later command — both are judgements, and a judgement
> cannot be generated. What each client actually has to change is now produced
> from the contract, because a hand-maintained list of ninety-five endpoints
> across five clients is stale the day after it is written:
>
> - [`PER_CLIENT_MIGRATION_PLAN.md`](PER_CLIENT_MIGRATION_PLAN.md) — the work list, one section per client
> - [`CLIENT_ENDPOINT_PARITY_MATRIX.md`](CLIENT_ENDPOINT_PARITY_MATRIX.md) — capability × client, every cell computed
> - [`CANONICAL_CALL_MANIFEST.json`](CANONICAL_CALL_MANIFEST.json) — machine-readable, diff your call sites against it
> - [`DEPRECATION_SCHEDULE.md`](DEPRECATION_SCHEDULE.md) — what has to be true before each alias goes
> - [`LEGACY_TELEMETRY_SPEC.md`](LEGACY_TELEMETRY_SPEC.md) — the measurement behind that schedule
>
> The phase checklist below is TAB 01's and is left as written; it is a record of
> what that command did, not a live tracker.

---

## The ordering principle

**Migrate in reverse order of correction cost.**

| Client | Correction cost | Why |
|---|---|---|
| Admin Portal | minutes | Netlify-from-git: the push *is* the deploy. A bad migration is reverted by a revert. |
| Provider Web | minutes | Same shape — a push to `main` is a production deploy. |
| Customer Web | hours | Angular, not yet deployed at `client.servana.com.ph`. |
| Provider Mobile | days–weeks | Play review, then the installed base has to update. |
| Customer Mobile | days–weeks | Same, and it is the largest installed base. |

A mobile client that adopts a wrong contract keeps calling it for as long as
customers leave the app installed. That is why the two Flutter apps go last even
though they are the reason the canonical namespace exists.

## Phase 0 — before any client moves (backend, done)

- [x] `/api/v1` mounted first, exempt from field-rewriting middleware.
- [x] `GET /api/catalog` unshadowed; shadow regression test over the whole app.
- [x] Legacy telemetry counting every alias, derived from the contract.
- [x] OpenAPI + registry + matrix generated, drift-tested in the gate.
- [ ] **Deploy.** Everything above is local and unpushed. No client can migrate
      against a contract that is not serving.
- [ ] **Production smoke** of the live endpoints against the deployed build, by
      introspecting the compiled router and calling each path — never by
      reading a 401 as proof a route exists.

The surface as it stands:

<!-- BEGIN GENERATED: v1-surface -->
- **114 canonical endpoints live**, each driven end to end by `tests/v1-router.test.ts`.
- **0 planned**, documented and not mounted — see §11 of [`API_V1_CONTRACT.md`](API_V1_CONTRACT.md).
- **94 legacy aliases** counted by telemetry, derived from the contract.
- **518 routes** mounted outside `/api/v1`, every one classified in the matrix.
<!-- END GENERATED: v1-surface -->

Each phase below opens with a generated table of what that client can move
today: every canonical endpoint the contract records it as still calling on a
legacy route, where the successor is `implemented` rather than `planned`. The
prose is the sequencing and the risk; the table is derived, so it grows as
domain commands land instead of going quietly stale.

## Phase 1 — Admin Portal

**Adopt first, migrate last.** The portal calls almost nothing in the canonical
set today — its surface is `/api/admin/*`, which this command classifies
`CANONICALIZE` and leaves to the admin-bookings domain command.

<!-- BEGIN GENERATED: v1-moves:admin -->
**20** canonical capabilities are live that this client still reaches by a legacy route.

| Move to (canonical) | Legacy routes it supersedes |
|---|---|
| `POST /api/v1/auth/login` | `POST /api/auth/signin`<br>`POST /api/auth/admin-signin`<br>`POST /api/auth/firebase-login` |
| `POST /api/v1/auth/refresh` | `POST /api/auth/refresh` |
| `POST /api/v1/auth/logout` | `POST /api/auth/logout` |
| `POST /api/v1/auth/forgot-password` | `POST /api/auth/forgot-password` |
| `POST /api/v1/auth/reset-password` | `POST /api/auth/reset-password` |
| `POST /api/v1/conversations` | `GET /api/bookings/:bookingId/conversation` |
| `GET /api/v1/conversations` | `GET /api/chat/conversations` |
| `GET /api/v1/conversations/:conversationId` | `GET /api/chat/conversations/:id` |
| `GET /api/v1/conversations/:conversationId/messages` | `GET /api/chat/conversations/:id/messages` |
| `POST /api/v1/conversations/:conversationId/messages` | `POST /api/chat/conversations/:id/messages` |
| `POST /api/v1/conversations/:conversationId/read` | `POST /api/chat/conversations/:id/read` |
| `POST /api/v1/bookings/:bookingId/reschedule` | `POST /api/admin/bookings/:id/reschedule` |
| `POST /api/v1/bookings/:bookingId/disputes` | `POST /api/admin/bookings/:id/escalate` |
| `POST /api/v1/admin/refunds/:refundId/mark-failed` | `POST /api/admin/finance/refunds/:refundId/mark-failed` |
| `GET /api/v1/admin/bookings` | `GET /api/admin/bookings` |
| `GET /api/v1/admin/bookings/:bookingId/assignment-candidates` | `GET /api/admin/bookings/:id/assignment-candidates` |
| `POST /api/v1/admin/bookings/:bookingId/assign` | `POST /api/admin/bookings/:id/assign` |
| `POST /api/v1/admin/bookings/:bookingId/reassign` | `POST /api/admin/bookings/:id/reassign` |
| `POST /api/v1/bookings/:bookingId/refunds` | `POST /api/admin/finance/refunds` |
| `GET /api/v1/admin/finance/reconciliation` | `GET /api/admin/finance/reconciliation/exceptions` |

Caller state is recorded **per capability**, not per legacy path: this client calls one or more of the routes on the right, not all of them. `ROLE_SPECIFIC` routes are excluded — those are the ones that must not be collapsed.
<!-- END GENERATED: v1-moves:admin -->

What it should do now:

1. Send `X-Servana-Client: admin` and `X-Servana-Client-Version` on every
   request. This is what makes the legacy telemetry able to attribute traffic,
   and it costs one interceptor.
2. Optionally take the auth moves above — `/api/auth/admin-signin` is
   `/api/v1/auth/login` with `audience: "admin"`, and the role gate is a
   property of the caller rather than of the credential. Cheap, reversible by a
   revert, and it exercises the canonical session path with a real client.
3. **Not the reads.** Migrating `/api/admin/bookings` before the
   permission-scoped DTO is settled would freeze a shape that has to change.

**Gate to Phase 2:** the header lands and `pm2 logs | grep legacy-contract`
shows `admin=` counts.

## Phase 2 — Provider Web (`Servana.com.ph`)

The cheapest real migration, and the one that proves the contract under load.

<!-- BEGIN GENERATED: v1-moves:providerWeb -->
**17** canonical capabilities are live that this client still reaches by a legacy route.

| Move to (canonical) | Legacy routes it supersedes |
|---|---|
| `PATCH /api/v1/me` | `PUT /api/user/updateprofile` |
| `GET /api/v1/provider/document-types` | `GET /api/provider/document-types` |
| `GET /api/v1/provider/availability` | `GET /api/worker/availability` |
| `PATCH /api/v1/provider/availability` | `PUT /api/worker/availability` |
| `GET /api/v1/provider/time-off` | `GET /api/worker/time-off` |
| `POST /api/v1/provider/time-off` | `POST /api/worker/time-off` |
| `DELETE /api/v1/provider/time-off/:timeOffId` | `DELETE /api/worker/time-off/:id` |
| `GET /api/v1/settings/notification-preferences` | `GET /api/provider/notification-preferences`<br>`GET /api/workers/:uid/notification-preferences` |
| `PUT /api/v1/settings/notification-preferences` | `PUT /api/provider/notification-preferences`<br>`PUT /api/workers/:uid/notification-preferences` |
| `POST /api/v1/auth/register` | `POST /api/auth/signup`<br>`POST /api/auth/provider/register` |
| `POST /api/v1/auth/login` | `POST /api/auth/signin`<br>`POST /api/auth/admin-signin`<br>`POST /api/auth/firebase-login` |
| `POST /api/v1/auth/refresh` | `POST /api/auth/refresh` |
| `POST /api/v1/auth/forgot-password` | `POST /api/auth/forgot-password` |
| `POST /api/v1/auth/reset-password` | `POST /api/auth/reset-password` |
| `POST /api/v1/auth/resend-verification` | `POST /api/auth/resend-email-otp`<br>`GET /api/auth/resendverification` |
| `POST /api/v1/provider/jobs/:bookingId/start` | `PUT /api/worker/bookings/:bookingId/start` |
| `GET /api/v1/bookings/:bookingId/additional-work` | `GET /api/additional/booking/:bookingId` |

Caller state is recorded **per capability**, not per legacy path: this client calls one or more of the routes on the right, not all of them. `ROLE_SPECIFIC` routes are excluded — those are the ones that must not be collapsed.
<!-- END GENERATED: v1-moves:providerWeb -->

Three shape changes to plan for, none of them mechanical:

- `GET /api/auth/me` — same service already; the envelope changes from
  `{status,data}` to `{data}`.
- `GET /api/worker/job-cards` — legacy returns a **bare array**; v1 returns
  `{ data: { jobs: [...] }, meta.page }`.
- `GET/PUT /api/provider/notification-preferences` — v1 is not role-gated, since
  the preference table has no role column.

The six `PUT /api/worker/bookings/:id/*` lifecycle actions are the substantial
half. Their v1 successors run on the canonical transition executor rather than
writing status directly, so the migration is what moves this client onto the one
state machine — and it is the reason the actions ship with an `Idempotency-Key`
convention the legacy PUTs never had.

Do it behind one API-client adapter, not at 40 call sites. The envelope change
is mechanical; the risk is doing it inconsistently.

**Gate to Phase 3:** provider-web hits on those legacy routes reach zero for 14
consecutive days.

## Phase 3 — Customer Web (`servana_Customer_WebPortal`)

Not yet deployed, so it can adopt v1 as its **only** contract rather than
migrating onto it.

<!-- BEGIN GENERATED: v1-moves:customerWeb -->
**30** canonical capabilities are live that this client still reaches by a legacy route.

| Move to (canonical) | Legacy routes it supersedes |
|---|---|
| `GET /api/v1/bookings` | `GET /api/users/:userId/bookings` |
| `GET /api/v1/bookings/:bookingId` | `GET /api/:id` |
| `GET /api/v1/notifications` | `GET /api/user/notifications` |
| `GET /api/v1/notifications/unread-count` | `GET /api/user/notifications/unread-count` |
| `PATCH /api/v1/notifications/:key/read` | `PATCH /api/user/notifications/:key/read` |
| `POST /api/v1/notifications/read-all` | `POST /api/user/notifications/mark-all-read` |
| `PATCH /api/v1/me` | `PUT /api/user/updateprofile` |
| `GET /api/v1/customer/profile` | `GET /api/user/profile` |
| `PATCH /api/v1/customer/profile` | `PUT /api/user/updateprofile` |
| `GET /api/v1/customer/addresses` | `GET /api/user/alluseraddresses` |
| `POST /api/v1/customer/addresses` | `POST /api/user/adduseraddress` |
| `PATCH /api/v1/customer/addresses/:addressId` | `POST /api/user/adduseraddress` |
| `DELETE /api/v1/customer/addresses/:addressId` | `DELETE /api/user/deleteaddress` |
| `POST /api/v1/customer/addresses/:addressId/default` | `PUT /api/user/makeaddressprimary` |
| `POST /api/v1/bookings/:bookingId/review` | `POST /api/bookings/:bookingId/reviews` |
| `GET /api/v1/bookings/:bookingId/review` | `GET /api/bookings/:bookingId/reviews`<br>`GET /api/bookings/:bookingId/review-eligibility` |
| `POST /api/v1/auth/login` | `POST /api/auth/signin`<br>`POST /api/auth/admin-signin`<br>`POST /api/auth/firebase-login` |
| `POST /api/v1/auth/refresh` | `POST /api/auth/refresh` |
| `POST /api/v1/auth/logout` | `POST /api/auth/logout` |
| `POST /api/v1/auth/forgot-password` | `POST /api/auth/forgot-password` |
| `POST /api/v1/auth/reset-password` | `POST /api/auth/reset-password` |
| `POST /api/v1/conversations` | `GET /api/bookings/:bookingId/conversation` |
| `GET /api/v1/conversations` | `GET /api/chat/conversations` |
| `GET /api/v1/conversations/:conversationId` | `GET /api/chat/conversations/:id` |
| `GET /api/v1/conversations/:conversationId/messages` | `GET /api/chat/conversations/:id/messages` |
| `POST /api/v1/conversations/:conversationId/messages` | `POST /api/chat/conversations/:id/messages` |
| `POST /api/v1/conversations/:conversationId/read` | `POST /api/chat/conversations/:id/read` |
| `POST /api/v1/bookings/:bookingId/cancel` | `POST /api/bookings/:id/cancel` |
| `GET /api/v1/bookings/:bookingId/tracking` | `GET /api/:id/tracking`<br>`GET /api/booking/:bookingId/provider-location` |
| `POST /api/v1/bookings/:bookingId/payment-intents` | `POST /api/:bookingId/paymongo/create` |

Caller state is recorded **per capability**, not per legacy path: this client calls one or more of the routes on the right, not all of them. `ROLE_SPECIFIC` routes are excluded — those are the ones that must not be collapsed.
<!-- END GENERATED: v1-moves:customerWeb -->

That table is what this client is recorded as calling on a legacy route. Because
it has no installed base, it should not stop there: the full canonical surface is
in [`API_ENDPOINT_REGISTRY.md`](API_ENDPOINT_REGISTRY.md), and anything marked
**live** there is available to a client that has never shipped a legacy call.

Still legacy for this client, by design: booking **creation**, and chat. Each is
owned by a later domain command; see the matrix. Booking *cancellation* is no
longer on that list — `POST /api/v1/bookings/:bookingId/cancel` runs on the
canonical transition executor and is live.

**One-line fix to fold in while here:** `notification.types.ts` `ROUTE_KEYS` has
`MESSAGES` but not `CONVERSATION`, so the customer chat notification renders
un-clickable. Safe by design (unknown key → never navigate), but it is a dead
tap today.

## Phase 4 — Provider Mobile (ServanaWorker)

First Flutter client.

<!-- BEGIN GENERATED: v1-moves:providerMobile -->
**33** canonical capabilities are live that this client still reaches by a legacy route.

| Move to (canonical) | Legacy routes it supersedes |
|---|---|
| `GET /api/v1/bookings/:bookingId` | `GET /api/:id` |
| `GET /api/v1/notifications` | `GET /api/user/notifications` |
| `GET /api/v1/notifications/unread-count` | `GET /api/user/notifications/unread-count` |
| `PATCH /api/v1/notifications/:key/read` | `PATCH /api/user/notifications/:key/read` |
| `POST /api/v1/notifications/read-all` | `POST /api/user/notifications/mark-all-read` |
| `GET /api/v1/me/notification-preferences` | `GET /api/provider/notification-preferences` |
| `PATCH /api/v1/me/notification-preferences` | `PUT /api/provider/notification-preferences` |
| `PATCH /api/v1/me` | `PUT /api/user/updateprofile` |
| `GET /api/v1/provider/profile` | `GET /api/provider/profile` |
| `PATCH /api/v1/provider/profile` | `POST /api/provider/public-profile-revisions` |
| `GET /api/v1/provider/documents` | `GET /api/provider/documents` |
| `GET /api/v1/provider/availability` | `GET /api/worker/availability` |
| `PATCH /api/v1/provider/availability` | `PUT /api/worker/availability` |
| `GET /api/v1/settings/notification-preferences` | `GET /api/provider/notification-preferences`<br>`GET /api/workers/:uid/notification-preferences` |
| `PUT /api/v1/settings/notification-preferences` | `PUT /api/provider/notification-preferences`<br>`PUT /api/workers/:uid/notification-preferences` |
| `POST /api/v1/auth/register` | `POST /api/auth/signup`<br>`POST /api/auth/provider/register` |
| `POST /api/v1/auth/login` | `POST /api/auth/signin`<br>`POST /api/auth/admin-signin`<br>`POST /api/auth/firebase-login` |
| `POST /api/v1/auth/refresh` | `POST /api/auth/refresh` |
| `POST /api/v1/auth/logout` | `POST /api/auth/logout` |
| `POST /api/v1/auth/forgot-password` | `POST /api/auth/forgot-password` |
| `POST /api/v1/auth/reset-password` | `POST /api/auth/reset-password` |
| `POST /api/v1/auth/verify-email` | `POST /api/auth/verify-email-otp` |
| `POST /api/v1/auth/resend-verification` | `POST /api/auth/resend-email-otp`<br>`GET /api/auth/resendverification` |
| `GET /api/v1/catalog/subcategories/:subcategoryId/services` | `GET /api/services/:serviceId/options-with-addons`<br>`GET /api/:serviceId/options-with-addons` |
| `POST /api/v1/conversations` | `GET /api/bookings/:bookingId/conversation` |
| `GET /api/v1/conversations` | `GET /api/chat/conversations` |
| `GET /api/v1/conversations/:conversationId` | `GET /api/chat/conversations/:id` |
| `GET /api/v1/conversations/:conversationId/messages` | `GET /api/chat/conversations/:id/messages` |
| `POST /api/v1/conversations/:conversationId/messages` | `POST /api/chat/conversations/:id/messages` |
| `POST /api/v1/conversations/:conversationId/read` | `POST /api/chat/conversations/:id/read` |
| `GET /api/v1/provider/earnings/summary` | `GET /api/provider/earnings/summary` |
| `GET /api/v1/provider/earnings/transactions` | `GET /api/provider/earnings`<br>`GET /api/provider/ledger` |
| `GET /api/v1/provider/earnings/payouts` | `GET /api/provider/payouts` |

Caller state is recorded **per capability**, not per legacy path: this client calls one or more of the routes on the right, not all of them. `ROLE_SPECIFIC` routes are excluded — those are the ones that must not be collapsed.
<!-- END GENERATED: v1-moves:providerMobile -->

The two that matter most are `GET /api/workers/:workerId/job-cards` and
`GET/PUT /api/workers/:uid/notification-preferences`: both take the provider uid
from the **path**, which is the shape that produced a real BOLA, and the v1
successors offer no way to name another person. Also adopt `GET /api/v1/me`.

**Sequencing note:** this app already has a release blocked on **MS-02** — the
only SHA registered for `com.servana.worker` is a debug keystore, so phone auth
fails in every release build. Fold the migration into that release rather than
cutting one for it.

**Gate to Phase 5:** 90 consecutive days of zero hits on both aliases. Ninety,
not fourteen: an unupdated app keeps calling the old path for as long as it
stays installed, and no server-side measurement of the current build sees that.

## Phase 5 — Customer Mobile (ServanaClient)

Largest installed base, so last.

<!-- BEGIN GENERATED: v1-moves:customerMobile -->
**40** canonical capabilities are live that this client still reaches by a legacy route.

| Move to (canonical) | Legacy routes it supersedes |
|---|---|
| `GET /api/v1/bookings` | `GET /api/users/:userId/bookings` |
| `GET /api/v1/bookings/:bookingId` | `GET /api/:id` |
| `GET /api/v1/bookings/:bookingId/timeline` | `GET /api/:id/timeline` |
| `GET /api/v1/notifications` | `GET /api/user/notifications` |
| `GET /api/v1/notifications/unread-count` | `GET /api/user/notifications/unread-count` |
| `PATCH /api/v1/notifications/:key/read` | `PATCH /api/user/notifications/:key/read` |
| `POST /api/v1/notifications/read-all` | `POST /api/user/notifications/mark-all-read` |
| `POST /api/v1/me/devices` | `POST /api/provider/fcm-token`<br>`POST /api/user/fcm-token` |
| `DELETE /api/v1/me/devices` | `DELETE /api/provider/fcm-token`<br>`DELETE /api/user/fcm-token` |
| `PATCH /api/v1/me` | `PUT /api/user/updateprofile` |
| `GET /api/v1/customer/profile` | `GET /api/user/profile` |
| `PATCH /api/v1/customer/profile` | `PUT /api/user/updateprofile` |
| `GET /api/v1/customer/addresses` | `GET /api/user/alluseraddresses` |
| `POST /api/v1/customer/addresses` | `POST /api/user/adduseraddress` |
| `PATCH /api/v1/customer/addresses/:addressId` | `POST /api/user/adduseraddress` |
| `DELETE /api/v1/customer/addresses/:addressId` | `DELETE /api/user/deleteaddress` |
| `POST /api/v1/customer/addresses/:addressId/default` | `PUT /api/user/makeaddressprimary` |
| `POST /api/v1/bookings/:bookingId/review` | `POST /api/bookings/:bookingId/reviews` |
| `GET /api/v1/bookings/:bookingId/review` | `GET /api/bookings/:bookingId/reviews`<br>`GET /api/bookings/:bookingId/review-eligibility` |
| `POST /api/v1/auth/register` | `POST /api/auth/signup`<br>`POST /api/auth/provider/register` |
| `POST /api/v1/auth/login` | `POST /api/auth/signin`<br>`POST /api/auth/admin-signin`<br>`POST /api/auth/firebase-login` |
| `POST /api/v1/auth/refresh` | `POST /api/auth/refresh` |
| `POST /api/v1/auth/logout` | `POST /api/auth/logout` |
| `POST /api/v1/auth/forgot-password` | `POST /api/auth/forgot-password` |
| `POST /api/v1/auth/reset-password` | `POST /api/auth/reset-password` |
| `POST /api/v1/auth/verify-email` | `POST /api/auth/verify-email-otp` |
| `POST /api/v1/auth/resend-verification` | `POST /api/auth/resend-email-otp`<br>`GET /api/auth/resendverification` |
| `GET /api/v1/search` | `GET /api/services/full` |
| `GET /api/v1/catalog/categories/:categoryId/subcategories` | `GET /api/services/:serviceId/level2` |
| `POST /api/v1/conversations` | `GET /api/bookings/:bookingId/conversation` |
| `GET /api/v1/conversations` | `GET /api/chat/conversations` |
| `GET /api/v1/conversations/:conversationId` | `GET /api/chat/conversations/:id` |
| `GET /api/v1/conversations/:conversationId/messages` | `GET /api/chat/conversations/:id/messages` |
| `POST /api/v1/conversations/:conversationId/messages` | `POST /api/chat/conversations/:id/messages` |
| `POST /api/v1/conversations/:conversationId/read` | `POST /api/chat/conversations/:id/read` |
| `POST /api/v1/bookings/:bookingId/cancel` | `POST /api/bookings/:id/cancel` |
| `GET /api/v1/bookings/:bookingId/tracking` | `GET /api/:id/tracking`<br>`GET /api/booking/:bookingId/provider-location` |
| `POST /api/v1/bookings/:bookingId/otp/request` | `POST /api/:bookingId/resend-otp` |
| `POST /api/v1/bookings/:bookingId/otp/verify` | `POST /api/:id/confirm-otp` |
| `POST /api/v1/bookings/:bookingId/payment-intents` | `POST /api/:bookingId/paymongo/create` |

Caller state is recorded **per capability**, not per legacy path: this client calls one or more of the routes on the right, not all of them. `ROLE_SPECIFIC` routes are excluded — those are the ones that must not be collapsed.
<!-- END GENERATED: v1-moves:customerMobile -->

The catalog move is the substantial one: the app currently searches
**client-side** over the `/api/services/full` payload, which is why an empty
`level2` silently emptied the search cache and every query rendered "No services
match your search." A canonical tree with a canonical `services.id` removes the
class. `GET /api/v1/search` is now live and server-side, so this client can drop
the client-side scan rather than reimplement it — a change worth making in the
same release as the catalog move, since both hang off the same cache.

## Retiring an alias

All four must hold. Criteria live in code —
[`RETIREMENT_CRITERIA`](../../src/api/v1/legacyTelemetry.ts) — and the matrix is
generated from them, so this list cannot drift from what is enforced.

1. Web-only alias: **14** consecutive days of zero recorded hits.
2. Mobile alias: **90** consecutive days of zero recorded hits.
3. Every client the matrix lists for the route reads `migrated`.
4. The canonical successor is `implemented`, not `planned`.

Measure with `pm2 logs servana-prod | grep legacy-contract`. One summary line
per legacy route per hour: hits, how many carried a bearer token, and a
breakdown by client and version. No uid, no path parameter, no query string, no
raw User-Agent.

**`GET /api/:id` is a special case.** It is a live protected-client contract, it
is the reason no unknown single-segment GET can 404, and it is what swallowed
`GET /api/catalog`. Retiring it needs the criteria above **and** evidence of
zero non-numeric ids reaching it — otherwise something is still relying on the
accident.

## What this command deliberately did not migrate

Named here so the omissions are decisions rather than oversights. The list is
shorter than it was: **auth** and the **booking lifecycle transitions** were both
on it, and both have since been swept onto canonical paths by their own domain
commands — auth behind one session service, the transitions behind one executor.
That was the sequencing this document argued for, not a reversal of it.

Still deliberately not migrated:

- **Chat.** Chat endpoints do not use the `{status,data}` envelope at all — the
  store reads a top-level `conversations` key. Re-enveloping is a real client
  change and belongs with the messaging work.
- **Provider earnings.** The payout window is documented as 48h in copy and 72h
  in reality. A second read path before that is settled would give two answers
  to "when am I paid".
- **Booking creation.** Create carries pricing, payment-intent and assignment
  obligations that the read and transition paths do not. It is owned by the
  booking-creation command.
- **Admin.** The admin list carries permission-scoped columns; the DTO needs the
  permission model resolved first.

Every one of those is a `planned` entry or a `CANONICALIZE` row today, so the
matrix already names the successor a client team should expect.
