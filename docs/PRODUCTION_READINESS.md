# Production readiness — what stands between here and operational

> Evidence, not estimate. Every number below was measured in this repository on
> 2026-08-16; the method is named beside each one so it can be re-run.

## The headline

The v1 backend is **built and gated, and neither deployed nor adopted.**

```
backend implementation      COMPLETE   95 canonical endpoints from ONE contract
local verification          GREEN      252 suites, 5687 tests, exit 0
production deployment       NONE       63 commits unpushed; origin/main = 2e03a4b
client adoption             ZERO       57 endpoints legacy, 51 planned, 0 migrated
production smoke            NEVER RUN  tooling delivered, never executed
```

That last line is the one to hold on to. Every certification in `docs/` is a
statement about **this repository**, proven against tests and an in-process
PostgreSQL. None of it is a statement about the running system.

---

## 1. Blocking items, in the order they must happen

Ordering matters here, and it is not the obvious one.

### 1.1 Mark the production migration ledger — 16 rows, NOT 36

`servana.schema_migrations` **does not exist in production** and never has.
`.github/workflows/deploy.yml` never invokes the runner, so migrations were
applied by hand with no record.

Consequence: `npm run migrations:apply` against production today creates the
ledger, finds all 36 pending, and dies on `001`.

**Only 16 migrations may be marked applied.** Marking all of them does not defer
the rest — it forgets them, because the runner only ever applies what is absent
from the ledger.

```
npm run migrations:baseline:plan

  present            16   production already has these effects — safe to mark
  ABSENT              6   030–035, undeployed — MUST NOT be marked
  no schema effect   14   DML-only; no schema fingerprint — human judgement
```

The 14 DML-only migrations are catalog seeds (`001`–`008`), backfills and the
credential canary. They almost certainly ran, but the baseline cannot prove it,
so they are listed rather than assumed.

> **If `030`–`035` are marked applied, `finance_ledger_events`,
> `domain_event_outbox`, `account_settings`, `booking_support_cases`,
> `booking_reschedule_requests` and `booking_otp_events` are never created on any
> database bootstrapped from this baseline.**

### 1.2 Apply the six pending migrations BEFORE the code

This is the sequencing that is easy to get backwards, and the reason is subtle.

`recordLedgerEventBestEffort` **catches and logs** rather than throwing
(`financeLedger.ts:284`). So deploying the code before migration `031` does not
crash anything — it silently drops every financial ledger event while the
hourly `runDisbursements` cron keeps running. The result is a money path that
looks healthy and a reconciliation that can never balance, with no alarm.

A crash would be safer. Fail-soft is what makes the ordering load-bearing.

Proven safe to apply: all six land cleanly on production's real schema.

```
npm run db:verify:embedded
  restore + mark version   ok        121 tables (production's schema)
  pending applied on top   all clean   6 migrations
  final table count        128
```

Destructive-operation audit of the six: **none**. One `DROP TRIGGER IF EXISTS`
in `031`, immediately recreated. No `DROP TABLE`, no `TRUNCATE`, no
`DELETE FROM`, no type changes, no `SET NOT NULL` on existing columns.

Messaging is the exception that needs no ordering: `chat.repository.ts:561`
issues `ADD COLUMN IF NOT EXISTS last_read_at` at runtime, so `032`'s effect is
self-healing either way.

### 1.3 Push — currently blocked by a standing rule, not by readiness

63 commits are unpushed. For this repository a push to `main` **is** a
production deploy: `deploy.yml` triggers on push and runs on a self-hosted
runner on the production host.

The standing instruction in this project is that everything stays local until
the admin, client and worker apps are migrated. **That rule is not satisfied —
zero clients have migrated.** So this step is blocked by product sequencing, not
by engineering readiness.

---

## 2. What "operational" additionally requires

Deploying the backend is necessary and nowhere near sufficient. The Master
Command's goal is that five clients call the same canonical endpoints.

| Gap | State | Why it matters |
| --- | --- | --- |
| **Client migration** | 0 of 108 endpoints | The actual goal. Until a client calls v1, convergence is proven possible, not achieved. |
| **Legacy retirement** | 114 mappings live | Cannot begin: retirement is telemetry-gated and no v1 traffic exists to measure. |
| **Production smoke** | never executed | The suite and least-privilege credential strategy exist. The run needs credentials this environment must not hold. |
| **Ownership on a real engine** | unverified | PGlite runs as one superuser. The `fresh` CI job covers it and has never been observed running. |
| **Legacy telemetry** | no data | Deprecation schedule is written against traffic that does not exist yet. |

Migration order is already decided and is cost-based rather than arbitrary —
admin first (minutes to correct), then provider web, customer web, then the two
mobile clients last, because an installed build keeps calling whatever it knows
for as long as the customer leaves the app installed.

---

## 3. Risks found while preparing this

**A fail-soft money path.** Covered in §1.2. Worth restating as a standing
concern rather than a deploy step: a ledger write that logs and continues will
also hide a permissions problem, a full disk, or a constraint violation. It is
the right behaviour for not breaking a booking, and the wrong behaviour for
noticing. Reconciliation is the compensating control and it has never run
against production.

**Runtime DDL.** `chat.repository.ts` alters a table at runtime. It works, and
it requires the app role to retain ALTER on that table forever. It is also
invisible to the migration ledger, so the schema has a source of truth the
ledger does not know about.

**Deploy-time secret handling.** `deploy.yml` copies `.env` from the runner host
and, when no managed document scanner is configured, appends
`ALLOW_BASELINE_DOCUMENT_SCAN=true` so uploads fall back to the built-in
scanner. That is a deliberate, commented decision — but it means production
document scanning is currently the built-in signature scanner, not a managed
one. Worth a conscious re-confirmation before scale.

**An intermittent test.** `OTP semantics › a rotation restores the budget`
failed twice in one session and passed in isolation and on re-run. Characterised
as `--runInBand` order-sensitivity; **not root-caused.** It is the one open
question in the suite.

---

## 4. Ready, pending authorisation

Everything below is prepared and verified locally. None of it has been executed.

```
1  mark the ledger        16 rows — see npm run migrations:baseline:plan
2  apply 030–035          proven clean on production's schema
3  push / deploy          63 commits; push IS the deploy
4  production smoke       npm run smoke:plan, then smoke with credentials
5  migrate client 1       admin web — cheapest to correct
```

Steps 1–4 are production actions. Step 3 additionally conflicts with the
standing local-only rule.

**Rollback:** `docs/database/DATABASE_BASELINE_CAPTURE.md` §7–§8 covers restore
and rollback. The six migrations are additive, so the rollback for step 2 is
dropping the six new tables and the one added column — no data loss, because
nothing writes to them until v1 traffic exists.

---

## 5. What this document does not cover

- Load, capacity or performance under real traffic. Nothing here was measured
  against production volume.
- The eight unswept TABs (02, 03, 05, 06, 08, 10, 11, 12) for the
  self-validating-check failure class that three of six swept tabs carried.
- Client-side readiness. This is a backend view; the Flutter and Angular
  repositories have their own state.
