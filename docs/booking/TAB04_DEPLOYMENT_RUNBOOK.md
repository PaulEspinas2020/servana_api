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

### 4 — Apply migration 027 **[HUMAN]**

Plan first. The runner defaults to plan mode and only writes with `--apply`:

```bash
npx ts-node scripts/run-migrations.ts
# expect: {"mode":"plan", ..., "pending":["027-booking-lifecycle-timestamps.sql"]}
```

Then apply:

```bash
npx ts-node scripts/run-migrations.ts --apply
# expect: applied 027-booking-lifecycle-timestamps.sql
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

### 9 — Authenticated production booking smoke **[DECISION]** — see §7
### 10 — Lifecycle preservation / integrity checks **[DECISION]** — see §7

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

## 7. ⚠ The production smoke needs a decision before it runs

The required smoke is a **write** lifecycle: ACCEPT → EN_ROUTE → ARRIVED →
START → COMPLETE, plus admin assign / reassign / cancel / approve and one
auto-assignment. Three facts collide:

1. **The E2E canary is read-only against production by rule** — never used for
   a write path there. The customer-web `assertNotProduction()` guard refuses
   `api.servana.com.ph` deliberately, and was not weakened.
2. **There is no synthetic-account exclusion anywhere in the backend.** I
   grepped: no `is_test`, no exclusion in `adminBookingService`, nothing. A
   smoke booking lands in every metric with no way to filter it out afterwards.
3. **Production has 109 bookings and zero completions, ever.** A smoke that
   reaches COMPLETE creates the platform's first completion — synthetic,
   unmarked and permanent. It would also be the first data point for completion
   rate, provider acceptance rate, and anything downstream of them.

So running the full lifecycle against production is not a neutral act, and it
is not mine to decide. The options:

| | Approach | Cost |
|---|---|---|
| **A** | Full lifecycle on production with a synthetic-exclusion marker added first | needs a schema/filter change before the smoke — more scope, but the only option that leaves metrics trustworthy |
| **B** | Read-only verification on production; write lifecycle against a non-production API | needs the non-production API that has been the standing blocker |
| **C** | Full lifecycle on production, unmarked, and accept the metric pollution | cheapest now; permanently corrupts the first-completion data point |

**My recommendation: A**, and add the exclusion marker as its own small change
*before* the smoke rather than cleaning up after. The marker is useful
regardless — it is the same thing that would let the canary ever be used for a
write path — and "we will remember which booking was fake" is not a control.

Steps 9 and 10 stay blocked until this is chosen. Everything before them is
unaffected.

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
