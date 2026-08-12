<!--
  GENERATED FILE - do not edit by hand.
  Source: scripts/generate-booking-docs.ts, derived from
    src/services/booking/canonicalState.ts   (states, transition whitelist)
    src/services/booking/transitionExecutor.ts (action registry)
  Regenerate: npm run booking:docs
-->

# Booking canonical state machine

11 states, 32 whitelisted transitions,
16 actions. Every lifecycle write in the
backend goes through `transitionBooking`; there are no others.

## States

A booking is in exactly one canonical state, and that state is **derived from
the locked database rows inside the transaction**, never read from a request.

| State | Group | Terminal | Ways in | Ways out |
|---|---|---|---|---|
| `PENDING_OTP` | INTAKE | — | 0 | 3 |
| `AWAITING_ASSIGNMENT` | INTAKE | — | 5 | 2 |
| `ASSIGNED` | PRE_SERVICE | — | 4 | 4 |
| `ACCEPTED` | PRE_SERVICE | — | 1 | 6 |
| `EN_ROUTE` | PRE_SERVICE | — | 1 | 5 |
| `ARRIVED` | PRE_SERVICE | — | 1 | 4 |
| `IN_PROGRESS` | SERVICE | — | 3 | 3 |
| `COMPLETED` | CLOSED | yes | 4 | 1 |
| `CANCELLED` | CLOSED | yes | 8 | 0 |
| `DISPUTED` | EXCEPTION | — | 2 | 2 |
| `EXPIRED` | CLOSED | yes | 1 | 0 |

`DISPUTED` outranks everything, including a terminal state: a dispute is
raised precisely because a booking finished wrongly, and it is the live thing
needing attention. It does not undo `COMPLETED` — the timeline keeps it.

## Transition whitelist

Keyed on `(from, to, actor)`. A transition absent from this table cannot
happen, whatever a caller asks for.

| From | To | Action | Actors | Requires |
|---|---|---|---|---|
| `PENDING_OTP` | `AWAITING_ASSIGNMENT` | `confirmOtp` | Customer, Admin | `valid_booking_otp` |
| `PENDING_OTP` | `EXPIRED` | `expire` | System | — |
| `PENDING_OTP` | `CANCELLED` | `cancel` | Customer, Admin | — |
| `AWAITING_ASSIGNMENT` | `AWAITING_ASSIGNMENT` | `confirmOtp` | Customer, Admin | `valid_booking_otp` |
| `AWAITING_ASSIGNMENT` | `ASSIGNED` | `assignProvider` | Admin, System | `provider_eligible` |
| `AWAITING_ASSIGNMENT` | `CANCELLED` | `cancel` | Customer, Admin | — |
| `ASSIGNED` | `ACCEPTED` | `accept` | Assigned provider, Admin | `current_assignment` |
| `ASSIGNED` | `AWAITING_ASSIGNMENT` | `decline` | Assigned provider | `current_assignment` |
| `ASSIGNED` | `ASSIGNED` | `reassignProvider` | Admin | `reason`, `provider_eligible` |
| `ASSIGNED` | `CANCELLED` | `cancel` | Customer, Admin | — |
| `ACCEPTED` | `EN_ROUTE` | `markEnRoute` | Assigned provider | `current_assignment` |
| `EN_ROUTE` | `ARRIVED` | `markArrived` | Assigned provider | `current_assignment` |
| `ARRIVED` | `IN_PROGRESS` | `startJob` | Assigned provider | `current_assignment`, `worker_code` |
| `ACCEPTED` | `IN_PROGRESS` | `startJob` | Assigned provider | `current_assignment`, `worker_code` |
| `EN_ROUTE` | `IN_PROGRESS` | `startJob` | Assigned provider | `current_assignment`, `worker_code` |
| `ACCEPTED` | `CANCELLED` | `cancel` | Customer, Admin | `cancellation_eligible` |
| `ACCEPTED` | `AWAITING_ASSIGNMENT` | `providerCancel` | Assigned provider | `current_assignment`, `reason`, `outside_notice_window` |
| `ACCEPTED` | `ASSIGNED` | `reassignProvider` | Admin | `reason`, `provider_eligible` |
| `EN_ROUTE` | `CANCELLED` | `cancel` | Customer, Admin | `cancellation_eligible` |
| `EN_ROUTE` | `AWAITING_ASSIGNMENT` | `providerCancel` | Assigned provider | `current_assignment`, `reason`, `outside_notice_window` |
| `EN_ROUTE` | `ASSIGNED` | `reassignProvider` | Admin | `reason`, `provider_eligible` |
| `ARRIVED` | `CANCELLED` | `cancel` | Customer, Admin | `cancellation_eligible` |
| `ARRIVED` | `AWAITING_ASSIGNMENT` | `providerCancel` | Assigned provider | `current_assignment`, `reason`, `outside_notice_window` |
| `ARRIVED` | `ASSIGNED` | `reassignProvider` | Admin | `reason`, `provider_eligible` |
| `IN_PROGRESS` | `COMPLETED` | `complete` | Assigned provider, Admin | `current_assignment` |
| `ASSIGNED` | `COMPLETED` | `approveCompletion` | Admin | `reason` |
| `ACCEPTED` | `COMPLETED` | `approveCompletion` | Admin | `reason` |
| `IN_PROGRESS` | `CANCELLED` | `cancel` | Admin | — |
| `COMPLETED` | `DISPUTED` | `raiseDispute` | Customer, Admin | — |
| `IN_PROGRESS` | `DISPUTED` | `raiseDispute` | Customer, Admin | — |
| `DISPUTED` | `COMPLETED` | `resolveDispute` | Admin | `resolution` |
| `DISPUTED` | `CANCELLED` | `resolveDispute` | Admin | `resolution` |

## Action registry

Callers name an ACTION, never a destination state. A caller that names a
destination can pick any state the machine happens to allow from where the
booking is, and so bypass the business rule that was supposed to get it there.
Naming the action makes the machine decide what it means — including which
guards apply and who may perform it.

| Action | To | Actor | From | Guard | Credential | Advisory lock | Target validation | Same target | Event only |
|---|---|---|---|---|---|---|---|---|---|
| `CUSTOMER_CONFIRM_OTP` | `AWAITING_ASSIGNMENT` | Customer | `PENDING_OTP` `AWAITING_ASSIGNMENT` | `bookingAwaitsOtpConfirmation` | `BOOKING_OTP` | — | — | — | — |
| `CUSTOMER_CANCEL` | `CANCELLED` | Customer | _any legal source_ | `customerCancellationStage` | — | — | — | — | — |
| `PROVIDER_ACCEPT` | `ACCEPTED` | Assigned provider | _any legal source_ | — | — | — | — | — | — |
| `PROVIDER_DECLINE` | `AWAITING_ASSIGNMENT` | Assigned provider | `ASSIGNED` | — | — | — | — | — | — |
| `PROVIDER_EN_ROUTE` | `EN_ROUTE` | Assigned provider | _any legal source_ | — | — | — | — | — | — |
| `PROVIDER_ARRIVED` | `ARRIVED` | Assigned provider | _any legal source_ | — | — | — | — | — | — |
| `PROVIDER_START` | `IN_PROGRESS` | Assigned provider | _any legal source_ | — | — | — | — | — | — |
| `PROVIDER_COMPLETE` | `COMPLETED` | Assigned provider | _any legal source_ | `cashPaymentSettledBeforeCompletion` | — | — | — | — | — |
| `PROVIDER_CANCEL` | `AWAITING_ASSIGNMENT` | Assigned provider | `ACCEPTED` `EN_ROUTE` `ARRIVED` | `providerCancellationWindow` | — | — | — | — | — |
| `ADMIN_ASSIGN` | `ASSIGNED` | Admin | `AWAITING_ASSIGNMENT` | — | — | `PROVIDER_ASSIGNMENT` | `FULL` | — | — |
| `AUTO_ASSIGN` | `ASSIGNED` | System | `AWAITING_ASSIGNMENT` | — | — | `PROVIDER_ASSIGNMENT` | `LEGACY_AUTO` | — | — |
| `ADMIN_REASSIGN` | `ASSIGNED` | Admin | `ASSIGNED` `ACCEPTED` `EN_ROUTE` `ARRIVED` | — | — | `PROVIDER_ASSIGNMENT` | `FULL` | `IDEMPOTENT_NO_OP` | — |
| `ADMIN_CONFIRM_ASSIGNMENT` | `ACCEPTED` | Admin | `ASSIGNED` | — | — | — | — | — | — |
| `ADMIN_CANCEL` | `CANCELLED` | Admin | `PENDING_OTP` `AWAITING_ASSIGNMENT` `ASSIGNED` `ACCEPTED` `EN_ROUTE` `ARRIVED` `IN_PROGRESS` `DISPUTED` | — | — | — | — | — | — |
| `ADMIN_APPROVE_COMPLETION` | `COMPLETED` | Admin | `ASSIGNED` `ACCEPTED` `IN_PROGRESS` | — | — | — | — | — | `yes` |
| `SYSTEM_EXPIRE` | `EXPIRED` | System | _any legal source_ | — | — | — | — | — | — |

Column meanings:

- **From** — a source restriction narrower than the whitelist. Two actions can
  share a `(to, actor)` pair, so without this a decline could be executed as a
  cancellation.
- **Guard** — a named policy consulted inside the transaction. Guards are
  read-only.
- **Credential** — a secret the caller must present, checked in the same
  statement that performs the write.
- **Advisory lock** — `pg_advisory_xact_lock`, taken AFTER the booking row
  lock. One order for every producer, so the deadlock cannot form.
- **Target validation** — how hard the assignment target is checked.
  `LEGACY_AUTO` is deliberately weaker than `FULL`; see
  `docs/TAB04_OPEN_GAPS.md`.
- **Same target** — what happens when the requested target is already the
  current one.
- **Event only** — an administrative event recorded without a state change.

## Notes carried by the machine itself

**`PENDING_OTP` → `EXPIRED` (`expire`)**

> The scheduler ages out unconfirmed bookings. No human performs this.

**`AWAITING_ASSIGNMENT` → `AWAITING_ASSIGNMENT` (`confirmOtp`)**

> A booking that reached PAID without a provider already derives as AWAITING_ASSIGNMENT, but it has NOT been OTP-confirmed: the legacy compare-and-swap accepted `status = PAID AND worker_uid IS NULL` as a confirmable source. Same canonical state either side, so this is a self-transition — but it is not a no-op. It writes CONFIRMED and releases the booking to auto-assignment. Refusing it would strand every payment-first booking holding a valid code.

**`AWAITING_ASSIGNMENT` → `ASSIGNED` (`assignProvider`)**

> Admin assigns, or auto-assignment does. A provider cannot assign themselves.

**`ASSIGNED` → `ACCEPTED` (`accept`)**

> Admin may confirm ON BEHALF (§23) — recorded with confirmationSource = admin_on_behalf_of_provider, never as if the provider clicked Accept.

**`ASSIGNED` → `AWAITING_ASSIGNMENT` (`decline`)**

> A decline returns the booking to the pool; it does not cancel it.

**`ASSIGNED` → `ASSIGNED` (`reassignProvider`)**

> Same state, different provider. The assignment history keeps both.

**`ARRIVED` → `IN_PROGRESS` (`startJob`)**

> The worker code is the six-digit secret the CUSTOMER reads out. It is the only gate on starting a chargeable job, which is why it is rate-limited per provider (middleware/workerCodeLimiter).

**`ACCEPTED` → `IN_PROGRESS` (`startJob`)**

> EN_ROUTE and ARRIVED remain OPTIONAL stages — the live app has always allowed starting from ACCEPTED, and refusing it now would strand any provider whose app predates the tracking screens. The states are first-class, not mandatory.

**`ACCEPTED` → `AWAITING_ASSIGNMENT` (`providerCancel`)**

> A provider cancelling returns the booking to the pool and triggers reassignment. 48 hours notice; inside that window support handles it.

**`ACCEPTED` → `ASSIGNED` (`reassignProvider`)**

> REASSIGNMENT RESETS THE PROGRESSION. A booking whose old provider was EN_ROUTE goes back to ASSIGNED for the new one — the new provider is not on the way, and silently carrying the old operational state over would tell the customer somebody is arriving who has not left.

**`EN_ROUTE` → `AWAITING_ASSIGNMENT` (`providerCancel`)**

> A provider cancelling returns the booking to the pool and triggers reassignment. 48 hours notice; inside that window support handles it.

**`EN_ROUTE` → `ASSIGNED` (`reassignProvider`)**

> REASSIGNMENT RESETS THE PROGRESSION. A booking whose old provider was EN_ROUTE goes back to ASSIGNED for the new one — the new provider is not on the way, and silently carrying the old operational state over would tell the customer somebody is arriving who has not left.

**`ARRIVED` → `AWAITING_ASSIGNMENT` (`providerCancel`)**

> A provider cancelling returns the booking to the pool and triggers reassignment. 48 hours notice; inside that window support handles it.

**`ARRIVED` → `ASSIGNED` (`reassignProvider`)**

> REASSIGNMENT RESETS THE PROGRESSION. A booking whose old provider was EN_ROUTE goes back to ASSIGNED for the new one — the new provider is not on the way, and silently carrying the old operational state over would tell the customer somebody is arriving who has not left.

**`ASSIGNED` → `COMPLETED` (`approveCompletion`)**

> Admin closes out a job that never reached IN_PROGRESS. Preserved from the legacy admin path, which updated assignments in ASSIGNED, ACCEPTED and IN_PROGRESS alike.

**`ACCEPTED` → `COMPLETED` (`approveCompletion`)**

> Admin closes out a job that never reached IN_PROGRESS. Preserved from the legacy admin path, which updated assignments in ASSIGNED, ACCEPTED and IN_PROGRESS alike.

**`IN_PROGRESS` → `CANCELLED` (`cancel`)**

> ADMIN ONLY. Abandoning live work is a support and safety matter, not a self-service action — neither the customer nor the provider may do it.

**`COMPLETED` → `DISPUTED` (`raiseDispute`)**

> The one route out of a terminal state, and it is deliberate: a dispute is raised precisely because the booking finished wrongly. It does not undo COMPLETED — the timeline keeps it — it opens an exception on top.

## Ordering inside the executor

```
 1. idempotency lookup          a retry must not re-run the work
 2. BEGIN
 3. SELECT ... FOR UPDATE       booking row, then assignment rows
 4. derive canonical state      from the locked rows, never the request
 5. expectedState check         optimistic concurrency, inside the lock
 6. authorize actor             from the loaded assignment, never the body
 7. same-target no-op / event-only
 8. from-restriction, then the whitelist
 9. advisory lock               provider-scoped, AFTER the booking row
10. credential, then guard
11. write booking + assignment
12. legacy projections          tracking, timeline event, status
13. append canonical transition SAME transaction
14. record idempotency          SAME transaction
15. COMMIT
16. return; notifications are emitted by the caller AFTER commit
```

Steps 3–14 are one transaction. The timeline is inside it deliberately: an
`UPDATE status; COMMIT; INSERT timeline` sequence lets operational state
change with no historical evidence, and that gap is exactly where a crash
leaves a booking that moved for no recorded reason.

Notifications are downstream and outside the transaction. Hard rule §45: a
notification failure must not roll back a committed transition.
