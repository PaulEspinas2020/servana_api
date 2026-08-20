-- 039 · Give legacy family 67 (Electrical Services) the coverage every other
--       live family already has.
--
-- ── The defect ───────────────────────────────────────────────────────────────
--
-- `servana.service_coverage_geo` holds ZERO rows for service_id 67, and
-- `serviceService.checkCoverageGeo` ends with:
--
--     return { covered: !!match, ... }
--
-- With no rows there is no match, so `covered` is FALSE — absent configuration
-- fails CLOSED. `bookingService.createBooking` then throws
-- "Service not available in your area." before it writes anything.
--
-- Measured on production 2026-08-20:
--
--   GET /api/services/67/coverage-geo  ->  {"success":true,"coverage":[]}
--
-- Family 67 owns exactly one promoted catalogue service — canonical
-- `services.id` 180, "Wiring fuitures" — which is the ONLY service in the
-- Home Maintenance category. So the whole category was unsellable: a customer
-- could browse it, open it, choose an address and a time, and be refused at
-- submission for a reason no screen could have warned them about.
--
-- ── Why these five rows and not a judgement call ──────────────────────────────
--
-- This is NOT a new service-area policy. It is the completion of one that was
-- already applied and missed this family.
--
-- Families 1 (Aircon 2) and 2 (Beauty & Wellness) carry byte-identical
-- geometry: one Metro Manila disc created 2026-02-22, plus four regional discs
-- all created within 132ms of each other on 2026-05-28 — a single expansion
-- pass. Family 67 received neither the February row nor the May pass. The rows
-- below are exactly family 1's, so Home Maintenance becomes sellable wherever
-- Servana already sells and nowhere else.
--
--   (14.5547, 121.0244) r 25km   Metro Manila      · from the Feb row
--   (16.5,    121.5)    r 600km  Luzon             · from the May pass
--   (11.0,    123.5)    r 400km  Visayas           ·
--   ( 7.0,    123.5)    r 600km  Mindanao          ·
--   (10.0,    118.5)    r 350km  Palawan           ·
--
-- ── Deliberately NOT in scope ────────────────────────────────────────────────
--
-- **Family 52 (Massage, 10 catalogue services) is left alone.** It has only the
-- February Metro Manila row, so it is bookable — just restricted to a 25km
-- disc. Widening a service area that currently WORKS is a dispatch decision
-- with an operational cost (§29 revalidates the provider at assignment time,
-- but a booking accepted 500km from any provider is still a booking somebody
-- has to cancel). 67 sells nowhere at all; 52 sells somewhere. Different
-- problems, different approvals.
--
-- Families 53, 54, 66, 68, 69 and 70 also hold zero rows and are also left
-- alone: `/api/services/full` shows they have no promoted options, so no
-- catalogue service resolves to them and no customer can reach them.
--
-- **The fail-closed default itself is not changed here.** §28 says that no
-- explicit restriction should mean all Servana-supported cities, and
-- `covered: !!match` says the opposite. Fixing that in `checkCoverageGeo`
-- would silently open coverage for every family whose rows are ever deleted,
-- which is the failure §28 warns about in its own second sentence. It needs
-- its own change, with a distinction between "no configuration" and
-- "configuration that excludes you". Recorded, not smuggled in.
--
-- ── Safety ───────────────────────────────────────────────────────────────────
--
-- Purely additive: INSERT only, one table, no schema change, no BEGIN/COMMIT
-- (the runner wraps each migration and a self-managed transaction cannot be
-- dry-run). Idempotent by `WHERE NOT EXISTS` on the geometry, so re-running
-- inserts nothing — the table has no unique constraint to rely on, and this
-- must not be the migration that discovers that.
--
-- Rollback:
--   DELETE FROM servana.service_coverage_geo WHERE service_id = 67;
-- No other row references these; `checkCoverageGeo` reads them and nothing
-- writes them. That returns family 67 to its present state exactly.

INSERT INTO servana.service_coverage_geo
  (service_id, center_lat, center_lon, radius_km, is_active)
SELECT v.service_id, v.center_lat, v.center_lon, v.radius_km, TRUE
FROM (
  VALUES
    (67, 14.5547::numeric, 121.0244::numeric,  25::numeric),
    (67, 16.5::numeric,    121.5::numeric,    600::numeric),
    (67, 11.0::numeric,    123.5::numeric,    400::numeric),
    (67,  7.0::numeric,    123.5::numeric,    600::numeric),
    (67, 10.0::numeric,    118.5::numeric,    350::numeric)
) AS v(service_id, center_lat, center_lon, radius_km)
WHERE EXISTS (
  -- The family must exist. Inserting coverage for a service_id that is not
  -- there would be an orphan row no reader ever finds, and the table carries
  -- no foreign key to stop it.
  SELECT 1 FROM servana.service_families f WHERE f.id = v.service_id
)
AND NOT EXISTS (
  SELECT 1
  FROM servana.service_coverage_geo existing
  WHERE existing.service_id = v.service_id
    AND existing.center_lat = v.center_lat
    AND existing.center_lon = v.center_lon
    AND existing.radius_km  = v.radius_km
);

-- Fail loudly rather than report success on a no-op.
--
-- Every guard above is a silent skip: a missing family, or rows already there,
-- both leave the migration "successful" with nothing achieved. The ledger would
-- then record 039 as applied and no later run would revisit it. The postcondition
-- is what this migration is FOR, so it is asserted rather than assumed.
DO $$
DECLARE
  covered INTEGER;
BEGIN
  SELECT COUNT(*) INTO covered
  FROM servana.service_coverage_geo
  WHERE service_id = 67 AND is_active = TRUE;

  IF covered < 5 THEN
    RAISE EXCEPTION
      'Migration 039 postcondition failed: service_id 67 has % active coverage rows, expected at least 5. Check that servana.service_families contains id 67.',
      covered;
  END IF;
END;
$$;
