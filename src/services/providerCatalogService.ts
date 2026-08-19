import { db } from "../config";
import dbQuery, { pool } from "../db/dbQuery";
import { toCamel } from "../helpers/idGenerator";
import { auditFire } from "./adminAuditService";
import { evaluateApplicationEligibility } from "./serviceApplicationService";
const dbSchema = db.schema;

// -- Schema (TAB 02) ----------------------------------------------------------
//
// `initProviderCatalogSchema` created `provider_catalog_offerings`,
// `provider_catalog_offering_mappings` and `employee_catalog_capabilities`, and
// added columns to `service_options`, `service_option_meta` and
// `user_credentials`. All of it comes from `scripts/baseline/000-baseline.sql`.
//
// No split was needed here: the seeding was ALREADY a separate export
// (`seedBuiltInOfferings`), so the DDL half could go on its own. That is the
// shape to aim for — compare `adminPermissionService`, where the two were fused
// in one function and had to be prised apart and renamed.
//
// Three UNIQUE constraints the removed DDL declared, all load-bearing and all
// present in the baseline:
//
//   provider_catalog_offerings.catalog_key UNIQUE — the seed is idempotent
//     BECAUSE of this: it inserts only when catalog_key is absent, so a repeated
//     boot does not duplicate the built-in catalog.
//   provider_catalog_offering_mappings UNIQUE (offering_id, service_id, level_2)
//     — one mapping per (offering, service, level).
//   employee_catalog_capabilities UNIQUE (employee_uid, offering_id) — a provider
//     holds a capability once, not once per grant attempt.

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
    `SELECT id, name FROM ${dbSchema}.service_families ORDER BY id`,
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

export const getOfferingsForProvider = async (workerUid: string): Promise<any[]> => {
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
     JOIN ${dbSchema}.service_families s ON s.id = m.service_id
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
  return Promise.all(offerings.map(async (o: any) => {
    const oMappings = mappingsByOffering.get(Number(o.id)) ?? [];
    const specificServices: any[] = [];

    for (const mp of oMappings) {
      const services = specificServicesRows.filter(
        (ss: any) => Number(ss.service_id) === mp.serviceId && ss.level_2 === mp.level2
      );
      for (const ss of services) {
        specificServices.push({
          serviceOptionId: Number(ss.id),
          serviceId: mp.serviceId,
          name: ss.level_3,
          description: ss.description || null,
          unit: ss.unit,
          inclusions: ss.inclusions ?? [],
          exclusions: ss.exclusions ?? [],
          addons: (addonsByParent.get(Number(ss.id)) ?? []).map((addon: any) => ({
            serviceOptionId: addon.serviceOptionId,
            name: addon.name,
            unit: addon.unit,
          })),
        });
      }
    }

    const applicationTargets = await Promise.all(
      [...new Map(oMappings.map((mapping: any) => [mapping.serviceId, mapping])).values()]
        .map(async (mapping: any) => ({
          serviceId: mapping.serviceId,
          serviceName: mapping.serviceFamilyName,
          eligibility: await evaluateApplicationEligibility(workerUid, mapping.serviceId),
        })),
    );

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
      applicationTargets,
    };
  }));
};

// ─── Admin — Offering Providers (Compatibility tab) ──────────────────────────

export const getOfferingProviders = async (offeringId: number): Promise<any[]> => {
  const res = await dbQuery.query(
    `SELECT ecc.employee_uid, ecc.status, ecc.approved_at, ecc.created_at,
            uc.first_name, uc.last_name
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
    `SELECT id, name FROM ${dbSchema}.service_families ORDER BY name`,
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
     JOIN ${dbSchema}.service_families s ON s.id = m.service_id
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

  const [policyRes, requirementsRes] = await Promise.all([
    dbQuery.query(
      `SELECT enforcement_state, allowed_provider_types, allowed_branch_ids,
              allowed_city_ids, version, updated_at, updated_by
       FROM ${dbSchema}.provider_catalog_offering_policies WHERE offering_id = $1`,
      [offeringId],
    ),
    dbQuery.query(
      `SELECT requirement_key, document_type_id, provider_label,
              provider_description, is_required, is_active, display_order, version
       FROM ${dbSchema}.provider_catalog_offering_requirements
       WHERE offering_id = $1 ORDER BY display_order, id`,
      [offeringId],
    ),
  ]);

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
    policy: policyRes.rowCount ? {
      enforcementState: policyRes.rows[0].enforcement_state,
      allowedProviderTypes: policyRes.rows[0].allowed_provider_types ?? [],
      allowedBranchIds: policyRes.rows[0].allowed_branch_ids ?? [],
      allowedCityIds: policyRes.rows[0].allowed_city_ids ?? [],
      version: Number(policyRes.rows[0].version ?? 1),
      updatedAt: policyRes.rows[0].updated_at,
      updatedBy: policyRes.rows[0].updated_by ?? null,
      requirements: requirementsRes.rows.map((row: any) => ({
        requirementKey: row.requirement_key,
        documentTypeId: row.document_type_id,
        providerLabel: row.provider_label,
        providerDescription: row.provider_description,
        required: Boolean(row.is_required),
        active: Boolean(row.is_active),
        displayOrder: Number(row.display_order),
        version: Number(row.version),
      })),
    } : {
      enforcementState: 'draft',
      allowedProviderTypes: [],
      allowedBranchIds: [],
      allowedCityIds: [],
      version: 0,
      updatedAt: null,
      updatedBy: null,
      requirements: [],
    },
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

export interface OfferingPolicyInput {
  enforcementState: 'draft' | 'enforced';
  allowedProviderTypes: string[];
  allowedBranchIds: string[];
  allowedCityIds: string[];
  requirements: Array<{
    requirementKey: string;
    documentTypeId: string;
    providerLabel: string;
    providerDescription: string;
    required: boolean;
    displayOrder?: number;
  }>;
  expectedVersion: number;
}

export const saveOfferingPolicy = async (
  offeringId: number,
  input: OfferingPolicyInput,
  adminUid: string,
): Promise<any> => {
  const providerTypes = uniqueStrings(input.allowedProviderTypes, 'allowedProviderTypes');
  const branchIds = uniqueStrings(input.allowedBranchIds, 'allowedBranchIds');
  const cityIds = uniqueStrings(input.allowedCityIds, 'allowedCityIds');
  if (!['draft', 'enforced'].includes(input.enforcementState)) throw new Error('enforcementState must be draft or enforced');
  if (providerTypes.some((value) => !['individual_provider', 'organization_provider'].includes(value))) {
    throw new Error('allowedProviderTypes contains an unsupported provider type');
  }
  if (!Array.isArray(input.requirements) || input.requirements.length > 50) throw new Error('requirements must contain at most 50 items');
  const requirementKeys = new Set<string>();
  for (const requirement of input.requirements) {
    if (!/^[a-z0-9][a-z0-9_-]{2,99}$/.test(String(requirement.requirementKey ?? ''))) throw new Error('Each requirement needs a stable lowercase requirementKey');
    if (requirementKeys.has(requirement.requirementKey)) throw new Error(`Duplicate requirementKey: ${requirement.requirementKey}`);
    requirementKeys.add(requirement.requirementKey);
    if (!String(requirement.providerLabel ?? '').trim() || !String(requirement.providerDescription ?? '').trim()) {
      throw new Error('Every requirement needs provider-safe label and description text');
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const offering = await client.query(
      `SELECT id, version FROM ${dbSchema}.provider_catalog_offerings WHERE id = $1 FOR UPDATE`,
      [offeringId],
    );
    if (!offering.rowCount) throw Object.assign(new Error('Offering not found'), { statusCode: 404 });
    if (Number(offering.rows[0].version) !== Number(input.expectedVersion)) {
      throw Object.assign(new Error('Conflict: offering policy changed; refresh and retry'), { code: 'CONFLICT' });
    }

    if (branchIds.length) {
      const valid = await client.query(`SELECT id::text AS id FROM ${dbSchema}.branches WHERE id::text = ANY($1)`, [branchIds]);
      const found = new Set(valid.rows.map((row: any) => String(row.id)));
      const unknown = branchIds.filter((id) => !found.has(id));
      if (unknown.length) throw new Error(`Unknown branch ids: ${unknown.join(', ')}`);
    }
    if (cityIds.length) {
      const valid = await client.query(
        `SELECT area_id FROM ${dbSchema}.provider_service_area_catalog WHERE area_id = ANY($1) AND is_supported = TRUE`,
        [cityIds],
      );
      const found = new Set(valid.rows.map((row: any) => String(row.area_id)));
      const unknown = cityIds.filter((id) => !found.has(id));
      if (unknown.length) throw new Error(`Unsupported service area ids: ${unknown.join(', ')}`);
    }
    if (input.requirements.length) {
      const documentTypes = input.requirements.map((requirement) => requirement.documentTypeId);
      const valid = await client.query(
        `SELECT document_type_id FROM ${dbSchema}.provider_document_types
         WHERE document_type_id = ANY($1) AND is_active = TRUE`,
        [documentTypes],
      );
      const found = new Set(valid.rows.map((row: any) => String(row.document_type_id)));
      const unknown = documentTypes.filter((id) => !found.has(id));
      if (unknown.length) throw new Error(`Unknown document types: ${[...new Set(unknown)].join(', ')}`);
    }

    await client.query(
      `INSERT INTO ${dbSchema}.provider_catalog_offering_policies
         (offering_id, enforcement_state, allowed_provider_types,
          allowed_branch_ids, allowed_city_ids, updated_by)
       VALUES ($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6)
       ON CONFLICT (offering_id) DO UPDATE SET
         enforcement_state = EXCLUDED.enforcement_state,
         allowed_provider_types = EXCLUDED.allowed_provider_types,
         allowed_branch_ids = EXCLUDED.allowed_branch_ids,
         allowed_city_ids = EXCLUDED.allowed_city_ids,
         updated_by = EXCLUDED.updated_by, updated_at = NOW(),
         version = ${dbSchema}.provider_catalog_offering_policies.version + 1`,
      [offeringId, input.enforcementState, JSON.stringify(providerTypes), JSON.stringify(branchIds), JSON.stringify(cityIds), adminUid],
    );
    await client.query(
      `UPDATE ${dbSchema}.provider_catalog_offering_requirements
       SET is_active = FALSE, updated_at = NOW(), version = version + 1
       WHERE offering_id = $1 AND is_active = TRUE`,
      [offeringId],
    );
    for (const requirement of input.requirements) {
      await client.query(
        `INSERT INTO ${dbSchema}.provider_catalog_offering_requirements
           (offering_id, requirement_key, document_type_id, provider_label,
            provider_description, is_required, is_active, display_order)
         VALUES ($1,$2,$3,$4,$5,$6,TRUE,$7)
         ON CONFLICT (offering_id, requirement_key) DO UPDATE SET
           document_type_id = EXCLUDED.document_type_id,
           provider_label = EXCLUDED.provider_label,
           provider_description = EXCLUDED.provider_description,
           is_required = EXCLUDED.is_required, is_active = TRUE,
           display_order = EXCLUDED.display_order, updated_at = NOW(),
           version = ${dbSchema}.provider_catalog_offering_requirements.version + 1`,
        [offeringId, requirement.requirementKey, requirement.documentTypeId,
          requirement.providerLabel.trim(), requirement.providerDescription.trim(),
          Boolean(requirement.required), Number(requirement.displayOrder ?? 0)],
      );
    }
    await client.query(
      `UPDATE ${dbSchema}.provider_catalog_offerings
       SET version = version + 1, updated_by = $2, updated_at = NOW() WHERE id = $1`,
      [offeringId, adminUid],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  auditFire({ action: 'catalog_offering.policy_update', actionCategory: 'catalog', outcome: 'success', actorUid: adminUid, actorType: 'admin', entityType: 'catalog_offering', entityId: String(offeringId), after: { enforcementState: input.enforcementState, requirementCount: input.requirements.length } });
  return getAdminOffering(offeringId);
};

export const getCatalogPolicyDimensions = async () => {
  const [branches, areas, documentTypes] = await Promise.all([
    dbQuery.query(`SELECT id::text AS id, name FROM ${dbSchema}.branches ORDER BY name`, []),
    dbQuery.query(`SELECT area_id, provider_label, province, is_supported FROM ${dbSchema}.provider_service_area_catalog ORDER BY province, provider_label`, []),
    dbQuery.query(`SELECT document_type_id, provider_label, category, expiry_policy FROM ${dbSchema}.provider_document_types WHERE is_active = TRUE ORDER BY category, provider_label`, []),
  ]);
  return {
    providerTypes: [
      { id: 'individual_provider', label: 'Individual provider' },
      { id: 'organization_provider', label: 'Organization provider' },
    ],
    branches: branches.rows.map((row: any) => ({ id: String(row.id), label: row.name })),
    serviceAreas: areas.rows.map((row: any) => ({ id: row.area_id, label: row.provider_label, province: row.province, supported: Boolean(row.is_supported) })),
    documentTypes: documentTypes.rows.map((row: any) => ({ id: row.document_type_id, label: row.provider_label, category: row.category, expiryPolicy: row.expiry_policy })),
  };
};

const uniqueStrings = (value: unknown, field: string): string[] => {
  if (!Array.isArray(value) || value.length > 250) throw new Error(`${field} must be an array with at most 250 values`);
  const normalized = value.map((item) => String(item).trim()).filter(Boolean);
  if (normalized.some((item) => item.length > 100)) throw new Error(`${field} contains an invalid value`);
  return [...new Set(normalized)];
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
  category?: string;     // services.category — the service-family category
  level2?: string;       // service group within the family
  unit?: string;
  minPrice?: number;
  maxPrice?: number;
  mapped?: string;       // 'true' | 'false' | omitted = all
  hasBanner?: string;    // 'true' | 'false' | omitted = all
  isActive?: string;     // 'true' | 'false' | omitted = all
  sortBy?: string;       // 'name' | 'catalog' | 'price' | 'updatedAt' | 'level2' | 'category'
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
    conditions.push(
      // pco is the LATERAL below, whose column is aliased offering_name — not name.
      `(LOWER(so.level_3) LIKE $${i} OR LOWER(so.level_2) LIKE $${i}` +
      ` OR LOWER(COALESCE(pco.offering_name, '')) LIKE $${i}` +
      ` OR LOWER(COALESCE(s.name, '')) LIKE $${i}` +
      ` OR LOWER(COALESCE(s.category, '')) LIKE $${i})`,
    );
    queryParams.push(`%${params.search.toLowerCase().trim()}%`);
    i++;
  }

  // Filter across ALL of a service's mappings, not just the primary one resolved
  // below — a service mapped to two offerings must still match either of them.
  if (params.offeringId) {
    conditions.push(`EXISTS (
      SELECT 1 FROM ${dbSchema}.provider_catalog_offering_mappings m2
      WHERE m2.service_id = so.service_id AND m2.level_2 = so.level_2
        AND m2.is_active = true AND m2.offering_id = $${i}
    )`);
    queryParams.push(Number(params.offeringId));
    i++;
  }

  if (params.category) {
    conditions.push(`LOWER(s.category) = $${i}`);
    queryParams.push(String(params.category).toLowerCase().trim());
    i++;
  }

  if (params.level2) {
    conditions.push(`LOWER(so.level_2) = $${i}`);
    queryParams.push(String(params.level2).toLowerCase().trim());
    i++;
  }

  if (params.unit) {
    conditions.push(`LOWER(so.unit) = $${i}`);
    queryParams.push(String(params.unit).toLowerCase().trim());
    i++;
  }

  if (params.minPrice != null && isFinite(Number(params.minPrice))) {
    conditions.push(`so.base_price >= $${i}`);
    queryParams.push(Number(params.minPrice));
    i++;
  }

  if (params.maxPrice != null && isFinite(Number(params.maxPrice))) {
    conditions.push(`so.base_price <= $${i}`);
    queryParams.push(Number(params.maxPrice));
    i++;
  }

  if (params.mapped === 'true')       conditions.push(`pco.id IS NOT NULL`);
  else if (params.mapped === 'false') conditions.push(`pco.id IS NULL`);

  if (params.hasBanner === 'true')       conditions.push(`so.banner_url IS NOT NULL AND so.banner_url <> ''`);
  else if (params.hasBanner === 'false') conditions.push(`(so.banner_url IS NULL OR so.banner_url = '')`);

  if (params.isActive === 'true') {
    conditions.push(`COALESCE(so.is_active, true) = true`);
  } else if (params.isActive === 'false') {
    conditions.push(`COALESCE(so.is_active, true) = false`);
  }

  const validSort: Record<string, string> = {
    name:      'so.level_3',
    catalog:   'pco.offering_name',
    price:     'so.base_price',
    updatedAt: 'so.updated_at',
    level2:    'so.level_2',
    category:  's.category',
  };
  const sortField = validSort[params.sortBy ?? ''] ?? 'so.level_3';
  const sortDir   = params.sortOrder === 'desc' ? 'DESC' : 'ASC';

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Offerings are resolved through a LATERAL "primary mapping" lookup rather than a
  // plain INNER JOIN. Two reasons, both correctness rather than taste:
  //   1. INNER JOIN silently DROPPED every specific service with no active offering
  //      mapping — an admin page that promises "all services" must not hide rows,
  //      and an unmapped service is exactly the row an admin needs to find.
  //   2. UNIQUE(offering_id, service_id, level_2) permits the same (service_id,
  //      level_2) under several offerings, so the join emitted one DUPLICATE row per
  //      extra mapping and inflated total_count with it.
  // `offering` therefore stays a single object (unchanged shape, may now be null) and
  // `offeringCount` is added so the UI can show when a service belongs to more.
  const sql = `
    SELECT
      so.id          AS service_option_id,
      so.service_id,
      so.level_2,
      so.level_3     AS name,
      so.unit,
      so.base_price,
      so.banner_url,
      COALESCE(so.is_active, true) AS is_active,
      so.updated_at,
      s.name         AS service_family_name,
      s.category     AS category,
      COALESCE(m.description, '') AS description,
      pco.offering_id,
      pco.offering_name,
      pco.catalog_key,
      pco.icon_key,
      pco.offering_status,
      (
        SELECT COUNT(*) FROM ${dbSchema}.provider_catalog_offering_mappings m3
        WHERE m3.service_id = so.service_id AND m3.level_2 = so.level_2 AND m3.is_active = true
      ) AS offering_count,
      COUNT(*) OVER() AS total_count
    FROM ${dbSchema}.service_options so
    LEFT JOIN ${dbSchema}.service_families s
      ON s.id = so.service_id
    LEFT JOIN ${dbSchema}.service_option_meta m
      ON m.service_option_id = so.id
    LEFT JOIN LATERAL (
      SELECT o.id     AS offering_id,
             o.name   AS offering_name,
             o.catalog_key,
             o.icon_key,
             o.status AS offering_status
      FROM ${dbSchema}.provider_catalog_offering_mappings pcom
      INNER JOIN ${dbSchema}.provider_catalog_offerings o
        ON o.id = pcom.offering_id
      WHERE pcom.service_id = so.service_id
        AND pcom.level_2    = so.level_2
        AND pcom.is_active  = true
      ORDER BY o.display_order ASC, o.id ASC
      LIMIT 1
    ) pco ON true
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
    bannerUrl:       r.banner_url || null,
    description:     r.description || null,
    category:        r.category || null,
    serviceFamilyName: r.service_family_name || null,
    isActive:        r.is_active == null ? true : Boolean(r.is_active),
    updatedAt:       r.updated_at ? new Date(r.updated_at).toISOString() : null,
    offeringCount:   Number(r.offering_count ?? 0),
    offering: r.offering_id == null ? null : {
      offeringId:  Number(r.offering_id),
      name:        r.offering_name as string,
      catalogKey:  r.catalog_key  as string,
      iconKey:     r.icon_key     as string | null,
      status:      r.offering_status as string,
    },
  }));

  return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
};

// Distinct filter values for the Services Management filter bar. Derived from the
// live rows rather than the hardcoded CATALOG_OFFERINGS list in the portal, so a
// category seeded by a migration shows up without a frontend release.
export const listSpecificServiceFilterOptions = async (): Promise<{
  categories: Array<{ category: string; serviceCount: number }>;
  level2s: string[];
  units: string[];
  priceRange: { min: number | null; max: number | null };
}> => {
  const catRes = await dbQuery.query(
    `SELECT s.category, COUNT(*)::int AS service_count
     FROM ${dbSchema}.service_options so
     INNER JOIN ${dbSchema}.service_families s ON s.id = so.service_id
     WHERE so.option_type = 'MAIN' AND s.category IS NOT NULL AND s.category <> ''
     GROUP BY s.category
     ORDER BY s.category ASC`,
    [],
  );

  const l2Res = await dbQuery.query(
    `SELECT DISTINCT level_2 FROM ${dbSchema}.service_options
     WHERE option_type = 'MAIN' AND level_2 IS NOT NULL AND level_2 <> ''
     ORDER BY level_2 ASC`,
    [],
  );

  const unitRes = await dbQuery.query(
    `SELECT DISTINCT unit FROM ${dbSchema}.service_options
     WHERE option_type = 'MAIN' AND unit IS NOT NULL AND unit <> ''
     ORDER BY unit ASC`,
    [],
  );

  const rangeRes = await dbQuery.query(
    `SELECT MIN(base_price) AS min, MAX(base_price) AS max
     FROM ${dbSchema}.service_options WHERE option_type = 'MAIN'`,
    [],
  );

  return {
    categories: catRes.rows.map((r: any) => ({
      category: r.category as string,
      serviceCount: Number(r.service_count),
    })),
    level2s: l2Res.rows.map((r: any) => r.level_2 as string),
    units:   unitRes.rows.map((r: any) => r.unit as string),
    priceRange: {
      min: rangeRes.rows[0]?.min == null ? null : Number(rangeRes.rows[0].min),
      max: rangeRes.rows[0]?.max == null ? null : Number(rangeRes.rows[0].max),
    },
  };
};

// ─── Admin — Specific Services CRUD ──────────────────────────────────────────

export const listSpecificServicesForOffering = async (offeringId: number): Promise<any[]> => {
  // Match the (service_id, level_2) PAIRS this offering maps to.
  //
  // This used to collect the two columns into separate arrays and filter
  // `service_id = ANY(sids) AND level_2 = ANY(l2s)`, which is the cross product of
  // the two sets rather than the set of pairs. With mappings (1,'Deep Clean') and
  // (2,'Standard') it also returned (1,'Standard') and (2,'Deep Clean') — specific
  // services belonging to OTHER offerings, listed and editable under this one. An
  // over-include is worse than a drop: nothing looks missing, so nobody checks.
  //
  // EXISTS against the mapping row keeps the pairing intact.
  const res = await dbQuery.query(
    `SELECT so.id, so.service_id, so.level_2, so.level_3, so.unit, so.base_price,
            so.is_active, so.banner_url,
            COALESCE(m.description, '') AS description,
            COALESCE(m.inclusions, '[]'::jsonb) AS inclusions,
            COALESCE(m.exclusions, '[]'::jsonb) AS exclusions
     FROM ${dbSchema}.service_options so
     LEFT JOIN ${dbSchema}.service_option_meta m ON m.service_option_id = so.id
     WHERE so.option_type = 'MAIN'
       AND EXISTS (
         SELECT 1 FROM ${dbSchema}.provider_catalog_offering_mappings pcom
         WHERE pcom.offering_id = $1
           AND pcom.is_active   = true
           AND pcom.service_id  = so.service_id
           AND pcom.level_2     = so.level_2
       )
     ORDER BY so.level_2, so.level_3`,
    [offeringId]
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
    bannerUrl: r.banner_url || null,
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
        `SELECT id FROM ${dbSchema}.service_families WHERE LOWER(name) = LOWER($1) LIMIT 1`,
        [familyName]
      );
      if (famRes.rows.length > 0) resolvedServiceId = Number(famRes.rows[0].id);
    }
    if (!resolvedServiceId) {
      const anyRes = await dbQuery.query(
        `SELECT id FROM ${dbSchema}.service_families ORDER BY id LIMIT 1`, []
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
  // Read back rather than echoing the input, so create and update return the SAME
  // shape — the echoed object was missing category / serviceFamilyName / bannerUrl
  // and left callers guessing which fields a create response actually carries.
  return (await getAdminSpecificService(optionId)) ?? {
    serviceOptionId: optionId,
    serviceId,
    level2: data.level2,
    level3: data.level3,
    description: data.description ?? null,
    unit: data.unit,
    basePrice: data.basePrice,
    bannerUrl: null,
    inclusions: data.inclusions ?? [],
    exclusions: data.exclusions ?? [],
    addons: [],
  };
};

export const getAdminSpecificService = async (serviceOptionId: number): Promise<any | null> => {
  const res = await dbQuery.query(
    `SELECT so.id, so.service_id, so.level_2, so.level_3, so.unit, so.base_price, so.is_active,
            so.banner_url,
            s.name     AS service_family_name,
            s.category AS category,
            COALESCE(m.description, '') AS description,
            COALESCE(m.inclusions, '[]'::jsonb) AS inclusions,
            COALESCE(m.exclusions, '[]'::jsonb) AS exclusions
     FROM ${dbSchema}.service_options so
     LEFT JOIN ${dbSchema}.service_families s ON s.id = so.service_id
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
    // toCamel yields `id` from so.id, but every other catalog response calls this
    // `serviceOptionId`. Emit both so callers do not have to know which one they got.
    serviceOptionId: Number(res.rows[0].id),
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
    bannerUrl?: string | null;   // explicit null clears the banner
  },
  adminUid: string
): Promise<any> => {
  if (data.basePrice !== undefined && (data.basePrice < 0 || !isFinite(data.basePrice))) {
    throw new Error('basePrice must be a non-negative finite number');
  }

  // Read the pre-change row so the audit event carries a real `before` (§15) rather
  // than only the submitted fields.
  const check = await dbQuery.query(
    `SELECT id, level_3, unit, base_price, banner_url
     FROM ${dbSchema}.service_options WHERE id = $1 AND option_type = 'MAIN'`,
    [serviceOptionId]
  );
  if (check.rows.length === 0) throw new Error('Specific service not found');
  const before = check.rows[0];

  // Update service_options — preserve id, service_id, level_2, option_type.
  // banner_url uses a separate "explicitly provided?" flag because COALESCE cannot
  // distinguish "leave alone" from "clear it": both arrive as null.
  const clearBanner = data.bannerUrl === null;
  await dbQuery.query(
    `UPDATE ${dbSchema}.service_options SET
       level_3    = COALESCE($1, level_3),
       unit       = COALESCE($2, unit),
       base_price = COALESCE($3, base_price),
       banner_url = CASE WHEN $5::boolean THEN NULL ELSE COALESCE($6::text, banner_url) END,
       updated_at = NOW()
     WHERE id = $4`,
    [
      data.level3 ?? null, data.unit ?? null, data.basePrice ?? null, serviceOptionId,
      clearBanner, data.bannerUrl ?? null,
    ]
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

  // The panel can clear a banner through this route rather than DELETE .../banner,
  // so the same withdrawal has to happen here or that path leaks a live token URL.
  if (clearBanner && before.banner_url) {
    await deleteBannerObject(before.banner_url);
  }

  auditFire({
    action: 'catalog_service_option.update', actionCategory: 'catalog', outcome: 'success',
    actorUid: adminUid, actorType: 'admin', entityType: 'catalog_service_option',
    entityId: String(serviceOptionId),
    before: {
      level3: before.level_3, unit: before.unit,
      basePrice: before.base_price == null ? null : Number(before.base_price),
      bannerUrl: before.banner_url ?? null,
    },
    after: data as Record<string, unknown>,
    changedFields: Object.keys(data).filter((k) => (data as Record<string, unknown>)[k] !== undefined),
  });
  return getAdminSpecificService(serviceOptionId);
};

// ─── Admin — Specific Service Banner ─────────────────────────────────────────
// A banner is public catalog marketing content, so it is stored as a permanent
// public Firebase download URL (uploadFileToStorage) rather than a private path +
// signed URL. Provider documents keep the private path treatment; do not copy this
// helper for anything containing personal data.

const ALLOWED_BANNER_MIMES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_BANNER_BYTES = 5 * 1024 * 1024;

/**
 * Best-effort removal of the storage object behind a banner URL.
 *
 * Replacing or removing a banner used to leave the old object in the bucket
 * forever — and because these URLs carry an embedded download token, a "removed"
 * banner stayed publicly fetchable by anyone who had ever seen its URL. Clearing
 * the column is not the same as withdrawing the image.
 *
 * Never throws: losing the old file is not a reason to fail the admin's edit, and
 * the new banner is already the record of truth by the time this runs.
 */
const deleteBannerObject = async (bannerUrl: string | null | undefined): Promise<void> => {
  const url = String(bannerUrl ?? '');
  if (!url.startsWith('https://firebasestorage.googleapis.com/')) return;
  try {
    // Format we mint in uploadFileToStorage: .../o/<uri-encoded path>?alt=media&token=...
    const encoded = url.split('/o/')[1]?.split('?')[0];
    if (!encoded) return;
    const storagePath = decodeURIComponent(encoded);
    if (!storagePath.startsWith('service-banners/')) return;  // never touch another domain's files
    const { deletePrivateStoredFile } = await import('../helpers/firebaseStorageUploader');
    await deletePrivateStoredFile(storagePath);
  } catch (err: any) {
    console.error('[catalog] banner cleanup failed:', err?.message ?? err);
  }
};

export const setSpecificServiceBanner = async (
  serviceOptionId: number,
  fileDataUri: string,
  fileName: string,
  adminUid: string,
): Promise<any> => {
  const check = await dbQuery.query(
    `SELECT id, level_3, banner_url FROM ${dbSchema}.service_options
     WHERE id = $1 AND option_type = 'MAIN'`,
    [serviceOptionId],
  );
  if (check.rows.length === 0) {
    throw Object.assign(new Error('Specific service not found'), { statusCode: 404 });
  }

  /**
   * Parsed by index rather than by regex, deliberately.
   *
   * This was `/^data:([^;,]+);base64,(.+)$/`. The `(.+)` captures the whole
   * payload, and V8 sizes a regex stack against the input — so a 4 MB image
   * (≈5.6 MB of base64) could throw `RangeError: Maximum call stack size
   * exceeded` instead of the 400 below. The caller then saw a 500 on an upload
   * that was merely too large, and the size limit that exists to produce a
   * clean error never got the chance to run.
   *
   * It surfaced as an intermittent test failure rather than a report, because
   * whether the allocation fails depends on heap pressure at the moment of the
   * call — so it moved between suites and looked like flakiness.
   *
   * `indexOf` + `slice` does no backtracking and is O(n) on any input.
   */
  const raw = String(fileDataUri ?? '').trim();
  const SEPARATOR = ';base64,';
  const separatorAt = raw.indexOf(SEPARATOR);
  const header = separatorAt >= 0 ? raw.slice(0, separatorAt) : '';
  const declaredMime = header.startsWith('data:') ? header.slice('data:'.length) : '';

  // The MIME may not itself contain a parameter separator — `data:image/png;q=1`
  // is a different shape and is refused rather than silently accepted.
  if (separatorAt < 0 || !declaredMime || /[;,]/.test(declaredMime)) {
    throw Object.assign(new Error('Banner must be a base64 data URI'), { statusCode: 400 });
  }
  const payload = raw.slice(separatorAt + SEPARATOR.length);
  if (!payload) {
    throw Object.assign(new Error('Banner must be a base64 data URI'), { statusCode: 400 });
  }
  const match = [raw, declaredMime, payload] as const;
  const mimeType = match[1].toLowerCase();
  if (!ALLOWED_BANNER_MIMES.includes(mimeType)) {
    throw Object.assign(
      new Error('Banner must be a JPG, PNG or WebP image'),
      { statusCode: 400 },
    );
  }
  // Decode to measure real bytes — a base64 length check overstates by ~33% and a
  // client-declared size is not evidence.
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.byteLength === 0) {
    throw Object.assign(new Error('Banner image is empty'), { statusCode: 400 });
  }
  if (buffer.byteLength > MAX_BANNER_BYTES) {
    throw Object.assign(new Error('Banner image must be 5 MB or smaller'), { statusCode: 400 });
  }
  // Magic bytes must agree with the declared MIME — a renamed .exe otherwise sails
  // through on the client-supplied content type alone.
  const sniffed =
    buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff ? 'image/jpeg'
    : buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 ? 'image/png'
    : buffer.length > 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp'
    : null;
  if (sniffed !== mimeType) {
    throw Object.assign(
      new Error('Banner file contents do not match its image type'),
      { statusCode: 400 },
    );
  }

  // uploadFileToStorage appends its own extension derived from the MIME type, so
  // strip any the caller supplied — otherwise "photo.png" became "…photo.png.png".
  const safeName = String(fileName || 'banner')
    .replace(/\.(jpe?g|png|webp)$/i, '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '_')   // no dot runs, so no traversal segment survives
    .replace(/^[.\-]+/, '')    // and nothing starts with a dot or dash
    .slice(0, 60) || 'banner';
  // Imported lazily for the same reason adminProviderService does: the Firebase
  // bucket accessor resolves credentials on first use, and nothing else in this
  // module needs storage.
  const { uploadFileToStorage } = await import('../helpers/firebaseStorageUploader');
  const url = await uploadFileToStorage(
    `service-banners/${serviceOptionId}`,
    `${Date.now()}_${safeName}`,
    fileDataUri,
  );

  await dbQuery.query(
    `UPDATE ${dbSchema}.service_options SET banner_url = $1, updated_at = NOW() WHERE id = $2`,
    [url, serviceOptionId],
  );

  // Withdraw the image this one replaced, after the new URL is committed.
  await deleteBannerObject(check.rows[0].banner_url);

  auditFire({
    action: 'catalog_service_option.banner_set', actionCategory: 'catalog', outcome: 'success',
    actorUid: adminUid, actorType: 'admin', entityType: 'catalog_service_option',
    entityId: String(serviceOptionId), entityDisplayName: check.rows[0].level_3 ?? null,
    before: { bannerUrl: check.rows[0].banner_url ?? null },
    after: { bannerUrl: url, mimeType, byteSize: buffer.byteLength },
    changedFields: ['bannerUrl'],
  });

  return getAdminSpecificService(serviceOptionId);
};

export const removeSpecificServiceBanner = async (
  serviceOptionId: number,
  adminUid: string,
): Promise<any> => {
  // Read the old URL BEFORE clearing it: RETURNING on an UPDATE yields the new row,
  // where banner_url is already NULL, so there would be nothing left to delete.
  const existing = await dbQuery.query(
    `SELECT banner_url FROM ${dbSchema}.service_options
     WHERE id = $1 AND option_type = 'MAIN'`,
    [serviceOptionId],
  );
  if (existing.rows.length === 0) {
    throw Object.assign(new Error('Specific service not found'), { statusCode: 404 });
  }
  const previousBannerUrl = existing.rows[0].banner_url as string | null;

  const res = await dbQuery.query(
    `UPDATE ${dbSchema}.service_options SET banner_url = NULL, updated_at = NOW()
     WHERE id = $1 AND option_type = 'MAIN'
     RETURNING id`,
    [serviceOptionId],
  );
  if (res.rows.length === 0) {
    throw Object.assign(new Error('Specific service not found'), { statusCode: 404 });
  }
  await deleteBannerObject(previousBannerUrl);
  auditFire({
    action: 'catalog_service_option.banner_removed', actionCategory: 'catalog', outcome: 'success',
    actorUid: adminUid, actorType: 'admin', entityType: 'catalog_service_option',
    entityId: String(serviceOptionId), after: { bannerUrl: null }, changedFields: ['bannerUrl'],
  });
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
     JOIN ${dbSchema}.service_families s ON s.id = m.service_id
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
    `SELECT id, name FROM ${dbSchema}.service_families WHERE id = $1`,
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
     RETURNING *, (SELECT name FROM ${dbSchema}.service_families s WHERE s.id = service_id) AS service_family_name`,
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
  /**
   * A published offering may not be left with zero active mappings.
   *
   * `getPublishPreview` already refuses to publish an offering that has no
   * active mapping, but nothing stopped the last one being archived AFTER
   * publication — so the invariant held at the publish gate and nowhere else.
   * An offering in that state stays status='active' and shows providers an
   * empty catalog entry, which is the failure the publish blocker exists to
   * prevent.
   *
   * Scoped deliberately:
   *  - only when the offering is published (`status = 'active'`). A draft has
   *    no providers reading it, and the spec this came from explicitly allows
   *    emptying a draft.
   *  - only when the mapping being archived is currently active. Archiving an
   *    already-archived mapping changes nothing and must stay idempotent.
   */
  const guard = await dbQuery.query(
    `SELECT m.is_active,
            o.status,
            (SELECT COUNT(*)
               FROM ${dbSchema}.provider_catalog_offering_mappings sib
              WHERE sib.offering_id = m.offering_id
                AND sib.is_active = true) AS active_sibling_count
       FROM ${dbSchema}.provider_catalog_offering_mappings m
       JOIN ${dbSchema}.provider_catalog_offerings o ON o.id = m.offering_id
      WHERE m.id = $1`,
    [mappingId]
  );
  if (guard.rows.length === 0) throw new Error('Mapping not found');
  const g = guard.rows[0];
  if (g.is_active === true && g.status === 'active' && Number(g.active_sibling_count) <= 1) {
    throw Object.assign(
      new Error('Cannot archive the last active mapping on a published offering. Archive the offering instead, or add another mapping first.'),
      { code: 'VALIDATION' }
    );
  }

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
    `SELECT id, name, status, is_builtin, provider_web_visible FROM ${dbSchema}.provider_catalog_offerings WHERE id = $1`,
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
            COUNT(so.id) AS ss_count,
            COUNT(so.id) FILTER (WHERE so.base_price IS NOT NULL AND so.base_price > 0) AS priced_count
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
      } else if (Number(m.priced_count) === 0) {
        // Counting rows was not enough. A mapping whose specific services all
        // sit at a null or zero base_price is exactly as unusable to a provider
        // as one with no services at all, and the row count hid that.
        warnings.push(`Mapping "${m.level_2}" has ${m.ss_count} active specific service(s) but none has a price — providers cannot quote from it.`);
      }
    }
  }

  // Published-but-invisible is a real and easy mistake: the offering goes
  // status='active' and still appears nowhere, because the provider web portal
  // filters on provider_web_visible (see getOfferingsForProvider). A warning,
  // not a blocker — hiding an offering deliberately is legitimate.
  if (o.provider_web_visible === false) {
    warnings.push('This offering is not visible on the provider web portal (providerWebVisible is off), so publishing will not surface it there.');
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

  const limit = Math.min(Math.max(Number(filter.limit) || 50, 1), 200);
  const offset = Math.max(Number(filter.offset) || 0, 0);
  params.push(limit, offset);

  const res = await dbQuery.query(
    `SELECT ae.id, ae.actor_uid, ae.action, ae.entity_type, ae.entity_id,
            ae.before_json, ae.after_json, ae.reason, ae.request_id, ae.created_at
     FROM ${dbSchema}.admin_audit_events ae
     WHERE ${conditions.join(' AND ')}
     -- id DESC is a tiebreaker, not decoration. created_at alone is not a total
     -- order: audit rows written in one transaction share a timestamp, so their
     -- relative order is undefined, and LIMIT/OFFSET paging over an undefined
     -- order can show a row twice or skip it entirely between pages.
     ORDER BY ae.created_at DESC, ae.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

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
