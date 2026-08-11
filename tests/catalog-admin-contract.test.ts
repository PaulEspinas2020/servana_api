/**
 * ADMIN CATALOG V2 — contract tests (§59–§64, §78, §82).
 *
 * These pin the properties the whole migration exists to protect:
 *
 *   - a Service id is issued by the database, never by the caller
 *   - editing a Service preserves services.id
 *   - moving a Service preserves services.id AND its provider capabilities
 *   - moving a Subcategory preserves its id and every descendant services.id
 *   - archiving is an UPDATE, never a DELETE
 *
 * They assert against the SQL actually issued rather than against a returned
 * object, because "the id did not change" is a claim about the write, not about
 * the response shape. A delete-and-recreate that happened to reuse the number
 * would satisfy a response-only assertion and still destroy every foreign key
 * pointing at it.
 */

jest.mock('../src/db/dbQuery', () => {
  const query = jest.fn();
  const connect = jest.fn();
  return { __esModule: true, default: { query }, pool: { connect } };
});
jest.mock('../src/config', () => ({ db: { schema: 'servana' } }));
jest.mock('../src/services/adminAuditService', () => ({
  __esModule: true,
  auditFire: jest.fn(),
}));

import fs from 'fs';
import path from 'path';
import dbQuery, { pool } from '../src/db/dbQuery';
import { auditFire } from '../src/services/adminAuditService';
import * as svc from '../src/services/catalogAdminService';

const q = dbQuery.query as jest.Mock;
const connect = (pool as any).connect as jest.Mock;
const audit = auditFire as jest.Mock;

/** Every statement issued this test, in order, across both the pool and a client. */
let issued: Array<{ sql: string; params: any[] }>;

type Rule = [RegExp, any[] | ((params: any[]) => any[])];

/**
 * Routes SQL to rows by pattern rather than by call order. Order-based fakes
 * break every time a query is added, and the breakage looks like a logic failure.
 */
const useDb = (rules: Rule[]) => {
  issued = [];
  const run = (sql: string, params: any[] = []) => {
    issued.push({ sql, params });
    for (const [pattern, rows] of rules) {
      if (pattern.test(sql)) {
        const r = typeof rows === 'function' ? rows(params) : rows;
        return Promise.resolve({ rows: r, rowCount: r.length });
      }
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  };

  q.mockReset();
  q.mockImplementation(run);

  const client = { query: jest.fn(run), release: jest.fn() };
  connect.mockReset();
  connect.mockResolvedValue(client);
  audit.mockReset();
  return client;
};

const sqlText = () => issued.map((c) => c.sql).join('\n;;\n');
const find = (pattern: RegExp) => issued.filter((c) => pattern.test(c.sql));

/** A fully-populated `services` row as getService() expects to read it back. */
const serviceRow = (over: Record<string, any> = {}) => ({
  id: 501, subcategory_id: 8, name: 'Pimple Facial', slug: 'pimple-facial',
  status: 'active', display_order: 0, bookable: true, base_price: '750',
  unit: 'per session', updated_at: '2026-08-11T00:00:00.000Z',
  subcategory_name: 'Facial', category_id: 3, category_name: 'Personal Care',
  provider_count: 4, short_description: null, full_description: null,
  image_url: null, estimated_duration_mins: 60, archived_at: null,
  created_at: '2026-01-01T00:00:00.000Z',
  legacy_service_option_id: 501, legacy_service_family_id: 2,
  ...over,
});

// Shared rules: the read-back path plus a valid destination subcategory.
const BASE_RULES: Rule[] = [
  [/FROM servana\.catalog_subcategories\s+WHERE id = \$1/, [{ id: 8, category_id: 3 }]],
  [/SELECT s\.\*/, [serviceRow()]],
];

// ─── §59 — Create Service ────────────────────────────────────────────────────

describe('§59 create Service — the database issues the id', () => {
  const rules: Rule[] = [
    ...BASE_RULES,
    [/INSERT INTO servana\.services/, [{ id: 501 }]],
  ];

  test('the INSERT does not name an id column and the sequence supplies it', async () => {
    useDb(rules);
    const created = await svc.createService(
      { subcategoryId: 8, name: 'Pimple Facial', basePrice: 750 }, 'admin-1',
    );

    const insert = find(/INSERT INTO servana\.services/)[0];
    expect(insert).toBeDefined();

    // The column list must not contain a bare `id`. If it ever does, the caller
    // is choosing the primary key and services.id stops being sequence-owned.
    const columnList = insert.sql.slice(insert.sql.indexOf('('), insert.sql.indexOf(')'));
    expect(columnList).not.toMatch(/\bid\b/);
    expect(insert.params).not.toContain(501);

    expect(created.id).toBe(501);
  });

  test('a blank name is refused before any write', async () => {
    useDb(rules);
    await expect(svc.createService({ subcategoryId: 8, name: '   ' }, 'admin-1'))
      .rejects.toThrow(/cannot be blank/i);
    expect(find(/INSERT/)).toHaveLength(0);
  });

  test('an unknown Subcategory is refused before any write', async () => {
    useDb([[/INSERT INTO servana\.services/, [{ id: 501 }]]]); // no subcategory rule → not found
    await expect(svc.createService({ subcategoryId: 999, name: 'Ghost' }, 'admin-1'))
      .rejects.toMatchObject({ statusCode: 404 });
    expect(find(/INSERT/)).toHaveLength(0);
  });

  test('a Category that contradicts the Subcategory is refused (§13)', async () => {
    useDb(rules);
    // Subcategory 8 belongs to category 3; the caller claims category 1.
    await expect(svc.createService(
      { subcategoryId: 8, categoryId: 1, name: 'Pimple Facial' }, 'admin-1',
    )).rejects.toMatchObject({ code: 'HIERARCHY_MISMATCH' });
    expect(find(/INSERT/)).toHaveLength(0);
  });

  test('a negative base price is refused', async () => {
    useDb(rules);
    await expect(svc.createService({ subcategoryId: 8, name: 'X', basePrice: -1 }, 'admin-1'))
      .rejects.toThrow(/zero or greater/i);
  });

  test('a slug is generated, because the column is NOT NULL with no default', async () => {
    useDb(rules);
    await svc.createService({ subcategoryId: 8, name: 'Pimple  Facial!' }, 'admin-1');
    const insert = find(/INSERT INTO servana\.services/)[0];
    expect(insert.params).toContain('pimple-facial');
  });

  test('a colliding slug is suffixed rather than raising a constraint error', async () => {
    useDb([
      ...BASE_RULES,
      // Report `pimple-facial` taken, `pimple-facial-2` free.
      [/SELECT 1 FROM servana\.services WHERE slug/, (p) => (p[0] === 'pimple-facial' ? [{ '?column?': 1 }] : [])],
      [/INSERT INTO servana\.services/, [{ id: 501 }]],
    ]);
    await svc.createService({ subcategoryId: 8, name: 'Pimple Facial' }, 'admin-1');
    expect(find(/INSERT INTO servana\.services/)[0].params).toContain('pimple-facial-2');
  });
});

// ─── §60 — Update Service ────────────────────────────────────────────────────

describe('§60 update Service — the id survives', () => {
  const rules: Rule[] = [
    ...BASE_RULES,
    [/SELECT id, subcategory_id, name, slug, status, bookable FROM servana\.services/,
      [{ id: 501, subcategory_id: 8, name: 'Pimple Facial', slug: 'pimple-facial', status: 'active', bookable: true }]],
  ];

  test('editing issues an UPDATE keyed on the id and never a DELETE or INSERT', async () => {
    useDb(rules);
    const updated = await svc.updateService(
      501, { name: 'Pimple Facial Deluxe', basePrice: 900, status: 'active' }, 'admin-1',
    );

    const update = find(/UPDATE servana\.services/)[0];
    expect(update).toBeDefined();
    expect(update.sql).toMatch(/WHERE id = \$1/);
    expect(update.params[0]).toBe(501);

    // The identity-destroying shapes must be absent entirely.
    expect(sqlText()).not.toMatch(/DELETE FROM servana\.services/);
    expect(sqlText()).not.toMatch(/INSERT INTO servana\.services/);

    expect(updated.id).toBe(501);
  });

  test('the row is locked FOR UPDATE so a concurrent edit cannot be lost (§18)', async () => {
    useDb(rules);
    await svc.updateService(501, { name: 'Renamed' }, 'admin-1');
    expect(sqlText()).toMatch(/FOR UPDATE/);
  });

  test('the whole edit runs in one transaction', async () => {
    const client = useDb(rules);
    await svc.updateService(501, { name: 'Renamed' }, 'admin-1');
    const stmts = client.query.mock.calls.map((c: any[]) => c[0]);
    expect(stmts[0]).toBe('BEGIN');
    expect(stmts).toContain('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });

  test('a failed edit rolls back and still releases the client', async () => {
    useDb([
      ...BASE_RULES,
      [/SELECT id, subcategory_id, name, slug, status, bookable FROM servana\.services/, []],
    ]);
    await expect(svc.updateService(999, { name: 'Nope' }, 'admin-1')).rejects.toMatchObject({ statusCode: 404 });
    expect(sqlText()).toMatch(/ROLLBACK/);
  });
});

// ─── §61 — Move Service ──────────────────────────────────────────────────────

describe('§61 move Service — id and provider capabilities both survive', () => {
  const rules: Rule[] = [
    [/FROM servana\.catalog_subcategories\s+WHERE id = \$1/, (p) =>
      (Number(p[0]) === 12 ? [{ id: 12, category_id: 3 }] : [{ id: 8, category_id: 3 }])],
    [/SELECT s\.\*/, [serviceRow({ subcategory_id: 12 })]],
    [/SELECT id, subcategory_id, name, slug, status, bookable FROM servana\.services/,
      [{ id: 501, subcategory_id: 8, name: 'Pimple Facial', slug: 'pimple-facial', status: 'active', bookable: true }]],
  ];

  test('only subcategory_id changes; the id is the WHERE clause, not a SET target', async () => {
    useDb(rules);
    const moved = await svc.updateService(501, { subcategoryId: 12 }, 'admin-1');

    const update = find(/UPDATE servana\.services/)[0];
    expect(update.sql).toMatch(/subcategory_id\s+= \$2/);
    expect(update.sql).toMatch(/WHERE id = \$1/);
    // Assigning a bare `id` in SET would mean the identity is being rewritten.
    // Checked against the SET clause alone: a pattern spanning the whole
    // statement matches the `WHERE id = $1` that is supposed to be there.
    const setClause = update.sql.slice(update.sql.indexOf('SET'), update.sql.indexOf('WHERE'));
    expect(setClause).not.toMatch(/(?:SET|,)\s*id\s*=/);
    expect(setClause).toMatch(/subcategory_id\s*=/);
    expect(update.params[0]).toBe(501);
    expect(update.params[1]).toBe(12);
    expect(moved.id).toBe(501);
  });

  test('a move never touches catalog_provider_services', async () => {
    useDb(rules);
    await svc.updateService(501, { subcategoryId: 12 }, 'admin-1');
    // Capabilities key on service_id, which is unchanged — so the correct number
    // of writes to the capability table is exactly zero.
    expect(sqlText()).not.toMatch(/(INSERT INTO|UPDATE|DELETE FROM) servana\.catalog_provider_services/);
  });

  test('a move never touches the legacy family tables', async () => {
    useDb(rules);
    await svc.updateService(501, { subcategoryId: 12 }, 'admin-1');
    expect(sqlText()).not.toMatch(/servana\.(service_families|employee_services|service_options)/);
  });

  test('a move into a Subcategory of a different Category than claimed is refused', async () => {
    useDb([
      [/FROM servana\.catalog_subcategories\s+WHERE id = \$1/, [{ id: 12, category_id: 3 }]],
      [/SELECT id, subcategory_id, name, slug, status, bookable FROM servana\.services/,
        [{ id: 501, subcategory_id: 8, name: 'P', slug: 'p', status: 'active', bookable: true }]],
    ]);
    await expect(svc.updateService(501, { subcategoryId: 12, categoryId: 99 }, 'admin-1'))
      .rejects.toMatchObject({ code: 'HIERARCHY_MISMATCH' });
    expect(sqlText()).not.toMatch(/UPDATE servana\.services/);
  });

  test('the move is audited as a move, not as an ordinary edit', async () => {
    useDb(rules);
    await svc.updateService(501, { subcategoryId: 12 }, 'admin-1');
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'catalog_service.move',
      entityType: 'catalog_service',
      entityId: '501',
      actorUid: 'admin-1',
    }));
  });
});

// ─── §62 — Move Subcategory ──────────────────────────────────────────────────

describe('§62 move Subcategory — its id and every child services.id survive', () => {
  const rules: Rule[] = [
    [/SELECT id, category_id, name, slug, status FROM servana\.catalog_subcategories/,
      [{ id: 8, category_id: 3, name: 'Facial', slug: 'facial', status: 'active' }]],
    [/SELECT id FROM servana\.catalog_categories WHERE id = \$1/, [{ id: 2 }]],
    [/UPDATE servana\.catalog_subcategories/,
      [{ id: 8, category_id: 2, name: 'Facial', slug: 'facial', description: null, image_url: null, status: 'active', display_order: 0 }]],
    [/SELECT COUNT\(\*\)::int AS n FROM servana\.services WHERE subcategory_id/, [{ n: 31 }]],
  ];

  test('the subcategory id is preserved and only category_id moves', async () => {
    useDb(rules);
    const moved = await svc.updateSubcategory(8, { categoryId: 2 }, 'admin-1');

    const update = find(/UPDATE servana\.catalog_subcategories/)[0];
    expect(update.sql).toMatch(/WHERE id = \$1/);
    expect(update.params[0]).toBe(8);
    expect(update.params[1]).toBe(2);
    expect(moved.id).toBe(8);
    expect(moved.categoryId).toBe(2);
  });

  test('no child service row is rewritten — the services table is only counted', async () => {
    useDb(rules);
    await svc.updateSubcategory(8, { categoryId: 2 }, 'admin-1');
    expect(sqlText()).not.toMatch(/UPDATE servana\.services/);
    expect(sqlText()).not.toMatch(/DELETE FROM servana\.services/);
    // The only contact with `services` is the invariant count.
    expect(find(/servana\.services/).every((c) => /COUNT\(\*\)/.test(c.sql))).toBe(true);
  });

  test('the slug is re-derived against the destination, because it is unique per category', async () => {
    useDb(rules);
    await svc.updateSubcategory(8, { categoryId: 2 }, 'admin-1');
    const slugCheck = find(/SELECT 1 FROM servana\.catalog_subcategories WHERE slug/)[0];
    expect(slugCheck).toBeDefined();
    // Scoped to the destination category, not the origin.
    expect(slugCheck.params).toContain(2);
  });

  test('an unknown destination Category is refused before the update', async () => {
    useDb([
      [/SELECT id, category_id, name, slug, status FROM servana\.catalog_subcategories/,
        [{ id: 8, category_id: 3, name: 'Facial', slug: 'facial', status: 'active' }]],
    ]);
    await expect(svc.updateSubcategory(8, { categoryId: 404 }, 'admin-1'))
      .rejects.toMatchObject({ statusCode: 404 });
    expect(sqlText()).not.toMatch(/UPDATE servana\.catalog_subcategories/);
  });
});

// ─── §63 — Archive ───────────────────────────────────────────────────────────

describe('§63 archive Service — the row remains', () => {
  // Rules are matched in order, so the archived read-back must precede the
  // generic one in BASE_RULES or it never fires.
  const rules: Rule[] = [
    [/SELECT status FROM servana\.services WHERE id = \$1/, [{ status: 'active' }]],
    [/SELECT s\.\*/, [serviceRow({ status: 'archived', archived_at: '2026-08-11T00:00:00.000Z' })]],
    ...BASE_RULES,
  ];

  test('archiving is an UPDATE of status, never a DELETE', async () => {
    useDb(rules);
    const archived = await svc.setServiceStatus(501, 'archived', 'admin-1');

    expect(sqlText()).not.toMatch(/DELETE FROM/);
    const update = find(/UPDATE servana\.services/)[0];
    expect(update.sql).toMatch(/SET status = \$2/);
    expect(update.params).toEqual([501, 'archived']);
    expect(archived.status).toBe('archived');
  });

  test('archiving leaves provider capability rows untouched', async () => {
    useDb(rules);
    await svc.setServiceStatus(501, 'archived', 'admin-1');
    // The read-back legitimately COUNTs capabilities; what must never happen is
    // a write, which is what would sever the provider's history.
    expect(sqlText()).not.toMatch(/(INSERT INTO|UPDATE|DELETE FROM) servana\.catalog_provider_services/);
  });

  test('reactivating clears archived_at rather than leaving a stale stamp', async () => {
    useDb(rules);
    await svc.setServiceStatus(501, 'active', 'admin-1');
    expect(find(/UPDATE servana\.services/)[0].sql)
      .toMatch(/archived_at = CASE WHEN \$2 = 'archived' THEN NOW\(\) ELSE NULL END/);
  });

  test('an invalid status is refused', async () => {
    useDb(rules);
    await expect(svc.setServiceStatus(501, 'deleted' as any, 'admin-1')).rejects.toThrow(/Invalid status/);
  });

  test('deactivating a Category does not touch its descendants (§33)', async () => {
    useDb([
      [/SELECT id, name, slug, status, display_order FROM servana\.catalog_categories/,
        [{ id: 3, name: 'Personal Care', slug: 'personal-care', status: 'active', display_order: 0 }]],
      [/UPDATE servana\.catalog_categories/,
        [{ id: 3, name: 'Personal Care', slug: 'personal-care', description: null, image_url: null, status: 'inactive', display_order: 0 }]],
    ]);
    await svc.updateCategory(3, { status: 'inactive' }, 'admin-1');
    expect(sqlText()).not.toMatch(/UPDATE servana\.catalog_subcategories/);
    expect(sqlText()).not.toMatch(/UPDATE servana\.services/);
    expect(sqlText()).not.toMatch(/DELETE FROM/);
  });
});

// ─── §44 / §78 / §82 — coverage, aggregation, leakage ───────────────────────

describe('§44 provider coverage derives from the canonical capability', () => {
  const rules: Rule[] = [
    [/SELECT 1 FROM servana\.services WHERE id = \$1/, [{ '?column?': 1 }]],
    [/FROM servana\.catalog_provider_services cps/, [
      { provider_uid: 'uid-a', status: 'active',   source: 'migrated_from_family', created_at: 'x', first_name: 'Ana',  last_name: 'Cruz' },
      { provider_uid: 'uid-b', status: 'active',   source: 'application_approved', created_at: 'y', first_name: null,   last_name: null },
      { provider_uid: 'uid-c', status: 'archived', source: 'admin_grant',          created_at: 'z', first_name: 'Ben',  last_name: 'Reyes' },
    ]],
  ];

  test('counts come from catalog_provider_services, never employee_services', async () => {
    useDb(rules);
    const coverage = await svc.getServiceProviders(501);
    expect(sqlText()).toMatch(/servana\.catalog_provider_services/);
    expect(sqlText()).not.toMatch(/employee_services/);
    // Only active rows count as approved; the archived one is still listed.
    expect(coverage.approvedCount).toBe(2);
    expect(coverage.totalCount).toBe(3);
  });

  test('a service with no active capability reports the zero-provider state (§45)', async () => {
    useDb([
      [/SELECT 1 FROM servana\.services WHERE id = \$1/, [{ '?column?': 1 }]],
      [/FROM servana\.catalog_provider_services cps/, []],
    ]);
    const coverage = await svc.getServiceProviders(501);
    expect(coverage.approvedCount).toBe(0);
    expect(coverage.coverageStatus).toBe('no_providers');
  });

  test('coverage exposes no documents, notes or profile detail (§82)', async () => {
    useDb(rules);
    const coverage = await svc.getServiceProviders(501);
    const keys = Object.keys(coverage.providers[0]).sort();
    expect(keys).toEqual(['grantedAt', 'name', 'providerUid', 'source', 'status']);
    expect(sqlText()).not.toMatch(/worker_requirements|document|notes|password|token/i);
  });
});

describe('§78 the hierarchy read does not fan out', () => {
  const rules: Rule[] = [
    [/FROM servana\.catalog_categories/, [{ id: 3, name: 'Personal Care', slug: 'pc', description: null, image_url: null, status: 'active', display_order: 0 }]],
    [/FROM servana\.catalog_subcategories/, [{ id: 8, category_id: 3, name: 'Facial', slug: 'facial', description: null, image_url: null, status: 'active', display_order: 0 }]],
    [/FROM servana\.services s/, [serviceRow(), serviceRow({ id: 502, name: 'Deep Facial' })]],
  ];

  test('three statements regardless of how many services exist', async () => {
    useDb(rules);
    const tree = await svc.getCatalogHierarchy();
    expect(q).toHaveBeenCalledTimes(3);
    expect(tree[0].subcategories![0].services!.map((s) => s.id)).toEqual([501, 502]);
  });

  test('provider counts are aggregated in SQL, not requested per service', async () => {
    useDb(rules);
    const tree = await svc.getCatalogHierarchy();
    const servicesQuery = find(/FROM servana\.services s/)[0];
    expect(servicesQuery.sql).toMatch(/COUNT\(\*\)::int AS provider_count/);
    expect(servicesQuery.sql).toMatch(/GROUP BY service_id/);
    expect(tree[0].subcategories![0].services![0].providerCount).toBe(4);
  });

  test('the projection stays light — no options, add-ons, questions or long copy', async () => {
    useDb(rules);
    const tree = await svc.getCatalogHierarchy();
    const service = tree[0].subcategories![0].services![0] as any;
    expect(service.fullDescription).toBeUndefined();
    expect(service.options).toBeUndefined();
    expect(service.addons).toBeUndefined();
    expect(sqlText()).not.toMatch(/service_options|addons|questions/i);
  });

  test('counts roll up from the rows actually returned, never hard-coded', async () => {
    useDb(rules);
    const tree = await svc.getCatalogHierarchy();
    expect(tree[0].subcategoryCount).toBe(1);
    expect(tree[0].serviceCount).toBe(2);
  });

  test('ordering tie-breaks on name, because display_order is 0 across production', async () => {
    useDb(rules);
    await svc.getCatalogHierarchy();
    for (const call of find(/FROM servana\.catalog_(categories|subcategories)/)) {
      expect(call.sql).toMatch(/ORDER BY display_order, name/);
    }
  });
});

// ─── §46 / §47 — the six legacy gaps stay visible and untouched ─────────────

describe('§47 content gaps are reported, never resolved automatically', () => {
  test('families with provider intent but no canonical service are listed read-only', async () => {
    useDb([
      [/FROM servana\.service_families f/, [
        { id: 5, name: 'Nails',    category: 'Personal Care', provider_intent_count: 6, legacy_link_count: 6 },
        { id: 6, name: 'Hair',     category: 'Personal Care', provider_intent_count: 6, legacy_link_count: 6 },
        { id: 2, name: 'Aircon 2', category: 'Home Services', provider_intent_count: 14, legacy_link_count: 14 },
      ]],
      // Aircon 2 has canonical services, so it is not a gap.
      [/SELECT legacy_service_family_id AS fid/, [{ fid: 2, canonical_count: 30 }]],
    ]);
    const gaps = await svc.getCatalogContentGaps();
    expect(gaps.map((g) => g.legacyFamilyName)).toEqual(['Nails', 'Hair']);
    expect(gaps[0].providerIntentCount).toBe(6);
    // Reporting only: no approval is deleted and no service is invented.
    expect(sqlText()).not.toMatch(/DELETE|INSERT|UPDATE/);
  });

  test('the legacy category column is never read out of the canonical table', async () => {
    useDb([
      [/FROM servana\.service_families f/, []],
      [/SELECT legacy_service_family_id AS fid/, []],
    ]);
    await svc.getCatalogContentGaps();
    // The guard that protects against the Deploy-3 outage query, asserted here
    // behaviourally as well as by source inspection.
    const canonicalRead = find(/FROM servana\.services/)[0];
    expect(canonicalRead.sql).not.toMatch(/\bcategory\b/);
  });
});

// ─── §55 — reorder ──────────────────────────────────────────────────────────

describe('reorder applies atomically', () => {
  test('all rows move in one transaction after the ids are validated', async () => {
    const client = useDb([[/SELECT id FROM servana\.catalog_categories WHERE id = ANY/, [{ id: 1 }, { id: 2 }]]]);
    const result = await svc.reorder('category', [{ id: 1, displayOrder: 0 }, { id: 2, displayOrder: 1 }], 'admin-1');
    const stmts = client.query.mock.calls.map((c: any[]) => c[0]);
    expect(stmts[0]).toBe('BEGIN');
    expect(stmts).toContain('COMMIT');
    expect(result.reordered).toBe(2);
  });

  test('an id that no longer exists aborts the whole reorder', async () => {
    useDb([[/SELECT id FROM servana\.catalog_categories WHERE id = ANY/, [{ id: 1 }]]]);
    await expect(svc.reorder('category', [{ id: 1, displayOrder: 0 }, { id: 99, displayOrder: 1 }], 'admin-1'))
      .rejects.toMatchObject({ code: 'STALE' });
    expect(sqlText()).toMatch(/ROLLBACK/);
    expect(sqlText()).not.toMatch(/SET display_order/);
  });
});

// ─── Duplicate-name protection (§9) ─────────────────────────────────────────

describe('normalised duplicate names are refused', () => {
  test('case and spacing differences do not create a second Category', async () => {
    useDb([
      [/SELECT id FROM servana\.catalog_categories WHERE lower/, [{ id: 3 }]],
    ]);
    await expect(svc.createCategory({ name: '  personal   CARE ' }, 'admin-1'))
      .rejects.toMatchObject({ code: 'DUPLICATE_NAME' });
    expect(sqlText()).not.toMatch(/INSERT INTO/);
  });

  test('an archived row does not block reusing its name', async () => {
    useDb([
      [/SELECT id FROM servana\.catalog_categories WHERE lower/, []],
      [/INSERT INTO servana\.catalog_categories/, [{ id: 4, name: 'Retired Area', slug: 'retired-area', description: null, image_url: null, status: 'active', display_order: 0 }]],
    ]);
    const created = await svc.createCategory({ name: 'Retired Area' }, 'admin-1');
    expect(created.id).toBe(4);
    // The duplicate check must exclude archived rows, or a name can never be reused.
    expect(find(/SELECT id FROM servana\.catalog_categories WHERE lower/)[0].sql)
      .toMatch(/status <> 'archived'/);
  });
});

// ─── Wire-format contract (found in production, post-deploy) ────────────────

describe('timestamps are ISO 8601 with an explicit UTC designator', () => {
  // Override must precede BASE_RULES — first pattern match wins.
  const rules: Rule[] = [
    [/SELECT s\.\*/, [serviceRow({
      // The exact shape measured coming out of production: space separator,
      // two-digit offset. Neither is ISO 8601.
      updated_at: '2026-08-11 11:03:23.421016+00',
      created_at: '2026-01-01 00:00:00+00',
      archived_at: null,
    })]],
    ...BASE_RULES,
  ];

  test('a space-separated Postgres timestamp is normalised', async () => {
    useDb(rules);
    const service = await svc.getService(501);
    expect(service.updatedAt).toBe('2026-08-11T11:03:23.421Z');
    expect(service.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  test('the wire value parses in a plain JS Date', async () => {
    useDb(rules);
    const service = await svc.getService(501);
    // `new Date('2026-08-11 11:03:23.421016+00')` is implementation-defined and
    // has been rejected outright by WebKit. The normalised form must not be.
    expect(Number.isNaN(new Date(service.updatedAt!).getTime())).toBe(false);
    expect(service.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test('null stays null rather than becoming an epoch date', async () => {
    useDb(rules);
    const service = await svc.getService(501);
    expect(service.archivedAt).toBeNull();
  });

  test('an unparseable value is passed through, never invented', async () => {
    useDb([[/SELECT s\.\*/, [serviceRow({ updated_at: 'not-a-date' })]], ...BASE_RULES]);
    const service = await svc.getService(501);
    expect(service.updatedAt).toBe('not-a-date');
  });

  test('coverage grant timestamps are normalised too', async () => {
    useDb([
      [/SELECT 1 FROM servana\.services WHERE id = \$1/, [{ '?column?': 1 }]],
      [/FROM servana\.catalog_provider_services cps/, [
        { provider_uid: 'uid-a', status: 'active', source: 'admin_grant',
          created_at: '2026-08-11 11:03:23.421016+00', first_name: 'Ana', last_name: 'Cruz' },
      ]],
    ]);
    const coverage = await svc.getServiceProviders(501);
    expect(coverage.providers[0].grantedAt).toBe('2026-08-11T11:03:23.421Z');
  });
});

describe('the canonical catalog is exempt from response parity aliases', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.ts'), 'utf8');

  test('parityMiddleware is skipped for /api/admin/catalog', () => {
    // Parity maps `name` → `level2`, so a canonical Service shipped
    // `level2: "<its own name>"` while `level2` means the SUBCATEGORY in the
    // legacy model. Measured in production before this exemption existed.
    //
    // Asserted as "this prefix is exempt", not as one particular spelling of
    // the check. The original form pinned a singular `CANONICAL_CATALOG_PREFIX`
    // identifier and failed the moment the public catalog earned the same
    // exemption and the constant became a list — a break that reported a
    // regression where the guarantee had actually widened.
    expect(app).toContain("'/api/admin/catalog'");
    expect(app).toMatch(/startsWith\([\s\S]{0,80}\)[\s\S]{0,40}return next\(\)/);
  });

  test('the public catalog carries the same exemption', () => {
    // It needs it more, not less: `/api/catalog` is the surface the Flutter
    // clients migrate onto, so a parity-generated `level2` there would be read
    // by a customer app as the Subcategory while holding the Service's name.
    expect(app).toContain("'/api/catalog'");
  });

  test('every other route still gets parity', () => {
    expect(app).toMatch(/return parityMiddleware\(req, res, next\)/);
  });
});

describe('slugify', () => {
  test.each([
    ['Pimple Facial', 'pimple-facial'],
    ['Aircon — Deep Clean!', 'aircon-deep-clean'],
    ['  Multiple   Spaces  ', 'multiple-spaces'],
    ['///', 'item'],
  ])('%s → %s', (input, expected) => {
    expect(svc.slugify(input) || 'item').toBe(expected);
  });
});
