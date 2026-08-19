# Cross-platform impact register

Six consumers depend on this API. The rule this file exists to honour is that a
change is proven additive **by reading the consumer repositories, never by
reasoning about them**. Reasoning is how "that route is admin-only, so no client
calls it" becomes true-until-it-isn't.

Recorded 2026-08-19, covering V2 TABs 01–13.

## What is actually on this machine

| Consumer | Repository | On disk | Verified by reading |
| --- | --- | --- | --- |
| Customer Mobile | `Upupapp/ServanaClientAPP` | **yes** — `/Users/user/ServanaClientAPP` | ✅ |
| Provider Web | `PaulEspinas2020/servana_service-provider` | **yes** — `/Users/user/ServanaWorkerWeb` | ✅ |
| Admin Portal | `PaulEspinas2020/servana_adminportal` | yes | ✅ (it is the change) |
| Provider Mobile | `ServanaWorkerMObile` | no | ❌ unverified |
| Customer Web | `servana.com.ph` front end | no | ❌ unverified |
| Any other client | — | no | ❌ unverified |

Two of the four external consumers are present and were read. **A prior note in
this programme recorded `servana_service-provider` as absent from this machine —
that was wrong.** It is at `/Users/user/ServanaWorkerWeb`, 566 source files, and
it was read for this register.

## What changed that could reach a consumer

Everything in TABs 01–13 lands in one of three places: `/api/admin/*`, the v1
admin domain, or a gate that runs before a push. None of it alters a route a
customer or provider client calls. That is the claim; below is the reading.

| Change | Surface | Consumer impact |
| --- | --- | --- |
| `manualRetry` deleted; payout retry now queues | `/api/admin/finance/payouts/:id/retry` | none |
| `requirePermission` on four disbursement routes | `/api/admin/*` | none |
| v1 refund opens a review for admin actors | `POST /api/v1/bookings/:id/refunds` | **see below** |
| Refund approver ≠ requester | `/api/admin/finance/refunds/:id/approve` | none |
| New `mark-failed` terminal + `admin.refunds.markFailed` | admin only, additive | none |
| `adminRateLimit` on 18 admin route files | `/api/admin/*` | none |
| Security headers, CORP `cross-origin` | all responses | permissive; cannot break a caller |
| Every gate added in TABs 04–13 | pre-push / CI | none — nothing runtime |

## The reading

**Customer Mobile — `ServanaClientAPP`** (604 source files)

Four references to `/admin/` or `/refunds` exist and **not one is an API call**:

* `test/common/deep_links/deep_link_coordinator_test.dart:53` and
  `deep_link_resolver_test.dart:62` assert that
  `https://servana.com.ph/admin/payouts` resolves to `isFalse` / `isNull` — the
  app has a test that it REFUSES to follow admin deep links.
* `test/common/servana_urls_test.dart` references `/refunds` as a marketing page
  ("Cancellations and Refunds"), with a comment warning against inventing it.

Zero references to payout retry or to any disbursement route.

**Provider Web — `servana_service-provider`** (566 source files)

Three references to `/admin/`, and again none is a call:

* `core/contracts/provider-dispute.ts:19` names
  `POST /api/admin/bookings/:id/escalate` in a comment, recording what the
  provider *used to* depend on.
* `core/api/c50-provider-communication-stitch.spec.ts:725` is a test titled
  **"service does not expose any /admin/ path"**, asserting the negative.

Zero references to refunds.

Both consumers therefore carry their own guards against reaching the surface
this programme changed. That is a stronger result than "we did not change their
routes": they would fail their own tests if they started calling one.

## The one change with a consumer-visible edge

`POST /api/v1/bookings/:bookingId/refunds` behaves differently **for an admin
actor**: it now opens a review rather than calling the processor directly. The
customer path is unchanged, and neither consumer read here calls the endpoint at
all. Provider Mobile and Customer Web are unverified, so this is the row to check
first when either repository becomes available.

## What this register cannot say

Provider Mobile and Customer Web were **not read, so no claim is made about
them**. The honest position is not "probably fine" — it is unverified, and the
rule exists precisely because the probable answer is the one that has been wrong
before.

Closing this needs those repositories on a machine with this book. Until then
every entry above is complete for two consumers and empty for two.
