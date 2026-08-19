/**
 * archiveOfferingMapping — a published offering may not lose its last mapping.
 *
 * getPublishPreview refuses to publish an offering with no active mapping, but
 * nothing enforced that invariant afterwards, so the last mapping could be
 * archived out from under a live offering. The offering then stays
 * status='active' while showing providers nothing.
 *
 * The guard came from the spec on feat/catalog-workspace (see
 * docs/CATALOG_WORKSPACE_UNLANDED.md), which is the one divergence there that is
 * a data-integrity rule rather than a matter of strictness.
 */

const calls: Array<{ sql: string; params: any[] }> = [];
let responses: Array<{ rows: any[] }> = [];

jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: {
    query: async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      return responses.shift() ?? { rows: [] };
    },
  },
  pool: {},
}));
jest.mock('../src/db/mongodbQuery', () => ({ __esModule: true, default: Promise.resolve({}) }));
jest.mock('../src/middleware/firebaseApp', () => ({ getFirebaseAdmin: () => ({}), __esModule: true }));
jest.mock('../src/services/adminAuditService', () => ({ __esModule: true, auditFire: () => undefined }));

import { archiveOfferingMapping, getPublishPreview } from '../src/services/providerCatalogService';

/** What the guard SELECT returns for one mapping. */
const guardRow = (o: { isActive: boolean; status: string; siblings: number }) => ({
  rows: [{ is_active: o.isActive, status: o.status, active_sibling_count: String(o.siblings) }],
});
const archived = { rows: [{ id: 7 }] };

beforeEach(() => { calls.length = 0; responses = []; });

describe('archiveOfferingMapping — published offerings keep at least one mapping', () => {
  it('refuses to archive the last active mapping on a published offering', async () => {
    responses = [guardRow({ isActive: true, status: 'active', siblings: 1 })];
    await expect(archiveOfferingMapping(7, 'admin-1')).rejects.toThrow(/last active mapping on a published offering/i);
    // and it must not have run the UPDATE
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/SELECT/i);
  });

  it('carries code VALIDATION so the caller can map it to a 4xx', async () => {
    responses = [guardRow({ isActive: true, status: 'active', siblings: 1 })];
    await expect(archiveOfferingMapping(7, 'admin-1')).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('allows archiving when another active mapping remains', async () => {
    responses = [guardRow({ isActive: true, status: 'active', siblings: 2 }), archived];
    await expect(archiveOfferingMapping(7, 'admin-1')).resolves.toEqual({ mappingId: 7, archived: true });
    expect(calls).toHaveLength(2);
    expect(calls[1].sql).toMatch(/UPDATE/i);
  });
});

describe('archiveOfferingMapping — the guard is scoped, not blanket', () => {
  it('allows emptying a DRAFT offering — no provider is reading it yet', async () => {
    responses = [guardRow({ isActive: true, status: 'draft', siblings: 1 }), archived];
    await expect(archiveOfferingMapping(7, 'admin-1')).resolves.toEqual({ mappingId: 7, archived: true });
  });

  it('allows emptying an already-archived offering', async () => {
    responses = [guardRow({ isActive: true, status: 'archived', siblings: 1 }), archived];
    await expect(archiveOfferingMapping(7, 'admin-1')).resolves.toEqual({ mappingId: 7, archived: true });
  });

  it('stays idempotent: re-archiving an inactive mapping does not throw', async () => {
    // siblings is 1 and the offering is published, but this mapping is already
    // inactive, so archiving it removes nothing and must not be blocked.
    responses = [guardRow({ isActive: false, status: 'active', siblings: 1 }), archived];
    await expect(archiveOfferingMapping(7, 'admin-1')).resolves.toEqual({ mappingId: 7, archived: true });
  });
});

describe('archiveOfferingMapping — unknown mapping', () => {
  it('reports a missing mapping rather than silently succeeding', async () => {
    responses = [{ rows: [] }];
    await expect(archiveOfferingMapping(999, 'admin-1')).rejects.toThrow(/Mapping not found/i);
    expect(calls).toHaveLength(1);
  });
});


// ─── Publish preview warnings ────────────────────────────────────────────────

/** The offering row getPublishPreview selects first. */
const offeringRow = (o: { status?: string; visible?: boolean } = {}) => ({
  rows: [{ id: 1, name: 'Deep Clean', status: o.status ?? 'draft', is_builtin: false,
           provider_web_visible: o.visible ?? true }],
});
/** One active mapping with a given service count and priced count. */
const mappingRows = (ss: number, priced: number) => ({
  rows: [{ id: 11, service_id: 3, level_2: 'Sofa', ss_count: String(ss), priced_count: String(priced) }],
});

describe('getPublishPreview — an unpriced mapping is as unusable as an empty one', () => {
  it('warns when services exist but none carries a price', async () => {
    responses = [offeringRow(), mappingRows(4, 0)];
    const r = await getPublishPreview(1);
    expect(r.canPublish).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/none has a price/i);
  });

  it('does not warn about price when at least one service is priced', async () => {
    responses = [offeringRow(), mappingRows(4, 1)];
    const r = await getPublishPreview(1);
    expect(r.warnings.join(' ')).not.toMatch(/none has a price/i);
  });

  it('keeps the pre-existing empty-mapping warning distinct from the price one', async () => {
    responses = [offeringRow(), mappingRows(0, 0)];
    const r = await getPublishPreview(1);
    expect(r.warnings.join(' ')).toMatch(/no active specific services/i);
    expect(r.warnings.join(' ')).not.toMatch(/none has a price/i);
  });

  it('asks the database for the priced count rather than deriving it', async () => {
    responses = [offeringRow(), mappingRows(1, 1)];
    await getPublishPreview(1);
    expect(calls[1].sql).toMatch(/FILTER \(WHERE so\.base_price IS NOT NULL AND so\.base_price > 0\)/i);
  });
});

describe('getPublishPreview — published but invisible', () => {
  it('warns when providerWebVisible is off', async () => {
    responses = [offeringRow({ visible: false }), mappingRows(2, 2)];
    const r = await getPublishPreview(1);
    expect(r.canPublish).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/not visible on the provider web portal/i);
  });

  it('stays silent when the offering is visible', async () => {
    responses = [offeringRow({ visible: true }), mappingRows(2, 2)];
    const r = await getPublishPreview(1);
    expect(r.warnings.join(' ')).not.toMatch(/not visible/i);
  });

  /**
   * Deliberate: these are warnings, never blockers. Turning either into a
   * blocker would refuse publishes that succeed today, which is a behaviour
   * change for the admin portal rather than an additive one.
   */
  it('neither warning blocks a publish', async () => {
    responses = [offeringRow({ visible: false }), mappingRows(3, 0)];
    const r = await getPublishPreview(1);
    expect(r.warnings.length).toBe(2);
    expect(r.blockers).toEqual([]);
    expect(r.canPublish).toBe(true);
  });
});
