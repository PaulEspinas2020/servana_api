# TAB 09 — Cross-Platform Reaction Layer: Notifications + Domain Events

## Verdict

```
NOTIFICATIONS + EVENTS VERDICT: CERTIFIED_WITH_NONBLOCKING_GAPS
```

Every release gate is met in code, with tests that were actually executed. The
gaps below are environmental or sequencing, not defects: migration 033 has not
been applied to any database because the only reachable one is production, and
no client has migrated because the platform-app repositories are out of scope
until the backend Master Command completes.

```
NOTIFICATIONS ARE EVENT-DRIVEN         YES         ✔  11 events, one projector, one declaration
CANONICAL IDS DRIVE DEEP LINKS         ENFORCED    ✔  publisher THROWS on a forbidden or missing ref
NO DUPLICATE FOR ONE IDEMPOTENT EVENT  PROVEN      ✔  both producers run, both orders, one row
UNREAD RECONCILES                      DERIVED     ✔  same store resolution for list, count, mutation
PREFERENCES ACCOUNT-SCOPED             ONE MODEL   ✔  uid-keyed, every category, no role gate
DEVICE TOKENS ACCOUNT-SCOPED           ONE STORE   ✔  token is the PK, so a device has one owner
TRANSACTIONAL OUTBOX                   REAL        ✔  published before COMMIT, inside the executor's tx
ONE INBOX CONTRACT                     3 STORES    ✔  role resolves the store; one DTO over all three
PREFERENCE OVERRIDE POLICY             DECLARED    ✔  2 transactional categories; promotions excluded
DEEP-LINK AUTHORIZATION                AFTER NAV   ✔  pointer, never a grant; endpoint re-authorizes
STALE TOKEN PRUNING                    NARROW      ✔  2 permanent error codes only; transient ignored
TELEMETRY                              7 SIGNALS   ✔  declared catalog == emitted catalog, asserted
DOCS ARE EXECUTED, NOT WRITTEN         YES         ✔  projection + override matrices are run output
MIGRATION 033 APPLIED                  NOT RUN     ⚠  deploy precondition, additive, lazily self-healing
LEGACY PRODUCERS RETIRED               0 of ~32    ⚠  deliberate — they dedupe, and retire by measurement
CLIENTS MIGRATED                       0 of 5      ⚠  out of scope until the Master Command completes
PRODUCTION SMOKE                       NOT RUN     ✖  forbidden by the standing rules
```

Branch `main`, HEAD `36ca152`. **All work is uncommitted and local.** Nothing was
pushed, deployed, or run against production.

---

## 1. The sweep

Thirty-two direct `createNotification` / `createCustomerNotification` call sites
across thirteen modules. Each hand-wrote a title, a body, a severity, a route
and — sometimes — an idempotency key. Nothing connected the notification a
provider received about an assignment to the one the customer received about the
same assignment.

| Surface | State before | State now |
| --- | --- | --- |
| Domain events | None. Every notification was a controller-specific decision. | 11 canonical events, one declaration, durable outbox. |
| `GET /api/v1/notifications` | Read `customer_notifications` ONLY. A provider got an empty array. | One inbox service; role resolves the store. |
| Preferences | `provider_notification_preferences`, uid-keyed, but gated on a provider role. Customer push never read it. | One model, every account, every category, consulted by the push decision. |
| Device tokens | Providers: a table. Customers: a single COLUMN. | `account_device_tokens` for both; legacy dual-written and still read. |
| Stale tokens | Never removed. Every send retried dead tokens forever. | Pruned on the two permanent FCM error codes. |
| Deep links | Two client vocabularies, hand-written per call site. | One target declaration, rendered into both, plus a canonical `target`. |
| Idempotency | 2 of the notification sites were KEYLESS — a retry wrote a second row. | Deterministic keys everywhere; owner-scoped unique index enforces it. |

### The four defects the sweep found

1. **The canonical inbox served one of three seats.** `notifications.list` called
   `listCustomerNotifications` directly, so a provider calling the documented
   "any authenticated caller" endpoint received an empty array — not an error,
   not a 403, just nothing — while their notifications sat in
   `provider_notifications`.

2. **Customer push ignored preferences entirely.** `sendFcmPushToCustomer` had no
   preference check at all. A customer who turned promotions off still received
   them, because nothing ever asked.

3. **Customers had no multi-device push.** A single `fcm_token` column meant a
   phone and a tablet resolved to whichever signed in last. Silently. Providers
   had had a token table for months.

4. **`target` was stripped at write time.** `sanitizeNotificationRoute`'s
   allow-list did not include it, so the one field that says unambiguously where
   a notification points never survived the write — leaving the inbox to INFER
   the target from the legacy route shape, which cannot distinguish
   `BOOKING_DETAIL` from `JOB_DETAIL` because both render the same provider
   projection. Found by `notification-dedup.test.ts` on its first run.

---

## 2. Endpoints

### Added — canonical, 4 entries

| Method | Path | Domain service |
| --- | --- | --- |
| GET | `/api/v1/me/notification-preferences` | `notificationPreferences.getPreferences` |
| PATCH | `/api/v1/me/notification-preferences` | `notificationPreferences.patchPreferences` |
| POST | `/api/v1/me/devices` | `deviceTokenService.registerDevice` |
| DELETE | `/api/v1/me/devices` | `deviceTokenService.releaseDevice` |

### Re-pointed — same paths, one service

The four existing notification entries now name
`services/events/notificationInbox.*` instead of the customer-only functions.
Their caller matrices changed from `providerMobile: n/a, providerWeb: n/a` to
`legacy` — the cells read `n/a` because the endpoint genuinely did not work for
providers, which is a defect the matrix was faithfully recording.

### On the command's path list

The command names `POST /api/v1/notifications/:notificationId/read`. The
repository already had `PATCH /api/v1/notifications/:key/read`, implemented and
documented, and `:key` IS the notification identifier — opaque, owner-scoped, and
the only handle any of the three stores exposes. The command's own instruction is
to "reuse equivalent canonical routes that already exist" and to treat the paths
as target architecture rather than blind string replacements, so the existing
route was kept and the mapping is documented in `NOTIFICATIONS_V1_CONTRACT.md` §1
rather than left as an unexplained difference.

`GET/PATCH /me/notification-preferences` was added as named. The TAB 01
`/settings/notification-preferences` pair stays: it has PUT (full replace)
semantics that Provider Web sends today, and both shapes reach one writer.

### Aliased — legacy routes still serving traffic

`GET|PUT /api/provider/notification-preferences` ·
`POST|DELETE /api/provider/fcm-token` · `POST|DELETE /api/user/fcm-token` ·
`GET /api/user/notifications*` · `PATCH /api/user/notifications/:key/read` ·
`POST /api/user/notifications/mark-all-read`

Every one is counted by `api/v1/legacyTelemetry`, whose watch list is derived
from the same contract — a route can only be documented as superseded if it is
also being measured.

### Retired

None. Nothing in this domain was found dead.

---

## 3. The architecture

### One declaration

`src/services/events/domainEvents.ts` holds no database handle and imports
nothing. It declares the events, the canonical id vocabulary (and the forbidden
one), the preference categories, the channel policy, the deep-link targets, the
telemetry signals and the caller matrix — plus four pure functions: `projectEvent`,
`mayDeliver`, `deepLinkFor`, `missingRequiredRefs`.

Four consumers: the outbox validates against it, the projector projects from it,
`scripts/generate-notification-docs.ts` executes it to write both documents, and
the tests assert against it.

### The outbox, and where it is transactional

`publishBookingEvent` is called INSIDE `transitionBooking`'s transaction, before
the `COMMIT`, threading the same `client`. So:

- roll back → no event → nobody is told about a job that does not exist;
- commit → durable event → the dispatcher will project it, now or on the next boot.

It is deliberately NOT wrapped in a catch there: a publish that cannot be written
should fail the transition, because the alternative is a committed state change
that silently notifies nobody, and that is the one place where refusing is still
cheap. Every producer downstream of a commit uses `publishEventSafely`, which
never throws — §45.

The registry's `transactional` column says which producers have the stronger
guarantee, so the document does not overstate what the platform does. Messaging,
payments, reviews, applications and reschedule commit per statement and publish
immediately after.

### Why the legacy producers are still running

Every projection reuses the EXACT notification key its legacy producer uses. The
owner-scoped unique index on `(owner_uid, notification_key)` collapses the pair
into one row, whichever wins the race. That is what let the event layer become
the producer without a flag day, and `tests/notification-dedup.test.ts` runs both
producers in both orders and counts rows rather than assuming it.

Two sites that were KEYLESS — `bookingController.createBooking` and
`paymentService.approvePayment`/`markCashPaid` — were given the projector's key.
That is a bug fix in its own right: a retried create wrote a second "Booking
received" row for the same booking.

`serviceApplicationService` is the deliberate exception. Its five keyed producers
each carry the SPECIFIC decision (approved, rejected, action required) and the
event's projection is a generic "your application has an update". Collapsing them
would lose the decision, so both are delivered and the registry records it under
`supersedes`.

### One inbox contract, three stores

`provider_notifications`, `customer_notifications` and `admin_notifications` each
have live writers, live readers and different columns. Merging them is a data
migration against the only reachable database, which is production. What the
release gate needs is one CONTRACT — one DTO, one unread definition, one ordering,
one mark-read semantic — and that is achievable now. The store is resolved from
the caller's ROLE, never from a parameter, so the three tables are three private
inboxes rather than one shared surface.

---

## 4. Tests actually executed

Full local run: **229 suites / 4,980 tests, all passing**, plus both typechecks,
the protected-contract guard and all five doc-drift checks. `npm run build`
clean. Nothing below is claimed unexecuted.

### Suites added — 4, 90 tests

| Suite | Tests | What it proves |
| --- | --- | --- |
| `notification-event-contract.test.ts` | 18 | One event reaches every seat; recipients come from the source of truth, not the payload; the actor is excluded; the publisher refuses unknown names, missing refs and `serviceFamilyId`; every declared event actually projects. |
| `notification-dedup.test.ts` | 16 | Legacy-then-event and event-then-legacy both yield ONE row; re-publish and re-dispatch add nothing; two different facts both get through; unread reconciles across list, count and both mutations; one account cannot mark another's notification read; the provider inbox defect is closed. |
| `notification-policy.test.ts` | 35 | The in-app record is never suppressed; the override applies to exactly two categories and never to promotions; PATCH changes only what it names; a device moves between accounts; releasing one device leaves the others; pruning fires only on permanent errors; deep links refuse to render without their canonical id. |
| `notification-docs-generated.test.ts` | 21 | Both documents are the generated ones and say what the code says. |

`tests/support/eventDbFake.ts` routes the REAL SQL and enforces the two unique
indexes the whole design rests on. A suite that stubbed those out would prove the
services call each other; the dedup test in particular would pass against a
database that would have written two rows.

### Suites updated — 3, because they correctly caught this work

| Suite | Why |
| --- | --- |
| `booking-single-derivation` | The projector inlined the active worker-status list — a third derivation of the worker lifecycle. Fixed by IMPORTING `chat.repository.ACTIVE_WORKER_STATUSES` rather than by adding an allow-list entry, which is the better fix and made the guard pass without weakening it. |
| `provider-disclosure` | Same root cause: the inlined list named the PII operational set. The same import fixed it. |
| `v1-router`, `suite-inventory` | Four new contract entries, four new suites (225 → 229). |

### One flake observed, not caused by this work

`tests/catalog-banner.test.ts` failed on the first full run and passed on the
second, and passes in isolation (13/13). It is a pre-existing test-isolation or
timing sensitivity in a suite this tab does not touch. Recorded here rather than
left as an unexplained green-after-red.

---

## 5. Cross-platform caller matrix

Rendered in full, with a per-capability role-split rationale, in
`NOTIFICATIONS_V1_CONTRACT.md` §3 — generated from `NOTIFICATION_CAPABILITIES`,
so it cannot drift from the contract.

Summary: **six capabilities, zero role splits.** Every surface performs the same
business operation through the same endpoint and the same domain service. Two of
the six are places a role split USED to exist and was the defect: the inbox
(which served customers only) and preferences (which were gated on a provider
role for a table with no role column).

Every cell reads `legacy`, `planned` or `—`. No client is migrated, and the
document asserts that it claims none.

---

## 6. Gaps

### P0 — none

### P1 — none

### P2 — deploy precondition

**Migration `033-domain-event-outbox.sql` has never been applied.** Two additive
tables and three indexes. `ensureOutboxSchema` and `ensureDeviceTokenSchema`
perform the same DDL lazily at first use, so a deploy without the migration
self-heals; the migration exists so a DBA can apply it deliberately.

Not applied here because the only reachable database is production, which this
work is forbidden to touch.

### P3 — sequencing and deliberate remainders

1. **No legacy producer has been retired.** That is the design, not an omission:
   they dedupe against the projector, and each can be deleted once
   `NOTIFICATION_DEDUPED` shows the projector is reaching everyone. Retiring
   them before that measurement would be trading a proven path for an unproven
   one.

2. **The dispatcher runs opportunistically, not on a timer.** `dispatchSoon()`
   fires after each publish. A crash between commit and dispatch leaves the row
   PENDING and it is picked up by the next publish — which on a quiet system
   could be a while. A scheduled sweep is the obvious next step and was left out
   deliberately: `src/scheduler.ts` is a live production surface and adding a job
   to it is a change with its own blast radius.

3. **`email` and `sms` channels are declared and unrouted.** The existing
   `send()` template path is untouched. The channels are in the policy so the
   preference matrix is complete, and the document says they route nothing.

4. **Admin notifications carry no deep link beyond a booking id**, because
   `admin_notifications` has no route column. The DTO synthesises one from
   `booking_id` and returns null otherwise.

5. **`BookingRescheduled` and `JobStarted`/`JobCompleted` projections are new
   notifications.** Nobody was told about these before. They are additive by
   definition, and the first deploy will produce notifications people have not
   previously received — worth knowing before it happens, though every one is
   preference-gated on `jobAssigned`, which is on by default.

---

## 7. The next safe deprecation step

**Add a scheduled outbox sweep, then migrate Admin Web onto
`GET /api/v1/notifications`.**

The sweep first, because it is the one thing standing between the current design
and a durability claim that holds without a subsequent publish. It is a small
job — `dispatchPending()` on a short interval — and it belongs in the same change
as the migration, since both are deploy-time concerns.

Then Admin Web, for the same reasons as TAB 08: a web client, so the retirement
window is 14 days of observed zero traffic rather than 90; no installed base to
outlive a release; and the admin inbox is currently served by
`adminNotificationService.listForAdmin` directly, so migrating it proves the
canonical route serves the third seat without retiring anything the four apps
depend on.

Then, in order: Customer Web, Provider Web, then the two mobile clients together
— mobile aliases need 90 days of observed zero traffic because an unupdated app
keeps calling the old path for as long as it stays installed.
`RETIREMENT_CRITERIA` in `api/v1/legacyTelemetry` states all of this, and the
telemetry that measures it is already running.

Individual legacy PRODUCERS (as opposed to routes) retire on a different signal:
when `NOTIFICATION_DEDUPED` for a given notification type is consistently equal
to the projector's delivery count for that type, the legacy call is provably
redundant and can be deleted. That is a per-site measurement, and it is the only
honest basis for removing a line of code that currently reaches a person's phone.
