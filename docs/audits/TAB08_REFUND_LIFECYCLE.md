# TAB 08 — the refund review lifecycle

> **Partially closes F-11.** The live bypass is closed; the v1 lifecycle is
> specified and NOT built. Implemented 2026-08-18 against `servana_api` at `fd743a2`.

---

## 1. What was found is worse than what was recorded

The book records F-11 as **P1**: *"v1 has one unpermissioned
`POST /bookings/:id/refunds` and no review lifecycle. Migrating as drawn would
destroy a modelled separation of duties."*

That describes a **future** risk taken on at migration. Reading the code, the
risk is **already live**. The complete path:

```
POST /api/v1/bookings/:bookingId/refunds
  contract entry:  auth: 'authenticated', NO permission
  actor:           assertBookingAccess() → 'admin' for any role-1 user,
                   on ANY booking
  handler:         refundBookingPayment()
  admin branch:    refundService.forceRefund()
                     → POST https://api.paymongo.com/v1/refunds
                     → money gone, inside the request
```

Against the legacy admin surface, which demands four steps behind four named
permissions with a `requires` chain:

| Step | Permission | Risk level |
| --- | --- | --- |
| open a review | `refunds.review.open` | high |
| approve | `refunds.approve` | **critical** |
| reject | `refunds.reject` | high |
| mark processed | `refunds.mark_processed` | high |

**So an admin deliberately denied `refunds.approve` could issue a refund by
calling the customer's endpoint.** One POST, no named permission, no review, no
second actor.

This is structurally identical to F-01 on the payout surface — a second, quieter
path to a capability whose guard lives somewhere else — and unlike F-01 it is
reachable in production today, because v1 is deployed and all 98 probeable
routes answer. On the evidence it is a **P0**, not a P1.

## 2. What was changed, and why it is not the shortcut the book forbids

The book is explicit: *"DO NOT SHORTCUT THIS BY ADDING PERMISSIONS TO THE
EXISTING V1 ROUTE. The gap is not a missing guard, it is a missing workflow."*

That is right, and it is why the fix is **not** `requirePermission`. A single
permissioned refund call still collapses request, review, approval and
processing into one actor and one moment — exactly the control the legacy design
encodes. Adding a permission would have closed the privilege hole and quietly
blessed the collapse.

**The money path is removed instead.** Every actor reaching
`refundBookingPayment` now opens a review; refunds complete through the
reviewed, permissioned admin surface. The `refund.service` import went with it,
because leaving the dependency is an invitation to re-add the call. The
fall-through now raises `PAYMENT_ACTOR_NOT_PERMITTED` rather than reaching a
processor.

That is strictly safer than a permission check, and it is the direction the
lifecycle has to go anyway.

## 3. What this costs, stated rather than buried

A v1 client can no longer complete a refund in one call. Measured before
changing it:

- `refundBookingPayment` has **exactly one caller** — the v1 handler;
- the admin portal issues refunds through `/api/admin/finance/refunds/*`,
  which is untouched;
- the two mobile clients call this endpoint **as customers**, which is
  unchanged — `outcome: 'requested'` is what they already receive.

So the capability removed is one with no known caller. **That is an argument
from measurement, not from certainty**: the four client repositories are not on
this machine, and §4 demands additive-ness be proven by reading them. Manual
task 08.1.

## 4. The lifecycle is NOT built, and that is the honest headline

TAB 08's full scope is a first-class refund case with an explicit state machine
(`requested → under_review → approved|rejected → processed|failed`), one
canonical executor, a v1 route and named permission per transition, a
server-enforced `requires` chain, an approver-≠-requester rule, immutable audit
per transition, and idempotency keys.

**None of that is built here.** What is built is the removal of the bypass.

The sequencing is deliberate. The lifecycle exists to make refunds
*migratable*; migration is TAB 07, which is blocked because the portal
repository is not on this machine. The bypass, by contrast, is live now. Closing
a live authorization hole first and building the workflow that unblocks a
blocked migration second is the correct order — and doing the second without the
first would have left the hole open for however long the build took.

### 4.1 The design, recorded so it is not re-derived

| Transition | v1 route | Permission | Rule |
| --- | --- | --- | --- |
| open | `POST /v1/admin/refunds` | `refunds.review.open` | one open review per booking |
| review | `POST /v1/admin/refunds/:id/review` | `refunds.review.open` | `requested → under_review` |
| approve | `POST /v1/admin/refunds/:id/approve` | `refunds.approve` (**critical**) | **approver ≠ requester**, enforced in the executor |
| reject | `POST /v1/admin/refunds/:id/reject` | `refunds.reject` | reason required |
| mark processed | `POST /v1/admin/refunds/:id/mark-processed` | `refunds.mark_processed` | only from `approved` |

Four points that must not be lost when it is built:

1. **The approval boundary is a rule in the executor, not a UI affordance.**
   Hiding a button is not authorization (§12).
2. **`requires` is enforced server-side.** A state machine that trusts the
   client's claimed current state is not a control.
3. **Idempotency keys, because this is money** (§17). A double-click, a retry or
   a network replay must produce one refund. Disabling a button is not
   sufficient.
4. **`trigger` must be mapped honestly.** Its seven values have no legacy
   equivalent — legacy `reason` is free text. Either derive it (lossy, and
   lossiness on a money record must be a deliberate, recorded decision) or
   require it only on new cases and leave historic ones null. Decide explicitly.

## 5. Gates

```
npm run verify        PASS exit 0 — 287 suites, 6090 tests
npm run authz:legacy  PASS exit 0
tests/v1-refund-no-money-path.test.ts   12 tests
```

**Mutation-verified:** reintroducing `refundService.forceRefund()` in the admin
branch — the exact code that was there — fails the gate.

The assertions are deliberately about the **source**, with comments stripped
first. The behavioural half (an admin call returns `outcome: 'requested'`) is
covered by the finance domain suites; what a behavioural test cannot catch is
somebody reintroducing a processor call in a branch no fixture exercises.

### 5.1 One run segfaulted, and it is recorded rather than ignored

The first full `npm run verify` after this change exited **139 (SIGSEGV)** part
way through the suite. The re-run passed at 287/287, and a third full gate passed
again.

Not silently retried: a segfault is a crash, not a flake, and writing it off is
how a real fault gets absorbed into folklore. The probable cause is machine
contention — a second workstream has been committing to this repository
throughout the session, the crashing run took 80s against a normal 10s, and both
runs load PGlite's WASM engine. That is an explanation, **not a diagnosis**. If
it recurs on a quiet machine it is a real defect and should be treated as one.

## 6. What could NOT be done here

| Item | State | Why |
| --- | --- | --- |
| Build the lifecycle (§4) | **NOT DONE** | Deliberate sequencing, see §4. Manual task 08.2. |
| Prove no client relied on the v1 admin refund path | **NOT DONE** | `NO-REPO`. Manual task 08.1. |
| Decide the `trigger` mapping | **NOT DONE** | `HUMAN-JUDGEMENT` — lossiness on a money record is a decision, not a default. Manual task 08.3. |
| Confirm no in-flight refund depended on the removed path | **NOT DONE** | `PROD-ACCESS`. Manual task 08.4. |
