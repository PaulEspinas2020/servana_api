import { db } from "../config";
import dbQuery from "../db/dbQuery";
import { toCamel } from "../helpers/idGenerator";
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

  // 7. is_mobile_protected flag on offerings — marks level_2 values that ServanaWorker/ServanaClient
  //    hard-code (cannot be renamed, deleted, or archived while live mobile bookings reference them).
  await dbQuery.query(`
    ALTER TABLE ${dbSchema}.provider_catalog_offerings
    ADD COLUMN IF NOT EXISTS is_mobile_protected BOOLEAN NOT NULL DEFAULT false
  `, []);

  // 8. Catalog audit events — append-only log; fire-and-forget writes.
  await dbQuery.query(`
    CREATE TABLE IF NOT EXISTS ${dbSchema}.catalog_audit_events (
      id          SERIAL PRIMARY KEY,
      actor_uid   TEXT,
      action      VARCHAR(100) NOT NULL,
      entity_type VARCHAR(50)  NOT NULL,
      entity_id   TEXT,
      before_json JSONB,
      after_json  JSONB,
      reason      TEXT,
      request_id  TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
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
    shortDescription: "Women's hair styling and treatment services.",
    providerDescription: "Women's hair styling, treatment, and care services delivered at home.",
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
    shortDescription: 'Facial care and skin treatments including facials and waxing.',
    providerDescription: 'Facial care and skin treatments including basic facials, threading, and waxing.',
    iconKey: 'bi-palette',
    displayOrder: 7,
    // MOBILE-PROTECTED: level_2 'Facial' is exact match in ServanaClient BeautyWellnessScreen
    mappings: [
      { serviceFamilyName: 'Beauty & Wellness', level2: 'Facial', displayOrder: 1 },
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
      // Backfill is_mobile_protected for builtins inserted before column was added
      await dbQuery.query(
        `UPDATE ${dbSchema}.provider_catalog_offerings SET is_mobile_protected = true WHERE id = $1 AND is_mobile_protected = false`,
        [offeringId]
      );
    } else {
      const ins = await dbQuery.query(
        `INSERT INTO ${dbSchema}.provider_catalog_offerings
          (catalog_key, name, short_description, provider_description, icon_key,
           display_order, is_builtin, status, provider_web_visible, is_mobile_protected)
         VALUES ($1, $2, $3, $4, $5, $6, true, 'active', true, true)
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
  return res.rows.map(toCamel);
};

export const getAdminOffering = async (offeringId: number): Promise<any | null> => {
  const offerRes = await dbQuery.query(
    `SELECT * FROM ${dbSchema}.provider_catalog_offerings WHERE id = $1`,
    [offeringId]
  );
  if (offerRes.rows.length === 0) return null;

  const mappingsRes = await dbQuery.query(
    `SELECT m.*, s.name AS service_family_name
     FROM ${dbSchema}.provider_catalog_offering_mappings m
     JOIN ${dbSchema}.services s ON s.id = m.service_id
     WHERE m.offering_id = $1
     ORDER BY m.display_order`,
    [offeringId]
  );

  return {
    ...toCamel(offerRes.rows[0]),
    mappings: mappingsRes.rows.map(toCamel),
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

  const res = await dbQuery.query(
    `INSERT INTO ${dbSchema}.provider_catalog_offerings
      (catalog_key, name, short_description, provider_description, icon_key,
       banner_path, display_order, is_builtin, status, provider_web_visible, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, false, 'draft', true, $8, $8)
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
  return toCamel(res.rows[0]);
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
       name                 = COALESCE($1, name),
       short_description    = COALESCE($2, short_description),
       provider_description = COALESCE($3, provider_description),
       icon_key             = COALESCE($4, icon_key),
       banner_path          = COALESCE($5, banner_path),
       display_order        = COALESCE($6, display_order),
       provider_web_visible = COALESCE($7, provider_web_visible),
       customer_web_visible = COALESCE($8, customer_web_visible),
       updated_by           = $9,
       updated_at           = NOW(),
       version              = version + 1
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
    ]
  );
  return toCamel(res.rows[0]);
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
  return toCamel(res.rows[0]);
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
  return res.rows.map(toCamel);
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

  // Verify offering exists and the requested level_2 is one of its controlled mappings
  const mappingRes = await dbQuery.query(
    `SELECT m.service_id FROM ${dbSchema}.provider_catalog_offering_mappings m
     WHERE m.offering_id = $1 AND m.level_2 = $2 AND m.is_active = true`,
    [offeringId, data.level2]
  );
  if (mappingRes.rows.length === 0) {
    throw new Error(`level_2 '${data.level2}' is not a valid Option Group for this offering`);
  }
  const serviceId = Number(mappingRes.rows[0].service_id);

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
    `SELECT id, level_3, unit, base_price, is_active
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
       base_price = COALESCE($3, base_price)
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

  return getAdminSpecificService(serviceOptionId);
};

export const updateSpecificServiceStatus = async (
  serviceOptionId: number,
  isActive: boolean
): Promise<any> => {
  const res = await dbQuery.query(
    `UPDATE ${dbSchema}.service_options SET is_active = $1 WHERE id = $2 AND option_type = 'MAIN' RETURNING id`,
    [isActive, serviceOptionId]
  );
  if (res.rows.length === 0) throw new Error('Specific service not found');
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

  return { ...toCamel(res.rows[0]), parentOptionId };
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
  return toCamel(res.rows[0]);
};

export const updateAddonStatus = async (
  addonOptionId: number,
  isActive: boolean
): Promise<any> => {
  const res = await dbQuery.query(
    `UPDATE ${dbSchema}.service_options SET is_active = $1 WHERE id = $2 AND option_type = 'ADD_ON' RETURNING id`,
    [isActive, addonOptionId]
  );
  if (res.rows.length === 0) throw new Error('Add-on not found');
  return { addonOptionId, isActive };
};

// ─── Audit helpers ────────────────────────────────────────────────────────────

interface AuditEvent {
  actorUid?: string;
  action: string;
  entityType: string;
  entityId?: string;
  beforeJson?: any;
  afterJson?: any;
  reason?: string;
  requestId?: string;
}

const logAudit = (event: AuditEvent): void => {
  // Fire-and-forget — never blocks a mutation, never throws
  dbQuery.query(
    `INSERT INTO ${dbSchema}.catalog_audit_events
      (actor_uid, action, entity_type, entity_id, before_json, after_json, reason, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      event.actorUid ?? null,
      event.action,
      event.entityType,
      event.entityId ?? null,
      event.beforeJson ? JSON.stringify(event.beforeJson) : null,
      event.afterJson  ? JSON.stringify(event.afterJson)  : null,
      event.reason     ?? null,
      event.requestId  ?? null,
    ]
  ).catch(() => {});
};

// ─── Admin — Catalog Overview (consolidated read model) ───────────────────────

export const getAdminCatalogOverview = async (filter: {
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
    conditions.push(`COALESCE(o.is_mobile_protected, false) = $${params.length}`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const res = await dbQuery.query(
    `SELECT o.id, o.catalog_key, o.name, o.status, o.is_builtin,
            COALESCE(o.is_mobile_protected, false) AS is_mobile_protected,
            o.provider_web_visible, o.legacy_customer_mobile_visible,
            o.display_order, o.updated_at, o.version, o.icon_key
     FROM ${dbSchema}.provider_catalog_offerings o
     ${where}
     ORDER BY o.display_order, o.name`,
    params
  );
  if (res.rows.length === 0) return [];

  const offeringIds = res.rows.map((r: any) => Number(r.id));

  const mappingsRes = await dbQuery.query(
    `SELECT m.id, m.offering_id, m.service_id, m.level_2, m.is_active, m.display_order,
            s.name AS service_family_name,
            (SELECT COUNT(*) FROM ${dbSchema}.service_options so
             WHERE so.service_id = m.service_id AND so.level_2 = m.level_2
               AND so.option_type = 'MAIN' AND (so.is_active IS NULL OR so.is_active = true)
            ) AS specific_service_count,
            (SELECT COALESCE(MIN(so2.base_price), 0) FROM ${dbSchema}.service_options so2
             WHERE so2.service_id = m.service_id AND so2.level_2 = m.level_2
               AND so2.option_type = 'MAIN' AND (so2.is_active IS NULL OR so2.is_active = true)
            ) AS min_price,
            (SELECT COALESCE(MAX(so2.base_price), 0) FROM ${dbSchema}.service_options so2
             WHERE so2.service_id = m.service_id AND so2.level_2 = m.level_2
               AND so2.option_type = 'MAIN' AND (so2.is_active IS NULL OR so2.is_active = true)
            ) AS max_price
     FROM ${dbSchema}.provider_catalog_offering_mappings m
     JOIN ${dbSchema}.services s ON s.id = m.service_id
     WHERE m.offering_id = ANY($1)
     ORDER BY m.offering_id, m.display_order`,
    [offeringIds]
  );

  const mappingsByOffering = new Map<number, any[]>();
  for (const m of mappingsRes.rows) {
    const oid = Number(m.offering_id);
    if (!mappingsByOffering.has(oid)) mappingsByOffering.set(oid, []);
    mappingsByOffering.get(oid)!.push({
      mappingId: Number(m.id),
      serviceId: Number(m.service_id),
      serviceFamilyName: m.service_family_name,
      level2: m.level_2,
      isActive: Boolean(m.is_active),
      displayOrder: Number(m.display_order),
      specificServiceCount: Number(m.specific_service_count),
      minPrice: Number(m.min_price) || null,
      maxPrice: Number(m.max_price) || null,
    });
  }

  return res.rows.map((o: any) => {
    const mappings = mappingsByOffering.get(Number(o.id)) ?? [];
    const activeMappings = mappings.filter((m: any) => m.isActive);
    const totalSpecificServices = activeMappings.reduce((sum: number, m: any) => sum + m.specificServiceCount, 0);
    return {
      offeringId: Number(o.id),
      catalogKey: o.catalog_key,
      name: o.name,
      status: o.status,
      isBuiltin: Boolean(o.is_builtin),
      isMobileProtected: Boolean(o.is_mobile_protected),
      iconKey: o.icon_key ?? null,
      providerVisible: Boolean(o.provider_web_visible),
      customerVisible: Boolean(o.legacy_customer_mobile_visible),
      displayOrder: Number(o.display_order),
      lastUpdatedAt: o.updated_at,
      version: Number(o.version),
      activeMappingCount: activeMappings.length,
      totalSpecificServices,
      mappings,
    };
  });
};

// ─── Admin — Mappings CRUD ────────────────────────────────────────────────────

export const createMapping = async (
  offeringId: number,
  data: { serviceId: number; level2: string; displayOrder?: number },
  adminUid: string
): Promise<any> => {
  const offeringCheck = await dbQuery.query(
    `SELECT id, status FROM ${dbSchema}.provider_catalog_offerings WHERE id = $1`,
    [offeringId]
  );
  if (offeringCheck.rows.length === 0) throw new Error('Offering not found');
  if (offeringCheck.rows[0].status === 'archived') throw new Error('Cannot add mapping to an archived offering');

  const svcCheck = await dbQuery.query(
    `SELECT id, name FROM ${dbSchema}.services WHERE id = $1`,
    [data.serviceId]
  );
  if (svcCheck.rows.length === 0) throw new Error('Service family not found');

  const existing = await dbQuery.query(
    `SELECT id, is_active FROM ${dbSchema}.provider_catalog_offering_mappings
     WHERE offering_id = $1 AND service_id = $2 AND level_2 = $3`,
    [offeringId, data.serviceId, data.level2]
  );

  if (existing.rows.length > 0) {
    if (Boolean(existing.rows[0].is_active)) {
      throw new Error(`Mapping for "${data.level2}" already exists and is active`);
    }
    // Reactivate archived mapping
    const res = await dbQuery.query(
      `UPDATE ${dbSchema}.provider_catalog_offering_mappings
       SET is_active = true, display_order = $1, updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [data.displayOrder ?? 99, existing.rows[0].id]
    );
    logAudit({ actorUid: adminUid, action: 'reactivate_mapping', entityType: 'mapping', entityId: String(existing.rows[0].id), afterJson: { isActive: true } });
    return { ...toCamel(res.rows[0]), serviceFamilyName: svcCheck.rows[0].name };
  }

  const res = await dbQuery.query(
    `INSERT INTO ${dbSchema}.provider_catalog_offering_mappings
      (offering_id, service_id, level_2, display_order, is_active)
     VALUES ($1, $2, $3, $4, true)
     RETURNING *`,
    [offeringId, data.serviceId, data.level2, data.displayOrder ?? 99]
  );
  logAudit({ actorUid: adminUid, action: 'create_mapping', entityType: 'mapping', entityId: String(res.rows[0].id), afterJson: { offeringId, serviceId: data.serviceId, level2: data.level2 } });
  return { ...toCamel(res.rows[0]), serviceFamilyName: svcCheck.rows[0].name };
};

export const updateMapping = async (
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
     RETURNING *`,
    [data.displayOrder ?? null, data.isActive ?? null, mappingId]
  );
  if (res.rows.length === 0) throw new Error('Mapping not found');
  logAudit({ actorUid: adminUid, action: 'update_mapping', entityType: 'mapping', entityId: String(mappingId), afterJson: data });
  return toCamel(res.rows[0]);
};

export const archiveMapping = async (mappingId: number, adminUid: string): Promise<any> => {
  const mapping = await dbQuery.query(
    `SELECT m.offering_id, o.status FROM ${dbSchema}.provider_catalog_offering_mappings m
     JOIN ${dbSchema}.provider_catalog_offerings o ON o.id = m.offering_id
     WHERE m.id = $1`,
    [mappingId]
  );
  if (mapping.rows.length === 0) throw new Error('Mapping not found');

  const { offering_id, status } = mapping.rows[0];
  if (status === 'active') {
    const remaining = await dbQuery.query(
      `SELECT COUNT(*) AS cnt FROM ${dbSchema}.provider_catalog_offering_mappings
       WHERE offering_id = $1 AND is_active = true AND id != $2`,
      [offering_id, mappingId]
    );
    if (Number(remaining.rows[0].cnt) === 0) {
      throw new Error('Cannot archive the last active mapping on a published offering');
    }
  }

  const res = await dbQuery.query(
    `UPDATE ${dbSchema}.provider_catalog_offering_mappings
     SET is_active = false, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [mappingId]
  );
  logAudit({ actorUid: adminUid, action: 'archive_mapping', entityType: 'mapping', entityId: String(mappingId), afterJson: { isActive: false } });
  return toCamel(res.rows[0]);
};

// ─── Admin — Publish Preview & Publish ────────────────────────────────────────

export const runPublishPreview = async (offeringId: number): Promise<{
  canPublish: boolean;
  blockers: string[];
  warnings: string[];
}> => {
  const offering = await getAdminOffering(offeringId);
  if (!offering) return { canPublish: false, blockers: ['Offering not found'], warnings: [] };

  const blockers: string[] = [];
  const warnings: string[] = [];

  if (offering.status === 'archived') {
    blockers.push('Offering is archived and cannot be published');
  }

  const activeMappings = (offering.mappings ?? []).filter((m: any) => Boolean(m.isActive));
  if (activeMappings.length === 0) {
    blockers.push('Offering has no active option-group mappings — add at least one mapping first');
  }

  for (const m of activeMappings) {
    const ssRes = await dbQuery.query(
      `SELECT COUNT(*) AS cnt FROM ${dbSchema}.service_options
       WHERE service_id = $1 AND level_2 = $2 AND option_type = 'MAIN'
         AND (is_active IS NULL OR is_active = true) AND base_price > 0`,
      [m.serviceId, m.level2]
    );
    if (Number(ssRes.rows[0]?.cnt ?? 0) === 0) {
      blockers.push(`Mapping "${m.level2}" has no active specific services with a price — add specific services first`);
    }
  }

  if (!offering.providerWebVisible) {
    warnings.push('Offering will not be visible to providers on the web portal (providerWebVisible is false)');
  }

  return { canPublish: blockers.length === 0, blockers, warnings };
};

export const publishOffering = async (offeringId: number, adminUid: string): Promise<any> => {
  const preview = await runPublishPreview(offeringId);
  if (!preview.canPublish) {
    const err: any = new Error(`Cannot publish: ${preview.blockers.join('; ')}`);
    err.code = 'PUBLISH_BLOCKED';
    err.blockers = preview.blockers;
    throw err;
  }
  const result = await updateOfferingStatus(offeringId, 'active', adminUid);
  logAudit({ actorUid: adminUid, action: 'publish', entityType: 'offering', entityId: String(offeringId), afterJson: { status: 'active' } });
  return result;
};

// ─── Admin — Audit Trail ─────────────────────────────────────────────────────

export const getAuditTrail = async (filter: {
  entityType?: string;
  entityId?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<any[]> => {
  const conditions: string[] = [];
  const params: any[] = [];

  if (filter.entityType) {
    params.push(filter.entityType);
    conditions.push(`entity_type = $${params.length}`);
  }
  if (filter.entityId) {
    params.push(filter.entityId);
    conditions.push(`entity_id = $${params.length}`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(Math.min(filter.limit ?? 50, 200));
  const limitIdx = params.length;
  params.push(filter.offset ?? 0);
  const offsetIdx = params.length;

  const res = await dbQuery.query(
    `SELECT * FROM ${dbSchema}.catalog_audit_events
     ${where}
     ORDER BY created_at DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params
  );
  return res.rows.map(toCamel);
};
