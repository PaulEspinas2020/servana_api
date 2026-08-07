/**
 * REPEAT — Cross-platform parity source-inspection tests.
 *
 * Proves that Provider Web (/worker/*), Provider Mobile (/workers/:uid/*),
 * and Admin Portal (/admin/providers/:uid/*) all read from and write to the
 * same canonical PostgreSQL tables, so data created by one platform is
 * immediately visible to all others.
 *
 * These are static source tests (no running server required). They verify the
 * wiring at the code level. Live integration tests (create via mobile, read via
 * admin) are tracked in the TODO block at the bottom.
 */

const fs   = require('fs');
const { bareRoutes } = require('./helpers/routeAuth');
const path = require('path');

const SRC   = (...parts) => path.join(__dirname, '..', 'src', ...parts);
const SVC   = (...parts) => SRC('services', ...parts);
const CTRL  = (...parts) => SRC('controllers', ...parts);
const ROUTE = (...parts) => SRC('routes', ...parts);

// ---------------------------------------------------------------------------
// CAPABILITY: WORKER.AVAILABILITY
// ---------------------------------------------------------------------------

describe('REPEAT — WORKER.AVAILABILITY canonical storage', () => {
  it('Provider Web /worker/availability delegates to providerAvailabilityEngine', () => {
    const ctrl = fs.readFileSync(CTRL('providerController.ts'), 'utf8');
    expect(ctrl).toContain("availEngine.getAvailabilityProfile(uid)");
    expect(ctrl).toContain("availEngine.saveWeeklySchedule(uid");
  });

  it('Admin /admin/providers/:uid/availability delegates to providerAvailabilityEngine', () => {
    const ctrl = fs.readFileSync(CTRL('adminProviderController.ts'), 'utf8');
    expect(ctrl).toContain("availEngine");
  });

  it('Both engines point to the same PostgreSQL worker_availability table', () => {
    const engine = fs.readFileSync(SVC('providerAvailabilityEngine.ts'), 'utf8');
    expect(engine).toContain('worker_availability');
    // Must not touch MongoDB
    expect(engine).not.toContain('mongoDb');
    expect(engine).not.toContain('mongodb');
  });

  it('providerController no longer uses MongoDB worker_availability', () => {
    const ctrl = fs.readFileSync(CTRL('providerController.ts'), 'utf8');
    // Old MongoDB availability section must be gone
    expect(ctrl).not.toMatch(/collection\(["']worker_availability["']\)/);
  });

  it('bridgeToEngineSlots is defined in providerController (web→canonical converter)', () => {
    const ctrl = fs.readFileSync(CTRL('providerController.ts'), 'utf8');
    expect(ctrl).toContain('function bridgeToEngineSlots');
    expect(ctrl).toContain('DAY_TO_DOW');
  });

  it('bridgeToWebSchedule is defined in providerController (canonical→web converter)', () => {
    const ctrl = fs.readFileSync(CTRL('providerController.ts'), 'utf8');
    expect(ctrl).toContain('function bridgeToWebSchedule');
    expect(ctrl).toContain('DOW_TO_DAY');
  });
});

// ---------------------------------------------------------------------------
// CAPABILITY: WORKER.TIME_OFF
// ---------------------------------------------------------------------------

describe('REPEAT — WORKER.TIME_OFF canonical storage', () => {
  it('Provider Web /worker/time-off GET delegates to availEngine.listTimeOff', () => {
    const ctrl = fs.readFileSync(CTRL('providerController.ts'), 'utf8');
    expect(ctrl).toContain("availEngine.listTimeOff(uid)");
  });

  it('Provider Web /worker/time-off POST delegates to availEngine.createTimeOff', () => {
    const ctrl = fs.readFileSync(CTRL('providerController.ts'), 'utf8');
    // Whitespace-tolerant: the intent is "this route delegates to the engine",
    // not "the call fits on one line". C22 §17 made this a multi-line call to
    // pass the partial-day fields, and the literal-substring form failed on a
    // reformat that changed no behaviour.
    expect(ctrl).toMatch(/availEngine\.createTimeOff\(\s*uid/);
  });

  it('Provider Web /worker/time-off DELETE delegates to availEngine.cancelTimeOff', () => {
    const ctrl = fs.readFileSync(CTRL('providerController.ts'), 'utf8');
    expect(ctrl).toContain("availEngine.cancelTimeOff(uid");
  });

  it('providerController no longer uses MongoDB worker_time_off', () => {
    const ctrl = fs.readFileSync(CTRL('providerController.ts'), 'utf8');
    expect(ctrl).not.toMatch(/collection\(["']worker_time_off["']\)/);
  });

  it('bridgeToWebTimeOff filters out cancelled entries (GET only returns active)', () => {
    const ctrl = fs.readFileSync(CTRL('providerController.ts'), 'utf8');
    expect(ctrl).toContain("t.status === 'active'");
  });

  it('time-off IDs are returned as strings for Provider Web compatibility', () => {
    const ctrl = fs.readFileSync(CTRL('providerController.ts'), 'utf8');
    expect(ctrl).toContain("id:        String(record.id)");
  });

  it('DELETE handler parses time-off id as integer (PostgreSQL SERIAL)', () => {
    const ctrl = fs.readFileSync(CTRL('providerController.ts'), 'utf8');
    expect(ctrl).toContain("Number(id)");
    expect(ctrl).toContain("Number.isInteger(numericId)");
  });
});

// ---------------------------------------------------------------------------
// CAPABILITY: WORKER.SERVICE_AREA
// ---------------------------------------------------------------------------

describe('REPEAT — WORKER.SERVICE_AREA canonical storage', () => {
  it('Provider Web /worker/service-area delegates to providerServiceAreaEngine', () => {
    const ctrl = fs.readFileSync(CTRL('providerController.ts'), 'utf8');
    expect(ctrl).toContain("areaEngine.getServiceAreaProfile(uid)");
    expect(ctrl).toContain("areaEngine.saveServiceArea(uid");
  });

  it('Admin /admin/providers/:uid/service-area delegates to providerServiceAreaEngine', () => {
    const adminCtrl = fs.existsSync(CTRL('adminProviderController.ts'))
      ? fs.readFileSync(CTRL('adminProviderController.ts'), 'utf8')
      : '';
    const adminSvc = fs.existsSync(SVC('adminProviderService.ts'))
      ? fs.readFileSync(SVC('adminProviderService.ts'), 'utf8')
      : '';
    const combined = adminCtrl + adminSvc;
    expect(combined).toContain('areaEngine');
  });

  it('providerServiceAreaEngine uses PostgreSQL worker_service_areas table', () => {
    const engine = fs.readFileSync(SVC('providerServiceAreaEngine.ts'), 'utf8');
    expect(engine).toContain('worker_service_areas');
    expect(engine).not.toContain('mongoDb');
  });

  it('providerController no longer uses MongoDB worker_service_areas', () => {
    const ctrl = fs.readFileSync(CTRL('providerController.ts'), 'utf8');
    expect(ctrl).not.toMatch(/collection\(["']worker_service_areas["']\)/);
  });

  it('saveWorkerServiceArea bridges cityIds payload to coverageMode:city for engine', () => {
    const ctrl = fs.readFileSync(CTRL('providerController.ts'), 'utf8');
    expect(ctrl).toContain("coverageMode: 'city', cityIds");
  });
});

// ---------------------------------------------------------------------------
// CAPABILITY: ENGINE MOBILE CONTRACT PROTECTION
// ---------------------------------------------------------------------------

describe('REPEAT — Mobile contract protection (no-touch guarantees)', () => {
  it('nothing unauthenticated survives in technician.routes.ts', () => {
    // This asserted that /workers/:uid/availability was still present, as a
    // no-touch guarantee for mobile. That route had no authentication and took
    // its subject from the URL, so anyone could rewrite any provider's
    // availability by knowing a uid. Both apps now use the authenticated
    // /api/worker/availability, and the bare block was deleted in Command 4.
    //
    // The guarantee is inverted rather than dropped: instead of pinning a
    // specific unauthenticated route into existence, this asserts the property
    // that mattered all along — no route in this file is reachable without a
    // credential.
    const routes = fs.readFileSync(ROUTE('technician.routes.ts'), 'utf8');
    const bare = bareRoutes(routes);
    expect(bare).toEqual([]);
    expect(routes).not.toContain('/workers/:uid/availability');
  });

  it('provider.routes.ts /worker/availability routes still point to providerController', () => {
    const routes = fs.readFileSync(ROUTE('provider.routes.ts'), 'utf8');
    expect(routes).toContain('/worker/availability');
    expect(routes).toContain('provider.getWorkerAvailability');
    expect(routes).toContain('provider.saveWorkerAvailability');
  });

  it('provider.routes.ts /worker/time-off routes still in place', () => {
    const routes = fs.readFileSync(ROUTE('provider.routes.ts'), 'utf8');
    expect(routes).toContain('/worker/time-off');
    expect(routes).toContain('provider.getWorkerTimeOff');
    expect(routes).toContain('provider.createWorkerTimeOff');
    expect(routes).toContain('provider.deleteWorkerTimeOff');
  });

  it('provider.routes.ts /worker/service-area routes still in place', () => {
    const routes = fs.readFileSync(ROUTE('provider.routes.ts'), 'utf8');
    expect(routes).toContain('/worker/service-area');
    expect(routes).toContain('provider.getWorkerServiceArea');
    expect(routes).toContain('provider.saveWorkerServiceArea');
  });

  it('engine uses ADD COLUMN IF NOT EXISTS — zero-impact on mobile columns', () => {
    const engine = fs.readFileSync(SVC('providerAvailabilityEngine.ts'), 'utf8');
    expect(engine).toContain('ADD COLUMN IF NOT EXISTS');
  });
});

// ---------------------------------------------------------------------------
// CAPABILITY: PARITY MIDDLEWARE
// ---------------------------------------------------------------------------

describe('REPEAT — Response/request parity middleware coverage', () => {
  it('parityMiddleware.ts wraps res.json for alias enrichment', () => {
    const mw = fs.readFileSync(SRC('middleware', 'parityMiddleware.ts'), 'utf8');
    expect(mw).toContain('res.json');
    expect(mw).toContain('enrichValue');
  });

  it('requestParityMiddleware.ts normalizes req.body and req.query', () => {
    const mw = fs.readFileSync(SRC('middleware', 'requestParityMiddleware.ts'), 'utf8');
    expect(mw).toContain('req.body');
    expect(mw).toContain('applyContextSafeParity');
  });

  it('fieldParity.ts has at least 30 parity groups (canonical alias registry)', () => {
    const fp = fs.readFileSync(SRC('utils', 'fieldParity.ts'), 'utf8');
    // PARITY_REGISTRY is an array of ParityGroup objects — count array-entry openers
    const groupCount = (fp.match(/\baliases:\s*\[/g) || []).length;
    expect(groupCount).toBeGreaterThanOrEqual(30);
  });

  it('bookingService.ts formatBooking includes cross-platform aliases', () => {
    const svc = fs.readFileSync(SVC('bookingService.ts'), 'utf8');
    expect(svc).toContain('bookingId');
    expect(svc).toContain('scheduledAt');
    expect(svc).toContain('providerUid');
  });
});

// ---------------------------------------------------------------------------
// TODO: Live integration tests (require DB + Firebase tokens)
//
//  These would prove end-to-end cross-platform recognition:
//  1. Mobile creates availability via PUT /workers/:uid/availability
//     → Admin reads same record via GET /admin/providers/:uid/availability
//  2. Provider Web saves schedule via PUT /worker/availability
//     → Admin reads it via GET /admin/providers/:uid/availability
//  3. Admin creates time-off via POST /admin/providers/:uid/time-off
//     → Provider Web reads it via GET /worker/time-off
//  4. Provider Web saves service area via PUT /worker/service-area
//     → Admin reads it via GET /admin/providers/:uid/service-area
// ---------------------------------------------------------------------------
