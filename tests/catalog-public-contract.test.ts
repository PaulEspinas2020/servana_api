/**
 * PUBLIC CATALOG V2 — contract tests.
 *
 * This is the surface the Flutter clients migrate onto, so these pin the
 * properties the Client App is entitled to rely on, and the two production
 * defects that only a live smoke found:
 *
 *   - `level2` never appears (the parity defect: `name` → `level2` made a
 *     Service claim its own name as its Subcategory)
 *   - timestamps are ISO 8601 with a UTC designator, never Postgres' native
 *     `2026-08-11 11:03:23.421016+00`
 *
 * plus the boundaries that keep an unauthenticated route safe: browse shows
 * only `active` rows, detail resolves regardless of status so a deep link can
 * land somewhere honest, and nothing Admin-only or provider-identifying is
 * projected.
 */

jest.mock('../src/db/dbQuery', () => {
  const query = jest.fn();
  return { __esModule: true, default: { query }, pool: { connect: jest.fn() } };
});
jest.mock('../src/config', () => ({ db: { schema: 'servana' } }));

import fs from 'fs';
import path from 'path';
import dbQuery from '../src/db/dbQuery';
import * as svc from '../src/services/catalogPublicService';

const q = dbQuery.query as jest.Mock;

let issued: Array<{ sql: string; params: any[] }>;

beforeEach(() => {
  issued = [];
  q.mockReset();
});

/** Answer each statement by matching its SQL, recording everything issued. */
const respond = (rules: Array<[RegExp, any[]]>) => {
  q.mockImplementation(async (sql: string, params: any[] = []) => {
    issued.push({ sql, params });
    for (const [re, rows] of rules) if (re.test(sql)) return { rows, rowCount: rows.length };
    return { rows: [], rowCount: 0 };
  });
};

const CATEGORY_ROW = {
  id: 3, name: 'Personal Care', slug: 'personal-care',
  description: null, image_url: null, display_order: 0,
};
const SUBCATEGORY_ROW = {
  id: 7, category_id: 3, name: 'Facial', slug: 'facial',
  description: null, image_url: null, display_order: 0,
};
const SERVICE_ROW = {
  id: 15, subcategory_id: 7, name: 'Pimple Facial', slug: 'pimple-facial',
  short_description: null, image_url: null, status: 'active',
  display_order: 0, bookable: true, base_price: '1500', unit: 'per session',
  estimated_duration_mins: 60,
  // Deliberately the raw Postgres shape, which is what this pool hands back
  // for these columns.
  updated_at: '2026-08-11 11:03:23.421016+00',
  subcategory_name: 'Facial', category_id: 3, category_name: 'Personal Care',
};

const browseRules: Array<[RegExp, any[]]> = [
  [/FROM servana\.catalog_categories/, [CATEGORY_ROW]],
  [/FROM servana\.catalog_subcategories/, [SUBCATEGORY_ROW]],
  [/FROM servana\.services\s+s/, [SERVICE_ROW]],
];

// ─── Timestamps ──────────────────────────────────────────────────────────────

describe('ISO 8601 timestamps', () => {
  const { toIso } = svc.__test__;

  it('repairs BOTH Postgres deviations: the space and the two-digit offset', () => {
    // Repairing only the separator leaves `+00`, which `new Date()` rejects —
    // the helper then returns NaN and silently falls through to the raw value.
    // That is how the first version of this passed review and failed reality.
    expect(toIso('2026-08-11 11:03:23.421016+00')).toBe('2026-08-11T11:03:23.421Z');
  });

  it('passes through values that are already ISO', () => {
    expect(toIso('2026-05-28T03:51:24.270Z')).toBe('2026-05-28T03:51:24.270Z');
  });

  it('handles Date, null and undefined', () => {
    expect(toIso(new Date('2026-01-02T03:04:05.000Z'))).toBe('2026-01-02T03:04:05.000Z');
    expect(toIso(null)).toBeNull();
    expect(toIso(undefined)).toBeNull();
  });

  it('hands back an unparseable value rather than inventing a time', () => {
    expect(toIso('not a timestamp')).toBe('not a timestamp');
  });

  it('emits ISO through the real projection, not just the helper', async () => {
    respond(browseRules);
    const [category] = await svc.getPublicCatalog();
    const service = category.subcategories[0].services[0];
    expect(service.updatedAt).toBe('2026-08-11T11:03:23.421Z');
    expect(service.updatedAt).not.toContain(' ');
    expect(new Date(service.updatedAt!).getTime()).not.toBeNaN();
  });
});

// ─── The level2 parity regression ────────────────────────────────────────────

describe('level2 regression guard', () => {
  it('no catalog projection carries level2, level_2 or serviceName', async () => {
    respond(browseRules);
    const wire = JSON.stringify(await svc.getPublicCatalog());
    for (const banned of ['level2', 'level_2', 'level3', 'level_3', 'serviceName', 'service_name']) {
      expect(wire).not.toContain(`"${banned}"`);
    }
  });

  it('Subcategory comes from the hierarchy, and is NOT the Service name', async () => {
    respond(browseRules);
    const [category] = await svc.getPublicCatalog();
    const service = category.subcategories[0].services[0];
    // The exact defect: parity set level2 to the Service's own name. Here the
    // Subcategory is a different row reached through subcategoryId.
    expect(service.name).toBe('Pimple Facial');
    expect(service.subcategoryName).toBe('Facial');
    expect(service.subcategoryName).not.toBe(service.name);
    expect(service.subcategoryId).toBe(category.subcategories[0].id);
    expect(service.categoryId).toBe(category.id);
  });

  it('app.ts exempts the public catalog prefix from parity', () => {
    const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.ts'), 'utf8');
    expect(appSrc).toContain("'/api/catalog'");
    expect(appSrc).toMatch(/CANONICAL_CATALOG_PREFIXES[\s\S]{0,400}parityMiddleware/);
  });
});

// ─── Visibility ──────────────────────────────────────────────────────────────

describe('customer visibility', () => {
  it('browse filters every level to active — a draft category cannot leak', async () => {
    respond(browseRules);
    await svc.getPublicCatalog();
    const [cats, subs, services] = issued;
    expect(cats.sql).toMatch(/WHERE status = \$1/);
    expect(cats.params).toEqual(['active']);
    expect(subs.sql).toMatch(/WHERE status = \$1/);
    expect(subs.params).toEqual(['active']);
    // The service read must gate on all three, or a live Service under a
    // deactivated Category stays browsable.
    expect(services.sql).toMatch(/s\.status = \$1 AND sc\.status = \$1 AND c\.status = \$1/);
  });

  it('detail is NOT status-filtered, so an archived deep link still resolves', async () => {
    respond([[/FROM servana\.services\s+s/, [{
      ...SERVICE_ROW, status: 'archived', full_description: null,
      legacy_service_option_id: 15, subcategory_status: 'active',
      category_status: 'active', inclusions: [], exclusions: [],
    }]]]);
    const detail = await svc.getServiceDetail(15);
    expect(detail.id).toBe(15);
    expect(detail.status).toBe('archived');
    expect(detail.available).toBe(false);
    const [read] = issued;
    expect(read.sql).not.toMatch(/status = \$1/);
  });

  it('available folds in subcategory and category status, not just the service', async () => {
    const base = {
      ...SERVICE_ROW, full_description: null, legacy_service_option_id: 15,
      inclusions: [], exclusions: [],
    };
    const cases: Array<[any, boolean]> = [
      [{ subcategory_status: 'active', category_status: 'active' }, true],
      [{ subcategory_status: 'inactive', category_status: 'active' }, false],
      [{ subcategory_status: 'active', category_status: 'inactive' }, false],
    ];
    for (const [overrides, expected] of cases) {
      respond([[/FROM servana\.services\s+s/, [{ ...base, ...overrides }]]]);
      expect((await svc.getServiceDetail(15)).available).toBe(expected);
    }
  });

  it('a non-bookable but active service is not available', async () => {
    respond([[/FROM servana\.services\s+s/, [{
      ...SERVICE_ROW, bookable: false, full_description: null,
      legacy_service_option_id: 15, subcategory_status: 'active',
      category_status: 'active', inclusions: [], exclusions: [],
    }]]]);
    expect((await svc.getServiceDetail(15)).available).toBe(false);
  });

  it('a missing service is a safe 404, not a crash', async () => {
    respond([]);
    await expect(svc.getServiceDetail(999999)).rejects.toMatchObject({
      statusCode: 404, code: 'NOT_FOUND',
    });
  });
});

// ─── Leak boundary ───────────────────────────────────────────────────────────

describe('leak boundary', () => {
  it('never projects provider counts, legacy provenance or admin metadata', async () => {
    respond(browseRules);
    const wire = JSON.stringify(await svc.getPublicCatalog());
    for (const banned of [
      'providerCount', 'provider_count', 'legacyServiceOptionId',
      'legacy_service_option_id', 'legacyServiceFamilyId',
      'legacy_service_family_id', 'archivedAt', 'archived_at', 'providerUid',
    ]) {
      expect(wire).not.toContain(banned);
    }
  });

  it('never reads catalog_provider_services', async () => {
    respond(browseRules);
    await svc.getPublicCatalog();
    for (const s of issued) expect(s.sql).not.toContain('catalog_provider_services');
  });

  it('detail uses the legacy option id only as an add-on join key, never a field', async () => {
    respond([
      [/FROM servana\.services\s+s/, [{
        ...SERVICE_ROW, full_description: 'Full copy', legacy_service_option_id: 15,
        subcategory_status: 'active', category_status: 'active',
        inclusions: ['Consultation'], exclusions: ['Products'],
      }]],
      [/FROM servana\.service_options/, [{
        id: 6, level_3: 'Vitamin C', unit: 'per session',
        base_price: '500', duration_mins: 15,
      }]],
    ]);
    const detail = await svc.getServiceDetail(15);
    expect(JSON.stringify(detail)).not.toContain('legacy');
    expect(detail.addons).toEqual([{
      id: 6, name: 'Vitamin C', unit: 'per session',
      basePrice: 500, basePriceSummary: '₱500 / per session', durationMins: 15,
    }]);
    expect(detail.inclusions).toEqual(['Consultation']);
    // The add-on read joins on the legacy option id, which is the whole reason
    // that column is selected.
    expect(issued[1].params).toEqual([15]);
  });
});

// ─── Router shape ────────────────────────────────────────────────────────────

describe('router', () => {
  const routeSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'catalogPublic.routes.ts'), 'utf8');

  it('is read-only — an unauthenticated router cannot satisfy §12', () => {
    for (const verb of ['post', 'put', 'patch', 'delete']) {
      expect(routeSrc).not.toContain(`router.${verb}(`);
    }
  });

  it('declares the literal paths before the parameterised one', () => {
    const at = (p: string) => routeSrc.indexOf(p);
    expect(at('"/catalog/summary"')).toBeLessThan(at('"/catalog/services/:serviceId"'));
    expect(at('"/catalog/services"')).toBeLessThan(at('"/catalog/services/:serviceId"'));
  });
});

// ─── Booking dual-write ──────────────────────────────────────────────────────

describe('bookings.catalog_service_id dual-write', () => {
  const bookingSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'bookingService.ts'), 'utf8');

  it('writes the canonical column on create', () => {
    expect(bookingSrc).toMatch(/INSERT INTO \$\{dbSchema\}\.bookings[\s\S]{0,300}catalog_service_id/);
  });

  it('resolves through legacy_service_option_id rather than copying the param', () => {
    // Canonical services.id EQUALS the legacy option id for all 95 promoted
    // rows today, so `catalog_service_id = $3` would pass every current test
    // and write a dangling id for the first Admin-created Service, whose id
    // comes from the sequence and has no legacy option.
    expect(bookingSrc).toMatch(
      /SELECT s\.id FROM \$\{dbSchema\}\.services s WHERE s\.legacy_service_option_id = \$3/);
  });

  it('leaves service_option_id authoritative and untouched', () => {
    expect(bookingSrc).toMatch(/INSERT INTO \$\{dbSchema\}\.bookings[\s\S]{0,200}service_option_id/);
  });
});
