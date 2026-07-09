import dbQuery from '../db/dbQuery';
import { db } from '../config';

const dbSchema = db.schema;

// ── Schema ────────────────────────────────────────────────────────────────────

let schemaReady = false;

export const ensureAttributionSchema = async (): Promise<void> => {
  if (schemaReady) return;
  try {
    await dbQuery.query(`
      CREATE TABLE IF NOT EXISTS ${dbSchema}.provider_client_activity (
        id            BIGSERIAL PRIMARY KEY,
        provider_uid  TEXT        NOT NULL,
        activity_type TEXT        NOT NULL,
        client        TEXT        NOT NULL DEFAULT 'mobile',
        confidence    TEXT        NOT NULL DEFAULT 'high',
        metadata      JSONB,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await dbQuery.query(`
      CREATE INDEX IF NOT EXISTS idx_pca_provider_uid
        ON ${dbSchema}.provider_client_activity (provider_uid, created_at DESC)
    `);
    await dbQuery.query(`
      CREATE INDEX IF NOT EXISTS idx_pca_client_type
        ON ${dbSchema}.provider_client_activity (client, activity_type, created_at DESC)
    `);
    await dbQuery.query(`
      CREATE TABLE IF NOT EXISTS ${dbSchema}.provider_source_attribution (
        provider_uid              TEXT        PRIMARY KEY,
        registration_source       TEXT        NOT NULL DEFAULT 'unknown',
        registration_confidence   TEXT        NOT NULL DEFAULT 'low',
        source_signals            JSONB       NOT NULL DEFAULT '[]',
        first_seen_mobile_at      TIMESTAMPTZ,
        first_seen_web_at         TIMESTAMPTZ,
        last_mobile_at            TIMESTAMPTZ,
        last_web_at               TIMESTAMPTZ,
        mobile_activity_count     INTEGER     NOT NULL DEFAULT 0,
        attribution_computed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    schemaReady = true;
  } catch (err) {
    console.error('[mobile-attribution] schema error:', err);
    throw err;
  }
};

// ── Forward Activity Logging ─────────────────────────────────────────────────
// Fire-and-forget: callers must NOT await this.

export const logProviderClientActivity = (
  providerUid: string,
  activityType: string,
  client: 'mobile' | 'web',
  metadata?: Record<string, unknown>,
): void => {
  if (!providerUid) return;
  dbQuery
    .query(
      `INSERT INTO ${dbSchema}.provider_client_activity
         (provider_uid, activity_type, client, confidence, metadata)
       VALUES ($1, $2, $3, 'high', $4)`,
      [providerUid, activityType, client, metadata ? JSON.stringify(metadata) : null],
    )
    .catch((err) => console.error('[mobile-attribution] log error:', err));
};

// ── Registration Source Inference ────────────────────────────────────────────

const REG_WINDOW_SECONDS = 300;

const inferRegistrationSource = async (
  providerUid: string,
): Promise<{ source: string; confidence: string; signals: string[] }> => {
  const res = await dbQuery.query(
    `
    SELECT
      uc.created_date,
      MIN(es.created_at)                                                        AS earliest_service_at,
      EXTRACT(EPOCH FROM (MIN(es.created_at) - uc.created_date))                AS delta_seconds
    FROM ${dbSchema}.user_credentials uc
    LEFT JOIN ${dbSchema}.employee_services es ON es.employee_uid = uc.uid
    WHERE uc.uid = $1
    GROUP BY uc.created_date
    `,
    [providerUid],
  );

  if (!res.rows.length) return { source: 'unknown', confidence: 'low', signals: [] };

  const { delta_seconds, earliest_service_at } = res.rows[0];
  const signals: string[] = [];

  if (earliest_service_at !== null && delta_seconds !== null) {
    const delta = Number(delta_seconds);
    if (delta >= 0 && delta <= REG_WINDOW_SECONDS) {
      signals.push('employee_services_at_registration');
      return { source: 'inferred_mobile', confidence: 'medium', signals };
    }
    signals.push('employee_services_deferred');
  }

  return { source: 'unknown', confidence: 'low', signals };
};

// ── Catalog Association ──────────────────────────────────────────────────────

export type CatalogAssociationStatus =
  | 'fully_mapped'
  | 'partially_mapped'
  | 'legacy_only'
  | 'unmapped'
  | 'ambiguous'
  | 'not_applicable';

export interface ProviderCatalogAssociation {
  status: CatalogAssociationStatus;
  serviceCount: number;
  mappedCount: number;
  unmappedCount: number;
  ambiguousCount: number;
  hasCapabilities: boolean;
  services: Array<{
    serviceId: number;
    serviceName: string | null;
    offeringIds: number[];
    offeringNames: string[];
    status: 'mapped' | 'unmapped' | 'ambiguous';
  }>;
}

export const getProviderCatalogAssociation = async (
  providerUid: string,
): Promise<ProviderCatalogAssociation> => {
  const servicesRes = await dbQuery.query(
    `
    SELECT es.service_id, s.name AS service_name
    FROM   ${dbSchema}.employee_services es
    LEFT JOIN ${dbSchema}.services s ON s.id = es.service_id
    WHERE  es.employee_uid = $1
    `,
    [providerUid],
  );

  if (!servicesRes.rows.length) {
    return {
      status: 'not_applicable',
      serviceCount: 0,
      mappedCount: 0,
      unmappedCount: 0,
      ambiguousCount: 0,
      hasCapabilities: false,
      services: [],
    };
  }

  const serviceIds: number[] = servicesRes.rows.map((r: any) => r.service_id);

  const [mappingsRes, capsRes] = await Promise.all([
    dbQuery.query(
      `
      SELECT m.service_id, m.offering_id, o.name AS offering_name
      FROM   ${dbSchema}.provider_catalog_offering_mappings m
      JOIN   ${dbSchema}.provider_catalog_offerings o ON o.id = m.offering_id
      WHERE  m.service_id = ANY($1::int[])
      `,
      [serviceIds],
    ),
    dbQuery.query(
      `SELECT 1 FROM ${dbSchema}.employee_catalog_capabilities WHERE employee_uid = $1 LIMIT 1`,
      [providerUid],
    ),
  ]);

  const hasCapabilities = (capsRes.rowCount ?? 0) > 0;

  const offeringsByService = new Map<number, Array<{ id: number; name: string }>>();
  for (const row of mappingsRes.rows) {
    const list = offeringsByService.get(row.service_id) ?? [];
    if (!list.find((o) => o.id === row.offering_id)) {
      list.push({ id: row.offering_id, name: row.offering_name });
    }
    offeringsByService.set(row.service_id, list);
  }

  let mappedCount = 0;
  let unmappedCount = 0;
  let ambiguousCount = 0;

  const services = servicesRes.rows.map((row: any) => {
    const offerings = offeringsByService.get(row.service_id) ?? [];
    let svcStatus: 'mapped' | 'unmapped' | 'ambiguous';
    if (offerings.length === 0) { unmappedCount++; svcStatus = 'unmapped'; }
    else if (offerings.length === 1) { mappedCount++; svcStatus = 'mapped'; }
    else { ambiguousCount++; svcStatus = 'ambiguous'; }
    return {
      serviceId: row.service_id,
      serviceName: row.service_name ?? null,
      offeringIds: offerings.map((o) => o.id),
      offeringNames: offerings.map((o) => o.name),
      status: svcStatus,
    };
  });

  const serviceCount = servicesRes.rows.length;
  let status: CatalogAssociationStatus;

  if (ambiguousCount > 0) {
    status = 'ambiguous';
  } else if (unmappedCount === serviceCount) {
    status = 'unmapped';
  } else if (unmappedCount > 0) {
    status = 'partially_mapped';
  } else if (!hasCapabilities) {
    status = 'legacy_only';
  } else {
    status = 'fully_mapped';
  }

  return { status, serviceCount, mappedCount, unmappedCount, ambiguousCount, hasCapabilities, services };
};

// ── Per-provider Attribution ─────────────────────────────────────────────────

export const getProviderAttribution = async (providerUid: string) => {
  const [inferred, activityRes, attrRow] = await Promise.all([
    inferRegistrationSource(providerUid),
    dbQuery.query(
      `
      SELECT
        MIN(created_at) FILTER (WHERE client = 'mobile') AS first_mobile_at,
        MAX(created_at) FILTER (WHERE client = 'mobile') AS last_mobile_at,
        MIN(created_at) FILTER (WHERE client = 'web')    AS first_web_at,
        MAX(created_at) FILTER (WHERE client = 'web')    AS last_web_at,
        COUNT(*)        FILTER (WHERE client = 'mobile') AS mobile_count,
        COUNT(*)        FILTER (WHERE client = 'web')    AS web_count
      FROM ${dbSchema}.provider_client_activity
      WHERE provider_uid = $1
      `,
      [providerUid],
    ),
    dbQuery.query(
      `SELECT * FROM ${dbSchema}.provider_source_attribution WHERE provider_uid = $1`,
      [providerUid],
    ),
  ]);

  const act = activityRes.rows[0] ?? {};
  const stored = attrRow.rows[0] ?? null;

  const signals = [...inferred.signals];
  if (Number(act.mobile_count ?? 0) > 0) signals.push('mobile_activity_logged');

  return {
    providerUid,
    registrationSource: stored?.registration_source ?? inferred.source,
    registrationConfidence: stored?.registration_confidence ?? inferred.confidence,
    sourceSignals: stored?.source_signals ?? signals,
    firstSeenMobileAt: act.first_mobile_at ?? stored?.first_seen_mobile_at ?? null,
    firstSeenWebAt: act.first_web_at ?? stored?.first_seen_web_at ?? null,
    lastMobileAt: act.last_mobile_at ?? stored?.last_mobile_at ?? null,
    lastWebAt: act.last_web_at ?? stored?.last_web_at ?? null,
    mobileActivityCount: Number(act.mobile_count ?? 0),
    webActivityCount: Number(act.web_count ?? 0),
    attributionComputedAt: stored?.attribution_computed_at ?? null,
  };
};

// ── Mobile Aggregate Metrics ─────────────────────────────────────────────────

export const getMobileMetrics = async () => {
  const [totalRes, inferredRes, activityRes, catalogRes] = await Promise.all([
    dbQuery.query(
      `SELECT COUNT(*) AS total FROM ${dbSchema}.user_credentials WHERE role IN (2,4)`,
    ),
    dbQuery.query(
      `
      SELECT COUNT(DISTINCT es.employee_uid) AS inferred_mobile
      FROM   ${dbSchema}.employee_services es
      JOIN   ${dbSchema}.user_credentials uc ON uc.uid = es.employee_uid
      WHERE  uc.role IN (2,4)
        AND  EXTRACT(EPOCH FROM (es.created_at - uc.created_date)) BETWEEN 0 AND ${REG_WINDOW_SECONDS}
      `,
    ),
    dbQuery.query(
      `
      SELECT
        COUNT(DISTINCT provider_uid) AS providers_with_mobile_activity,
        COUNT(*)                     AS total_mobile_events
      FROM ${dbSchema}.provider_client_activity
      WHERE client = 'mobile'
      `,
    ),
    dbQuery.query(
      `
      WITH service_counts AS (
        SELECT
          es.employee_uid,
          COUNT(DISTINCT m.offering_id) AS offering_count,
          COUNT(DISTINCT es.service_id) AS service_count
        FROM   ${dbSchema}.employee_services es
        JOIN   ${dbSchema}.user_credentials uc ON uc.uid = es.employee_uid
        LEFT JOIN ${dbSchema}.provider_catalog_offering_mappings m ON m.service_id = es.service_id
        WHERE  uc.role IN (2,4)
        GROUP  BY es.employee_uid
      )
      SELECT
        COUNT(*) FILTER (WHERE offering_count = service_count AND service_count > 0) AS fully_mapped,
        COUNT(*) FILTER (WHERE offering_count > 0 AND offering_count < service_count) AS partially_mapped,
        COUNT(*) FILTER (WHERE offering_count = 0 AND service_count > 0)              AS unmapped
      FROM service_counts
      `,
    ),
  ]);

  const cat = catalogRes.rows[0] ?? {};
  return {
    totalProviders: Number(totalRes.rows[0]?.total ?? 0),
    inferredMobileRegistrants: Number(inferredRes.rows[0]?.inferred_mobile ?? 0),
    providersWithMobileActivity: Number(activityRes.rows[0]?.providers_with_mobile_activity ?? 0),
    totalMobileEvents: Number(activityRes.rows[0]?.total_mobile_events ?? 0),
    catalogFullyMapped: Number(cat.fully_mapped ?? 0),
    catalogPartiallyMapped: Number(cat.partially_mapped ?? 0),
    catalogUnmapped: Number(cat.unmapped ?? 0),
  };
};

// ── Historical Backfill ──────────────────────────────────────────────────────

export const backfillAttribution = async (): Promise<{ processed: number; inferred: number }> => {
  const providersRes = await dbQuery.query(
    `SELECT uid FROM ${dbSchema}.user_credentials WHERE role IN (2,4)`,
  );

  let processed = 0;
  let inferred = 0;

  for (const row of providersRes.rows) {
    try {
      const result = await inferRegistrationSource(row.uid);
      const actRes = await dbQuery.query(
        `
        SELECT
          MIN(created_at) FILTER (WHERE client = 'mobile') AS first_mobile,
          MAX(created_at) FILTER (WHERE client = 'mobile') AS last_mobile,
          COUNT(*)        FILTER (WHERE client = 'mobile') AS mobile_count
        FROM ${dbSchema}.provider_client_activity
        WHERE provider_uid = $1
        `,
        [row.uid],
      );
      const act = actRes.rows[0] ?? {};

      await dbQuery.query(
        `
        INSERT INTO ${dbSchema}.provider_source_attribution
          (provider_uid, registration_source, registration_confidence, source_signals,
           first_seen_mobile_at, last_mobile_at, mobile_activity_count, attribution_computed_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        ON CONFLICT (provider_uid) DO UPDATE SET
          registration_source     = EXCLUDED.registration_source,
          registration_confidence = EXCLUDED.registration_confidence,
          source_signals          = EXCLUDED.source_signals,
          first_seen_mobile_at    = COALESCE(EXCLUDED.first_seen_mobile_at,
                                             provider_source_attribution.first_seen_mobile_at),
          last_mobile_at          = COALESCE(EXCLUDED.last_mobile_at,
                                             provider_source_attribution.last_mobile_at),
          mobile_activity_count   = EXCLUDED.mobile_activity_count,
          attribution_computed_at = NOW()
        `,
        [
          row.uid,
          result.source,
          result.confidence,
          JSON.stringify(result.signals),
          act.first_mobile ?? null,
          act.last_mobile ?? null,
          Number(act.mobile_count ?? 0),
        ],
      );

      processed++;
      if (result.source === 'inferred_mobile') inferred++;
    } catch (err) {
      console.error(`[mobile-attribution] backfill error for ${row.uid}:`, err);
    }
  }

  return { processed, inferred };
};
