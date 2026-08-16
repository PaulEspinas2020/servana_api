/**
 * The application may not gain new unmanaged schema authority (TAB 02).
 *
 * ## What the inventory found
 *
 * 154 runtime DDL statements touch 112 objects that NO migration mentions. The
 * application creates a large part of its own schema on the fly, so the
 * migration chain is not the schema's authority — it is one of two, and they
 * never compare notes.
 *
 * ## This is the same finding TAB 15 hit from the other side
 *
 * TAB 15 concluded that eighteen tables were "altered or read by migrations and
 * created by none", and treated that as a hole a baseline had to fill. Seven of
 * those eighteen — `service_options`, `provider_catalog_offerings`,
 * `provider_onboarding_cases`, `provider_onboarding_drafts`,
 * `worker_service_applications`, `service_option_meta`, `employee_services` —
 * appear in this inventory. They were never missing. They are created at
 * RUNTIME, by the application, on first use.
 *
 * That reframes both tabs. A fresh database is not unbootstrappable because
 * something was forgotten; it is unbootstrappable from MIGRATIONS because a
 * large part of the schema was never migration-owned in the first place.
 *
 * ## Why a budget rather than a fix
 *
 * TAB 02 estimates one to two weeks and requires the API to start with DDL
 * privileges revoked — every one of these statements has to move to a migration
 * before that can be true. That is not a change to make in passing.
 *
 * So the number is pinned. It may fall; it may not rise. Adding a new runtime
 * `CREATE TABLE` fails this test, which is the point: the debt is now bounded
 * and visible instead of growing quietly.
 */

import { runtimeDdl, migrationObjects } from '../scripts/runtime-ddl-inventory';

/** Lower it as statements move into migrations. Never raise it. */
const UNMANAGED_BUDGET = 154;
const DISTINCT_OBJECT_BUDGET = 112;

describe('runtime schema authority is bounded and shrinking', () => {
  const ddl = runtimeDdl();
  const owned = migrationObjects();
  const unmanaged = ddl.filter((d) => !owned.has(d.object));

  it('finds runtime DDL at all (positive fixture)', () => {
    // A broken scan would find none and pass the budget forever.
    expect(ddl.length).toBeGreaterThan(100);
    expect(owned.size).toBeGreaterThan(20);
  });

  it('adds no new unmanaged DDL statement', () => {
    expect(unmanaged.length).toBeLessThanOrEqual(UNMANAGED_BUDGET);
  });

  it('adds no new unmanaged object', () => {
    const distinct = new Set(unmanaged.map((d) => d.object));
    expect(distinct.size).toBeLessThanOrEqual(DISTINCT_OBJECT_BUDGET);
  });

  it('the budget is not stale — it still matches reality', () => {
    /**
     * A budget only bounds if it is tight. Left far above the real number it
     * silently permits growth up to the gap, which is how a "shrinking" debt
     * register quietly stops shrinking.
     */
    const distinct = new Set(unmanaged.map((d) => d.object));
    expect(UNMANAGED_BUDGET - unmanaged.length).toBeLessThanOrEqual(5);
    expect(DISTINCT_OBJECT_BUDGET - distinct.size).toBeLessThanOrEqual(5);
  });

  it('names the seven TAB 15 called missing — they are runtime-created', () => {
    /**
     * Pinned because it is the load-bearing correction. If these ever become
     * migration-owned this fails, and TAB 15's baseline requirements should
     * shrink in the same change.
     */
    const objects = new Set(unmanaged.map((d) => d.object));
    for (const table of [
      'service_options',
      'provider_catalog_offerings',
      'provider_onboarding_cases',
      'provider_onboarding_drafts',
      'worker_service_applications',
      'service_option_meta',
      'employee_services',
    ]) {
      expect(objects).toContain(table);
    }
  });
});
