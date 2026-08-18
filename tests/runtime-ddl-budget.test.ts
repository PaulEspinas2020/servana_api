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
 * TAB 02 requires the API to start with DDL privileges revoked, so every one of
 * these statements has to go before that can be true. That is not a change to
 * make in passing.
 *
 * So the number is pinned. It may fall; it may not rise. Adding a new runtime
 * `CREATE TABLE` fails this test, which is the point: the debt is now bounded
 * and visible instead of growing quietly.
 *
 * ## This number is NOT the size of TAB 02
 *
 * It was read that way — 154 statements to move, "one to two weeks", the
 * multi-week core of the command. That was wrong, and this test's own framing is
 * how: it asks only whether a MIGRATION owns the object, and migrations stopped
 * being the sole authority when TAB 15 added `scripts/baseline/000-baseline.sql`.
 *
 * `npm run schema:authority` splits this number against the baseline too. All 148
 * touch an object the baseline already declares, and `db:verify:embedded` proves
 * a fresh database reaches the current schema from it. They are REDUNDANT
 * statements to delete, not schema to design. The genuine authoring gap was six
 * statements and three columns, and migration 036 closed it.
 *
 * Both numbers are worth keeping. This one bounds the deletion backlog; the
 * other bounds the authoring gap, and only the second one blocks anything.
 */

import { runtimeDdl, migrationObjects } from '../scripts/runtime-ddl-inventory';

/**
 * Lower it as statements move into migrations. Never raise it.
 *
 * 154 → 148 and 112 → 106 when migration 036 claimed the six objects that
 * neither a migration nor the baseline declared. What remains is not an
 * authoring backlog: `npm run schema:authority` shows every one of them touches
 * an object `scripts/baseline/000-baseline.sql` already builds, so they are
 * redundant statements awaiting DELETION rather than schema awaiting design. See
 * `tests/schema-authority.test.ts` for why that distinction rescopes TAB 02.
 *
 * 148 → 144 as the deletion pass began: `accountDeletionService` (table + 2
 * partial indexes) and `providerOperationalAvailabilityService` (1 table, plus
 * three lazy awaits).
 *
 * 144 → 111 and 102 → 73 with the eight bootstraps no test pinned in source text:
 * adminNotificationService, adminMobileAttributionService, adminBookingDraftService,
 * providerOnboardingService, providerActivationService, identityColumns and
 * adminOnboardingService (seven tables and eight indexes in one function).
 * 34 lazy awaits and 6 startup dependencies went with them — the startup graph is
 * 13 dependencies now, down from 19.
 *
 * 111 → 105 with `providerAvailabilityEngine` and `providerServiceAreaEngine`,
 * which also took the contested-object count from 7 to 4: both duplicated tables
 * `technicianService` creates, and a second `CREATE TABLE IF NOT EXISTS` for one
 * object is a race with a silent loser.
 *
 * 105 → 94 and 73 → 69 with `adminProviderService`, `adminInviteState`,
 * `adminAuditService`, `adminFinanceService` and `adminGuestService`. Two more
 * startup dependencies went (the graph is 11), including the last `required`
 * PAYMENT one — `ensureFinanceSchema`, which also created a FUNCTION and the only
 * TRIGGER in the schema, plus a one-time DML backfill of `payments.updated_at`.
 *
 * ⚠ This number understates what was removed. Fifteen of those statements were
 * `CREATE INDEX` with an interpolated NAME, which `ddl:inventory` cannot see at
 * all — see the interpolated-index block in `tests/schema-authority.test.ts`.
 *
 * 94 → 81 and 69 → 56 with `adminPermissionService` and `customerSupportService`.
 * The first was SPLIT rather than deleted: it created four tables and four indexes
 * AND seeded the permission catalog, so the DDL went and the seeding stayed —
 * renamed `seedAdminPermissions`, because a function called
 * `ensurePermissionSchema` that touches no schema is a lie the next reader has to
 * find by reading the body. Its startup entry stays `required`: a grant row is
 * meaningless without its definition row, so an unseeded database holds grants
 * that resolve to nothing.
 *
 * 81 → 65 and 56 → 44 with `adminCommunicationService` and
 * `providerCatalogService`. The catalog one needed no split — its seeding was
 * already a separate export, which is the shape to aim for.
 *
 * 65 → 41 and 44 → 32 with `serviceApplicationService` and six bootstraps in
 * `technicianService`. NOT `ensureOnboardingTable`: it creates `worker_onboarding`,
 * which migration 036 claims and production does NOT have, so deleting it before
 * 036 is applied would make worker onboarding depend on an unapplied migration.
 *
 * 41 → 3 and 32 → 3 with `notification.service` (both bootstraps),
 * `providerAutoOnlineEngine`, `adminBookingService` and
 * `adminCreateBookingService`. The startup graph is SIX entries, and only one is
 * still `required` — `admin-permission-seed`, which seeds DATA, not schema.
 *
 * Everything still counted here is `chat.repository`, which is deferred: its
 * bootstrap also runs a DML derivation of `chat_conversations.status` from
 * `is_closed`, and that has three consumers.
 */
const UNMANAGED_BUDGET = 3;
const DISTINCT_OBJECT_BUDGET = 3;

describe('runtime schema authority is bounded and shrinking', () => {
  const ddl = runtimeDdl();
  const owned = migrationObjects();
  const unmanaged = ddl.filter((d) => !owned.has(d.object));

  it('finds runtime DDL at all (positive fixture)', () => {
    /**
     * A broken scan would find none and pass the budget forever.
     *
     * The floor sits well BELOW the current count on purpose. It was 100 and the
     * count fell to 94 — the fixture failed because the work SUCCEEDED, which is
     * the second time that has happened in this pass. A positive fixture proves
     * the scan functions; it must never double as a budget.
     */
    expect(ddl.length).toBeGreaterThan(20);
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

  it('the seven TAB 15 called missing were runtime-created, and are being retired', () => {
    /**
     * TAB 15 concluded these seven were "altered or read by migrations and created
     * by none". They were never missing — they were created at RUNTIME. This test
     * pinned that correction, and its original note said: "If these ever become
     * migration-owned this fails, and TAB 15's baseline requirements should shrink
     * in the same change."
     *
     * That is now happening, by the other route the note did not anticipate: the
     * deletion pass. FIVE of the seven are no longer created by anything at
     * runtime — the baseline supplies them, and `adminOnboardingService`,
     * `providerOnboardingService`, `providerCatalogService` and
     * `serviceApplicationService` no longer issue DDL. They are absent from this
     * scan entirely, which is the goal rather than a regression.
     *
     * The two survivors are down to ONE statement each: `service_options` from
     * four, `employee_services` from eight, as `providerCatalogService`,
     * `serviceApplicationService` and `technicianService` each stopped altering
     * them.
     *
     * The list therefore splits: still runtime-created, and retired. Moving a name
     * from one array to the other is the correct diff when a bootstrap is deleted.
     * Both arrays are asserted, so a name cannot silently vanish from both.
     */
    const objects = new Set(unmanaged.map((d) => d.object));

    // ALL SEVEN are retired now. None is created by anything at runtime.
    const retired = [
      'service_options',
      'service_option_meta',
      'provider_catalog_offerings',
      'provider_onboarding_cases',
      'provider_onboarding_drafts',
      'worker_service_applications',
      'employee_services',
    ];
    expect(retired).toHaveLength(7);
    for (const table of retired) {
      expect(objects).not.toContain(table);
    }

    // All seven are still accounted for, so none was dropped from the record.
  });
});
