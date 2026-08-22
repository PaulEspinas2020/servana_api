<!--
  GENERATED FILE - do not edit by hand.
  Source: scripts/generate-finance-docs.ts, derived from
    src/services/finance/financePolicy.ts   (economics, states, refunds, checks)
    src/services/revenueSplit.ts            (the 80/20 split and its rounding)
    src/services/payoutStatus.ts            (the payout window and its dialects)
    src/api/v1/contract.ts                  (the canonical endpoints)
  Regenerate: npm run finance:docs
-->

# Finance v1 Contract

> The single financial truth for Customer Mobile, Customer Web, Provider Mobile,
> Provider Web and Admin Web. Everything below is derived by EXECUTING
> `src/services/finance/financePolicy.ts` — the numbers in this document are the numbers
> the platform computes.

## 1. Provider economics

Servana retains **20%** of gross revenue and the
provider earns **80%** — uniformly, with no per-service, per-provider or
per-revenue-type variation. The rate lives in `src/services/revenueSplit.ts` and is imported
here rather than restated.

There are two economic models, and which one applies is decided by
`user_credentials.is_internal_fixer` — an admin-set, permissioned, audited flag. It is **not**
decided by the provider's role: role 4 is read as `internal_provider` in one module and
`organization_provider` in another, and neither is a statement about pay.

| Model | Earns a job share | Share | Revenue owner | Payout eligible |
| --- | --- | --- | --- | --- |
| `EXTERNAL_PROVIDER` | yes | 80% | split | yes |
| `INTERNAL_FIXER` | — | 0% | servana | — |

**`EXTERNAL_PROVIDER`** — A marketplace provider. Earns the standard provider share of everything the customer was charged for the booking, including paid additional work.

**`INTERNAL_FIXER`** — A salaried Servana fixer. Service revenue is Servana's in full and compensation is payroll, which this backend does not model. No per-job commission is calculated, recorded or paid.

### Worked example — a PHP 5000.00 booking

| Model | Gross | Provider payable | Servana revenue |
| --- | --- | --- | --- |
| `EXTERNAL_PROVIDER` | PHP 5000.00 | PHP 4000.00 | PHP 1000.00 |
| `INTERNAL_FIXER` | PHP 5000.00 | PHP 0.00 | PHP 5000.00 |

The gross is the booking price **plus paid additional work**. On-site upsell is charged through
its own checkout and never writes back to `bookings.final_price`, so any reader treating
`final_price` as the gross silently drops it.

### Internal fixer policy

Internal fixer service revenue belongs to Servana in full, and compensation is salary through
payroll — a system this backend does not model and must not pretend to. **No per-job commission
is calculated, recorded or paid.**

This is enforced at the WRITER: `createDisbursement` creates no disbursement row for an
internal fixer and records a `PROVIDER_EARNING_WITHHELD` event with reason
`INTERNAL_FIXER_SALARIED` plus an `INTERNAL_FIXER_REVENUE_RETAINED` event for the gross.
The reconciliation check `INTERNAL_FIXER_JOB_WITH_PROVIDER_PAYOUT` remains as the detector for
rows created before that refusal existed, and for a provider tagged as an internal fixer after
their jobs completed.

## 2. Payment state model

Payment state is **separate from booking state and linked to it**. A booking can be COMPLETED and
unpaid (cash awaiting confirmation), or paid and cancelled (refund pending). Collapsing the two
would make one of those unrepresentable.

| State | Captured | Terminal | Earnings eligible | May become |
| --- | --- | --- | --- | --- |
| `PENDING` | — | — | — | `PAID`, `FAILED`, `REJECTED` |
| `PAID` | yes | — | yes | `REFUNDING` |
| `FAILED` | — | — | — | `PENDING`, `PAID` |
| `REJECTED` | — | yes | — | — (terminal) |
| `REFUNDING` | yes | — | — | `REFUNDED`, `PAID` |
| `REFUNDED` | — | yes | — | — (terminal) |

**`PENDING`** — Awaiting the customer, the processor, or an admin review.

**`PAID`** — Funds captured. The only state a provider earning may accrue from.

**`FAILED`** — The processor declined or abandoned the charge. A new attempt may be started.

**`REJECTED`** — An admin refused a manually submitted proof of payment.

**`REFUNDING`** — A refund has been claimed against captured funds and its outcome is not yet known. Still captured: the money has not come back yet, and treating it as returned would permit a second refund of the same charge.

**`REFUNDED`** — Funds returned to the customer and confirmed by the processor.

Two absences are deliberate. `REFUNDED` never returns to `PAID` — failure and settlement are
monotonic, so a delayed or duplicated processor event cannot demote a charge that has settled.
And `FAILED` never reaches `REFUNDED` directly, because there is nothing captured to return.
`REFUNDING → PAID` **is** present: the refund service restores it when the processor
definitively rejected the refund, and only then.

## 3. Ledger and reconciliation model

The financial record has two halves, and both are needed.

**The calculator.** `financeLedger.computeBookingFinance` is a pure function from the source
rows — the booking, its payment, its paid additional work, its disbursement — to the canonical
financial picture. Every surface projects from it: the customer's payment screen, the provider's
earnings, the admin's reconciliation. A single function cannot disagree with itself.

**The event log.** `finance_ledger_events` is append-only, enforced by a database trigger that
refuses UPDATE and DELETE, and idempotent on `event_key` so a webhook retry or a double-click
cannot record the same money twice. Keys are composed from the FACT
(`payment:47:captured`), never from the attempt.

The calculator is the truth for all history; the log is the evidence for everything that happens
from here on. They are checked against each other by
`LEDGER_EVENT_AMOUNT_MISMATCH` and `COMPLETED_BOOKING_WITHOUT_EARNING`.

| Event | Counterparty | Direction | Carries money | Milestone |
| --- | --- | --- | --- | --- |
| `PAYMENT_CAPTURED` | servana | credit | yes | payments.status → PAID |
| `ADDITIONAL_WORK_CAPTURED` | servana | credit | yes | payments.status → PAID with additional_request_id set |
| `PAYMENT_REFUNDED` | customer | credit | yes | payments.status → REFUNDED |
| `PROVIDER_EARNING_ACCRUED` | provider | credit | yes | booking_workers.status → COMPLETED |
| `PROVIDER_EARNING_WITHHELD` | provider | credit | — | booking_workers.status → COMPLETED |
| `PROVIDER_PAYOUT_RELEASED` | provider | debit | yes | disbursements.status → RELEASED |
| `PROVIDER_PAYOUT_FAILED` | provider | debit | — | disbursements.status → FAILED |
| `INTERNAL_FIXER_REVENUE_RETAINED` | servana | credit | yes | booking_workers.status → COMPLETED on an internal fixer job |

**`PAYMENT_CAPTURED`** — The customer's booking charge reached Servana.

**`ADDITIONAL_WORK_CAPTURED`** — On-site additional work was paid. Recorded separately because it is charged through its own checkout and never writes back to bookings.final_price.

**`PAYMENT_REFUNDED`** — Captured funds were returned to the customer and the processor confirmed it.

**`PROVIDER_EARNING_ACCRUED`** — The provider became owed their share of the job. Not yet paid.

**`PROVIDER_EARNING_WITHHELD`** — A completed job produced no provider payable, and why. Written so a job with no earning is an explained zero rather than a gap in the record.

**`PROVIDER_PAYOUT_RELEASED`** — The accrued earning left Servana toward the provider's bank account.

**`PROVIDER_PAYOUT_FAILED`** — A release attempt was definitively rejected. The earning remains owed.

**`INTERNAL_FIXER_REVENUE_RETAINED`** — The full service revenue of an internal fixer job stayed with Servana. The counterpart to the per-job commission that is deliberately not calculated.

## 4. Payout policy

**The provider payout window is 72 hours** from job completion. That
number is declared once, in `src/services/payoutStatus.ts`, and is read by the release
scheduler, by the eligibility rule below, and by the expected-arrival date every earnings screen
shows. Provider Web once restated it as 48 against a scheduler releasing at 72, telling providers
their money was due a day early; there is now nothing to restate.

Eligibility returns the **first** blocking reason in precedence order, not a list — a provider
told "your payout is held" needs the sentence that is actionable, and an internal fixer must
never be told they are waiting for a window that will never pay them.

| Scenario | Outcome | Reason | Message |
| --- | --- | --- | --- |
| Paid, completed, window passed | **releases** | — | — |
| Internal fixer | blocked | `INTERNAL_FIXER_SALARIED` | Internal fixer work is salaried; no per-job payout is due. |
| Already released | blocked | `ALREADY_RELEASED` | This payout has already been released. |
| Job not completed | blocked | `JOB_NOT_COMPLETED` | The assignment has not been completed. |
| Customer has not paid | blocked | `PAYMENT_NOT_CAPTURED` | The customer payment for this booking has not been captured. |
| Refund in progress | blocked | `REFUND_ACTIVE` | A refund is in progress against this booking's payment. |
| Zero provider share | blocked | `AMOUNT_NOT_POSITIVE` | The computed provider share is not a positive amount. |
| Admin hold, no expiry | blocked | `ADMIN_HOLD` | An admin placed a hold on this payout. |
| Admin hold, expired | **releases** | — | — |
| No payout account | blocked | `NO_BANK_ACCOUNT` | The provider has no registered payout account. |
| Inside the payout window | blocked | `WITHIN_PAYOUT_WINDOW` | Inside the 72-hour payout window that follows completion. |

An admin hold with no expiry is indefinite; a hold whose expiry has passed no longer blocks. That
reproduces `processPendingDisbursements` exactly rather than offering a second opinion beside
the scheduler.

## 5. Refund policy

One eligibility rule, two outcomes. A **customer requests** — which opens a
`finance_refund_reviews` row and calls no processor. An **admin issues** — which moves money.
Both run `evaluateRefundEligibility` first, so a request can never be accepted for a booking an
issue would refuse. A **provider is refused outright**: they are not a party to the customer's
charge, and a provider able to refund a booking they worked could erase the evidence of a job
they were paid for.

| Trigger | Who may cite it | Reverses provider earning | Meaning |
| --- | --- | --- | --- |
| `CUSTOMER_CANCELLED` | customer, admin | yes | The customer cancelled within the cancellation policy. |
| `PROVIDER_CANCELLED` | customer, admin | yes | The assigned provider cancelled and no replacement served the booking. |
| `ADMIN_CANCELLED` | admin | yes | Servana cancelled the booking. |
| `DISPUTE_UPHELD` | admin | yes | A dispute was resolved in the customer's favour. |
| `SERVICE_NOT_DELIVERED` | customer, admin | yes | The booking was paid and no service was performed. |
| `DUPLICATE_PAYMENT` | customer, admin | — | The customer was charged twice for one booking. The provider earned once, so the earning is NOT reversed. |
| `ADMIN_DISCRETION` | admin | — | A goodwill refund. Servana absorbs it, so the provider keeps what they earned. |

### Double refunds are prevented by arithmetic

The ceiling is **captured minus already refunded**, so a second full refund computes a ceiling of
zero and is refused — not by a flag somebody has to remember to check.

Worked from the real function against a PHP 1500.00 capture:

| Case | Max refundable | Outcome |
| --- | --- | --- |
| Already refunded in full, asking again | PHP 0.00 | `REFUND_EXCEEDS_CAPTURED` |
| PHP 500.00 already refunded, asking for the rest | PHP 1000.00 | **allowed**, PHP 1000.00 |

`REFUNDING` counts as **still captured** for exactly this reason: a refund whose outcome is
unknown must not free the balance for a second attempt.

| Refusal | Message |
| --- | --- |
| `PAYMENT_NOT_FOUND` | No payment exists for this booking. |
| `PAYMENT_NOT_CAPTURED` | Only a captured payment can be refunded. |
| `REFUND_ALREADY_SETTLED` | This payment has already been refunded. |
| `REFUND_IN_PROGRESS` | A refund is already in progress for this payment. |
| `REFUND_EXCEEDS_CAPTURED` | A refund cannot exceed the amount captured. |
| `AMOUNT_NOT_POSITIVE` | The refund amount must be greater than zero. |
| `PROVIDER_NOT_PERMITTED` | A provider cannot refund a booking they worked. |
| `OUTCOME_NOT_REFUNDABLE` | This booking outcome does not entitle the customer to a refund. |

## 6. Reconciliation checks

Every break a reconciliation run can find, declared in one catalog that the engine, the admin
read model and the tests all consume. Before this the checks were anonymous closures with their
codes written inline, so nothing could enumerate them and the admin UI could not label them.

"Required by spec" marks the checks TAB 07 §78 names by hand.

| Code | Severity | §78 | Detects | Remediation |
| --- | --- | --- | --- | --- |
| `GCASH_PENDING_REVIEW_OVER_SLA` | warning | — | A GCash proof of payment has waited longer than the review SLA. | Review the proof in the GCash queue and approve or reject it. |
| `CASH_PAYMENT_UNCONFIRMED_OVER_SLA` | warning | — | A cash payment was never confirmed within the SLA. | Confirm collection with the provider, then mark the payment paid. |
| `PAYMONGO_FAILED_PAYMENT` | critical | — | A PayMongo charge failed and has not been reviewed. | Contact the customer to restart checkout, or cancel the booking. |
| `PAYMONGO_CHECKOUT_WITHOUT_FINAL_STATUS` | warning | yes | A checkout session has had no terminal outcome for longer than the stale window. | Query the session at PayMongo and settle the local row to match. |
| `RELEASED_PAYOUT_WITHOUT_PAID_PAYMENT` | critical | yes | Money left Servana for a booking that was never paid for. | Recover the payout or record the write-off; find why the guard was bypassed. |
| `DUPLICATE_PAYOUT_FOR_BOOKING` | critical | yes | More than one live disbursement exists for one booking. | Cancel the duplicate before it releases; reverse it if it already did. |
| `INTERNAL_FIXER_JOB_WITH_PROVIDER_PAYOUT` | critical | — | A salaried internal fixer has a per-job provider payout. | Hold and void the payout. Since the writer now refuses these, a new row means the provider was tagged as an internal fixer after the job was completed. |
| `PAYOUT_FAILED_PROVIDER_ERROR` | critical | — | A payout has exhausted its automatic retries. | Check the provider's bank details, then retry the payout manually. |
| `REFUND_APPROVED_WITH_RELEASED_PAYOUT` | critical | — | A refund was approved after the provider payout for the same booking was released. | Recover the provider share manually; the processor cannot reverse it. |
| `ORPHANED_PAYMENT_WITHOUT_BOOKING` | critical | yes | A captured payment references no booking, or one that no longer exists. | Identify the payer from the processor record and re-link or refund. |
| `COMPLETED_BOOKING_WITHOUT_EARNING` | critical | yes | A paid, completed booking produced no provider earning and no recorded reason for withholding one. | Run the earning accrual for the booking. An internal fixer job is NOT this break — those carry a PROVIDER_EARNING_WITHHELD event that explains the zero. |
| `PAYOUT_WITHOUT_EARNING` | critical | yes | A disbursement exists with no accrued earning event behind it. | Hold the payout and establish what it was for before it releases. |
| `REFUND_EXCEEDS_CAPTURED_AMOUNT` | critical | yes | Refunds against a payment total more than was ever captured. | Reclaim the excess from the processor; investigate the duplicate refund path. |
| `LEDGER_EVENT_AMOUNT_MISMATCH` | critical | — | A recorded ledger event disagrees with the amount the canonical calculator derives from the same source rows. | Do not edit the event — it is the immutable record. Establish which writer produced the disagreement and correct the source row. |

`GET /api/v1/admin/finance/reconciliation` is **read-only** — it reports the open breaks,
the check catalog and the platform money totals, including the outstanding provider liability
(accrued minus released). `POST /api/admin/finance/reconciliation/run` remains the way to
produce a fresh set; a GET that writes rows is one somebody eventually puts behind a dashboard
refresh timer.

## 7. Canonical endpoints

| Endpoint | Auth | Idempotent | Domain service |
| --- | --- | --- | --- |
| `GET /api/v1/provider/earnings/transactions/:transactionId` | provider | yes | `services/finance/providerEarningsService.getEarningTransaction` |
| `POST /api/v1/bookings/:bookingId/payment-intents` | authenticated | no | `services/finance/bookingPaymentService.startPaymentIntent` |
| `GET /api/v1/bookings/:bookingId/payment` | authenticated | yes | `services/finance/bookingPaymentService.getBookingPayment` |
| `POST /api/v1/bookings/:bookingId/refunds` | authenticated | no | `services/finance/bookingPaymentService.refundBookingPayment` |
| `GET /api/v1/provider/earnings/summary` | provider | yes | `services/finance/providerEarningsService.getEarningsSummary` |
| `GET /api/v1/provider/earnings/transactions` | provider | yes | `services/finance/providerEarningsService.listEarningsTransactions` |
| `GET /api/v1/provider/earnings/payouts` | provider | yes | `services/finance/providerEarningsService.listProviderPayouts` |
| `GET /api/v1/admin/finance/reconciliation` | admin | yes | `services/finance/financeReconciliationService.getReconciliationReport` |

Every one of them delegates to a module under `services/finance/`, and all of them project from
the same calculator. That is what makes "Provider Web and Provider Mobile earnings match exactly"
a property of the code rather than an agreement between two implementations.

### Replay guards

**`bookings.payments.intent`** — An advisory transaction lock on the booking, plus reuse of a live session for the same return origin instead of minting a second, plus a processor Idempotency-Key derived from the payment row and its attempt counter. A replay returns the SAME checkout URL rather than creating a second payable session.

**`bookings.refunds.create`** — Eligibility is evaluated against captured-minus-already-refunded, so a second full refund computes a ceiling of zero and is refused by arithmetic. A customer repeat returns the SAME open review row rather than opening a second, and the admin path claims the payment row with a compare-and-swap to REFUNDING before calling the processor.

### Legacy routes still serving traffic

| Legacy route | Disposition | Canonical successor | Note |
| --- | --- | --- | --- |
| `GET /api/provider/earnings/:id` | ALIAS_TEMPORARILY | `provider.earnings.transaction` | Same service. The legacy path sits directly under /earnings, where it shadows any future literal segment added beside it. |
| `POST /api/:bookingId/paymongo/create` | ALIAS_TEMPORARILY | `bookings.payments.intent` | The live customer checkout call. Identical domain service — this entry adds the booking-scoped authorization and refuses a provider, which the legacy route does not do. Kept until Customer Web and Customer Mobile migrate. |
| `GET /api/admin/finance/ledger/booking/:bookingId` | ROLE_SPECIFIC | `bookings.payments.get` | The admin revenue-recognition view over finance_ledger_entries. It answers a different question (what was recognised, when, by whom) and carries its own permission. Both now read the same underlying capture events. |
| `POST /api/admin/finance/refunds` | ALIAS_TEMPORARILY | `bookings.refunds.create` | The admin portal opens refund reviews here today. Same table, same eligibility rule once migrated; this entry adds the customer-initiated path, which had no route at all. |
| `GET /api/provider/earnings/summary` | ALIAS_TEMPORARILY | `provider.earnings.summary` | The live provider portal call, now delegating to the same domain service so the two paths return identical figures during migration rather than merely similar ones. |
| `GET /api/provider/earnings` | ALIAS_TEMPORARILY | `provider.earnings.transactions` | The live earnings list. Same domain service now; the v1 shape adds the economic model, the payout block reason and minor-unit amounts. |
| `GET /api/provider/ledger` | ALIAS_TEMPORARILY | `provider.earnings.transactions` | A THIRD reading of the same columns, which used to hardcode every completed booking as "settled" and report failed payouts as money in hand. Superseded entirely. |
| `GET /api/workers/:uid/earnings-history` | RETIRE | `provider.earnings.transactions` | Takes the provider uid from the URL and has no auth, so it answers for anybody. No located caller in any of the five clients. Carried over from the planned placeholder this entry replaces; delete once telemetry confirms zero traffic. |
| `GET /api/provider/payouts` | ALIAS_TEMPORARILY | `provider.earnings.payouts` | The live payouts list, now delegating to the same domain service. Both exclude the processor id, servana_share, payout_error and the admin hold fields by projection. |
| `GET /api/admin/finance/reconciliation/exceptions` | ALIAS_TEMPORARILY | `admin.finance.reconciliation` | The paged exception list the admin portal reads today. This entry adds the check catalog, the money totals and the outstanding provider liability, so an admin can see that the ledger balances rather than only that a page of rows exists. |

## 8. Cross-platform caller matrix

`migrated` — this client calls the canonical v1 route today.
`legacy` — this client calls a legacy route the canonical entry supersedes.
`planned` — this client will migrate; it calls no equivalent today.
`n/a` — the capability does not apply to this client.

| Capability | Customer Mobile | Customer Web | Provider Mobile | Provider Web | Admin Web | Canonical endpoint(s) |
| --- | --- | --- | --- | --- | --- | --- |
| Start or resume a booking payment | legacy | legacy | n/a | n/a | planned | `bookings.payments.intent` |
| Read a booking's payment and price breakdown | planned | planned | migrated | planned | planned | `bookings.payments.get` |
| Refund a booking payment | planned | planned | n/a | n/a | legacy | `bookings.refunds.create` |
| Provider earnings summary | n/a | n/a | legacy | migrated | n/a | `provider.earnings.summary` |
| Provider earnings transactions | n/a | n/a | planned / legacy | planned / migrated | n/a | `provider.earnings.transaction`, `provider.earnings.transactions` |
| Provider payouts | n/a | n/a | legacy | migrated | n/a | `provider.earnings.payouts` |
| Admin ledger reconciliation | n/a | n/a | n/a | n/a | legacy | `admin.finance.reconciliation` |

No client is `migrated` yet: the platform application repositories are out of scope until the
backend Master Command completes. Every legacy route above stays mounted and now delegates to the
same domain service, so a client migrating later changes its URL and not its numbers.

### Why each capability is or is not role-split

**Start or resume a booking payment** (`services/finance/bookingPaymentService`)

No role split. One booking-scoped endpoint; the caller's relationship to the booking is resolved by `assertBookingAccess`, and an admin starting a payment on a customer's behalf runs the identical `createCheckoutSession` call. A provider is refused — they are never a party to the customer's charge.

**Read a booking's payment and price breakdown** (`services/finance/bookingPaymentService`)

No role split, but the DTO is FIELD-SCOPED by actor from one declaration: a provider sees their own share and never the processor reference or the customer's method, and a customer sees what they paid and never the provider share. One endpoint, one calculator, one projection function — not three endpoints that could each compute a different total.

**Refund a booking payment** (`services/finance/bookingPaymentService`)

One endpoint, two outcomes decided by the actor: a customer REQUESTS (opening a refund review) and an admin ISSUES (moving money). Both call `evaluateRefundEligibility` first, so a request can never be accepted for a booking an issue would refuse. A provider is refused outright.

**Provider earnings summary** (`services/finance/providerEarningsService`)

No role split. Provider Web and Provider Mobile call the same path and receive the same DTO from the same aggregate query, which is what makes "earnings match exactly" a property rather than a coincidence of two implementations.

**Provider earnings transactions** (`services/finance/providerEarningsService`)

No role split. Replaces three legacy shapes — `/provider/earnings`, `/provider/ledger` and the job-card earnings fields — that read the same columns and answered in three vocabularies.

**Provider payouts** (`services/finance/providerEarningsService`)

No role split. The provider's own payouts only; the subject is the token, never a uid in the path. Admin payout administration is a genuinely different operation — it can hold, retry and see processor references — and lives under /admin/finance with its own permissions.

**Admin ledger reconciliation** (`services/finance/financeReconciliationService`)

Admin only, and legitimately so: it reads across every booking, provider and payment on the platform. It reconciles the SAME ledger the provider and customer endpoints project from, so an admin investigating a break and a provider reading their earnings are looking at one set of records.
