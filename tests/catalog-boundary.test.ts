jest.mock('../src/config', () => ({ db: { schema: 'servana' } }));
jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn() },
}));

import dbQuery from '../src/db/dbQuery';
import { getFullServiceCatalog, getLevel2List } from '../src/services/serviceService';
import { getCatalogAuditTrail, getOfferingProviders } from '../src/services/providerCatalogService';

const query = dbQuery.query as jest.Mock;

describe('services catalog boundaries', () => {
  beforeEach(() => query.mockReset());

  it('does not expose inactive mobile level-two entries', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await getLevel2List(7);
    expect(query.mock.calls[0][0]).toMatch(/option_type = 'MAIN'[\s\S]*is_active = true/);
  });

  it('does not expose inactive main services or add-ons in the full customer catalog', async () => {
    query.mockResolvedValue({ rows: [] });
    await getFullServiceCatalog();
    expect(query.mock.calls[0][0]).toMatch(/so\.option_type = 'MAIN'[\s\S]*so\.is_active = true/);
    expect(query.mock.calls[1][0]).toMatch(/option_type = 'ADD_ON'[\s\S]*is_active = true/);
  });

  it('keeps provider email out of the Services compatibility response', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await getOfferingProviders(3);
    expect(query.mock.calls[0][0]).not.toMatch(/uc\.email/);
  });

  it('clamps invalid audit pagination before querying PostgreSQL', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await getCatalogAuditTrail({ limit: -5, offset: -9 });
    expect(query.mock.calls[0][1].slice(-2)).toEqual([1, 0]);
  });
});
