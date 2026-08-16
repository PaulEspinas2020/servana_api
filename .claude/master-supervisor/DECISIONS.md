# MATERIAL DECISIONS

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
