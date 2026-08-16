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
| 15 | Database baseline / fresh DB | **NOT_CERTIFIED** — locally exhausted |

## Current TAB — 15 (locally exhausted; blocked on a human boundary)

The gate is "a fresh database can reach current schema automatically." It cannot.

**The correction this session made.** TAB 15 had concluded 11 missing tables and a
stop at migration 009, from  — a hand-written DDL
interpreter validated only by its own suite. It was under-reporting: it recorded
a table only when an  named it, so DML-only dependencies were
invisible.

PGlite (PostgreSQL 18 compiled to WASM, in-process) executed the chain and proved:

- the chain dies on **001-massage-services.sql**, not 009 — it seeds by reading
   and , and 
  rethrows on first failure, so nothing after 001 runs;
- **13 tables proven missing** by execution, **18** by the widened model;
- three were never reported at all: ,
  , .


> servana_api@1.0.0 db:verify:embedded
> ts-node scripts/verify-fresh-db.ts --embedded

Servana fresh-database gate — STATIC replay (no engine required)

  baseline captured        NO
  migrations replayed      36
  statements parsed        366 (0 unparsed)
  tables reached           45
  bootstraps from zero     NO

  A fresh database CANNOT reach the current schema. 18 table(s)
  are altered or read by a migration and created by none:

    booking_escalations          needed by 030-booking-experiences.sql
      proven columns: category, opened_by_role, state_snapshot
    booking_workers              needed by 016-booking-worker-lifecycle-timestamps.sql, 027-booking-lifecycle-timestamps.sql
      proven columns: en_route_at, arrived_at, accepted_at, declined_at
    bookings                     needed by 020-catalog-v2-expand.sql, 028-booking-synthetic-marker.sql
      proven columns: catalog_service_id, is_synthetic
    chat_participants            needed by 032-messaging-read-receipts.sql
      proven columns: last_read_at
    disbursements                needed by 017-paymongo-transaction-integrity.sql
      proven columns: payout_attempt
    email_otps                   needed by 026-otp-purpose.sql
      proven columns: purpose
    employee_services            needed by 021-catalog-v2-backfill.sql, 029-capability-canonical-source.sql
    payments                     needed by 017-paymongo-transaction-integrity.sql, 018-payment-return-origin.sql, 020-payment-superseded-sessions.sql
      proven columns: checkout_attempt, refund_attempt, return_origin, superseded_session_ids
    provider_catalog_offerings   needed by 005-beauty-services.sql, 006-beauty-catalog-description.sql
      proven columns: id
    provider_onboarding_cases    needed by 021-backfill-submitted-onboarding-cases.sql
    provider_onboarding_drafts   needed by 021-backfill-submitted-onboarding-cases.sql
    service_families             needed by 024-catalog-v2-canonical-rename.sql
    service_option_meta          needed by 001-massage-services.sql, 002-massage-specific-services.sql, 003-nail-services.sql, 004-hair-barber-services.sql, 005-beauty-services.sql, 007-aircon-cleaning-services.sql, 021-catalog-v2-backfill.sql
    service_options              needed by 001-massage-services.sql, 002-massage-specific-services.sql, 003-nail-services.sql, 004-hair-barber-services.sql, 005-beauty-services.sql, 007-aircon-cleaning-services.sql, 008-aircon-installation-repair-services.sql, 021-catalog-v2-backfill.sql
    services                     needed by 024-catalog-v2-canonical-rename.sql, 025-catalog-v2-services-sequence.sql
      proven columns: id
    user_profile                 needed by 009-provider-profile-compliance.sql
      proven columns: public_display_name, public_bio, public_skills, public_languages, public_experience_summary, legal_address, profile_version, public_profile_version, updated_at
    worker_requirements          needed by 009-provider-profile-compliance.sql, 010-provider-contact-media-security.sql
      proven columns: storage_path, mime_type, byte_size, content_sha256, client_request_id, lifecycle_state, scan_status, issue_date, expires_at, identifier_mask, replacement_for_id, replaced_by_id, version, updated_at, scanner_engine, id
    worker_service_applications  needed by 029-capability-canonical-source.sql

  Capture a baseline: npm run baseline:plan

  Canonical semantics (§155-§157):
    pass  catalog-hierarchy-exists           services=true catalog_subcategories=true catalog_categories=true
    pass  services-to-subcategory            services.subcategory_id -> catalog_subcategories.id
    pass  subcategory-to-category            catalog_subcategories.category_id -> catalog_categories.id
    pass  services-is-catalog-v2             services former names: [catalog_services]
    pass  capability-to-canonical-service    catalog_provider_services.service_id -> services.id
    pass  no-canonical-fk-to-family          none
    pass  services-sequence-exists           present
    pass  services-sequence-floor            START 100000 — must clear carried-over ids
    pass  services-sequence-owned-by-column  OWNED BY services.id
    pass  services-id-default                services.id DEFAULT nextval('servana.catalog_services_id_seq')
    pass  no-unapproved-owner                all declared owners in [admin]
    pass  sequence-owner-approved            catalog_services_id_seq owner admin

  Migrations leaking transaction control: 0

  RESULT: FAIL
  Expected while no baseline exists. This is the gap TAB 15 documents.

Servana fresh-database gate — EMBEDDED PostgreSQL (PGlite, in-process)

  runner-faithful replay   dies on 001-massage-services.sql
  applied before that      0/36
  continue-past-failure    7/36 applied
  engine-proven missing    13 (converged in 3 round(s))
    booking_escalations
    booking_workers
    bookings
    chat_participants
    disbursements
    email_otps
    payments
    provider_catalog_offerings
    provider_onboarding_cases
    service_families
    service_options
    user_profile
    worker_requirements

  model agrees with engine yes

  EMBEDDED RESULT: FAIL
  A fresh database cannot reach the current schema. This is the TAB 15 gap,
  now proven by execution rather than by a model. now fails the build if the model ever again reports
less than the engine proves. Engine ⊆ model is the invariant (the engine stops
each file at its first error, so it legitimately sees fewer).

**Still open, and it needs a human:** a schema-only production dump restored into
a disposable PostgreSQL, then 
> servana_api@1.0.0 baseline:capture
> ts-node -r dotenv/config scripts/capture-schema-baseline.ts

Servana baseline capture — PLAN ONLY. Nothing was connected to.

  target file            scriptsaseline -baseline.sql
  catalog queries        7 (information_schema / pg_catalog only)
  reads application rows no

Tables the migration chain proves must exist before it runs (18):

  booking_escalations    3 proven column(s), altered by 1 migration(s)
      category, opened_by_role, state_snapshot
  booking_workers        4 proven column(s), altered by 2 migration(s)
      en_route_at, arrived_at, accepted_at, declined_at
  bookings               2 proven column(s), altered by 2 migration(s)
      catalog_service_id, is_synthetic
  chat_participants      1 proven column(s), altered by 1 migration(s)
      last_read_at
  disbursements          1 proven column(s), altered by 1 migration(s)
      payout_attempt
  email_otps             1 proven column(s), altered by 1 migration(s)
      purpose
  employee_services      0 proven column(s), altered by 0 migration(s)
  payments               4 proven column(s), altered by 3 migration(s)
      checkout_attempt, refund_attempt, return_origin, superseded_session_ids
  provider_catalog_offerings 1 proven column(s), altered by 0 migration(s)
      id
  provider_onboarding_cases 0 proven column(s), altered by 0 migration(s)
  provider_onboarding_drafts 0 proven column(s), altered by 0 migration(s)
  service_families       0 proven column(s), altered by 1 migration(s)
  service_option_meta    0 proven column(s), altered by 0 migration(s)
  service_options        0 proven column(s), altered by 0 migration(s)
  services               1 proven column(s), altered by 2 migration(s)
      id
  user_profile           9 proven column(s), altered by 1 migration(s)
      public_display_name, public_bio, public_skills, public_languages, public_experience_summary, legal_address, profile_version, public_profile_version, updated_at
  worker_requirements    16 proven column(s), altered by 2 migration(s)
      storage_path, mime_type, byte_size, content_sha256, client_request_id, lifecycle_state, scan_status, issue_date, expires_at, identifier_mask, replacement_for_id, replaced_by_id, version, updated_at, scanner_engine, id
  worker_service_applications 0 proven column(s), altered by 0 migration(s)

Refusals in force:
  • never the configured production host or database
  • non-local sources need BASELINE_SOURCE_ACK=<host:port>
  • output is scanned for secrets and personal data before it is written

To capture: restore a production dump into a DISPOSABLE instance, then
  npm run baseline:capture -- --from=postgres://user@localhost:5432/servana_baseline. Inferring the DDL was
rejected — a wrong baseline is worse than a missing one.

**PGlite cannot check ownership.** It runs as one bundled superuser, so role
separation is still only covered by the  CI job, which waits on a baseline.

## Environment gaps (all TABs)

- No PostgreSQL *server* locally (no docker/psql/pg_dump/initdb). PGlite now
  provides an in-process engine for replay, but not role separation.
- The only credentialed database is **production** — forbidden.
- No production smoke run; smoke suite exists and is planned-only.

## Git / working tree

Branch `main`. See `state.json` for HEAD and commit state.

## Next action

See `state.json.currentObjective`.
