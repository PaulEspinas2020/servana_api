<!--
  GENERATED FILE - do not edit by hand.
  Source: scripts/generate-booking-docs.ts, derived from
    src/services/booking/canonicalState.ts   (states, transition whitelist)
    src/services/booking/transitionExecutor.ts (action registry)
  Regenerate: npm run booking:docs
-->

# Booking legacy status → canonical state migration matrix

Produced by RUNNING `deriveCanonicalState` over the cross-product of legacy
values, not by describing it. If the mapping changes, this table changes with
it.

## The grid

Rows are `bookings.status`; columns are the latest `booking_workers.status`.
`worker_uid` is populated wherever an assignment row exists.

| `bookings.status` \ `booking_workers.status` | _none_ | `ASSIGNED` | `ACCEPTED` | `EN_ROUTE` | `ARRIVED` | `IN_PROGRESS` | `COMPLETED` | `DECLINED` | `REASSIGNED` | `CANCELLED` |
|---|---|---|---|---|---|---|---|---|---|---|
| `PENDING_OTP` | `PENDING_OTP` | `ASSIGNED` | `ACCEPTED` | `EN_ROUTE` | `ARRIVED` | `IN_PROGRESS` | `COMPLETED` | `AWAITING_ASSIGNMENT` | `AWAITING_ASSIGNMENT` | `AWAITING_ASSIGNMENT` |
| `CONFIRMED` | `AWAITING_ASSIGNMENT` | `ASSIGNED` | `ACCEPTED` | `EN_ROUTE` | `ARRIVED` | `IN_PROGRESS` | `COMPLETED` | `AWAITING_ASSIGNMENT` | `AWAITING_ASSIGNMENT` | `AWAITING_ASSIGNMENT` |
| `PAID` | `AWAITING_ASSIGNMENT` | `ASSIGNED` | `ACCEPTED` | `EN_ROUTE` | `ARRIVED` | `IN_PROGRESS` | `COMPLETED` | `AWAITING_ASSIGNMENT` | `AWAITING_ASSIGNMENT` | `AWAITING_ASSIGNMENT` |
| `WORKER_ASSIGNED` | `AWAITING_ASSIGNMENT` | `ASSIGNED` | `ACCEPTED` | `EN_ROUTE` | `ARRIVED` | `IN_PROGRESS` | `COMPLETED` | `AWAITING_ASSIGNMENT` | `AWAITING_ASSIGNMENT` | `AWAITING_ASSIGNMENT` |
| `COMPLETED` | `COMPLETED` | `COMPLETED` | `COMPLETED` | `COMPLETED` | `COMPLETED` | `COMPLETED` | `COMPLETED` | `COMPLETED` | `COMPLETED` | `COMPLETED` |
| `CANCELLED` | `CANCELLED` | `CANCELLED` | `CANCELLED` | `CANCELLED` | `CANCELLED` | `CANCELLED` | `CANCELLED` | `CANCELLED` | `CANCELLED` | `CANCELLED` |
| `CANCELED` | `CANCELLED` | `CANCELLED` | `CANCELLED` | `CANCELLED` | `CANCELLED` | `CANCELLED` | `CANCELLED` | `CANCELLED` | `CANCELLED` | `CANCELLED` |
| `REFUNDED` | `CANCELLED` | `CANCELLED` | `CANCELLED` | `CANCELLED` | `CANCELLED` | `CANCELLED` | `CANCELLED` | `CANCELLED` | `CANCELLED` | `CANCELLED` |
| `FAILED` | `CANCELLED` | `CANCELLED` | `CANCELLED` | `CANCELLED` | `CANCELLED` | `CANCELLED` | `CANCELLED` | `CANCELLED` | `CANCELLED` | `CANCELLED` |
| `EXPIRED` | `EXPIRED` | `EXPIRED` | `EXPIRED` | `EXPIRED` | `EXPIRED` | `EXPIRED` | `EXPIRED` | `EXPIRED` | `EXPIRED` | `EXPIRED` |
| `SOME_UNRECOGNISED_STATUS` | `AWAITING_ASSIGNMENT` | `ASSIGNED` | `ACCEPTED` | `EN_ROUTE` | `ARRIVED` | `IN_PROGRESS` | `COMPLETED` | `AWAITING_ASSIGNMENT` | `AWAITING_ASSIGNMENT` | `AWAITING_ASSIGNMENT` |

## Why an ended assignment reads as `AWAITING_ASSIGNMENT`

`DECLINED`, `REASSIGNED` and `CANCELLED` all mean the assignment row is
closed. `bookings.status` is **not** rewritten when a provider declines —
the legacy path cleared `worker_uid` and closed the row, leaving the booking
at `WORKER_ASSIGNED`. Reading only `bookings.status` therefore reported
`ASSIGNED` for a booking with no provider on it, and allowed the provider who
had just declined to accept the same job again.

## Where `worker_uid` decides the answer

With no assignment row at all, three legacy statuses are ambiguous, and the
distinction between "looked and found nobody" (`null`) and "did not look"
(`undefined`) is load-bearing.

| `bookings.status` | `worker_uid` set | `worker_uid` `null` | `worker_uid` `undefined` |
|---|---|---|---|
| `WORKER_ASSIGNED` | `ASSIGNED` | `AWAITING_ASSIGNMENT` | `ASSIGNED` |
| `CONFIRMED` | `ASSIGNED` | `AWAITING_ASSIGNMENT` | `AWAITING_ASSIGNMENT` |
| `PAID` | `ASSIGNED` | `AWAITING_ASSIGNMENT` | `AWAITING_ASSIGNMENT` |

A two-column caller cannot know which case it is in, so it keeps the old
answer. Admin passes the column explicitly and gets the accurate one. Guessing
for the two-argument caller would change a wire value on the strength of a
field it never supplied.

## Escalation outranks everything

`COMPLETED` + `COMPLETED` + an open escalation derives `DISPUTED`.

## `PAID` and `CONFIRMED` collapse

Both map to `AWAITING_ASSIGNMENT`, which loses the distinction between "paid
but not yet OTP-confirmed" and "confirmed, awaiting a provider". This is
guard-compensated for TAB 04 rather than modelled, and carries an explicit
promotion trigger in `docs/TAB04_OPEN_GAPS.md`.
