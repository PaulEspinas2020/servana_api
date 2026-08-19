/**
 * getCatalogAuditTrail — ordering totality and read-failure behaviour.
 *
 * Both properties below were defects found while auditing this service against
 * the unlanded spec on feat/catalog-workspace (see
 * docs/CATALOG_WORKSPACE_UNLANDED.md). Neither is about that spec's features —
 * they are independent bugs in code that already shipped.
 */

const queryCalls: Array<{ sql: string; params: any[] }> = [];
let nextResult: { rows: any[] } | Error = { rows: [] };

jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: {
    query: async (sql: string, params: any[] = []) => {
      queryCalls.push({ sql, params });
      if (nextResult instanceof Error) throw nextResult;
      return nextResult;
    },
  },
  pool: {},
}));
jest.mock('../src/db/mongodbQuery', () => ({ __esModule: true, default: Promise.resolve({}) }));
jest.mock('../src/middleware/firebaseApp', () => ({ getFirebaseAdmin: () => ({}), __esModule: true }));

import { getCatalogAuditTrail } from '../src/services/providerCatalogService';

beforeEach(() => {
  queryCalls.length = 0;
  nextResult = { rows: [] };
});

describe('getCatalogAuditTrail — ordering is total', () => {
  /**
   * created_at alone does not order these rows. Audit events written inside one
   * transaction share a timestamp, so their relative order is undefined, and
   * LIMIT/OFFSET paging over an undefined order can repeat a row on page 2 or
   * skip it. A tiebreaker on a unique column is what makes paging sound.
   */
  it('orders by a unique tiebreaker as well as created_at', async () => {
    await getCatalogAuditTrail({ limit: 5 });
    const { sql } = queryCalls[0];
    const order = sql.slice(sql.toUpperCase().lastIndexOf('ORDER BY'));
    expect(order).toMatch(/ORDER BY\s+ae\.created_at\s+DESC\s*,\s*ae\.id\s+DESC/i);
  });

  it('pages with LIMIT and OFFSET, so the order above has to be total', async () => {
    await getCatalogAuditTrail({ limit: 5, offset: 10 });
    const { sql, params } = queryCalls[0];
    expect(sql).toMatch(/LIMIT \$\d+ OFFSET \$\d+/);
    expect(params.slice(-2)).toEqual([5, 10]);
  });
});

describe('getCatalogAuditTrail — a failed read is not an empty audit trail', () => {
  /**
   * This call used to end in `.catch(() => ({ rows: [] }))`. An audit log that
   * answers "nothing happened" when it actually failed to read is worse than one
   * that errors: the caller cannot tell absence of events from absence of
   * knowledge, and an audit trail exists precisely to be trusted on that point.
   */
  it('propagates a database error instead of reporting no events', async () => {
    nextResult = new Error('relation "admin_audit_events" does not exist');
    await expect(getCatalogAuditTrail({})).rejects.toThrow(/admin_audit_events/);
  });

  it('still returns an empty array when the table genuinely has no rows', async () => {
    nextResult = { rows: [] };
    await expect(getCatalogAuditTrail({})).resolves.toEqual([]);
  });
});

describe('getCatalogAuditTrail — limit clamping', () => {
  /**
   * The 0 and -5 cases land differently, and that asymmetry is real rather than
   * a typo here: the implementation is
   *   Math.min(Math.max(Number(limit) || 50, 1), 200)
   * 0 is falsy, so `|| 50` substitutes the default before clamping. -5 is
   * truthy, so it survives to Math.max and clamps to 1 — a caller asking for
   * -5 rows gets one row, not fifty. Pinned because it is the kind of edge a
   * later refactor of that expression would silently change.
   */
  it.each([
    [0, 50],
    [-5, 1],
    [1000, 200],
    [25, 25],
  ])('limit %p is clamped to %p', async (given, expected) => {
    await getCatalogAuditTrail({ limit: given as number });
    expect(queryCalls[0].params.slice(-2)[0]).toBe(expected);
  });
});
