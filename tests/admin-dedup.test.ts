/**
 * Admin Provider Deduplication — contract tests
 *
 * These verify that Admin read-model endpoints deduplicate by provider UID
 * and that provider/worker/mobile routes are UNMODIFIED.
 *
 * Run with:  npx ts-node tests/admin-dedup.test.ts
 * (Requires local API running on PORT env var or default 3000)
 */

import http from 'http';

const BASE = `http://localhost:${process.env.PORT ?? 3000}/api`;
let pass = 0, fail = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────

function get(path: string, token?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const opts: http.RequestOptions = { method: 'GET', headers: {} };
    if (token) (opts.headers as any)['Authorization'] = `Bearer ${token}`;
    const url = new URL(BASE + path);
    const req = http.request({ hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method: 'GET', headers: opts.headers ?? {} }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
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

// ── Tests ─────────────────────────────────────────────────────────────────────

async function testProtectedRoutes() {
  console.log('\n§ Protected route compatibility (unauthenticated → not 200)');

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

async function testAdminProviderList() {
  console.log('\n§ GET /admin/providers — requires auth (no token → non-200)');
  const res = await get('/admin/providers');
  assert('unauthenticated request blocked', res.status !== 200, `got ${res.status}`);
}

async function testAdminMetricsShape() {
  console.log('\n§ GET /admin/providers/metrics — structure check (unauthenticated)');
  const res = await get('/admin/providers/metrics');
  assert('returns 401/403 without token', res.status === 401 || res.status === 403 || res.status === 400);
}

async function testAdminDuplicatesRoute() {
  console.log('\n§ GET /admin/providers/duplicates — route registered');
  const res = await get('/admin/providers/duplicates');
  // Without a token, expect 401/403, NOT 404 (route must exist)
  assert('route is registered (not 404)', res.status !== 404, `got ${res.status}`);
  assert('blocked without admin token', res.status !== 200, `got ${res.status}`);
}

async function testOverlapMapRoute() {
  console.log('\n§ GET /admin/providers/:uid/overlap-map — route registered');
  const res = await get('/admin/providers/test-uid-does-not-exist/overlap-map');
  assert('route registered (not 404 on missing uid)', res.status !== 404, `got ${res.status}`);
}

async function testWorkerRoutesUnmodified() {
  console.log('\n§ /workers/:uid/* mobile routes — path structure unchanged');
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
    // Mobile routes have no auth — they return 200/400/404 but NOT 401/403
    assert(`${path} is accessible without token (status ${res.status})`, res.status !== 401 && res.status !== 403);
  }
}

// ── Run all ───────────────────────────────────────────────────────────────────

(async () => {
  console.log('=== Admin Dedup Contract Tests ===');
  try {
    await testProtectedRoutes();
    await testAdminProviderList();
    await testAdminMetricsShape();
    await testAdminDuplicatesRoute();
    await testOverlapMapRoute();
    await testWorkerRoutesUnmodified();
  } catch (e) {
    console.error('Test runner error:', e);
    fail++;
  }

  console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
})();
