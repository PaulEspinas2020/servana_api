-- Catalog V2 — attach the id sequence to the canonical services table.
--
-- NO TRANSACTION CONTROL — the runner owns the transaction.
--
-- catalog_services was created with `id INT PRIMARY KEY` and populated with ids
-- carried over from service_options, so it never had a DEFAULT. That was correct
-- for the migration but leaves the table unable to accept a NEW service: an INSERT
-- without an explicit id fails on a NOT NULL violation. The Admin "Create Specific
-- Service" flow would hit that on its first use.
--
-- The sequence already exists (created in 020, START 100000) but was never attached.
-- 100000 is safely above the current max id of 231, so no collision is possible.
ALTER TABLE servana.services
  ALTER COLUMN id SET DEFAULT nextval('servana.catalog_services_id_seq');

ALTER SEQUENCE servana.catalog_services_id_seq OWNED BY servana.services.id;

-- Never move the sequence backwards; take whichever is higher.
SELECT setval('servana.catalog_services_id_seq',
              GREATEST(100000, (SELECT COALESCE(MAX(id), 0) FROM servana.services)),
              true);

ALTER SEQUENCE servana.catalog_services_id_seq OWNER TO admin;
