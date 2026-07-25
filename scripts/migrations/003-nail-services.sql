-- Migration 003: Replace all Nail Care specific services under offering 'nail-care'
--
-- The admin portal reads nail services via:
--   provider_catalog_offering_mappings (nail-care offering) → (service_id=2, level_2='Nails')
--   service_options WHERE service_id=2 AND level_2='Nails' AND option_type='MAIN'
--
-- MOBILE-PROTECTED: level_2='Nails' matches /nail/i in ServanaClient HairNailsScreen — DO NOT CHANGE
--
-- This migration:
--   1. Guards against deleting options that have active bookings
--   2. Removes all existing service_options (MAIN + ADD_ON + meta) for (service_id=2, level_2='Nails')
--   3. Inserts 17 new MAIN service options across 3 sub-categories:
--        Regular Polish (5), Gel Polish (5), Nail Extensions (7)

BEGIN;

-- Guard: abort if any existing nail options have active bookings
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM servana.bookings b
    JOIN servana.service_options so ON so.id = b.service_option_id
    WHERE so.service_id = 2 AND so.level_2 = 'Nails'
    LIMIT 1
  ) THEN
    RAISE EXCEPTION 'Cannot replace Nail service options — existing bookings reference them. Migration aborted.';
  END IF;
END;
$$;

-- ─── Remove existing Nail service_options under service_id=2, level_2='Nails' ──
-- Delete meta for ADD_ONs first
DELETE FROM servana.service_option_meta
WHERE service_option_id IN (
  SELECT id FROM servana.service_options
  WHERE parent_option_id IN (
    SELECT id FROM servana.service_options
    WHERE service_id = 2 AND level_2 = 'Nails' AND option_type = 'MAIN'
  )
);
-- Delete ADD_ON rows
DELETE FROM servana.service_options
WHERE parent_option_id IN (
  SELECT id FROM servana.service_options
  WHERE service_id = 2 AND level_2 = 'Nails' AND option_type = 'MAIN'
);
-- Delete meta for MAIN rows
DELETE FROM servana.service_option_meta
WHERE service_option_id IN (
  SELECT id FROM servana.service_options
  WHERE service_id = 2 AND level_2 = 'Nails' AND option_type = 'MAIN'
);
-- Delete MAIN rows
DELETE FROM servana.service_options
WHERE service_id = 2 AND level_2 = 'Nails' AND option_type = 'MAIN';

-- ─── Regular Polish (5 services) ─────────────────────────────────────────────

-- 1. Regular Polish - Manicure (₱250)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Nails', 'Regular Polish - Manicure', 250, 'session')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Classic nail care for hands including nail trimming, shaping, cuticle care, and regular polish application for a clean, polished look.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 2. Regular Polish - Pedicure (₱350)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Nails', 'Regular Polish - Pedicure', 350, 'session')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Classic nail care for feet including foot soak, nail trimming, shaping, cuticle care, and regular polish application.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 3. Regular Polish - Mani/Pedi (₱500)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Nails', 'Regular Polish - Mani/Pedi', 500, 'session')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Complete hand and foot nail care with trimming, shaping, cuticle care, and regular polish application on both hands and feet.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 4. Regular Polish - Mabi/Pedi/Footspa (₱800)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Nails', 'Regular Polish - Mabi/Pedi/Footspa', 800, 'session')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Full nail treatment combining manicure, pedicure, and a relaxing foot spa service for complete hand and foot care.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 5. Regular Polish - Mani/Pedi (Cleaning) (₱400)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Nails', 'Regular Polish - Mani/Pedi (Cleaning)', 400, 'session')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Essential hand and foot nail cleaning service with trimming, filing, and cuticle care — no polish application included.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- ─── Gel Polish (5 services) ─────────────────────────────────────────────────

-- 6. Gel Polish - Manicure (₱350)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Nails', 'Gel Polish - Manicure', 350, 'session')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Long-lasting gel polish application on hands with nail trimming, shaping, and cuticle care for a chip-free finish that lasts weeks.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 7. Gel Polish - Pedicure (₱500)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Nails', 'Gel Polish - Pedicure', 500, 'session')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Long-lasting gel polish application on feet with nail trimming, shaping, and cuticle care for a durable, glossy finish.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 8. Gel Polish - Mani/Pedi (₱800)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Nails', 'Gel Polish - Mani/Pedi', 800, 'session')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Gel polish application on both hands and feet with full nail care for long-lasting color and shine on all nails.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 9. Gel Polish - Mani/Pedi/Footspa (₱1,100)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Nails', 'Gel Polish - Mani/Pedi/Footspa', 1100, 'session')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Premium gel polish mani/pedi service with a relaxing foot spa treatment — complete hand and foot pampering with long-lasting color.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 10. Gel Polish - Gel Removal (₱200)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Nails', 'Gel Polish - Gel Removal', 200, 'session')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Safe and gentle removal of existing gel polish from nails without damage, leaving nails clean and ready for a new application.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- ─── Nail Extensions (7 services) ────────────────────────────────────────────

-- 11. Nail Extensions - Soft gel/Polygel (₱1,500)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Nails', 'Nail Extensions - Soft gel/Polygel', 1500, 'session')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Professional nail extension service using soft gel or polygel for natural-looking, lightweight, and durable nail enhancements.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 12. Nail Extensions - Soft gel removal (₱300)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Nails', 'Nail Extensions - Soft gel removal', 300, 'session')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Professional and safe removal of soft gel nail extensions, preserving nail health and minimizing damage to the natural nail.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 13. Nail Extensions - Gems/Rhines (S) (₱10)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Nails', 'Nail Extensions - Gems/Rhines (S)', 10, 'per piece')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Application of small-sized nail gems or rhinestones for decorative nail art accents — priced per piece.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 14. Nail Extensions - Gems/Rhines (M) (₱15)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Nails', 'Nail Extensions - Gems/Rhines (M)', 15, 'per piece')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Application of medium-sized nail gems or rhinestones for decorative nail art accents — priced per piece.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 15. Nail Extensions - Gems/Rhines (L) (₱20)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Nails', 'Nail Extensions - Gems/Rhines (L)', 20, 'per piece')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Application of large-sized nail gems or rhinestones for bold decorative nail art accents — priced per piece.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 16. Nail Extensions - Stone Removal (₱200)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Nails', 'Nail Extensions - Stone Removal', 200, 'session')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Professional removal of nail gems, rhinestones, or decorative stones from nails without causing damage to the nail surface.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 17. Nail Extensions - Ribbons/Flowers (₱50)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Nails', 'Nail Extensions - Ribbons/Flowers', 50, 'per nail')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Application of ribbon or floral nail art decorations for a feminine, decorative finish — priced per nail.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

COMMIT;

-- Verify: should return 17 rows
SELECT so.id, so.level_3, so.base_price, so.unit, m.description
FROM servana.service_options so
LEFT JOIN servana.service_option_meta m ON m.service_option_id = so.id
WHERE so.service_id = 2 AND so.level_2 = 'Nails' AND so.option_type = 'MAIN'
ORDER BY so.id;
