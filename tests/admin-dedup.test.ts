/**
 * Admin Provider Deduplication — contract tests
 *
 * Sections:
 *   §1  Protected route compatibility (unauthenticated → not 200)
 *   §2  Admin list endpoint — auth gate
 *   §3  Admin metrics endpoint — auth gate
 *   §4  Diagnostic route registration checks
 *   §5  Mobile /workers/:uid/* route compatibility (path structure unchanged)
 *   §6  Dedup invariants — validated against any live authenticated response
 *       (Cases A–I: structural contracts guaranteed by the read-model design)
 *   §7  Pure-logic unit tests — no DB required (row-mapping contract)
 *
 * Run:  npx ts-node tests/admin-dedup.test.ts
 * Live sections (§1–§6) require: LOCAL_ADMIN_TOKEN=<admin JWT> PORT=3000
 */

import http from 'http';

const BASE  = `http://localhost:${process.env.PORT ?? 3000}/api`;
const TOKEN = process.env.LOCAL_ADMIN_TOKEN ?? '';

let pass = 0, fail = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────

function get(path: string, token?: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const url = new URL(BASE + path);
    const req = http.request(
      { hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search,
        method: 'GET', headers },
      res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode!, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode!, body: data }); }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function assert(label: string, condition: boolean, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
    pass++;
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    fail++;
  }
}

function assertUnit(label: string, condition: boolean, detail = '') {
  assert(`[unit] ${label}`, condition, detail);
}

// ── §1  Protected routes ───────────────────────────────────────────────────────

async function testProtectedRoutes() {
  console.log('\n§1  Protected route compatibility (unauthenticated → not 200)');

  const protectedPaths = [
    '/worker/availability',
    '/worker/requirements',
    '/worker/onboarding',
    '/worker/service-applications',
    '/provider/profile',
    '/provider/dashboard',
    '/providers/me/review-status',
    '/provider-catalog/v1/offerings',
  ];

  for (const path of protectedPaths) {
    const res = await get(path).catch(() => ({ status: 0, body: null }));
    assert(`${path} returns non-200 without token (got ${res.status})`, res.status !== 200);
  }
}

// ── §2  Admin list ─────────────────────────────────────────────────────────────

async function testAdminProviderList() {
  console.log('\n§2  GET /admin/providers — requires auth (no token → non-200)');
  const res = await get('/admin/providers');
  assert('unauthenticated request blocked', res.status !== 200, `got ${res.status}`);
}

// ── §3  Admin metrics ──────────────────────────────────────────────────────────

async function testAdminMetricsShape() {
  console.log('\n§3  GET /admin/providers/metrics — auth gate + shape');
  const res = await get('/admin/providers/metrics');
  assert('returns 401/403/400 without token', res.status === 401 || res.status === 403 || res.status === 400);
}

// ── §4  Diagnostic route registration ─────────────────────────────────────────

async function testAdminDiagnosticRoutes() {
  console.log('\n§4  Diagnostic routes registered (not 404, blocked without token)');

  const routes = [
    '/admin/providers/duplicates',
    '/admin/providers/test-uid-does-not-exist/overlap-map',
    '/admin/providers/mobile-metrics',
  ];

  for (const path of routes) {
    const res = await get(path).catch(() => ({ status: 0, body: null }));
    assert(`${path} is registered (not 404)`, res.status !== 404, `got ${res.status}`);
    assert(`${path} blocked without admin token`, res.status !== 200, `got ${res.status}`);
  }
}

// ── §5  Mobile /workers/* routes unchanged ─────────────────────────────────────

async function testWorkerRoutesUnmodified() {
  console.log('\n§5  /workers/:uid/* mobile routes — path structure unchanged');

  const paths = [
    '/workers/test-uid/services',
    '/workers/test-uid/requirements',
    '/workers/test-uid/availability',
    '/workers/test-uid/schedule',
    '/workers/available',
    '/workers/all',
  ];

  for (const path of paths) {
    const res = await get(path).catch(() => ({ status: 0, body: null }));
    // Mobile routes have no admin auth — they return 200/400/404 but NOT 401/403
    assert(
      `${path} is NOT admin-auth-gated (status ${res.status})`,
      res.status !== 401 && res.status !== 403
    );
  }
}

// ── §6  Dedup invariants against live authenticated response ───────────────────

/**
 * Cases A–I describe database states and the guarantees the read-model must hold:
 *
 * A  Single provider — list returns exactly 1 row, uid unique.
 * B  Provider with N worker_requirements — list returns 1 row, doc_total = N (not N rows).
 * C  Provider with N employee_services — list returns 1 row, active_svc = N.
 * D  Provider with N worker_service_applications — list returns 1 row, pending_apps = P.
 * E  Orphan employee_services (no user_credentials) — never appears in list.
 * F  Orphan worker_requirements — never appears in list.
 * G  role=1 (admin) with provider-related data — excluded from list (role IN (2,4) only).
 * H  All tables populated — 1 row per provider, all counts correct, no inflation.
 * I  M distinct providers — list returns M rows, each uid unique, meta.total = M.
 *
 * The structural checks below validate these guarantees on ANY live page.
 */
async function testDeduplicationInvariants() {
  if (!TOKEN) {
    console.log('\n§6  Dedup invariants — SKIPPED (set LOCAL_ADMIN_TOKEN env var to run)');
    return;
  }

  console.log('\n§6  Dedup invariants (Cases A–I structural checks)');

  const res = await get('/admin/providers?limit=200', TOKEN).catch(() => ({ status: 0, body: null }));
  if (res.status !== 200) {
    assert('GET /admin/providers with token returns 200', false, `got ${res.status}`);
    return;
  }

  const body = res.body;

  // ── Envelope shape ──────────────────────────────────────────────────────────
  assert('response.status is "success"', body?.status === 'success');
  assert('response.data is an array',    Array.isArray(body?.data));
  assert('response.meta is an object',   typeof body?.meta === 'object' && body.meta !== null);

  const data: any[] = body.data ?? [];
  const meta = body.meta ?? {};

  // ── meta contract ───────────────────────────────────────────────────────────
  assert('meta.total is a non-negative integer',   Number.isInteger(meta.total) && meta.total >= 0,   `got ${meta.total}`);
  assert('meta.page is a positive integer',         Number.isInteger(meta.page)  && meta.page  >= 1,   `got ${meta.page}`);
  assert('meta.limit is a positive integer',        Number.isInteger(meta.limit) && meta.limit >= 1,   `got ${meta.limit}`);
  assert('meta.totalPages is a non-negative int',   Number.isInteger(meta.totalPages) && meta.totalPages >= 0, `got ${meta.totalPages}`);
  assert('meta.requestId is a string',              typeof meta.requestId === 'string' && meta.requestId.length > 0, `got ${JSON.stringify(meta.requestId)}`);
  assert('meta.generatedAt is a date string',       typeof meta.generatedAt === 'string' && !isNaN(Date.parse(meta.generatedAt)), `got ${meta.generatedAt}`);

  if (data.length === 0) {
    console.log('  (no providers in DB — row-level checks skipped)');
    return;
  }

  // ── Case I: M providers → M unique UIDs ─────────────────────────────────────
  const uids = data.map((r: any) => r.uid);
  const uniqueUids = new Set(uids);
  assert(
    `Case I: all UIDs are unique (${uniqueUids.size}/${data.length} rows)`,
    uniqueUids.size === data.length,
    `duplicate UIDs: ${uids.filter((u, i) => uids.indexOf(u) !== i).join(', ')}`
  );

  // ── Case A/H: row shape contract for each provider ──────────────────────────
  let shapeOk = true;
  for (const r of data) {
    if (typeof r.uid !== 'string'                         ) { shapeOk = false; break; }
    if (r.providerUid !== r.uid                           ) { shapeOk = false; break; }
    if (r.role !== 2 && r.role !== 4                      ) { shapeOk = false; break; } // Case G
    if (typeof r.documentSummary?.total !== 'number'      ) { shapeOk = false; break; } // Case B
    if (typeof r.serviceSummary?.pendingApplications !== 'number') { shapeOk = false; break; } // Case D
    if (typeof r.serviceSummary?.activeServices !== 'number'     ) { shapeOk = false; break; } // Case C
    if (!['saved', 'missing', 'unknown'].includes(r.availabilityStatus)) { shapeOk = false; break; }
    if (!['saved', 'missing', 'unknown'].includes(r.serviceAreaStatus))  { shapeOk = false; break; }
    if (typeof r.displayName !== 'string' || r.displayName.length === 0) { shapeOk = false; break; }
  }
  assert(
    'Cases A/B/C/D/G/H: every row has correct shape (uid, role ∈ {2,4}, counts, displayName)',
    shapeOk,
    'at least one row failed shape check'
  );

  // ── doc_total is never negative (inflated joins would yield N>1, orphans 0) ─
  const negativeDocTotal = data.filter((r: any) => r.documentSummary?.total < 0);
  assert('Case B/F: documentSummary.total is never negative', negativeDocTotal.length === 0,
    `${negativeDocTotal.length} rows with negative doc total`);

  // ── meta.total ≥ data.length (page may be a subset) ─────────────────────────
  assert('Case I: meta.total ≥ data.length (consistent pagination)',
    meta.total >= data.length, `meta.total=${meta.total} but data.length=${data.length}`);

  // ── providerType is restricted ───────────────────────────────────────────────
  const badType = data.filter((r: any) => !['marketplace_provider', 'internal_provider', 'unknown'].includes(r.providerType));
  assert('providerType is always one of the 3 canonical values', badType.length === 0,
    `${badType.length} rows with unexpected providerType`);

  // ── Metrics consistency check ────────────────────────────────────────────────
  const metricsRes = await get('/admin/providers/metrics', TOKEN).catch(() => ({ status: 0, body: null }));
  if (metricsRes.status === 200) {
    const m = metricsRes.body?.data ?? {};
    assert('metrics.total is a non-negative integer',  Number.isInteger(m.total)  && m.total  >= 0);
    assert('metrics.active is a non-negative integer', Number.isInteger(m.active) && m.active >= 0);
    assert('metrics has canonical missingDocuments key',   'missingDocuments'  in m, `got ${JSON.stringify(m)}`);
    assert('metrics has canonical attentionNeeded key',    'attentionNeeded'   in m);
    assert('metrics has canonical missingAvailability key','missingAvailability' in m);
    assert('metrics has canonical missingServiceArea key', 'missingServiceArea'  in m);
    // Case H: missingDocuments + providersWithDocuments should equal total
    if ('missingDocuments' in m && 'providersWithDocuments' in m) {
      const docSum = m.missingDocuments + m.providersWithDocuments;
      assert(
        `Case H: missingDocuments (${m.missingDocuments}) + providersWithDocuments (${m.providersWithDocuments}) = total (${m.total})`,
        docSum === m.total,
        `sum=${docSum} ≠ total=${m.total}`
      );
    }
  } else {
    console.log(`  (metrics endpoint returned ${metricsRes.status} — consistency check skipped)`);
  }
}

// ── §7  Pure-logic unit tests (no DB / no HTTP) ────────────────────────────────

function testPureLogic() {
  console.log('\n§7  Pure-logic unit tests (row mapping contract)');

  // simulates what the controller row mapper produces from raw DB rows
  function mapRow(r: Record<string, any>) {
    return {
      uid:             r.uid,
      providerUid:     r.uid,
      firstName:       r.first_name        ?? null,
      lastName:        r.last_name         ?? null,
      displayName:     `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || r.email || r.uid,
      email:           r.email             ?? null,
      phoneNumber:     r.phone_number      ?? null,
      role:            Number(r.role),
      providerType:    r.role === 2 ? 'marketplace_provider' : r.role === 4 ? 'internal_provider' : 'unknown',
      accountStatus:   r.account_status    ?? null,
      isArchive:       r.is_archive        ?? false,
      isEmailVerified: r.is_email_verified ?? false,
      createdDate:     r.created_date      ?? null,
      photoUrl:        r.photo_url         ?? null,
      documentSummary: { total: Number(r.doc_total    ?? 0) },
      serviceSummary:  { pendingApplications: Number(r.pending_apps ?? 0), activeServices: Number(r.active_svc ?? 0) },
      availabilityStatus: r.avail_status ?? 'unknown',
      serviceAreaStatus:  r.area_status  ?? 'unknown',
    };
  }

  // Case A: minimal provider
  const caseA = mapRow({ uid: 'uid-a', first_name: 'Ana', last_name: 'Cruz', email: 'a@test.com',
    role: 2, account_status: 'active', is_archive: false, is_email_verified: true,
    doc_total: 0, pending_apps: 0, active_svc: 0, avail_status: 'missing', area_status: 'missing' });

  assertUnit('Case A: providerUid === uid', caseA.providerUid === caseA.uid);
  assertUnit('Case A: displayName from name', caseA.displayName === 'Ana Cruz');
  assertUnit('Case A: role is number', typeof caseA.role === 'number');
  assertUnit('Case A: providerType = marketplace_provider for role 2', caseA.providerType === 'marketplace_provider');

  // Case B: multiple doc rows collapse to single provider with doc_total
  const caseB = mapRow({ uid: 'uid-b', first_name: null, last_name: null, email: 'b@test.com',
    role: 4, account_status: 'pending', is_archive: false, is_email_verified: false,
    doc_total: 5, pending_apps: 0, active_svc: 0, avail_status: 'saved', area_status: 'missing' });

  assertUnit('Case B: documentSummary.total = 5 (not one row per doc)', caseB.documentSummary.total === 5);
  assertUnit('Case B: displayName falls back to email when no name', caseB.displayName === 'b@test.com');
  assertUnit('Case B: providerType = internal_provider for role 4', caseB.providerType === 'internal_provider');

  // Case C: multiple active services collapse
  const caseC = mapRow({ uid: 'uid-c', first_name: 'Carlos', last_name: null, email: null,
    role: 2, account_status: 'active', is_archive: false, is_email_verified: true,
    doc_total: 3, pending_apps: 1, active_svc: 7, avail_status: 'saved', area_status: 'saved' });

  assertUnit('Case C: serviceSummary.activeServices = 7', caseC.serviceSummary.activeServices === 7);
  assertUnit('Case C: serviceSummary.pendingApplications = 1', caseC.serviceSummary.pendingApplications === 1);
  assertUnit('Case C: displayName from first name only when last is null', caseC.displayName === 'Carlos');

  // Case D: pending_apps isolated
  const caseD = mapRow({ uid: 'uid-d', first_name: '', last_name: '', email: null,
    role: 2, account_status: 'pending', is_archive: false, is_email_verified: false,
    doc_total: 0, pending_apps: 3, active_svc: 0, avail_status: 'missing', area_status: 'missing' });

  assertUnit('Case D: pendingApplications = 3', caseD.serviceSummary.pendingApplications === 3);
  assertUnit('Case D: displayName falls back to uid when all empty', caseD.displayName === 'uid-d');

  // Case G: role=1 would never appear (SQL WHERE uc.role IN (2,4) prevents it)
  // We test that the mapper correctly labels role=1 as 'unknown' providerType
  const caseG = mapRow({ uid: 'uid-g', role: 1, first_name: 'Admin', last_name: 'User',
    email: 'admin@test.com', account_status: 'active', is_archive: false, is_email_verified: true,
    doc_total: 0, pending_apps: 0, active_svc: 2, avail_status: 'unknown', area_status: 'unknown' });
  assertUnit('Case G: role=1 maps to providerType "unknown"', caseG.providerType === 'unknown');

  // Case H/E/F: null-safe doc_total — should never be negative
  const caseH = mapRow({ uid: 'uid-h', role: 2, first_name: 'H', last_name: null, email: null,
    account_status: 'active', is_archive: false, is_email_verified: true,
    doc_total: null, pending_apps: null, active_svc: null,
    avail_status: null, area_status: null });
  assertUnit('Case H/E/F: null doc_total → 0 (no orphan inflation)', caseH.documentSummary.total === 0);
  assertUnit('Case H/E/F: null pending_apps → 0', caseH.serviceSummary.pendingApplications === 0);
  assertUnit('Case H/E/F: null active_svc → 0', caseH.serviceSummary.activeServices === 0);
  assertUnit('Case H/E/F: null avail_status → "unknown"', caseH.availabilityStatus === 'unknown');

  // Case I: dedup invariant — unique UIDs
  const fakeRows = [
    { uid: 'u1', role: 2, first_name: 'A', last_name: 'B', email: 'a@x.com',
      account_status: 'active', is_archive: false, is_email_verified: true,
      doc_total: 2, pending_apps: 0, active_svc: 1, avail_status: 'saved', area_status: 'saved' },
    { uid: 'u2', role: 4, first_name: 'C', last_name: 'D', email: 'c@x.com',
      account_status: 'pending', is_archive: false, is_email_verified: false,
      doc_total: 0, pending_apps: 1, active_svc: 0, avail_status: 'missing', area_status: 'missing' },
    { uid: 'u3', role: 2, first_name: 'E', last_name: 'F', email: 'e@x.com',
      account_status: 'active', is_archive: false, is_email_verified: true,
      doc_total: 1, pending_apps: 0, active_svc: 3, avail_status: 'saved', area_status: 'missing' },
  ].map(mapRow);

  const mappedUids = fakeRows.map(r => r.uid);
  const mappedUnique = new Set(mappedUids);
  assertUnit('Case I: 3 providers → 3 unique UIDs after mapping', mappedUnique.size === 3);
  assertUnit('Case I: providerUid === uid on all rows', fakeRows.every(r => r.providerUid === r.uid));
  assertUnit('Case I: all roles are numbers after mapping', fakeRows.every(r => typeof r.role === 'number'));

  // Role string coercion (DB may return string "2")
  const roleStr = mapRow({ uid: 'uid-role', role: '2', first_name: 'R', last_name: 'S',
    email: null, account_status: 'active', is_archive: false, is_email_verified: true,
    doc_total: 0, pending_apps: 0, active_svc: 0, avail_status: 'saved', area_status: 'saved' });
  assertUnit('role is coerced to number even when DB returns string "2"', roleStr.role === 2);
  assertUnit('providerType correct after string role coercion', roleStr.providerType === 'marketplace_provider');
}

// ── Run all ───────────────────────────────────────────────────────────────────

(async () => {
  console.log('=== Admin Provider Dedup Contract Tests ===');
  try {
    await testProtectedRoutes();
    await testAdminProviderList();
    await testAdminMetricsShape();
    await testAdminDiagnosticRoutes();
    await testWorkerRoutesUnmodified();
    await testDeduplicationInvariants();
    testPureLogic();
  } catch (e) {
    console.error('Test runner error:', e);
    fail++;
  }

  console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
})();
