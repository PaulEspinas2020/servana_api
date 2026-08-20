-- 040 · Retire "Massage & Wellness", which sells the same ten services twice.
--
-- ── The duplicate ────────────────────────────────────────────────────────────
--
-- Two subcategories under Personal Care offer the same catalogue:
--
--   subcategory 10  "Massage"             services 191-200, legacy family 2
--   subcategory 11  "Massage & Wellness"  services  19-122, legacy family 52
--
-- Nine of the ten names are identical and all ten prices are identical; the only
-- difference is unit phrasing ("1 hour" against "per hour"):
--
--   191 Body Massage  PHP 400 / 1 hour        19 Body Massage  PHP 400 / per hour
--   195 Ventosa       PHP 500 / 1 hour        23 Ventosa       PHP 500 / per hour
--   199 Swedish       PHP 1000 / 2 hours     122 Swedish       PHP 1000 / per 2 hours
--
-- Both are `status = 'active'` with `display_order = 0`, so a customer browsing
-- Personal Care sees both sections. Which one they tap decides whether they can
-- book outside Metro Manila, because family 2 carries five coverage discs and
-- family 52 carries one 25km disc. Same service, same price, different answer —
-- §9's duplicate reality, with a consequence the customer feels.
--
-- ── Which one is the real one, measured 2026-08-20 ───────────────────────────
--
--                              family 2        family 52
--   bookings                   83 of 111       15
--   last booking               2026-08-11      2026-05-27
--   providers                  12              6
--   coverage                   5 discs         1 disc, Manila 25km
--   catalogue last extended    2026-07-25      2026-05-28
--
-- Family 52's last booking predates its own creation date (2026-05-28): those
-- fifteen were placed while the options still belonged to family 2 and were
-- moved out afterwards. **It has taken no booking since it existed as a family.**
--
-- And the direction of travel is away from it. On 2026-07-25 Massage (10),
-- Nails (17) and Hair (14) were created UNDER FAMILY 2, while dedicated
-- families 52/53/54 for exactly those trades already existed — 53 and 54 still
-- hold zero options today. The trade split is an abandoned direction, not the
-- destination.
--
-- ── Retire, not merge, and not delete ────────────────────────────────────────
--
-- §57: preserve historical ids, booking references and audit history; do not
-- destructively merge. Fifteen bookings reference these options and must keep
-- resolving.
--
-- So this flips ONE column. The rows stay:
--
--   * `catalog_subcategories.status = 'archived'` removes it from browse —
--     `getPublicCatalog` filters `status = 'active'` on categories,
--     subcategories AND services, so the section and its ten services leave the
--     tree together.
--   * `getServiceDetail` still RESOLVES those services and reports
--     `available: false`, which is deliberate: an archived deep link gets an
--     honest "unavailable" instead of a 404 dead end.
--   * `service_options`, `services`, `bookings` and every id are untouched.
--
-- Nothing is said here about family 52's coverage disc. Once nothing is sold
-- through it the question is moot, and narrowing or widening it would be a
-- change to a service area rather than a retirement.
--
-- Rollback, complete and exact:
--   UPDATE servana.catalog_subcategories
--      SET status = 'active', archived_at = NULL
--    WHERE id = 11;
--
-- ── Safety ───────────────────────────────────────────────────────────────────
--
-- One UPDATE, one row, no schema change, no BEGIN/COMMIT (the runner wraps each
-- migration). Idempotent: re-running finds the row already archived and changes
-- nothing.

UPDATE servana.catalog_subcategories
   SET status = 'archived',
       archived_at = COALESCE(archived_at, NOW()),
       updated_at = NOW()
 WHERE id = 11
   AND status <> 'archived'
   -- Identity re-asserted rather than assumed. Ids are stable, but a migration
   -- that archives "whatever is row 11" would retire the wrong section against
   -- a database whose catalogue was seeded differently.
   --
   -- These two predicates are intent stated at the write, NOT the enforcement:
   -- removing them fails no rehearsal check, because the postcondition below
   -- catches the same case and PostgreSQL rolls the UPDATE back with it. Said
   -- plainly rather than left to look like a guard that is doing the work.
   AND name = 'Massage & Wellness'
   AND legacy_service_family_id = 52;

-- Fail loudly rather than report success on a no-op.
--
-- Every guard above is a silent skip: a renamed row, a different family id, or
-- an id that is not this subcategory all leave the migration "successful" with
-- nothing achieved, and the ledger then records it as applied so no later run
-- revisits it. The postcondition is what this migration is FOR.
DO $$
DECLARE
  archived_rows INTEGER;
  still_visible INTEGER;
BEGIN
  SELECT COUNT(*) INTO archived_rows
  FROM servana.catalog_subcategories
  WHERE id = 11 AND name = 'Massage & Wellness' AND status = 'archived';

  IF archived_rows <> 1 THEN
    RAISE EXCEPTION
      'Migration 040 postcondition failed: subcategory 11 "Massage & Wellness" is not archived. Check that it still carries that name and legacy_service_family_id 52.';
  END IF;

  -- The point of the whole migration: Personal Care must no longer offer two
  -- massage sections. Asserted against what the public catalog actually reads.
  SELECT COUNT(*) INTO still_visible
  FROM servana.catalog_subcategories sc
  JOIN servana.catalog_categories c ON c.id = sc.category_id
  WHERE sc.status = 'active'
    AND c.status = 'active'
    AND sc.name ILIKE '%massage%';

  IF still_visible <> 1 THEN
    RAISE EXCEPTION
      'Migration 040 postcondition failed: % massage subcategories are still visible, expected exactly 1 ("Massage", legacy family 2).',
      still_visible;
  END IF;
END;
$$;
