-- Migration 002: Add 10 Massage specific services under offering ID 4 (Massage Therapy)
--
-- The admin portal reads specific-services via:
--   provider_catalog_offering_mappings (offering_id=4) → (service_id=2, level_2='Massage')
--   service_options WHERE service_id=2 AND level_2='Massage' AND option_type='MAIN'
--
-- Migration 001 was incorrect: it inserted service rows with category='Massage' and used
-- level_2 = service name (wrong). This migration corrects that:
--   1. Cleans up migration-001 junk rows (servana.services WHERE category='Massage')
--   2. Removes any existing service_options for (service_id=2, level_2='Massage')
--   3. Inserts 10 correct service_options with level_2='Massage', level_3=<service name>

BEGIN;

-- Guard: abort if any existing massage options (correct path) have active bookings
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM servana.bookings b
    JOIN servana.service_options so ON so.id = b.service_option_id
    WHERE so.service_id = 2 AND so.level_2 = 'Massage'
    LIMIT 1
  ) THEN
    RAISE EXCEPTION 'Cannot replace Massage service options — existing bookings reference them. Migration aborted.';
  END IF;
END;
$$;

-- ─── Clean up migration 001 incorrect rows ────────────────────────────────────
-- (service rows with category='Massage' linked to wrong service_ids)
DELETE FROM servana.service_option_meta
WHERE service_option_id IN (
  SELECT so.id FROM servana.service_options so
  JOIN servana.services s ON s.id = so.service_id
  WHERE s.category = 'Massage'
);
DELETE FROM servana.service_options
WHERE service_id IN (SELECT id FROM servana.services WHERE category = 'Massage');
DELETE FROM servana.services WHERE category = 'Massage';

-- ─── Remove existing Massage service_options under service_id=2 ───────────────
-- Delete meta for ADD_ONs first
DELETE FROM servana.service_option_meta
WHERE service_option_id IN (
  SELECT id FROM servana.service_options
  WHERE parent_option_id IN (
    SELECT id FROM servana.service_options
    WHERE service_id = 2 AND level_2 = 'Massage' AND option_type = 'MAIN'
  )
);
-- Delete ADD_ON rows
DELETE FROM servana.service_options
WHERE parent_option_id IN (
  SELECT id FROM servana.service_options
  WHERE service_id = 2 AND level_2 = 'Massage' AND option_type = 'MAIN'
);
-- Delete meta for MAIN rows
DELETE FROM servana.service_option_meta
WHERE service_option_id IN (
  SELECT id FROM servana.service_options
  WHERE service_id = 2 AND level_2 = 'Massage' AND option_type = 'MAIN'
);
-- Delete MAIN rows
DELETE FROM servana.service_options
WHERE service_id = 2 AND level_2 = 'Massage' AND option_type = 'MAIN';

-- ─── Insert 10 Massage specific services ─────────────────────────────────────
-- service_id=2 (Beauty & Wellness), level_2='Massage', option_type='MAIN'

-- 1. Body Massage (₱400, 1 hour)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Massage', 'Body Massage', 400, '1 hour')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Soothing therapy that uses calming strokes and gentle pressure to relax the muscles, improve blood flow, and restore balance to the body',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 2. Foot Massage (₱400, 1 hour)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Massage', 'Foot Massage', 400, '1 hour')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Therapeutic treatment that applies pressure to specific points on the feet to help stimulate energy flow throughout the body',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 3. Face Massage (₱400, 1 hour)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Massage', 'Face Massage', 400, '1 hour')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Rejuvenating treatment that gently lifts, tones, and relaxes the face, leaving your skin glowing and refreshed',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 4. Head, Back & Shoulder Massage (₱400, 1 hour)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Massage', 'Head, Back & Shoulder Massage', 400, '1 hour')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Relaxing therapy that helps reduce stress, relieve body aches, and relax tight muscles in the upper body',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 5. Ventosa (₱500, 1 hour)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Massage', 'Ventosa', 500, '1 hour')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Traditional therapeutic treatment that uses suction cups on the skin to stimulate blood circulation, relieve muscle tension, and promote natural healing',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 6. Hot Stone Massage (₱500, 1 hour)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Massage', 'Hot Stone Massage', 500, '1 hour')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Deeply calming treatment that combines warm stones and gentle massage techniques to melt away tension, improve blood flow, and restore balance to the body',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 7. Ear Candling (₱600, 1 hour)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Massage', 'Ear Candling', 600, '1 hour')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Traditional wellness therapy that uses a hollow candle placed in the ear to help remove excess earwax, relieve pressure, and promote relaxation',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 8. Sports Massage (₱600, 1 hour)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Massage', 'Sports Massage', 600, '1 hour')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Improve athletic performance, reduce muscle tension, prevent injuries, and support recovery after physical activity',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 9. Swedish Massage (₱1000, 2 hours)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Massage', 'Swedish Massage', 1000, '2 hours')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Gentle and relaxing type of massage therapy that uses smooth, flowing strokes, kneading, circular movements, and light to moderate pressure to help relax the body and improve overall wellness',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 10. Shiatzu Massage (Deep Tissue) (₱1000, 2 hours)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (2, 'MAIN', 'Massage', 'Shiatzu Massage (Deep Tissue)', 1000, '2 hours')
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Therapeutic massage technique that combines the principles of traditional Japanese Shiatsu massage with deep tissue pressure to relieve muscle tension, reduce stress, and improve the body''s natural energy flow',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

COMMIT;

-- Verify: should return 10 rows
SELECT so.id, so.level_3, so.base_price, so.unit, m.description
FROM servana.service_options so
LEFT JOIN servana.service_option_meta m ON m.service_option_id = so.id
WHERE so.service_id = 2 AND so.level_2 = 'Massage' AND so.option_type = 'MAIN'
ORDER BY so.base_price, so.level_3;
