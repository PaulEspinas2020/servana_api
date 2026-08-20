-- 041 · Bring Plumbing (69) and Carpentry (70) into Home Maintenance.
--
-- ── Why they sold nothing ────────────────────────────────────────────────────
--
-- Both families were created 2026-07-08 alongside Aesthetics & Beauty (66),
-- Electrical Services (67) and Barbering (68). Only 67 was ever wired up. The
-- other four have no `service_options`, no `services`, no
-- `catalog_subcategories` row and no `provider_catalog_offering_mappings` — so
-- they are invisible to the customer catalogue AND to the provider catalogue,
-- while holding provider grants and pending applications.
--
-- The provider-facing product already exists for both. Measured 2026-08-20,
-- `provider_catalog_offerings` holds eight rows, all `status = 'active'` and
-- `provider_web_visible = true`, including id 2 "Plumbing" and id 8 "Carpentry
-- & Fixer" — and neither maps to a family.
--
-- ## The reason is a name lookup that missed, quietly
--
-- `seedBuiltInOfferings` resolves each mapping by family NAME:
--
--     const sid = serviceIdByName.get(m.serviceFamilyName.toLowerCase());
--     if (!sid) continue; // Service family not yet in DB; skip silently
--
-- and three of the seeded names do not exist:
--
--     seed expects            actual family              result
--     'Plumbing Services'     'Plumbing' (69)            unmapped
--     'Carpentry & Handyman'  'Carpentry' (70)           unmapped
--     'Aircon Services'       'Aircon 2' (1)             unmapped
--
-- Identity taken from display text, which §7 forbids for exactly this reason.
-- The skip is silent, so nothing has ever reported it. `providerCatalogService`
-- is fixed in the same change to fail loudly instead; this migration repairs
-- the DATA the silent skips left behind, for the two families in scope.
--
-- Aircon (offering 1 -> family 1) is deliberately NOT mapped here. It already
-- has fifteen providers granted through `employee_services`, so opening its
-- offering changes who may apply to a working family — a supply decision, not a
-- repair. Reported instead.
--
-- ── What this does ───────────────────────────────────────────────────────────
--
-- 1. Maps offering 2 -> family 69 and offering 8 -> family 70, which is what
--    `evaluateApplicationEligibility` reads to decide `application_open`. The
--    two Plumbing applications already sitting in `pending_review` become
--    actionable rather than orphaned.
--
-- 2. Creates a Home Maintenance subcategory for each, as **draft**.
--
--    Draft, not active, and that is the point. `getPublicCatalog` filters
--    `status = 'active'` and deliberately returns a subcategory with no visible
--    services so the client can render an empty state — so an ACTIVE empty
--    section would put "Plumbing (0)" and "Carpentry (0)" in front of every
--    customer browsing Home Maintenance. A section that cannot be booked is
--    worse than one that is not there yet (§62).
--
--    They go live by flipping one column each, once services exist.
--
-- 3. Gives both families explicit coverage: one Metro Manila disc.
--
--    NOT the five national discs families 1, 2 and 67 carry. Measured the same
--    day: `provider_service_area_catalog` is 21 cities, all Metro Manila and
--    its fringe; all 27 `worker_service_areas` rows draw only from it; every
--    booking ever placed is Metro Manila. A 600km disc reaching Mindanao
--    describes coverage no provider can serve. These two start honest.
--
--    (Families 1, 2 and 67 still carry the wide discs. Narrowing them would
--    refuse bookings the platform accepts today — a decision about where
--    Servana sells, not a repair, so it stays reported.)
--
-- ── What this does NOT do ────────────────────────────────────────────────────
--
-- It creates no service and no price. There is no basis in this repository for
-- what a drain unclogging or a shelf installation costs, and inventing a
-- price list is not a migration's job. Until an admin adds services through
-- `/api/admin/catalog/*`, both subcategories stay draft and both families sell
-- nothing — which is the state they are in today, minus the invisibility.
--
-- ── Safety ───────────────────────────────────────────────────────────────────
--
-- Additive. Two INSERTs into `catalog_subcategories`, two into
-- `provider_catalog_offering_mappings`, two into `service_coverage_geo`. No
-- schema change, no BEGIN/COMMIT (the runner wraps each migration). Idempotent
-- throughout by `WHERE NOT EXISTS` and `ON CONFLICT DO NOTHING`.
--
-- Rollback:
--   DELETE FROM servana.service_coverage_geo WHERE service_id IN (69, 70);
--   DELETE FROM servana.provider_catalog_offering_mappings
--    WHERE (offering_id, service_id) IN ((2, 69), (8, 70));
--   DELETE FROM servana.catalog_subcategories
--    WHERE legacy_service_family_id IN (69, 70) AND status = 'draft';

-- ── 1. Provider side: the offering mappings the seed never made ──────────────
INSERT INTO servana.provider_catalog_offering_mappings
  (offering_id, service_id, level_2, display_order, is_active)
SELECT v.offering_id, v.service_id, v.level_2, v.display_order, TRUE
FROM (
  VALUES
    (2, 69, 'Plumbing',  1),
    (8, 70, 'Carpentry', 1)
) AS v(offering_id, service_id, level_2, display_order)
WHERE EXISTS (
  SELECT 1 FROM servana.provider_catalog_offerings o WHERE o.id = v.offering_id
)
AND EXISTS (
  SELECT 1 FROM servana.service_families f WHERE f.id = v.service_id
)
ON CONFLICT (offering_id, service_id, level_2) DO NOTHING;

-- ── 2. Customer side: a home for each, not yet on display ────────────────────
INSERT INTO servana.catalog_subcategories
  (category_id, name, slug, display_order, status, legacy_service_family_id)
SELECT 1, v.name, v.slug, v.display_order, 'draft', v.family
FROM (
  VALUES
    ('Plumbing',  'plumbing',  1, 69),
    ('Carpentry', 'carpentry', 2, 70)
) AS v(name, slug, display_order, family)
WHERE EXISTS (
  -- Category 1 is Home Maintenance. Asserted rather than assumed: an INSERT
  -- against a category that is not there would be an orphan nothing renders.
  SELECT 1 FROM servana.catalog_categories c
   WHERE c.id = 1 AND c.name = 'Home Maintenance'
)
AND NOT EXISTS (
  SELECT 1 FROM servana.catalog_subcategories existing
   WHERE existing.legacy_service_family_id = v.family
);

-- ── 3. Coverage: Metro Manila, where the providers actually are ──────────────
INSERT INTO servana.service_coverage_geo
  (service_id, center_lat, center_lon, radius_km, is_active)
SELECT v.service_id, 14.5547::numeric, 121.0244::numeric, 50::numeric, TRUE
FROM (VALUES (69), (70)) AS v(service_id)
WHERE EXISTS (
  SELECT 1 FROM servana.service_families f WHERE f.id = v.service_id
)
AND NOT EXISTS (
  SELECT 1 FROM servana.service_coverage_geo existing
   WHERE existing.service_id = v.service_id
);

-- Fail loudly rather than report success on a no-op.
--
-- Every guard above is a silent skip — which is precisely the failure this
-- migration exists to repair. A migration that repairs a silent skip by
-- skipping silently would be a poor joke.
DO $$
DECLARE
  mappings INTEGER;
  subcats  INTEGER;
  coverage INTEGER;
  visible  INTEGER;
BEGIN
  SELECT COUNT(*) INTO mappings
  FROM servana.provider_catalog_offering_mappings
  WHERE service_id IN (69, 70) AND is_active;

  SELECT COUNT(*) INTO subcats
  FROM servana.catalog_subcategories
  WHERE legacy_service_family_id IN (69, 70);

  SELECT COUNT(*) INTO coverage
  FROM servana.service_coverage_geo
  WHERE service_id IN (69, 70) AND is_active;

  IF mappings < 2 THEN
    RAISE EXCEPTION 'Migration 041: % offering mappings for families 69/70, expected 2. Check that offerings 2 and 8 still exist.', mappings;
  END IF;
  IF subcats < 2 THEN
    RAISE EXCEPTION 'Migration 041: % subcategories for families 69/70, expected 2. Check that category 1 is still "Home Maintenance".', subcats;
  END IF;
  IF coverage < 2 THEN
    RAISE EXCEPTION 'Migration 041: % coverage rows for families 69/70, expected 2.', coverage;
  END IF;

  -- The customer-facing promise: nothing new appears in browse yet, because
  -- neither subcategory has a service to show.
  SELECT COUNT(*) INTO visible
  FROM servana.catalog_subcategories sc
  WHERE sc.legacy_service_family_id IN (69, 70) AND sc.status = 'active';

  IF visible <> 0 THEN
    RAISE EXCEPTION 'Migration 041: % of the new subcategories are ACTIVE. They must stay draft until they have services, or customers see empty sections they cannot book.', visible;
  END IF;
END;
$$;
