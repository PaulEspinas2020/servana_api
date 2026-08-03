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
| Assignment / provider response | `booking_workers.status` | `ASSIGNED`, `ACCEPTED`, `IN_PROGRESS`, `COMPLETED`, `DECLINED`, `CANCELED` |
| Payment | `payments.status` | `PENDING`, `PAID`, `FAILED`, `REFUNDED` |
| Payout | `disbursements.status` | `PENDING`, `PROCESSING`, `RELEASED`, `FAILED` |
| Customer timeline | `booking_tracking.status` | `CONFIRMED`, `WORKER_ASSIGNED`, `ADDITIONAL_PAID`, `PAYMENT_PAID` |
| Additional work | `booking_additional_requests.status` | 9 values (see below) |

**The provider's own state lives in `booking_workers.status`, not in
`bookings.status`.** A client that reads only the booking row cannot tell whether
the provider has accepted, started, or finished.

## ⚠ The spelling split

`bookings.status` is written **`CANCELLED`** (double L).
`booking_workers.status` is written **`CANCELED`** (single L).

Both spellings are real and both are load-bearing. This is not cosmetic:
`getWorkerDashboard` counted the parent's spelling against the child's table, so
`cancelledJobs` read zero forever. Fixed in `2750bfd` by matching both.

**Any new query against `booking_workers` must use `CANCELED`, or accept both.**
Normalising the two is a data migration and has not been done.

## Transitions the backend actually enforces

Enforced = the `UPDATE` carries a `WHERE ... AND status = <expected>`, so an
out-of-order call changes nothing rather than corrupting state.

| From | To | Enforced at |
|---|---|---|
| `bookings.PENDING_OTP` | `CONFIRMED` | `bookingService.ts:215` |
| `booking_workers.ASSIGNED` | `ACCEPTED` | `technicianService.ts:961` |
| `booking_workers.ASSIGNED` | `DECLINED` | `technicianService.ts:1027` |
| `booking_workers.ACCEPTED` | `IN_PROGRESS` | `technicianService.ts:1144` |
| `booking_workers.IN_PROGRESS` | `COMPLETED` | `technicianService.ts:1208` |
| `booking_workers.ASSIGNED\|ACCEPTED` | `CANCELED` | `bookingService.ts:660` |
| `disbursements.PENDING` | `PROCESSING` | `disbursement.service.ts:71` |
| `payments.PAID` | `REFUNDED` | `refund.service.ts:31` |

The provider lifecycle — `ASSIGNED → ACCEPTED → IN_PROGRESS → COMPLETED` — is
fully guarded. A provider cannot start a job they have not accepted, or complete
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
| `bookings.EN_ROUTE`, `bookings.ARRIVED` | `serviceService.ts:125` | Never match |
| `bookings.REJECTED` | `providerController.ts:1641, :1715` | Never matches |
| `bookings.ACCEPTED` | `adminProviderService.ts:684` | Never matches; acceptance lives on `booking_workers` |
| `bookings.CANCELED` (single L) | `technicianService.ts:577, :831, :901` | Phantom on this table |
| `payments.REFUND_PENDING` | 3 admin sites | Never written |

**`EN_ROUTE` and `ARRIVED` do not exist anywhere in the backend.** No route, no
write, no transition. Neither client can implement arrival tracking today: this
is a platform gap, not a client gap, and no amount of frontend work closes it.

## Additional work

`booking_additional_requests.status`: `PENDING_ADMIN_APPROVAL`,
`WAITING_FOR_PAYMENT`, `WAITING_WORKER_APPROVAL`, `ACCEPTED`, `REJECTED`,
`CANCELLED`, `IN_PROGRESS`, `PROCEEDING`, `REFUNDED`.

Note `IN_PROGRESS` and `PROCEEDING` are written by two different paths for the
same action — `additional.service.ts:189` and `providerController.ts:881`. A
client must treat them as synonyms.

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
