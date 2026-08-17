# RESUME — Servana API MASTER COMMAND (12 TABs)

Repo state at handoff: branch `main`, working tree **clean**, nothing deployed.
Check the commit count yourself — `git rev-list --count origin/main..HEAD` — the
last two handoffs both recorded a number that was already stale by the time the
next session read it.

Read this, then `MEMORY.md`, `state.json`, `DECISIONS.md`, and
`docs/PRODUCTION_READINESS.md`. Everything below was measured, not remembered.

---

## 1. Prove the baseline before changing anything

```
npm run verify              expect PASS — 265 suites, 5768 tests
npm run db:verify:embedded  expect PASS — 121 restored + 7 applied = 132 tables
npm run schema:authority    expect UNMANAGED 0, MISSING columns 0  (exits 0)
npm run ddl:inventory       expect 148 unmanaged, 106 objects  (exits 1 BY DESIGN)
npm run authz:legacy        expect 615 routes, 0 loosenings
npm run release:summary     writes reports/release-summary.json
```

**THREE gates exit non-zero deliberately**, not two as this file previously said:
`db:verify`, `ddl:inventory` and `migrations:baseline:plan`. None of them belongs
in `npm run verify`.

Read the numbers as a pair. `ddl:inventory` counts what no MIGRATION owns;
`schema:authority` counts what NOTHING in the repository owns. The second is the
one that blocks.

---

## 2. TAB status

| TAB | Priority | State |
| --- | --- | --- |
| 01 Establish the release gate | P0 | **Done** except the concurrency suite |
| 02 Migrations the sole schema authority | P0 | **Rescoped and half-done — see §3** |
| 03 Atomic startup lifecycle | P0 | Done except tests needing a real boot |
| 04 Centralize authorization policy | P0 | Rules derived, parity gated, audit wired |
| 05 Converge clients onto v1 | P1 | Not started — 0 of 108 migrated |
| 06 Booking transitions the only write path | P0 | Not started (largely done by the previous command's TAB 04) |
| 07 Harden money movement | P0 | Not started |
| 08 Schedulers safe under scale | P1 | Not started |
| 09 Unify errors/logging/observability | P1 | Partly pre-existing |
| 10 Remove query amplification | P1 | Not started |
| 11 Data ownership / cross-store | P1 | Not started |
| 12 Security + dependency hygiene | P1 | Credential removed from build; 0 high CVEs |

---

## 3. TAB 02 was scoped from a number that meant something else

The previous handoff said: *"move 154 runtime DDL statements into migrations …
this is the multi-week core of the command and the thing everything else waits
on."* That was wrong, and `npm run schema:authority` now shows why.

`ddl:inventory` asks only whether a **migration** owns an object. Migrations
stopped being the only schema authority here when TAB 15 added
`scripts/baseline/000-baseline.sql` — production's own `pg_dump`, which
`db:verify:embedded` restores and then applies pending migrations on top of. The
154 was the union of two unrelated problems:

- **148 statements** touch an object the baseline already declares. Verified
  against the real engine, not a regex: restore the baseline into PGlite, ask
  PostgreSQL which tables exist, and all 51 tables and 39 ALTER targets are
  there. These are **redundant statements to DELETE**. Nothing to author.
- **6 statements and 3 columns** were declared by nothing in the repository.
  That was the whole authoring gap, and it was booking-critical:
  `booking_transitions`, `idx_booking_transitions_booking`,
  `booking_transition_idempotency` (the ONE canonical transition writer),
  `booking_evidence`, `idx_booking_evidence_booking_worker`,
  `worker_onboarding`, and `booking_workers.{cancelled_at,
  cancellation_reason_code, cancellation_note}`.

They are absent from production's dump, so they exist only where this unreleased
code has already run. On deploy the application would create them itself, at
runtime, on the booking write path — and would fail outright once DDL privileges
are revoked.

`scripts/migrations/036-booking-transition-evidence-onboarding.sql` closes that
gap. Every definition is a fingerprint of the runtime statement it replaces, and
that is proven rather than asserted — three orderings on real PostgreSQL
(migration-first, runtime-DDL-first, double-apply) all converge on 132 tables.

### What is actually left

**Delete 144 runtime DDL statements and the lazy bootstraps that await them.**
Mechanical and broad, not a design exercise. 148 → 144 is done:
`accountDeletionService` (table + 2 partial indexes) and
`providerOperationalAvailabilityService` (1 table + 3 lazy awaits).

⚠ **The 036 objects are the exception, and they are NOT part of this 144.**
Their runtime DDL stays until 036 is applied to production — deleting it first
makes booking transitions depend on a migration that has not run. Everything
else targets an object production already has, so it is safe now.

#### The recipe, per object

1. `npm run schema:authority` — confirm the object is `baseline`-owned, never
   `UNMANAGED`.
2. `grep -c '<object>' scripts/baseline/000-baseline.sql` — see the definition
   you are relying on, and cite its line in the replacement comment.
3. Delete the `ensure*` function. Replace it with a comment saying where the
   schema comes from **and what the deleted DDL guaranteed** — a partial unique
   index that an `ON CONFLICT DO NOTHING` depends on is invisible once the
   `CREATE INDEX` is gone.
4. Remove every caller: the `startup.ts` import and entry, AND the lazy
   `await ensure*()` at the top of each operation. Most of this DDL is awaited on
   a REQUEST path, not only at startup.
5. `npm run typecheck`, then `npm run verify`.
6. Lower `UNMANAGED_BUDGET` / `DISTINCT_OBJECT_BUDGET` in
   `tests/runtime-ddl-budget.test.ts` in the same commit.

#### Two traps, both hit on the first pass

- **Source-introspection tests pin the DDL.** ~10 assertions across 5 files
  assert on source TEXT that a bootstrap exists and creates a table — e.g.
  `admin-audit.test.js` expects `svcSrc` to contain
  `export async function ensureAuditSchema` and `startupSrc` to mention it.
  Deleting the function turns those red, and they have to be rewritten in the
  same commit. **Do the eight uncoupled ones first:**
  `ensureAdminNotifications`, `ensureDashboardSchema`, `ensureAttributionSchema`,
  `ensureAdminBookingDraftSchema`, `ensureOnboardingSchema`,
  `ensureIdentityColumns`, `ensureActivationSchema`, `ensureProviderWebSchema`.
  Coupled: audit, finance, permissions, create-booking, invite-state, chat
  lifecycle, provider-catalog.
- **Removing a line from a ROUTE file breaks a doc gate.** `api:docs:check`
  records `src/routes/*.ts:NN`, so deleting one dead import shifted three line
  numbers and failed `verify` BEFORE jest ran. Fix with `npm run api:docs` and
  check the diff is line numbers only. Service files are not affected — no
  generated doc cites a `src/services/**` line.

Acceptance is unchanged: the API starts with DDL privileges revoked.

---

## 4. Blocked on the human — say so early

1. **One real boot.** Nobody has started the actual server since `app.ts`
   startup was rewritten: 14 fire-and-forget bootstraps became a 19-dependency
   graph awaited before `listen`, plus `/healthz`, `/readyz` and SIGTERM
   draining. Verified as far as tests allow; not against reality. This remains
   the single largest unverified assumption in the whole body of work.
2. **The deploy decision.** A push to `main` **IS** the deploy. It also
   conflicts with the standing local-only rule, and 0 of 108 endpoints have
   migrated, so that rule is unsatisfied.
3. **Apply migration 036.** Authored, gated, committed, NOT applied. Until it
   is, production lacks four tables its own booking code writes to, and the
   deletion work in §3 cannot start. Applying it is a production write and needs
   the same explicit authorisation 030–035 got.
4. **`race go`.** A disposable `servana_race_test` database on the Linode host
   unblocks `tests/booking-postgres-races.test.ts`, which currently reports
   `BLOCKED_BY_TEST_DATABASE`. Measured as safe: the harness caps at 8
   connections and 2 concurrent transactions; the server is idle with 481 MB
   free. PGlite CANNOT substitute — single-connection, so no lock contention and
   no `40P01`.

---

## 5. Working rules that were earned the hard way

- **A number is not a scope.** TAB 02 was budgeted at one to two weeks from a
  count that answered a different question than the one being asked. Before
  costing work off a metric, read what the metric actually measures.
- **Check a classification against the engine, not the regex.** The
  baseline-owned claim was re-derived by restoring the baseline into PGlite and
  asking PostgreSQL. Regex and engine agreed — but that agreement is the
  evidence, and it was cheap.
- **Mutation-test every gate, and confirm the mutation landed.** Both new gates
  here were mutation-tested: a probe file adding one runtime `CREATE TABLE` and
  one undeclared column turned 4 assertions red. Six checks in an earlier
  session passed while broken; three were hunting that exact class.
- **Pipelines hide exit codes.** `npm run verify | tail` reported `exited with
  code 0` over a run with 2 failed suites. Redirect and check `$?`, or read the
  summary line — never trust the pipe.
- **Grep counts are not findings.** `ensureAccountDeletionTable` looked like a
  live route-module bootstrap and is a dead import; the "5 missing columns" were
  3, two being the SQL keyword `IF` captured by a backtracking regex.
- **Never let observability change a decision.** The authz audit threw inside a
  denial branch and turned a 403 into a bypass in a test.
- **Prefer the Edit tool to shell heredocs for code.** Heredocs mangled
  backslashes repeatedly — including writing real CR/LF into a JS regex, which
  stopped five suites parsing and dropped 586 tests with nothing red.
- **`\b` in a template literal is a backspace.** Use `String.raw`.
- **Do not read credential contents** to establish a finding; presence and
  permissions suffice.

---

## 6. Production state

The database is **ahead of** the deployed code, deliberately.

```
servana.schema_migrations   36 rows   (30 marked + 6 applied 2026-08-16)
servana tables             128
not owned by admin           0
servana-prod              online, 0 restarts through the change
```

Production has the schema for the finance ledger, outbox, account settings and
support cases — and not the code that writes to them. Harmless until v1 traffic
exists, but not a steady state.

It does **not** have 036's four tables. A fresh database built from this
repository now reaches **132** tables; production is at 128. That difference is
the one open schema gap, and it is on the booking write path.
