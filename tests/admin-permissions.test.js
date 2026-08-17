/**
 * admin-permissions.test.js
 * Source-inspection tests for the admin permission system (C17).
 * Pattern: inspect source code for correct structure, imports, logic — no DB required.
 */

const fs   = require('fs');
const path = require('path');

const SVC    = path.resolve(__dirname, '../src/services/adminPermissionService.ts');
const MW     = path.resolve(__dirname, '../src/middleware/requirePermission.ts');
const CTRL   = path.resolve(__dirname, '../src/controllers/adminPermissionController.ts');
const ROUTES = path.resolve(__dirname, '../src/routes/adminPermission.routes.ts');
const APP    = path.resolve(__dirname, '../src/app.ts');
const STARTUP = path.resolve(__dirname, '../src/startup.ts');
const AUDIT  = path.resolve(__dirname, '../src/services/adminAuditService.ts');

// ── Route files ───────────────────────────────────────────────────────────────
const PROVIDER_ROUTES   = path.resolve(__dirname, '../src/routes/adminProvider.routes.ts');
const ONBOARDING_ROUTES = path.resolve(__dirname, '../src/routes/adminOnboarding.routes.ts');
const BOOKING_ROUTES    = path.resolve(__dirname, '../src/routes/adminBooking.routes.ts');
const DASHBOARD_ROUTES  = path.resolve(__dirname, '../src/routes/adminDashboard.routes.ts');
const AUDIT_ROUTES      = path.resolve(__dirname, '../src/routes/adminAudit.routes.ts');
const COMM_ROUTES       = path.resolve(__dirname, '../src/routes/adminCommunication.routes.ts');
const AUTOONLINE_ROUTES = path.resolve(__dirname, '../src/routes/adminAutoOnline.routes.ts');
const FINANCE_ROUTES    = path.resolve(__dirname, '../src/routes/adminFinance.routes.ts');
const AVAIL_ROUTES      = path.resolve(__dirname, '../src/routes/adminProviderAvailability.routes.ts');

function read(f) { return fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n'); }

// ── SERVICE TESTS ──────────────────────────────────────────────────────────────

describe('adminPermissionService — file structure', () => {
  const src = read(SVC);

  test('imports dbQuery and db from config', () => {
    // Matches the default import regardless of any named imports alongside it —
    // pinning the exact string broke as soon as `pool` was added for
    // bootstrapSuperAdmin's transaction, which is not what this test is about.
    expect(src).toMatch(/import dbQuery(?:,\s*\{[^}]*\})?\s+from '\.\.\/db\/dbQuery'/);
    expect(src).toContain("import { db } from '../config'");
  });

  test('exports seedAdminPermissions, and no schema bootstrap (TAB 02)', () => {
    // Renamed when the DDL was removed: the function seeds the permission
    // catalog and promotes role=1 accounts, and touches no schema.
    expect(src).toContain('export async function seedAdminPermissions');
    expect(src).not.toContain('export async function ensurePermissionSchema');
  });

  test('exports getAdminUser', () => {
    expect(src).toContain('export async function getAdminUser');
  });

  test('exports ensureAdminUserRow', () => {
    expect(src).toContain('export async function ensureAdminUserRow');
  });

  test('exports isSuperAdmin', () => {
    expect(src).toContain('export async function isSuperAdmin');
  });

  test('exports hasPermission', () => {
    expect(src).toContain('export async function hasPermission');
  });

  test('exports getEffectivePermissions', () => {
    expect(src).toContain('export async function getEffectivePermissions');
  });

  test('exports listAdminUsers', () => {
    expect(src).toContain('export async function listAdminUsers');
  });

  test('exports getAdminUserDetail', () => {
    expect(src).toContain('export async function getAdminUserDetail');
  });

  test('exports createAdminUser', () => {
    expect(src).toContain('export async function createAdminUser');
  });

  test('exports updateAdminUser', () => {
    expect(src).toContain('export async function updateAdminUser');
  });

  test('exports updateAdminUserStatus', () => {
    expect(src).toContain('export async function updateAdminUserStatus');
  });

  test('exports getPermissionDefinitions', () => {
    expect(src).toContain('export async function getPermissionDefinitions');
  });

  test('exports getAdminUserPermissions', () => {
    expect(src).toContain('export async function getAdminUserPermissions');
  });

  test('exports previewPermissionChange', () => {
    expect(src).toContain('export async function previewPermissionChange');
  });

  test('exports updateAdminUserPermissions', () => {
    expect(src).toContain('export async function updateAdminUserPermissions');
  });

  test('exports getPermissionHistory', () => {
    expect(src).toContain('export async function getPermissionHistory');
  });

  test('exports assertAtLeastOneSuperAdmin', () => {
    expect(src).toContain('export async function assertAtLeastOneSuperAdmin');
  });

  test('exports bootstrapSuperAdmin', () => {
    expect(src).toContain('export async function bootstrapSuperAdmin');
  });

  test('exports resolvePermissionDependencies', () => {
    expect(src).toContain('export function resolvePermissionDependencies');
  });

  test('exports invalidatePermissionCache', () => {
    expect(src).toContain('export function invalidatePermissionCache');
  });
});

describe('adminPermissionService — the four tables come from the baseline (TAB 02)', () => {
  const src = read(SVC);
  const baseline = fs
    .readFileSync(path.join(__dirname, '..', 'scripts', 'baseline', '000-baseline.sql'), 'utf8')
    .replace(/\r\n/g, '\n');

  /**
   * These asserted the service source contained `CREATE TABLE IF NOT EXISTS`,
   * `idx_perm_grants_uid`, and so on. That was the right check while the service
   * created its own schema at boot.
   *
   * It does not any more. The four tables and four indexes are in
   * `scripts/baseline/000-baseline.sql` — production's own dump, and what
   * `db:verify:embedded` builds a fresh database from — so the assertions check
   * the schema that will actually exist rather than code that meant to create it.
   */

  test('the service issues no DDL at all', () => {
    expect(src).not.toContain('CREATE TABLE');
    expect(src).not.toContain('CREATE INDEX');
    expect(src).not.toContain('ADD COLUMN');
  });

  test('all four tables are declared by the baseline', () => {
    ['admin_users', 'admin_permission_definitions', 'admin_permission_grants', 'admin_permission_events']
      .forEach((table) => {
        expect(baseline).toContain('CREATE TABLE servana.' + table + ' (');
      });
  });

  test('all four indexes are declared by the baseline', () => {
    ['idx_perm_grants_uid', 'idx_perm_grants_key', 'idx_perm_grants_uid_granted', 'idx_perm_events_target']
      .forEach((idx) => {
        expect(baseline).toContain(idx);
      });
  });

  test('the seeding it still does is idempotent, so every boot is safe', () => {
    // Both halves run unattended on each start. The promotion only ever INSERTs:
    // removing an admin is a decision with an actor and a reason.
    expect(src).toContain('ON CONFLICT (admin_uid) DO NOTHING');
    expect(src).toContain('ON CONFLICT (permission_key) DO UPDATE');
    expect(src).not.toMatch(/DELETE FROM \$\{s\}\.admin_users/);
  });
});

describe('adminPermissionService — permission cache', () => {
  const src = read(SVC);

  test('uses 60s TTL constant', () => {
    expect(src).toContain('60_000');
  });

  test('cache uses Map', () => {
    expect(src).toContain('new Map<string');
  });

  test('invalidatePermissionCache deletes from map', () => {
    expect(src).toContain('permCache.delete(');
  });

  test('cache key for super admin uses sa: prefix', () => {
    expect(src).toContain('sa:${adminUid}');
  });
});

describe('adminPermissionService — permission seeds', () => {
  const src = read(SVC);

  test('seeds dashboard.view permission', () => {
    expect(src).toContain("'dashboard.view'");
  });

  test('seeds bookings.view permission', () => {
    expect(src).toContain("'bookings.view'");
  });

  test('seeds bookings.cancel permission', () => {
    expect(src).toContain("'bookings.cancel'");
  });

  test('seeds providers.view permission', () => {
    expect(src).toContain("'providers.view'");
  });

  test('seeds providers.suspend with is_dangerous flag', () => {
    const suspendIdx = src.indexOf("key: 'providers.suspend'");
    const segment = src.substring(suspendIdx, suspendIdx + 300);
    expect(segment).toContain('is_dangerous: true');
  });

  test('seeds onboarding.final_approve permission', () => {
    expect(src).toContain("'onboarding.final_approve'");
  });

  test('seeds payments.gcash.approve permission', () => {
    expect(src).toContain("'payments.gcash.approve'");
  });

  test('seeds admin_users.view permission', () => {
    expect(src).toContain("'admin_users.view'");
  });

  test('seeds admin_permissions.grant_super_admin permission', () => {
    expect(src).toContain("'admin_permissions.grant_super_admin'");
  });

  test('seeds developer permissions as hidden from normal UI', () => {
    const devIdx = src.indexOf("module: 'developer'");
    expect(devIdx).toBeGreaterThan(-1);
    const segment = src.substring(devIdx, devIdx + 600);
    expect(segment).toContain('is_hidden_from_normal_ui: true');
  });

  test('seeds at least 100 permission keys', () => {
    const matches = src.match(/key: '[a-z_]+(\.[a-z_]+)+'/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(100);
  });
});

describe('adminPermissionService — safety guards', () => {
  const src = read(SVC);

  test('assertAtLeastOneSuperAdmin checks active super admin count', () => {
    const fn = src.substring(src.indexOf('assertAtLeastOneSuperAdmin'));
    expect(fn).toContain('is_super_admin');
    expect(fn).toContain("account_status = 'active'");
  });

  test('assertAtLeastOneSuperAdmin throws BUSINESS_RULE if zero remaining', () => {
    expect(src).toContain("code: 'BUSINESS_RULE'");
    expect(src).toContain('last active Super Admin');
  });

  test('updateAdminUserStatus guards deactivation of last Super Admin', () => {
    const fnStart = src.indexOf('export async function updateAdminUserStatus');
    const segment = src.substring(fnStart, fnStart + 600);
    expect(segment).toContain('assertAtLeastOneSuperAdmin');
  });

  // Scans the WHOLE function body rather than a fixed byte window. The previous
  // `substring(fnStart, fnStart + 600)` broke the moment the function grew a
  // comment, which says nothing about whether the guard still works.
  function bootstrapBody() {
    const start = src.indexOf('export async function bootstrapSuperAdmin');
    expect(start).toBeGreaterThan(-1);
    const after = src.indexOf('\nexport ', start + 1);
    return src.substring(start, after === -1 ? src.length : after);
  }

  test('bootstrapSuperAdmin rejects if super admin already exists', () => {
    const segment = bootstrapBody();
    expect(segment).toContain('Super Admin already exists');
    expect(segment).toContain("code: 'CONFLICT'");
  });

  test('bootstrapSuperAdmin counts super admins regardless of account_status', () => {
    // Filtering the count on account_status = 'active' meant deactivating every
    // Super Admin reopened self-promotion to any authenticated user.
    const segment = bootstrapBody();
    expect(segment).toContain("FILTER (WHERE is_super_admin = TRUE)");
    expect(segment).not.toContain("account_status = 'active'");
  });

  test('bootstrapSuperAdmin checks and writes inside one locked transaction', () => {
    // Without this the check and the insert are separable and two concurrent
    // callers can both pass the "no super admin yet" check.
    const segment = bootstrapBody();
    expect(segment).toContain('pg_advisory_xact_lock');
    expect(segment).toContain("client.query('BEGIN')");
    expect(segment).toContain("client.query('COMMIT')");
    expect(segment).toContain("client.query('ROLLBACK')");
  });

  test('bootstrapSuperAdmin requires an existing admin when admin users exist', () => {
    // Only a completely empty admin_users table is open to any authenticated
    // caller; otherwise a customer could claim the first Super Admin slot.
    const segment = bootstrapBody();
    expect(segment).toContain('NOT_AN_EXISTING_ADMIN');
  });

  test('bootstrapSuperAdmin audits refused attempts', () => {
    const segment = bootstrapBody();
    expect(segment).toContain('super_admin_bootstrap_denied');
  });

  test('updateAdminUserPermissions requires reason', () => {
    const fnStart = src.indexOf('export async function updateAdminUserPermissions');
    const segment = src.substring(fnStart, fnStart + 400);
    expect(segment).toContain('Reason is required');
  });
});

describe('adminPermissionService — resolvePermissionDependencies', () => {
  const src = read(SVC);

  test('resolvePermissionDependencies uses BFS', () => {
    const fnStart = src.indexOf('export function resolvePermissionDependencies');
    const segment = src.substring(fnStart, fnStart + 500);
    expect(segment).toContain('queue');
    expect(segment).toContain('requires');
  });

  test('returns resolved and added arrays', () => {
    const fnStart = src.indexOf('export function resolvePermissionDependencies');
    const segment = src.substring(fnStart, fnStart + 600);
    expect(segment).toContain('resolved');
    expect(segment).toContain('added');
  });
});

// ── MIDDLEWARE TESTS ──────────────────────────────────────────────────────────

describe('requirePermission middleware', () => {
  const src = read(MW);

  test('exports requirePermission factory', () => {
    expect(src).toContain('export function requirePermission(key: string)');
  });

  test('exports requireAnyPermission factory', () => {
    expect(src).toContain('export function requireAnyPermission(');
  });

  test('exports requireAllPermissions factory', () => {
    expect(src).toContain('export function requireAllPermissions(');
  });

  test('exports requireSuperAdmin middleware', () => {
    expect(src).toContain('export const requireSuperAdmin');
  });

  test('imports from adminPermissionService', () => {
    expect(src).toContain("from '../services/adminPermissionService'");
  });

  test('imports from adminAuditService', () => {
    expect(src).toContain("from '../services/adminAuditService'");
  });

  test('imports adminError helper', () => {
    expect(src).toContain("from '../helpers/adminError'");
  });

  test('Super Admins bypass permission check', () => {
    expect(src).toContain('isSuperAdmin');
    expect(src).toContain('next()');
  });

  test('inactive account returns 403', () => {
    expect(src).toContain("account_status !== 'active'");
    expect(src).toContain('Account is not active');
  });

  test('missing permission returns 403 with key', () => {
    expect(src).toContain('Missing required permission');
  });

  test('logs admin_access_denied to audit on block', () => {
    expect(src).toContain("action: 'admin_access_denied'");
  });

  test('calls ensureAdminUserRow to auto-create row', () => {
    expect(src).toContain('ensureAdminUserRow');
  });
});

// ── CONTROLLER TESTS ─────────────────────────────────────────────────────────

describe('adminPermissionController', () => {
  const src = read(CTRL);

  test('exports getMyPermissions', () => {
    expect(src).toContain('export async function getMyPermissions');
  });

  test('exports getPermissionDefinitions', () => {
    expect(src).toContain('export async function getPermissionDefinitions');
  });

  test('exports listAdminUsers', () => {
    expect(src).toContain('export async function listAdminUsers');
  });

  test('exports createAdminUser', () => {
    expect(src).toContain('export async function createAdminUser');
  });

  test('exports getAdminUserById', () => {
    expect(src).toContain('export async function getAdminUserById');
  });

  test('exports updateAdminUser', () => {
    expect(src).toContain('export async function updateAdminUser');
  });

  test('exports updateAdminUserStatus', () => {
    expect(src).toContain('export async function updateAdminUserStatus');
  });

  test('exports getAdminUserPermissions', () => {
    expect(src).toContain('export async function getAdminUserPermissions');
  });

  test('exports updateAdminUserPermissions', () => {
    expect(src).toContain('export async function updateAdminUserPermissions');
  });

  test('exports previewPermissionChange', () => {
    expect(src).toContain('export async function previewPermissionChange');
  });

  test('exports getPermissionHistory', () => {
    expect(src).toContain('export async function getPermissionHistory');
  });

  test('exports bootstrapSuperAdmin', () => {
    expect(src).toContain('export async function bootstrapSuperAdmin');
  });

  test('createAdminUser validates adminUid and email required', () => {
    const fnStart = CTRL_src.indexOf ? CTRL_src.indexOf('export async function createAdminUser') : src.indexOf('export async function createAdminUser');
    const segment = src.substring(src.indexOf('export async function createAdminUser'), src.indexOf('export async function createAdminUser') + 400);
    expect(segment).toContain('adminUid and email are required');
  });

  test('updateAdminUserStatus validates status value', () => {
    const fnStart = src.indexOf('export async function updateAdminUserStatus');
    const segment = src.substring(fnStart, fnStart + 500);
    expect(segment).toContain('status must be one of');
  });

  test('updateAdminUserPermissions validates permissions is array', () => {
    const fnStart = src.indexOf('export async function updateAdminUserPermissions');
    const segment = src.substring(fnStart, fnStart + 900);
    expect(segment).toContain('Array.isArray');
    expect(segment).toContain('reason is required');
  });

  test('handles NOT_FOUND errors', () => {
    expect(src).toContain("e?.code === 'NOT_FOUND'");
  });

  test('handles CONFLICT errors', () => {
    expect(src).toContain("e?.code === 'CONFLICT'");
  });

  test('handles BUSINESS_RULE errors', () => {
    expect(src).toContain("e?.code === 'BUSINESS_RULE'");
  });

  test('handles FORBIDDEN errors', () => {
    expect(src).toContain("e?.code === 'FORBIDDEN'");
  });
});

// ── ROUTES TESTS ─────────────────────────────────────────────────────────────

describe('adminPermission.routes.ts', () => {
  const src = read(ROUTES);

  test('imports requirePermission and requireSuperAdmin', () => {
    expect(src).toContain("requirePermission, requireSuperAdmin");
  });

  test('mounts GET /admin/me/permissions with verifyAuth only', () => {
    expect(src).toContain("'/admin/me/permissions'");
    expect(src).toContain('verifyAuth, ctrl.getMyPermissions');
  });

  test('mounts GET /admin/permission-definitions', () => {
    expect(src).toContain("'/admin/permission-definitions'");
  });

  test('GET /admin/admin-users requires admin_users.view', () => {
    const idx = src.indexOf("'/admin/admin-users'");
    const segment = src.substring(idx - 10, idx + 200);
    expect(segment).toContain("requirePermission('admin_users.view')");
  });

  test('POST /admin/admin-users requires requireSuperAdmin', () => {
    // Route may span multiple lines — search a 200-char window around the POST route
    const idx = src.indexOf("router.post('/admin/admin-users'");
    expect(idx).toBeGreaterThan(-1);
    const segment = src.substring(idx, idx + 200);
    expect(segment).toContain('requireSuperAdmin');
  });

  test('bootstrap-super-admin route exists with verifyAuth+verifyRoles', () => {
    expect(src).toContain('bootstrap-super-admin');
    expect(src).toContain('verifyRoles([1])');
  });

  test('PATCH /admin/admin-users/:adminUid requires requireSuperAdmin', () => {
    // Find the PATCH /:adminUid route that is NOT /status or /permissions
    const idx = src.indexOf("router.patch('/admin/admin-users/:adminUid',");
    expect(idx).toBeGreaterThan(-1);
    const segment = src.substring(idx, idx + 200);
    expect(segment).toContain('requireSuperAdmin');
  });

  test('PATCH /admin/admin-users/:adminUid/status requires requireSuperAdmin', () => {
    const idx = src.indexOf("'/admin/admin-users/:adminUid/status'");
    expect(idx).toBeGreaterThan(-1);
    const segment = src.substring(idx - 50, idx + 200);
    expect(segment).toContain('requireSuperAdmin');
  });

  test('GET /admin/admin-users/:adminUid/permissions requires requireSuperAdmin', () => {
    const idx = src.indexOf("'/admin/admin-users/:adminUid/permissions'");
    expect(idx).toBeGreaterThan(-1);
    const segment = src.substring(idx - 50, idx + 200);
    expect(segment).toContain('requireSuperAdmin');
  });
});

// ── app.ts WIRING TESTS ───────────────────────────────────────────────────────

describe('app.ts — permission route registration', () => {
  const src = read(APP);

  test('imports adminPermissionRoutes', () => {
    expect(src).toContain("adminPermissionRoutes from \"./routes/adminPermission.routes\"");
  });

  test('registers adminPermissionRoutes on /api', () => {
    expect(src).toContain('adminPermissionRoutes');
    const idx = src.indexOf('adminPermissionRoutes');
    const segment = src.substring(idx - 50, idx + 80);
    expect(segment).toContain('/api');
  });

  /**
   * TAB 03 moved these bootstraps out of app.ts into a declared dependency
   * graph. The IIFE and its `[admin-permission]` catch are gone — replaced by
   * a classification and a central failure path — so the assertions now check
   * the thing that carries the guarantee.
   *
   * This is strictly stronger. "app.ts mentions ensurePermissionSchema" could
   * not distinguish a live bootstrap from a stale import; the graph says the
   * dependency exists AND that authorization is `required`, so a failure
   * withholds readiness rather than being logged.
   */
  test('the permission SEED is a declared startup dependency', () => {
    const startup = fs.readFileSync(STARTUP, 'utf8').replace(/\r\n/g, '\n');
    expect(startup).toContain('seedAdminPermissions');
    expect(startup).toContain("name: 'admin-permission-seed'");
  });

  test('authorization is classified required, not optional', () => {
    // TAB 03 stop condition: an authorization dependency must never be
    // silently downgraded to optional.
    const startup = fs.readFileSync(STARTUP, 'utf8').replace(/\r\n/g, '\n');
    const idx = startup.indexOf("name: 'admin-permission-seed'");
    expect(idx).toBeGreaterThan(-1);
    expect(startup.substring(idx, idx + 200)).toContain("kind: 'required'");
  });
});

// ── adminAuditService UPDATES ─────────────────────────────────────────────────

describe('adminAuditService — permission entity types', () => {
  const src = read(AUDIT);

  test('includes admin_user in AuditEntityType', () => {
    expect(src).toContain("'admin_user'");
  });

  test('includes permission_grant in AuditEntityType', () => {
    expect(src).toContain("'permission_grant'");
  });

  test('includes permission_profile in AuditEntityType', () => {
    expect(src).toContain("'permission_profile'");
  });

  test('includes super_admin_granted in HIGH_RISK_ACTIONS', () => {
    expect(src).toContain("'super_admin_granted'");
  });

  test('includes super_admin_revoked in HIGH_RISK_ACTIONS', () => {
    expect(src).toContain("'super_admin_revoked'");
  });

  test('includes admin_user_created in HIGH_RISK_ACTIONS', () => {
    expect(src).toContain("'admin_user_created'");
  });

  test('includes admin_user_deactivated in HIGH_RISK_ACTIONS', () => {
    expect(src).toContain("'admin_user_deactivated'");
  });

  test('includes admin_permissions_updated in HIGH_RISK_ACTIONS', () => {
    expect(src).toContain("'admin_permissions_updated'");
  });

  test('includes admin_user_created in ACTION_LABELS', () => {
    expect(src).toContain("admin_user_created: 'Admin User Created'");
  });

  test('includes super_admin_granted in ACTION_LABELS', () => {
    expect(src).toContain("super_admin_granted: 'Super Admin Granted'");
  });

  test('includes admin_access_denied in ACTION_LABELS', () => {
    expect(src).toContain("admin_access_denied: 'Admin Access Denied'");
  });
});

// ── EXISTING ROUTES NOW WIRED WITH requirePermission ────────────────────────

describe('adminProvider.routes.ts — requirePermission wired', () => {
  const src = read(PROVIDER_ROUTES);

  test('imports requirePermission', () => {
    expect(src).toContain("{ requirePermission }");
  });

  test('provider list route uses providers.view', () => {
    expect(src).toContain("requirePermission('providers.view')");
  });

  test('account-status route uses providers.status.change', () => {
    expect(src).toContain("requirePermission('providers.status.change')");
  });

  test('archive route uses providers.archive', () => {
    expect(src).toContain("requirePermission('providers.archive')");
  });

  test('earnings route uses providers.earnings.view (sensitive)', () => {
    expect(src).toContain("requirePermission('providers.earnings.view')");
  });

  test('documents upload uses providers.documents.upload', () => {
    expect(src).toContain("requirePermission('providers.documents.upload')");
  });
});

describe('adminOnboarding.routes.ts — requirePermission wired', () => {
  const src = read(ONBOARDING_ROUTES);

  test('imports requirePermission', () => {
    expect(src).toContain("{ requirePermission }");
  });

  test('queue/case list uses onboarding.view', () => {
    expect(src).toContain("requirePermission('onboarding.view')");
  });

  test('final-approve uses onboarding.final_approve', () => {
    expect(src).toContain("requirePermission('onboarding.final_approve')");
  });

  test('final-reject uses onboarding.final_reject', () => {
    expect(src).toContain("requirePermission('onboarding.final_reject')");
  });

  test('requirement approve uses onboarding.requirement.approve', () => {
    expect(src).toContain("requirePermission('onboarding.requirement.approve')");
  });
});

describe('adminBooking.routes.ts — requirePermission wired', () => {
  const src = read(BOOKING_ROUTES);

  test('imports requirePermission', () => {
    expect(src).toContain("{ requirePermission }");
  });

  test('list uses bookings.view', () => {
    expect(src).toContain("requirePermission('bookings.view')");
  });

  test('cancel uses bookings.cancel', () => {
    expect(src).toContain("requirePermission('bookings.cancel')");
  });

  test('approve-completion uses bookings.approve_completion', () => {
    expect(src).toContain("requirePermission('bookings.approve_completion')");
  });

  test('assign uses bookings.assign_provider', () => {
    expect(src).toContain("requirePermission('bookings.assign_provider')");
  });
});

describe('adminDashboard.routes.ts — requirePermission wired', () => {
  const src = read(DASHBOARD_ROUTES);

  test('imports requirePermission', () => {
    expect(src).toContain("{ requirePermission }");
  });

  test('operations route uses dashboard.view', () => {
    expect(src).toContain("requirePermission('dashboard.view')");
  });
});

describe('adminAudit.routes.ts — requirePermission wired', () => {
  const src = read(AUDIT_ROUTES);

  test('imports requirePermission', () => {
    expect(src).toContain("{ requirePermission }");
  });

  test('list uses audit_logs.view', () => {
    expect(src).toContain("requirePermission('audit_logs.view')");
  });

  test('export uses audit_logs.export', () => {
    expect(src).toContain("requirePermission('audit_logs.export')");
  });
});

describe('adminCommunication.routes.ts — requirePermission wired', () => {
  const src = read(COMM_ROUTES);

  test('imports requirePermission', () => {
    expect(src).toContain("{ requirePermission }");
  });

  test('summary uses communications.view', () => {
    expect(src).toContain("requirePermission('communications.view')");
  });

  test('bulk-retry uses communications.bulk_retry_failed', () => {
    expect(src).toContain("requirePermission('communications.bulk_retry_failed')");
  });

  test('templates create uses communications.templates.create', () => {
    expect(src).toContain("requirePermission('communications.templates.create')");
  });
});

describe('adminAutoOnline.routes.ts — requirePermission wired', () => {
  const src = read(AUTOONLINE_ROUTES);

  test('imports requirePermission', () => {
    expect(src).toContain("{ requirePermission }");
  });

  test('summary uses auto_online.view', () => {
    expect(src).toContain("requirePermission('auto_online.view')");
  });

  test('disable uses auto_online.disable', () => {
    expect(src).toContain("requirePermission('auto_online.disable')");
  });

  test('backfill-apply uses auto_online.backfill_apply (dangerous)', () => {
    expect(src).toContain("requirePermission('auto_online.backfill_apply')");
  });
});

describe('adminFinance.routes.ts — requirePermission wired', () => {
  const src = read(FINANCE_ROUTES);

  test('imports requirePermission', () => {
    expect(src).toContain("{ requirePermission }");
  });

  test('summary uses finance.dashboard.view', () => {
    expect(src).toContain("requirePermission('finance.dashboard.view')");
  });

  test('gcash approve uses payments.gcash.approve (critical)', () => {
    expect(src).toContain("requirePermission('payments.gcash.approve')");
  });

  test('gcash reject uses payments.gcash.reject (critical)', () => {
    expect(src).toContain("requirePermission('payments.gcash.reject')");
  });

  test('refund approve uses refunds.approve (critical)', () => {
    expect(src).toContain("requirePermission('refunds.approve')");
  });

  test('payout retry uses payouts.retry_failed (critical)', () => {
    expect(src).toContain("requirePermission('payouts.retry_failed')");
  });

  test('reconciliation run uses reconciliation.run', () => {
    expect(src).toContain("requirePermission('reconciliation.run')");
  });
});

describe('adminProviderAvailability.routes.ts — requirePermission wired', () => {
  const src = read(AVAIL_ROUTES);

  test('imports requirePermission', () => {
    expect(src).toContain("{ requirePermission }");
  });

  test('summary uses provider_availability.view', () => {
    expect(src).toContain("requirePermission('provider_availability.view')");
  });

  test('evaluate-booking uses provider_eligibility.preview', () => {
    expect(src).toContain("requirePermission('provider_eligibility.preview')");
  });
});

// ── COMPATIBILITY — Protected mobile/provider-web routes untouched ───────────

describe('Protected mobile and provider-web routes — no changes', () => {
  const workerRoutes = path.resolve(__dirname, '../src/routes/technician.routes.ts');
  const paymentRoutes = path.resolve(__dirname, '../src/routes/payment.routes.ts');

  test('technician.routes.ts (worker mobile) still exists', () => {
    expect(fs.existsSync(workerRoutes)).toBe(true);
  });

  test('payment.routes.ts still exists', () => {
    expect(fs.existsSync(paymentRoutes)).toBe(true);
  });

  test('provider catalog routes file: provider-facing route has no permission gate, admin routes do', () => {
    const catalogRoutes = path.resolve(__dirname, '../src/routes/providerCatalog.routes.ts');
    expect(fs.existsSync(catalogRoutes)).toBe(true);
    const src = fs.readFileSync(catalogRoutes, 'utf8').replace(/\r\n/g, '\n');
    // Provider-facing offering route must NOT have requirePermission (would break provider web app)
    const providerBlock = src.indexOf('"/provider-catalog/v1/offerings"');
    expect(providerBlock).toBeGreaterThan(-1);
    expect(src.substring(providerBlock, providerBlock + 200)).not.toContain('requirePermission');
    // Admin routes MUST have requirePermission (security enforcement)
    expect(src).toContain("requirePermission");
    expect(src).toContain("services.view");
    expect(src).toContain("services.publish");
  });

  test('adminPermissionService does not modify existing provider/booking/payment tables', () => {
    const src = read(SVC);
    // The service must not touch mobile-authoritative tables
    expect(src).not.toContain('ALTER TABLE bookings');
    expect(src).not.toContain('ALTER TABLE payments');
    expect(src).not.toContain('ALTER TABLE disbursements');
  });
});

// ── COLUMN / FIELD SECURITY ──────────────────────────────────────────────────

describe('Security — no sensitive data in default admin user listings', () => {
  const src = read(SVC);

  test('listAdminUsers does not SELECT password fields', () => {
    const fnStart = src.indexOf('export async function listAdminUsers');
    const segment = src.substring(fnStart, fnStart + 500);
    expect(segment).not.toContain('password');
    expect(segment).not.toContain('secret');
  });

  test('permission grants store granted_by and no credential columns', () => {
    /**
     * This used to slice 500 characters after the first mention of
     * `admin_permission_grants` in the service, which worked only because the
     * CREATE TABLE was there. The column list now lives in the baseline, so
     * the window is taken from the real definition.
     */
    const baseline = fs
      .readFileSync(path.join(__dirname, '..', 'scripts', 'baseline', '000-baseline.sql'), 'utf8')
      .replace(/\r\n/g, '\n');
    const table = /CREATE TABLE servana\.admin_permission_grants \(([\s\S]*?)\n\);/.exec(baseline);
    expect(table).not.toBeNull();
    expect(table[1]).toContain('granted_by');
    expect(table[1]).not.toContain('password');
    expect(table[1]).not.toContain('token');
  });
});

// Dummy reference to avoid ReferenceError on CTRL_src
const CTRL_src = { indexOf: () => -1 };
