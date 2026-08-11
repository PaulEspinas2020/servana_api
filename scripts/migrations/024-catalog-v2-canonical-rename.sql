-- Catalog V2 — Deploy 2: the canonical rename
--
--   service_families  view  ->  DROPPED
--   services          (10 legacy families)  ->  service_families   (real table)
--   catalog_services  (95 Specific Services) ->  services          (THE BOOKABLE ENTITY)
--
-- NO TRANSACTION CONTROL — the runner owns the transaction. Must run through the
-- deployment migration step under `admin`. No manual production DDL.
--
-- Why there is no window this time:
--
--   The code currently RUNNING is Deploy 1's, and it names `service_families` for
--   every legacy-family read (45 references). It never names the physical `services`
--   table except in one lazy CREATE TABLE IF NOT EXISTS whose table already exists,
--   so that statement is skipped and never evaluates the reference.
--
--   Inside this transaction `service_families` stops being a view and becomes a
--   table with the identical rows. DDL is transactional in PostgreSQL, so no other
--   session observes the intermediate state — they block until commit and then see
--   the finished result.
--
--     before : service_families = view over 10 families        running code OK
--     after  : service_families = table of the same 10 rows    running code OK
--     after  : services         = the 95 Specific Services     nothing reads it yet
--
-- Constraint order is load-bearing. A constraint name is unique per schema, so the
-- legacy `services_pkey` must be renamed AWAY before the new table can claim it.
-- Doing both table renames first and the constraints afterwards fails with
-- `relation "services_pkey" already exists` — proven during the earlier attempt,
-- where --single-transaction rolled it back cleanly.
--
-- Reverse (proven — this is what restored service during the earlier outage):
--   ALTER TABLE servana.services RENAME TO catalog_services;
--   ALTER TABLE servana.catalog_services RENAME CONSTRAINT services_pkey TO catalog_services_pkey;
--   ALTER TABLE servana.service_families RENAME TO services;
--   ALTER TABLE servana.services RENAME CONSTRAINT service_families_pkey TO services_pkey;
--   CREATE OR REPLACE VIEW servana.service_families AS SELECT * FROM servana.services;
--   ALTER VIEW servana.service_families OWNER TO admin;

DROP VIEW servana.service_families;

ALTER TABLE servana.services RENAME TO service_families;
ALTER TABLE servana.service_families RENAME CONSTRAINT services_pkey TO service_families_pkey;

ALTER TABLE servana.catalog_services RENAME TO services;
ALTER TABLE servana.services RENAME CONSTRAINT catalog_services_pkey TO services_pkey;

-- Ownership must survive the rename. It does in PostgreSQL, but the outage came
-- from an ownership assumption, so assert it rather than trust it.
ALTER TABLE servana.service_families OWNER TO admin;
ALTER TABLE servana.services         OWNER TO admin;

COMMENT ON TABLE servana.services IS
  'Catalog V2 canonical bookable entity: the 95 Specific Services. '
  'services.id is the canonical service identity for provider capability, future '
  'booking, matching and analytics. Category is derived through '
  'subcategory_id -> catalog_subcategories -> catalog_categories.';

COMMENT ON TABLE servana.service_families IS
  'LEGACY coarse service families. Retained for provenance: employee_services, '
  'worker_service_applications, service_options, branches and coverage still key on '
  'these ids. Not the canonical catalog hierarchy and not for everyday management.';
