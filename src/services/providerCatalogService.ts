import { db } from "../config";
import dbQuery from "../db/dbQuery";
import { toCamel } from "../helpers/idGenerator";
import { auditFire } from "./adminAuditService";
const dbSchema = db.schema;

// ─── Schema init ─────────────────────────────────────────────────────────────
// Runs once at startup. All operations are additive and idempotent (IF NOT EXISTS,
// ADD COLUMN IF NOT EXISTS). No existing table, column, or data is ever dropped here.

export const initProviderCatalogSchema = async (): Promise<void> => {
  // 1. Provider Catalog Offerings — the canonical provider-facing catalog entity
  await dbQuery.query(`
    CREATE TABLE IF NOT EXISTS ${dbSchema}.provider_catalog_offerings (
      id                         SERIAL PRIMARY KEY,
      catalog_key                VARCHAR(100) NOT NULL UNIQUE,
      name                       VARCHAR(200) NOT NULL,
      short_description          TEXT,
      provider_description       TEXT,
      icon_key                   VARCHAR(100),
      banner_path                TEXT,
      display_order              INT NOT NULL DEFAULT 0,
      is_builtin                 BOOLEAN NOT NULL DEFAULT false,
      status                     VARCHAR(20) NOT NULL DEFAULT 'draft'
                                   CHECK (status IN ('draft','active','archived')),
      provider_web_visible       BOOLEAN NOT NULL DEFAULT true,
      customer_web_visible       BOOLEAN NOT NULL DEFAULT false,
      legacy_provider_mobile_visible  BOOLEAN NOT NULL DEFAULT false,
      legacy_customer_mobile_visible  BOOLEAN NOT NULL DEFAULT false,
      created_by                 TEXT,
      updated_by                 TEXT,
      created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      archived_at                TIMESTAMPTZ,
      version                    INT NOT NULL DEFAULT 1
    )
  `, []);

  // 2. Offering → Service Family + Option Group mappings (legacy compat layer)
  await dbQuery.query(`
    CREATE TABLE IF NOT EXISTS ${dbSchema}.provider_catalog_offering_mappings (
      id            SERIAL PRIMARY KEY,
      offering_id   INT NOT NULL REFERENCES ${dbSchema}.provider_catalog_offerings(id),
      service_id    INT NOT NULL,
      level_2       VARCHAR(100) NOT NULL,
      display_order INT NOT NULL DEFAULT 0,
      is_active     BOOLEAN NOT NULL DEFAULT true,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (offering_id, service_id, level_2)
    )
  `, []);

  // 3. Add description column to service_option_meta (nullable, backward-compatible)
  await dbQuery.query(`
    ALTER TABLE ${dbSchema}.service_option_meta
    ADD COLUMN IF NOT EXISTS description TEXT
  `, []);

  // 4. Add is_active column to service_options (defaults true for all existing rows)
  await dbQuery.query(`
    ALTER TABLE ${dbSchema}.service_options
    ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true
  `, []);

  // 5. Employee Catalog Capabilities — offering-specific provider qualification
  //    (more granular than employee_services which only tracks service_id)
  await dbQuery.query(`
    CREATE TABLE IF NOT EXISTS ${dbSchema}.employee_catalog_capabilities (
      id             SERIAL PRIMARY KEY,
      employee_uid   TEXT NOT NULL,
      offering_id    INT NOT NULL REFERENCES ${dbSchema}.provider_catalog_offerings(id),
      service_id     INT NOT NULL,
      level_2        VARCHAR(100) NOT NULL,
      status         VARCHAR(20) NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','suspended','archived')),
      application_id UUID,
      approved_at    TIMESTAMPTZ,
      suspended_at   TIMESTAMPTZ,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      version        INT NOT NULL DEFAULT 1,
      UNIQUE (employee_uid, offering_id)
    )
  `, []);

  // 6. account_status on user_credentials — added in code but not yet migrated in prod
  await dbQuery.query(`
    ALTER TABLE ${dbSchema}.user_credentials
    ADD COLUMN IF NOT EXISTS account_status TEXT NOT NULL DEFAULT 'pending'
  `, []);

  // 7. updated_at on service_options — tracks when a specific service was last modified
  //    (DEFAULT NOW() fills existing rows with the migration timestamp, which is accurate enough)
  await dbQuery.query(`
    ALTER TABLE ${dbSchema}.service_options
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  `, []);
};

// ─── Seed ────────────────────────────────────────────────────────────────────
// Idempotent: inserts only when catalog_key is absent. Never deletes or updates.
// Mappings reference services by name lookup (avoids hardcoding IDs that differ
// between environments). Only mappings whose service name is found are inserted.

interface OfferingSeed {
  catalogKey: string;
  name: string;
  shortDescription: string;
  providerDescription: string;
  iconKey: string;
  displayOrder: number;
  mappings: Array<{ serviceFamilyName: string; level2: string; displayOrder: number }>;
}

const BUILTIN_OFFERINGS: OfferingSeed[] = [
  {
    catalogKey: 'aircon-cleaning-repair',
    name: 'Aircon Cleaning & Repair',
    shortDescription: 'Split-type and window-type AC cleaning, repair, and installation.',
    providerDescription: 'Service and maintain residential air conditioning units including cleaning, basic repairs, and system checks.',
    iconKey: 'bi-wind',
    displayOrder: 1,
    mappings: [
      { serviceFamilyName: 'Aircon Services', level2: 'Cleaning',     displayOrder: 1 },
      { serviceFamilyName: 'Aircon Services', level2: 'Installation', displayOrder: 2 },
      { serviceFamilyName: 'Aircon Services', level2: 'Repair',       displayOrder: 3 },
    ],
  },
  {
    catalogKey: 'plumbing',
    name: 'Plumbing',
    shortDescription: 'Leak detection, drain clearing, and fixture installation.',
    providerDescription: 'Diagnose and fix common residential plumbing issues including leaks, clogs, and fixture installation.',
    iconKey: 'bi-droplet',
    displayOrder: 2,
    mappings: [
      { serviceFamilyName: 'Plumbing Services', level2: 'Plumbing', displayOrder: 1 },
    ],
  },
  {
    catalogKey: 'electrical-services',
    name: 'Electrical Services',
    shortDescription: 'Outlet, lighting, and minor wiring residential electrical work.',
    providerDescription: 'Perform common residential electrical tasks including outlet installation, lighting, and minor wiring repairs.',
    iconKey: 'bi-lightning',
    displayOrder: 3,
    mappings: [
      { serviceFamilyName: 'Electrical Services', level2: 'Electrical', displayOrder: 1 },
    ],
  },
  {
    catalogKey: 'massage-therapy',
    name: 'Massage Therapy',
    shortDescription: 'Therapeutic and relaxation massage services.',
    providerDescription: 'Professional therapeutic massage services for relaxation, stress relief, and muscle recovery.',
    iconKey: 'bi-heart-pulse',
    displayOrder: 4,
    // MOBILE-PROTECTED: level_2 'Massage' is used by ServanaClient MassageScreen (contains match)
    mappings: [
      { serviceFamilyName: 'Beauty & Wellness', level2: 'Massage', displayOrder: 1 },
    ],
  },
  {
    catalogKey: 'nail-care',
    name: 'Nail Care',
    shortDescription: 'Professional manicure and pedicure services.',
    providerDescription: 'Professional manicure and pedicure services for hands and feet, at home.',
    iconKey: 'bi-gem',
    displayOrder: 5,
    // MOBILE-PROTECTED: level_2 'Nails' matches /nail/i in ServanaClient HairNailsScreen
    mappings: [
      { serviceFamilyName: 'Beauty & Wellness', level2: 'Nails', displayOrder: 1 },
    ],
  },
  {
    catalogKey: 'hair-services',
    name: 'Hair Services',
    shortDescription: 'Professional haircut, styling, and grooming services.',
    providerDescription: 'Professional haircut, styling, grooming, and treatment services delivered at home for all hair types.',
    iconKey: 'bi-brush',
    displayOrder: 6,
    // MOBILE-PROTECTED: level_2 'Hair' matches /hair/i in ServanaClient HairNailsScreen
    mappings: [
      { serviceFamilyName: 'Beauty & Wellness', level2: 'Hair', displayOrder: 1 },
    ],
  },
  {
    catalogKey: 'aesthetics-beauty',
    name: 'Aesthetics & Beauty',
    shortDescription: 'Facial, skin treatments, and Beauty Drip IV therapy.',
    providerDescription: 'Facial care, waxing, and Beauty Drip IV therapy delivered at home.',
    iconKey: 'bi-palette',
    displayOrder: 7,
    // MOBILE-PROTECTED: level_2 'Facial' is exact match in ServanaClient BeautyWellnessScreen
    // 'Beauty Drip' and 'Beauty Drip Add Ons' are admin/provider-web only (no mobile match)
    mappings: [
      { serviceFamilyName: 'Beauty & Wellness', level2: 'Facial',              displayOrder: 1 },
      { serviceFamilyName: 'Beauty & Wellness', level2: 'Beauty Drip',         displayOrder: 2 },
      { serviceFamilyName: 'Beauty & Wellness', level2: 'Beauty Drip Add Ons', displayOrder: 3 },
    ],
  },
  {
    catalogKey: 'carpentry-fixer',
    name: 'Carpentry & Fixer',
    shortDescription: 'General handyman and carpentry services for home repairs.',
    providerDescription: 'General handyman and carpentry services for home repairs, furniture assembly, and fixtures.',
    iconKey: 'bi-wrench-adjustable',
    displayOrder: 8,
    mappings: [
      { serviceFamilyName: 'Carpentry & Handyman', level2: 'Carpentry', displayOrder: 1 },
    ],
  },
];

export const seedBuiltInOfferings = async (): Promise<void> => {
  // Pre-load service name → id map for mapping resolution
  const svcs = await dbQuery.query(
    `SELECT id, name FROM ${dbSchema}.services ORDER BY id`,
    []
  );
  const serviceIdByName = new Map<string, number>();
  for (const row of svcs.rows) {
    serviceIdByName.set((row.name as string).toLowerCase(), Number(row.id));
  }

  for (const seed of BUILTIN_OFFERINGS) {
    // Upsert offering (insert only when missing)
    const existing = await dbQuery.query(
      `SELECT id FROM ${dbSchema}.provider_catalog_offerings WHERE catalog_key = $1`,
      [seed.catalogKey]
    );

    let offeringId: number;

    if (existing.rows.length > 0) {
      offeringId = Number(existing.rows[0].id);
    } else {
      const ins = await dbQuery.query(
        `INSERT INTO ${dbSchema}.provider_catalog_offerings
          (catalog_key, name, short_description, provider_description, icon_key,
           display_order, is_builtin, status, provider_web_visible)
         VALUES ($1, $2, $3, $4, $5, $6, true, 'active', true)
         RETURNING id`,
        [
          seed.catalogKey,
          seed.name,
          seed.shortDescription,
          seed.providerDescription,
          seed.iconKey,
          seed.displayOrder,
        ]
      );
      offeringId = Number(ins.rows[0].id);
    }

    // Upsert mappings for this offering
    for (const m of seed.mappings) {
      const sid = serviceIdByName.get(m.serviceFamilyName.toLowerCase());
      if (!sid) continue; // Service family not yet in DB; skip silently

      await dbQuery.query(
        `INSERT INTO ${dbSchema}.provider_catalog_offering_mappings
          (offering_id, service_id, level_2, display_order, is_active)
         VALUES ($1, $2, $3, $4, true)
         ON CONFLICT (offering_id, service_id, level_2) DO NOTHING`,
        [offeringId, sid, m.level2, m.displayOrder]
      );
    }
  }
};

// ─── Provider-facing catalog read ────────────────────────────────────────────

export const getOfferingsForProvider = async (): Promise<any[]> => {
  const offeringsRes = await dbQuery.query(
    `SELECT id, catalog_key, name, short_description, provider_description,
            icon_key, banner_path, display_order, is_builtin, status
     FROM ${dbSchema}.provider_catalog_offerings
     WHERE status = 'active' AND provider_web_visible = true
     ORDER BY display_order, name`,
    []
  );

  const offerings = offeringsRes.rows;
  if (offerings.length === 0) return [];

  const ids = offerings.map((o: any) => o.id);

  // Mappings (legacy compat details)
  const mappingsRes = await dbQuery.query(
    `SELECT m.offering_id, m.service_id, m.level_2, s.name AS service_family_name
     FROM ${dbSchema}.provider_catalog_offering_mappings m
     JOIN ${dbSchema}.services s ON s.id = m.service_id
     WHERE m.offering_id = ANY($1) AND m.is_active = true
     ORDER BY m.offering_id, m.display_order`,
    [ids]
  );

  // Specific services for each offering (via mappings)
  const serviceIds = [...new Set<number>(mappingsRes.rows.map((m: any) => Number(m.service_id)))];
  const level2Values = [...new Set<string>(mappingsRes.rows.map((m: any) => m.level_2 as string))];

  let specificServicesRows: any[] = [];
  let addonsRows: any[] = [];

  if (serviceIds.length > 0 && level2Values.length > 0) {
    const ssRes = await dbQuery.query(
      `SELECT so.id, so.service_id, so.level_2, so.level_3, so.unit, so.base_price,
              COALESCE(m.description, '') AS description,
              COALESCE(m.inclusions, '[]'::jsonb) AS inclusions,
              COALESCE(m.exclusions, '[]'::jsonb) AS exclusions
       FROM ${dbSchema}.service_options so
       LEFT JOIN ${dbSchema}.service_option_meta m ON m.service_option_id = so.id
       WHERE so.service_id = ANY($1)
         AND so.level_2 = ANY($2)
         AND so.option_type = 'MAIN'
         AND (so.is_active IS NULL OR so.is_active = true)
       ORDER BY so.service_id, so.level_2, so.level_3`,
      [serviceIds, level2Values]
    );
    specificServicesRows = ssRes.rows;

    if (specificServicesRows.length > 0) {
      const ssIds = specificServicesRows.map((r: any) => Number(r.id));
      const addonRes = await dbQuery.query(
        `SELECT so.id, so.parent_option_id, so.level_3, so.unit, so.base_price
         FROM ${dbSchema}.service_options so
         WHERE so.parent_option_id = ANY($1) AND so.option_type = 'ADD_ON'
           AND (so.is_active IS NULL OR so.is_active = true)
         ORDER BY so.parent_option_id, so.level_3`,
        [ssIds]
      );
      addonsRows = addonRes.rows;
    }
  }

  // Group addons by parent
  const addonsByParent = new Map<number, any[]>();
  for (const a of addonsRows) {
    const pid = Number(a.parent_option_id);
    if (!addonsByParent.has(pid)) addonsByParent.set(pid, []);
    addonsByParent.get(pid)!.push({
      serviceOptionId: Number(a.id),
      name: a.level_3,
      unit: a.unit,
      basePrice: Number(a.base_price),
    });
  }

  // Group mappings by offering_id
  const mappingsByOffering = new Map<number, any[]>();
  for (const m of mappingsRes.rows) {
    const oid = Number(m.offering_id);
    if (!mappingsByOffering.has(oid)) mappingsByOffering.set(oid, []);
    mappingsByOffering.get(oid)!.push({
      serviceId: Number(m.service_id),
      serviceFamilyName: m.service_family_name,
      level2: m.level_2,
    });
  }

  // Group specific services by (service_id + level_2) → then match to offerings via mappings
  return offerings.map((o: any) => {
    const oMappings = mappingsByOffering.get(Number(o.id)) ?? [];
    const specificServices: any[] = [];

    for (const mp of oMappings) {
      const services = specificServicesRows.filter(
        (ss: any) => Number(ss.service_id) === mp.serviceId && ss.level_2 === mp.level2
      );
      for (const ss of services) {
        specificServices.push({
          serviceOptionId: Number(ss.id),
          name: ss.level_3,
          description: ss.description || null,
          unit: ss.unit,
          basePrice: Number(ss.base_price),
          inclusions: ss.inclusions ?? [],
          exclusions: ss.exclusions ?? [],
          addons: addonsByParent.get(Number(ss.id)) ?? [],
        });
      }
    }

    return {
      id: Number(o.id),
      catalogKey: o.catalog_key,
      name: o.name,
      shortDescription: o.short_description || null,
      providerDescription: o.provider_description || null,
      iconKey: o.icon_key || null,
      bannerUrl: o.banner_path || null,
      displayOrder: Number(o.display_order),
      isBuiltIn: Boolean(o.is_builtin),
      status: o.status,
      legacyMappings: oMappings,
      specificServices,
    };
  });
};

// ─── Admin — Offering Providers (Compatibility tab) ──────────────────────────

export const getOfferingProviders = async (offeringId: number): Promise<any[]> => {
  const res = await dbQuery.query(
    `SELECT ecc.employee_uid, ecc.status, ecc.approved_at, ecc.created_at,
            uc.first_name, uc.last_name, uc.email
     FROM ${dbSchema}.employee_catalog_capabilities ecc
     LEFT JOIN ${dbSchema}.user_credentials uc ON uc.uid = ecc.employee_uid
     WHERE ecc.offering_id = $1
     ORDER BY ecc.created_at DESC`,
    [offeringId]
  );
  return res.rows.map(toCamel);
};

// ─── Admin — Service Family Lookup ────────────────────────────────────────────

export const listServiceFamilies = async (): Promise<Array<{ id: number; name: string }>> => {
  const res = await dbQuery.query(
    `SELECT id, name FROM ${dbSchema}.services ORDER BY name`,
    []
  );
  return res.rows.map((r: any) => ({ id: Number(r.id), name: r.name as string }));
};

// ─── Admin — Offerings CRUD ───────────────────────────────────────────────────

export const listAdminOfferings = async (): Promise<any[]> => {
  const res = await dbQuery.query(
    `SELECT o.*,
            (SELECT COUNT(*) FROM ${dbSchema}.provider_catalog_offering_mappings m
             WHERE m.offering_id = o.id AND m.is_active = true) AS mapping_count
     FROM ${dbSchema}.provider_catalog_offerings o
     ORDER BY o.display_order, o.name`,
    []
  );
  return res.rows.map((r: any) => {
    const item = toCamel(r);
    item.isMobileProtected = Boolean(r.legacy_provider_mobile_visible);
    return item;
  });
};

export const getAdminOffering = async (offeringId: number): Promise<any | null> => {
  const offerRes = await dbQuery.query(
    `SELECT id, catalog_key, name, short_description, provider_description, icon_key,
            banner_path, display_order, is_builtin, status,
            provider_web_visible, customer_web_visible,
            legacy_provider_mobile_visible AS is_mobile_protected,
            legacy_customer_mobile_visible,
            version, created_at, updated_at
     FROM ${dbSchema}.provider_catalog_offerings WHERE id = $1`,
    [offeringId]
  );
  if (offerRes.rows.length === 0) return null;

  const mappingsRes = await dbQuery.query(
    `SELECT m.id AS mapping_id, m.offering_id, m.service_id, m.level_2, m.display_order, m.is_active,
            s.name AS service_family_name
     FROM ${dbSchema}.provider_catalog_offering_mappings m
     JOIN ${dbSchema}.services s ON s.id = m.service_id
     WHERE m.offering_id = $1
     ORDER BY m.display_order`,
    [offeringId]
  );

  const mappingStatsRes = await dbQuery.query(
    `SELECT m.id AS mapping_id,
            COUNT(so.id)::int  AS specific_service_count,
            MIN(so.base_price) AS min_price,
            MAX(so.base_price) AS max_price
     FROM ${dbSchema}.provider_catalog_offering_mappings m
     LEFT JOIN ${dbSchema}.service_options so
       ON so.service_id = m.service_id
       AND so.level_2 = m.level_2
       AND so.option_type = 'MAIN'
       AND (so.is_active IS NULL OR so.is_active = true)
     WHERE m.offering_id = $1
     GROUP BY m.id`,
    [offeringId]
  );

  const statsMap = new Map<number, { specific_service_count: number; min_price: number | null; max_price: number | null }>();
  for (const r of mappingStatsRes.rows) {
    statsMap.set(Number(r.mapping_id), {
      specific_service_count: Number(r.specific_service_count),
      min_price: r.min_price != null ? Number(r.min_price) : null,
      max_price: r.max_price != null ? Number(r.max_price) : null,
    });
  }

  const offer = toCamel(offerRes.rows[0]);
  return {
    ...offer,
    isMobileProtected: Boolean(offerRes.rows[0].is_mobile_protected),
    legacyCustomerMobileVisible: Boolean(offerRes.rows[0].legacy_customer_mobile_visible),
    mappings: mappingsRes.rows.map((m: any) => {
      const stats = statsMap.get(Number(m.mapping_id));
      return {
        mappingId: Number(m.mapping_id),
        serviceId: Number(m.service_id),
        serviceFamilyName: m.service_family_name,
        level2: m.level_2,
        isActive: Boolean(m.is_active),
        displayOrder: Number(m.display_order),
        specificServiceCount: stats?.specific_service_count ?? 0,
        minPrice: stats?.min_price ?? null,
        maxPrice: stats?.max_price ?? null,
      };
    }),
  };
};

export const createOffering = async (
  data: {
    catalogKey: string;
    name: string;
    shortDescription?: string;
    providerDescription?: string;
    iconKey?: string;
    bannerPath?: string;
    displayOrder?: number;
  },
  adminUid: string
): Promise<any> => {
  if (!data.catalogKey || !data.name) {
    throw new Error('catalogKey and name are required');
  }

  // Reject invalid catalog keys (slug format only)
  if (!/^[a-z0-9-]+$/.test(data.catalogKey)) {
    throw new Error('catalogKey must be lowercase letters, numbers, and hyphens only');
  }

  try {
    const res = await dbQuery.query(
      `INSERT INTO ${dbSchema}.provider_catalog_offerings
        (catalog_key, name, short_description, provider_description, icon_key,
         banner_path, display_order, is_builtin, status, provider_web_visible,
         legacy_provider_mobile_visible, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, false, 'draft', true, false, $8, $8)
       RETURNING *`,
      [
        data.catalogKey,
        data.name,
        data.shortDescription ?? null,
        data.providerDescription ?? null,
        data.iconKey ?? null,
        data.bannerPath ?? null,
        data.displayOrder ?? 99,
        adminUid,
      ]
    );
    const result = toCamel(res.rows[0]);
    result.isMobileProtected = Boolean(res.rows[0].legacy_provider_mobile_visible);
    auditFire({ action: 'catalog_offering.create', actionCategory: 'catalog', outcome: 'success', actorUid: adminUid, actorType: 'admin', entityType: 'catalog_offering', entityId: String(result.id), after: { catalogKey: result.catalogKey, name: result.name } });
    return result;
  } catch (err: any) {
    if (err.code === '23505') {
      // Duplicate catalog_key — look up the existing offering so the frontend can navigate to it
      const existing = await dbQuery.query(
        `SELECT id FROM ${dbSchema}.provider_catalog_offerings WHERE catalog_key = $1`,
        [data.catalogKey]
      );
      const existingOfferingId = existing.rows.length > 0 ? Number(existing.rows[0].id) : null;
      throw Object.assign(
        new Error(`An offering with catalog key "${data.catalogKey}" already exists.`),
        { code: 'CATALOG_KEY_ALREADY_EXISTS', existingOfferingId }
      );
    }
    throw err;
  }
};

export const updateOffering = async (
  offeringId: number,
  data: {
    name?: string;
    shortDescription?: string;
    providerDescription?: string;
    iconKey?: string;
    bannerPath?: string;
    displayOrder?: number;
    providerWebVisible?: boolean;
    customerWebVisible?: boolean;
    legacyProviderMobileVisible?: boolean;
    legacyCustomerMobileVisible?: boolean;
    version: number;
  },
  adminUid: string
): Promise<any> => {
  // Optimistic concurrency check
  const current = await dbQuery.query(
    `SELECT version, is_builtin FROM ${dbSchema}.provider_catalog_offerings WHERE id = $1`,
    [offeringId]
  );
  if (current.rows.length === 0) throw new Error('Offering not found');
  if (Number(current.rows[0].version) !== data.version) {
    throw Object.assign(new Error('Conflict: offering was modified by another request'), { code: 'CONFLICT' });
  }

  const res = await dbQuery.query(
    `UPDATE ${dbSchema}.provider_catalog_offerings SET
       name                           = COALESCE($1, name),
       short_description              = COALESCE($2, short_description),
       provider_description           = COALESCE($3, provider_description),
       icon_key                       = COALESCE($4, icon_key),
       banner_path                    = COALESCE($5, banner_path),
       display_order                  = COALESCE($6, display_order),
       provider_web_visible           = COALESCE($7, provider_web_visible),
       customer_web_visible           = COALESCE($8, customer_web_visible),
       legacy_provider_mobile_visible = COALESCE($11, legacy_provider_mobile_visible),
       legacy_customer_mobile_visible = COALESCE($12, legacy_customer_mobile_visible),
       updated_by                     = $9,
       updated_at                     = NOW(),
       version                        = version + 1
     WHERE id = $10
     RETURNING *`,
    [
      data.name ?? null,
      data.shortDescription ?? null,
      data.providerDescription ?? null,
      data.iconKey ?? null,
      data.bannerPath ?? null,
      data.displayOrder ?? null,
      data.providerWebVisible ?? null,
      data.customerWebVisible ?? null,
      adminUid,
      offeringId,
      data.legacyProviderMobileVisible !== undefined ? data.legacyProviderMobileVisible : null,
      data.legacyCustomerMobileVisible !== undefined ? data.legacyCustomerMobileVisible : null,
    ]
  );
  const result = toCamel(res.rows[0]);
  result.isMobileProtected = Boolean(res.rows[0].legacy_provider_mobile_visible);
  auditFire({ action: 'catalog_offering.update', actionCategory: 'catalog', outcome: 'success', actorUid: adminUid, actorType: 'admin', entityType: 'catalog_offering', entityId: String(offeringId), after: { name: result.name, status: result.status } });
  return result;
};

export const updateOfferingStatus = async (
  offeringId: number,
  newStatus: string,
  adminUid: string
): Promise<any> => {
  const valid = ['draft', 'active', 'archived'];
  if (!valid.includes(newStatus)) throw new Error(`Invalid status: ${newStatus}`);

  const res = await dbQuery.query(
    `UPDATE ${dbSchema}.provider_catalog_offerings SET
       status     = $1,
       archived_at = CASE WHEN $1 = 'archived' THEN NOW() ELSE archived_at END,
       updated_by = $2,
       updated_at = NOW(),
       version    = version + 1
     WHERE id = $3
     RETURNING *`,
    [newStatus, adminUid, offeringId]
  );
  if (res.rows.length === 0) throw new Error('Offering not found');
  const result = toCamel(res.rows[0]);
  auditFire({ action: `catalog_offering.${newStatus}`, actionCategory: 'catalog', outcome: 'success', actorUid: adminUid, actorType: 'admin', entityType: 'catalog_offering', entityId: String(offeringId), after: { status: newStatus } });
  return result;
};

// ─── Admin — Cross-Offering Specific Services List ────────────────────────────

export const listAllSpecificServices = async (params: {
  search?: string;
  offeringId?: number;
  isActive?: string;     // 'true' | 'false' | omitted = all
  sortBy?: string;       // 'name' | 'catalog' | 'price' | 'updatedAt'
  sortOrder?: string;    // 'asc' | 'desc'
  page?: number;
  limit?: number;
}): Promise<{ items: any[]; total: number; page: number; limit: number; totalPages: number }> => {
  const limit  = Math.min(Math.max(Number(params.limit)  || 25, 1), 100);
  const page   = Math.max(Number(params.page)   || 1, 1);
  const offset = (page - 1) * limit;

  const conditions: string[] = [`so.option_type = 'MAIN'`];
  const queryParams: any[]   = [];
  let i = 1;

  if (params.search) {
    conditions.push(`(LOWER(so.level_3) LIKE $${i} OR LOWER(so.level_2) LIKE $${i} OR LOWER(pco.name) LIKE $${i})`);
    queryParams.push(`%${params.search.toLowerCase().trim()}%`);
    i++;
  }

  if (params.offeringId) {
    conditions.push(`pcom.offering_id = $${i}`);
    queryParams.push(Number(params.offeringId));
    i++;
  }

  if (params.isActive === 'true') {
    conditions.push(`COALESCE(so.is_active, true) = true`);
  } else if (params.isActive === 'false') {
    conditions.push(`COALESCE(so.is_active, true) = false`);
  }

  const validSort: Record<string, string> = {
    name:      'so.level_3',
    catalog:   'pco.name',
    price:     'so.base_price',
    updatedAt: 'so.updated_at',
    level2:    'so.level_2',
  };
  const sortField = validSort[params.sortBy ?? ''] ?? 'so.level_3';
  const sortDir   = params.sortOrder === 'desc' ? 'DESC' : 'ASC';

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const sql = `
    SELECT
      so.id          AS service_option_id,
      so.service_id,
      so.level_2,
      so.level_3     AS name,
      so.unit,
      so.base_price,
      COALESCE(so.is_active, true) AS is_active,
      so.updated_at,
      pco.id         AS offering_id,
      pco.name       AS offering_name,
      pco.catalog_key,
      pco.icon_key,
      pco.status     AS offering_status,
      COUNT(*) OVER() AS total_count
    FROM ${dbSchema}.service_options so
    INNER JOIN ${dbSchema}.provider_catalog_offering_mappings pcom
      ON pcom.service_id = so.service_id
     AND pcom.level_2    = so.level_2
     AND pcom.is_active  = true
    INNER JOIN ${dbSchema}.provider_catalog_offerings pco
      ON pco.id = pcom.offering_id
    ${where}
    ORDER BY ${sortField} ${sortDir}, so.level_3 ASC, so.id ASC
    LIMIT $${i} OFFSET $${i + 1}
  `;

  queryParams.push(limit, offset);
  const res = await dbQuery.query(sql, queryParams);

  const total = res.rows.length > 0 ? Number(res.rows[0].total_count) : 0;

  const items = res.rows.map((r: any) => ({
    serviceOptionId: Number(r.service_option_id),
    serviceId:       Number(r.service_id),
    name:            r.name as string,
    level2:          r.level_2 as string,
    unit:            r.unit as string,
    basePrice:       Number(r.base_price),
    isActive:        r.is_active == null ? true : Boolean(r.is_active),
    updatedAt:       r.updated_at ? new Date(r.updated_at).toISOString() : null,
    offering: {
      offeringId:  Number(r.offering_id),
      name:        r.offering_name as string,
      catalogKey:  r.catalog_key  as string,
      iconKey:     r.icon_key     as string | null,
      status:      r.offering_status as string,
    },
  }));

  return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
};

// ─── Admin — Specific Services CRUD ──────────────────────────────────────────

export const listSpecificServicesForOffering = async (offeringId: number): Promise<any[]> => {
  // Resolve which service_id + level_2 values this offering maps to
  const mappingsRes = await dbQuery.query(
    `SELECT service_id, level_2
     FROM ${dbSchema}.provider_catalog_offering_mappings
     WHERE offering_id = $1 AND is_active = true`,
    [offeringId]
  );
  if (mappingsRes.rows.length === 0) return [];

  const sids = mappingsRes.rows.map((m: any) => Number(m.service_id));
  const l2s  = mappingsRes.rows.map((m: any) => m.level_2 as string);

  const res = await dbQuery.query(
    `SELECT so.id, so.service_id, so.level_2, so.level_3, so.unit, so.base_price,
            so.is_active,
            COALESCE(m.description, '') AS description,
            COALESCE(m.inclusions, '[]'::jsonb) AS inclusions,
            COALESCE(m.exclusions, '[]'::jsonb) AS exclusions
     FROM ${dbSchema}.service_options so
     LEFT JOIN ${dbSchema}.service_option_meta m ON m.service_option_id = so.id
     WHERE so.service_id = ANY($1)
       AND so.level_2 = ANY($2)
       AND so.option_type = 'MAIN'
     ORDER BY so.level_2, so.level_3`,
    [sids, l2s]
  );
  if (res.rows.length === 0) return [];

  // Load addons for all specific services in one query
  const mainIds = res.rows.map((r: any) => Number(r.id));
  const addonRes = await dbQuery.query(
    `SELECT id, parent_option_id, level_3, unit, base_price, is_active
     FROM ${dbSchema}.service_options
     WHERE parent_option_id = ANY($1) AND option_type = 'ADD_ON'
     ORDER BY parent_option_id, level_3`,
    [mainIds]
  );

  const addonsByParent = new Map<number, any[]>();
  for (const a of addonRes.rows) {
    const pid = Number(a.parent_option_id);
    if (!addonsByParent.has(pid)) addonsByParent.set(pid, []);
    addonsByParent.get(pid)!.push({
      id: Number(a.id),
      parentOptionId: pid,
      level3: a.level_3,
      unit: a.unit,
      basePrice: Number(a.base_price),
      isActive: a.is_active == null ? true : Boolean(a.is_active),
    });
  }

  return res.rows.map((r: any) => ({
    serviceOptionId: Number(r.id),
    serviceId: Number(r.service_id),
    level2: r.level_2,
    level3: r.level_3,
    unit: r.unit,
    basePrice: Number(r.base_price),
    isActive: r.is_active == null ? true : Boolean(r.is_active),
    description: r.description || null,
    inclusions: Array.isArray(r.inclusions) ? r.inclusions : (r.inclusions ? JSON.parse(r.inclusions) : []),
    exclusions: Array.isArray(r.exclusions) ? r.exclusions : (r.exclusions ? JSON.parse(r.exclusions) : []),
    addons: addonsByParent.get(Number(r.id)) ?? [],
  }));
};

export const createSpecificService = async (
  offeringId: number,
  data: {
    level2: string;
    level3: string;
    description?: string;
    unit: string;
    basePrice: number;
    inclusions?: string[];
    exclusions?: string[];
  },
  adminUid: string
): Promise<any> => {
  if (!data.level2 || !data.level3 || !data.unit) {
    throw new Error('level2, level3, and unit are required');
  }
  if (data.basePrice == null || data.basePrice < 0 || !isFinite(data.basePrice)) {
    throw new Error('basePrice must be a non-negative finite number');
  }

  // Verify offering exists and the requested level_2 is one of its controlled mappings.
  // If not, auto-create the mapping using the offering's builtin service family (or first available).
  const mappingRes = await dbQuery.query(
    `SELECT m.service_id FROM ${dbSchema}.provider_catalog_offering_mappings m
     WHERE m.offering_id = $1 AND m.level_2 = $2 AND m.is_active = true`,
    [offeringId, data.level2]
  );

  let serviceId: number;
  if (mappingRes.rows.length > 0) {
    serviceId = Number(mappingRes.rows[0].service_id);
  } else {
    // Auto-create mapping: resolve service_id from the offering's builtin seed, or fallback
    const offeringRow = await dbQuery.query(
      `SELECT catalog_key FROM ${dbSchema}.provider_catalog_offerings WHERE id = $1`,
      [offeringId]
    );
    if (offeringRow.rows.length === 0) throw new Error('Offering not found');

    const catalogKey = offeringRow.rows[0].catalog_key as string;
    const builtinSeed = BUILTIN_OFFERINGS.find(o => o.catalogKey === catalogKey);
    const familyName  = builtinSeed?.mappings[0]?.serviceFamilyName ?? null;

    let resolvedServiceId: number | null = null;
    if (familyName) {
      const famRes = await dbQuery.query(
        `SELECT id FROM ${dbSchema}.services WHERE LOWER(name) = LOWER($1) LIMIT 1`,
        [familyName]
      );
      if (famRes.rows.length > 0) resolvedServiceId = Number(famRes.rows[0].id);
    }
    if (!resolvedServiceId) {
      const anyRes = await dbQuery.query(
        `SELECT id FROM ${dbSchema}.services ORDER BY id LIMIT 1`, []
      );
      if (anyRes.rows.length > 0) resolvedServiceId = Number(anyRes.rows[0].id);
    }
    if (!resolvedServiceId) throw new Error('No service families exist. Seed the database first.');

    await dbQuery.query(
      `INSERT INTO ${dbSchema}.provider_catalog_offering_mappings
        (offering_id, service_id, level_2, display_order, is_active)
       VALUES ($1, $2, $3, 0, true)
       ON CONFLICT (offering_id, service_id, level_2) DO UPDATE SET is_active = true`,
      [offeringId, resolvedServiceId, data.level2]
    );
    serviceId = resolvedServiceId;
  }

  // Insert service_options row (MAIN)
  const optRes = await dbQuery.query(
    `INSERT INTO ${dbSchema}.service_options
      (service_id, option_type, level_2, level_3, base_price, unit)
     VALUES ($1, 'MAIN', $2, $3, $4, $5)
     RETURNING id`,
    [serviceId, data.level2, data.level3, data.basePrice, data.unit]
  );
  const optionId = Number(optRes.rows[0].id);

  // Insert or update meta
  await dbQuery.query(
    `INSERT INTO ${dbSchema}.service_option_meta
      (service_option_id, description, inclusions, exclusions)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (service_option_id) DO UPDATE SET
       description = EXCLUDED.description,
       inclusions  = EXCLUDED.inclusions,
       exclusions  = EXCLUDED.exclusions`,
    [
      optionId,
      data.description ?? null,
      JSON.stringify(data.inclusions ?? []),
      JSON.stringify(data.exclusions ?? []),
    ]
  );

  auditFire({ action: 'catalog_service_option.create', actionCategory: 'catalog', outcome: 'success', actorUid: adminUid, actorType: 'admin', entityType: 'catalog_service_option', entityId: String(optionId), after: { level2: data.level2, level3: data.level3, basePrice: data.basePrice } });
  return {
    serviceOptionId: optionId,
    serviceId,
    level2: data.level2,
    level3: data.level3,
    description: data.description ?? null,
    unit: data.unit,
    basePrice: data.basePrice,
    inclusions: data.inclusions ?? [],
    exclusions: data.exclusions ?? [],
    addons: [],
  };
};

export const getAdminSpecificService = async (serviceOptionId: number): Promise<any | null> => {
  const res = await dbQuery.query(
    `SELECT so.id, so.service_id, so.level_2, so.level_3, so.unit, so.base_price, so.is_active,
            COALESCE(m.description, '') AS description,
            COALESCE(m.inclusions, '[]'::jsonb) AS inclusions,
            COALESCE(m.exclusions, '[]'::jsonb) AS exclusions
     FROM ${dbSchema}.service_options so
     LEFT JOIN ${dbSchema}.service_option_meta m ON m.service_option_id = so.id
     WHERE so.id = $1 AND so.option_type = 'MAIN'`,
    [serviceOptionId]
  );
  if (res.rows.length === 0) return null;

  const addonRes = await dbQuery.query(
    `SELECT id, parent_option_id, level_3, unit, base_price, is_active
     FROM ${dbSchema}.service_options
     WHERE parent_option_id = $1 AND option_type = 'ADD_ON'
     ORDER BY level_3`,
    [serviceOptionId]
  );

  return {
    ...toCamel(res.rows[0]),
    addons: addonRes.rows.map(toCamel),
  };
};

export const updateSpecificService = async (
  serviceOptionId: number,
  data: {
    level3?: string;
    description?: string;
    unit?: string;
    basePrice?: number;
    inclusions?: string[];
    exclusions?: string[];
  },
  adminUid: string
): Promise<any> => {
  if (data.basePrice !== undefined && (data.basePrice < 0 || !isFinite(data.basePrice))) {
    throw new Error('basePrice must be a non-negative finite number');
  }

  // Verify exists and is MAIN
  const check = await dbQuery.query(
    `SELECT id FROM ${dbSchema}.service_options WHERE id = $1 AND option_type = 'MAIN'`,
    [serviceOptionId]
  );
  if (check.rows.length === 0) throw new Error('Specific service not found');

  // Update service_options — preserve id, service_id, level_2, option_type
  await dbQuery.query(
    `UPDATE ${dbSchema}.service_options SET
       level_3    = COALESCE($1, level_3),
       unit       = COALESCE($2, unit),
       base_price = COALESCE($3, base_price),
       updated_at = NOW()
     WHERE id = $4`,
    [data.level3 ?? null, data.unit ?? null, data.basePrice ?? null, serviceOptionId]
  );

  // Upsert meta
  if (data.description !== undefined || data.inclusions !== undefined || data.exclusions !== undefined) {
    await dbQuery.query(
      `INSERT INTO ${dbSchema}.service_option_meta
        (service_option_id, description, inclusions, exclusions)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (service_option_id) DO UPDATE SET
         description = COALESCE($2, service_option_meta.description),
         inclusions  = COALESCE($3, service_option_meta.inclusions),
         exclusions  = COALESCE($4, service_option_meta.exclusions)`,
      [
        serviceOptionId,
        data.description ?? null,
        data.inclusions ? JSON.stringify(data.inclusions) : null,
        data.exclusions ? JSON.stringify(data.exclusions) : null,
      ]
    );
  }

  auditFire({ action: 'catalog_service_option.update', actionCategory: 'catalog', outcome: 'success', actorUid: adminUid, actorType: 'admin', entityType: 'catalog_service_option', entityId: String(serviceOptionId), after: data as Record<string, unknown> });
  return getAdminSpecificService(serviceOptionId);
};

export const updateSpecificServiceStatus = async (
  serviceOptionId: number,
  isActive: boolean,
  adminUid: string = 'system'
): Promise<any> => {
  const res = await dbQuery.query(
    `UPDATE ${dbSchema}.service_options SET is_active = $1, updated_at = NOW() WHERE id = $2 AND option_type = 'MAIN' RETURNING id`,
    [isActive, serviceOptionId]
  );
  if (res.rows.length === 0) throw new Error('Specific service not found');
  auditFire({ action: `catalog_service_option.${isActive ? 'activate' : 'deactivate'}`, actionCategory: 'catalog', outcome: 'success', actorUid: adminUid, actorType: 'admin', entityType: 'catalog_service_option', entityId: String(serviceOptionId), after: { isActive } });
  return { serviceOptionId, isActive };
};

// ─── Admin — Add-ons CRUD ─────────────────────────────────────────────────────

export const createAddon = async (
  parentOptionId: number,
  data: { level3: string; unit: string; basePrice: number },
  adminUid: string
): Promise<any> => {
  if (!data.level3 || !data.unit) throw new Error('level3 and unit are required');
  if (data.basePrice == null || data.basePrice < 0 || !isFinite(data.basePrice)) {
    throw new Error('basePrice must be a non-negative finite number');
  }

  const parent = await dbQuery.query(
    `SELECT service_id, level_2 FROM ${dbSchema}.service_options WHERE id = $1 AND option_type = 'MAIN'`,
    [parentOptionId]
  );
  if (parent.rows.length === 0) throw new Error('Parent specific service not found');

  const res = await dbQuery.query(
    `INSERT INTO ${dbSchema}.service_options
      (service_id, option_type, level_2, level_3, base_price, unit, parent_option_id)
     VALUES ($1, 'ADD_ON', $2, $3, $4, $5, $6)
     RETURNING id, level_3, unit, base_price, is_active`,
    [parent.rows[0].service_id, parent.rows[0].level_2, data.level3, data.basePrice, data.unit, parentOptionId]
  );

  const addon = { ...toCamel(res.rows[0]), parentOptionId };
  auditFire({ action: 'catalog_addon.create', actionCategory: 'catalog', outcome: 'success', actorUid: adminUid, actorType: 'admin', entityType: 'catalog_addon', entityId: String(addon.id), after: { level3: data.level3, basePrice: data.basePrice, parentOptionId } });
  return addon;
};

export const updateAddon = async (
  addonOptionId: number,
  data: { level3?: string; unit?: string; basePrice?: number },
  adminUid: string
): Promise<any> => {
  if (data.basePrice !== undefined && (data.basePrice < 0 || !isFinite(data.basePrice))) {
    throw new Error('basePrice must be a non-negative finite number');
  }

  const res = await dbQuery.query(
    `UPDATE ${dbSchema}.service_options SET
       level_3    = COALESCE($1, level_3),
       unit       = COALESCE($2, unit),
       base_price = COALESCE($3, base_price)
     WHERE id = $4 AND option_type = 'ADD_ON'
     RETURNING id, level_3, unit, base_price, is_active, parent_option_id`,
    [data.level3 ?? null, data.unit ?? null, data.basePrice ?? null, addonOptionId]
  );
  if (res.rows.length === 0) throw new Error('Add-on not found');
  const updated = toCamel(res.rows[0]);
  auditFire({ action: 'catalog_addon.update', actionCategory: 'catalog', outcome: 'success', actorUid: adminUid, actorType: 'admin', entityType: 'catalog_addon', entityId: String(addonOptionId), after: data as Record<string, unknown> });
  return updated;
};

export const updateAddonStatus = async (
  addonOptionId: number,
  isActive: boolean,
  adminUid: string = 'system'
): Promise<any> => {
  const res = await dbQuery.query(
    `UPDATE ${dbSchema}.service_options SET is_active = $1 WHERE id = $2 AND option_type = 'ADD_ON' RETURNING id`,
    [isActive, addonOptionId]
  );
  if (res.rows.length === 0) throw new Error('Add-on not found');
  auditFire({ action: `catalog_addon.${isActive ? 'activate' : 'deactivate'}`, actionCategory: 'catalog', outcome: 'success', actorUid: adminUid, actorType: 'admin', entityType: 'catalog_addon', entityId: String(addonOptionId), after: { isActive } });
  return { addonOptionId, isActive };
};

// ─── Admin — Catalog Overview (enhanced listing with mappings) ────────────────

export const getCatalogOverview = async (filter: {
  search?: string;
  status?: string;
  mobileProtected?: boolean;
} = {}): Promise<any[]> => {
  const conditions: string[] = [];
  const params: any[] = [];

  if (filter.search) {
    params.push(`%${filter.search}%`);
    conditions.push(`(o.name ILIKE $${params.length} OR o.catalog_key ILIKE $${params.length})`);
  }
  if (filter.status) {
    params.push(filter.status);
    conditions.push(`o.status = $${params.length}`);
  }
  if (filter.mobileProtected !== undefined) {
    params.push(filter.mobileProtected);
    conditions.push(`o.legacy_provider_mobile_visible = $${params.length}`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const offeringsRes = await dbQuery.query(
    `SELECT o.id, o.catalog_key, o.name, o.status, o.is_builtin,
            o.legacy_provider_mobile_visible AS is_mobile_protected,
            o.icon_key, o.provider_web_visible AS provider_visible,
            o.customer_web_visible AS customer_visible,
            o.display_order, o.updated_at AS last_updated_at, o.version
     FROM ${dbSchema}.provider_catalog_offerings o
     ${where}
     ORDER BY o.display_order, o.name`,
    params
  );

  if (offeringsRes.rows.length === 0) return [];

  const ids: number[] = offeringsRes.rows.map((o: any) => Number(o.id));

  const mappingsRes = await dbQuery.query(
    `SELECT m.id, m.offering_id, m.service_id, m.level_2, m.display_order, m.is_active,
            s.name AS service_family_name
     FROM ${dbSchema}.provider_catalog_offering_mappings m
     JOIN ${dbSchema}.services s ON s.id = m.service_id
     WHERE m.offering_id = ANY($1)
     ORDER BY m.offering_id, m.display_order`,
    [ids]
  );

  // Count specific services per offering (via active mappings)
  const ssCountRes = await dbQuery.query(
    `SELECT m.offering_id, COUNT(DISTINCT so.id) AS specific_service_count
     FROM ${dbSchema}.provider_catalog_offering_mappings m
     JOIN ${dbSchema}.service_options so
       ON so.service_id = m.service_id AND so.level_2 = m.level_2
       AND so.option_type = 'MAIN' AND (so.is_active IS NULL OR so.is_active = true)
     WHERE m.offering_id = ANY($1) AND m.is_active = true
     GROUP BY m.offering_id`,
    [ids]
  );

  // Per-mapping specific-service count and price range
  const mappingStatsRes = await dbQuery.query(
    `SELECT m.id AS mapping_id,
            COUNT(so.id)::int  AS specific_service_count,
            MIN(so.base_price) AS min_price,
            MAX(so.base_price) AS max_price
     FROM ${dbSchema}.provider_catalog_offering_mappings m
     LEFT JOIN ${dbSchema}.service_options so
       ON so.service_id = m.service_id
       AND so.level_2 = m.level_2
       AND so.option_type = 'MAIN'
       AND (so.is_active IS NULL OR so.is_active = true)
     WHERE m.offering_id = ANY($1)
     GROUP BY m.id`,
    [ids]
  );

  const mappingStatsMap = new Map<number, { specific_service_count: number; min_price: number | null; max_price: number | null }>();
  for (const r of mappingStatsRes.rows) {
    mappingStatsMap.set(Number(r.mapping_id), {
      specific_service_count: Number(r.specific_service_count),
      min_price: r.min_price != null ? Number(r.min_price) : null,
      max_price: r.max_price != null ? Number(r.max_price) : null,
    });
  }

  const mappingsByOffering = new Map<number, any[]>();
  for (const m of mappingsRes.rows) {
    const oid = Number(m.offering_id);
    if (!mappingsByOffering.has(oid)) mappingsByOffering.set(oid, []);
    const stats = mappingStatsMap.get(Number(m.id));
    mappingsByOffering.get(oid)!.push({
      mappingId: Number(m.id),
      serviceId: Number(m.service_id),
      serviceFamilyName: m.service_family_name,
      level2: m.level_2,
      isActive: Boolean(m.is_active),
      displayOrder: Number(m.display_order),
      specificServiceCount: stats?.specific_service_count ?? 0,
      minPrice: stats?.min_price ?? null,
      maxPrice: stats?.max_price ?? null,
    });
  }

  const ssCountByOffering = new Map<number, number>();
  for (const r of ssCountRes.rows) {
    ssCountByOffering.set(Number(r.offering_id), Number(r.specific_service_count));
  }

  return offeringsRes.rows.map((o: any) => {
    const mappings = mappingsByOffering.get(Number(o.id)) ?? [];
    return {
      offeringId: Number(o.id),
      catalogKey: o.catalog_key,
      name: o.name,
      status: o.status,
      isBuiltin: Boolean(o.is_builtin),
      isMobileProtected: Boolean(o.is_mobile_protected),
      iconKey: o.icon_key || null,
      providerVisible: Boolean(o.provider_visible),
      customerVisible: Boolean(o.customer_visible),
      displayOrder: Number(o.display_order),
      lastUpdatedAt: o.last_updated_at ? new Date(o.last_updated_at).toISOString() : null,
      version: Number(o.version),
      activeMappingCount: mappings.filter((m: any) => m.isActive).length,
      totalSpecificServices: ssCountByOffering.get(Number(o.id)) ?? 0,
      mappings,
    };
  });
};

// ─── Admin — Offering Mappings CRUD ──────────────────────────────────────────

export const createOfferingMapping = async (
  offeringId: number,
  data: { serviceId: number; level2: string; displayOrder?: number },
  adminUid: string
): Promise<any> => {
  if (!data.serviceId || !data.level2) throw new Error('serviceId and level2 are required');

  const offering = await dbQuery.query(
    `SELECT id, is_builtin FROM ${dbSchema}.provider_catalog_offerings WHERE id = $1`,
    [offeringId]
  );
  if (offering.rows.length === 0) throw new Error('Offering not found');

  const svc = await dbQuery.query(
    `SELECT id, name FROM ${dbSchema}.services WHERE id = $1`,
    [data.serviceId]
  );
  if (svc.rows.length === 0) throw new Error('Service not found');

  const res = await dbQuery.query(
    `INSERT INTO ${dbSchema}.provider_catalog_offering_mappings
      (offering_id, service_id, level_2, display_order, is_active)
     VALUES ($1, $2, $3, $4, true)
     ON CONFLICT (offering_id, service_id, level_2)
       DO UPDATE SET is_active = true, display_order = EXCLUDED.display_order,
                     updated_at = NOW()
     RETURNING *`,
    [offeringId, data.serviceId, data.level2, data.displayOrder ?? 0]
  );

  const row = res.rows[0];
  const mapping = {
    mappingId: Number(row.id),
    offeringId: Number(row.offering_id),
    serviceId: Number(row.service_id),
    serviceFamilyName: svc.rows[0].name,
    level2: row.level_2,
    isActive: Boolean(row.is_active),
    displayOrder: Number(row.display_order),
  };
  auditFire({ action: 'catalog_mapping.create', actionCategory: 'catalog', outcome: 'success', actorUid: adminUid, actorType: 'admin', entityType: 'catalog_mapping', entityId: String(mapping.mappingId), after: { level2: mapping.level2, serviceId: mapping.serviceId, offeringId } });
  return mapping;
};

export const updateOfferingMapping = async (
  mappingId: number,
  data: { displayOrder?: number; isActive?: boolean },
  adminUid: string
): Promise<any> => {
  const res = await dbQuery.query(
    `UPDATE ${dbSchema}.provider_catalog_offering_mappings SET
       display_order = COALESCE($1, display_order),
       is_active     = COALESCE($2, is_active),
       updated_at    = NOW()
     WHERE id = $3
     RETURNING *, (SELECT name FROM ${dbSchema}.services s WHERE s.id = service_id) AS service_family_name`,
    [data.displayOrder ?? null, data.isActive ?? null, mappingId]
  );
  if (res.rows.length === 0) throw new Error('Mapping not found');
  const row = res.rows[0];
  const updated = {
    mappingId: Number(row.id),
    offeringId: Number(row.offering_id),
    serviceId: Number(row.service_id),
    serviceFamilyName: row.service_family_name,
    level2: row.level_2,
    isActive: Boolean(row.is_active),
    displayOrder: Number(row.display_order),
  };
  auditFire({ action: 'catalog_mapping.update', actionCategory: 'catalog', outcome: 'success', actorUid: adminUid, actorType: 'admin', entityType: 'catalog_mapping', entityId: String(mappingId), after: data as Record<string, unknown> });
  return updated;
};

export const archiveOfferingMapping = async (
  mappingId: number,
  adminUid: string
): Promise<any> => {
  const res = await dbQuery.query(
    `UPDATE ${dbSchema}.provider_catalog_offering_mappings SET
       is_active = false, updated_at = NOW()
     WHERE id = $1
     RETURNING id`,
    [mappingId]
  );
  if (res.rows.length === 0) throw new Error('Mapping not found');
  auditFire({ action: 'catalog_mapping.archive', actionCategory: 'catalog', outcome: 'success', actorUid: adminUid, actorType: 'admin', entityType: 'catalog_mapping', entityId: String(mappingId), after: { archived: true } });
  return { mappingId, archived: true };
};

// ─── Admin — Publish Preview + Publish ───────────────────────────────────────

export const getPublishPreview = async (offeringId: number): Promise<{
  canPublish: boolean;
  blockers: string[];
  warnings: string[];
}> => {
  const offering = await dbQuery.query(
    `SELECT id, name, status, is_builtin FROM ${dbSchema}.provider_catalog_offerings WHERE id = $1`,
    [offeringId]
  );
  if (offering.rows.length === 0) throw new Error('Offering not found');

  const o = offering.rows[0];
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (o.status === 'archived') {
    blockers.push('Archived offerings cannot be published. Restore the offering first.');
  }

  // Check active mappings
  const mappings = await dbQuery.query(
    `SELECT m.id, m.service_id, m.level_2,
            COUNT(so.id) AS ss_count
     FROM ${dbSchema}.provider_catalog_offering_mappings m
     LEFT JOIN ${dbSchema}.service_options so
       ON so.service_id = m.service_id AND so.level_2 = m.level_2
       AND so.option_type = 'MAIN' AND (so.is_active IS NULL OR so.is_active = true)
     WHERE m.offering_id = $1 AND m.is_active = true
     GROUP BY m.id, m.service_id, m.level_2`,
    [offeringId]
  );

  if (mappings.rows.length === 0) {
    blockers.push('At least one active service mapping is required before publishing.');
  } else {
    for (const m of mappings.rows) {
      if (Number(m.ss_count) === 0) {
        warnings.push(`Mapping "${m.level_2}" has no active specific services — it will appear empty to providers.`);
      }
    }
  }

  return {
    canPublish: blockers.length === 0,
    blockers,
    warnings,
  };
};

export const publishOffering = async (
  offeringId: number,
  adminUid: string
): Promise<any> => {
  const preview = await getPublishPreview(offeringId);
  if (!preview.canPublish) {
    throw Object.assign(
      new Error(`Cannot publish: ${preview.blockers[0]}`),
      { code: 'VALIDATION', blockers: preview.blockers }
    );
  }
  return updateOfferingStatus(offeringId, 'active', adminUid);
};

// ─── Admin — Catalog Audit Trail ─────────────────────────────────────────────

export const getCatalogAuditTrail = async (filter: {
  entityType?: string;
  entityId?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<any[]> => {
  const conditions: string[] = [`ae.entity_type IN ('catalog_offering', 'catalog_mapping', 'catalog_service_option', 'catalog_addon')`];
  const params: any[] = [];

  if (filter.entityType) {
    params.push(filter.entityType);
    conditions.push(`ae.entity_type = $${params.length}`);
  }
  if (filter.entityId) {
    params.push(filter.entityId);
    conditions.push(`ae.entity_id = $${params.length}`);
  }

  const limit = Math.min(filter.limit ?? 50, 200);
  const offset = filter.offset ?? 0;
  params.push(limit, offset);

  const res = await dbQuery.query(
    `SELECT ae.id, ae.actor_uid, ae.action, ae.entity_type, ae.entity_id,
            ae.before_json, ae.after_json, ae.reason, ae.request_id, ae.created_at
     FROM ${dbSchema}.admin_audit_events ae
     WHERE ${conditions.join(' AND ')}
     ORDER BY ae.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  ).catch(() => ({ rows: [] as any[] }));

  return res.rows.map((r: any) => ({
    id: Number(r.id),
    actorUid: r.actor_uid || null,
    action: r.action,
    entityType: r.entity_type,
    entityId: r.entity_id || null,
    beforeJson: r.before_json || null,
    afterJson: r.after_json || null,
    reason: r.reason || null,
    requestId: r.request_id || null,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
  }));
};
