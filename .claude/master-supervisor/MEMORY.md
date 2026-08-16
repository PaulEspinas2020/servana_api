# MASTER SUPERVISOR — MEMORY CHECKPOINT

Compact recovery state. Not a transcript.

## Master Command

**Servana Backend Centralization Command Book** — 15 standalone, priority-ordered
TABs. Primary goal: Customer Mobile, Customer Web, Provider Mobile, Provider Web
and Admin call the *same canonical endpoints* over *one domain service /
state machine*; role-specific routes only where authz/actions/payload genuinely
differ.

Hard constraints carried into every TAB:

- Providers are a protected live production dependency — do not break them.
- Catalog V2 is certified: `catalog_categories → catalog_subcategories → services`;
  `services.id` is the canonical Service identity.
- `service_families` is legacy coarse provenance — never the bookable identity.
- Shared changes must be additive/backward-compatible until every client migrates.
- No global field-rewriting middleware on canonical v1 routes — explicit DTOs.
- Never claim a test passed unless it was executed.

## Repository

`C:\Users\paulg\OneDrive\Desktop\servana_api-main` — Node + TypeScript + Express 5
+ Postgres (`pg`), Socket.IO, Firebase Admin, Jest/ts-jest.

Critical paths:

```
src/api/v1/contract.ts          ONE contract array — all 95 v1 endpoints
src/api/v1/register.ts          route composition; the only v1 mount point
src/api/v1/convergence.ts       federated capability registry + convergence verdicts
src/api/v1/errors.ts            canonical error catalog
src/api/v1/openapi.ts           OpenAPI generated FROM the contract
src/services/booking/           transitionExecutor (ONE executor) + eligibilityPipeline
scripts/migrations/             36 migrations, 001..035
scripts/lib/schemaModel.ts      static DDL replay (TAB 15) — was under-reporting
scripts/lib/embeddedEngine.ts   EXECUTED replay on PostgreSQL 18 via PGlite
scripts/lib/schemaBaseline.ts   gap / requirements / semantics / sanitisation
```

Gates:

- `npm run verify` — typecheck + typecheck:tests + guard:protected-contracts +
  10 doc-drift checks + `test:ci`. **PASS, exit 0 — 251 suites, 5654 tests.**
- `npm run db:verify` — static fresh-DB gate. **FAIL exit 1, correctly.**
- `npm run db:verify:embedded` — executed fresh-DB gate. **FAIL exit 1, correctly.**

The two `db:verify` gates are red *by design* and are deliberately NOT part of
`verify`. They go green when a baseline is captured.

## TAB status

| TAB | Subject | Verdict |
| --- | --- | --- |
| 01 | API centralization + registry | CERTIFIED_WITH_NONBLOCKING_GAPS |
| 02 | Auth + registration + identity | CERTIFIED (AUTH_V1_CONTRACT.md) |
| 03 | Catalog + search | CERTIFIED (CATALOG_V1_CONTRACT.md) |
| 04 | Booking core + state machine | CERTIFIED_WITH_NONBLOCKING_GAPS |
| 05 | Job orders + matching | CERTIFIED_WITH_NONBLOCKING_GAPS |
| 06 | Booking experiences | CERTIFIED_WITH_NONBLOCKING_GAPS |
| 07 | Payments + earnings | CERTIFIED_WITH_NONBLOCKING_GAPS |
| 08 | Messaging | CERTIFIED_WITH_NONBLOCKING_GAPS |
| 09 | Notifications + events | CERTIFIED_WITH_NONBLOCKING_GAPS |
| 10 | Profile + settings | CERTIFIED_WITH_NONBLOCKING_GAPS |
| 11 | Homepage composition | CERTIFIED_WITH_NONBLOCKING_GAPS |
| 12 | Reviews + quality | CERTIFIED_WITH_NONBLOCKING_GAPS |
| 13 | Cross-platform convergence | CERTIFIED_WITH_NONBLOCKING_GAPS |
| 14 | Observability + release safety | CERTIFIED_WITH_NONBLOCKING_GAPS |
| 15 | Database baseline / fresh DB | **NOT_CERTIFIED** — locally exhausted |

## Current TAB — 15 (locally exhausted; blocked on a human boundary)

The gate is "a fresh database can reach current schema automatically." It cannot.

**The correction this session made.** TAB 15 had concluded eleven missing tables
and a stop at migration 009, from `scripts/lib/schemaModel.ts` — a hand-written
DDL interpreter validated only by its own suite. It was under-reporting: it
recorded a table only when an `ALTER TABLE` named it, so dependencies expressed
as INSERT / UPDATE / SELECT / CREATE INDEX / COMMENT ON were invisible.

PGlite (PostgreSQL 18 compiled to WASM, in-process) executed the chain and proved:

- the chain dies on **001-massage-services.sql**, not 009 — it seeds the catalog
  by reading `servana.service_option_meta` and `servana.bookings`, and
  `run-migrations.ts` rethrows on first failure, so nothing after 001 runs;
- **13 tables proven missing** by execution, **18** by the widened model;
- three had never been reported at all: `provider_catalog_offerings`,
  `provider_onboarding_cases`, `service_options`.

A baseline verified against the old eleven-table list would have passed and still
been unable to create a database.

`npm run db:verify:embedded` now fails the build if the model ever again reports
less than the engine proves. The invariant is **engine ⊆ model**, not equality:
the engine stops each file at its first error, so it legitimately sees fewer.

**Still open, and it needs a human:** a schema-only production dump restored into
a disposable PostgreSQL, then `npm run baseline:capture`. Inferring the DDL was
rejected — a wrong baseline is worse than a missing one, because a missing one is
visibly missing.

**PGlite cannot check ownership.** It runs as one bundled superuser, so role
separation is still covered only by the `fresh` CI job, which waits on a baseline.

## Environment gaps (all TABs)

- No PostgreSQL *server* locally (no docker/psql/pg_dump/initdb). PGlite now
  provides an in-process engine for replay, but not role separation.
- The only credentialed database is **production** — forbidden.
- No production smoke run; the smoke suite exists and is planned-only.

## Git / working tree

Branch `main`, working tree **clean**. Local commits this session:

```
bad3c49  supervisor: TAB 15 checkpoint after the engine correction
5db9263  tab15: execute the migration chain on a real PostgreSQL — the model was wrong
8282e46  centralization: TABs 06-15 — booking experiences through fresh-DB gap
36ca152  (inherited) booking: ADMIN_REASSIGN records WHEN the outgoing assignment closed
```

Nothing pushed. Nothing deployed. No production access.

## Next action

TAB 15 has no remaining locally derivable work. The next step is the human
boundary recorded in `docs/database/TAB15_CERTIFICATION.md` §10.
