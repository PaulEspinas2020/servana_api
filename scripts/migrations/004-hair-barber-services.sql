-- Migration 004: Replace all Hair/Barbers services under offering 'hair-services'
--
-- The admin portal reads hair services via:
--   provider_catalog_offering_mappings (hair-services offering) → (service_id=2, level_2='Hair')
--   service_options WHERE service_id=2 AND level_2='Hair' AND option_type='MAIN'
--
-- MOBILE-PROTECTED: level_2='Hair' matches /hair/i in ServanaClient HairNailsScreen — DO NOT CHANGE
--
-- This migration:
--   1. Guards against deleting options that have active bookings
--   2. Removes all existing service_options (MAIN + ADD_ON + meta) for (service_id=2, level_2='Hair')
--   3. Inserts 14 new MAIN service options across 3 sub-categories:
--        Haircut (6), Trendy/Style Cuts (5), Package Services / Full Grooming (3)

BEGIN;

-- Guard: abort if any existing hair options have active bookings
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM servana.bookings b
    JOIN servana.service_options so ON so.id = b.service_option_id
    WHERE so.service_id = 2 AND so.level_2 = 'Hair'
    LIMIT 1
  ) THEN
    RAISE EXCEPTION 'Cannot replace Hair service options — existing bookings reference them. Migration aborted.';
  END IF;
END;
$$;

-- ─── Remove existing Hair service_options under service_id=2, level_2='Hair' ──
-- Delete meta for ADD_ONs first
DELETE FROM servana.service_option_meta
WHERE service_option_id IN (
  SELECT id FROM servana.service_options
  WHERE parent_option_id IN (
    SELECT id FROM servana.service_options
    WHERE service_id = 2 AND level_2 = 'Hair' AND option_type = 'MAIN'
  )
);
-- Delete ADD_ON rows
DELETE FROM servana.service_options
WHERE parent_option_id IN (
  SELECT id FROM servana.service_options
  WHERE service_id = 2 AND level_2 = 'Hair' AND option_type = 'MAIN'
);
-- Delete meta for MAIN rows
DELETE FROM servana.service_option_meta
WHERE service_option_id IN (
  SELECT id FROM servana.service_options
  WHERE service_id = 2 AND level_2 = 'Hair' AND option_type = 'MAIN'
);
-- Delete MAIN rows
DELETE FROM servana.service_options
WHERE service_id = 2 AND level_2 = 'Hair' AND option_type = 'MAIN';

-- ─── Haircut (6 services) ─────────────────────────────────────────────────────

-- 1. Haircut - Basic Men's Haircut (₱300)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Hair', 'Haircut - Basic Men''s Haircut', 300, 'session')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Classic men''s haircut with professional styling, trimming, and finishing for a clean and well-groomed look.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 2. Haircut - Women's Haircut (₱400)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Hair', 'Haircut - Women''s Haircut', 400, 'session')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Professional women''s haircut with trimming, shaping, and styling tailored to your preferred look and hair type.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 3. Haircut - Haircut with Shampoo (₱400)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Hair', 'Haircut - Haircut with Shampoo', 400, 'session')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Complete haircut service that includes a refreshing shampoo wash before the cut for a clean and fresh result.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 4. Haircut - Haircut with Shave (₱500)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Hair', 'Haircut - Haircut with Shave', 500, 'session')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Haircut combined with a professional shave for a full grooming service that keeps you looking sharp and clean.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 5. Haircut - Haircut + Half Body Massage (₱550)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Hair', 'Haircut - Haircut + Half Body Massage', 550, 'session')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Haircut paired with a relaxing half body massage — the perfect combination for grooming and stress relief in one session.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 6. Haircut - Premium Haircut + Charcoal Treatment (₱700)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Hair', 'Haircut - Premium Haircut + Charcoal Treatment', 700, 'session')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Premium haircut experience with a deep-cleansing charcoal treatment that removes impurities and leaves hair feeling refreshed and healthy.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- ─── Trendy/Style Cuts (5 services) ─────────────────────────────────────────

-- 7. Trendy/Style Cuts - Curtain Cut (₱400)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Hair', 'Trendy/Style Cuts - Curtain Cut', 400, 'session')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Stylish curtain cut with a center part and flowing layers that frame the face — a timeless yet modern look.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 8. Trendy/Style Cuts - Wolf Cut (₱400)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Hair', 'Trendy/Style Cuts - Wolf Cut', 400, 'session')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Edgy wolf cut combining shaggy layers and volume for a bold, textured style that works for all hair types.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 9. Trendy/Style Cuts - Pompadour/Long Trim (₱400)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Hair', 'Trendy/Style Cuts - Pompadour/Long Trim', 400, 'session')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Classic pompadour or long trim styling with volume on top and a clean, shaped finish that elevates your overall look.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 10. Trendy/Style Cuts - Edgar Cut (₱400)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Hair', 'Trendy/Style Cuts - Edgar Cut', 400, 'session')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Sharp Edgar cut with a straight fringe and blunt top — a bold, structured style popular for its clean and defined look.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 11. Trendy/Style Cuts - Mullet Cut (₱400)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Hair', 'Trendy/Style Cuts - Mullet Cut', 400, 'session')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Modern mullet cut with short sides and a longer back — a retro-inspired style that has made a strong comeback in contemporary fashion.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- ─── Package Services / Full Grooming (3 services) ───────────────────────────

-- 12. Package Services - Haircut + Shampoo + Basic Hair Dye (₱1,350)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Hair', 'Package Services - Haircut + Shampoo + Basic Hair Dye', 1350, 'session')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Full grooming package that includes a haircut, shampoo wash, and basic single-color hair dye application for a complete transformation.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 13. Package Services - Haircut + Shampoo + Treatment (₱1,000)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Hair', 'Package Services - Haircut + Shampoo + Treatment', 1000, 'session')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Full grooming package combining a haircut, shampoo wash, and a nourishing hair treatment to improve hair health and shine.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 14. Package Services - Haircut + Shampoo + Shave + Charcoal Mask (₱1,000)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Hair', 'Package Services - Haircut + Shampoo + Shave + Charcoal Mask', 1000, 'session')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Complete grooming package with a haircut, shampoo, professional shave, and a deep-cleansing charcoal mask for a fully refreshed appearance.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

COMMIT;

-- Verify: should return 14 rows
SELECT so.id, so.level_3, so.base_price, so.unit, m.description
FROM servana.service_options so
LEFT JOIN servana.service_option_meta m ON m.service_option_id = so.id
WHERE so.service_id = 2 AND so.level_2 = 'Hair' AND so.option_type = 'MAIN'
ORDER BY so.id;
