/**
 * Command 15 — Provider Catalog System tests.
 *
 * Source-inspection tests (no running server, no live DB).
 * Verifies catalog CRUD wiring, audit event coverage, per-mapping stats,
 * service-family endpoint, and protected contract integrity.
 */

const fs   = require('fs');
const path = require('path');

const SRC   = (...parts) => path.join(__dirname, '..', 'src', ...parts);
const SVC   = (...parts) => SRC('services', ...parts);
const CTRL  = (...parts) => SRC('controllers', ...parts);
const ROUTE = (...parts) => SRC('routes', ...parts);

// ── File existence ─────────────────────────────────────────────────────────────

describe('C15 — catalog files exist', () => {
  it('providerCatalogService.ts is present', () => {
    expect(fs.existsSync(SVC('providerCatalogService.ts'))).toBe(true);
  });
  it('providerCatalogController.ts is present', () => {
    expect(fs.existsSync(CTRL('providerCatalogController.ts'))).toBe(true);
  });
  it('providerCatalog.routes.ts is present', () => {
    expect(fs.existsSync(ROUTE('providerCatalog.routes.ts'))).toBe(true);
  });
  it('adminAuditService.ts is present', () => {
    expect(fs.existsSync(SVC('adminAuditService.ts'))).toBe(true);
  });
});

// ── Audit entity types include catalog types ───────────────────────────────────

describe('C15 — adminAuditService exports catalog entity types', () => {
  let audit;
  beforeAll(() => { audit = fs.readFileSync(SVC('adminAuditService.ts'), 'utf8'); });

  it('AuditEntityType includes catalog_offering', () => {
    expect(audit).toContain("'catalog_offering'");
  });
  it('AuditEntityType includes catalog_mapping', () => {
    expect(audit).toContain("'catalog_mapping'");
  });
  it('AuditEntityType includes catalog_service_option', () => {
    expect(audit).toContain("'catalog_service_option'");
  });
  it('AuditEntityType includes catalog_addon', () => {
    expect(audit).toContain("'catalog_addon'");
  });
});

// ── Catalog service: audit event wiring ───────────────────────────────────────

describe('C15 — providerCatalogService imports and calls auditFire', () => {
  let svc;
  beforeAll(() => { svc = fs.readFileSync(SVC('providerCatalogService.ts'), 'utf8'); });

  it('imports auditFire from adminAuditService', () => {
    expect(svc).toContain('import { auditFire } from "./adminAuditService"');
  });

  it('fires audit on catalog_offering.create', () => {
    expect(svc).toContain("'catalog_offering.create'");
  });
  it('fires audit on catalog_offering.update', () => {
    expect(svc).toContain("'catalog_offering.update'");
  });
  it('fires audit on catalog_offering status changes', () => {
    expect(svc).toContain('`catalog_offering.${newStatus}`');
  });
  it('fires audit on catalog_mapping.create', () => {
    expect(svc).toContain("'catalog_mapping.create'");
  });
  it('fires audit on catalog_mapping.update', () => {
    expect(svc).toContain("'catalog_mapping.update'");
  });
  it('fires audit on catalog_mapping.archive', () => {
    expect(svc).toContain("'catalog_mapping.archive'");
  });
  it('fires audit on catalog_service_option.create', () => {
    expect(svc).toContain("'catalog_service_option.create'");
  });
  it('fires audit on catalog_service_option.update', () => {
    expect(svc).toContain("'catalog_service_option.update'");
  });
  it('fires audit on catalog_service_option status toggle', () => {
    expect(svc).toContain('`catalog_service_option.${isActive ? \'activate\' : \'deactivate\'}`');
  });
  it('fires audit on catalog_addon.create', () => {
    expect(svc).toContain("'catalog_addon.create'");
  });
  it('fires audit on catalog_addon.update', () => {
    expect(svc).toContain("'catalog_addon.update'");
  });
  it('fires audit on catalog_addon status toggle', () => {
    expect(svc).toContain('`catalog_addon.${isActive ? \'activate\' : \'deactivate\'}`');
  });
});

// ── Per-mapping stats in getCatalogOverview ────────────────────────────────────

describe('C15 — getCatalogOverview includes per-mapping stats', () => {
  let svc;
  beforeAll(() => { svc = fs.readFileSync(SVC('providerCatalogService.ts'), 'utf8'); });

  it('queries per-mapping specific_service_count', () => {
    expect(svc).toContain('specific_service_count');
  });
  it('queries per-mapping min_price', () => {
    expect(svc).toContain('min_price');
  });
  it('queries per-mapping max_price', () => {
    expect(svc).toContain('max_price');
  });
  it('includes specificServiceCount in mapping row object', () => {
    expect(svc).toContain('specificServiceCount:');
  });
  it('includes minPrice in mapping row object', () => {
    expect(svc).toContain('minPrice:');
  });
  it('includes maxPrice in mapping row object', () => {
    expect(svc).toContain('maxPrice:');
  });
});

// ── Service family listing ─────────────────────────────────────────────────────

describe('C15 — listServiceFamilies endpoint wiring', () => {
  let svc, ctrl, routes;
  beforeAll(() => {
    svc    = fs.readFileSync(SVC('providerCatalogService.ts'), 'utf8');
    ctrl   = fs.readFileSync(CTRL('providerCatalogController.ts'), 'utf8');
    routes = fs.readFileSync(ROUTE('providerCatalog.routes.ts'), 'utf8');
  });

  it('service exports listServiceFamilies', () => {
    expect(svc).toContain('export const listServiceFamilies');
  });
  it('controller exports listServiceFamilies', () => {
    expect(ctrl).toContain('export const listServiceFamilies');
  });
  it('controller calls svc.listServiceFamilies()', () => {
    expect(ctrl).toContain('svc.listServiceFamilies()');
  });
  it('route registers GET /admin/provider-catalog/service-families', () => {
    expect(routes).toContain('/admin/provider-catalog/service-families');
    expect(routes).toContain('ctrl.listServiceFamilies');
  });
  it('service-families route requires admin role', () => {
    const familiesIdx = routes.indexOf('/admin/provider-catalog/service-families');
    const segment = routes.slice(familiesIdx, familiesIdx + 200);
    expect(segment).toContain('verifyRoles([1])');
  });
});

// ── Protected contracts: mobile endpoints untouched ───────────────────────────

describe('C15 — protected mobile/customer endpoints are not modified in catalog controller', () => {
  let ctrl, routes;
  beforeAll(() => {
    ctrl   = fs.readFileSync(CTRL('providerCatalogController.ts'), 'utf8');
    routes = fs.readFileSync(ROUTE('providerCatalog.routes.ts'), 'utf8');
  });

  it('catalog controller does not reference /workers/:uid/job-cards', () => {
    expect(ctrl).not.toContain('job-cards');
  });
  it('catalog controller does not reference /api/bookings', () => {
    expect(ctrl).not.toContain('/api/bookings');
  });
  it('catalog routes do not modify GET /services/:serviceId/level2', () => {
    // The legacy GET /services/* routes are in service.route.ts, not here
    expect(routes).not.toContain('/services/:serviceId/level2');
  });
  it('catalog routes do not modify GET /api/services', () => {
    expect(routes).not.toContain('/api/services');
  });
});

// ── Schema init is additive only ──────────────────────────────────────────────

describe('C15 — initProviderCatalogSchema is safe (no DROP, no ALTER DROP)', () => {
  let svc;
  beforeAll(() => { svc = fs.readFileSync(SVC('providerCatalogService.ts'), 'utf8'); });

  it('does not drop any table', () => {
    expect(svc.toUpperCase()).not.toContain('DROP TABLE');
  });
  it('does not drop any column', () => {
    expect(svc.toUpperCase()).not.toContain('DROP COLUMN');
  });
  it('uses IF NOT EXISTS for all CREATE TABLE statements', () => {
    const creates = svc.match(/CREATE TABLE/gi) || [];
    const safeCreates = svc.match(/CREATE TABLE IF NOT EXISTS/gi) || [];
    expect(safeCreates.length).toEqual(creates.length);
  });
  it('uses ADD COLUMN IF NOT EXISTS for all ALTER ADD COLUMN statements', () => {
    const adds = svc.match(/ADD COLUMN/gi) || [];
    const safeAdds = svc.match(/ADD COLUMN IF NOT EXISTS/gi) || [];
    expect(safeAdds.length).toEqual(adds.length);
  });
});

// ── updateSpecificServiceStatus and updateAddonStatus accept adminUid ──────────

describe('C15 — status functions accept optional adminUid', () => {
  let svc;
  beforeAll(() => { svc = fs.readFileSync(SVC('providerCatalogService.ts'), 'utf8'); });

  it('updateSpecificServiceStatus has adminUid parameter with default', () => {
    expect(svc).toContain("adminUid: string = 'system'");
  });
  it('updateAddonStatus has adminUid parameter with default', () => {
    const addonStatusIdx = svc.indexOf('export const updateAddonStatus');
    const segment = svc.slice(addonStatusIdx, addonStatusIdx + 200);
    expect(segment).toContain("adminUid: string = 'system'");
  });
});

// ── Controller passes adminUid to status functions ────────────────────────────

describe('C15 — controller passes adminUid to status update functions', () => {
  let ctrl;
  beforeAll(() => { ctrl = fs.readFileSync(CTRL('providerCatalogController.ts'), 'utf8'); });

  it('updateSpecificServiceStatus controller extracts adminUid', () => {
    const idx = ctrl.indexOf('export const updateSpecificServiceStatus');
    const segment = ctrl.slice(idx, idx + 500);
    expect(segment).toContain('user?.uid');
    expect(segment).toContain('updateSpecificServiceStatus(id, isActive, adminUid)');
  });
  it('updateAddonStatus controller extracts adminUid', () => {
    const idx = ctrl.indexOf('export const updateAddonStatus');
    const segment = ctrl.slice(idx, idx + 500);
    expect(segment).toContain('user?.uid');
    expect(segment).toContain('updateAddonStatus(id, isActive, adminUid)');
  });
});

// ── C16: CATALOG_KEY_ALREADY_EXISTS duplicate key handling ────────────────────

describe('C16 — createOffering handles duplicate catalog key safely', () => {
  let svc, ctrl;
  beforeAll(() => {
    svc  = fs.readFileSync(SVC('providerCatalogService.ts'), 'utf8');
    ctrl = fs.readFileSync(CTRL('providerCatalogController.ts'), 'utf8');
  });

  it('service catches PostgreSQL 23505 error code on insert', () => {
    expect(svc).toContain("err.code === '23505'");
  });

  it('service looks up existing offering by catalogKey on 23505', () => {
    expect(svc).toContain('catalog_key = $1');
    expect(svc).toContain('existingOfferingId');
  });

  it('service throws tagged error with code CATALOG_KEY_ALREADY_EXISTS', () => {
    expect(svc).toContain("'CATALOG_KEY_ALREADY_EXISTS'");
  });

  it('service includes existingOfferingId in thrown error', () => {
    const idx = svc.indexOf('CATALOG_KEY_ALREADY_EXISTS');
    const segment = svc.slice(idx, idx + 400);
    expect(segment).toContain('existingOfferingId');
  });

  it('service does not expose raw PostgreSQL constraint name in error message', () => {
    // The error message must not contain the raw PG constraint name
    expect(svc).not.toContain('provider_catalog_offerings_catalog_key_key');
  });

  it('controller handles CATALOG_KEY_ALREADY_EXISTS and returns 409', () => {
    const idx = ctrl.indexOf("code === \"CATALOG_KEY_ALREADY_EXISTS\"");
    expect(idx).toBeGreaterThan(-1);
    const segment = ctrl.slice(idx, idx + 300);
    expect(segment).toContain('res.status(409)');
  });

  it('controller 409 response includes structured code field', () => {
    const idx = ctrl.indexOf("code === \"CATALOG_KEY_ALREADY_EXISTS\"");
    const segment = ctrl.slice(idx, idx + 400);
    expect(segment).toContain('"CATALOG_KEY_ALREADY_EXISTS"');
  });

  it('controller 409 response includes existingOfferingId', () => {
    const idx = ctrl.indexOf("code === \"CATALOG_KEY_ALREADY_EXISTS\"");
    const segment = ctrl.slice(idx, idx + 400);
    expect(segment).toContain('existingOfferingId');
  });

  it('controller createOffering generic error returns 400 not 500', () => {
    const idx = ctrl.indexOf('export const createOffering');
    const segment = ctrl.slice(idx, idx + 900);
    expect(segment).toContain('res.status(400)');
  });
});

// ── C16: listSpecificServicesForOffering response shape ───────────────────────

describe('C16 — listSpecificServicesForOffering returns serviceOptionId alias', () => {
  let svc;
  beforeAll(() => { svc = fs.readFileSync(SVC('providerCatalogService.ts'), 'utf8'); });

  it('response shape uses serviceOptionId alias (not raw id)', () => {
    const idx = svc.indexOf('listSpecificServicesForOffering');
    const segment = svc.slice(idx, idx + 4000);
    expect(segment).toContain('serviceOptionId:');
  });

  it('serviceOptionId is aliased from Number(r.id)', () => {
    const idx = svc.indexOf('listSpecificServicesForOffering');
    const segment = svc.slice(idx, idx + 4000);
    // Must not rely on toCamel which would return `id` not `serviceOptionId`
    expect(segment).not.toContain('rows.map(toCamel)');
  });

  it('response shape includes addons array per specific service', () => {
    const idx = svc.indexOf('listSpecificServicesForOffering');
    const segment = svc.slice(idx, idx + 4000);
    expect(segment).toContain('addons:');
  });

  it('addons are loaded via a second batch query on parent_option_id', () => {
    const idx = svc.indexOf('listSpecificServicesForOffering');
    const segment = svc.slice(idx, idx + 4000);
    expect(segment).toContain('parent_option_id');
  });

  it('addons are grouped by parent using addonsByParent Map', () => {
    const idx = svc.indexOf('listSpecificServicesForOffering');
    const segment = svc.slice(idx, idx + 4000);
    expect(segment).toContain('addonsByParent');
  });

  it('response shape includes isActive field for each specific service', () => {
    const idx = svc.indexOf('listSpecificServicesForOffering');
    const segment = svc.slice(idx, idx + 4000);
    expect(segment).toContain('isActive:');
  });

  it('inclusions and exclusions are parsed to arrays', () => {
    const idx = svc.indexOf('listSpecificServicesForOffering');
    const segment = svc.slice(idx, idx + 4000);
    expect(segment).toContain('inclusions:');
    expect(segment).toContain('exclusions:');
  });
});
