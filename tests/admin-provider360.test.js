/**
 * admin-provider360.test.js
 * Source-inspection tests for the PROVIDER360ADMIN feature set (b75d87c).
 * Covers: requirement-definitions endpoint, profile edit endpoint, service removal endpoint.
 * Pattern: readFileSync — no DB required.
 */

const fs   = require('fs');
const path = require('path');

/**
 * The elements of `const adminOnly = [ … ]`, split on top-level commas.
 *
 * Bracket-aware on purpose: the chain contains `verifyRoles([1])`, whose `]`
 * would end a naive `[^\]]*` match early and silently truncate the answer.
 */
function adminOnlyChain(src) {
  const decl = /const\s+adminOnly\s*=\s*\[/.exec(src);
  if (!decl) return [];
  const open = decl.index + decl[0].length;
  let depth = 1;
  let i = open;
  for (; i < src.length && depth > 0; i += 1) {
    const c = src[i];
    if (c === '[' || c === '(') depth += 1;
    else if (c === ']' || c === ')') depth -= 1;
  }
  const inner = src.slice(open, i - 1);
  const parts = [];
  let buf = '';
  let d = 0;
  for (const c of inner) {
    if (c === '[' || c === '(') d += 1;
    if (c === ']' || c === ')') d -= 1;
    if (c === ',' && d === 0) { if (buf.trim()) parts.push(buf.trim()); buf = ''; continue; }
    buf += c;
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts;
}


const ROUTES  = path.resolve(__dirname, '../src/routes/adminProvider.routes.ts');
const CTRL    = path.resolve(__dirname, '../src/controllers/adminProviderController.ts');
const SVC     = path.resolve(__dirname, '../src/services/adminProviderService.ts');
const PERMS   = path.resolve(__dirname, '../src/services/adminPermissionService.ts');

function read(f) { return fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n'); }

// ── Route registration ─────────────────────────────────────────────────────────

describe('adminProvider.routes — PROVIDER360ADMIN route registration', () => {
  const src = read(ROUTES);

  test('GET /admin/providers/requirement-definitions is registered', () => {
    expect(src).toContain("get('/admin/providers/requirement-definitions'");
  });

  test('requirement-definitions uses providers.documents.view permission', () => {
    expect(src).toContain("requirePermission('providers.documents.view'), ctrl.getRequirementDefinitions");
  });

  test('PATCH /admin/providers/:uid/profile is registered', () => {
    expect(src).toContain("patch('/admin/providers/:uid/profile'");
  });

  test('profile patch uses providers.profile.edit permission', () => {
    expect(src).toContain("requirePermission('providers.profile.edit'), ctrl.updateProviderProfile");
  });

  test('DELETE /admin/providers/:uid/services/:serviceId is registered', () => {
    expect(src).toContain("delete('/admin/providers/:uid/services/:serviceId'");
  });

  test('service delete uses providers.services.remove permission', () => {
    expect(src).toContain("requirePermission('providers.services.remove'), ctrl.removeProviderService");
  });

  test('requirement-definitions route appears before /:uid catch-all routes', () => {
    const reqDefPos  = src.indexOf("get('/admin/providers/requirement-definitions'");
    const uidCatchPos = src.indexOf("get('/admin/providers/:uid'");
    expect(reqDefPos).toBeGreaterThan(-1);
    expect(uidCatchPos).toBeGreaterThan(-1);
    expect(reqDefPos).toBeLessThan(uidCatchPos);
  });

  test('all 3 new routes gate with verifyAuth + verifyRoles([1])', () => {
    // adminOnly spread is used on every route — verify it is defined
    // Asserts the CHAIN CONTAINS the guards, rather than matching the array
    // literal character for character. The literal form broke the day
    // `adminRateLimit` was added to it (TAB 05) even though every guard this
    // test cares about was still there — a text-equality assertion on a
    // middleware array fails on every legitimate addition, which trains people
    // to edit the test rather than read it.
    expect(adminOnlyChain(src)).toEqual(
      expect.arrayContaining(['verifyAuth', 'verifyRoles([1])']),
    );
  });
});

// ── Controller handlers ────────────────────────────────────────────────────────

describe('adminProviderController — PROVIDER360ADMIN handlers', () => {
  const src = read(CTRL);

  test('exports getRequirementDefinitions handler', () => {
    expect(src).toContain('export const getRequirementDefinitions');
  });

  test('exports updateProviderProfile handler', () => {
    expect(src).toContain('export const updateProviderProfile');
  });

  test('exports removeProviderService handler', () => {
    expect(src).toContain('export const removeProviderService');
  });

  test('getRequirementDefinitions calls svc.getRequirementDefinitions', () => {
    expect(src).toContain('svc.getRequirementDefinitions()');
  });

  test('updateProviderProfile writes PROVIDER.PROFILE.UPDATED_BY_ADMIN audit event', () => {
    expect(src).toContain('PROVIDER.PROFILE.UPDATED_BY_ADMIN');
  });

  test('removeProviderService writes PROVIDER.SERVICE.REMOVED audit event', () => {
    expect(src).toContain('PROVIDER.SERVICE.REMOVED');
  });

  test('removeProviderService audit uses entityType: service (not provider_service)', () => {
    expect(src).toContain("entityType: 'service'");
    expect(src).not.toContain("entityType: 'provider_service'");
  });

  test('removeProviderService triggers autoOnlineEngine.evaluateProvider', () => {
    expect(src).toContain('autoOnlineEngine.evaluateProvider');
  });

  test('updateProviderProfile validates serviceId as Number', () => {
    // serviceId parsed as Number to prevent string injection
    expect(src).toContain('Number(req.params.serviceId)');
  });
});

// ── Service functions ──────────────────────────────────────────────────────────

describe('adminProviderService — PROVIDER360ADMIN service layer', () => {
  const src = read(SVC);

  test('exports REQUIREMENT_DEFINITIONS array', () => {
    expect(src).toContain('export const REQUIREMENT_DEFINITIONS');
  });

  test('exports getRequirementDefinitions function', () => {
    expect(src).toContain('export const getRequirementDefinitions');
  });

  test('REQUIREMENT_DEFINITIONS contains government_id entry', () => {
    expect(src).toContain("requirementKey: 'government_id'");
  });

  test('REQUIREMENT_DEFINITIONS contains nbi_clearance entry', () => {
    expect(src).toContain("requirementKey: 'nbi_clearance'");
  });

  test('REQUIREMENT_DEFINITIONS contains proof_of_address entry', () => {
    expect(src).toContain("requirementKey: 'proof_of_address'");
  });

  test('exports updateProviderProfile function', () => {
    expect(src).toContain('export const updateProviderProfile');
  });

  test('exports removeProviderService function', () => {
    expect(src).toContain('export const removeProviderService');
  });

  test('updateProviderProfile validates phone with regex', () => {
    expect(src).toContain('PHONE_RE');
  });

  test('updateProviderProfile validates gender against allowlist', () => {
    expect(src).toContain('VALID_GENDERS');
  });

  test('removeProviderService checks employee_services table', () => {
    expect(src).toContain('employee_services');
  });

  test('removeProviderService checks for active bookings before deletion', () => {
    expect(src).toContain('booking_workers');
    expect(src).toContain("'CONFIRMED'");
    expect(src).toContain("'IN_PROGRESS'");
  });

  test('removeProviderService archives employee_catalog_capabilities on removal', () => {
    expect(src).toContain('employee_catalog_capabilities');
    expect(src).toContain('archived');
    expect(src).toContain('suspended_at');
  });

  test('no ESM-unsafe nullish coalescing operator used (ESM 3.2.25 constraint)', () => {
    // Scan only the new functions (after REQUIREMENT_DEFINITIONS) for ?? operator
    const reqDefsIdx = src.indexOf('export const REQUIREMENT_DEFINITIONS');
    const tail = src.slice(reqDefsIdx);
    expect(tail).not.toMatch(/\?\?/);
  });

  test('no ESM-unsafe optional chaining used in new functions', () => {
    const reqDefsIdx = src.indexOf('export const REQUIREMENT_DEFINITIONS');
    const tail = src.slice(reqDefsIdx);
    expect(tail).not.toMatch(/\?\./);
  });
});

// ── Permission seed ────────────────────────────────────────────────────────────

describe('adminPermissionService — providers.services.remove permission seed', () => {
  const src = read(PERMS);

  test('seeds providers.services.remove permission key', () => {
    expect(src).toContain("'providers.services.remove'");
  });

  test('providers.services.remove has risk_level high', () => {
    // Verify the high-risk designation is present in the seed block
    const idx = src.indexOf("'providers.services.remove'");
    const block = src.slice(idx, idx + 400);
    expect(block).toContain("'high'");
  });

  test('providers.services.remove requires providers.active_services.view', () => {
    const idx = src.indexOf("'providers.services.remove'");
    const block = src.slice(idx, idx + 400);
    expect(block).toContain("'providers.active_services.view'");
  });

  test('providers.profile.edit permission is seeded', () => {
    expect(src).toContain("'providers.profile.edit'");
  });

  test('providers.documents.view permission is seeded', () => {
    expect(src).toContain("'providers.documents.view'");
  });
});
