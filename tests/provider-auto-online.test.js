/**
 * Command 14 — Provider Auto-Online Engine tests.
 *
 * These are source-inspection tests (no running server, no live DB).
 * They verify wiring, guard contracts, and data shapes.
 */

const fs   = require('fs');
const { bareRoutes } = require('./helpers/routeAuth');
const path = require('path');

const SRC  = (...parts) => path.join(__dirname, '..', 'src', ...parts);
const SVC  = (...parts) => SRC('services', ...parts);
const CTRL = (...parts) => SRC('controllers', ...parts);
const ROUTE = (...parts) => SRC('routes', ...parts);

// ── Engine file existence ─────────────────────────────────────────────────────

describe('Command 14 — providerAutoOnlineEngine.ts exists', () => {
  it('engine file is present', () => {
    expect(fs.existsSync(SVC('providerAutoOnlineEngine.ts'))).toBe(true);
  });
});

// ── Table definitions ─────────────────────────────────────────────────────────

describe('Command 14 — 3 required tables defined in engine', () => {
  let engine;
  beforeAll(() => { engine = fs.readFileSync(SVC('providerAutoOnlineEngine.ts'), 'utf8'); });

  it('defines provider_auto_online_state table', () => {
    expect(engine).toContain('provider_auto_online_state');
    expect(engine).toContain('is_auto_online');
    expect(engine).toContain('is_bookable');
    expect(engine).toContain('activation_mode');
  });

  it('defines provider_provisional_bookable_services table', () => {
    expect(engine).toContain('provider_provisional_bookable_services');
  });

  it('defines provider_auto_online_events audit table', () => {
    expect(engine).toContain('provider_auto_online_events');
    expect(engine).toContain('event_type');
    expect(engine).toContain('actor_type');
  });

  it('uses CREATE TABLE IF NOT EXISTS (safe bootstrap)', () => {
    const count = (engine.match(/CREATE TABLE IF NOT EXISTS/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(3);
  });
});

// ── Eligibility criteria ──────────────────────────────────────────────────────

describe('Command 14 — eligibility criteria', () => {
  let engine;
  beforeAll(() => { engine = fs.readFileSync(SVC('providerAutoOnlineEngine.ts'), 'utf8'); });

  it('checks user_credentials for details (name, phone, email, role, archive)', () => {
    expect(engine).toContain('user_credentials');
    expect(engine).toContain('first_name');
    expect(engine).toContain('phone_number');
    expect(engine).toContain('is_archive');
  });

  it('checks worker_requirements for documents', () => {
    expect(engine).toContain('worker_requirements');
    expect(engine).toContain('requirement_type');
  });

  it('document check: typed classification handles valid_id group', () => {
    expect(engine).toContain('VALID_ID_TYPES');
    expect(engine).toContain('CLEARANCE_TYPES');
    expect(engine).toContain('WORK_RECORD_TYPES');
  });

  it('document check: legacy fallback for untyped uploads (count >= 3)', () => {
    expect(engine).toContain('legacy_inferred');
    expect(engine).toContain('allUntyped');
  });

  it('checks employee_services for service association', () => {
    expect(engine).toContain('employee_services');
    expect(engine).toContain('employee_uid');
  });

  it('checks worker_service_applications for pending applications', () => {
    expect(engine).toContain('worker_service_applications');
    expect(engine).toContain('pending_review');
    expect(engine).toContain('action_required');
  });

  it('evaluateProvider returns ProviderAutoOnlineReadiness shape', () => {
    expect(engine).toContain('evaluateProvider');
    expect(engine).toContain('ProviderAutoOnlineReadiness');
    expect(engine).toContain('autoOnline:');
    expect(engine).toContain('eligible:');
    expect(engine).toContain('blockers:');
  });
});

// ── Activation ────────────────────────────────────────────────────────────────

describe('Command 14 — activation + revocation', () => {
  let engine;
  beforeAll(() => { engine = fs.readFileSync(SVC('providerAutoOnlineEngine.ts'), 'utf8'); });

  it('applyAutoOnline delegates is_online/auto_online writes to canonical setOnline()', () => {
    expect(engine).toContain('syncOnlineStatus');
    expect(engine).toContain('setOnline');
  });

  it('applyAutoOnline uses $setOnInsert to stamp location_confidence for first-time docs', () => {
    expect(engine).toContain('$setOnInsert');
    expect(engine).toContain('location_confidence');
    expect(engine).toContain('auto_online_default');
  });

  it('applyAutoOnline generates all-time availability (7 days 00:00-23:59)', () => {
    expect(engine).toContain('syncAllTimeAvailability');
    expect(engine).toContain("startTime: '00:00'");
    expect(engine).toContain("endTime: '23:59'");
  });

  it('applyAutoOnline covers all 21+ cities', () => {
    expect(engine).toContain('ALL_CITY_IDS');
    const cityCount = (engine.match(/ALL_CITY_IDS\s*=/)[0]) ? true : false;
    expect(cityCount).toBe(true);
    expect(engine).toContain("'manila'");
    expect(engine).toContain("'makati'");
    expect(engine).toContain("'taguig'");
  });

  it('applyAutoOnline populates provisional bookable services', () => {
    expect(engine).toContain('syncProvisionalBookableServices');
    expect(engine).toContain('provider_provisional_bookable_services');
  });

  it('revokeAutoOnline sets is_auto_online = FALSE', () => {
    expect(engine).toContain('revokeAutoOnline');
    expect(engine).toContain('is_auto_online = FALSE');
    expect(engine).toContain('is_bookable = FALSE');
  });
});

// ── Admin override ────────────────────────────────────────────────────────────

describe('Command 14 — admin disable / enable override', () => {
  let engine;
  beforeAll(() => { engine = fs.readFileSync(SVC('providerAutoOnlineEngine.ts'), 'utf8'); });

  it('disableAutoOnline sets activation_mode = manual_admin_disabled', () => {
    expect(engine).toContain('disableAutoOnline');
    expect(engine).toContain("'manual_admin_disabled'");
  });

  it('evaluateProvider respects manual_admin_disabled (does not re-activate)', () => {
    expect(engine).toContain("activation_mode === 'manual_admin_disabled'");
    expect(engine).toContain('isAdminDisabled');
  });

  it('enableAutoOnlineOverride sets activation_mode = manual_admin_override', () => {
    expect(engine).toContain('enableAutoOnlineOverride');
    expect(engine).toContain("'manual_admin_override'");
  });
});

// ── Audit ─────────────────────────────────────────────────────────────────────

describe('Command 14 — audit events', () => {
  let engine;
  beforeAll(() => { engine = fs.readFileSync(SVC('providerAutoOnlineEngine.ts'), 'utf8'); });

  it('writeAuditEvent is non-blocking (wraps in try/catch)', () => {
    expect(engine).toContain('writeAuditEvent');
    expect(engine).toContain('best-effort audit');
  });

  it('audit events include event_type, actor_type, before, after', () => {
    expect(engine).toContain('event_type');
    expect(engine).toContain('actor_type');
    expect(engine).toContain('before');
    expect(engine).toContain('after');
  });
});

// ── Backfill ──────────────────────────────────────────────────────────────────

describe('Command 14 — evaluateAllProviders (backfill)', () => {
  let engine;
  beforeAll(() => { engine = fs.readFileSync(SVC('providerAutoOnlineEngine.ts'), 'utf8'); });

  it('evaluateAllProviders exists with applyChanges parameter', () => {
    expect(engine).toContain('evaluateAllProviders');
    expect(engine).toContain('applyChanges');
  });

  it('backfill returns scanned/eligible/newlyActivated counts', () => {
    expect(engine).toContain('scanned');
    expect(engine).toContain('eligible');
    expect(engine).toContain('newlyActivated');
  });

  it('getAutoBookableProviderUids supports optional serviceId filter', () => {
    expect(engine).toContain('getAutoBookableProviderUids');
    expect(engine).toContain('serviceId');
  });
});

// ── Trigger hooks ─────────────────────────────────────────────────────────────

describe('Command 14 — trigger hooks (fire-and-forget pattern)', () => {
  let authCtrl, provCtrl, adminCtrl;
  beforeAll(() => {
    authCtrl  = fs.readFileSync(CTRL('auth.controller.ts'), 'utf8');
    provCtrl  = fs.readFileSync(CTRL('providerController.ts'), 'utf8');
    adminCtrl = fs.readFileSync(CTRL('adminProviderController.ts'), 'utf8');
  });

  it('auth.controller.ts imports autoOnlineEngine', () => {
    expect(authCtrl).toContain('from "../services/providerAutoOnlineEngine"');
  });

  it('providerRegisterController triggers evaluateProvider on new registration', () => {
    expect(authCtrl).toContain('autoOnlineEngine.evaluateProvider');
  });

  it('providerController.ts imports autoOnlineEngine', () => {
    expect(provCtrl).toContain('from "../services/providerAutoOnlineEngine"');
  });

  it('canonical uploadDocument triggers evaluateProvider', () => {
    const complianceCtrl = fs.readFileSync(
      path.join(__dirname, '../src/controllers/providerProfileComplianceController.ts'),
      'utf8',
    );
    const fn = complianceCtrl.slice(complianceCtrl.indexOf('uploadDocument'), complianceCtrl.indexOf('getDocumentPreview'));
    expect(fn).toContain('autoOnlineEngine.evaluateProvider');
  });

  it('canonical deleteDocument triggers evaluateProvider', () => {
    const complianceCtrl = fs.readFileSync(
      path.join(__dirname, '../src/controllers/providerProfileComplianceController.ts'),
      'utf8',
    );
    const fn = complianceCtrl.slice(complianceCtrl.indexOf('deleteDocument'), complianceCtrl.indexOf('getCertifications'));
    expect(fn).toContain('autoOnlineEngine.evaluateProvider');
  });

  it('submitOnboarding triggers evaluateProvider', () => {
    const fn = provCtrl.slice(provCtrl.indexOf('submitOnboarding'), provCtrl.indexOf('saveOnboardingStep'));
    expect(fn).toContain('autoOnlineEngine.evaluateProvider');
  });

  it('cancelServiceApplication triggers evaluateProvider', () => {
    const fn = provCtrl.slice(provCtrl.indexOf('cancelServiceApplication'));
    expect(fn).toContain('autoOnlineEngine.evaluateProvider');
  });

  it('adminProviderController.ts imports autoOnlineEngine', () => {
    expect(adminCtrl).toContain("from '../services/providerAutoOnlineEngine'");
  });

  it('approveServiceApplication triggers evaluateProvider for provider', () => {
    const fn = adminCtrl.slice(adminCtrl.indexOf('approveServiceApplication'), adminCtrl.indexOf('rejectServiceApplication'));
    expect(fn).toContain('autoOnlineEngine.evaluateProvider');
  });

  it('rejectServiceApplication triggers evaluateProvider for provider', () => {
    const fn = adminCtrl.slice(adminCtrl.indexOf('rejectServiceApplication'), adminCtrl.indexOf('getProviderCatalogCapabilities'));
    expect(fn).toContain('autoOnlineEngine.evaluateProvider');
  });

  it('updateProviderAccountStatus triggers evaluateProvider', () => {
    const fn = adminCtrl.slice(adminCtrl.indexOf('updateProviderAccountStatus'), adminCtrl.indexOf('setProviderArchive'));
    expect(fn).toContain('autoOnlineEngine.evaluateProvider');
  });

  it('setProviderArchive triggers evaluateProvider', () => {
    const fn = adminCtrl.slice(adminCtrl.indexOf('setProviderArchive'), adminCtrl.indexOf('saveProviderAvailabilityAdmin'));
    expect(fn).toContain('autoOnlineEngine.evaluateProvider');
  });

  it('all triggers are fire-and-forget (.catch(() => {}))', () => {
    const triggers = [...authCtrl.matchAll(/autoOnlineEngine\.evaluateProvider[^;]+;/g)];
    const provTriggers = [...provCtrl.matchAll(/autoOnlineEngine\.evaluateProvider[^;]+;/g)];
    const adminTriggers = [...adminCtrl.matchAll(/autoOnlineEngine\.evaluateProvider[^;]+;/g)];
    const allTriggers = [...triggers, ...provTriggers, ...adminTriggers];
    // All should use .catch(() => {}) pattern — await-less
    allTriggers.forEach(t => {
      expect(t[0]).toContain('.catch(');
    });
  });
});

// ── Assignment merge ──────────────────────────────────────────────────────────

describe('Command 14 — assignNearestWorker includes auto-bookable providers', () => {
  let svc;
  beforeAll(() => { svc = fs.readFileSync(SVC('technicianService.ts'), 'utf8'); });

  it('imports getAutoBookableProviderUids', () => {
    expect(svc).toContain('getAutoBookableProviderUids');
    expect(svc).toContain('from "./providerAutoOnlineEngine"');
  });

  it('mergeAutoBookableProviders helper is defined', () => {
    expect(svc).toContain('mergeAutoBookableProviders');
  });

  it('assignNearestWorker uses merged online workers', () => {
    const fn = svc.slice(svc.indexOf('assignNearestWorker'));
    expect(fn).toContain('mergeAutoBookableProviders');
  });

  it('mergeAutoBookableProviders is safe (has try/catch)', () => {
    const fn = svc.slice(svc.indexOf('mergeAutoBookableProviders'), svc.indexOf('export const assignNearestWorker'));
    expect(fn).toContain('try {');
    expect(fn).toContain('return existing');
  });

  it('the auto-online engine still does not reach into the worker routes', () => {
    // This asserted that /workers/:uid/availability and /workers/:uid were
    // present, as a no-touch guarantee for mobile clients that depended on
    // them. Both apps have since been migrated to the authenticated
    // /api/worker/* family, and the unauthenticated block was deleted in
    // Command 4 — so requiring those routes to exist now pins the platform to
    // the exposure it just removed.
    //
    // The part of the guarantee that still means something is the second
    // clause: this engine must not wire itself into the worker routes. That is
    // kept, and the surviving routes are asserted to be authenticated rather
    // than merely present, which is the stronger property.
    const routes = fs.readFileSync(ROUTE('technician.routes.ts'), 'utf8');
    expect(routes).not.toContain('autoOnlineEngine');

    const bare = bareRoutes(routes);
    expect(bare).toEqual([]);
  });
});

// ── Admin controller ──────────────────────────────────────────────────────────

describe('Command 14 — adminAutoOnlineController.ts', () => {
  let ctrl;
  beforeAll(() => { ctrl = fs.readFileSync(CTRL('adminAutoOnlineController.ts'), 'utf8'); });

  it('exports getReadiness', () => { expect(ctrl).toContain('getReadiness'); });
  it('exports reEvaluate',   () => { expect(ctrl).toContain('reEvaluate'); });
  it('exports disableAutoOnline', () => { expect(ctrl).toContain('disableAutoOnline'); });
  it('exports enableOverride',    () => { expect(ctrl).toContain('enableOverride'); });
  it('exports getSummary',   () => { expect(ctrl).toContain('getSummary'); });
  it('exports getBlockers',  () => { expect(ctrl).toContain('getBlockers'); });
  it('exports backfillPreview', () => { expect(ctrl).toContain('backfillPreview'); });
  it('exports backfillApply',   () => { expect(ctrl).toContain('backfillApply'); });
});

// ── Admin routes ──────────────────────────────────────────────────────────────

describe('Command 14 — adminAutoOnline.routes.ts', () => {
  let routes;
  beforeAll(() => { routes = fs.readFileSync(ROUTE('adminAutoOnline.routes.ts'), 'utf8'); });

  it('has readiness route', () => { expect(routes).toContain('/auto-online/readiness'); });
  it('has re-evaluate route', () => { expect(routes).toContain('/auto-online/re-evaluate'); });
  it('has disable route',    () => { expect(routes).toContain('/auto-online/disable'); });
  it('has enable-override route', () => { expect(routes).toContain('/auto-online/enable-override'); });
  it('has summary route',    () => { expect(routes).toContain('/auto-online/summary'); });
  it('has blockers route',   () => { expect(routes).toContain('/auto-online/blockers'); });
  it('has backfill-preview route', () => { expect(routes).toContain('/auto-online/backfill-preview'); });
  it('has backfill-apply route', () => { expect(routes).toContain('/auto-online/backfill-apply'); });
  it('all routes are admin-only (verifyAuth + verifyRoles)', () => {
    expect(routes).toContain('verifyAuth');
    expect(routes).toContain('verifyRoles');
  });
});

// ── app.ts wiring ─────────────────────────────────────────────────────────────

describe('Command 14 — app.ts wiring', () => {
  let app;
  beforeAll(() => {
      app = fs.readFileSync(SRC('app.ts'), 'utf8');
      // TAB 03: bootstraps live in the startup graph now.
      startup = fs.readFileSync(SRC('startup.ts'), 'utf8');
    });

  it('imports adminAutoOnlineRoutes', () => {
    expect(app).toContain('adminAutoOnlineRoutes');
  });

  it('mounts adminAutoOnlineRoutes', () => {
    expect(app).toContain("app.use(\"/api\"");
    expect(app).toContain('adminAutoOnlineRoutes');
  });

  it('bootstraps auto-online schema on startup', () => {
    // TAB 03: declared in the startup graph.
    expect(startup).toContain('bootstrapAutoOnline');
  });
});

// ── Mobile contract protection ────────────────────────────────────────────────

describe('Command 14 — mobile contract protection', () => {
  it('engine does not modify technician.routes.ts', () => {
    const engine = fs.readFileSync(SVC('providerAutoOnlineEngine.ts'), 'utf8');
    expect(engine).not.toContain('technician.routes');
    expect(engine).not.toContain('/workers/:uid');
  });

  it('no changes to /workers/bookings/:bookingId/accept|start|complete routes', () => {
    const routes = fs.readFileSync(ROUTE('technician.routes.ts'), 'utf8');
    expect(routes).toContain('/bookings/:bookingId/accept');
    expect(routes).toContain('/bookings/:bookingId/complete');
  });

  it('provider.routes.ts protected /worker/* contracts unchanged', () => {
    const routes = fs.readFileSync(ROUTE('provider.routes.ts'), 'utf8');
    expect(routes).toContain('/worker/availability');
    expect(routes).toContain('/worker/time-off');
    expect(routes).toContain('/worker/service-area');
    expect(routes).toContain('/worker/requirements');
    expect(routes).toContain('/worker/onboarding');
    expect(routes).toContain('/worker/service-applications');
  });
});
