-- Migration 005: Replace all Beauty services under offering 'aesthetics-beauty'
--
-- The admin portal reads beauty services via:
--   provider_catalog_offering_mappings (aesthetics-beauty offering) → (service_id=2, level_2=...)
--   service_options WHERE service_id=2 AND level_2 IN ('Facial','Beauty Drip','Beauty Drip Add Ons') AND option_type='MAIN'
--
-- MOBILE-PROTECTED: level_2='Facial' is an EXACT match in ServanaClient BeautyWellnessScreen — DO NOT CHANGE
-- New level_2 values 'Beauty Drip' and 'Beauty Drip Add Ons' are admin/provider-web only (no mobile match)
--
-- This migration:
--   1. Guards against active bookings for all three level_2 groups
--   2. Removes existing service_options (MAIN + ADD_ON + meta) for all three level_2 values
--   3. Adds 'Beauty Drip' and 'Beauty Drip Add Ons' catalog offering mappings (ON CONFLICT DO NOTHING)
--   4. Inserts 18 new MAIN service options across 3 sub-categories:
--        Beauty Drip (5), Beauty Drip Add Ons (5), Facial (8)

BEGIN;

-- Pre-flight: ensure aesthetics-beauty offering exists (created by seedBuiltInOfferings at app boot)
-- On a fresh DB, migrations run before seed — the subquery would silently insert 0 rows without this guard
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM servana.provider_catalog_offerings WHERE catalog_key = 'aesthetics-beauty'
  ) THEN
    RAISE EXCEPTION 'aesthetics-beauty offering not found — run app once to seed catalog before this migration';
  END IF;
END;
$$;

-- Guard: abort if any existing beauty options have active bookings
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM servana.bookings b
    JOIN servana.service_options so ON so.id = b.service_option_id
    WHERE so.service_id = 2 AND so.level_2 IN ('Facial', 'Beauty Drip', 'Beauty Drip Add Ons')
    LIMIT 1
  ) THEN
    RAISE EXCEPTION 'Cannot replace Beauty service options — existing bookings reference them. Migration aborted.';
  END IF;
END;
$$;

-- ─── Remove existing service_options for all three beauty level_2 groups ────────

-- Delete meta for ADD_ON children
DELETE FROM servana.service_option_meta
WHERE service_option_id IN (
  SELECT id FROM servana.service_options
  WHERE parent_option_id IN (
    SELECT id FROM servana.service_options
    WHERE service_id = 2 AND level_2 IN ('Facial', 'Beauty Drip', 'Beauty Drip Add Ons') AND option_type = 'MAIN'
  )
);
-- Delete ADD_ON rows
DELETE FROM servana.service_options
WHERE parent_option_id IN (
  SELECT id FROM servana.service_options
  WHERE service_id = 2 AND level_2 IN ('Facial', 'Beauty Drip', 'Beauty Drip Add Ons') AND option_type = 'MAIN'
);
-- Delete meta for MAIN rows
DELETE FROM servana.service_option_meta
WHERE service_option_id IN (
  SELECT id FROM servana.service_options
  WHERE service_id = 2 AND level_2 IN ('Facial', 'Beauty Drip', 'Beauty Drip Add Ons') AND option_type = 'MAIN'
);
-- Delete MAIN rows
DELETE FROM servana.service_options
WHERE service_id = 2 AND level_2 IN ('Facial', 'Beauty Drip', 'Beauty Drip Add Ons') AND option_type = 'MAIN';

-- ─── Update aesthetics-beauty catalog description to include Beauty Drip ──────
-- seedBuiltInOfferings never updates existing rows, so this UPDATE is the only way
-- to keep the description accurate on production
UPDATE servana.provider_catalog_offerings
SET short_description   = 'Facial, skin treatments, and Beauty Drip IV therapy.',
    provider_description = 'Facial care, waxing, and Beauty Drip IV therapy delivered at home.',
    updated_at           = NOW(),
    version              = version + 1
WHERE catalog_key = 'aesthetics-beauty';

-- ─── Add new catalog offering mappings for Beauty Drip sub-categories ────────
-- Resolves offering_id from catalog_key 'aesthetics-beauty' at runtime
INSERT INTO servana.provider_catalog_offering_mappings (offering_id, service_id, level_2, display_order, is_active)
SELECT pco.id, 2, 'Beauty Drip', 2, true
FROM servana.provider_catalog_offerings pco
WHERE pco.catalog_key = 'aesthetics-beauty'
ON CONFLICT (offering_id, service_id, level_2) DO NOTHING;

INSERT INTO servana.provider_catalog_offering_mappings (offering_id, service_id, level_2, display_order, is_active)
SELECT pco.id, 2, 'Beauty Drip Add Ons', 3, true
FROM servana.provider_catalog_offerings pco
WHERE pco.catalog_key = 'aesthetics-beauty'
ON CONFLICT (offering_id, service_id, level_2) DO NOTHING;

-- ─── Beauty Drip (5 services) ────────────────────────────────────────────────

-- 1. Gluta Drip (₱990)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Beauty Drip', 'Gluta Drip', 990, 'session')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Tationil (600), Vitamin C, Vitamin B',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 2. Swiss Drip (₱1,500)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Beauty Drip', 'Swiss Drip', 1500, 'session')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Gluta (1200), C, B, Collagen, Hya, EGP, Lipoic Acid, Kojic, Peptide, Placenta, Coq10',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 3. Japanese Drip (₱2,500)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Beauty Drip', 'Japanese Drip', 2500, 'session')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Gluta (5000mg), C, B, Thioctic, Collagen, Embryonic Stem Cell, Kojic, Amino Acid, Human Placenta',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 4. Emperor''s Drip (₱3,500)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Beauty Drip', 'Emperor''s Drip', 3500, 'session')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Gluta (300k mg), C, B, Collagen, Celergen Stem Cell, Vegetable Placenta, Coq10, N-ALA+',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 5. Governor''s Drip (₱4,500)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Beauty Drip', 'Governor''s Drip', 4500, 'session')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'The ultimate drip treatment, a powerful combination of all drip formulas in one.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- ─── Beauty Drip Add Ons (5 services) ────────────────────────────────────────

-- 6. Vitamin C (₱350)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Beauty Drip Add Ons', 'Vitamin C', 350, 'session')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Add-on Vitamin C booster to complement your beauty drip session.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 7. Vitamin D (₱350)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Beauty Drip Add Ons', 'Vitamin D', 350, 'session')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Add-on Vitamin D booster to support immunity and bone health alongside your beauty drip.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 8. iSlim (L-Carnitine) (₱500)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Beauty Drip Add Ons', 'iSlim (L-Carnitine)', 500, 'session')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Add-on L-Carnitine booster that supports fat metabolism and energy conversion.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 9. Vitamin B-Complex (₱500)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Beauty Drip Add Ons', 'Vitamin B-Complex', 500, 'session')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Add-on Vitamin B-Complex booster for energy, nerve function, and overall wellness.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 10. Collagen (₱350)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Beauty Drip Add Ons', 'Collagen', 350, 'session')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Add-on Collagen booster to improve skin elasticity, hydration, and youthful appearance.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- ─── Facial (8 services) ─────────────────────────────────────────────────────
-- level_2='Facial' is MOBILE-PROTECTED — exact match in ServanaClient BeautyWellnessScreen

-- 11. Deep Cleansing Facial (₱1,000)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Facial', 'Deep Cleansing Facial', 1000, 'session')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Classic offering that attempts to nourish and regenerate your facial skin, making it appear healthier and younger.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 12. Collagen Facial (₱1,500)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Facial', 'Collagen Facial', 1500, 'session')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Aims to put a stop to the aging process by externally applying collagen to the skin so that it can penetrate the dermis directly.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 13. Whitening Facial (₱1,500)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Facial', 'Whitening Facial', 1500, 'session')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Softly lightens freckles, dark spots, hyperpigmentation while retaining the skin''s natural color.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 14. Pimple Facial (₱1,500)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Facial', 'Pimple Facial', 1500, 'session')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Suitable for individuals of all ages who have acne-prone skin.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 15. Signature Facial (₱2,000)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Facial', 'Signature Facial', 2000, 'session')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Signature facial that offers a great treatment specialized for your current skin condition.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 16. Hydra Facial (₱3,500)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Facial', 'Hydra Facial', 3500, 'session')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Suitable for all skin types and works to improve radiance, hydration, plumping, and brightening that is supple to the touch.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 17. Celebrity Hydra Facial (₱5,000)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Facial', 'Celebrity Hydra Facial', 5000, 'session')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Combination of Signature and Hydra Facial. Bespoke skincare treatment that will reveal the radiant glow and immaculate complexion of the stars on the red carpet.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 18. Vampire Facial (₱6,000)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Facial', 'Vampire Facial', 6000, 'session')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Platelet-rich plasma (PRP) treatment with signature facial. Reduces wrinkles, plumps up drooping skin, removes deep creases, lessens acne scars, and brightens the complexion.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

COMMIT;

-- Verify: should return 18 rows across 3 level_2 groups
SELECT so.level_2, so.level_3, so.base_price, m.description
FROM servana.service_options so
LEFT JOIN servana.service_option_meta m ON m.service_option_id = so.id
WHERE so.service_id = 2 AND so.level_2 IN ('Facial', 'Beauty Drip', 'Beauty Drip Add Ons') AND so.option_type = 'MAIN'
ORDER BY so.level_2, so.id;
