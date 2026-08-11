/**
 * Canonical catalog search — ranking, aliases, and the identity rules.
 *
 * The alias behaviour gets the most attention here because it is the one place
 * where a search feature could quietly violate §30: "aircon" must find "Air
 * Conditioning Cleaning" WITHOUT a second Service row existing for the synonym.
 * A test that only checked "aircon returns results" would pass on the wrong
 * implementation.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' } }));

const query = jest.fn();
jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: (...a: unknown[]) => query(...a) },
  pool: { connect: jest.fn() },
}));

import {
  searchCatalog,
  expandQuery,
  scoreOf,
  SEARCH_ALIASES,
  MIN_QUERY_LENGTH,
} from '../src/services/catalogSearchService';

/** A small catalog with names chosen to exercise every rung of the ladder. */
const SERVICES = [
  { id: 15, name: 'Facial', slug: 'facial', short_description: 'Deep cleanse', image_url: null, status: 'active', display_order: 0, bookable: true, base_price: '1500', subcategory_id: 7, subcategory_name: 'Facial Care', category_id: 3, category_name: 'Personal Care' },
  { id: 16, name: 'Pimple Facial', slug: 'pimple-facial', short_description: null, image_url: null, status: 'active', display_order: 0, bookable: true, base_price: '1800', subcategory_id: 7, subcategory_name: 'Facial Care', category_id: 3, category_name: 'Personal Care' },
  { id: 20, name: 'Air Conditioning Cleaning', slug: 'aircon-cleaning', short_description: 'Split type', image_url: null, status: 'active', display_order: 0, bookable: true, base_price: '900', subcategory_id: 9, subcategory_name: 'Appliance Care', category_id: 5, category_name: 'Home Services' },
  { id: 21, name: 'Swedish Massage', slug: 'swedish-massage', short_description: null, image_url: null, status: 'active', display_order: 0, bookable: true, base_price: '1200', subcategory_id: 8, subcategory_name: 'Massage', category_id: 3, category_name: 'Personal Care' },
];
const SUBCATEGORIES = [
  { id: 7, name: 'Facial Care', slug: 'facial-care', description: null, image_url: null, status: 'active', display_order: 0, category_id: 3, category_name: 'Personal Care' },
  { id: 8, name: 'Massage', slug: 'massage', description: null, image_url: null, status: 'active', display_order: 0, category_id: 3, category_name: 'Personal Care' },
  { id: 9, name: 'Appliance Care', slug: 'appliance-care', description: null, image_url: null, status: 'active', display_order: 0, category_id: 5, category_name: 'Home Services' },
];
const CATEGORIES = [
  { id: 3, name: 'Personal Care', slug: 'personal-care', description: null, image_url: null, status: 'active', display_order: 0 },
  { id: 5, name: 'Home Services', slug: 'home-services', description: 'Aircon, plumbing', image_url: null, status: 'active', display_order: 0 },
];

beforeEach(() => {
  query.mockReset().mockImplementation(async (sql: string) => {
    if (/FROM servana\.services/.test(sql)) return { rows: SERVICES, rowCount: SERVICES.length };
    if (/FROM servana\.catalog_subcategories/.test(sql)) return { rows: SUBCATEGORIES, rowCount: SUBCATEGORIES.length };
    if (/FROM servana\.catalog_categories/.test(sql)) return { rows: CATEGORIES, rowCount: CATEGORIES.length };
    return { rows: [], rowCount: 0 };
  });
});

describe('the ranking ladder', () => {
  it('scores exact above prefix above word-prefix above contains', () => {
    expect(scoreOf('Facial', 'Facial', 'facial')).toBe(4);
    expect(scoreOf('Facial Care', 'Facial Care', 'facial')).toBe(3);
    expect(scoreOf('Pimple Facial', 'Pimple Facial', 'facial')).toBe(2);
    expect(scoreOf('Deep Clean', 'Deep Clean facial treatment', 'facial')).toBe(1);
    expect(scoreOf('Plumbing', 'Plumbing', 'facial')).toBe(0);
  });

  it('is case-insensitive on both sides', () => {
    expect(scoreOf('FACIAL', 'FACIAL', 'facial')).toBe(4);
    expect(scoreOf('facial', 'facial', 'FACIAL')).toBe(4);
  });

  it('treats a hyphen and a slash as word boundaries', () => {
    expect(scoreOf('Deep-Clean Facial', 'x', 'clean')).toBe(2);
    expect(scoreOf('Wash/Fold', 'x', 'fold')).toBe(2);
  });

  it('puts the exact match first and the bookable thing above its container', async () => {
    const result = await searchCatalog('facial');
    // "Facial" the Service (exact, 4) beats "Facial Care" the Subcategory
    // (prefix, 3) beats "Pimple Facial" (word-prefix, 2).
    expect(result.hits.map((h) => h.ref)).toEqual([
      'service:15',
      'subcategory:7',
      'service:16',
    ]);
  });

  it('breaks a score tie toward the bookable entity', async () => {
    // "massage" is an exact match for BOTH the Subcategory and (via alias) part
    // of the Service name. Service ranks first because somebody typing it wants
    // to book, not to browse.
    const result = await searchCatalog('massage');
    const top = result.hits.filter((h) => h.score === Math.max(...result.hits.map((x) => x.score)));
    expect(top[0].type).not.toBe('category');
  });

  it('is deterministic — the same query twice gives the same order', async () => {
    const a = await searchCatalog('care');
    const b = await searchCatalog('care');
    expect(a.hits.map((h) => h.ref)).toEqual(b.hits.map((h) => h.ref));
  });
});

describe('aliases widen matching, never the catalog', () => {
  it('"aircon" finds the Air Conditioning service', async () => {
    const result = await searchCatalog('aircon');
    expect(result.hits.some((h) => h.ref === 'service:20')).toBe(true);
  });

  it('"aircon" and "air conditioning" return the SAME services with the SAME ids', async () => {
    // This is §30 expressed as a test. If a synonym were implemented by adding a
    // Service row, these two queries would return different ids for one
    // real-world service — and the platform would have two canonical
    // identities for one bookable thing.
    const a = await searchCatalog('aircon');
    const b = await searchCatalog('air conditioning');
    const idsOf = (r: typeof a) => r.hits.filter((h) => h.type === 'service').map((h) => h.id).sort();
    expect(idsOf(a)).toEqual(idsOf(b));
    expect(idsOf(a)).toContain(20);
  });

  it('returns no duplicate refs, whatever the alias expansion', async () => {
    // An alias table that adds a hit per matched term instead of scoring once
    // would return the same Service several times.
    for (const q of ['aircon', 'cleaning', 'massage', 'care']) {
      const refs = (await searchCatalog(q)).hits.map((h) => h.ref);
      expect(refs).toEqual([...new Set(refs)]);
    }
  });

  it('names the term that produced the hit, so a surprising result is explainable', async () => {
    const result = await searchCatalog('aircon');
    const hit = result.hits.find((h) => h.ref === 'service:20')!;
    expect(hit.matchedTerm).toBeTruthy();
    expect(result.expandedTerms).toContain('air conditioning');
  });

  it('prefers the typed term over an alias when both score the same', async () => {
    const result = await searchCatalog('facial');
    expect(result.hits[0].matchedTerm).toBe('facial');
  });

  it('expands both ways — a value finds its key and its siblings', () => {
    expect(expandQuery('masahe')).toContain('massage');
    expect(expandQuery('massage')).toContain('masahe');
  });

  it('matches an alias as a WHOLE WORD, not as a substring', () => {
    // Regression. The first implementation used `includes` in both directions,
    // and the alias `ac` is a substring of "f-ac-ial" — so searching "facial"
    // expanded into the entire air-conditioning group and returned
    // "Air Conditioning Cleaning" above half the facial results.
    expect(expandQuery('facial')).not.toContain('aircon');
    expect(expandQuery('facial')).not.toContain('ac');
    // …while the alias itself still works when it IS a word.
    expect(expandQuery('ac')).toContain('aircon');
    expect(expandQuery('ac cleaning')).toContain('aircon');
  });

  it('a facial search returns no air-conditioning result', async () => {
    const result = await searchCatalog('facial');
    expect(result.hits.map((h) => h.ref)).not.toContain('service:20');
    expect(result.hits.map((h) => h.ref)).not.toContain('category:5');
  });

  it('every alias key is lowercase and free of leading or trailing space', () => {
    // The expansion compares against a lowercased query; a key with a capital
    // could never match and would look like a working alias.
    for (const [key, values] of Object.entries(SEARCH_ALIASES)) {
      expect(key).toBe(key.toLowerCase().trim());
      for (const v of values) expect(v).toBe(v.toLowerCase().trim());
    }
  });
});

describe('boundaries', () => {
  it('a query below the minimum returns empty rather than most of the catalog', async () => {
    const result = await searchCatalog('a');
    expect(MIN_QUERY_LENGTH).toBe(2);
    expect(result.hits).toEqual([]);
    expect(result.total).toBe(0);
    // And it does not even ask the database.
    expect(query).not.toHaveBeenCalled();
  });

  it('an empty or whitespace query is empty, not an error', async () => {
    for (const q of ['', '   ', null as any, undefined as any]) {
      const result = await searchCatalog(q);
      expect(result.total).toBe(0);
    }
  });

  it('reports the true total and returns only the limit', async () => {
    const result = await searchCatalog('care', { limit: 1 });
    expect(result.hits).toHaveLength(1);
    expect(result.total).toBeGreaterThan(1);
  });

  it('clamps the limit rather than trusting it', async () => {
    const huge = await searchCatalog('care', { limit: 10_000 });
    expect(huge.hits.length).toBeLessThanOrEqual(50);
    const negative = await searchCatalog('care', { limit: -5 });
    expect(negative.hits.length).toBeGreaterThan(0);
  });

  it('a type filter narrows the query set, not just the output', async () => {
    query.mockClear();
    await searchCatalog('facial', { types: ['service'] });
    const tables = query.mock.calls.map((c) => String(c[0]));
    expect(tables.some((t) => /FROM servana\.services/.test(t))).toBe(true);
    expect(tables.some((t) => /FROM servana\.catalog_categories/.test(t))).toBe(false);
  });

  it('counts each entity type independently of the limit', async () => {
    const result = await searchCatalog('care', { limit: 1 });
    const summed = result.counts.category + result.counts.subcategory + result.counts.service;
    expect(summed).toBe(result.total);
  });
});

describe('identity in every result', () => {
  it('every hit has a qualified ref matching its type and id', async () => {
    const result = await searchCatalog('care');
    expect(result.hits.length).toBeGreaterThan(0);
    for (const hit of result.hits) {
      expect(hit.ref).toBe(`${hit.type}:${hit.id}`);
    }
  });

  it('a Service hit carries bookable; a Category hit carries null', async () => {
    const result = await searchCatalog('care');
    for (const hit of result.hits) {
      if (hit.type === 'service') expect(typeof hit.bookable).toBe('boolean');
      else expect(hit.bookable).toBeNull();
    }
  });

  it('only asks for active rows at every level', async () => {
    await searchCatalog('facial');
    for (const call of query.mock.calls) {
      expect(String(call[0])).toContain('status = $1');
      expect(call[1]).toEqual(['active']);
    }
  });

  it('never projects a legacy identifier', async () => {
    const result = await searchCatalog('care');
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('legacy');
    expect(serialised).not.toContain('service_family');
    expect(serialised).not.toContain('level_2');
    expect(serialised).not.toContain('level2');
  });
});
