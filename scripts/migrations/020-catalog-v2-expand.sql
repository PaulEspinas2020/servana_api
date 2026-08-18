-- Catalog V2 — Phase 1: EXPAND
--
-- Canonical model (decided 2026-08-11):
--
--   categories.id
--     └── subcategories.id
--           └── services.id           <- THE BOOKABLE ENTITY
--                 └── service_options.id   <- variants/configuration only
--                       └── addons / questions
--
-- Additive ONLY. Creates new tables, reads nothing, changes no existing column,
-- and no existing query can see any of this. Safe to run on production at any
-- time; safe to drop wholesale to roll back.
--
-- Naming: the target name `services` is currently taken by the legacy service
-- FAMILY table (19 rows: "Beauty & Wellness", "Aircon 2"). These are created as
-- catalog_* now and renamed into place only in Phase 6, after every consumer has
-- moved. That keeps EXPAND non-breaking.
--
-- NO TRANSACTION CONTROL IN THIS FILE. The runner owns the transaction.
--
-- A migration that carries its own BEGIN/COMMIT cannot be dry-run: wrapping it in
-- an outer BEGIN does not isolate it, because its COMMIT ends the outer
-- transaction too and the change lands for real. This file was written that way
-- first and committed to production on what was meant to be a rehearsal; the
-- tables were empty and were dropped again, but the lesson is baked in here.
--
-- Dry run:  psql -1 -c 'BEGIN' -f this.sql -c 'ROLLBACK'   (or \i inside a tx)
-- Apply:    psql --single-transaction -f this.sql
--
-- Verified against production before writing:
--   * 109 bookings reference service_options.id
--   * the shipped customer app posts serviceOptionId when booking
--   * service_options.id occupies 1..231; catalog_services reuses those ids so
--     the number a customer already booked IS its canonical service id
--   * the current tree is already strict: 3 categories, 12 subcategories,
--     95 bookable services, 0 orphans, 0 cross-parent subcategories

-- ── Category ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS servana.catalog_categories (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(200) NOT NULL,
  slug          VARCHAR(200) NOT NULL UNIQUE,
  description   TEXT,
  icon_key      VARCHAR(100),
  image_url     TEXT,
  display_order INT NOT NULL DEFAULT 0,
  status        VARCHAR(20) NOT NULL DEFAULT 'active'
                  CHECK (status IN ('draft','active','inactive','archived')),
  -- Where this came from, so the migration is auditable and reversible.
  legacy_category_text TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at   TIMESTAMPTZ
);

-- ── Subcategory ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS servana.catalog_subcategories (
  id            SERIAL PRIMARY KEY,
  category_id   INT NOT NULL REFERENCES servana.catalog_categories(id),
  name          VARCHAR(200) NOT NULL,
  slug          VARCHAR(200) NOT NULL,
  description   TEXT,
  icon_key      VARCHAR(100),
  image_url     TEXT,
  display_order INT NOT NULL DEFAULT 0,
  status        VARCHAR(20) NOT NULL DEFAULT 'active'
                  CHECK (status IN ('draft','active','inactive','archived')),
  -- Legacy provenance: the (services.id family, level_2) pair this came from.
  legacy_service_family_id INT,
  legacy_level_2           VARCHAR(100),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at   TIMESTAMPTZ,
  -- Slug unique within its category, per the agreed policy.
  UNIQUE (category_id, slug)
);

-- ── Service — THE BOOKABLE ENTITY ───────────────────────────────────────────
-- id is NOT a fresh sequence. It is seeded from service_options.id so that the
-- identifier a customer already booked and the canonical service id are the same
-- number. That makes the legacy mapping an identity function, lets historical
-- bookings be read through the new model without a lookup table, and means the
-- shipped app's serviceOptionId keeps resolving during the whole migration.
CREATE TABLE IF NOT EXISTS servana.catalog_services (
  id                 INT PRIMARY KEY,
  subcategory_id     INT NOT NULL REFERENCES servana.catalog_subcategories(id),
  name               VARCHAR(300) NOT NULL,
  slug               VARCHAR(300) NOT NULL UNIQUE,
  short_description  TEXT,
  full_description   TEXT,
  image_url          TEXT,
  base_price         NUMERIC,
  unit               VARCHAR(100),
  estimated_duration_mins INT,
  display_order      INT NOT NULL DEFAULT 0,
  bookable           BOOLEAN NOT NULL DEFAULT true,
  status             VARCHAR(20) NOT NULL DEFAULT 'active'
                       CHECK (status IN ('draft','active','inactive','archived')),
  -- Provenance. legacy_service_option_id equals id for every migrated row; it is
  -- kept explicit so a future service created natively (with no legacy row) is
  -- distinguishable from a migrated one.
  legacy_service_option_id INT UNIQUE,
  legacy_service_family_id INT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at        TIMESTAMPTZ
);

-- Ids are assigned explicitly during backfill; this sequence only serves
-- natively-created services afterwards. Started above the legacy id space.
CREATE SEQUENCE IF NOT EXISTS servana.catalog_services_id_seq AS INT START 100000;

-- ── Provider capability at the bookable grain ───────────────────────────────
-- Today eligibility keys on the FAMILY (employee_services.service_id ->
-- services.id), so one approval covers every bookable service under it — up to
-- 54. Fanning that out to one row per bookable service PRESERVES today's
-- assignability exactly rather than widening or narrowing it.
CREATE TABLE IF NOT EXISTS servana.catalog_provider_services (
  id            SERIAL PRIMARY KEY,
  provider_uid  TEXT NOT NULL,
  service_id    INT NOT NULL REFERENCES servana.catalog_services(id),
  status        VARCHAR(20) NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','paused','archived')),
  -- Which legacy family approval produced this row, so it can be reversed.
  legacy_service_family_id INT,
  source        VARCHAR(30) NOT NULL DEFAULT 'migrated_from_family'
                  CHECK (source IN ('migrated_from_family','admin_grant','application_approved')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider_uid, service_id)
);

CREATE INDEX IF NOT EXISTS catalog_subcategories_category_idx
  ON servana.catalog_subcategories(category_id);
CREATE INDEX IF NOT EXISTS catalog_services_subcategory_idx
  ON servana.catalog_services(subcategory_id);
CREATE INDEX IF NOT EXISTS catalog_provider_services_service_idx
  ON servana.catalog_provider_services(service_id);
CREATE INDEX IF NOT EXISTS catalog_provider_services_provider_idx
  ON servana.catalog_provider_services(provider_uid);

-- ── Booking linkage — added, never populated in this phase ──────────────────
-- bookings.service_option_id stays exactly as it is and remains authoritative.
-- This column is written only from Phase 4, for NEW bookings. Historical rows
-- are backfilled read-only later, and no existing booking is ever rewritten.
ALTER TABLE servana.bookings
  ADD COLUMN IF NOT EXISTS catalog_service_id INT;

-- Ownership, added after the deploy outage: objects created as `postgres` were
-- unusable by `admin`, the deploy and runtime role, and the deployment died on
-- "permission denied for table catalog_subcategories". Setting it explicitly makes
-- the result correct regardless of which role runs the migration. Idempotent.
ALTER TABLE servana.catalog_categories        OWNER TO admin;
ALTER TABLE servana.catalog_subcategories     OWNER TO admin;
ALTER TABLE servana.catalog_services          OWNER TO admin;
ALTER TABLE servana.catalog_provider_services OWNER TO admin;
ALTER SEQUENCE servana.catalog_services_id_seq OWNER TO admin;
