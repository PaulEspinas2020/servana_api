# Servana provider status matrix

**Command 3 §6 and §7 deliverable.** Every value and transition below was read
out of the source; nothing is aspirational. Where the platform documentation and
the code disagree, the code is recorded and the disagreement is noted.

## There is no single booking status. There are six lifecycles.

This is the central fact. A "booking status" is not one field, and the six are
independent by design — §7 requires exactly this separation, and the schema
already has it.

| Dimension | Column | Values |
|---|---|---|
| Booking lifecycle | `bookings.status` | `PENDING_OTP`, `CONFIRMED`, `WORKER_ASSIGNED`, `PAID`, `COMPLETED`, `CANCELLED`, `REVIEWED` |
| Assignment / provider response | `booking_workers.status` | `ASSIGNED`, `ACCEPTED`, `EN_ROUTE`, `ARRIVED`, `IN_PROGRESS`, `COMPLETED`, `DECLINED`, `CANCELLED` |
| Payment | `payments.status` | `PENDING`, `PAID`, `FAILED`, `REFUNDED` |
| Payout | `disbursements.status` | `PENDING`, `PROCESSING`, `RELEASED`, `FAILED` |
| Customer timeline | `booking_tracking.status` | `CONFIRMED`, `WORKER_ASSIGNED`, `ADDITIONAL_PAID`, `PAYMENT_PAID` |
| Additional work | `booking_additional_requests.status` | 9 values (see below) |

**The provider's own state lives in `booking_workers.status`, not in
`bookings.status`.** A client that reads only the booking row cannot tell whether
the provider has accepted, started, or finished.

## The spelling split — resolved

`booking_workers.status` used to be written **`CANCELED`** (single L) while
`bookings.status` used **`CANCELLED`** (double L). Both were load-bearing, and
`getWorkerDashboard` crossed them — counting the parent's spelling against the
child's table — so `cancelledJobs` read zero forever.

**`CANCELLED` is now the only spelling written** (`aad7dc9`). Reads still accept
both, deliberately: a query matching only the canonical spelling against rows
written before `scripts/normalise-cancelled-spelling.ts` has run reintroduces
exactly the bug that was removed. Keep reads tolerant until that script has run
everywhere.

## Transitions the backend actually enforces

Enforced = the `UPDATE` carries a `WHERE ... AND status = <expected>`, so an
out-of-order call changes nothing rather than corrupting state.

| From | To | Enforced at |
|---|---|---|
| `bookings.PENDING_OTP` | `CONFIRMED` | `bookingService.ts:215` |
| `booking_workers.ASSIGNED` | `ACCEPTED` | `technicianService.ts:961` |
| `booking_workers.ASSIGNED` | `DECLINED` | `technicianService.ts:1027` |
| `booking_workers.ACCEPTED` | `EN_ROUTE` | `technicianService.ts` (`markEnRoute`) |
| `booking_workers.EN_ROUTE` | `ARRIVED` | `technicianService.ts` (`markArrived`) |
| `booking_workers.ACCEPTED\|EN_ROUTE\|ARRIVED` | `IN_PROGRESS` | `technicianService.ts:1144` |
| `booking_workers.IN_PROGRESS` | `COMPLETED` | `technicianService.ts:1208` |
| `booking_workers.ASSIGNED\|ACCEPTED\|EN_ROUTE\|ARRIVED` | `CANCELLED` | `bookingService.ts:660` |
| `disbursements.PENDING` | `PROCESSING` | `disbursement.service.ts:71` |
| `payments.PAID` | `REFUNDED` | `refund.service.ts:31` |

The provider lifecycle — `ASSIGNED → ACCEPTED → [EN_ROUTE → ARRIVED] → IN_PROGRESS
→ COMPLETED` — is fully guarded. The two bracketed stages are optional. A provider cannot start a job they have not accepted, or complete
one they have not started.

## Transitions that are NOT guarded

These write unconditionally from any prior state. Each is a real behaviour a
client must expect.

| Transition | Where | Consequence |
|---|---|---|
| any → `bookings.PAID` | `paymentService.ts:472` | **The PayMongo webhook clobbers the lifecycle status.** A `COMPLETED` booking becomes `PAID`. Payment state is overwriting booking state, which is precisely what §7 forbids. |
| any → `bookings.WORKER_ASSIGNED` | `adminBookingService.ts:779, :844` | Admin can assign over a `COMPLETED` or `CANCELLED` booking |
| any → `bookings.CONFIRMED` + `worker_uid = NULL` | `technicianService.ts:1059` | After a decline the booking returns to the queue |
| `COMPLETED\|REVIEWED\|PAID` → `REVIEWED` | `customerReviewService.ts:271` | A review overwrites `COMPLETED` |

`acceptJob` does **not** touch `bookings.status`. The parent stays
`WORKER_ASSIGNED` after the provider accepts — acceptance is visible only on the
assignment row.

## Phantom statuses — read, never written

These appear in `WHERE` clauses and match nothing. Each one is a feature that
silently does not work.

| Phantom | Read at | Effect |
|---|---|---|
| `bookings.IN_PROGRESS` | `providerController.ts:222` | `activeJob` was always null while a job ran. **Fixed in `2750bfd`** |
| ~~`bookings.EN_ROUTE`, `bookings.ARRIVED`~~ | `serviceService.ts:125` | **No longer phantom** — written by `markEnRoute`/`markArrived` |
| `bookings.REJECTED` | `providerController.ts:1641, :1715` | Never matches |
| `bookings.ACCEPTED` | `adminProviderService.ts:684` | Never matches; acceptance lives on `booking_workers` |
| `bookings.CANCELED` (single L) | `technicianService.ts:577, :831, :901` | Phantom on this table |
| `payments.REFUND_PENDING` | 3 admin sites | Never written |

**`EN_ROUTE` and `ARRIVED` now exist.** Added as optional stages between
`ACCEPTED` and `IN_PROGRESS`, guarded like every other transition, cascaded to
`bookings.status`, with `booking_tracking` events. `startJob` accepts `ACCEPTED`,
`EN_ROUTE` or `ARRIVED`, so a provider who skips them is unaffected.

## Additional work

`booking_additional_requests.status`: `PENDING_ADMIN_APPROVAL`,
`WAITING_FOR_PAYMENT`, `WAITING_WORKER_APPROVAL`, `ACCEPTED`, `REJECTED`,
`CANCELLED`, `IN_PROGRESS`, `PROCEEDING`, `REFUNDED`.

`IN_PROGRESS` is canonical for newly confirmed work. Historical `PROCEEDING`
rows remain valid and clients must continue treating the two values as synonyms
until deployed data is normalized.

**Payment status is not agreement status.** A request can sit at `ACCEPTED`,
`IN_PROGRESS` or `PROCEEDING` with the customer having paid nothing. Provider pay
keys on `payments.status = 'PAID'`, never on the request status — see
`disbursement.service.ts`.

## Rules for clients

1. **Read the dimension you mean.** Provider state is `booking_workers.status`.
2. **Never infer permission from a status label.** Ask the backend what actions
   are available (§8).
3. **Unknown values must fail safe** — render as "unknown", never crash, never
   assume terminal.
4. **Do not add a status to represent an actor.** Who did something belongs in
   metadata (`confirmationSource`, `adminActorUid`), not in a new status value.
