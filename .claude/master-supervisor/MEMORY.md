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
src/api/v1/contract.ts        ONE contract array — all 95 v1 endpoints
src/api/v1/register.ts        route composition; the only v1 mount point
src/api/v1/convergence.ts     federated capability registry + convergence verdicts
src/api/v1/errors.ts          canonical error catalog
src/api/v1/openapi.ts         OpenAPI generated FROM the contract
src/services/booking/         transitionExecutor (ONE executor) + eligibilityPipeline
scripts/migrations/           36 migrations, 001..035
scripts/lib/schemaModel.ts    engine-free DDL replay (TAB 15)
scripts/lib/schemaBaseline.ts gap / requirements / semantics / sanitisation
```

The gate is **`npm run verify`**: typecheck + typecheck:tests +
guard:protected-contracts + 10 doc-drift checks + `test:ci`.

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
| 15 | Database baseline / fresh DB | **NOT_CERTIFIED** — current TAB |

## Current TAB — 15

The command's first release gate is "a fresh database can reach current schema
automatically." It cannot: **11 foundational tables are altered by migrations and
created by none**, so a fresh chain stops at `009-provider-profile-compliance.sql`.

Proven, not suspected: `scripts/lib/schemaModel.ts` replays 36 migrations,
366 statements, **0 unparsed**, and reports the stop.

Missing: `booking_escalations`, `booking_workers`, `bookings`, `chat_participants`,
`disbursements`, `email_otps`, `payments`, `service_families`, `services` (legacy),
`user_profile`, `worker_requirements`.

Verified independently this session:

- no `docker`, no `psql`, no `pg_dump`, no `initdb`, no `C:\Program Files\PostgreSQL`;
- no schema DDL anywhere in git history (`git log --all -- '*.sql'` finds only the
  36 migrations plus one deleted rename and one diagnostic query).

So the blocker is genuine and external, not an unexplored option.

## Environment gaps (all TABs)

- No PostgreSQL engine of any kind reachable locally.
- The only credentialed database is **production** — forbidden.
- No production smoke run; smoke suite exists and is planned-only.

## Git / working tree

Branch `main`. See `state.json` for HEAD and commit state.

## Next action

See `state.json.currentObjective`.
