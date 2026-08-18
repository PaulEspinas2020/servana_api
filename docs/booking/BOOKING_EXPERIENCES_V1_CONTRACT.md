<!--
  GENERATED FILE - do not edit by hand.
  Source: scripts/generate-booking-docs.ts, derived from
    src/services/booking/canonicalState.ts   (states, transition whitelist)
    src/services/booking/transitionExecutor.ts (action registry)
    src/services/booking/experiencePolicy.ts (OTP purposes, tracking, reschedule, disputes, events)
    src/api/v1/contract.ts                     (endpoints, callers, legacy dispositions)
  Regenerate: npm run booking:docs
-->

# Booking experiences contract (v1)

Tracking, codes, cancellation, reschedule, additional work and disputes are
**projections of a Booking**. Every one is booking-scoped, every one is
state-validated, and none of them carries a lifecycle of its own (§60).

## 1. Endpoints and their callers

`legacy` means the client is still on the pre-v1 path listed in §7 and the
alias is live. Shared surfaces move additively until every client has migrated.

### Tracking

**One domain module:** `services/booking/bookingTrackingService`

| Endpoint | Status | Customer Mobile | Customer Web | Provider Mobile | Provider Web | Admin |
|---|---|---|---|---|---|---|
| `GET /api/v1/bookings/:bookingId/tracking` | implemented | `legacy` | `legacy` | `planned` | `migrated` | `planned` |

**Role split:** No role split. One booking-scoped endpoint answers all three actors; the provider position is withheld or disclosed by the SAME visibility rule regardless of who asks, so a provider reading their own job and a customer watching it see one authorization decision.

### Booking codes (OTP)

**One domain module:** `services/booking/bookingOtpService`

| Endpoint | Status | Customer Mobile | Customer Web | Provider Mobile | Provider Web | Admin |
|---|---|---|---|---|---|---|
| `POST /api/v1/bookings/:bookingId/otp/request` | implemented | `legacy` | `planned` | · | · | `planned` |
| `POST /api/v1/bookings/:bookingId/otp/verify` | implemented | `legacy` | `planned` | `planned` | `migrated` | `planned` |

**Role split:** No role split. One request endpoint and one verify endpoint, both scoped by `purpose`. The actor rules differ PER PURPOSE, not per client: only the holder of a code may verify it, and a provider may never request the code they are required to be told.

### Cancellation

**One domain module:** `services/booking/transitionExecutor`

| Endpoint | Status | Customer Mobile | Customer Web | Provider Mobile | Provider Web | Admin |
|---|---|---|---|---|---|---|
| `POST /api/v1/bookings/:bookingId/cancel` | implemented | `legacy` | `legacy` | · | · | · |
| `POST /api/v1/provider/jobs/:bookingId/cancel` | implemented | · | · | `legacy` | `migrated` | · |

**Role split:** Role-specific endpoints, one state machine. Customer, provider and admin cancellation are three different ACTIONS with three different guards and three different notification fan-outs — but all three are `transitionBooking` calls against the same transition whitelist, so no client can cancel from a state another client could not.

### Reschedule

**One domain module:** `services/booking/bookingRescheduleService`

| Endpoint | Status | Customer Mobile | Customer Web | Provider Mobile | Provider Web | Admin |
|---|---|---|---|---|---|---|
| `POST /api/v1/bookings/:bookingId/reschedule` | implemented | `planned` | `planned` | · | · | `legacy` |

**Role split:** No role split. The admin path differs only in which policy checks apply (an admin may move a booking inside the customer notice window), and that difference is evaluated by the same function from the same declaration below rather than by a second endpoint.

### Additional work

**One domain module:** `services/additional.service`

| Endpoint | Status | Customer Mobile | Customer Web | Provider Mobile | Provider Web | Admin |
|---|---|---|---|---|---|---|
| `POST /api/v1/bookings/:bookingId/additional-work` | implemented | · | · | `planned` | `migrated` | · |
| `GET /api/v1/bookings/:bookingId/additional-work` | implemented | `planned` | `planned` | `planned` | `legacy` | `planned` |

**Role split:** Creation is provider-only because only the provider on site can observe work the booking did not cover; the READ is shared. Approval and payment remain on the legacy `/api/additional/*` family, which Provider Web calls today, and both families call the same `additionalService` instance.

### Disputes

**One domain module:** `services/booking/bookingDisputeService`

| Endpoint | Status | Customer Mobile | Customer Web | Provider Mobile | Provider Web | Admin |
|---|---|---|---|---|---|---|
| `POST /api/v1/bookings/:bookingId/disputes` | implemented | `planned` | `planned` | `planned` | `migrated` | `legacy` |
| `GET /api/v1/bookings/:bookingId/disputes` | implemented | `planned` | `planned` | `planned` | `migrated` | `planned` |

**Role split:** No role split. One open endpoint for all three actors writing one `booking_escalations` row, so admin, provider and customer cannot disagree about whether a booking is disputed. What each actor may READ back differs; what is RECORDED does not.

## 2. One domain service per capability

This is the table that makes "one canonical domain service behind all clients"
checkable rather than aspirational. Two endpoints naming different services for
the same business operation would be two business truths wearing one name.

| Capability | Endpoint | Domain service |
|---|---|---|
| Tracking | `GET /bookings/:bookingId/tracking` | `services/booking/bookingTrackingService.getBookingTracking` |
| Booking codes (OTP) | `POST /bookings/:bookingId/otp/request` | `services/booking/bookingOtpService.requestBookingOtp` |
| Booking codes (OTP) | `POST /bookings/:bookingId/otp/verify` | `services/booking/bookingOtpService.verifyBookingOtp` |
| Cancellation | `POST /bookings/:bookingId/cancel` | `services/booking/transitionExecutor.transitionBooking (CUSTOMER_CANCEL)` |
| Cancellation | `POST /provider/jobs/:bookingId/cancel` | `services/booking/transitionExecutor.transitionBooking (PROVIDER_CANCEL)` |
| Reschedule | `POST /bookings/:bookingId/reschedule` | `services/booking/bookingRescheduleService.rescheduleBooking` |
| Additional work | `POST /bookings/:bookingId/additional-work` | `services/additional.service.additionalService.createRequest` |
| Additional work | `GET /bookings/:bookingId/additional-work` | `services/additional.service.additionalService.getByBooking` |
| Disputes | `POST /bookings/:bookingId/disputes` | `services/booking/bookingDisputeService.openDispute` |
| Disputes | `GET /bookings/:bookingId/disputes` | `services/booking/bookingDisputeService.listDisputes` |

## 3. Cancellation, centralized

Three actors, three actions, three guards — **one state machine**. Each row is
enforced by `transitionBooking`, so no client can cancel from a state another
client could not.

| Actor | Action | May cancel from | Guard | Reason required | Reason codes | Notifies |
|---|---|---|---|---|---|---|
| Customer | `CUSTOMER_CANCEL` | `PENDING_OTP` `AWAITING_ASSIGNMENT` `ASSIGNED` `ACCEPTED` | `customerCancellationStage` | no | _free text_ | assigned provider, admin |
| Assigned provider | `PROVIDER_CANCEL` | `ACCEPTED` `EN_ROUTE` `ARRIVED` | `providerCancellationWindow` | **yes** | `SCHEDULE_CONFLICT` `ILLNESS_OR_EMERGENCY` `TRANSPORT_UNAVAILABLE` `EQUIPMENT_UNAVAILABLE` `OUTSIDE_SERVICE_AREA` `CUSTOMER_REQUESTED` `OTHER` | customer, admin |
| Admin | `ADMIN_CANCEL` | `PENDING_OTP` `AWAITING_ASSIGNMENT` `ASSIGNED` `ACCEPTED` `EN_ROUTE` `ARRIVED` `IN_PROGRESS` `DISPUTED` | — | **yes** | _free text_ | customer, assigned provider |

### Financial consequences

- **Customer** — None declared. No fee, no penalty and no refund rule has been specified by the operator, and inventing one would be worse than having none.
- **Assigned provider** — Record only. C18 §26 says outright "do not invent penalties": no fee, no rating impact. Cancelling releases the booking for reassignment.
- **Admin** — Carries an explicit `refundAction`. An admin cancelling live work is the support case the other two policies escalate TO, which is why it holds neither of their guards.

Nothing computes a penalty. C18 §26 says outright "do not invent penalties", and
a fee nobody specified would be worse than none.

### Why the endpoints stay role-specific

A customer cancel, a provider cancel and an admin cancel differ in *authority*,
not in truth: the provider action carries a notice window the customer's does
not, the admin action carries neither and takes a `refundAction`, and each has
its own notification fan-out. Collapsing them would mean one endpoint branching
on the caller's role to pick a guard — which is the same three rules with the
branch moved somewhere less visible.

## 4. Booking codes (OTP)

A code is minted **for a booking and for a purpose**. Verification compares it
against the column that purpose names and refuses an actor the purpose does not
list, so a confirmation code presented as a service-start code is checked against
`worker_code` and fails. There is no "elsewhere" for a code to be reused in.

| Purpose | Column | Issuer | Recipient | Delivery | Expiry | Cooldown | Attempts | Max issues | May request | May verify | Action |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `BOOKING_CONFIRMATION` | `bookings.otp_code` | system | customer | email | 60 min | 60s | 5 | 10 | customer, admin | customer, admin | `CUSTOMER_CONFIRM_OTP` |
| `SERVICE_START` | `bookings.worker_code` | system | customer | booking_detail | 720 min | 60s | 5 | 10 | customer, admin | assigned_provider | `PROVIDER_START` |

| Purpose | Valid states | Why this lifetime |
|---|---|---|
| `BOOKING_CONFIRMATION` | `PENDING_OTP` `AWAITING_ASSIGNMENT` | Emailed at creation and on request. Sixty minutes because it arrives by email and a customer who steps away from their inbox should not lose the booking; the resend path makes a longer window unnecessary. |
| `SERVICE_START` | `ASSIGNED` `ACCEPTED` `EN_ROUTE` `ARRIVED` | Issued with the assignment and shown in the booking detail, so it must survive the whole approach — twelve hours covers a job assigned in the morning for an afternoon visit without lasting into another day. |

### The inversion that matters

`SERVICE_START`'s recipient is the **customer** and its verifier is the
**provider**. That is the entire security property: the customer reads the code
out on the doorstep and the provider types it in. So the provider may not
*request* it — a provider who could rotate this code could mint the proof they
are supposed to be given.

### What bounds a replay

- **Expiry and cooldown** are derived from `booking_otp_events`, not from a
  column on `bookings`. The newest `ISSUED` row dates the current code; the
  `FAILED` rows after it are the attempt count.
- **Only a wrong code spends an attempt.** A mistimed call is refused before the
  executor runs, so nobody can burn a customer's budget by calling at the wrong
  moment.
- **A rotation restores the budget**, because it is a new credential. Otherwise a
  resend would hand back a code that was already dead on arrival.
- **The comparison is still inside the write.** This policy layer decides whether
  an attempt is *allowed*; `transitionBooking` decides whether the code
  *matches*, in the same statement as the mutation.

### Enforced in the domain service, not the endpoint

`bookingService.confirmOtp` and `resendBookingOtp` **delegate** to the same
service. A limit only the canonical path applied would leave
`POST /api/:id/confirm-otp` — the path the shipped customer app calls — as an
unlimited guessing oracle, and the release gate would be met on paper.

## 5. Tracking authorization

Provider position is disclosed only when **all three** hold:

1. the booking has an assignment;
2. its canonical state is one of `EN_ROUTE`, `ARRIVED`, `IN_PROGRESS`;
3. the last transition into one of those states was within
   **12 hours**.

The window is measured from the provider's last *movement*, not from the
schedule: a job that started three hours late is still live, and a job that is
never completed must eventually go dark. An unknown movement time **fails
closed**.

| Withheld reason | Meaning |
|---|---|
| `NO_ASSIGNMENT` | The booking has no provider on it yet. |
| `STATE_NOT_TRACKABLE` | The provider has not set off; there is nothing to watch. |
| `WINDOW_EXPIRED` | The window closed on a job that never reached a terminal state. |
| `NO_POSITION_REPORTED` | Assigned and moving, but no position has been reported. |

A withheld position answers **200 with a reason, never 403**. The caller is
entitled to the booking; they are simply not entitled to a live location for it
yet, and those are different screens.

## 6. Reschedule

| Rule | Value |
|---|---|
| Provider acceptance required | **no** — see below |
| Customer notice | 24 hours before the CURRENT start |
| Admin notice | none — an admin override is the escalation path |
| Maximum lead | 180 days |
| Reschedulable from | `PENDING_OTP` `AWAITING_ASSIGNMENT` `ASSIGNED` `ACCEPTED` `EN_ROUTE` `ARRIVED` |
| Reason codes | `CUSTOMER_UNAVAILABLE` `PROPERTY_NOT_READY` `WEATHER` `PROVIDER_SUPPLY` `OPERATIONAL` `OTHER` |

### Why there is no acceptance step

§62 asks for proposal/acceptance **"if both parties must agree"**. They do not:
the operator's recorded policy (C18 §14/§24) is that *"the provider is NOT a
party to rescheduling — only the customer and admin may move a booking, and the
provider only responds to the outcome."* That is preserved, and the provider is
refused with `BOOKING_ACCESS_DENIED` and notified of the result.

What is **not** preserved is the silent overwrite. Every attempt writes a
`booking_reschedule_requests` row — accepted *or* refused — so a schedule
change always has a proposer, a before, an after and a reason. Flipping
`RESCHEDULE_REQUIRES_PROVIDER_ACCEPTANCE` turns that same record into an
acceptance workflow with no schema change.

### Two ways a move is prevented from being silent

- **Optimistic concurrency.** The write carries
  `schedule IS NOT DISTINCT FROM <expected>`, so two simultaneous reschedules
  produce one winner and one `BOOKING_SCHEDULE_CHANGED` — not a last-write-wins.
  `IS NOT DISTINCT FROM` rather than `=` because a NULL schedule is real and
  `NULL = NULL` is NULL.
- **Assignment consistency.** A move that would collide with the assigned
  provider's calendar is **refused**, using the same half-open overlap predicate
  the matching engine and the executor use. Releasing the assignment instead
  would need a new lifecycle transition, and inventing one here would put a
  second writer beside the executor for the operation TAB 04 centralised.

## 7. Legacy routes still serving these capabilities

| Legacy | Successor | Disposition | Why it still exists |
|---|---|---|---|
| `GET /api/:id/tracking` | `GET /api/v1/bookings/:bookingId/tracking` | ALIAS_TEMPORARILY | The live customer tracking call. It returns the raw booking_tracking rows through formatBookings and applies NO state or time-window rule to the provider position, because it never returned one — the position came from a separate route. |
| `GET /api/booking/:bookingId/provider-location` | `GET /api/v1/bookings/:bookingId/tracking` | ALIAS_TEMPORARILY | The authenticated position route. Booking-scoped already, but answers in EVERY state — a customer could watch their provider on a booking cancelled last week. This entry adds the state and time-window rules §64 requires. |
| `POST /api/:bookingId/resend-otp` | `POST /api/v1/bookings/:bookingId/otp/request` | ALIAS_TEMPORARILY | The OTP screen's Resend button. It rotates the code with no cooldown and no issue ceiling; it now delegates to the same service, so the legacy path inherits the policy rather than remaining an unlimited rotation oracle. |
| `POST /api/:id/confirm-otp` | `POST /api/v1/bookings/:bookingId/otp/verify` | ALIAS_TEMPORARILY | The live customer confirmation. Already on the executor since Phase C; it now delegates through the OTP service so expiry and the attempt limit apply to it too. Accepts the code in the query string for builds that cannot be changed. |
| `POST /api/bookings/:id/cancel` | `POST /api/v1/bookings/:bookingId/cancel` | ALIAS_TEMPORARILY | The live customer cancel. It still writes status directly and is Phase C of the executor migration — deliberately after the provider lifecycle, because cancellation touches fees, refunds and provider compensation and is the worst first test of whether the executor architecture works. |
| `POST /api/provider/bookings/:bookingId/cancel` | `POST /api/v1/provider/jobs/:bookingId/cancel` | ALIAS_TEMPORARILY | The live Provider Web / Provider Mobile cancel. It ALREADY runs the executor and the same providerCancellationWindow guard — this entry gives it a canonical path and a v1 error vocabulary, it does not give it a second implementation. |
| `GET /api/provider/bookings/:bookingId/cancellation-eligibility` | `POST /api/v1/provider/jobs/:bookingId/cancel` | KEEP | NOT a duplicate. It answers "may I cancel, and until when" without cancelling, from the same evaluateCancellation function. The canonical successor for that question is the availableActions block on GET /bookings/:id/transitions. |
| `POST /api/admin/bookings/:id/reschedule` | `POST /api/v1/bookings/:bookingId/reschedule` | ALIAS_TEMPORARILY | The admin-only predecessor, and the only reschedule that has ever existed. A bare UPDATE with no optimistic concurrency and no provider-calendar check — two admins moving one booking produced a silent winner. Kept until the portal migrates. |
| `POST /api/additional/request/:userId` | `POST /api/v1/bookings/:bookingId/additional-work` | ALIAS_TEMPORARILY | The live Provider Web call. Its :userId segment is legacy and has never been treated as identity — the provider comes from the token in both paths, and both call the same additionalService instance. |
| `GET /api/additional/booking/:bookingId` | `GET /api/v1/bookings/:bookingId/additional-work` | ALIAS_TEMPORARILY | Already booking-scoped and already the same service. The canonical path differs only in living under the booking it belongs to, which is what §60 asks for. |
| `POST /api/admin/bookings/:id/escalate` | `POST /api/v1/bookings/:bookingId/disputes` | ALIAS_TEMPORARILY | The admin-only predecessor, and the only way to open a dispute before this. Writes the same booking_escalations row; it does not record a category, the opening role or the state snapshot §66 requires. Kept until the portal migrates. |
| `GET /api/provider/bookings/:bookingId/dispute-status` | `POST /api/v1/bookings/:bookingId/disputes` | ROLE_SPECIFIC | Provider-facing eligibility summary, shipped as "entry point only; opening is later". It reads the same table and the same categories. It stays because it answers "may I open one" for a live client that has no other way to ask. |

Every one of these is counted by `api/v1/legacyTelemetry`, whose watch list is
derived from the same table. A route can only be documented as superseded if it
is also being measured.

## 8. Additional work is a child request, not a mutation

It already was: `booking_additional_requests` + `booking_additional_items`,
with its own status machine —
`PENDING_ADMIN_APPROVAL → WAITING_FOR_PAYMENT → WAITING_WORKER_APPROVAL →
ACCEPTED → IN_PROGRESS`, plus `REJECTED` and `CANCELLED`. Scope and price are
approved before work proceeds, and a rejection refunds.

TAB 06 gives it a booking-scoped canonical path and puts it on the booking
timeline. It does **not** re-model it, and approval and payment stay on the
legacy `/api/additional/*` family that Provider Web calls today — both families
call the same `additionalService` instance.

## 9. Dispute model

One record for all three actors, on `booking_escalations` — the table the admin
portal already derives `hasDispute` from, `deriveCanonicalState` already reads
to return `DISPUTED`, and the payout hold already respects. A second table would
have given admin, provider and customer different answers to "is this booking
disputed?".

| Field | Purpose |
|---|---|
| `category` | The standardized vocabulary, distinct from the legacy free-form `reason_code`. |
| `opened_by_role` | Which seat raised it. `actor_uid` alone cannot say. |
| `state_snapshot` | Service and financial state **at opening** (§66) — canonical state, raw statuses, schedule, payment status and method. No amounts, no references, no payer. |

**Categories:** `SCOPE_DISAGREEMENT` `PAYMENT_ISSUE` `CUSTOMER_CONDUCT` `PROVIDER_SAFETY` `CANCELLATION_DISAGREEMENT` `COMPLETION_DISAGREEMENT` `DAMAGE_CLAIM` `SERVICE_QUALITY` `NO_SHOW`

**Openable from:** `ACCEPTED` `EN_ROUTE` `ARRIVED` `IN_PROGRESS` `COMPLETED` `CANCELLED` `DISPUTED`. A booking
nobody has committed to has nothing to dispute — declining is the mechanism
before acceptance.

**Duplicate prevention has two layers.** The policy check refuses a second open
dispute with a renderable reason; a partial unique index refuses it in the
database. The first is the good error message, the second is the one that holds
when two people press the button in the same second.

**Never projected to any caller:** `reason`, `assigned_team`, `actor_uid` —
free text one party typed about another, internal routing, and a person. Only
`openedByYou` varies by caller.

## 10. Canonical domain events

A closed catalog. An event not declared here cannot be emitted — the emitter's
parameter type is the union of these names — so a new side effect must be named
in a diff rather than appearing as a string literal at a call site.

| Event | Capability | Timeline type | Notifies | Status | Why |
|---|---|---|---|---|---|
| `otp.issued` | otp | `booking_otp_issued` | — | emitted | The audit trail for a code being minted. Never carries the code itself. |
| `otp.verified` | otp | `booking_otp_verified` | — | emitted | The transition it authorized is recorded separately by the executor; this records that the CREDENTIAL was accepted. |
| `otp.failed` | otp | `booking_otp_failed` | — | emitted | A wrong code is evidence. Without it an attempt limit is invisible to support. |
| `reschedule.proposed` | reschedule | `booking_reschedule_proposed` | — | emitted | Written BEFORE the schedule moves, so a move always has a proposer even if applying it fails. |
| `reschedule.applied` | reschedule | `booking_rescheduled` | assigned_provider, customer | emitted | The existing admin event type, reused. The provider is not a party to the decision but must be told the outcome. |
| `reschedule.refused` | reschedule | `booking_reschedule_refused` | — | emitted | A refused move is the interesting one when a customer complains that they tried. |
| `disputes.opened` | disputes | `dispute_opened` | admin | emitted | The existing admin event type, reused so the admin timeline and the hasDispute filter keep working unchanged. |
| `additionalWork.requested` | additionalWork | `additional_work_requested` | admin | emitted | A change order is a price change. It belongs on the booking timeline, not only in the additional-work table. |
| `tracking.viewed` | tracking | `booking_tracking_viewed` | — | **declared, not emitted** | DECLARED, NOT EMITTED. A row per poll would write more history than the booking has, and location access is already bounded by the visibility rule. Kept in the catalog so the decision is visible rather than missing. |

`booking_rescheduled` and `dispute_opened` are values the admin portal already
renders. They are **reused, not renamed**: a new spelling for an existing event
is a silent break of every timeline reader.

Emission is downstream of a committed change and never fails it (§45), except
where a caller passes its own transaction and has asked for the two to be atomic.
Credentials are redacted from every event detail before it reaches a timeline row.
