-- Catalog V2 — Phase 2: BACKFILL
--
-- Populates the Phase 1 tables from the existing catalog. Reads only; writes only
-- into catalog_* tables. Touches no legacy row, no booking, no provider record.
--
-- NO TRANSACTION CONTROL IN THIS FILE — the runner owns the transaction, so this
-- can be dry-run and rolled back. See the header of 020 for why that matters.
--
-- Source of truth for the mapping:
--   CATEGORY     <- services.category      (free text)
--   SUBCATEGORY  <- service_options.level_2
--   SERVICE      <- service_options WHERE option_type='MAIN'   (id carried over)
--
-- Only families that actually carry a bookable service are migrated. That is what
-- excludes the 15 empty families and their 7 junk category strings
-- ('Test Category', 'sdasd', 'sadgbjsadha', 'Home Servicessfdsd', ...) which would
-- otherwise become junk entries in every Admin dropdown the moment Category is a
-- real entity.

-- Slug helper, inline: lowercase, non-alphanumeric collapsed to single dashes.
-- Kept as an expression rather than a function so this file installs nothing.

-- ── 1. Categories ───────────────────────────────────────────────────────────
INSERT INTO servana.catalog_categories (name, slug, display_order, status, legacy_category_text)
SELECT DISTINCT ON (s.category)
       s.category,
       trim(both '-' from regexp_replace(lower(s.category), '[^a-z0-9]+', '-', 'g')),
       0,
       'active',
       s.category
FROM servana.services s
JOIN servana.service_options so ON so.service_id = s.id AND so.option_type = 'MAIN'
WHERE s.category IS NOT NULL AND s.category <> ''
ORDER BY s.category
ON CONFLICT (slug) DO NOTHING;

-- ── 2. Subcategories ────────────────────────────────────────────────────────
-- One per (category, level_2). Verified beforehand that no level_2 spans two
-- categories, so this cannot produce a subcategory with an ambiguous parent.
INSERT INTO servana.catalog_subcategories
  (category_id, name, slug, display_order, status, legacy_service_family_id, legacy_level_2)
SELECT DISTINCT ON (c.id, so.level_2)
       c.id,
       so.level_2,
       trim(both '-' from regexp_replace(lower(so.level_2), '[^a-z0-9]+', '-', 'g')),
       0,
       'active',
       s.id,
       so.level_2
FROM servana.service_options so
JOIN servana.services s          ON s.id = so.service_id
JOIN servana.catalog_categories c ON c.legacy_category_text = s.category
WHERE so.option_type = 'MAIN'
  AND so.level_2 IS NOT NULL AND so.level_2 <> ''
ORDER BY c.id, so.level_2, s.id
ON CONFLICT (category_id, slug) DO NOTHING;

-- ── 3. Services — THE BOOKABLE ENTITY ───────────────────────────────────────
-- id is carried over from service_options.id on purpose: the number a customer
-- already booked becomes its canonical service id, so historical bookings resolve
-- through the new model with no lookup table and the shipped app keeps working.
--
-- The slug is suffixed with the id because service names repeat across
-- subcategories (e.g. the same treatment under two groups) and the policy is a
-- globally unique service slug.
INSERT INTO servana.catalog_services
  (id, subcategory_id, name, slug, short_description, base_price, unit,
   display_order, bookable, status, legacy_service_option_id, legacy_service_family_id, image_url)
SELECT so.id,
       sub.id,
       so.level_3,
       trim(both '-' from regexp_replace(lower(so.level_3), '[^a-z0-9]+', '-', 'g')) || '-' || so.id,
       NULLIF(m.description, ''),
       so.base_price,
       so.unit,
       0,
       COALESCE(so.is_active, true),
       CASE WHEN COALESCE(so.is_active, true) THEN 'active' ELSE 'inactive' END,
       so.id,
       s.id,
       so.banner_url
FROM servana.service_options so
JOIN servana.services s ON s.id = so.service_id
JOIN servana.catalog_categories c   ON c.legacy_category_text = s.category
JOIN servana.catalog_subcategories sub
     ON sub.category_id = c.id AND sub.legacy_level_2 = so.level_2
LEFT JOIN servana.service_option_meta m ON m.service_option_id = so.id
WHERE so.option_type = 'MAIN'
ON CONFLICT (id) DO NOTHING;

-- ── 4. Provider capability at the bookable grain ────────────────────────────
-- Today one family approval implies every bookable service under that family (up
-- to 54). Fanning out one row per service reproduces exactly today's
-- assignability — it neither widens nor narrows who can be assigned to what.
-- Approvals against the 15 empty families produce nothing, because those families
-- contain no bookable service.
INSERT INTO servana.catalog_provider_services
  (provider_uid, service_id, status, legacy_service_family_id, source)
SELECT es.employee_uid,
       cs.id,
       CASE WHEN COALESCE(es.status, 'active') = 'paused' THEN 'paused' ELSE 'active' END,
       es.service_id,
       'migrated_from_family'
FROM servana.employee_services es
JOIN servana.catalog_services cs ON cs.legacy_service_family_id = es.service_id
ON CONFLICT (provider_uid, service_id) DO NOTHING;

-- ── 5. Historical booking linkage — READ-ONLY mapping, not a rewrite ────────
-- Sets the new column on existing rows so history is readable through the new
-- model. service_option_id is left exactly as it was and stays authoritative;
-- nothing else on the booking is touched.
UPDATE servana.bookings b
SET catalog_service_id = b.service_option_id
WHERE b.service_option_id IS NOT NULL
  AND b.catalog_service_id IS DISTINCT FROM b.service_option_id
  AND EXISTS (SELECT 1 FROM servana.catalog_services cs WHERE cs.id = b.service_option_id);
