<!--
  GENERATED FILE - do not edit by hand.
  Source: scripts/generate-booking-docs.ts, derived from
    src/services/booking/canonicalState.ts   (states, transition whitelist)
    src/services/booking/transitionExecutor.ts (action registry)
  Regenerate: npm run booking:docs
-->

# Booking actor / transition permission matrix

Who may do what, derived from the same declarations the executor enforces.

An actor is resolved from the authenticated token and, for a provider, from the
**loaded assignment row** — never from an id in a request body. Hard rule §11:
ids are identifiers, not authorization.

## Action ownership

Each action has exactly one actor. `assigned_provider` means the provider
currently holding the booking, proven from the locked row.

| Action | Customer | Assigned provider | Admin | System |
|---|---|---|---|---|
| `CUSTOMER_CONFIRM_OTP` | ✅ | · | · | · |
| `CUSTOMER_CANCEL` | ✅ | · | · | · |
| `PROVIDER_ACCEPT` | · | ✅ | · | · |
| `PROVIDER_DECLINE` | · | ✅ | · | · |
| `PROVIDER_EN_ROUTE` | · | ✅ | · | · |
| `PROVIDER_ARRIVED` | · | ✅ | · | · |
| `PROVIDER_START` | · | ✅ | · | · |
| `PROVIDER_COMPLETE` | · | ✅ | · | · |
| `PROVIDER_CANCEL` | · | ✅ | · | · |
| `ADMIN_ASSIGN` | · | · | ✅ | · |
| `AUTO_ASSIGN` | · | · | · | ✅ |
| `ADMIN_REASSIGN` | · | · | ✅ | · |
| `ADMIN_CONFIRM_ASSIGNMENT` | · | · | ✅ | · |
| `ADMIN_CANCEL` | · | · | ✅ | · |
| `ADMIN_APPROVE_COMPLETION` | · | · | ✅ | · |
| `SYSTEM_EXPIRE` | · | · | · | ✅ |

## What each actor may do from each state

Taken from the transition whitelist, so it includes machine-level transitions
that no action currently exposes.

| State | Customer | Assigned provider | Admin | System |
|---|---|---|---|---|
| `PENDING_OTP` | `confirmOtp` `cancel` | · | `confirmOtp` `cancel` | `expire` |
| `AWAITING_ASSIGNMENT` | `confirmOtp` `cancel` | · | `confirmOtp` `assignProvider` `cancel` | `assignProvider` |
| `ASSIGNED` | `cancel` | `accept` `decline` | `accept` `reassignProvider` `cancel` `approveCompletion` | · |
| `ACCEPTED` | `cancel` | `markEnRoute` `startJob` `providerCancel` | `cancel` `reassignProvider` `approveCompletion` | · |
| `EN_ROUTE` | `cancel` | `markArrived` `startJob` `providerCancel` | `cancel` `reassignProvider` | · |
| `ARRIVED` | `cancel` | `startJob` `providerCancel` | `cancel` `reassignProvider` | · |
| `IN_PROGRESS` | `raiseDispute` | `complete` | `complete` `cancel` `raiseDispute` | · |
| `COMPLETED` | `raiseDispute` | · | `raiseDispute` | · |
| `CANCELLED` | · | · | · | · |
| `DISPUTED` | · | · | `resolveDispute` | · |
| `EXPIRED` | · | · | · | · |

## The two authorization failures that are not the same

- `NOT_AUTHORIZED` — this actor may never do this, for this booking.
- `INVALID_TRANSITION` — this actor may do it, but not from here.

They are kept distinct because collapsing them makes a permission bug and a
sequencing bug indistinguishable in production logs, and only one of the two is
a security matter.
