# TAB 10 — Refunds and payouts: confirm the amount model (P2)

## Verdict

```
NEITHER OF THE BOOK'S TWO ANSWERS                             CERTIFIED

Partial refunds                          BUILT, not "coming"
An operator-entered amount               ACCEPTED — by openRefundReview
A server-supplied ceiling                ENFORCED already, and undisclosed
Two ceilings that disagree               FOUND, proven, documented
RefundTransitionResult.status ['failed'] CONFIRMED intended
```

## The question, and why the book got a "no" it should have got a "yes" to

> **The question.** No admin money endpoint accepts an operator-entered amount.
> Confirm that is intended.

It is not the case. `adminFinanceService.openRefundReview` takes
`amount: number` — required, not optional — and refuses `amount > remaining`
with a `BUSINESS_RULE` error.

The book enumerated the review **transitions** and found no amount on any:

```
approveRefund        (refundId)
rejectRefund         (refundId, rejectionReason)
markRefundProcessed  (refundId, refundReference)
holdPayout           (disbursementId, holdReason, holdUntil?)
```

That is correct, and it is the **right** design: the amount is fixed once, when
the review is opened, and the transitions act on the recorded review rather than
re-deciding it. There is exactly one place an operator names a figure, and the
book did not reach it because it is the *open* call, not a transition.

So the portal's rule — *"money is displayed, never computed"* — holds
everywhere the book looked, and holds for a better reason than it assumed.

**Answer to the book: option 2, already done.** Partial refunds are not coming;
they are here, and they are bounded.

## The finding — the ceiling shown and the ceiling enforced are two numbers

The book's next ask is the one that would have caused a defect:

> If partial refunds are planned, send `refundable` … alongside so the UI can
> bound the input and the server can refuse anything above it.

`refundable` is the **wrong number to bound with**, and it is larger.

| | Formula | Scope |
| --- | --- | --- |
| `BookingPayment.refund.refundable` | `gross − refundedAmount`, where `gross = final_price + paid additional work` | **booking** |
| `openRefundReview`'s guard | `payments.amount − refunded_amount` for the one row named by `paymentId` | **payment** |

Paid additional work is charged through its **own** `payments` row —
`earningsBasis.paidAdditionalWorkSql` sums `payments` where
`additional_request_id IS NOT NULL`. So the base payment row holds only the base
amount, while the booking-level figure includes the extra.

Proven, not argued. On `final_price 1500` with `400` of paid additional work:

```
shown    (refundable)        1900
enforced (payment remaining) 1500
gap                           400   == exactly the additional work
```

and asserted across `0.01`, `1`, `99.99` and `5000` of additional work, because
one example could be arithmetic luck.

**The failure this produces.** An operator bounded by the disclosed ceiling
enters the number the system showed them, and the same system refuses it — with
a message that explains nothing, because the figure came from the system itself.

## What was changed, and what deliberately was not

**Changed: the contract now says which ceiling `refundable` is.** It states that
it is booking-level, that additional work is charged separately, that
`openRefundReview` bounds by the payment instead, and the instruction that
follows: *bound by the payment, display this.*

**Not changed: the refund guard.** This is a money path. Making the two ceilings
one number is the right eventual fix, and it is a decision about what a refund
means — is a refund against a booking, or against a payment? — with real
consequences either way:

- Widening the guard to the booking-level figure would let a refund exceed the
  payment row it is recorded against, which the ledger then has to reconcile.
- Narrowing the disclosure to a per-payment figure changes what an admin screen
  shows about money.

Neither belongs in a P2 confirmation TAB, decided unilaterally, on a path where
being wrong moves real money. It is documented, proven with a failing arithmetic
case, and left for a change somebody can review — which is the same rule TAB 01
applied to renames.

## `RefundTransitionResult.status` — confirmed intended

> Confirm that `RefundTransitionResult.status`, currently a single-value enum
> `['failed']`, is intended to stay that way — the portal's own refund status
> vocabulary is much wider, and the two are not currently the same concept.

**Intended.** The endpoint is `POST /api/v1/admin/refunds/{refundId}/mark-failed`,
and the only terminal it can reach is `failed`. A wider enum would describe
states this operation cannot produce.

The book's own observation is the resolution: the two **are not the same
concept**. The portal's vocabulary describes the review's *lifecycle*; this
describes *one transition's outcome*. They should not share an enum, and a
single-value enum is the honest way to say "this endpoint has one answer".

## Deliverables

| File | What changed |
| --- | --- |
| `src/api/v1/openapi.ts` | `refundable` states its scope, the additional-work reason, and which figure to bound with |
| `tests/refund-amount-model.test.ts` | 12 assertions: the amount is accepted, the ceiling is enforced, the two ceilings agree without additional work and diverge with it |

## Acceptance, against the book's own criteria

| Book's criterion | Status |
| --- | --- |
| State in the schema whether a refund amount is operator-supplied or server-derived | ✅ operator-supplied at `openRefundReview`, server-bounded; stated |
| If partial refunds are planned, send `refundable` on the review payload so the UI can bound the input | ⚠️ **do not bound with it** — it is booking-level and larger. Documented, with the divergence proven |
| Enforce the ceiling server-side regardless of what the client sends | ✅ already true — `amount > remaining` refuses before anything is written |
| Confirm `RefundTransitionResult.status` stays single-value | ✅ intended, and the reason is the book's own: they are different concepts |

## Gate

```
npm run verify → Test Suites: 328 passed, 328 total
                 Tests:       6807 passed, 6807 total
                 EXIT=0
```

---
Servana Backend — Admin API Master Command · TAB 10
