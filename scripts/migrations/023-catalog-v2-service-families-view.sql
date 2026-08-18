-- Catalog V2 — Deploy 1: the service_families compatibility view
--
-- Introduces the NAME `service_families` for the legacy coarse service families,
-- without renaming anything. This is the compatibility boundary that makes the
-- physical rename in Deploy 2 safe.
--
-- NO TRANSACTION CONTROL — the runner owns the transaction.
-- MUST run through the deployment migration step under the `admin` role. Creating
-- objects manually as `postgres` is what caused the previous outage: the deploy
-- then failed on "permission denied" and left renamed tables facing old code.
--
-- Why this is safe for the CURRENTLY RUNNING code:
--   nothing is renamed, nothing moves, no row changes. `services` still exists and
--   still means exactly what it meant. Old code reading `services` is unaffected
--   whether or not the new code ever deploys.
--
-- Auto-updatable on purpose: a simple `SELECT *` over a single table with no
-- aggregate, DISTINCT, GROUP BY or set operation is updatable in PostgreSQL, so the
-- legacy INSERT/UPDATE/DELETE paths in serviceService (createService,
-- updateFullService, hardDeleteService) keep working through the view unchanged.

CREATE OR REPLACE VIEW servana.service_families AS
SELECT * FROM servana.services;

-- Ownership gate. Every other object in this schema is owned by `admin`, which is
-- the deploy and runtime role; a view owned by anyone else reintroduces the exact
-- permission failure that broke production.
ALTER VIEW servana.service_families OWNER TO admin;

COMMENT ON VIEW servana.service_families IS
  'Catalog V2 Deploy 1 compatibility view over the legacy coarse service families. '
  'In Deploy 2 this view is dropped and the physical table is renamed to this name, '
  'so application code that reads service_families keeps working across the cutover. '
  'The canonical bookable entity is catalog_services (95 Specific Services).';
