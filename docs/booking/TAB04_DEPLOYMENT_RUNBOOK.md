# TAB 04 + Admin canonical state — deployment runbook

**Status: FROZEN, LOCAL, NOT PUSHED, NOT DEPLOYED.**

Nothing in this document has been executed. It exists so that cutover is a
matter of running reviewed steps rather than improvising against production.

---

## 1. The freeze

| Repo | Branch | HEAD | Unpushed | Working tree |
|---|---|---|---|---|
| `servana_api` | `main` | `817d11b` | **38** | clean |
| `servana_adminportal` | `main` | `ab6f03f` | **2** | clean |

Gate state at the frozen SHAs:

```
backend    189 suites / 3,818 tests green
           typecheck (src) clean · typecheck (tests) clean
           guard:protected-contracts green · api + booking docs no drift
portal     1,202 specs green · ng build exit 0 · eslint 0 errors

RAW STATUS MUTATION OUTSIDE EXECUTOR    0
CROSS-SURFACE DISAGREEMENTS             0   (440 combinations)
POSTGRESQL LOCKING INTEGRATION          BLOCKED_BY_TEST_DATABASE
MIGRATION 027 APPLIED IN PRODUCTION     NO
```

`POSTGRESQL LOCKING INTEGRATION` stays **BLOCKED_BY_TEST_DATABASE**. It is not
relabelled PASS, and it is not treated as a deployment blocker — TAB 04 was
certified under that stated limitation with the fake-database lock-order and
race logic green.

---

## 2. What is being deployed

Foundational behaviour, all of it currently local:

- one canonical booking state derivation (was three: TypeScript ×2, SQL ×1)
- `transitionBooking` as the sole lifecycle writer (21 raw writers → 0)
- assignment locking protocol, booking-then-provider, one order for every producer
- canonical booking evidence (`booking_transitions`) inside the transition
- canonical Admin list / detail / filter / metrics
- role-4 assignment fix (role-4 providers were "Provider not found")
- `EN_ROUTE` / `ARRIVED` preserved end to end
- **migration 027 dependency**

---

## 3. THE ORDERING INVARIANT

```
027 MUST EXIST BEFORE NEW EXECUTOR CODE RECEIVES TRAFFIC.
```

Not "before the deploy finishes" — before the new process serves its first
request. The executor writes `accepted_at`, `en_route_at`, `arrived_at` and
`declined_at`, and it performs **no schema repair**, deliberately: a booking
transition must not be able to alter schema.

The old lazy DDL (`ensureArrivalColumns()`) is still present and is *not*
removed in this deploy, so the legacy path stays safe. But `/api/v1` goes
straight to the executor and never calls it. A provider hitting
`POST /api/v1/provider/jobs/:id/en-route` on a fresh process, before 027, fails
on a missing column.

Do **not** restart onto the new backend and then apply 027.

---

## 4. Steps

Steps marked **[HUMAN]** need production access I do not have and must not
assume. Steps marked **[DECISION]** are blocked on a question in §7.

### 1 — Freeze ✅ DONE
Recorded above. Both trees clean, both suites green at the frozen SHAs.

### 2 — Push backend **[HUMAN]**
Standing hard rule: the backend is never pushed without an explicit command,
and the instruction in force is *local only*. This step is queued, not pending.

```bash
cd servana_api && git log origin/main..HEAD --oneline   # expect 38
git push origin main
```

### 3 — Review CI / build from pushed HEAD **[HUMAN]**
Run the gate verbatim from a clean clone, not from this working tree:

```bash
git clone https://github.com/PaulEspinas2020/servana_api.git /tmp/verify && cd /tmp/verify
npm ci && npm run verify
echo "exit: $?"        # must be 0
```

### 4 — Apply migrations 027 and 028 **[HUMAN]**

Plan first. The runner defaults to plan mode and only writes with `--apply`:

```bash
npx ts-node scripts/run-migrations.ts
# expect pending: 027-booking-lifecycle-timestamps.sql
#                 028-booking-synthetic-marker.sql
```

Then apply:

```bash
npx ts-node scripts/run-migrations.ts --apply
# expect: applied 027-... then applied 028-...
```

027 carries no `BEGIN`/`COMMIT` of its own — the runner wraps each migration in
a transaction, and an inner `COMMIT` would end it early and defeat the plan.

### 5 — Verify 027 in the ledger **[HUMAN]**

```sql
SELECT migration_name, checksum_sha256, applied_at
  FROM servana.schema_migrations
 WHERE migration_name = '027-booking-lifecycle-timestamps.sql';
```

One row, and the checksum must match the file. A ledger row with a *different*
checksum means a modified migration was applied — stop and investigate.

### 6 — Verify the four columns **[HUMAN]**

```sql
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_schema = 'servana'
   AND table_name   = 'booking_workers'
   AND column_name IN ('accepted_at','en_route_at','arrived_at','declined_at')
 ORDER BY column_name;
```

Expect exactly four rows, all `timestamp with time zone`, all `YES` nullable.
Fewer than four → do not proceed to step 8.

### 7 — Verify the RUNTIME role can write them **[HUMAN]**

Existence is not permission. A migration applied as `postgres` can leave a
column the application role cannot write — this project has been bitten by an
ownership mismatch before, which is why this is its own step.

```sql
-- as the runtime role, or with SET ROLE to it
SELECT grantee, privilege_type
  FROM information_schema.column_privileges
 WHERE table_schema = 'servana' AND table_name = 'booking_workers'
   AND column_name = 'arrived_at';
```

Non-destructive write proof, inside a rolled-back transaction:

```sql
BEGIN;
UPDATE servana.booking_workers SET arrived_at = arrived_at WHERE false;
ROLLBACK;
```

`WHERE false` touches no row but still requires the UPDATE privilege on the
column, and the `ROLLBACK` guarantees nothing is left behind.

### 8 — Cut over / restart **[HUMAN]**
Only after 4–7 are green.

```bash
pm2 restart servana-prod && pm2 logs servana-prod --lines 50
```

PM2 process is `servana-prod` on **port 8000**, not 3000.

### 9 — Authenticated production booking smoke **[HUMAN]**
Create **ONE** booking marked `is_synthetic = true`, then run the full
lifecycle through the canonical executor: ASSIGN → ACCEPT → EN_ROUTE →
ARRIVED → START → COMPLETE, plus admin reassign / cancel / approve and one
auto-assignment. Same executor, same code path — see §7.

### 10 — Lifecycle preservation / integrity checks **[HUMAN]**
Checklist in §6, plus: confirm the synthetic booking is absent from the
dashboard KPIs, revenue, provider performance and supply analytics, and
present on the admin board.

### 11 — Deploy Admin portal **[HUMAN]**
Only after the backend is verified. Deploying the portal first is safe by
design — the canonical fields are optional and the fallback is exercised — but
it buys nothing, because the canonical tabs stay hidden until the backend can
count canonically.

### 12–15 — Admin board verification
Checklist in §6. These need a browser against production and can be done by
whoever has an admin login; no special access beyond that.

### 16 — TAB 05
Held. Boundary recorded in §8.

---

## 5. Rollback

Migration 027 is **additive and nullable**, so it does not need reverting: rolling
the application back to the previous release leaves four unused columns behind.
That is the intended property — the migration is safe to apply *before* the code
precisely because it is invisible to the old code.

Application rollback is the normal PM2 path. The one thing that is **not**
reversible by redeploying is data written by the new executor into
`booking_transitions` — that is evidence, and it is meant to persist.

---

## 6. Post-deploy verification

### Backend, after each applicable operation

| Check | Expected |
|---|---|
| `canonicalState` | matches the operation just performed |
| `booking_workers` | at most one active row |
| `bookings.status` | legacy projection consistent with canonical |
| `bookings.worker_uid` | names the live provider, or null after cancellation |
| `booking_transitions` | one row per committed transition, `state_changed` correct |
| `booking_tracking` / timeline | legacy projections written |
| raw mutations | none outside `transitionBooking` |

### Admin board

| Check | Expected |
|---|---|
| List state = detail state | identical for the same booking |
| Filter state = displayed state | filtering to X returns only X |
| Tab count = canonical metric count | tabs sum to total |
| `EN_ROUTE` | visible **and** filterable |
| `ARRIVED` | visible **and** filterable |
| Closed assignment | shows `AWAITING_ASSIGNMENT`, not Assigned |
| `REFUNDED` / `FAILED` / `EXPIRED` | not shown as New |
| `operationsStatus` | compatibility only |

Two behaviours to confirm explicitly:

- **`?operationsStatus=accepted` still returns the broader set** — ACCEPTED
  *and* EN_ROUTE *and* ARRIVED. An old bookmark must not silently narrow.
- **A tab click converges the URL on `?canonicalState=...`** and clears the
  legacy param.

### The hidden tabs

`EN_ROUTE` and `ARRIVED` tabs are hidden while the metrics response lacks
`byCanonicalState`. After the backend deploys they should appear with no portal
change. **If they do not, the backend deploy did not take** — the tabs are a
live indicator of which backend the portal is talking to.

### Telemetry

`BookingStateTelemetry.report()` in the browser console. Expect
`legacy=0 unknown=0` once both sides are deployed. Any non-zero `legacy` names
the surface still falling back, and `operationsStatus` cannot be retired until
that reads zero.

---

## 7. The synthetic marker — DECIDED (option A), IMPLEMENTED

The required smoke is a write lifecycle through to COMPLETE. Production carries
109 bookings and has never recorded a completion, so an unmarked smoke would
create the platform's **first completion** — synthetic, indistinguishable from
real, and the first data point for completion rate and provider acceptance rate.

Option A was chosen: an explicit, server-controlled classification, added
*before* the smoke rather than cleaned up after.

### What it is

`bookings.is_synthetic BOOLEAN NOT NULL DEFAULT false` (migration **028**).

Explicit, never inferred. Nothing deduces synthetic status from an email
address, a customer or provider name, or an id range — every one of those is a
heuristic a real customer eventually collides with, and the failure is silent:
real revenue quietly dropped from a report.

Server-controlled. No request body is read into the column, enforced by a
detector over the whole `src/` tree with a negative fixture.

### The principle

> The marker changes accounting, reporting and external-risk treatment.
> It changes **nothing** about lifecycle semantics.

A synthetic booking runs the same canonical executor, takes the same locks and
produces the same `booking_workers` mutations, `booking_transitions`,
`booking_tracking` projections and `canonicalState`. There is **no separate
test-transition path** — one would exercise code that never runs in anger.
Asserted directly: the executor, the canonical derivation, the SQL generators
and the projections all contain no reference to the marker.

### Excluded from (REPORTING)

| Surface | Why |
|---|---|
| `adminDashboardService#bookingAggregations` | total bookings, completion rate, cancellation rate |
| `adminFinanceService#revenue` | revenue / GMV |
| `providerPerformanceService#providerStats` | acceptance, decline, completion, on-time |
| `providerSupplyHealthService#demand` | unassigned-demand analytics that steer supply |

### Deliberately NOT excluded from (OPERATIONAL)

| Surface | Why |
|---|---|
| `adminBookingService#getAdminBookings` | an admin must SEE the smoke and watch it move |
| `adminBookingService#getAdminBookingDetail` | the audit trail of what the release exercised |
| `adminBookingService#getAdminBookingMetrics` | tab counts index the board; they must sum to the list |

The classification is a declared inventory in
`src/services/booking/syntheticBookings.ts`, not scattered `AND is_synthetic =
false` copies. A new query that is not classified fails the suite, which forces
somebody to decide rather than defaulting to the wrong answer — a KPI that is
slightly wrong looks exactly like one that is right.

### Money

`createDisbursement` throws `SyntheticFinancialRefusal` before any PayMongo
call. Exactly one financial check, at the one function that moves funds — not a
general test mode, because a broad financial bypass is a larger risk than the
one it prevents. It **throws** rather than returning null: the neighbouring
guards (no provider, no price) are ordinary business conditions, while this one
means a synthetic booking reached a money path.

Narrowness is enforced: a test walks `src/` and asserts exactly one consumer.

### Verified before the smoke

```
REAL BOOKING              counted in normal metrics
SYNTHETIC BOOKING         not counted in business metrics
ADMIN EXPLICIT QUERY      can retrieve it
CANONICAL STATE           unchanged by the flag
TRANSITION EXECUTOR       same code path
PROVIDER PERFORMANCE      synthetic accept/decline does not move real metrics
COMPLETION METRICS        synthetic completion is not the first real one
```

26 assertions, with negative fixtures on the body-read detector and on the
reporting-filter guard — removing a filter from a reporting surface fails the
suite, verified by temporarily removing one.

### Migration order

028 is independent of 027 and equally additive, but apply **both** before
cutover. Neither needs reverting: both leave unused columns if the app rolls
back, which is the property that makes them safe to apply first.

### Retention

Do not delete the smoke booking to make production look clean. Once marked and
excluded, keeping it is the audit trail of exactly what the release exercised.

---

## 8. TAB 05 boundary, frozen

```
TAB 05 MAY OWN
  provider eligibility · service qualification · availability
  geography · distance · ranking · candidate generation
  matching · auto-assignment SELECTION policy

TAB 05 MAY NOT OWN
  booking lifecycle writes · booking_workers lifecycle writes
  assignment commit mechanics · canonical state derivation
  transition timeline · lock protocol
```

Any provider TAB 05 selects must reach the database through
`transitionBooking`. Selection is a question; committing the answer is the
executor's job.

This is enforceable, not just stated: `tests/booking-raw-write-guard.test.ts`
holds an approved baseline of **0** raw status mutations outside the executor,
so a TAB 05 change that writes lifecycle state directly fails the gate.
