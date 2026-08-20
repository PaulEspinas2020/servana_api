-- 042 · Retire families 53 Hair, 54 Nails, 66 Aesthetics & Beauty, 68 Barbering.
--
-- ── They are duplicates, and the platform already moved on ───────────────────
--
-- All four were created as trade-specific families — 53/54 on 2026-05-28,
-- 66/68 on 2026-07-08 — and not one of them was ever given a service. Measured
-- 2026-08-20:
--
--   family  name                  options  services  subcats  bookings
--   53      Hair                  0        0         0        0 (never)
--   54      Nails                 0        0         0        0 (never)
--   66      Aesthetics & Beauty   0        0         0        0 (never)
--   68      Barbering             0        0         0        0 (never)
--
-- What they sell is sold by family 2. On 2026-07-25 Hair (14 services), Nails
-- (17) and Massage (10) were created UNDER FAMILY 2, joining Facial (8) and
-- Beauty Drip (5) — the whole of Personal Care except the ten already retired
-- with subcategory 11.
--
-- The provider catalogue reached the same conclusion independently. Every
-- offering mapping points at family 2:
--
--   offering 4 Massage Therapy      -> family 2, level_2 'Massage'
--   offering 5 Nail Care            -> family 2, level_2 'Nails'
--   offering 6 Hair Services        -> family 2, level_2 'Hair'
--   offering 7 Aesthetics & Beauty  -> family 2, 'Facial' / 'Beauty Drip' / ...
--
-- Not one points at 53, 54, 66 or 68. Both sides of the platform already
-- consolidated; only the family rows were left behind.
--
-- ── No supply is lost ────────────────────────────────────────────────────────
--
-- The four hold 14 provider grants between them (53: 6, 54: 6, 66: 1, 68: 1).
-- Every one of those providers ALSO holds family 2 — verified by counting
-- grants that have no family 1/2/52/67 sibling, which across all six empty
-- families comes to exactly ONE provider, and that one is on 69 Plumbing,
-- which 041 brings live rather than retires.
--
-- So every provider granted a retired family here can still be assigned every
-- job they could be assigned yesterday, through family 2.
--
-- ── What retiring means, and what it does NOT reach ──────────────────────────
--
-- `service_families.deleted_at` is the column the schema already provides and
-- has never used — 0 of 10 rows carry it. It is read by exactly TWO queries,
-- both in `serviceService`: the customer-facing family list and its lookup
-- sibling. Both filter `WHERE deleted_at IS NULL`.
--
-- It is NOT read by `providerCatalogService.listServiceFamilies` (an admin
-- dropdown) or by `serviceApplicationService.evaluateApplicationEligibility`.
-- That second one matters and is worth being precise about: applications are
-- gated by the OFFERING policy, not by the family —
--
--     BOOL_OR(o.status = 'active' AND o.provider_web_visible AND m.is_active)
--
-- and since none of these four has an offering mapping, `application_open` is
-- already false for all of them. Setting `deleted_at` does not close
-- applications, because the offering layer closed them first. What it does is
-- stop the family appearing in the customer-facing service list and mark the
-- row as retired for every future reader.
--
-- The 14 applications already pending against these four (53: 3, 54: 7, 66: 4,
-- 68: 0) are NOT touched. Cancelling somebody's application is a decision with
-- a person on the other end of it (§31 gives rejection a provider-visible
-- reason); they should be re-pointed at family 2 or declined by an admin, and
-- deleting them here would erase both the record and the choice.
--
-- ── Soft, and reversible ─────────────────────────────────────────────────────
--
-- One column, four rows. Nothing is deleted: §57 keeps historical ids,
-- provider associations and application history intact. Every grant, every
-- application and every audit row survives.
--
-- Rollback:
--   UPDATE servana.service_families SET deleted_at = NULL
--    WHERE id IN (53, 54, 66, 68);
--
-- ── Safety ───────────────────────────────────────────────────────────────────
--
-- One UPDATE, no schema change, no BEGIN/COMMIT (the runner wraps it).
-- Idempotent: a second run finds them already retired and changes nothing.

UPDATE servana.service_families
   SET deleted_at = NOW()
 WHERE id IN (53, 54, 66, 68)
   AND deleted_at IS NULL
   -- Identity re-asserted rather than assumed, and the emptiness re-checked at
   -- the moment of the write: a family that has acquired a service since this
   -- was written is no longer a duplicate of anything, and must not be retired
   -- by an id that was true last week.
   AND NOT EXISTS (
     SELECT 1 FROM servana.service_options so
      WHERE so.service_id = service_families.id
        AND so.option_type = 'MAIN'
        AND so.is_active = true
   )
   AND NOT EXISTS (
     SELECT 1 FROM servana.catalog_subcategories sc
      WHERE sc.legacy_service_family_id = service_families.id
   )
   AND NOT EXISTS (
     SELECT 1 FROM servana.provider_catalog_offering_mappings m
      WHERE m.service_id = service_families.id
        AND m.is_active = true
   );

-- Fail loudly rather than report success on a no-op.
DO $$
DECLARE
  retired   INTEGER;
  stranded  INTEGER;
  survivors INTEGER;
BEGIN
  SELECT COUNT(*) INTO retired
  FROM servana.service_families
  WHERE id IN (53, 54, 66, 68) AND deleted_at IS NOT NULL;

  IF retired <> 4 THEN
    RAISE EXCEPTION
      'Migration 042: % of the four families are retired, expected 4. One of them has acquired a service, a subcategory or an offering mapping since this was written — re-read before forcing it.',
      retired;
  END IF;

  -- The promise this migration makes: nobody loses work they could do
  -- yesterday. A provider granted ONLY retired families, with no live family
  -- to fall back on, would be exactly that loss.
  SELECT COUNT(DISTINCT e.employee_uid) INTO stranded
  FROM servana.employee_services e
  WHERE e.service_id IN (53, 54, 66, 68)
    AND NOT EXISTS (
      SELECT 1 FROM servana.employee_services live
      JOIN servana.service_families f ON f.id = live.service_id
      WHERE live.employee_uid = e.employee_uid
        AND f.deleted_at IS NULL
    );

  IF stranded > 0 THEN
    RAISE EXCEPTION
      'Migration 042: % provider(s) hold ONLY retired families and would lose all assignable work. Grant them family 2 first.',
      stranded;
  END IF;

  -- And the catalogue still has families that sell something.
  SELECT COUNT(*) INTO survivors
  FROM servana.service_families f
  WHERE f.deleted_at IS NULL
    AND EXISTS (SELECT 1 FROM servana.service_options so
                 WHERE so.service_id = f.id AND so.option_type = 'MAIN' AND so.is_active);

  IF survivors < 3 THEN
    RAISE EXCEPTION
      'Migration 042: only % live families still carry services, expected at least 3 (1 Aircon, 2 Beauty & Wellness, 67 Electrical).',
      survivors;
  END IF;
END;
$$;
