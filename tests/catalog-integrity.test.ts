/**
 * Hierarchy integrity rules, against fixtures that DELIBERATELY contain each
 * defect.
 *
 * A checker only ever exercised on healthy data is a checker nobody knows
 * works. Every rule here gets a positive fixture that must be caught and a
 * negative one that must not be — the same discipline the route-shadow scanner
 * needed, for the same reason.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' } }));
jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
  pool: { connect: jest.fn(), end: jest.fn() },
}));

import { evaluate, buildReport, type CatalogSnapshot } from '../src/services/catalogIntegrityService';

const HEALTHY: CatalogSnapshot = {
  categories: [
    { id: 3, name: 'Personal Care', slug: 'personal-care', status: 'active' },
    { id: 5, name: 'Home Services', slug: 'home-services', status: 'active' },
  ],
  subcategories: [
    { id: 7, category_id: 3, name: 'Facial Care', slug: 'facial-care', status: 'active' },
    { id: 8, category_id: 3, name: 'Massage', slug: 'massage', status: 'active' },
    // Same SLUG as subcategory 8 but under a different Category — legal,
    // because subcategory slugs are unique per category, not globally.
    { id: 9, category_id: 5, name: 'Massage Chairs', slug: 'massage', status: 'active' },
  ],
  services: [
    { id: 15, subcategory_id: 7, name: 'Facial', slug: 'facial', status: 'active', updated_at: '2026-08-11T00:00:00Z', legacy_service_option_id: 15 },
    { id: 16, subcategory_id: 8, name: 'Swedish', slug: 'swedish', status: 'active', updated_at: '2026-08-11T00:00:00Z', legacy_service_option_id: 16 },
  ],
  knownOptionIds: [15, 16, 6],
};

const codes = (snapshot: CatalogSnapshot) => evaluate(snapshot).map((f) => f.code).sort();
const withServices = (extra: CatalogSnapshot['services']): CatalogSnapshot => ({
  ...HEALTHY,
  services: [...HEALTHY.services, ...extra],
});

describe('a healthy catalog produces no findings', () => {
  it('finds nothing wrong with the fixture', () => {
    expect(evaluate(HEALTHY)).toEqual([]);
  });

  it('allows two subcategories to share a slug under DIFFERENT categories', () => {
    // Slug uniqueness is NOT uniform: category and service slugs are global,
    // subcategory slugs are per-category. A single global check would report
    // this legal pair as a duplicate.
    expect(codes(HEALTHY)).not.toContain('DUPLICATE_SUBCATEGORY_SLUG');
  });

  it('reports healthy and exits clean', () => {
    const report = buildReport(HEALTHY, '2026-08-12T00:00:00.000Z');
    expect(report.healthy).toBe(true);
    expect(report.errors).toBe(0);
    expect(report.counts).toEqual({ categories: 2, subcategories: 3, services: 2 });
  });
});

describe('orphans', () => {
  it('catches a Subcategory whose Category does not exist', () => {
    const snapshot: CatalogSnapshot = {
      ...HEALTHY,
      subcategories: [...HEALTHY.subcategories, { id: 99, category_id: 404, name: 'Ghost', slug: 'ghost', status: 'active' }],
    };
    const finding = evaluate(snapshot).find((f) => f.code === 'ORPHAN_SUBCATEGORY');
    expect(finding).toBeDefined();
    expect(finding!.ref).toBe('subcategory:99');
    expect(finding!.severity).toBe('error');
  });

  it('catches a Service whose Subcategory does not exist', () => {
    const snapshot = withServices([
      { id: 77, subcategory_id: 404, name: 'Lost', slug: 'lost', status: 'active', updated_at: 'x', legacy_service_option_id: null },
    ]);
    const finding = evaluate(snapshot).find((f) => f.code === 'ORPHAN_SERVICE');
    expect(finding?.ref).toBe('service:77');
    expect(finding?.severity).toBe('error');
  });

  it('does not double-report an orphan Service as visible-under-hidden', () => {
    // Its parent does not exist, so there is no parent status to judge. A
    // second finding here would be noise on top of the real one.
    const snapshot = withServices([
      { id: 77, subcategory_id: 404, name: 'Lost', slug: 'lost', status: 'active', updated_at: 'x', legacy_service_option_id: null },
    ]);
    expect(codes(snapshot).filter((c) => c === 'VISIBLE_UNDER_HIDDEN')).toEqual([]);
  });
});

describe('duplicates', () => {
  it('catches two Categories sharing a slug', () => {
    const snapshot: CatalogSnapshot = {
      ...HEALTHY,
      categories: [...HEALTHY.categories, { id: 6, name: 'Personal Care Again', slug: 'personal-care', status: 'active' }],
    };
    expect(codes(snapshot)).toContain('DUPLICATE_CATEGORY_SLUG');
  });

  it('catches two Subcategories sharing a slug WITHIN one Category', () => {
    const snapshot: CatalogSnapshot = {
      ...HEALTHY,
      subcategories: [...HEALTHY.subcategories, { id: 10, category_id: 3, name: 'Massage Two', slug: 'massage', status: 'active' }],
    };
    const finding = evaluate(snapshot).find((f) => f.code === 'DUPLICATE_SUBCATEGORY_SLUG');
    expect(finding?.ref).toBe('subcategory:10');
  });

  it('catches two Services sharing a slug globally', () => {
    const snapshot = withServices([
      { id: 18, subcategory_id: 8, name: 'Facial Copy', slug: 'facial', status: 'active', updated_at: 'x', legacy_service_option_id: 6 },
    ]);
    expect(codes(snapshot)).toContain('DUPLICATE_SERVICE_SLUG');
  });

  it('treats a duplicate NAME as a warning, not an error', () => {
    // Two "Massage" subcategories under one category is a content problem for a
    // human to resolve, not a reason to refuse a deploy.
    const snapshot: CatalogSnapshot = {
      ...HEALTHY,
      subcategories: [...HEALTHY.subcategories, { id: 11, category_id: 3, name: 'massage', slug: 'massage-2', status: 'active' }],
    };
    const finding = evaluate(snapshot).find((f) => f.code === 'DUPLICATE_SUBCATEGORY_NAME');
    expect(finding?.severity).toBe('warning');
    expect(buildReport(snapshot, 'x').healthy).toBe(true);
  });

  it('compares slugs case-insensitively', () => {
    const snapshot: CatalogSnapshot = {
      ...HEALTHY,
      categories: [...HEALTHY.categories, { id: 6, name: 'Shouty', slug: 'PERSONAL-CARE', status: 'active' }],
    };
    expect(codes(snapshot)).toContain('DUPLICATE_CATEGORY_SLUG');
  });
});

describe('legacy linkage', () => {
  it('catches a Service pointing at a service_options row that does not exist', () => {
    // Add-ons join through this column, so a dangling one produces a Service
    // with silently no add-ons rather than an error.
    const snapshot = withServices([
      { id: 19, subcategory_id: 7, name: 'Dangler', slug: 'dangler', status: 'active', updated_at: 'x', legacy_service_option_id: 9999 },
    ]);
    const finding = evaluate(snapshot).find((f) => f.code === 'DANGLING_LEGACY_OPTION');
    expect(finding?.ref).toBe('service:19');
    expect(finding?.severity).toBe('error');
  });

  it('accepts a NULL legacy id — an Admin-created Service has no legacy option', () => {
    const snapshot = withServices([
      { id: 100001, subcategory_id: 7, name: 'Brand New', slug: 'brand-new', status: 'active', updated_at: 'x', legacy_service_option_id: null },
    ]);
    expect(codes(snapshot)).not.toContain('DANGLING_LEGACY_OPTION');
  });
});

describe('visibility and timestamps', () => {
  it('flags an active Service under an inactive Subcategory', () => {
    const snapshot: CatalogSnapshot = {
      ...HEALTHY,
      subcategories: HEALTHY.subcategories.map((sc) => (sc.id === 7 ? { ...sc, status: 'inactive' } : sc)),
    };
    const finding = evaluate(snapshot).find((f) => f.code === 'VISIBLE_UNDER_HIDDEN');
    expect(finding?.ref).toBe('service:15');
    expect(finding?.detail).toContain('subcategory:7');
    expect(finding?.severity).toBe('warning');
  });

  it('flags an active Service under an inactive Category', () => {
    const snapshot: CatalogSnapshot = {
      ...HEALTHY,
      categories: HEALTHY.categories.map((c) => (c.id === 3 ? { ...c, status: 'inactive' } : c)),
    };
    const finding = evaluate(snapshot).find((f) => f.code === 'VISIBLE_UNDER_HIDDEN');
    expect(finding?.detail).toContain('category:3');
  });

  it('does not flag an INACTIVE Service under an inactive parent', () => {
    // Consistent, and therefore not a finding.
    const snapshot: CatalogSnapshot = {
      ...HEALTHY,
      categories: HEALTHY.categories.map((c) => (c.id === 3 ? { ...c, status: 'inactive' } : c)),
      services: HEALTHY.services.map((sv) => ({ ...sv, status: 'inactive' })),
    };
    expect(codes(snapshot)).not.toContain('VISIBLE_UNDER_HIDDEN');
  });

  it('flags a NULL updated_at, which would contribute nothing to the catalog ETag', () => {
    const snapshot = withServices([
      { id: 22, subcategory_id: 7, name: 'Stamped', slug: 'stamped', status: 'active', updated_at: null, legacy_service_option_id: 6 },
    ]);
    const finding = evaluate(snapshot).find((f) => f.code === 'MISSING_TIMESTAMP');
    expect(finding?.ref).toBe('service:22');
    expect(finding?.severity).toBe('warning');
  });
});

describe('the report gates on errors only', () => {
  it('is unhealthy when any error exists', () => {
    const snapshot = withServices([
      { id: 77, subcategory_id: 404, name: 'Lost', slug: 'lost', status: 'active', updated_at: 'x', legacy_service_option_id: null },
    ]);
    const report = buildReport(snapshot, 'x');
    expect(report.healthy).toBe(false);
    expect(report.errors).toBeGreaterThan(0);
  });

  it('stays healthy with warnings only', () => {
    const snapshot = withServices([
      { id: 22, subcategory_id: 7, name: 'Stamped', slug: 'stamped', status: 'active', updated_at: null, legacy_service_option_id: 6 },
    ]);
    const report = buildReport(snapshot, 'x');
    expect(report.warnings).toBeGreaterThan(0);
    expect(report.healthy).toBe(true);
  });

  it('every finding carries a qualified ref, so it names one row unambiguously', () => {
    const snapshot = withServices([
      { id: 19, subcategory_id: 7, name: 'Dangler', slug: 'dangler', status: 'active', updated_at: null, legacy_service_option_id: 9999 },
    ]);
    for (const finding of evaluate(snapshot)) {
      expect(finding.ref).toMatch(/^(category|subcategory|service):\d+$/);
    }
  });
});
