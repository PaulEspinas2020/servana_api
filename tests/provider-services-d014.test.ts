/**
 * D-014: the provider service list was empty for every provider.
 *
 * ## What was wrong
 *
 * `providerProfileService.listServices` selected
 * `WHERE es.worker_uid = $1` from `servana.employee_services`, which declares
 * `employee_uid` and has no `worker_uid` column at all
 * (`scripts/baseline/000-baseline.sql`). PostgreSQL answered 42703
 * `undefined_column`, a bare `catch` returned `[]`, and
 * `GET /api/v1/provider/services` answered 200 with an empty list for EVERY
 * provider. `profileCompletionService` derives `hasServices` from the same call,
 * so every provider also read as permanently incomplete.
 *
 * ## Why the suite did not catch it
 *
 * `tests/support/accountDbFake.ts` routed this query on its SELECT list alone
 * and stored its seed rows under `worker_uid` — the very name the defect used.
 * The fake agreed with the bug, so the query passed here and failed on a real
 * server. Both halves are fixed alongside this suite; the fake now requires the
 * real WHERE column and anything else falls through to its unrouted-SQL throw.
 *
 * ## What this suite asserts
 *
 * That a SEEDED ROW COMES BACK — the proof the command asks for, rather than a
 * re-reading of the SQL, which is what agreed with the defect in the first place.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' }, tempId: undefined }));
jest.mock('../src/db/dbQuery', () => {
  const fake = require('./support/accountDbFake');
  return { __esModule: true, default: fake.dbQueryFake, pool: fake.poolFake };
});
jest.mock('../src/db/mongodbQuery', () => ({
  __esModule: true,
  default: Promise.resolve({
    collection: () => ({
      findOne: async () => null,
      insertOne: async () => undefined,
      updateOne: async () => undefined,
    }),
  }),
}));

import * as fake from './support/accountDbFake';
import * as providerProfile from '../src/services/account/providerProfileService';

const PROVIDER = 'provider-d014';
const OTHER_PROVIDER = 'provider-other';

beforeEach(() => {
  fake.reset();
  fake.seedUser(PROVIDER, 2, { first_name: 'Pat', last_name: 'Provider' });
  fake.seedUser(OTHER_PROVIDER, 2, { first_name: 'Other', last_name: 'Provider' });
});

describe('D-014 — a provider with services gets a non-empty list', () => {
  it('returns the seeded row', async () => {
    fake.seedService(PROVIDER, 180);

    const services = await providerProfile.listServices(PROVIDER);

    expect(services).toHaveLength(1);
    expect(services[0]).toMatchObject({ serviceId: 180, isActive: true });
  });

  it('returns every seeded row, not just the first', async () => {
    fake.seedService(PROVIDER, 180);
    fake.seedService(PROVIDER, 181);
    fake.seedService(PROVIDER, 182, 'paused');

    const services = await providerProfile.listServices(PROVIDER);

    expect(services.map((s) => s.serviceId).sort()).toEqual([180, 181, 182]);
    // `paused` is still a row the provider holds; it is simply not active. The
    // completion service asks `isActive`, so the distinction has to survive.
    expect(services.filter((s) => s.isActive)).toHaveLength(2);
  });

  it('is scoped to the caller — one provider never sees another’s services', async () => {
    fake.seedService(PROVIDER, 180);
    fake.seedService(OTHER_PROVIDER, 999);

    const services = await providerProfile.listServices(PROVIDER);

    expect(services.map((s) => s.serviceId)).toEqual([180]);
  });

  it('returns an empty list for a provider who genuinely has none', async () => {
    // The honest empty case. Without it, a `listServices` hard-wired to return a
    // row would pass every assertion above, so this is what stops the fix being
    // provable by a constant.
    const services = await providerProfile.listServices(PROVIDER);

    expect(services).toEqual([]);
  });
});

describe('D-014 — a schema error is no longer swallowed', () => {
  it('rethrows 42703 rather than degrading to an empty list', async () => {
    const undefinedColumn = Object.assign(new Error('column es.worker_uid does not exist'), {
      code: '42703',
    });
    const spy = jest
      .spyOn(fake.dbQueryFake, 'query')
      .mockRejectedValueOnce(undefinedColumn as never);

    // This is the whole point of the change. A query this repository got wrong
    // fails identically on every call and every environment; absorbing it buys
    // silence and nothing else, and that silence is what made D-014 survive.
    await expect(providerProfile.listServices(PROVIDER)).rejects.toMatchObject({ code: '42703' });

    spy.mockRestore();
  });

  it('still degrades to an empty list when the database is merely unreachable', async () => {
    const unreachable = Object.assign(new Error('connection terminated'), { code: 'ECONNRESET' });
    const spy = jest
      .spyOn(fake.dbQueryFake, 'query')
      .mockRejectedValueOnce(unreachable as never);

    // A provider surface that collapses because the pool blipped is worse than a
    // momentarily short list, so the fail-open path has to survive the change.
    await expect(providerProfile.listServices(PROVIDER)).resolves.toEqual([]);

    spy.mockRestore();
  });
});

describe('the provider profile projects the biography column that exists', () => {
  it('round-trips a seeded biography through getProviderProfile', async () => {
    // `user_profile` declares `public_bio` (migration 009 creates it, the captured
    // baseline agrees). The query named `public_biography`, which nothing in this
    // repository has ever created, so it raised 42703 — and `getProviderProfile`
    // does not catch, so the read failed outright.
    fake.seedProviderProfile(PROVIDER, { public_bio: 'Ten years of aircon work.' });

    const profile = await providerProfile.getProviderProfile(PROVIDER, 'self');

    expect((profile.fields as Record<string, unknown>).biography).toBe('Ten years of aircon work.');
  });

  it('agrees with providerProfileComplianceService, which already read public_bio', async () => {
    // The two modules disagreed about the same column: the compliance service
    // read `public_bio` while this one selected `public_biography`. One source of
    // truth means they agree, so the disagreement is the assertion.
    fake.seedProviderProfile(PROVIDER, { public_bio: 'Consistent value.' });

    const profile = await providerProfile.getProviderProfile(PROVIDER, 'self');

    expect((profile.fields as Record<string, unknown>).biography).toBe('Consistent value.');
  });
});
