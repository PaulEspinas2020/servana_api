# DEPLOY2_RENAME_READINESS

Per §29. Deploy 1 succeeds only if the backend no longer needs the physical name
`services` for legacy-family semantics.

## Remaining physical `services` references in `src/`

| Location | Purpose | Safe for rename? | Required fix |
|---|---|---|---|
| `serviceApplicationService.ts` — `worker_service_applications` DDL, `service_id INT NOT NULL REFERENCES ${dbSchema}.services(id)` | Foreign key in a lazy `CREATE TABLE IF NOT EXISTS` | **NO** | Repoint to `service_families` in Deploy 2, once it is a real table. A FK cannot reference a view, which is why it could not move in Deploy 1. |

**That is the only one.** All other legacy-family access now goes through
`service_families` (45 references).

## Is it a blocker?

**No, but it must be in the Deploy 2 migration commit.** The statement only executes
on a database where `worker_service_applications` does not yet exist — never in
production, where it does. The risk is a fresh environment created after Deploy 2
binding the FK to the bookable table.

## Deploy 2 checklist

1. Repoint the FK reference to `service_families`.
2. Migration, one transaction:
   ```sql
   DROP VIEW servana.service_families;
   ALTER TABLE servana.services RENAME TO service_families;
   ALTER TABLE servana.service_families RENAME CONSTRAINT services_pkey TO service_families_pkey;
   ALTER TABLE servana.catalog_services RENAME TO services;
   ALTER TABLE servana.services RENAME CONSTRAINT catalog_services_pkey TO services_pkey;
   ```
   Constraint order matters — `services_pkey` must be freed before it is claimed, or
   the migration fails with `relation "services_pkey" already exists`.
3. Confirm ownership of the renamed objects is still `admin`.
4. Re-run the §16 old-code test: Deploy 1's code names only `service_families`, so
   it survives the rename. **Verify, do not assume.**
5. Smoke `/api/services`, `/api/services/full`, provider endpoints.
6. Stop. Admin Catalog V2 comes after the naming is stable.

## Readiness

**READY** — one classified, documented, non-blocking reference remains, with its fix
specified. No unexplained blockers.
