-- Migration 001: Replace all Massage category services
-- Safe delete order: meta → options (cascade ADD_ONs handled by FK) → services
-- Wrapped in a transaction so partial failure leaves no orphan rows.

BEGIN;

-- Guard: abort if any existing massage service_option is referenced by a booking
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM servana.bookings b
    JOIN servana.service_options so ON so.id = b.service_option_id
    JOIN servana.services s ON s.id = so.service_id
    WHERE s.category = 'Massage'
    LIMIT 1
  ) THEN
    RAISE EXCEPTION 'Cannot replace Massage services — existing bookings reference them. Migration aborted.';
  END IF;
END;
$$;

-- 1. Remove meta for all massage service options
DELETE FROM servana.service_option_meta
WHERE service_option_id IN (
  SELECT so.id
  FROM servana.service_options so
  JOIN servana.services s ON s.id = so.service_id
  WHERE s.category = 'Massage'
);

-- 2. Remove options (MAIN + ADD_ON)
DELETE FROM servana.service_options
WHERE service_id IN (
  SELECT id FROM servana.services WHERE category = 'Massage'
);

-- 3. Remove service rows
DELETE FROM servana.services WHERE category = 'Massage';

-- ─────────────────────────────────────────────────────────────────────────────
-- INSERT new Massage services (one service row per type, one MAIN option each)
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Body Massage (₱400, 1 hour)
WITH svc AS (
  INSERT INTO servana.services (name, category) VALUES ('Body Massage', 'Massage') RETURNING id
),
opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  SELECT id, 'MAIN', 'Body Massage', 'Body Massage', 400, '1 hour' FROM svc
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, inclusions, exclusions)
SELECT id,
  '["Soothing therapy that uses calming strokes and gentle pressure to relax the muscles, improve blood flow, and restore balance to the body"]'::jsonb,
  '[]'::jsonb
FROM opt;

-- 2. Foot Massage (₱400, 1 hour)
WITH svc AS (
  INSERT INTO servana.services (name, category) VALUES ('Foot Massage', 'Massage') RETURNING id
),
opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  SELECT id, 'MAIN', 'Foot Massage', 'Foot Massage', 400, '1 hour' FROM svc
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, inclusions, exclusions)
SELECT id,
  '["Therapeutic treatment that applies pressure to specific points on the feet to help stimulate energy flow throughout the body"]'::jsonb,
  '[]'::jsonb
FROM opt;

-- 3. Face Massage (₱400, 1 hour)
WITH svc AS (
  INSERT INTO servana.services (name, category) VALUES ('Face Massage', 'Massage') RETURNING id
),
opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  SELECT id, 'MAIN', 'Face Massage', 'Face Massage', 400, '1 hour' FROM svc
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, inclusions, exclusions)
SELECT id,
  '["Rejuvenating treatment that gently lifts, tones, and relaxes the face, leaving your skin glowing and refreshed"]'::jsonb,
  '[]'::jsonb
FROM opt;

-- 4. Head, Back & Shoulder Massage (₱400, 1 hour)
WITH svc AS (
  INSERT INTO servana.services (name, category) VALUES ('Head, Back & Shoulder Massage', 'Massage') RETURNING id
),
opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  SELECT id, 'MAIN', 'Head, Back & Shoulder Massage', 'Head, Back & Shoulder Massage', 400, '1 hour' FROM svc
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, inclusions, exclusions)
SELECT id,
  '["Relaxing therapy that helps reduce stress, relieve body aches, and relax tight muscles in the upper body"]'::jsonb,
  '[]'::jsonb
FROM opt;

-- 5. Ventosa (₱500, 1 hour)
WITH svc AS (
  INSERT INTO servana.services (name, category) VALUES ('Ventosa', 'Massage') RETURNING id
),
opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  SELECT id, 'MAIN', 'Ventosa', 'Ventosa', 500, '1 hour' FROM svc
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, inclusions, exclusions)
SELECT id,
  '["Traditional therapeutic treatment that uses suction cups on the skin to stimulate blood circulation, relieve muscle tension, and promote natural healing"]'::jsonb,
  '[]'::jsonb
FROM opt;

-- 6. Hot Stone Massage (₱500, 1 hour)
WITH svc AS (
  INSERT INTO servana.services (name, category) VALUES ('Hot Stone Massage', 'Massage') RETURNING id
),
opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  SELECT id, 'MAIN', 'Hot Stone Massage', 'Hot Stone Massage', 500, '1 hour' FROM svc
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, inclusions, exclusions)
SELECT id,
  '["Deeply calming treatment that combines warm stones and gentle massage techniques to melt away tension, improve blood flow, and restore balance to the body"]'::jsonb,
  '[]'::jsonb
FROM opt;

-- 7. Ear Candling (₱600, 1 hour)
WITH svc AS (
  INSERT INTO servana.services (name, category) VALUES ('Ear Candling', 'Massage') RETURNING id
),
opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  SELECT id, 'MAIN', 'Ear Candling', 'Ear Candling', 600, '1 hour' FROM svc
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, inclusions, exclusions)
SELECT id,
  '["Traditional wellness therapy that uses a hollow candle placed in the ear to help remove excess earwax, relieve pressure, and promote relaxation"]'::jsonb,
  '[]'::jsonb
FROM opt;

-- 8. Sports Massage (₱600, 1 hour)
WITH svc AS (
  INSERT INTO servana.services (name, category) VALUES ('Sports Massage', 'Massage') RETURNING id
),
opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  SELECT id, 'MAIN', 'Sports Massage', 'Sports Massage', 600, '1 hour' FROM svc
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, inclusions, exclusions)
SELECT id,
  '["Improve athletic performance, reduce muscle tension, prevent injuries, and support recovery after physical activity"]'::jsonb,
  '[]'::jsonb
FROM opt;

-- 9. Swedish Massage (₱1000, 2 hours)
WITH svc AS (
  INSERT INTO servana.services (name, category) VALUES ('Swedish Massage', 'Massage') RETURNING id
),
opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  SELECT id, 'MAIN', 'Swedish Massage', 'Swedish Massage', 1000, '2 hours' FROM svc
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, inclusions, exclusions)
SELECT id,
  '["Gentle and relaxing type of massage therapy that uses smooth, flowing strokes, kneading, circular movements, and light to moderate pressure to help relax the body and improve overall wellness"]'::jsonb,
  '[]'::jsonb
FROM opt;

-- 10. Shiatzu Massage (Deep Tissue) (₱1000, 2 hours)
WITH svc AS (
  INSERT INTO servana.services (name, category) VALUES ('Shiatzu Massage (Deep Tissue)', 'Massage') RETURNING id
),
opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  SELECT id, 'MAIN', 'Shiatzu Massage (Deep Tissue)', 'Shiatzu Massage (Deep Tissue)', 1000, '2 hours' FROM svc
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, inclusions, exclusions)
SELECT id,
  '["Therapeutic massage technique that combines the principles of traditional Japanese Shiatsu massage with deep tissue pressure to relieve muscle tension, reduce stress, and improve the body''s natural energy flow"]'::jsonb,
  '[]'::jsonb
FROM opt;

COMMIT;

-- Verify
SELECT s.id, s.name, s.category, so.base_price, so.unit
FROM servana.services s
JOIN servana.service_options so ON so.service_id = s.id
WHERE s.category = 'Massage'
ORDER BY so.base_price, s.name;
