-- Migration 008: Add Installation (3) and Repair (10) aircon services
--
-- Migration 007 cleared all Aircon service_options and seeded 14 Cleaning services.
-- This migration adds the Installation and Repair sub-category services (pure INSERT).
-- The provider_catalog_offering_mappings rows for Installation and Repair were never
-- deleted — they remain intact from seedBuiltInOfferings and need no new mapping rows.
--
-- No mobile protection concern: 'Installation' and 'Repair' are not mobile-protected.
-- No booking guard needed: no existing rows are being deleted.

BEGIN;

-- ─── Installation (3 services) ───────────────────────────────────────────────

-- 1. Aircon Installation Window Type (₱1,400)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (
    (SELECT id FROM servana.services WHERE name = 'Aircon Services'),
    'MAIN', 'Installation', 'Aircon Installation Window Type', 1400, 'session'
  )
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Need professional help installing your window-type air conditioner? Servana''s expert aircon installation service ensures your unit is installed safely, securely, and correctly for optimal cooling performance. Our trained technicians handle the setup with care, making sure your aircon is properly positioned, leveled, and tested before completion.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 2. Aircon Installation Split Type (₱7,400)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (
    (SELECT id FROM servana.services WHERE name = 'Aircon Services'),
    'MAIN', 'Installation', 'Aircon Installation Split Type', 7400, 'session'
  )
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Need professional help installing your split-type air conditioner? Servana''s expert aircon installation service ensures your unit is installed safely, correctly, and efficiently for optimal cooling performance. Our trained technicians handle the complete setup, from mounting the indoor and outdoor units to testing the system for proper operation.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 3. Freon Charge (₱2,900)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (
    (SELECT id FROM servana.services WHERE name = 'Aircon Services'),
    'MAIN', 'Installation', 'Freon Charge', 2900, 'per unit'
  )
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Restore your air conditioner''s cooling performance with Servana''s Freon Charging Service. If your aircon is blowing warm air or not cooling properly even after cleaning, it may need a refrigerant (Freon) refill. Our certified technicians will inspect your unit, check refrigerant levels, and safely recharge Freon to help bring back optimal cooling efficiency.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- ─── Repair (10 services) ────────────────────────────────────────────────────

-- 4. Aircon Check up for Window Type (₱300)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (
    (SELECT id FROM servana.services WHERE name = 'Aircon Services'),
    'MAIN', 'Repair', 'Aircon Check up for Window Type', 300, 'session'
  )
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Is your window-type air conditioner not cooling properly, making unusual noises, or showing signs of poor performance? Servana''s aircon check-up service helps diagnose potential issues before they become costly repairs. Our trained technicians will inspect your unit and identify any problems affecting its cooling efficiency and overall performance.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 5. Aircon Check up for Split Type (₱390)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (
    (SELECT id FROM servana.services WHERE name = 'Aircon Services'),
    'MAIN', 'Repair', 'Aircon Check up for Split Type', 390, 'session'
  )
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Is your split-type air conditioner not cooling properly, leaking water, or making unusual noises? Servana''s aircon check-up service helps identify issues early and ensures your unit is performing at its best. Our skilled technicians will inspect and diagnose your aircon to detect any problems affecting cooling efficiency, airflow, or overall system performance.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 6. Aircon Check up for Ceiling Mounted Type (₱400)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (
    (SELECT id FROM servana.services WHERE name = 'Aircon Services'),
    'MAIN', 'Repair', 'Aircon Check up for Ceiling Mounted Type', 400, 'session'
  )
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Is your ceiling-mounted air conditioner not cooling properly, producing weak airflow, dripping water, or making unusual noises? Servana''s aircon check-up service helps identify issues early and ensures your unit is running efficiently and safely. Our trained technicians will thoroughly inspect and diagnose your system to detect any problems affecting performance, airflow distribution, or overall operation.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 7. Aircon Check up for Tower Type (₱400)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (
    (SELECT id FROM servana.services WHERE name = 'Aircon Services'),
    'MAIN', 'Repair', 'Aircon Check up for Tower Type', 400, 'session'
  )
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Is your tower-type air conditioner not cooling properly, blowing weak airflow, leaking water, or making unusual noises? Servana''s aircon check-up service helps identify issues early and ensures your unit is operating efficiently and safely. Our trained technicians will thoroughly inspect and diagnose your tower-type aircon to detect any problems affecting performance, airflow, and overall system condition.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 8. Aircon Check up for Cassette Type (₱400)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (
    (SELECT id FROM servana.services WHERE name = 'Aircon Services'),
    'MAIN', 'Repair', 'Aircon Check up for Cassette Type', 400, 'session'
  )
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Is your cassette-type air conditioner not cooling properly, distributing uneven airflow, leaking water, or producing unusual noises? Servana''s aircon check-up service helps detect problems early and ensures your unit performs efficiently and reliably. Our skilled technicians will carefully inspect and diagnose your cassette-type aircon to identify any issues affecting cooling performance, airflow, and overall system operation.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 9. Freon Charge (₱2,900)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (
    (SELECT id FROM servana.services WHERE name = 'Aircon Services'),
    'MAIN', 'Repair', 'Freon Charge', 2900, 'per unit'
  )
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Restore your air conditioner''s cooling performance with Servana''s Freon Charging Service. If your aircon is blowing warm air or not cooling properly even after cleaning, it may need a refrigerant (Freon) refill. Our certified technicians will inspect your unit, check refrigerant levels, and safely recharge Freon to help bring back optimal cooling efficiency.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 10. Aircon System Reprocess Window Type (0.5 HP to 1.5 HP) (₱4,400)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (
    (SELECT id FROM servana.services WHERE name = 'Aircon Services'),
    'MAIN', 'Repair', 'Aircon System Reprocess Window Type (0.5 HP to 1.5 HP)', 4400, 'session'
  )
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Is your window-type air conditioner no longer cooling efficiently, blowing warm air, or struggling to maintain temperature? Servana''s aircon system reprocess service helps restore performance by deep servicing the internal system of your unit. This is ideal for units that need more than basic cleaning and require a full performance refresh.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 11. Aircon System Reprocess Window Type (2 HP to 2.5 HP) (₱5,400)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (
    (SELECT id FROM servana.services WHERE name = 'Aircon Services'),
    'MAIN', 'Repair', 'Aircon System Reprocess Window Type (2 HP to 2.5 HP)', 5400, 'session'
  )
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Is your high-capacity window-type air conditioner not cooling properly, taking longer to reach the set temperature, or running but not performing efficiently? Servana''s aircon system reprocess service is designed to restore and improve the overall performance of larger window-type units. This deep servicing helps bring back strong cooling, better airflow, and improved energy efficiency.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 12. Aircon System Reprocess Split Type (up to 1.5HP) (₱6,900)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (
    (SELECT id FROM servana.services WHERE name = 'Aircon Services'),
    'MAIN', 'Repair', 'Aircon System Reprocess Split Type (up to 1.5HP)', 6900, 'session'
  )
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Is your split-type air conditioner no longer cooling efficiently, taking longer to cool the room, or running with weak airflow? Servana''s aircon system reprocess service helps restore your unit''s performance through a deep internal system cleaning and optimization process. This service is ideal for split-type aircons that need more than basic cleaning to bring back strong and efficient cooling.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

-- 13. Aircon System Reprocess Split Type (2 HP to 2.5 HP) (₱7,900)
WITH opt AS (
  INSERT INTO servana.service_options (service_id, option_type, level_2, level_3, base_price, unit)
  VALUES (
    (SELECT id FROM servana.services WHERE name = 'Aircon Services'),
    'MAIN', 'Repair', 'Aircon System Reprocess Split Type (2 HP to 2.5 HP)', 7900, 'session'
  )
  RETURNING id
)
INSERT INTO servana.service_option_meta (service_option_id, description, inclusions, exclusions)
SELECT id,
  'Is your high-capacity split-type air conditioner not cooling effectively, taking longer to reach the desired temperature, or running with weak airflow? Servana''s aircon system reprocess service is designed to restore full performance through a deep system cleaning and optimization process. This service is ideal for larger split-type units that require more intensive maintenance to bring back strong, efficient cooling.',
  '[]'::jsonb, '[]'::jsonb
FROM opt;

COMMIT;

-- Verify: show all aircon service_options grouped by level_2 (expect 27 total: 14 Cleaning + 3 Installation + 10 Repair)
SELECT so.level_2, so.level_3, so.base_price, so.unit
FROM servana.service_options so
WHERE so.service_id = (SELECT id FROM servana.services WHERE name = 'Aircon Services')
  AND so.option_type = 'MAIN'
ORDER BY so.level_2, so.id;
