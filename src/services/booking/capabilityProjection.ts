/**
 * Keeping `catalog_provider_services` current.
 *
 * ## The fan-out, and why it is not a widening
 *
 * A legacy grant is per FAMILY: `employee_services.service_id` names one of ten
 * coarse families, and it already implies every bookable service under it — up
 * to 54. The canonical table records that same permission one row per
 * `services.id`, which is the grain matching actually needs.
 *
 * So projecting a family grant into N canonical rows PRESERVES today's
 * assignability exactly. It neither widens nor narrows: the provider could
 * already be assigned to every one of those services, and the fan-out is the
 * same statement migration 021 ran, moved to the moment the grant changes.
 *
 * ## Why every writer calls this instead of writing the table
 *
 * There are five capability-change paths (two approval routes, an admin grant,
 * a revoke, and pause/reactivate). Five hand-written projections would be five
 * chances to project with a different status vocabulary or forget the
 * provenance column — which is the failure this whole tab has been unpicking.
 * They call one function, and `tests/capability-canonical-source.test.ts`
 * asserts that they do.
 *
 * ## Revocation archives, it does not delete
 *
 * `status = 'archived'`, never `DELETE`. A deleted row cannot answer "was this
 * provider ever approved for that service, and when did it stop", which is the
 * question a payout dispute asks. The unique key is
 * `(provider_uid, service_id)`, so a re-grant revives the same row rather than
 * accumulating history — the timeline lives in the application and audit
 * trails, which do record every transition.
 */

/**
 * Whatever can run a query: a pooled client inside a transaction, or `dbQuery`.
 *
 * Typed structurally so a caller that already holds a transaction passes its
 * client and gets the projection committed atomically with the grant, while a
 * caller that does not can still project.
 */
export type CapabilityExec = (sql: string, params: unknown[]) => Promise<{ rowCount?: number | null }>;

/** How a canonical row came to exist. Matches the CHECK constraint on the table. */
export type CapabilityGrantOrigin = 'migrated_from_family' | 'admin_grant' | 'application_approved';

/** The canonical status vocabulary. Also the CHECK constraint. */
export type CanonicalCapabilityStatus = 'active' | 'paused' | 'archived';

export interface FamilyGrantProjection {
  providerUid: string;
  /** `service_families.id` — the legacy grain the writer works in. */
  familyId: number;
  origin: CapabilityGrantOrigin;
  /** Defaults to `active`. Pause and revoke pass their own. */
  status?: CanonicalCapabilityStatus;
}

/**
 * Project a family grant into one canonical row per bookable service.
 *
 * Idempotent by the table's unique key. An existing row is brought to the
 * requested status rather than skipped, so re-approving a previously revoked
 * grant restores assignability instead of leaving an archived row behind — the
 * bug that `ON CONFLICT DO NOTHING` would have produced, silently.
 *
 * `legacy_service_family_id` is stamped on every row so the projection can be
 * reversed by family, which is the grain the revoke path works in.
 *
 * Returns the number of canonical rows written. Zero is a legitimate answer: 15
 * legacy families carry no bookable service at all, so an approval against one
 * of them projects nothing — and that is worth seeing rather than treating as
 * a failure.
 */
export const projectFamilyGrant = async (
  exec: CapabilityExec,
  schema: string | undefined,
  grant: FamilyGrantProjection,
): Promise<number> => {
  const result = await exec(
    `INSERT INTO ${schema}.catalog_provider_services
       (provider_uid, service_id, status, legacy_service_family_id, source)
     SELECT $1, s.id, $3, $2, $4
       FROM ${schema}.services s
      WHERE s.legacy_service_family_id = $2
     ON CONFLICT (provider_uid, service_id) DO UPDATE
        SET status     = EXCLUDED.status,
            source     = EXCLUDED.source,
            legacy_service_family_id =
              COALESCE(${schema}.catalog_provider_services.legacy_service_family_id,
                       EXCLUDED.legacy_service_family_id),
            updated_at = NOW()`,
    [grant.providerUid, grant.familyId, grant.status ?? 'active', grant.origin],
  );
  return result.rowCount ?? 0;
};

/**
 * Move every canonical row that came from this family to a status.
 *
 * Used by revoke (`archived`), pause (`paused`) and reactivate (`active`), so
 * the canonical table tracks the legacy status change rather than drifting from
 * it the moment a provider pauses a service.
 *
 * Scoped by `legacy_service_family_id`, so a row the provider holds through a
 * DIFFERENT family or a direct admin grant is untouched. That scoping is the
 * reason the provenance column exists.
 */
export const setFamilyGrantStatus = async (
  exec: CapabilityExec,
  schema: string | undefined,
  args: { providerUid: string; familyId: number; status: CanonicalCapabilityStatus },
): Promise<number> => {
  const result = await exec(
    `UPDATE ${schema}.catalog_provider_services
        SET status = $3, updated_at = NOW()
      WHERE provider_uid = $1
        AND legacy_service_family_id = $2
        AND status IS DISTINCT FROM $3`,
    [args.providerUid, args.familyId, args.status],
  );
  return result.rowCount ?? 0;
};

/**
 * Project without ever failing the caller's operation.
 *
 * ## The judgement here, stated rather than buried
 *
 * On a path that already owns a transaction, the projection runs inside it and
 * a failure SHOULD roll the grant back — call `projectFamilyGrant` directly.
 *
 * On a path that does not, this wrapper is correct instead. Making a provider's
 * approval fail because a projection statement errored would be worse than the
 * drift it prevents: the read still falls back to the legacy grant, so the
 * provider remains assignable, and the parity report plus the reconciler close
 * the gap afterwards. Correctness does not depend on this write succeeding —
 * that is the whole reason the fallback is still in the predicate.
 *
 * The failure is logged with the family and the origin, never the uid.
 */
export const projectFamilyGrantSafely = async (
  exec: CapabilityExec,
  schema: string | undefined,
  grant: FamilyGrantProjection,
): Promise<number | null> => {
  try {
    return await projectFamilyGrant(exec, schema, grant);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(
      `[capability] canonical projection failed for family ${grant.familyId} (${grant.origin});`
      + ' the legacy grant still authorizes, and the reconciler will close the gap:',
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
};

/** The same tolerance for a status change. Same reasoning. */
export const setFamilyGrantStatusSafely = async (
  exec: CapabilityExec,
  schema: string | undefined,
  args: { providerUid: string; familyId: number; status: CanonicalCapabilityStatus },
): Promise<number | null> => {
  try {
    return await setFamilyGrantStatus(exec, schema, args);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(
      `[capability] canonical status change failed for family ${args.familyId} -> ${args.status}:`,
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
};

/**
 * Every legacy grant that has no active canonical row, per service.
 *
 * The parity measurement, and the supply-collapse guard in one query. Read-only.
 *
 * `legacy_only` is the adoption gap: a provider the legacy tables would qualify
 * and the canonical table would not. It must be zero before the fallback can be
 * removed, and any INCREASE means a writer stopped projecting.
 */
export const CAPABILITY_PARITY_SQL = (schema: string | undefined): string => `
  WITH legacy AS (
    SELECT es.employee_uid AS provider_uid, s.id AS service_id
      FROM ${schema}.employee_services es
      JOIN ${schema}.services s ON s.legacy_service_family_id = es.service_id
    UNION
    SELECT wsa.worker_uid, s.id
      FROM ${schema}.worker_service_applications wsa
      JOIN ${schema}.services s ON s.legacy_service_family_id = wsa.service_id
     WHERE wsa.status = 'approved'
  ),
  canonical AS (
    SELECT provider_uid, service_id
      FROM ${schema}.catalog_provider_services
     WHERE status = 'active'
  )
  SELECT
    (SELECT COUNT(*) FROM legacy)::int                                   AS legacy_grants,
    (SELECT COUNT(*) FROM canonical)::int                                AS canonical_grants,
    (SELECT COUNT(*) FROM legacy l
       WHERE NOT EXISTS (SELECT 1 FROM canonical c
                          WHERE c.provider_uid = l.provider_uid
                            AND c.service_id = l.service_id))::int       AS legacy_only,
    (SELECT COUNT(*) FROM canonical c
       WHERE NOT EXISTS (SELECT 1 FROM legacy l
                          WHERE l.provider_uid = c.provider_uid
                            AND l.service_id = c.service_id))::int       AS canonical_only,
    (SELECT COUNT(DISTINCT provider_uid) FROM legacy)::int               AS legacy_providers,
    (SELECT COUNT(DISTINCT provider_uid) FROM canonical)::int            AS canonical_providers`;

export interface CapabilityParity {
  legacyGrants: number;
  canonicalGrants: number;
  /** Grants the fallback is still carrying. Must be 0 to retire it. */
  legacyOnly: number;
  /** Canonical rows with no legacy counterpart — an admin grant, or a stale row. */
  canonicalOnly: number;
  legacyProviders: number;
  canonicalProviders: number;
}

export const readParityRow = (row: Record<string, unknown>): CapabilityParity => ({
  legacyGrants: Number(row.legacy_grants ?? 0),
  canonicalGrants: Number(row.canonical_grants ?? 0),
  legacyOnly: Number(row.legacy_only ?? 0),
  canonicalOnly: Number(row.canonical_only ?? 0),
  legacyProviders: Number(row.legacy_providers ?? 0),
  canonicalProviders: Number(row.canonical_providers ?? 0),
});

/**
 * Would adopting the canonical source alone cost any provider their supply?
 *
 * The guard that has to pass before the fallback is removed — and the reason
 * this migration is safe to ship before it does. A drop in *providers* is what
 * matters: losing one grant of fifty a provider holds is a gap, losing the only
 * grant they hold is a livelihood.
 */
export const supplyCollapseVerdict = (parity: CapabilityParity): {
  safeToRetireFallback: boolean;
  providerShortfall: number;
  detail: string;
} => {
  const providerShortfall = Math.max(0, parity.legacyProviders - parity.canonicalProviders);
  const safeToRetireFallback = parity.legacyOnly === 0 && providerShortfall === 0;

  return {
    safeToRetireFallback,
    providerShortfall,
    detail: safeToRetireFallback
      ? 'canonical covers every legacy grant; the fallback carries nothing'
      : `${parity.legacyOnly} grant(s) and ${providerShortfall} provider(s) would lose capability `
        + 'if the legacy fallback were removed now',
  };
};
