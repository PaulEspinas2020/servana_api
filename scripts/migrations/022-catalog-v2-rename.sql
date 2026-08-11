-- Catalog V2 — Phase 3: RENAME
--
-- Makes `services` mean what the business means by it: THE BOOKABLE ENTITY.
--
--   services            (19 rows, the legacy families)  ->  service_families
--   catalog_services    (95 rows, the bookable items)   ->  services
--
-- NO TRANSACTION CONTROL — the runner owns the transaction (see 020's header).
--
-- Postgres carries foreign keys through a table rename automatically, so all 7
-- FKs that point at the legacy table follow it to service_families without being
-- touched: service_options, service_coverage, branches, service_coverage_geo,
-- employee_services, worker_service_applications, service_review_dimensions.
-- Their column is still called service_id and it still means "family id" — that
-- is exactly the pre-existing meaning, preserved.
--
-- Every legacy query in the backend is repointed at service_families in the same
-- commit, so /api/services, /api/services/full, /api/services/:id/level2 and
-- /api/services/:id/options-with-addons keep returning precisely what they return
-- today. The shipped Flutter apps are unaffected.
--
-- Safe because the id spaces do NOT have to be reconciled: nothing reads the new
-- `services` table until the canonical API is wired. The legacy id space
-- (families, 1..70) stays in service_families; the bookable id space
-- (1..231, carried from service_options.id) lives in the new services.
--
-- Reverse:
--   ALTER TABLE servana.services RENAME TO catalog_services;
--   ALTER TABLE servana.service_families RENAME TO services;

-- Order matters. The legacy primary key is called services_pkey and a constraint
-- name must be unique per schema, so it has to be RENAMED AWAY before the new
-- table can claim it. Doing the table renames first and the constraints after
-- fails with 'relation "services_pkey" already exists'.
ALTER TABLE servana.services RENAME TO service_families;
ALTER TABLE servana.service_families RENAME CONSTRAINT services_pkey TO service_families_pkey;

ALTER TABLE servana.catalog_services RENAME TO services;
ALTER TABLE servana.services RENAME CONSTRAINT catalog_services_pkey TO services_pkey;
