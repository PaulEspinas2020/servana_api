-- Migration 007: Replace all Aircon services with 14 Cleaning services
--
-- The admin portal reads aircon services via:
--   provider_catalog_offering_mappings (aircon-cleaning-repair offering) → (service_id=Aircon Services, level_2=...)
--   service_options WHERE service_id=(Aircon Services id) AND level_2 IN ('Cleaning','Installation','Repair') AND option_type='MAIN'
--
-- No mobile protection concern: 'Cleaning' is not matched by ServanaClient mobile screens.
-- All 14 new services go under level_2='Cleaning'. Installation and Repair rows are also cleared.
-- No new catalog offering mappings needed: all 3 level_2 values already exist in BUILTIN_OFFERINGS.
--
-- This migration:
--   1. Guards against active bookings for any Aircon service options
--   2. Removes all existing Aircon service_options (Cleaning + Installation + Repair)
--   3. Inserts 14 new MAIN service options under level_2='Cleaning'

BEGIN;

-- Guard: abort if any existing aircon options have active bookings
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM servana.bookings b
    JOIN servana.service_options so ON so.id = b.service_option_id
    WHERE so.service_id = (SELECT id FROM servana.services WHERE name = 'Aircon Services')
    LIMIT 1
  ) THEN
    RAISE EXCEPTION 'Cannot replace Aircon service options — existing bookings reference them. Migration aborted.';
  END IF;
END;
$$;

-- ─── Remove all existing Aircon service_options ──────────────────────────────

-- Delete meta for ADD_ON children
DELETE FROM servana.service_option_meta
WHERE service_option_id IN (
  SELECT id FROM servana.service_options
  WHERE parent_option_id IN (
    SELECT id FROM servana.service_options
    WHERE service_id = (SELECT id FROM servana.services WHERE name = 'Aircon Services')
      AND level_2 IN ('Cleaning', 'Installation', 'Repair')
      AND option_type = 'MAIN'
  )
);
-- Delete ADD_ON rows
DELETE FROM servana.service_options
WHERE parent_option_id IN (
  SELECT id FROM servana.service_options
  WHERE service_id = (SELECT id FROM servana.services WHERE name = 'Aircon Services')
    AND level_2 IN ('Cleaning', 'Installation', 'Repair')
    AND option_type = 'MAIN'
);
-- Delete meta for MAIN rows
DELETE FROM servana.service_option_meta
WHERE service_option_id IN (
  SELECT id FROM servana.service_options
  WHERE service_id = (SELECT id FROM servana.services WHERE name = 'Aircon Services')
    AND level_2 IN ('Cleaning', 'Installation', 'Repair')
    AND option_type = 'MAIN'
);
-- Delete MAIN rows
DELETE FROM servana.service_options
WHERE service_id = (SELECT id FROM servana.services WHERE name = 'Aircon Services')
  AND level_2 IN ('Cleaning', 'Installation', 'Repair')
  AND option_type = 'MAIN';

-- ─── Cleaning (14 services) ──────────────────────────────────────────────────

-- 1. Aircon Cleaning for Window Type (Non-Inverter, 0.5 to 1.5HP) (₱690)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (
    (SELECT id FROM servana.services WHERE name = 'Aircon Services'),
    'MAIN', 'Cleaning', 'Aircon Cleaning for Window Type (Non-Inverter, 0.5 to 1.5HP)', 690, 'session'
  )
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Keep your window-type air conditioner in peak condition with Servana''s professional aircon cleaning service. Our expert technicians perform a complete and thorough cleaning to remove dust, dirt, and buildup that can affect your unit''s cooling performance and air quality. Regular maintenance helps your aircon cool faster, operate more efficiently, and last longer.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 2. Aircon Cleaning for Window Type (Non-Inverter, 2 to 2.5HP) (₱790)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (
    (SELECT id FROM servana.services WHERE name = 'Aircon Services'),
    'MAIN', 'Cleaning', 'Aircon Cleaning for Window Type (Non-Inverter, 2 to 2.5HP)', 790, 'session'
  )
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Keep your window-type air conditioner in peak condition with Servana''s professional aircon cleaning service. Our expert technicians perform a complete and thorough cleaning to remove dust, dirt, and buildup that can affect your unit''s cooling performance and air quality. Regular maintenance helps your aircon cool faster, operate more efficiently, and last longer.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 3. Aircon Cleaning for Window Type (Inverter, 0.5 to 1.5HP) (₱990)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (
    (SELECT id FROM servana.services WHERE name = 'Aircon Services'),
    'MAIN', 'Cleaning', 'Aircon Cleaning for Window Type (Inverter, 0.5 to 1.5HP)', 990, 'session'
  )
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Keep your window-type air conditioner in peak condition with Servana''s professional aircon cleaning service. Our expert technicians perform a complete and thorough cleaning to remove dust, dirt, and buildup that can affect your unit''s cooling performance and air quality. Regular maintenance helps your aircon cool faster, operate more efficiently, and last longer.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 4. Aircon Cleaning for Window Type (Inverter, 2 to 2.5HP) (₱1,190)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (
    (SELECT id FROM servana.services WHERE name = 'Aircon Services'),
    'MAIN', 'Cleaning', 'Aircon Cleaning for Window Type (Inverter, 2 to 2.5HP)', 1190, 'session'
  )
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Keep your window-type air conditioner in peak condition with Servana''s professional aircon cleaning service. Our expert technicians perform a complete and thorough cleaning to remove dust, dirt, and buildup that can affect your unit''s cooling performance and air quality. Regular maintenance helps your aircon cool faster, operate more efficiently, and last longer.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 5. Aircon Cleaning for Split Type (up to 1.5HP) (₱1,390)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (
    (SELECT id FROM servana.services WHERE name = 'Aircon Services'),
    'MAIN', 'Cleaning', 'Aircon Cleaning for Split Type (up to 1.5HP)', 1390, 'session'
  )
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Keep your split-type air conditioner performing at its best with Servana''s professional aircon cleaning service. Our expert technicians provide a complete cleaning to remove dust, mold, and dirt buildup that can affect cooling performance, air quality, and energy efficiency. Regular maintenance helps your unit cool faster, run more efficiently, and extend its lifespan.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 6. Aircon Cleaning for Split Type (2 to 3HP) (₱1,590)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (
    (SELECT id FROM servana.services WHERE name = 'Aircon Services'),
    'MAIN', 'Cleaning', 'Aircon Cleaning for Split Type (2 to 3HP)', 1590, 'session'
  )
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Keep your split-type air conditioner performing at its best with Servana''s professional aircon cleaning service. Our expert technicians provide a complete cleaning to remove dust, mold, and dirt buildup that can affect cooling performance, air quality, and energy efficiency. Regular maintenance helps your unit cool faster, run more efficiently, and extend its lifespan.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 7. Pull-down Cleaning for Split Type (up to 1.5HP) (₱4,490)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (
    (SELECT id FROM servana.services WHERE name = 'Aircon Services'),
    'MAIN', 'Cleaning', 'Pull-down Cleaning for Split Type (up to 1.5HP)', 4490, 'session'
  )
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Restore your split-type air conditioner''s performance with Servana''s pull-down cleaning service. This deep-cleaning service involves carefully dismantling key parts of the indoor unit to thoroughly remove stubborn dirt, dust, mold, and buildup that regular cleaning may miss. Ideal for units with reduced cooling, unpleasant odors, or overdue maintenance.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 8. Pull-down Cleaning for Split Type (2 to 3HP) (₱4,990)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (
    (SELECT id FROM servana.services WHERE name = 'Aircon Services'),
    'MAIN', 'Cleaning', 'Pull-down Cleaning for Split Type (2 to 3HP)', 4990, 'session'
  )
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Keep your larger split-type air conditioner running at peak performance with Servana''s professional pull-down cleaning service. This deep-cleaning service involves carefully dismantling key components of the indoor unit to remove built-up dust, dirt, mold, and debris that regular cleaning cannot fully reach. Ideal for units experiencing weak cooling, unusual odors, or overdue maintenance.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 9. Aircon Cleaning for Tower Type (₱2,290)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (
    (SELECT id FROM servana.services WHERE name = 'Aircon Services'),
    'MAIN', 'Cleaning', 'Aircon Cleaning for Tower Type', 2290, 'session'
  )
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Keep your tower-type air conditioner running efficiently with Servana''s professional aircon cleaning service. Our expert technicians perform a thorough cleaning to remove dust, dirt, and buildup that can affect cooling performance, airflow, and air quality. Regular cleaning helps your unit cool more effectively, consume less energy, and maintain a healthier indoor environment.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 10. Aircon Cleaning for Cassette Type (₱3,190)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (
    (SELECT id FROM servana.services WHERE name = 'Aircon Services'),
    'MAIN', 'Cleaning', 'Aircon Cleaning for Cassette Type', 3190, 'session'
  )
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Keep your cassette-type air conditioner operating at peak performance with Servana''s professional aircon cleaning service. Our expert technicians provide a thorough cleaning to remove dust, dirt, and buildup from essential components, helping improve cooling efficiency, airflow, and indoor air quality. Regular maintenance helps your unit perform better, use less energy, and last longer.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 11. Aircon Cleaning for Suspended Type (₱3,200)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (
    (SELECT id FROM servana.services WHERE name = 'Aircon Services'),
    'MAIN', 'Cleaning', 'Aircon Cleaning for Suspended Type', 3200, 'session'
  )
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Keep your suspended-type air conditioner performing at its best with Servana''s professional aircon cleaning service. Our expert technicians provide a thorough cleaning to remove dust, dirt, and buildup from essential components, helping improve cooling efficiency, airflow, and indoor air quality. Regular maintenance helps your unit cool effectively, consume less energy, and extend its lifespan.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 12. Aircon Cleaning for Concealed Type (₱3,200)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (
    (SELECT id FROM servana.services WHERE name = 'Aircon Services'),
    'MAIN', 'Cleaning', 'Aircon Cleaning for Concealed Type', 3200, 'session'
  )
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Maintain the performance of your concealed air conditioning system with Servana''s professional aircon cleaning service. Our expert technicians provide a thorough cleaning of essential components to remove dust, dirt, and buildup that can affect cooling efficiency, airflow, and indoor air quality. Regular maintenance helps your unit operate smoothly, consume less energy, and extend its lifespan.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 13. Aircon Cleaning for Ceiling Mounted Type (₱2,199)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (
    (SELECT id FROM servana.services WHERE name = 'Aircon Services'),
    'MAIN', 'Cleaning', 'Aircon Cleaning for Ceiling Mounted Type', 2199, 'session'
  )
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Keep your ceiling-mounted air conditioner operating efficiently with Servana''s professional aircon cleaning service. Our expert technicians perform a thorough cleaning to remove dust, dirt, and buildup from key components, helping improve cooling performance, airflow, and indoor air quality. Regular maintenance helps your unit run smoothly, reduce energy consumption, and extend its lifespan.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 14. Freon Charge (per unit) (₱2,990)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (
    (SELECT id FROM servana.services WHERE name = 'Aircon Services'),
    'MAIN', 'Cleaning', 'Freon Charge (per unit)', 2990, 'per unit'
  )
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Restore your air conditioner''s cooling performance with Servana''s Freon Charging Service. If your aircon is blowing warm air or not cooling properly even after cleaning, it may need a refrigerant (Freon) refill. Our certified technicians will inspect your unit, check refrigerant levels, and safely recharge Freon to help bring back optimal cooling efficiency.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

COMMIT;

-- Verify: should return 14 rows under level_2='Cleaning'
SELECT so.level_2, so.level_3, so.base_price, so.unit
FROM servana.service_options so
WHERE so.service_id = (SELECT id FROM servana.services WHERE name = 'Aircon Services')
  AND so.option_type = 'MAIN'
ORDER BY so.level_2, so.id;
