# MATERIAL DECISIONS

---

DECISION:
Treat `scripts/baseline/000-baseline.sql` as a schema AUTHORITY alongside the
migration chain, and rescope TAB 02 accordingly — from "move 154 runtime DDL
statements into migrations" to "author the 6 statements and 3 columns nothing
declares, then delete the 148 that are redundant".

CONTEXT:
TAB 02 was budgeted at one to two weeks and called "the multi-week core of the
command", entirely off `ddl:inventory`'s count of 154. That script asks only
whether a MIGRATION owns an object. It was written before TAB 15 added the
baseline, and never learned about it — so it reported the union of two unrelated
problems as one number.

OPTIONS:
1. Teach `runtime-ddl-inventory.ts` about the baseline, changing what the
   existing 154 budget means.
2. Add a second, separately named gate that classifies against migrations AND
   the baseline, and leave the existing budget measuring what it always did.
3. Take the 154 at face value and write ~112 no-op migrations.

SELECTED:
Option 2. `scripts/schema-authority.ts` + `tests/schema-authority.test.ts`,
with `ddl:inventory`'s budget lowered 154 → 148 and 112 → 106 only because
migration 036 genuinely claimed six objects.

WHY:
Both numbers are real and they bound different things. `ddl:inventory` bounds the
DELETION backlog — every one of those statements still has to go before the API
can start with DDL privileges revoked. `schema:authority` bounds the AUTHORING
gap, and only that one blocks: an object nothing in the repository declares
exists solely where the code has already run. Redefining the first number in
place would have destroyed the ability to compare against every prior report,
and Option 3 is a week of no-op SQL for objects a fresh database already builds.

EVIDENCE:
- `npm run schema:authority`: 214 runtime statements — 66 migration-owned, 148
  baseline-owned, 6 unmanaged. After 036: 0 unmanaged, 0 missing columns.
- Checked against the ENGINE, not the regex that found it: restoring the
  baseline into PGlite and asking PostgreSQL which tables exist confirms all 51
  baseline-owned CREATE TABLE targets and all 39 ALTER targets. 0 disagreements.
- 036 proven idempotent on real PostgreSQL in three orderings —
  migration-first, runtime-DDL-first, and double-apply — all converging on 132
  tables. The runtime-DDL-first case is the one that matters: it is what a
  deploy hits on a host where the app already bootstrapped the tables.
- Both new gates mutation-tested. A probe adding one runtime `CREATE TABLE` and
  one undeclared column turned 4 assertions red; removing it returned them to
  green.
- `npm run verify` exit 0 — 265 suites, 5768 tests, exit code read directly
  rather than through a pipe.

LOCAL IMPACT:
`scripts/schema-authority.ts`, `tests/schema-authority.test.ts`,
`scripts/migrations/036-booking-transition-evidence-onboarding.sql`, budget and
narrative updates in `runtime-ddl-budget.test.ts`, `schema-baseline.test.ts`
(43 → 46 proven columns), `suite-inventory.test.ts` (264 → 265), `lifecycle.ts`.

BACKWARD COMPATIBILITY:
None affected. 036 is additive and every table is `IF NOT EXISTS`; the three
`booking_workers` columns are nullable with no backfill, so a row predating them
reads as never cancelled. No runtime DDL was removed, so no code path gained a
dependency on a migration having run.

PRODUCTION IMPACT:
None yet, and the sequencing is load-bearing: 036 must be APPLIED before the
runtime DDL it replaces is deleted. Reversing that order makes booking
transitions depend on a migration that has not run.

DATE: 2026-08-17

---

DECISION:
Commit the entire 212-entry TAB 06–15 dirty tree as ONE local checkpoint rather
than decomposing it into per-TAB commits.

CONTEXT:
The session inherited a working tree with 76 modified tracked files and ~136
untracked ones, spanning ten TABs of work, uncommitted on top of `36ca152`. That
is a total-loss risk on any mishap.

OPTIONS:
1. One commit for the verified whole.
2. Per-TAB or per-domain commits reconstructed from the final snapshot.
3. Leave uncommitted and work on top.

SELECTED:
Option 1, plus a separate commit for the supervision area.

WHY:
Every domain added in that tree also edits `src/api/v1/contract.ts` and
`register.ts`, and the doc-drift gates regenerate their documents FROM that code.
Any per-domain split reconstructed after the fact would produce intermediate
commits that neither typecheck nor pass their own gate — history that lies about
having been green. Option 3 leaves the risk in place.

EVIDENCE:
`npm run verify` exit 0 before committing — 250 suites, 5648 tests.

LOCAL IMPACT:
`8282e46`, 247 files.

BACKWARD COMPATIBILITY:
None affected; no runtime behaviour changed by the act of committing.

PRODUCTION IMPACT:
None. Not pushed.

DATE: 2026-08-16

---

DECISION:
Add `@electric-sql/pglite` as a devDependency and make an executed replay the
authority for the fresh-database gate.

CONTEXT:
TAB 15's central claim — 11 missing tables, chain stops at migration 009 — rested
entirely on `scripts/lib/schemaModel.ts`, a 583-line hand-written DDL interpreter
validated only by its own suite. The tab was certified NOT_CERTIFIED partly on
the grounds that "no PostgreSQL engine is reachable."

OPTIONS:
1. Accept the model's conclusion and leave the tab blocked.
2. Install a PostgreSQL server locally.
3. PGlite — PostgreSQL compiled to WASM, in-process, no server or container.
4. `pg-mem` — a JS reimplementation of a Postgres-like engine.

SELECTED:
Option 3.

WHY:
Option 1 leaves a self-validating detector as the sole authority on the most
load-bearing structural claim in the repository. Option 2 needs administrative
install rights and still would not be reproducible in CI. Option 4 is a
reimplementation, so its disagreements with real PostgreSQL prove nothing.
PGlite is the actual PostgreSQL source compiled to a different target — same
parser, same planner — and runs anywhere Node does.

EVIDENCE:
Probed first: no `docker`, no `psql`, no `pg_dump`, no `initdb`, no
`C:\Program Files\PostgreSQL`. So the original "no engine" claim was true of
servers and false of the option actually taken.

The engine immediately contradicted the model:
  - chain dies on `001-massage-services.sql`, not 009;
  - 13 tables proven missing by execution, against the model's 11;
  - three the model had never reported — `provider_catalog_offerings`,
    `provider_onboarding_cases`, `service_options`.

Root cause: `schemaModel.ts` classified INSERT/UPDATE/SELECT/CREATE INDEX/
COMMENT ON as "no model impact", so a table depended on only by DML was
invisible. 001 is exactly that case.

LOCAL IMPACT:
`scripts/lib/embeddedEngine.ts`; `db:verify:embedded`; a third CI job; the model
widened to 18 tables; `TableRequirement.neededBy`; corrected assertions in
`tests/schema-baseline.test.ts`; both TAB 15 documents rewritten.

BACKWARD COMPATIBILITY:
Additive. The static gate keeps working with no dependency. No migration, route,
DTO or runtime path changed.

PRODUCTION IMPACT:
None. The embedded engine has no connection string and cannot be pointed at
anything.

DATE: 2026-08-16

---

DECISION:
Keep the executed replay OUT of Jest and OUT of `npm run verify`.

CONTEXT:
PGlite loads WASM through a dynamic `import()`, which Jest refuses without
`--experimental-vm-modules`.

OPTIONS:
1. Enable `--experimental-vm-modules` for the whole suite.
2. Run the engine in the gate script; keep only pure harness tests in Jest.

SELECTED:
Option 2.

WHY:
Turning on an experimental VM flag for 251 suites to accommodate one file trades
a broad stability risk for a narrow convenience. Separately, `db:verify` exits
non-zero **by design** while the gap is open, so it cannot join `verify` without
turning the green gate permanently red.

LOCAL IMPACT:
`npm run db:verify:embedded` is its own gate and its own CI job. The parts that
can rot silently — the error-message regex and the chain-application policy — are
unit-tested in Jest against a fake exec.

DATE: 2026-08-16

---

DECISION:
Assert engine ⊆ model, not engine = model.

CONTEXT:
The corrected model reports 18 missing tables; the engine proves 13.

WHY:
The engine stops each file at its first error, so a file blocked by `bookings`
never reveals that it also needs `payments`. The model reads every reference
regardless of execution order and legitimately sees more. Demanding equality
would produce a permanently failing gate that says nothing.

What must never recur is the inverse — the engine proving a table the model does
not report. That is the exact fail-open that produced this correction, and it is
what `db:verify:embedded` fails on.

LOCAL IMPACT:
Five of the eighteen are labelled "model only" in the certification rather than
being presented as equally proven.

DATE: 2026-08-16

---

DECISION:
Capture the production schema by streaming `pg_dump --schema-only` over SSH,
rather than restoring a dump into a disposable instance first.

CONTEXT:
The user explicitly authorised "get the schema dump" after the boundary was
raised. The repository's own capture tool refuses the production host by design.

OPTIONS:
1. Ask the user to produce a dump and restore it somewhere themselves.
2. Stream `pg_dump --schema-only --no-owner --no-privileges` over SSH, read-only.
3. Override the capture tool's production refusal and point it at production.

SELECTED:
Option 2.

WHY:
Option 1 was the original plan and the user declined it by instructing
otherwise. Option 3 would have removed a safety property permanently to perform
a one-off action; the refusal in `capture-schema-baseline.ts` is still intact and
still refuses production.

`--schema-only` takes brief ACCESS SHARE locks and reads no rows. Streaming to
stdout means nothing was written on the server, and the password was read from
the server's own `.env` inside the remote shell so it never crossed the link.

EVIDENCE:
Verified on the artifact before it entered the repository: 0 INSERT, 0 COPY,
0 OWNER TO, 0 GRANT, 0 email-shaped values, 0 bcrypt hashes, 0 JWTs, 0 matches
against FORBIDDEN_BASELINE_PATTERNS.

LOCAL IMPACT:
`scripts/baseline/000-baseline.sql` — 120 tables, 61 sequences.

PRODUCTION IMPACT:
One read. No write, no DDL, no credential change.

DATE: 2026-08-16

---

DECISION:
Mark the baseline version in a ledger instead of replaying the chain on top of
the baseline.

CONTEXT:
`verify-fresh-db` applied `[baseline, ...migrations]`. With a real baseline that
fails 12 of 36 migrations.

WHY:
The baseline IS the current schema, so replaying the chain replays spent history
against a schema that has moved on — 001–008 read `services.category`, removed
by Catalog V2; 023/024 expect `service_families` to be a view when it is now a
table. The migrations are not broken, they are spent.

This is the standard baseline-version pattern (Flyway `baseline`, Sqitch
`deploy --to`). The gate now asserts zero pending migrations, read back out of
the database rather than derived from the SQL that wrote it — deriving it from
the generator would be a check that could only agree with itself.

LOCAL IMPACT:
`ledgerAtBaselineSql()`; both the embedded and live gates use it.

PRODUCTION IMPACT:
None, and a finding: production has NO `schema_migrations` table at all.
Recorded as a P0 in the certification. Marking it is a production write and was
not performed.

DATE: 2026-08-16

---

DECISION:
Cache the baseline read and both catalog replays.

CONTEXT:
Adding the baseline made the suite fail intermittently in a DIFFERENT suite each
run. The reflex explanation — the project's known `--runInBand` order
sensitivity — was wrong, and was tested rather than assumed: stashing the work
gave 251/251 clean, restoring it reproduced the flakiness.

WHY:
`catalog-banner` validates a 4 MB upload with `/^data:([^;,]+);base64,(.+)$/`.
V8 sizes a regex stack against that 5.6 MB input, and under heap pressure the
allocation fails with `RangeError: Maximum call stack size exceeded` instead of
the expected size error. Eleven un-cached re-parses of a 235 KB baseline in one
shared heap were enough to tip it.

Caching is safe — nothing writes these files at runtime — and
`resetBaselineCaches()` exists for a test that deliberately changes disk.

The product-code fragility is NOT fixed here: it is outside this tab and it is a
real defect worth its own change. Recorded as P1.

DATE: 2026-08-16

---

DECISION:
Sweep TABs 01, 04, 07, 09, 13, 14 for the self-validating-detector failure class,
and mutation-test every gate rather than trusting a green result.

CONTEXT:
TAB 15 produced three instances of one shape: a specific, plausible, well-
commented claim that no independent source ever checked.

FINDINGS:

  TAB 13  DEFECT   5 of 54 capabilities declared a `domainModule` that none of
                   their endpoints reach. Every declared module existed as a
                   file, which is what made the claims read as verified.
  TAB 14  DEFECT   `ROLE_ACCESS` documented itself as "asserted against
                   register.ts's authChain". It was not — a source-text regex
                   and a presence check. The VALUES were correct; they were
                   simply unverified. Also named a test file that never existed.
  TAB 09  GAP      The 6 silent booking actions were a deliberate, well-argued
                   decision recorded only as prose. Nothing asserted the
                   partition, so a new action joined the silent half by default.
  TAB 07  CLEAN    Earnings derive from payments/disbursements/milestones, not
                   job cards. The ledger has a real writer called from five
                   modules. Partition gate added anyway.
  TAB 04  CLEAN    State matrix is GENERATED from BOOKING_ACTIONS, so it cannot
                   drift. Raw-write guard mutation-verified: an injected raw
                   status write produces 3 failures.
  TAB 01  CLEAN    Route existence mutation-verified: unmounting a real contract
                   entry produces 3 failures.

WHY MUTATION TESTING WAS NOT OPTIONAL:
The first version of the TAB 07 gate was VACUOUS. It counted any module
containing `recordLedgerEvent` as a writer, and every type is declared in one of
those modules, so each type matched its own declaration. An injected orphan did
not fail it. That is the exact defect being hunted, written into the detector
meant to hunt it — and only a mutation test found it.

The mutation test was itself wrong on the first attempt (injected into
financeLedger.ts when LEDGER_EVENTS is declared in financePolicy.ts), so it was
a no-op that "passed".

FOUR FALSE LEADS, ALL FROM GREP:
  - ADDITIONAL_WORK_CAPTURED looked producerless; it is emitted by a ternary
  - four booking events looked producerless; published generically from a map
  - the vacuous gate above
  - a mutation probe using `catalog.categories`, which is not a contract id
Every one was settled by reading the code. Grep says where to look.

PRODUCTION IMPACT:
None. One product defect fixed en route: a 4MB banner upload threw RangeError
instead of a clean 400.

DATE: 2026-08-16
