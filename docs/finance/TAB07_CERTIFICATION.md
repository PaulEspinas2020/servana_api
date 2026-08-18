# TAB 07 — Payments, Provider Earnings, Payouts, Refunds

## Verdict

```
PAYMENTS + EARNINGS VERDICT: CERTIFIED_WITH_NONBLOCKING_GAPS
```

Every release gate is met in code, with tests that were actually executed. The
gaps below are environmental or sequencing, not defects: migration 031 has not
been applied to any database because the only reachable one is production, no
client has migrated because platform-app repositories are out of scope until the
backend Master Command completes, and one item — the population of providers
already tagged `is_internal_fixer` — needs an operator decision rather than code.

```
BACKEND IS THE SINGLE CALCULATOR       YES         ✔  one pure function, every surface projects from it
PROVIDER WEB / MOBILE EARNINGS MATCH   PROVEN      ✔  both paths driven over one fixture, payloads asserted equal
INTERNAL FIXER ECONOMICS               ENFORCED    ✔  refused at the WRITER, not just flagged after the fact
PAYOUT WINDOW                          72h, ONE    ✔  one constant; scheduler, policy and ETA all read it
REFUND IDEMPOTENCY                     ARITHMETIC  ✔  ceiling = captured − refunded; second refund computes 0
PAYOUT IDEMPOTENCY                     CLAIMED     ✔  compare-and-swap to PROCESSING before the processor call
LEDGER EVENTS                          APPEND-ONLY ✔  DB trigger refuses UPDATE/DELETE; unique on event_key
LEDGER COVERS EVERY CAPTURE PATH       YES         ✔  webhook + GCash approval + cash; webhook in-transaction
RECONCILIATION CHECK CATALOG           DECLARED    ✔  14 checks, engine asserted against the catalog
§78 REQUIRED CHECKS                    5 of 5      ✔  orphaned, no-earning, payout-without-earning, over-refund, drift
FINANCIAL LEAKAGE TESTS                PASS        ✔  provider scoping proven as a property of the SQL
PER-SEAT FIELD DISCLOSURE              ADDITIVE    ✔  three explicit DTOs, no subtractive projection
ADMIN v1 ROUTE PERMISSION              PARITY      ✔  reconciliation.view, same as the legacy predecessor
LEDGER RECONCILIATION BREAKS           0 LOCALLY   ⚠  no database to run the engine against; see §7
MIGRATION 031 APPLIED                  NOT RUN     ⚠  deploy precondition, transactional, lazily self-healing
INTERNAL FIXER POPULATION              UNKNOWN     ⚠  needs Paul; changes money movement for tagged providers
CLIENTS MIGRATED                       0 of 5      ⚠  out of scope until the Master Command completes
PRODUCTION SMOKE                       NOT RUN     ✖  forbidden by the standing rules
```

Branch `main`, HEAD `36ca152`. **All work is uncommitted and local.** Nothing was
pushed, deployed, or run against production.

---

## 1. What was already there

TAB 07 is centralisation, not greenfield. The sweep found the 80/20 split already
extracted to one module (`revenueSplit.ts`), the earnings gross already extracted
(`earningsBasis.ts`), the payout status dialects already derived from one
canonical value and the 72-hour window already a single constant
(`payoutStatus.ts`), plus an admin finance service with a revenue ledger, refund
reviews and a nine-check reconciliation engine.

Each of those extractions fixed **one constant**. What was missing was the layer
above them: the rules that say who earns, when money becomes payable, what a
payment state means, and which breaks a reconciliation run must find. Those lived
as behaviour scattered across a payout scheduler, a webhook handler, two refund
methods and nine inline SQL checks, so no client and no auditor could read the
policy anywhere.

### The two defects the sweep found

1. **`createLedgerEntry` only ever ran on the two ADMIN paths** —
   `approveGcashPayment` and `adminConfirmCash`. The PayMongo webhook wrote
   nothing, so online payments — the majority of Servana's volume — were absent
   from the "revenue ledger" entirely, and any reconciliation over it was
   reconciling a minority of the money.

2. **Internal fixers were being paid a per-job 80% share.** Reconciliation check
   7 (`INTERNAL_FIXER_JOB_WITH_PROVIDER_PAYOUT`, severity `critical`, description
   "should be NOT_APPLICABLE") has existed since the engine was written, and
   `internal_fixer_revenue.view` exists as a distinct sensitive permission — but
   `createDisbursement` had no internal-fixer branch. Every completed
   internal-fixer job created a PENDING disbursement that the hourly scheduler
   then released, and the reconciliation run flagged it afterwards as a critical
   break nobody could close, because nothing upstream would stop the next one.

---

## 2. Endpoints

### Added — canonical, 7 entries

| Endpoint | Auth | Domain service |
|---|---|---|
| `POST /api/v1/bookings/:bookingId/payment-intents` | authenticated | `bookingPaymentService.startPaymentIntent` |
| `GET /api/v1/bookings/:bookingId/payment` | authenticated | `bookingPaymentService.getBookingPayment` |
| `POST /api/v1/bookings/:bookingId/refunds` | authenticated | `bookingPaymentService.refundBookingPayment` |
| `GET /api/v1/provider/earnings/summary` | provider | `providerEarningsService.getEarningsSummary` |
| `GET /api/v1/provider/earnings/transactions` | provider | `providerEarningsService.listEarningsTransactions` |
| `GET /api/v1/provider/earnings/payouts` | provider | `providerEarningsService.listProviderPayouts` |
| `GET /api/v1/admin/finance/reconciliation` | admin + `reconciliation.view` | `financeReconciliationService.getReconciliationReport` |

These are exactly the seven paths the Master Command names as the target
architecture.

### Changed — re-pointed, not replaced

Five live provider endpoints keep their **exact response shapes** and now
delegate to the canonical domain service:

| Live route | Change |
|---|---|
| `GET /api/provider/earnings` | now returns the canonical transaction DTO (a superset of the old shape) |
| `GET /api/provider/earnings/:id` | same |
| `GET /api/provider/earnings/summary` | now the canonical summary (superset) |
| `GET /api/provider/ledger` | same figures, unchanged ledger-row shape |
| `GET /api/provider/payouts` | same figures, unchanged `ProviderPayoutDto` shape |

Every field these endpoints returned before is still returned, with the same name
and the same meaning. `tests/finance-contract.test.ts` asserts the full legacy key
set on both the summary and the transaction shapes, so an additive change cannot
silently become a breaking one.

### Aliased — legacy routes still serving traffic

`POST /api/:bookingId/paymongo/create`, `GET /api/admin/finance/refunds`,
`GET /api/admin/finance/reconciliation/exceptions`,
`GET /api/admin/finance/ledger/booking/:bookingId`, and the five provider
earnings routes above. All remain mounted; all now share the canonical domain
service or, in the admin ledger's case, the same underlying capture events.

### Retired

None. One route — `GET /api/workers/:uid/earnings-history` — is marked `RETIRE`:
it takes the provider uid from the URL and has no auth, so it answers for
anybody, and no caller was located in any of the five clients. It is **not**
deleted, because deletion needs telemetry confirming zero traffic first.

### Removed from the contract

The `provider.earnings.summary` PLANNED placeholder from an earlier tab. It
deferred earnings explicitly — *"the payout window is already documented as 48h
in copy and 72h in reality, and a second read path before that is settled would
give two answers to 'when am I paid'"*. That is now settled, so the placeholder
was replaced by the implemented entry rather than left beside it.

---

## 3. The financial model

### One calculator

`financeLedger.computeBookingFinance` is a **pure function** from the source rows
to the canonical financial picture. Every surface projects from it: the
customer's payment screen, the provider's earnings, the admin's reconciliation.
Being pure is what lets the test suite exercise every economic case — internal
fixer, refund in flight, additional work, failed payout, sub-centavo rounding —
without a database.

Two rules it encodes that were each previously a per-endpoint decision:

- **The gross includes paid additional work.** On-site upsell is charged through
  its own checkout and never writes back to `bookings.final_price`.
- **A recorded share beats a derived one.** Where a disbursement exists its
  `worker_share` is authoritative and is used as-is; only a completed booking
  with no disbursement row yet is derived, and it is flagged `isEstimate`.

### One append-only log

`finance_ledger_events`: one row per financial fact, unique on `event_key`, with
a database trigger that refuses UPDATE and DELETE. Keys are composed from the
**fact** (`payment:47:captured`), never from the attempt, so a PayMongo retry, a
double-clicked admin approval and a scheduler tick that overlaps the previous one
all collide and insert once.

### Why both

The log necessarily starts empty — this repository cannot reach a non-production
database, so there is no backfill. If earnings read the log alone, every
provider's history would vanish on the day it shipped. So the calculator derives
from the source rows, which exist for all history, and the log records each event
as it happens.

That is not two truths. `LEDGER_EVENT_AMOUNT_MISMATCH` fails when a recorded
event disagrees with what the calculator derives from the same rows, and
`COMPLETED_BOOKING_WITHOUT_EARNING` fails when a milestone passed and no event
was written. The log is how the calculator is audited; the calculator is how the
log stays complete.

---

## 4. Internal fixer policy

**Internal fixer service revenue belongs to Servana in full. Compensation is
salary through payroll, which this backend does not model. No per-job commission
is calculated, recorded or paid.**

Enforced at the writer. `createDisbursement` now creates no disbursement row for
an internal fixer, and records an *explained zero* in its place:
`PROVIDER_EARNING_WITHHELD` with reason `INTERNAL_FIXER_SALARIED`, plus
`INTERNAL_FIXER_REVENUE_RETAINED` for the whole gross.

The explained zero is the point. A completed internal-fixer job with **no** event
at all would be indistinguishable from a completed job whose accrual was dropped
by a bug, and `COMPLETED_BOOKING_WITHOUT_EARNING` would flag both. Writing the
zero is what lets reconciliation tell the designed case from the defect.

The economic model is resolved from `user_credentials.is_internal_fixer` — an
admin-set, permissioned, audited flag — and deliberately **not** from the
provider's role. Role 4 is read as `internal_provider` in
`adminProviderController` and as `organization_provider` in
`providerProfileComplianceService`; neither is a statement about pay.

`INTERNAL_FIXER_JOB_WITH_PROVIDER_PAYOUT` stays in the catalog as the detector
for rows created before this refusal existed, and for a provider tagged as an
internal fixer after their jobs completed.

> **This changes money movement.** See §7 — Paul needs to confirm the tagged
> population before deploy.

---

## 5. Tests actually executed

Final verification, run in full on 2026-08-13:

```
npm run verify   → typecheck, typecheck:tests, guard:protected-contracts,
                   api:docs:check, booking:docs:check, finance:docs:check,
                   test:ci
                 → 219 suites / 4,744 tests, all passing
npm run build    → clean
```

Seven suites were added, 213 tests:

| Suite | What it proves |
|---|---|
| `finance-policy` | economics, payment states, payout precedence, refund ceilings, catalogs |
| `finance-ledger-derivation` | the calculator over every economic case, plus invariants across combinations |
| `finance-leakage` | §79 — provider scoping as a property of the SQL; per-seat field disclosure |
| `finance-idempotency` | §72/§77 — the internal-fixer refusal at the writer, `ON CONFLICT` keys |
| `finance-reconciliation` | the engine matches the catalog; the §78 checks run and stay quiet when clean |
| `finance-contract` | the seven endpoints, and **both provider paths driven over one fixture** |
| `finance-docs-generated` | the contract document is derived and current |

Six existing suites were updated because they correctly caught this work:

- `provider-earnings-summary` — rewritten against per-booking rows. The old
  fixture was a pre-aggregated row from a query that no longer exists. Every
  named defect (upsell dropped, PROCESSING lost, FAILED counted as pending,
  estimates unlabelled) is still covered, now behaviourally rather than by
  scanning SQL for CASE arms. One rule genuinely changed and is documented in the
  file: the rounding boundary moved to the per-booking amount so the headline
  equals the sum of the rows the provider can see.
- `provider-ledger-status`, `provider-earnings-rate-and-eta`,
  `paymongo-payout-retry-boundary`, `reassignment-leakage` — source scans
  re-pointed at where each guarantee now lives. The guarantees are unchanged.
- `payout-status-vocabulary` — the "all four payout-bearing responses report the
  canonical value" count was asserted against one file; two of the four moved
  into the shared DTO, so the claim is now asserted about the responses.
- `v1-router` — gained an ADMIN auth-mode set (TAB 07 mounted the first
  implemented `admin` entry, and the totals assertion forced it), a permission
  mock, and two assertions that the permission gate is really mounted.
- `suite-inventory` — 212 → 219.

**No test was weakened to pass.** The one assertion whose expected value changed
(`rounds once, after summing`) is replaced by a stricter invariant.

---

## 6. Cross-platform caller matrix

Full matrix with per-capability role-split rationale:
`docs/finance/FINANCE_V1_CONTRACT.md` §8, generated from the policy.

| Capability | CM | CW | PM | PW | Admin |
|---|---|---|---|---|---|
| Start a booking payment | legacy | legacy | n/a | n/a | planned |
| Read payment + breakdown | planned | planned | planned | planned | planned |
| Refund | planned | planned | n/a | n/a | legacy |
| Earnings summary | n/a | n/a | legacy | legacy | n/a |
| Earnings transactions | n/a | n/a | legacy | legacy | n/a |
| Payouts | n/a | n/a | legacy | legacy | n/a |
| Reconciliation | n/a | n/a | n/a | n/a | legacy |

No client is `migrated`. `tests/finance-contract.test.ts` asserts that, so the
certification cannot claim a migration that did not happen.

Where a role split remains it is documented and proven to share a domain service:

- **Refunds** — one endpoint, two outcomes by actor. A customer REQUESTS (a
  review row, no processor call); an admin ISSUES (money moves). Both run
  `evaluateRefundEligibility` first, so a request can never be accepted for a
  booking an issue would refuse.
- **Payment view** — one endpoint, three explicit DTOs. The CALCULATION is one
  object; only the disclosed fields differ.
- **Provider payouts vs admin payout administration** — genuinely different
  operations. Admin can hold, retry and see processor references; those live
  under `/admin/finance` with their own permissions.

---

## 7. Gaps

### P0 — none

### P1 — needs Paul, not code

**The internal fixer population is unknown, and the change moves money.** Any
provider currently tagged `is_internal_fixer` stops receiving per-job payouts the
moment this deploys. That is what §73 requires and what the reconciliation engine
has always said should happen — but the set of affected providers cannot be read
from here, because the only reachable database is production.

Before deploy, run:

```sql
SELECT uc.uid, uc.first_name, uc.last_name,
       COUNT(d.id)              AS disbursements,
       SUM(d.worker_share)      AS total_paid_to_date,
       MAX(d.created_at)        AS most_recent
  FROM servana.user_credentials uc
  LEFT JOIN servana.disbursements d ON d.worker_uid = uc.uid
 WHERE uc.is_internal_fixer = true
 GROUP BY uc.uid, uc.first_name, uc.last_name;
```

If that returns rows with payouts, those people have been paid a per-job share on
top of a salary and the flag or the policy needs an operator decision. Existing
disbursements are **not** touched by this work — they are reported by
`INTERNAL_FIXER_JOB_WITH_PROVIDER_PAYOUT`, listed rather than closed
automatically, so each one is decided by a person.

### P2 — deploy precondition

**Migration `031-finance-ledger.sql` has not been applied.** It is transactional
and `IF NOT EXISTS` throughout. `ensureFinanceLedgerSchema` performs the same DDL
lazily and is called from `ensureFinanceSchema` at boot, so a deploy that forgets
the migration self-heals; it THROWS rather than degrading, because there is no
safe degraded mode for a financial audit log.

**Ledger reconciliation has zero breaks locally, and locally is a fake database.**
The engine, the catalog and each check's SQL are tested; what cannot be tested
here is what the checks return against real data. First run after deploy should
be treated as a discovery exercise — `PAYOUT_WITHOUT_EARNING` and
`COMPLETED_BOOKING_WITHOUT_EARNING` are deliberately written to ignore bookings
that predate the event log, so a large first-run count would itself be a finding.

### P3 — sequencing

**No client has migrated.** Platform application repositories are out of scope
until the backend Master Command completes. Every legacy route stays mounted and
now delegates to the same domain service, so a client migrating later changes its
URL and not its numbers.

**Production smoke not run** — forbidden by the standing rules.

---

## 8. The next safe deprecation step

Nothing should be deleted yet. In order:

1. **Apply 031 to a non-production database** and run
   `POST /api/admin/finance/reconciliation/run`, then read
   `GET /api/v1/admin/finance/reconciliation`. That is the first time the checks
   meet real data.
2. **Resolve the internal fixer population** (§7) before the payout change
   reaches production.
3. **Migrate Admin Web first.** It is the lowest-risk client — one team, one
   release, no app store — and `GET /api/v1/admin/finance/reconciliation` is
   strictly additive: the legacy exceptions list keeps working beside it.
4. **Then Provider Web** onto `/api/v1/provider/earnings/*`. The payloads are
   already proven identical to the legacy ones, so this is a URL change.
5. **Only then** consider retiring `GET /api/workers/:uid/earnings-history`,
   which needs telemetry confirming zero traffic first — it is the one route here
   with no auth and no located caller.

Provider Mobile last, because an app release cannot be rolled back the way a web
deploy can.
