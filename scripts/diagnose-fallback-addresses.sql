-- Identify customer addresses damaged by the two address-form defects fixed in
-- servana_client 1a15ecd. READ-ONLY. Nothing here writes.
--
-- Run against production with:
--   psql "$DATABASE_URL" -f scripts/diagnose-fallback-addresses.sql
--
-- ── The two defects ──────────────────────────────────────────────────────────
--
-- (A) COSMETIC. The address form appended `locality` (the city) to the street
--     line while also writing it to the city field, so address_one ends with
--     the same value post_town holds. Every screen then printed both:
--     "15, Del Pilar, Manila, Manila". Harmless to dispatch — the address is
--     correct, it just reads badly — and the shipped client already hides it at
--     display time via formatAddressLine(). No backfill is strictly required.
--
-- (B) SERIOUS. With no initial location the map opened on a hardcoded
--     BGC/Taguig fallback (14.5535, 121.0220) and then tried GPS, swallowing
--     failures silently. The map still fired onCameraIdle, which reverse-
--     geocoded whatever the camera sat on — the fallback, whenever GPS was off,
--     denied or slow. Those rows hold an address the customer never chose AND
--     the fallback's coordinates, which feed coverage checks and dispatch.
--     A display fix cannot repair these. They are wrong data.
--
-- ── Why location_id is the reliable signal ───────────────────────────────────
--
-- user_address has no lat/lon columns; the coordinates live in MongoDB. But the
-- client writes location_id as 'loc_<lat>_<lon>' to exactly six decimals
-- (address_repository.dart), so the fallback produces the literal string
-- 'loc_14.553500_121.022000'. That is an exact match, not a heuristic.
--
-- Verify that constant against the client before trusting query 2:
--   address_form_screen.dart  _fallbackCenter = LatLng(14.5535, 121.0220)

\echo ''
\echo '=== 1. Rows whose street line repeats the city (defect A, cosmetic) ==='
\echo '    Matching is on the whole trailing comma-separated component, so'
\echo '    "12 Manila Street" + "Quezon City" is NOT flagged. Same rule as'
\echo '    addressLineRepeatsCity() in the app, deliberately.'
\echo ''

SELECT
  count(*) AS affected_rows,
  count(DISTINCT uid) AS affected_customers
FROM servana.user_address
WHERE post_town IS NOT NULL
  AND btrim(post_town) <> ''
  AND lower(btrim(split_part(address_one, ',', -1))) = lower(btrim(post_town));

\echo ''
\echo '=== 2. Rows saved from the hardcoded BGC fallback (defect B, SERIOUS) ==='
\echo '    These carry a location the customer never picked. Exact match on the'
\echo '    fallback coordinates as the client encodes them.'
\echo ''

SELECT
  count(*) AS affected_rows,
  count(DISTINCT uid) AS affected_customers
FROM servana.user_address
WHERE location_id = 'loc_14.553500_121.022000';

\echo ''
\echo '=== 2b. Same, with detail — review before deciding anything ==='
\echo ''

SELECT
  address_id,
  uid,
  label,
  address_one,
  post_town,
  is_primary,
  to_timestamp(created_by::bigint) AT TIME ZONE 'Asia/Manila' AS created_manila
FROM servana.user_address
WHERE location_id = 'loc_14.553500_121.022000'
ORDER BY created_by DESC
LIMIT 100;

\echo ''
\echo '=== 3. How many of those fallback rows were actually USED for a booking? ==='
\echo '    This is the number that matters. An unused bad address is a cleanup;'
\echo '    a booked one may have sent a technician to the wrong place, and the'
\echo '    customer should be contacted rather than silently corrected.'
\echo ''

SELECT
  count(DISTINCT b.id)      AS bookings_on_fallback_addresses,
  count(DISTINCT b.user_id) AS customers_affected,
  min(b.schedule)           AS earliest_schedule,
  max(b.schedule)           AS latest_schedule
FROM servana.bookings b
JOIN servana.user_address ua ON ua.address_id = b.user_address_id
WHERE ua.location_id = 'loc_14.553500_121.022000';

\echo ''
\echo '=== 3b. Those bookings, listed ==='
\echo ''

SELECT
  b.id AS booking_id,
  'SVN-' || lpad(b.id::text, 6, '0') AS booking_code,
  b.status,
  b.schedule,
  ua.address_one,
  ua.post_town
FROM servana.bookings b
JOIN servana.user_address ua ON ua.address_id = b.user_address_id
WHERE ua.location_id = 'loc_14.553500_121.022000'
ORDER BY b.schedule DESC
LIMIT 100;

\echo ''
\echo '=== 4. Sanity check: is the fallback a plausible REAL address for anyone? ==='
\echo '    BGC is a real place, so a customer genuinely there could legitimately'
\echo '    produce these coordinates — but only to six-decimal exactness by'
\echo '    coincidence, which is vanishingly unlikely. This shows how tightly the'
\echo '    value clusters; a spike at exactly one location_id is the fallback,'
\echo '    not a neighbourhood.'
\echo ''

SELECT
  location_id,
  count(*) AS rows
FROM servana.user_address
WHERE location_id LIKE 'loc_14.55%'
GROUP BY location_id
ORDER BY rows DESC
LIMIT 20;

\echo ''
\echo '=== NOTHING WAS MODIFIED. ==='
\echo ''
\echo 'Suggested reading of the results:'
\echo '  Query 1 > 0  — cosmetic only; the shipped client already hides it.'
\echo '                 A backfill is optional and can wait for a quiet window.'
\echo '  Query 2 > 0  — real bad data. Those addresses point at BGC.'
\echo '  Query 3 > 0  — bookings were placed against them. Do NOT silently'
\echo '                 rewrite these: a completed job at the wrong address is a'
\echo '                 customer-service matter, not a data-cleanup one.'
\echo ''
\echo 'The client fix (1a15ecd) stops new rows of either kind. It does not and'
\echo 'cannot repair existing ones.'
