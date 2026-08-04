/**
 * The customer catalog must ship NAMES, not just ids and prices.
 *
 * `getFullServiceCatalog` runs every row through `toCamel`, so by the time
 * `transformServiceCatalog` sees them `level_2` is `level2` and `level_3` is
 * `level3`. The transformer read the snake spellings, which are undefined on a
 * camelCased object — and JSON.stringify omits undefined, so the keys did not
 * arrive as null, they vanished. Live production response before the fix:
 *
 *     "options": [{ "items": [{ "level3id": 130, "unit": "per unit",
 *                               "base_price": 3190, "addons": [] }] }]
 *
 * Every option group and every item was nameless.
 *
 * parityMiddleware could not rescue it — fieldParity skips undefined before
 * aliasing, so it can rename a key but never invent an absent one.
 *
 * Customer impact was total: search_repository.dart:29-30 drops any group whose
 * level2 is empty, so the search cache was always empty and every query rendered
 * "No services match your search." A complete data-layer failure shown as a
 * legitimate empty result (§20).
 *
 * The tell was inside the function: `opt.basePrice` on the adjacent line is
 * camelCase and worked. Two keys were missed in a conversion.
 *
 * These are pure unit tests over the transformer — no database, no server.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' } }));
jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn() },
}));

import { transformServiceCatalog } from '../src/services/serviceService';

/** A row exactly as getFullServiceCatalog yields it: already camelCased. */
const camelRow = (over: Record<string, any> = {}) => ({
  id: 130,
  serviceId: 2,
  serviceName: 'Beauty & Wellness',
  serviceCategory: 'BEAUTY',
  level2: 'Beauty Drip',
  level3: 'Gluta Drip',
  unit: 'per unit',
  basePrice: 3190,
  inclusions: [],
  exclusions: [],
  addons: [],
  ...over,
});

const catalog = (rows: any[]) =>
  transformServiceCatalog([{ serviceId: 2, options: rows }]);

describe('names survive the transform', () => {
  it('the option group carries its level2 name', () => {
    const [svc] = catalog([camelRow()]);
    expect(svc.options[0].level2).toBe('Beauty Drip');
  });

  it('the item carries its level3 name', () => {
    const [svc] = catalog([camelRow()]);
    expect(svc.options[0].items[0].level3).toBe('Gluta Drip');
  });

  it('an add-on carries its level3 name', () => {
    const [svc] = catalog([
      camelRow({
        addons: [{ id: 9, level3: 'Extra Vitamin C', unit: 'per unit', basePrice: 500 }],
      }),
    ]);
    expect(svc.options[0].items[0].addons[0].level3).toBe('Extra Vitamin C');
  });

  it('NO name key is undefined anywhere in the payload', () => {
    // The precise failure mode: undefined rather than null, so the key is
    // absent from the JSON entirely and a shape check on the parsed body would
    // not see a null to complain about.
    const [svc] = catalog([
      camelRow({ addons: [{ id: 9, level3: 'A', unit: 'u', basePrice: 1 }] }),
    ]);
    const wire = JSON.parse(JSON.stringify(svc));
    expect(Object.keys(wire.options[0])).toContain('level2');
    expect(Object.keys(wire.options[0].items[0])).toContain('level3');
    expect(Object.keys(wire.options[0].items[0].addons[0])).toContain('level3');
  });

  it('groups by name, so two items under one level2 share a group', () => {
    const [svc] = catalog([
      camelRow({ id: 1, level3: 'Gluta Drip' }),
      camelRow({ id: 2, level3: 'Collagen' }),
    ]);
    expect(svc.options).toHaveLength(1);
    expect(svc.options[0].items.map((i: any) => i.level3)).toEqual([
      'Gluta Drip',
      'Collagen',
    ]);
  });

  it('distinct level2 values produce distinct groups', () => {
    const [svc] = catalog([
      camelRow({ level2: 'Beauty Drip' }),
      camelRow({ level2: 'Facial' }),
    ]);
    expect(svc.options.map((o: any) => o.level2).sort()).toEqual([
      'Beauty Drip',
      'Facial',
    ]);
  });
});

describe('raw snake rows still work', () => {
  // Defensive: if a caller ever passes rows that have NOT been through toCamel,
  // the transformer must not silently produce nameless output again.
  const snakeRow = {
    id: 7,
    level_2: 'Massage',
    level_3: 'Swedish',
    unit: '1 hour',
    basePrice: 400,
    addons: [{ id: 8, level_3: 'Hot Stone', unit: '1 hour', basePrice: 150 }],
  };

  it('reads level_2 when level2 is absent', () => {
    const [svc] = catalog([snakeRow]);
    expect(svc.options[0].level2).toBe('Massage');
  });

  it('reads level_3 when level3 is absent, including on add-ons', () => {
    const [svc] = catalog([snakeRow]);
    expect(svc.options[0].items[0].level3).toBe('Swedish');
    expect(svc.options[0].items[0].addons[0].level3).toBe('Hot Stone');
  });
});

describe('the fields that already worked are not disturbed', () => {
  it('price stays numeric', () => {
    const [svc] = catalog([camelRow({ basePrice: '3190' })]);
    expect(svc.options[0].items[0].base_price).toBe(3190);
  });

  it('id, unit and the service name are unchanged', () => {
    const [svc] = catalog([camelRow()]);
    expect(svc.options[0].items[0].level3id).toBe(130);
    expect(svc.options[0].items[0].unit).toBe('per unit');
    expect(svc.name).toBe('Beauty & Wellness');
  });
});

describe('the transformer reads camelCase, matching what feeds it', () => {
  it('does not reference the snake spelling alone', () => {
    // Guards the actual regression: a future edit that drops the camel read and
    // keeps only `opt.level_2` would restore a nameless catalog while every
    // test above that uses snake fixtures still passed.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'services', 'serviceService.ts'),
      'utf8',
    );
    const fn = src.slice(
      src.indexOf('export const transformServiceCatalog'),
      src.indexOf('export const getFullServiceCatalog'),
    );
    expect(fn).toMatch(/opt\.level2\s*\?\?\s*opt\.level_2/);
    expect(fn).toMatch(/opt\.level3\s*\?\?\s*opt\.level_3/);
    expect(fn).toMatch(/a\.level3\s*\?\?\s*a\.level_3/);
  });
});
