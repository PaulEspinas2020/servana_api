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
src/services/booking/           transitionExecutor (ONE executor) + eligibilityPipeline
scripts/migrations/             36 migrations, 001..035
scripts/baseline/000-baseline.sql   CAPTURED production schema — 120 tables
scripts/lib/schemaModel.ts      static DDL replay (was under-reporting; widened)
scripts/lib/embeddedEngine.ts   EXECUTED replay on PostgreSQL 18 via PGlite
scripts/lib/schemaBaseline.ts   gap / requirements / semantics / ledger / caches
```

Gates — **all three green**:

- `npm run verify` — typecheck + typecheck:tests + guard + 10 doc-drift + test:ci.
  **PASS exit 0 — 251 suites, 5656 tests.**
- `npm run db:verify` — static fresh-DB gate. **PASS exit 0.**
- `npm run db:verify:embedded` — executed fresh-DB gate. **PASS exit 0.**

## Environment — corrected

**PostgreSQL 16.14 IS installed locally** (`C:\Program Files\PostgreSQL\16\bin`,
service `postgresql-x64-16` listening on 5432). It is simply not on `PATH`. An
earlier session — and this one, initially — recorded "no engine reachable"; that
was a misread probe and it is wrong.

Production: Linode `192.46.224.126`, SSH alias `servana` (root, key in
`~/.ssh/config`). App at
`/home/github-runner/actions-runner/_work/servana_api/servana_api`. DB is
`localhost:5432`, database `servana`, user `admin`. The **repo's local `.env` has
EMPTY `DB_HOST`/`DB_USER`/`DB_DATABASE`** — no production credentials live here.

## TAB status — all 15 certified

| TAB | Subject | Verdict |
| --- | --- | --- |
| 01–14 | (as certified by prior sessions) | CERTIFIED_WITH_NONBLOCKING_GAPS |
| 15 | Database baseline / fresh DB | **CERTIFIED_WITH_NONBLOCKING_GAPS** |

## TAB 15 — what this session established

Three corrections, each found by checking rather than trusting:

1. **The static model was under-reporting.** It recorded a table only when an
   `ALTER TABLE` named it, so DML-only dependencies were invisible. The chain
   dies on **001**, not 009 — 001 seeds by reading `servana.service_option_meta`
   and `servana.bookings`. 11 reported → 18 real. `db:verify:embedded` now fails
   the build if the model reports less than the engine proves (engine ⊆ model).
2. **"No engine reachable" was false** — see Environment above.
3. **The baseline destabilised the test suite**, and the reflex "known flake"
   explanation was wrong. Verified by stashing: 251/251 clean without it,
   intermittent with it. Cause: 11 un-cached re-parses of a 235 KB baseline
   raised heap enough that `catalog-banner`'s regex over a 5.6 MB data URI threw
   `RangeError` instead of its size error. Fixed by caching in `schemaBaseline.ts`.

**The gap is closed.** `pg_dump --schema-only --no-owner --no-privileges` was
streamed over SSH under explicit user authorisation (read-only; nothing written
on the server, no credential moved). Sanitised: 0 rows, 0 owners, 0 grants, 0
forbidden patterns. The gate restores it into PostgreSQL 18 and proves **121
tables, 0 pending migrations**.

**Key architecture point:** the baseline IS the current schema, so the chain is
NOT replayed on top of it — 12 of 36 migrations are *spent* and fail (001–008
read `services.category`, removed by Catalog V2). Instead the version is marked
in `servana.schema_migrations` (`ledgerAtBaselineSql()`), Flyway-baseline style.

## Open items — highest first

- **P0 Production has NO `schema_migrations` ledger.** It has never existed;
  `deploy.yml` never invokes the runner, so migrations were applied by hand.
  `npm run migrations:apply` against production today would find all 36 pending
  and fail on 001. Marking it is a **production write** and was NOT done.
- **P1 A 4 MB+ banner upload can throw `RangeError` instead of a clean 400** —
  `/^data:([^;,]+);base64,(.+)$/` over a multi-MB string. Real, product-side,
  deliberately not fixed here (outside TAB 15).
- **P1 Ownership unverified on a real engine** — PGlite has no role separation;
  the `fresh` CI job now activates but has not been observed running.
- **P2 `scripts/**` is typechecked by neither tsconfig.**

## Git / working tree

Branch `main`. Local commits this session:

```
917569a  supervisor: repair MEMORY.md
bad3c49  supervisor: TAB 15 checkpoint after the engine correction
5db9263  tab15: execute the migration chain on a real PostgreSQL — the model was wrong
8282e46  centralization: TABs 06-15 — booking experiences through fresh-DB gap
36ca152  (inherited)
```

Nothing pushed. Nothing deployed. One authorised production READ.
