/**
 * The catalog contract, and the certification bar.
 *
 * The bar for this command is specific: **do not certify if a canonical
 * customer or provider path can interpret the same identifier as two different
 * service concepts.** That is not a slogan, it is a checkable property, and
 * most of this file checks it.
 *
 * Four different things in this platform are called a "service id":
 *
 *   `services.id`             the canonical Specific Service
 *   `service_families.id`     the legacy coarse family
 *   `service_options.id`      a legacy option or an add-on
 *   `catalog_subcategories.id`
 *
 * Three are integers in overlapping ranges, and `GET /api/services/:serviceId/level2`
 * and `GET /api/v1/catalog/services/:serviceId` both accept the integer `3` and
 * answer about different things. The canonical namespace has to be provably
 * free of that, and the ambiguity between namespaces has to be documented.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' } }));
jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
  pool: { connect: jest.fn() },
}));

import fs from 'fs';
import path from 'path';
import { V1_CONTRACT, fullPath, type ContractEntry } from '../src/api/v1/contract';
import { SCHEMAS } from '../src/api/v1/openapi';
import { makeRef, parseRef, REF_TYPES } from '../src/services/catalogPublicService';
import { handlers as catalogHandlers } from '../src/api/v1/domains/catalog';

const REPO = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');

/**
 * Source with comments removed.
 *
 * "This module never queries service_families" cannot be checked against raw
 * text: the docblock explaining WHY it never does contains the words. The first
 * version of these assertions failed on their own explanation, which is a
 * detector that cannot tell code from prose — and the prose is the part that
 * should be allowed to name the thing.
 */
const code = (rel: string): string =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');

const CATALOG_ENTRIES = V1_CONTRACT.filter((e) => e.domain === 'catalog' || e.domain === 'search');
const catalogService = code('src/services/catalogPublicService.ts');
const searchService = code('src/services/catalogSearchService.ts');

// ─── The certification bar ────────────────────────────────────────────────────

describe('no canonical path reads one identifier as two service concepts', () => {
  /** Every path parameter across the canonical catalog surface. */
  const PARAMS = CATALOG_ENTRIES.flatMap((e) =>
    (e.params ?? []).map((p) => ({ entry: e, param: p })),
  );

  it('the canonical surface uses exactly three parameter names', () => {
    expect([...new Set(PARAMS.map((p) => p.param.name))].sort()).toEqual([
      'categoryId',
      'serviceId',
      'subcategoryId',
    ]);
  });

  it('each parameter name means ONE thing across every canonical endpoint', () => {
    // The failure this prevents: `serviceId` meaning services.id on one route
    // and service_families.id on another, inside the same namespace.
    const byName = new Map<string, Set<string>>();
    for (const { entry, param } of PARAMS) {
      const service = entry.domainService;
      if (!byName.has(param.name)) byName.set(param.name, new Set());
      byName.get(param.name)!.add(service.includes('catalogPublicService') ? 'catalogPublicService' : service);
    }
    for (const [, services] of byName) expect(services.size).toBe(1);
  });

  it('every canonical id parameter documents the table it resolves against', () => {
    for (const { param } of PARAMS) {
      expect(param.description).toMatch(/catalog_categories\.id|catalog_subcategories\.id|services\.id/);
    }
  });

  it('NO canonical endpoint resolves a service_families.id or a service_options.id', () => {
    for (const { param } of PARAMS) {
      expect(param.description).not.toMatch(/service_families\.id\b(?!\s*\.)/);
      expect(param.description.replace(/NOT a service_families\.id/, '')).not.toContain('service_families.id');
      expect(param.description).not.toContain('service_options.id');
    }
  });

  it('the canonical read model never queries service_families', () => {
    // Catalog V2 exists to stop `service_families` being the customer-facing
    // bookable identity. A canonical read touching that table would reverse it.
    expect(catalogService).not.toContain('service_families');
    expect(searchService).not.toContain('service_families');
  });

  it('the canonical read model touches service_options ONLY as an add-on join', () => {
    const optionMentions = catalogService.split('\n').filter((l) => l.includes('service_options') && !l.trim().startsWith('*'));
    expect(optionMentions.length).toBeGreaterThan(0);
    for (const line of optionMentions) {
      // The single legitimate use: reading add-ons by parent_option_id.
      expect(line).toMatch(/FROM \$\{dbSchema\}\.service_options/);
    }
    expect(catalogService).toContain('parent_option_id');
    expect(searchService).not.toContain('service_options');
  });

  it('legacy_service_option_id is a join key and is never projected', () => {
    // Selecting it is required — add-ons join through it. Returning it would
    // hand a client an id from a different namespace with no way to know.
    expect(catalogService).toContain('s.legacy_service_option_id');
    expect(catalogService).not.toMatch(/legacyServiceOptionId\s*:/);
  });
});

describe('qualified references make every id self-describing', () => {
  it('covers all four entity kinds', () => {
    expect([...REF_TYPES].sort()).toEqual(['addon', 'category', 'service', 'subcategory']);
  });

  it('round-trips', () => {
    for (const type of REF_TYPES) {
      expect(parseRef(makeRef(type, 42))).toEqual({ type, id: 42 });
    }
  });

  it('refuses anything that is not a canonical reference', () => {
    for (const bad of ['180', 'service:', ':180', 'family:3', 'service:0', 'service:-1', 'service:abc', 'service:1:2', '', null, 7]) {
      expect(parseRef(bad as unknown)).toBeNull();
    }
  });

  it('a Service ref and an add-on ref with the same number are different references', () => {
    // The whole point. `service_options` ids and `services` ids happen not to
    // collide today because of how the migration ran — a property nothing
    // enforces. The ref does not depend on that accident.
    expect(makeRef('service', 130)).not.toBe(makeRef('addon', 130));
    expect(parseRef('service:130')!.type).not.toBe(parseRef('addon:130')!.type);
  });

  it('the DTO requires a ref on every entity that carries an id', () => {
    for (const name of ['CatalogService', 'CategorySummary', 'SubcategorySummary', 'SearchHit']) {
      const schema = SCHEMAS[name] as any;
      expect(schema.required).toContain('ref');
      expect(schema.properties.ref).toBeDefined();
    }
  });

  it('the ref pattern in the spec matches what the code emits', () => {
    const pattern = new RegExp((SCHEMAS.CatalogRef as any).pattern);
    for (const type of REF_TYPES) expect(pattern.test(makeRef(type, 1))).toBe(true);
    expect(pattern.test('family:1')).toBe(false);
  });
});

// ─── The deployed DTO is frozen ───────────────────────────────────────────────

describe('the production-certified Catalog V2 DTO is preserved', () => {
  /** Fields the deployed contract carries. Removing or renaming one is breaking. */
  const FROZEN_SERVICE_FIELDS = [
    'id', 'subcategoryId', 'subcategoryName', 'categoryId', 'categoryName',
    'name', 'slug', 'shortDescription', 'imageUrl', 'status', 'displayOrder',
    'bookable', 'basePrice', 'unit', 'basePriceSummary', 'estimatedDurationMins', 'updatedAt',
  ];

  it('every frozen Service field is still declared', () => {
    for (const field of FROZEN_SERVICE_FIELDS) {
      expect(catalogService).toMatch(new RegExp(`\\n\\s+${field}[?]?:`));
    }
  });

  it('displayOrder, status and bookable are returned everywhere they apply', () => {
    // The command asks for these three specifically, and they are the ones a
    // client silently does without: an absent `bookable` reads as "not
    // bookable" in most template engines.
    expect(catalogService).toMatch(/displayOrder: Number\(r\.display_order\)/);
    expect(catalogService).toMatch(/status: r\.status/);
    expect(catalogService).toMatch(/bookable: Boolean\(r\.bookable\)/);
  });

  it('timestamps go through the ISO normaliser', () => {
    // Postgres emits `2026-08-11 11:03:23.421016+00` — a space where ISO wants
    // T, and a two-digit offset. Repairing only the separator returns NaN and
    // falls through to the raw value, so both deviations must be fixed together.
    expect(catalogService).toContain("candidate = raw.replace(' ', 'T')");
    expect(catalogService).toContain("candidate.replace(/([+-]\\d{2})$/, '$1:00')");
    expect(catalogService).toContain('updatedAt: toIso(r.updated_at)');
  });

  it('nothing Admin-only is projected', () => {
    for (const forbidden of ['providerCount', 'archived_at', 'catalog_provider_services', 'legacyServiceFamilyId']) {
      expect(catalogService).not.toContain(forbidden);
    }
  });
});

// ─── Parity exemption ─────────────────────────────────────────────────────────

describe('the canonical namespace is exempt from name→level2 rewriting', () => {
  const appTs = read('src/app.ts');

  it('both /api/v1 and /api/catalog are exempt', () => {
    const list = /CANONICAL_CONTRACT_PREFIXES\s*=\s*\[([^\]]*)\]/.exec(appTs)![1];
    expect(list).toContain('/api/v1');
    expect(list).toContain('/api/catalog');
    expect(list).toContain('/api/admin/catalog');
  });

  it('the Service schema states that level2 never appears', () => {
    // Parity maps `name` → `level2`, and in the legacy model `level2` means the
    // SUBCATEGORY — so a canonical Service came back claiming its own name as
    // its subcategory. A production smoke found it; no unit test could.
    expect((SCHEMAS.CatalogService as any).description).toMatch(/level2/);
  });

  it('no canonical catalog response type declares a level field', () => {
    for (const name of ['CatalogService', 'CategorySummary', 'SubcategorySummary', 'SearchHit']) {
      expect(Object.keys((SCHEMAS[name] as any).properties ?? {})).not.toContain('level2');
      expect(Object.keys((SCHEMAS[name] as any).properties ?? {})).not.toContain('level3');
    }
  });

  it('the taxonomy is exposed as Category/Subcategory/Service, never Level 1/2/3', () => {
    for (const entry of CATALOG_ENTRIES) {
      expect(entry.path).not.toMatch(/level\d/i);
      expect(entry.responseSchema).not.toMatch(/level/i);
    }
  });
});

// ─── Search ───────────────────────────────────────────────────────────────────

describe('search is one implementation behind two paths', () => {
  it('both search entries name the same domain service', () => {
    const byId = (id: string) => V1_CONTRACT.find((e) => e.id === id) as ContractEntry;
    expect(byId('search.query').domainService).toBe(byId('catalog.search').domainService);
  });

  it('both handlers exist and delegate to the same shared function', () => {
    // Two paths is a naming convenience the command asked for. Two
    // implementations would be two search behaviours wearing one name.
    const source = read('src/api/v1/domains/catalog.ts');
    expect(source).toContain("'search.query': async (req, res) => runSearch(req, res, 'search.query')");
    expect(source).toContain("'catalog.search': async (req, res) => runSearch(req, res, 'catalog.search')");
    expect(typeof catalogHandlers['search.query']).toBe('function');
    expect(typeof catalogHandlers['catalog.search']).toBe('function');
  });

  it('every search hit type is a catalog entity, never a provider or a booking', () => {
    const hit = SCHEMAS.SearchHit as any;
    expect(hit.properties.type.enum).toEqual(['category', 'subcategory', 'service']);
  });
});

// ─── Legacy accounting ────────────────────────────────────────────────────────

describe('every legacy catalog route is accounted for', () => {
  const claimed = new Set<string>();
  for (const entry of V1_CONTRACT) {
    for (const l of entry.legacy) claimed.add(`${l.method.toUpperCase()} ${l.path}`);
  }

  it.each([
    'GET /api/services/full',
    'GET /api/services/:serviceId/level2',
    'GET /api/services/:serviceId/options-with-addons',
    'GET /api/:serviceId/options-with-addons',
    'GET /api/catalog',
    'GET /api/catalog/summary',
    'GET /api/catalog/services',
    'GET /api/catalog/services/:serviceId',
  ])('%s is claimed by a canonical successor', (route) => {
    expect(claimed.has(route)).toBe(true);
  });

  it('the level2 route is CANONICALIZE, not a rename', () => {
    // Its `:serviceId` is a family id and it returns DISTINCT strings with no
    // ids at all. Calling the new route a rename of it would be false.
    const entry = V1_CONTRACT.find((e) => e.id === 'catalog.categories.subcategories')!;
    const legacy = entry.legacy.find((l) => l.path === '/api/services/:serviceId/level2')!;
    expect(legacy.disposition).toBe('CANONICALIZE');
    expect(legacy.note).toContain('service_families.id');
  });

  it('the un-prefixed options route is kept as a temporary alias for ServanaWorker', () => {
    const entry = V1_CONTRACT.find((e) => e.id === 'catalog.subcategories.services')!;
    const legacy = entry.legacy.find((l) => l.path === '/api/:serviceId/options-with-addons')!;
    expect(legacy.disposition).toBe('ALIAS_TEMPORARILY');
    expect(legacy.note).toContain('ServanaWorker');
  });

  it('the generated catalog registry exists and names every canonical path', () => {
    const registry = read('docs/api/CATALOG_ENDPOINT_REGISTRY.md');
    for (const entry of CATALOG_ENTRIES) expect(registry).toContain(fullPath(entry));
    expect(registry).toContain('service_families.id');
  });
});
