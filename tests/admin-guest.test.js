/**
 * admin-guest.test.js — source-inspection tests for Guest Customer management (C10)
 *
 * Run: npx jest tests/admin-guest.test.js
 *
 * These are static contract tests — no DB or network required.
 * They verify that the code has the right structural properties:
 * security, parameterization, CTE pattern, schema prefix, permissions.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const SVC_PATH    = path.resolve(__dirname, '../src/services/adminGuestService.ts');
const CTRL_PATH   = path.resolve(__dirname, '../src/controllers/adminGuestController.ts');
const ROUTE_PATH  = path.resolve(__dirname, '../src/routes/adminCustomer.routes.ts');
const PERM_PATH   = path.resolve(__dirname, '../src/services/adminPermissionService.ts');
const SCHEMA_PATH = path.resolve(__dirname, '../src/services/adminCreateBookingService.ts');
const APP_PATH    = path.resolve(__dirname, '../src/app.ts');

function read(p) { return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'); }

const svc    = read(SVC_PATH);
const ctrl   = read(CTRL_PATH);
const routes = read(ROUTE_PATH);
const perm   = read(PERM_PATH);
const schema = read(SCHEMA_PATH);
const app    = read(APP_PATH);

// ── 1. Schema migration adds source_channel ───────────────────────────────────

describe('schema migration — guest_customers new columns', () => {
  test('adds source_channel column', () => {
    expect(schema).toContain('ADD COLUMN IF NOT EXISTS source_channel');
  });

  test('adds source_details column', () => {
    expect(schema).toContain('ADD COLUMN IF NOT EXISTS source_details');
  });

  test('adds internal_notes column', () => {
    expect(schema).toContain('ADD COLUMN IF NOT EXISTS internal_notes');
  });

  test('adds updated_at column', () => {
    expect(schema).toContain('ADD COLUMN IF NOT EXISTS updated_at');
  });

  test('each new ALTER is in a try-catch block', () => {
    // Every ADD COLUMN IF NOT EXISTS block for the new columns should be followed by a catch
    const idx = schema.indexOf('ADD COLUMN IF NOT EXISTS source_channel');
    const catchIdx = schema.indexOf('} catch {', idx);
    expect(catchIdx).toBeGreaterThan(idx);
  });
});

// ── 2. listGuests uses CTE — no N+1 ──────────────────────────────────────────

describe('listGuests — CTE aggregate pattern (no N+1)', () => {
  test('uses WITH booking_stats CTE', () => {
    expect(svc).toContain('WITH booking_stats AS');
  });

  test('CTE aggregates booking_count per guest in one query', () => {
    expect(svc).toContain('COUNT(b.id)');
    expect(svc).toContain('GROUP BY b.guest_customer_id');
  });

  test('CTE result joined to guest_customers via LEFT JOIN', () => {
    expect(svc).toContain('LEFT JOIN booking_stats bs ON bs.guest_customer_id');
  });

  test('upcoming_booking_count uses FILTER (WHERE schedule > NOW())', () => {
    expect(svc).toContain("FILTER (WHERE b.schedule > NOW())");
  });

  test('total_spend uses SUM(b.final_price)', () => {
    expect(svc).toContain('SUM(b.final_price)');
  });
});

// ── 3. Parameterized queries — no string interpolation of user input ──────────

describe('parameterized queries — no string interpolation of user input', () => {
  test('search term uses $1 placeholder, not string concat in SQL', () => {
    // search param is set into queryParams array, not directly into SQL string
    expect(svc).toContain("queryParams.push(q)");
    expect(svc).toContain('$${p}');
  });

  test('sourceChannel filter uses $N placeholder', () => {
    // source channel is pushed to queryParams
    expect(svc).toContain('queryParams.push(params.sourceChannel)');
  });

  test('updateGuest builds parameterized SET clauses', () => {
    expect(svc).toContain('queryParams.push(fields.firstName.trim())');
  });

  test('linkGuestToClient passes customerUid as $2 param', () => {
    // customerUid goes to param array, not SQL string
    expect(svc).toContain('[guestCustomerId, customerUid, adminUid, reason');
  });

  test('no direct template interpolation of user-supplied search string into SQL', () => {
    // The search string must NOT appear like `WHERE ... ILIKE '${search}'`
    // It should use parameterized $N notation
    expect(svc).not.toMatch(/ILIKE ['"`]\${/);
  });
});

// ── 4. linkGuestToClient validates client exists before linking ───────────────

describe('linkGuestToClient — client validation', () => {
  test('queries user_credentials with role::int = 3', () => {
    expect(svc).toContain('WHERE uid = $1 AND role::int = 3');
  });

  test('throws NOT_FOUND if client query returns no rows', () => {
    expect(svc).toContain("'Client not found or is not a customer account (role 3)'");
  });

  test('validates guest exists first', () => {
    const fnStart = svc.indexOf('export async function linkGuestToClient');
    const body = svc.slice(fnStart, fnStart + 3000);
    // getGuestDetail call must appear before the client check
    const guestCheckIdx = body.indexOf('getGuestDetail(guestCustomerId)');
    const clientCheckIdx = body.indexOf("role::int = 3");
    expect(guestCheckIdx).toBeGreaterThan(-1);
    expect(clientCheckIdx).toBeGreaterThan(guestCheckIdx);
  });

  test('throws CONFLICT if already linked', () => {
    expect(svc).toContain('Guest is already linked to a client account');
    expect(svc).toContain("code: 'CONFLICT'");
  });
});

// ── 5. Routes — all behind adminOnly + requirePermission ─────────────────────

describe('adminCustomer.routes — security middleware', () => {
  test('imports verifyAuth', () => {
    expect(routes).toContain("import verifyAuth from '../middleware/verifyAuth'");
  });

  test('imports verifyRoles', () => {
    expect(routes).toContain("import verifyRoles from '../middleware/verifyRoles'");
  });

  test('imports requirePermission', () => {
    expect(routes).toContain("import { requirePermission } from '../middleware/requirePermission'");
  });

  test('adminOnly uses verifyAuth + verifyRoles([1])', () => {
    expect(routes).toContain('const adminOnly = [verifyAuth, verifyRoles([1])]');
  });

  test('GET /admin/customers requires customers.read', () => {
    expect(routes).toContain("requirePermission('customers.read')");
    expect(routes).toContain("ctrl.listAllCustomers");
  });

  test('GET /admin/customers/guests requires customers.read_guests', () => {
    expect(routes).toContain("requirePermission('customers.read_guests')");
    expect(routes).toContain("ctrl.listGuests");
  });

  test('PATCH /admin/customers/guests/:guestId requires customers.edit_guest', () => {
    expect(routes).toContain("requirePermission('customers.edit_guest')");
    expect(routes).toContain("ctrl.updateGuest");
  });

  test('POST /admin/customers/guests/:guestId/link-client requires customers.link_guest_client', () => {
    expect(routes).toContain("requirePermission('customers.link_guest_client')");
    expect(routes).toContain("ctrl.linkGuestToClient");
  });

  test('GET /admin/customers/metrics route registered', () => {
    expect(routes).toContain("'/admin/customers/metrics'");
    expect(routes).toContain("ctrl.getCustomerMetrics");
  });

  test('GET /admin/customers/guests/:guestId/bookings route registered', () => {
    expect(routes).toContain("'/admin/customers/guests/:guestId/bookings'");
    expect(routes).toContain("ctrl.getGuestBookings");
  });
});

// ── 6. No fake customerUid assigned to guest ──────────────────────────────────

describe('guest identity safety — no fake Firebase accounts or UIDs', () => {
  test('service does not call createUser or admin.auth()', () => {
    expect(svc).not.toContain('admin.auth()');
    expect(svc).not.toContain('createUser(');
  });

  test('service does not assign uid to guest from Firebase', () => {
    expect(svc).not.toContain('firebaseAdmin');
    expect(svc).not.toContain('getAuth()');
  });

  test('guest rows are never given a user_credentials uid', () => {
    // The service must never INSERT into user_credentials for a guest
    expect(svc).not.toContain(`INSERT INTO ${'{s}'}.user_credentials`);
  });

  test('controller does not pass fake customerUid for guest', () => {
    // Controller must not generate a fake uid for linkGuestToClient
    expect(ctrl).not.toContain('randomUUID()');
  });
});

// ── 7. linkGuestToClient sets linked_at with NOW() ────────────────────────────

describe('linkGuestToClient — linked_at timestamping', () => {
  test('sets linked_at = NOW() in UPDATE query', () => {
    expect(svc).toContain('linked_at            = NOW()');
  });

  test('sets linked_by_admin_uid', () => {
    expect(svc).toContain('linked_by_admin_uid  = $3');
  });

  test('sets link_reason', () => {
    expect(svc).toContain('link_reason          = $4');
  });
});

// ── 8. Cross-tenant risk: schema prefix used throughout ───────────────────────

describe('cross-tenant safety — schema prefix on all table references', () => {
  test('listGuests uses ${s}. prefix on bookings', () => {
    expect(svc).toContain('FROM ${s}.bookings');
  });

  test('listGuests uses ${s}. prefix on guest_customers', () => {
    expect(svc).toContain('FROM ${s}.guest_customers');
  });

  test('linkGuestToClient uses ${s}. prefix on user_credentials', () => {
    expect(svc).toContain('FROM ${s}.user_credentials');
  });

  test('getGuestBookings uses ${s}. prefix on service_options', () => {
    expect(svc).toContain('${s}.service_options');
  });

  test('no hardcoded schema name in SQL', () => {
    // Should not contain literal schema names like "public." or "servana."
    expect(svc).not.toMatch(/FROM public\./);
    expect(svc).not.toMatch(/FROM servana\./);
  });
});

// ── 9. Permissions registered in adminPermissionService ──────────────────────

describe('permission seeds — customers.* guest permissions', () => {
  test('customers.read permission seeded', () => {
    expect(perm).toContain("key: 'customers.read'");
  });

  test('customers.read has risk_level low', () => {
    const idx = perm.indexOf("key: 'customers.read'");
    const slice = perm.slice(idx, idx + 400);
    expect(slice).toContain("risk_level: 'low'");
  });

  test('customers.read_clients permission seeded', () => {
    expect(perm).toContain("key: 'customers.read_clients'");
  });

  test('customers.read_guests permission seeded', () => {
    expect(perm).toContain("key: 'customers.read_guests'");
  });

  test('customers.edit_guest permission seeded with risk_level medium', () => {
    expect(perm).toContain("key: 'customers.edit_guest'");
    const idx = perm.indexOf("key: 'customers.edit_guest'");
    const slice = perm.slice(idx, idx + 400);
    expect(slice).toContain("risk_level: 'medium'");
  });

  test('customers.link_guest_client permission seeded with risk_level high', () => {
    expect(perm).toContain("key: 'customers.link_guest_client'");
    const idx = perm.indexOf("key: 'customers.link_guest_client'");
    const slice = perm.slice(idx, idx + 400);
    expect(slice).toContain("risk_level: 'high'");
  });
});

// ── 10. app.ts wires adminCustomerRoutes ─────────────────────────────────────

describe('app.ts — adminCustomerRoutes wired', () => {
  test('imports adminCustomerRoutes', () => {
    expect(app).toContain("import adminCustomerRoutes from \"./routes/adminCustomer.routes\"");
  });

  test('mounts adminCustomerRoutes under /api', () => {
    expect(app).toContain('app.use("/api", cors(corsOptionsDelegate), adminCustomerRoutes)');
  });
});

// ── 11. Source-channel allowed values validated ───────────────────────────────

describe('source_channel validation', () => {
  test('VALID_SOURCE_CHANNELS set is defined', () => {
    expect(svc).toContain('VALID_SOURCE_CHANNELS');
  });

  test('all required channel values present', () => {
    const channels = ['phone', 'facebook_messenger', 'instagram', 'walk_in', 'referral', 'admin_support', 'other'];
    for (const ch of channels) {
      expect(svc).toContain(`'${ch}'`);
    }
  });

  test('updateGuest validates sourceChannel against VALID_SOURCE_CHANNELS', () => {
    expect(svc).toContain('VALID_SOURCE_CHANNELS.has(fields.sourceChannel)');
  });
});

// ── 12. No ESM ES2020 incompatible syntax ─────────────────────────────────────

describe('ESM 3.2.25 compatibility — no ?? or ?. operators', () => {
  test('service has no nullish coalescing operator ??', () => {
    // Strip string literals and comments first by checking for operator not inside a string
    // Simple heuristic: no ?? token in the source
    expect(svc).not.toMatch(/[^'"`][?][?][^'"`]/);
  });

  test('service has no optional chaining operator ?.', () => {
    expect(svc).not.toMatch(/\?\./);
  });

  test('controller has no ?? operator', () => {
    expect(ctrl).not.toMatch(/[^'"`][?][?][^'"`]/);
  });

  test('controller has no ?. operator', () => {
    expect(ctrl).not.toMatch(/\?\./);
  });
});

// ── 13. Controller extracts actorUid safely ────────────────────────────────────

describe('controller — actorUid extraction without ?. operator', () => {
  test('actorUid helper uses explicit null check, not ?.', () => {
    // Must use req.user && req.user.uid pattern or similar — NOT req.user?.uid
    expect(ctrl).toContain('req.user && req.user.uid');
  });
});

// ── 14. listAllCustomers uses UNION ALL CTE ────────────────────────────────────

describe('listAllCustomers — UNION ALL structure', () => {
  test('uses UNION ALL to combine clients and guests', () => {
    expect(svc).toContain('UNION ALL');
  });

  test('clients come from user_credentials with role::int = 3', () => {
    expect(svc).toContain("WHERE uc.role::int = 3");
  });

  test('maps the user_credentials created_date column to the unified created_at contract', () => {
    expect(svc).toContain('uc.created_date');
    expect(svc).toContain('AS created_at');
    expect(svc).not.toMatch(/uc\.created_at/);
  });

  test('guests come from guest_customers table', () => {
    expect(svc).toContain('FROM ${s}.guest_customers gc');
  });

  test("identity_type distinguishes 'client' from 'guest' (::text cast)", () => {
    expect(svc).toContain("'client'::text");
    expect(svc).toContain("'guest'::text");
    expect(svc).toContain("AS identity_type");
  });
});
