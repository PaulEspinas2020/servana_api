/**
 * TAB 05 — `employee_services.service_id` is a FAMILY id, and two readers forgot.
 *
 * ## The defect
 *
 * Migration 024 swapped two tables. `services` (the old coarse families) was
 * renamed to `service_families`, and `catalog_services` (the 95 canonical
 * bookable services) was renamed to `services`. Two different id spaces, each
 * with its own sequence after migration 025.
 *
 * `employee_services.service_id` was **not** remapped and still holds a FAMILY
 * id. The schema says so in as many words — the baseline's own comment on
 * `service_families` reads *"Retained for provenance: employee_services,
 * worker_service_applications, service_options, branches and coverage still key
 * on these ids"* — and migration 029 proves it in SQL, joining
 * `servana.services s ON s.legacy_service_family_id = es.service_id` rather than
 * on `s.id`.
 *
 * Two readers nevertheless joined `services` on `sv.id = es.service_id`:
 *
 *   - `providerProfileService.listServices` — behind **`GET /api/v1/provider/services`**,
 *     which the provider mobile app has already migrated to
 *     (`provider_account_api.dart:52`).
 *   - `providerProfileComplianceService.getProfileCenter` — `operational.services`.
 *
 * Two others get it right: `getProviderServicesOverview` joins `service_families`,
 * and `catalogAdminService` joins `service_families f ON es.service_id = f.id`.
 * One rule, four statements, wrong in two.
 *
 * ## Why it was invisible
 *
 * It is a LEFT JOIN, so nothing raises. Where the numeric id happens to exist in
 * the new `services` table the provider is shown a **different service's name**;
 * where it does not, `name` is null. Silently wrong beats loudly broken for
 * survival, which is why this outlived the rename.
 *
 * `listServices` already carries a long comment about D-014 — `es.worker_uid`
 * where the column is `employee_uid` — which returned an empty list for every
 * provider and was caught by a fake that had been written from the SQL. This is
 * the same class one level subtler: the right column against the wrong table.
 *
 * ## How this test avoids repeating that mistake
 *
 * The fake does not agree with the code. It answers by WHICH TABLE the query
 * names: the family table yields the family's real name, and the canonical
 * services table yields the unrelated row that shares the id — which is exactly
 * what production does. So a reader joining the wrong table gets the wrong name
 * here too, and the assertion fails.
 */

jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn() },
  pool: { connect: jest.fn() },
}));
jest.mock('../src/config', () => ({ db: { schema: 'servana' } }));

import dbQuery from '../src/db/dbQuery';
import { listServices } from '../src/services/account/providerProfileService';

const q = dbQuery.query as jest.Mock;

/** Family 2 is "Aircon Cleaning". Canonical service 2 is something else entirely. */
const FAMILY_NAME = 'Aircon Cleaning';
const COLLIDING_CANONICAL_NAME = 'Deep Tissue Massage (90 min)';

/**
 * Answers by the table the query actually names.
 *
 * This is the point of the suite. A fake keyed on the SELECT-list prefix would
 * hand the same row to a right and a wrong query alike and agree with whichever
 * one the code happens to issue — the failure mode this repository has already
 * been bitten by twice.
 */
const seedByTable = () => {
  q.mockReset();
  q.mockImplementation(async (sql: string) => {
    const joinsFamilies = /service_families/.test(sql);
    const joinsCanonicalById = /\bservices\s+\w+\s+ON\s+\w+\.id\s*=\s*es\.service_id/i.test(sql);

    if (joinsFamilies) {
      return { rows: [{ service_id: 2, status: 'active', name: FAMILY_NAME }], rowCount: 1 };
    }
    if (joinsCanonicalById) {
      // Production behaviour: the family id collides with an unrelated canonical
      // service and the provider is shown its name.
      return { rows: [{ service_id: 2, status: 'active', name: COLLIDING_CANONICAL_NAME }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
};

describe('a provider sees the name of the service they were actually granted', () => {
  it('GET /api/v1/provider/services resolves the FAMILY name, not a colliding one', async () => {
    seedByTable();

    const services = await listServices('prov-1');

    expect(services).toHaveLength(1);
    expect(services[0].serviceId).toBe(2);
    // Before the fix this was 'Deep Tissue Massage (90 min)' — a real service
    // name, for a service this provider was never approved for, on a canonical
    // route the mobile app has already migrated to.
    expect(services[0].name).toBe(FAMILY_NAME);
    expect(services[0].name).not.toBe(COLLIDING_CANONICAL_NAME);
  });

  it('the query names the family table, because that is what the column references', async () => {
    seedByTable();
    await listServices('prov-1');

    const sql = q.mock.calls[0][0] as string;
    // Asserted in addition to the behaviour above, not instead of it: the
    // behavioural check is what catches a regression, and this names the reason
    // so the next reader does not "simplify" the join back.
    expect(sql).toMatch(/service_families/);
    expect(sql).not.toMatch(/\bservices\s+sv\s+ON\s+sv\.id\s*=\s*es\.service_id/i);
  });

  it('still reports the operational status, which was never the broken half', async () => {
    seedByTable();
    const services = await listServices('prov-1');
    expect(services[0].status).toBe('active');
    expect(services[0].isActive).toBe(true);
  });
});
