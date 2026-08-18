-- TAB 05 — catalog_provider_services becomes the authoritative capability source
--
-- NON-DESTRUCTIVE. Inserts and reactivates canonical rows; touches no legacy
-- row, no provider record, no booking. Nothing is deleted and no legacy table
-- is read except to copy from.
--
-- NO TRANSACTION CONTROL — the runner owns the transaction, so this can be
-- dry-run with `npm run migrations:plan` and rolled back. See 020's header.
--
-- ## What this closes
--
-- Migration 021 backfilled `catalog_provider_services` from `employee_services`
-- only, once, in the Catalog V2 cutover. Two gaps have been open since:
--
--   1. approved `worker_service_applications` were never projected, so a
--      provider whose approval had not been mirrored into `employee_services`
--      has no canonical row at all;
--   2. nothing wrote the table afterwards, so every grant made since the
--      cutover is legacy-only.
--
-- The application writers now project on every change
-- (`services/booking/capabilityProjection.ts`). This migration is the catch-up
-- for everything that happened before they did.
--
-- ## Why the fan-out is not a widening
--
-- A legacy grant is per FAMILY and already implies every bookable service under
-- that family — up to 54. One canonical row per `services.id` records the same
-- permission at the grain matching needs. Nobody becomes assignable to anything
-- they were not already assignable to. Approvals against the 15 empty families
-- project nothing, because those families carry no bookable service.
--
-- ## The guard
--
-- The final DO block RAISES if any provider would come out of this migration
-- with fewer canonical services than their legacy grants imply. That aborts the
-- whole transaction. A backfill that silently under-covers is exactly the
-- supply collapse this tab exists to prevent, and the migration refusing to
-- commit is far cheaper than discovering it from an empty candidate list.

-- ── 1. employee_services → canonical, including previously-skipped statuses ──
-- Migration 021 ran the same fan-out but is not idempotent against status
-- changes: it used DO NOTHING, so a row that was later paused or archived in
-- the legacy table still reads 'active' canonically. This brings both in step.
INSERT INTO servana.catalog_provider_services
  (provider_uid, service_id, status, legacy_service_family_id, source)
SELECT es.employee_uid,
       s.id,
       CASE WHEN COALESCE(es.status, 'active') = 'paused' THEN 'paused' ELSE 'active' END,
       es.service_id,
       'migrated_from_family'
FROM servana.employee_services es
JOIN servana.services s ON s.legacy_service_family_id = es.service_id
ON CONFLICT (provider_uid, service_id) DO UPDATE
   SET status     = EXCLUDED.status,
       legacy_service_family_id =
         COALESCE(servana.catalog_provider_services.legacy_service_family_id,
                  EXCLUDED.legacy_service_family_id),
       updated_at = NOW()
-- Only when it actually differs, so `updated_at` stays meaningful and a re-run
-- of an already-current migration writes nothing.
WHERE servana.catalog_provider_services.status IS DISTINCT FROM EXCLUDED.status;

-- ── 2. approved worker_service_applications → canonical ─────────────────────
-- Never covered by 021. An approval that was recorded on the application but
-- not mirrored into employee_services has been assignable through the legacy
-- fallback and invisible canonically.
--
-- Does NOT downgrade an existing row: a provider who is paused on a family
-- should stay paused, and an approved application is not an instruction to
-- resume. Hence the WHERE on the conflict target.
INSERT INTO servana.catalog_provider_services
  (provider_uid, service_id, status, legacy_service_family_id, source)
SELECT DISTINCT wsa.worker_uid,
       s.id,
       'active',
       wsa.service_id,
       'application_approved'
FROM servana.worker_service_applications wsa
JOIN servana.services s ON s.legacy_service_family_id = wsa.service_id
WHERE wsa.status = 'approved'
ON CONFLICT (provider_uid, service_id) DO UPDATE
   SET status     = 'active',
       updated_at = NOW()
WHERE servana.catalog_provider_services.status = 'archived';

-- ── 3. The supply-collapse guard ────────────────────────────────────────────
-- Refuses to commit if the canonical table would not cover every legacy grant.
-- Raising here rolls the whole migration back, leaving the fallback carrying
-- the load exactly as it did before — the safe direction to fail in.
DO $$
DECLARE
  legacy_only_grants   INT;
  legacy_providers     INT;
  canonical_providers  INT;
  sample               TEXT;
BEGIN
  WITH legacy AS (
    SELECT es.employee_uid AS provider_uid, s.id AS service_id
      FROM servana.employee_services es
      JOIN servana.services s ON s.legacy_service_family_id = es.service_id
    UNION
    SELECT wsa.worker_uid, s.id
      FROM servana.worker_service_applications wsa
      JOIN servana.services s ON s.legacy_service_family_id = wsa.service_id
     WHERE wsa.status = 'approved'
  ),
  canonical AS (
    SELECT provider_uid, service_id
      FROM servana.catalog_provider_services
     WHERE status IN ('active', 'paused')
  )
  SELECT COUNT(*),
         (SELECT COUNT(DISTINCT provider_uid) FROM legacy),
         (SELECT COUNT(DISTINCT provider_uid) FROM canonical),
         COALESCE(string_agg(DISTINCT l.service_id::text, ',' ORDER BY l.service_id::text), '')
    INTO legacy_only_grants, legacy_providers, canonical_providers, sample
    FROM legacy l
   WHERE NOT EXISTS (
     SELECT 1 FROM canonical c
      WHERE c.provider_uid = l.provider_uid AND c.service_id = l.service_id
   );

  IF legacy_only_grants > 0 THEN
    RAISE EXCEPTION
      'Capability backfill incomplete: % legacy grant(s) have no canonical row (services: %). '
      'Rolling back rather than adopting a source that would drop supply.',
      legacy_only_grants, left(sample, 200);
  END IF;

  IF canonical_providers < legacy_providers THEN
    RAISE EXCEPTION
      'Capability backfill would leave % provider(s) without canonical capability (% legacy, % canonical).',
      legacy_providers - canonical_providers, legacy_providers, canonical_providers;
  END IF;

  RAISE NOTICE
    'Capability parity: % provider(s) covered canonically, 0 legacy-only grants.',
    canonical_providers;
END $$;

-- ── 4. The index matching now depends on ────────────────────────────────────
-- The canonical predicate probes (provider_uid, service_id, status) on every
-- eligibility check and inside the assignment transaction. 020 created single
-- column indexes; this is the one the hot lookup actually uses.
CREATE INDEX IF NOT EXISTS catalog_provider_services_lookup_idx
  ON servana.catalog_provider_services (provider_uid, service_id, status);

ALTER TABLE servana.catalog_provider_services OWNER TO admin;

COMMENT ON TABLE servana.catalog_provider_services IS
  'AUTHORITATIVE provider capability, at the canonical services.id grain. '
  'Written by services/booking/capabilityProjection.ts on every approval, grant, '
  'revoke, pause and reactivate. The legacy family grants (employee_services, '
  'approved worker_service_applications) remain in the matching predicate as an '
  'INSTRUMENTED FALLBACK until CANONICAL_ADOPTION_CRITERIA are met; see '
  'services/booking/capabilitySource.ts.';
