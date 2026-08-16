# TAB 06 — Booking Experiences: Tracking, OTP, Cancel, Reschedule, Additional Work, Disputes

## Verdict

```
BOOKING EXPERIENCES VERDICT: CERTIFIED_WITH_NONBLOCKING_GAPS
```

Every release gate is met in code, with tests that were actually executed. The
gaps below are environmental or sequencing, not defects: migration 030 has not
been applied to any database because the only reachable one is production, and
no client has migrated yet because platform-app repositories are out of scope
until the backend Master Command completes.

```
EVERY RELATED ACTION BOOKING-SCOPED    YES        ✔  11 endpoints, all children of :bookingId
STATE-VALIDATED                        YES        ✔  every action gated on the canonical state
OTP REPLAY                             REFUSED    ✔  state machine + attempt budget
OTP CROSS-USE                          IMPOSSIBLE ✔  disjoint columns, disjoint actors, disjoint states
OTP EXPIRY / COOLDOWN / ATTEMPTS       ENFORCED   ✔  derived from an append-only event log
OTP POLICY ON THE LEGACY ROUTE         INHERITED  ✔  confirmOtp + resendBookingOtp delegate
TRACKING AUTHORIZATION                 STATE-LIMITED ✔ 3 conditions, fails closed, 12h window
TRACKING POSITION READ                 GATED FIRST ✔  never loaded when it may not be shown
CANCELLATION RULES ACROSS CLIENTS      IDENTICAL  ✔  3 actions, 1 state machine, matrix asserted
RESCHEDULE SILENT OVERWRITE            IMPOSSIBLE ✔  compare-and-swap + proposal record
RESCHEDULE vs ASSIGNMENT               CONSISTENT ✔  provider collision refuses, never releases
ADDITIONAL WORK                        CHILD REQUEST ✔ priced, approved, never a mutation
DISPUTE RECORD                         ONE TABLE  ✔  admin/provider/customer cannot disagree
DUPLICATE OPEN DISPUTES                PREVENTED  ✔  policy check AND partial unique index
DISPUTE STATE SNAPSHOT                 CAPTURED   ✔  service + financial state at opening
CANONICAL DOMAIN EVENTS                CLOSED SET ✔  10 declared, 9 emitted, 1 declared-not-emitted
RACES                                  ONE OUTCOME ✔ 15 interleaving tests
MIGRATION 030 APPLIED                  NOT RUN    ⚠  deploy precondition, transactional, guarded
CLIENTS MIGRATED                       0 of 5     ⚠  out of scope until the Master Command completes
POSTGRESQL LOCKING INTEGRATION         BLOCKED_BY_TEST_DATABASE  ✖  inherited from TAB 05
PRODUCTION SMOKE                       NOT RUN    ✖  forbidden by the standing rules
```

Branch `main`, HEAD `36ca152`. **All work is uncommitted and local.** Nothing was
pushed, deployed, or run against production.

---

## 1. Endpoints

### Added — canonical, 11 entries

| Endpoint | Domain service |
|---|---|
| `GET /api/v1/bookings/:bookingId/tracking` | `bookingTrackingService.getBookingTracking` |
| `POST /api/v1/bookings/:bookingId/otp/request` | `bookingOtpService.requestBookingOtp` |
| `POST /api/v1/bookings/:bookingId/otp/verify` | `bookingOtpService.verifyBookingOtp` |
| `GET /api/v1/bookings/:bookingId/otp/status` | `bookingOtpService.readCredentialState` |
| `POST /api/v1/bookings/:bookingId/reschedule` | `bookingRescheduleService.rescheduleBooking` |
| `GET /api/v1/bookings/:bookingId/reschedule` | `bookingRescheduleService.listRescheduleRequests` |
| `POST /api/v1/bookings/:bookingId/additional-work` | `additionalService.createRequest` |
| `GET /api/v1/bookings/:bookingId/additional-work` | `additionalService.getByBooking` |
| `POST /api/v1/bookings/:bookingId/disputes` | `bookingDisputeService.openDispute` |
| `GET /api/v1/bookings/:bookingId/disputes` | `bookingDisputeService.listDisputes` |
| `POST /api/v1/provider/jobs/:bookingId/cancel` | `transitionExecutor.transitionBooking (PROVIDER_CANCEL)` |

Two of the command's seven target paths already existed and were **reused, not
rebuilt**: `POST /api/v1/bookings/:bookingId/cancel` (CUSTOMER_CANCEL, canonical
since TAB 04). `otp/status` and `GET reschedule` are additions beyond the target
list — the first so a client renders "resend in 42s" from the backend instead of
its own copy of the policy, the second so "no silent overwrite" is observable to
a client and not merely true in the database.

### Changed

- `bookingService.confirmOtp` — now delegates the credential policy to
  `bookingOtpService.verifyBookingOtp`. Same executor, same legacy error message,
  same response shape.
- `bookingService.resendBookingOtp` — now delegates to
  `bookingOtpService.requestBookingOtp`. Gains a cooldown, an issue ceiling and
  an audit row.
- `bookingService.runPostConfirmationAssignment` — extracted and exported so the
  canonical and legacy confirmation paths run the identical post-commit step.
- `bookingController.resendOtp` — passes the actor derived from
  `assertBookingAccess` rather than calling anonymously.
- `booking_escalations` — three additive columns (`category`, `opened_by_role`,
  `state_snapshot`) and a partial unique index. No column altered or dropped.

### Aliased — still live, instrumented, unbroken

| Legacy | Successor | Why it stays |
|---|---|---|
| `GET /api/:id/tracking` | `bookings.tracking` | Shipped customer app |
| `GET /api/booking/:bookingId/provider-location` | `bookings.tracking` | Shipped customer app |
| `POST /api/:id/confirm-otp` | `bookings.otp.verify` | Shipped customer app |
| `POST /api/:bookingId/resend-otp` | `bookings.otp.request` | Shipped customer app |
| `POST /api/admin/bookings/:id/reschedule` | `bookings.reschedule` | Admin portal |
| `POST /api/admin/bookings/:id/escalate` | `bookings.disputes.open` | Admin portal |
| `POST /api/additional/request/:userId` | `bookings.additionalWork.create` | Provider Web |
| `GET /api/additional/booking/:bookingId` | `bookings.additionalWork.list` | Provider Web |
| `POST /api/provider/bookings/:bookingId/cancel` | `provider.jobs.cancel` | Provider Web + Mobile |

All nine are counted by `api/v1/legacyTelemetry`, whose watch list is **derived
from the contract** — a route can only be documented as superseded if it is also
being measured.

Two remain deliberately un-superseded:
`GET /api/provider/bookings/:bookingId/cancellation-eligibility` and
`GET /api/provider/bookings/:bookingId/dispute-status` answer "may I?" without
acting, from the same functions. Their canonical successor is the
`availableActions` block on `GET /bookings/:id/transitions`.

### Retired

**None.** One false claim was removed rather than added: an early draft listed
`GET /api/workers/location/:uid` as a RETIRE candidate. That route no longer
exists — it went with the worker-lookup family in an earlier tab — and naming a
deleted route as a live alias would have put a phantom row in the migration
matrix and a phantom entry in the telemetry watch list, i.e. a retirement that
looks pending forever because there is nothing left to measure.
`tests/booking-experiences-contract.test.ts` now asserts that every legacy path
this tab names is a route that is actually mounted.

---

## 2. Clients migrated

**Zero, deliberately.** Platform-app repositories are out of scope until the
backend Master Command completes, so every caller state in the contract reads
`legacy`, `planned` or `n/a` — and a test asserts that none reads `migrated`. A
`migrated` marking is a promise to a client team, and making one before the
client has moved is how a migration matrix stops being trustworthy.

Compatibility still active: all nine aliases above, plus the query-string OTP
form on `POST /api/:id/confirm-otp` for builds that cannot be changed
retroactively, plus the `data` alias on the provider-location payload.

---

## 3. Release gates, and the evidence for each

### Every related action is booking-scoped and state-validated

All 11 endpoints are children of `/bookings/:bookingId` (or
`/provider/jobs/:bookingId` for the provider action). No related resource is
addressable at the top level by its own id — asserted, so a future
`/additional-work/:id` cannot appear without failing the gate. Every action is
gated on `deriveCanonicalState`, the same derivation every other surface uses.

### OTP cannot be replayed or cross-used

Cross-use is refused three independent ways, any one of which would be enough:

- **by column** — `BOOKING_CONFIRMATION` reads `otp_code`, `SERVICE_START` reads
  `worker_code`, and a test asserts the two are disjoint;
- **by actor** — the customer may not present the service-start code and the
  provider may not present the confirmation code. The provider may not even
  *request* the service-start code: they are required to be *told* it, and a
  provider who could rotate it could mint the proof they are supposed to be given;
- **by state** — the two purposes' valid state lists do not overlap.

Replay is refused by the state machine (the booking has left the state the code
applied to) and bounded by a 5-attempt budget. **Only a wrong code spends an
attempt** — charging one for a mistimed call would let anyone burn a customer's
budget by calling at the wrong moment, turning a limit into a denial of service.

Expiry, cooldown and attempts are all derived from one append-only
`booking_otp_events` log, so there is no counter that can disagree with its own
history. A rotation restores the budget, because it is a new credential.

### Tracking authorization is state-limited

Position is disclosed only when the booking has an assignment, its state is
`EN_ROUTE`/`ARRIVED`/`IN_PROGRESS`, **and** the last transition into one of those
states was within 12 hours. An unknown movement time fails closed. The position
is **not read at all** unless the rule has already permitted it — there is no
branch in which the value exists and is discarded on the way out, which is the
shape that eventually leaks through a debug log or an added field.

A withheld position answers **200 with a named reason, never 403**: the caller is
entitled to the booking and simply not to a live location for it yet.

### Cancellation and reschedule rules are identical across clients

Cancellation is three actions on one state machine. The matrix in
`experiencePolicy` is asserted **against the executor's own declarations** — same
actor, same guard, same source states — so it is a projection that cannot drift,
not a prose copy. An admin may cancel from strictly more states than a customer,
and `IN_PROGRESS` is admin-only, which is asserted rather than assumed.

Reschedule is one endpoint for customer and admin. The only difference is the
notice window (24h vs none), evaluated by one function from one declaration.

### Races produce one authoritative outcome

15 interleaving tests. The load-bearing ones:

- two admins moving one booking → one winner, one `BOOKING_SCHEDULE_CHANGED`,
  and **both** attempts recorded;
- two reporters opening a dispute in the same instant → one record, and the loser
  gets the same code whether the policy check or the unique index refused them;
- a resend in flight while a code is being read out → only the newest code is
  live, and the superseded one is refused by the executor inside the write;
- a service-start code cannot start a booking that has already ended.

---

## 4. Tests actually executed

Every figure below was produced by a run on this machine. Nothing is claimed
that was not observed.

```
npm run verify        212 suites / 4511 tests   PASS
  ├─ typecheck (src)                            PASS
  ├─ typecheck:tests                            PASS
  ├─ guard:protected-contracts                  PASS
  ├─ api:docs:check                             PASS  (docs are the generated docs)
  ├─ booking:docs:check                         PASS  (docs are the generated docs)
  └─ test:ci  jest --runInBand --ci             PASS
npm run build         tsc                       PASS
```

Seven suites added (205 → 212), 190 tests:

| Suite | Tests | What it pins |
|---|---|---|
| `booking-experience-policy` | 48 | the declaration, against the executor and the contract |
| `booking-otp-contract` | 30 | purpose scoping, cross-use, expiry, cooldown, attempts, audit |
| `booking-tracking-authorization` | 15 | the three conditions, and that the position is not read early |
| `booking-reschedule-workflow` | 19 | proposals, notice window, compare-and-swap, conflicts |
| `booking-dispute-model` | 20 | one record, two duplicate layers, snapshot, projection |
| `booking-experience-races` | 15 | §68 interleavings |
| `booking-experiences-contract` | 33 | the v1 surface, DTOs, caller matrix, docs currency |

Five existing suites were updated because they are guards that correctly caught
this work, and each change is a policy decision made visible rather than a test
loosened:

- `booking-c-confirm-otp` — the block asserting the OTP had **no** expiry or
  attempt limit is inverted where §63 changed the policy and kept where it did
  not. The code is still not consumed; no expiry column was added; the executor
  still owns the comparison.
- `payment-before-assignment` — the guarantee that a paid-but-unassigned booking
  can still confirm and resend now follows the rule to its new home, and is
  asserted **through the real derivation** instead of by reading source.
- `resend-otp-and-tracking-shape` — each assertion names the file that now owns
  the property.
- `booking-single-derivation`, `provider-disclosure` — `experiencePolicy` added
  to the reviewed-consumer allow-lists, with the reason it is not a second
  derivation and not a PII stager.

**Production smoke: not run.** Forbidden by the standing rules, and there is no
non-production database to smoke against.

---

## 5. Gaps

### P0 — none

### P1 — migration 030 has not been applied

`scripts/migrations/030-booking-experiences.sql` creates two tables, three
additive columns and one partial unique index. It has **not** been run: the only
reachable database is production.

Mitigated, not ignored: `experienceStore.ensureExperienceSchema` performs the
same DDL lazily and is awaited by every reader and writer, following the pattern
`otpService.ensureOtpPurposeColumn` established. Unlike that one it **throws**
rather than degrading — an attempt limit that silently stops counting is a limit
that does not exist, and a reschedule proposal that silently is not written is
the silent overwrite §62 exists to prevent.

One warning for whoever applies it: the partial unique index will **fail** if any
booking already carries two unresolved escalations. That is a real data condition
to resolve, not a constraint to drop; the query to find them is in the file.

### P2 — no client has migrated

Every caller reads `legacy` or `planned`. Nothing can be retired until traffic
says so, and the retirement criteria are already declared
(`RETIREMENT_CRITERIA`: 14 days of zero hits for web, 90 for mobile, because an
unupdated app keeps calling the old path for as long as it stays installed).

### P2 — PostgreSQL locking is still unproven

Inherited from TAB 05 and unchanged. The race tests here are interleavings in one
process against a fake; they prove the ORDER of checks and writes, which is where
the application-level bugs are. They do not prove Postgres serialises two
concurrent transactions. The one place a constraint is load-bearing — duplicate
disputes — the fake enforces the unique index explicitly, so a race test cannot
pass against behaviour the database would refuse.

### P3 — the reschedule acceptance workflow is declared but unreachable

`RESCHEDULE_REQUIRES_PROVIDER_ACCEPTANCE` is `false`, matching the operator's
recorded policy (C18 §14/§24: the provider is not a party to rescheduling).
`booking_reschedule_requests.status` can already hold `PENDING_PROVIDER`, so
turning the policy around later is a flag flip and a test rather than a
migration. Flagged as a gap because the code path is unexercised.

### P3 — additional-work approval and payment remain on the legacy family

`POST /api/additional/:id/approve`, `/payment`, `/worker-decision`, `/withdraw`
and `/confirm-proceed` are unchanged and still Provider-Web-and-admin shaped.
They call the same `additionalService` instance as the canonical creation path,
so there is no second business truth — but they are not yet booking-scoped.

---

## 6. Product decisions taken from the Master Command

Recorded because they change behaviour and were not Paul's to re-litigate
mid-task; the command resolves each one explicitly.

1. **The OTP gained an expiry, a cooldown and an attempt limit.** §63 requires
   all three; `bookingService.confirmOtp` documented that none existed and that
   preserving that was right for TAB 04. The command overrides that, and Paul
   confirmed there are no live booking records, so no customer is mid-flow.
2. **The policy is enforced in the domain service, so the legacy routes inherit
   it.** A limit only the canonical endpoint applied would leave the path the
   shipped customer app calls as an unlimited oracle — the gate would be met on
   paper and not in the field.
3. **A conflicting reschedule is refused, not silently released.** §62 asks for
   assignment consistency. Releasing the assignment would need a new lifecycle
   transition, and inventing one here would put a second writer beside the
   executor for exactly the operation TAB 04 centralised. Refusing is additive
   and leaves the operator a real choice: reassign, then move.

---

## 7. Next safe deprecation step

**Not a deletion.** In order:

1. Apply `030-booking-experiences.sql` to a **non-production** database, after
   running the duplicate-escalation query in its header.
2. Deploy the backend. The aliases keep every client working unchanged.
3. Read `[legacy-contract]` telemetry for the nine aliased routes for one week.
   The two admin-portal routes (`reschedule`, `escalate`) are the cheapest first
   migration: one client, no installed base, and both already answer through the
   canonical services.
4. Migrate Admin Web to `POST /api/v1/bookings/:id/reschedule` and
   `POST /api/v1/bookings/:id/disputes`, flip those callers to `migrated`, and
   only then start the 14-day zero-traffic clock on the two legacy admin routes.

Customer-mobile aliases are last, and on the 90-day clock: `confirm-otp`,
`resend-otp` and `tracking` are called by builds already in people's hands.
