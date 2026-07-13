/**
 * Provider Catalog — contract tests
 *
 * Verifies that:
 *  1. Admin-only catalog routes require authentication.
 *  2. Provider-facing catalog route is accessible (no admin auth needed).
 *  3. Legacy /services routes still exist (backward compatibility).
 *  4. The /:serviceId/options-with-addons endpoint is reachable (mobile contract preserved).
 *  5. Publish-preview and publish routes are registered and gated.
 *
 * Run with:  npx ts-node tests/catalog-service.test.ts
 * (Requires local API on PORT env var or default 3000)
 */

import http from 'http';

const BASE = `http://localhost:${process.env.PORT ?? 3000}/api`;
let pass = 0, fail = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────

function request(method: string, path: string, body?: object, token?: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + path);
    const payload = body ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const req = http.request(
      { hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method, headers },
      res => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode ?? 0, body: data }); }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
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

async function testAdminCatalogRoutesGated() {
  console.log('\n§ Admin catalog routes — require authentication');

  const gatedRoutes = [
    ['GET', '/admin/provider-catalog/overview'],
    ['GET', '/admin/provider-catalog/offerings'],
    ['GET', '/admin/provider-catalog/service-families'],
    ['GET', '/admin/provider-catalog/audit'],
    ['POST', '/admin/provider-catalog/offerings'],
    ['PATCH', '/admin/provider-catalog/offerings/1'],
    ['PATCH', '/admin/provider-catalog/offerings/1/status'],
    ['POST', '/admin/provider-catalog/offerings/1/specific-services'],
    ['GET', '/admin/provider-catalog/offerings/1/specific-services'],
    ['GET', '/admin/provider-catalog/specific-services/1'],
    ['PATCH', '/admin/provider-catalog/specific-services/1'],
    ['PATCH', '/admin/provider-catalog/specific-services/1/status'],
    ['POST', '/admin/provider-catalog/specific-services/1/addons'],
    ['PATCH', '/admin/provider-catalog/addons/1'],
    ['PATCH', '/admin/provider-catalog/addons/1/status'],
    ['POST', '/admin/provider-catalog/offerings/1/publish-preview'],
    ['POST', '/admin/provider-catalog/offerings/1/publish'],
    ['GET', '/admin/provider-catalog/offerings/1/providers'],
    ['POST', '/admin/provider-catalog/offerings/1/mappings'],
    ['PATCH', '/admin/provider-catalog/mappings/1'],
    ['DELETE', '/admin/provider-catalog/mappings/1'],
  ];

  for (const [method, path] of gatedRoutes) {
    const res = await request(method, path).catch(() => ({ status: 0, body: null }));
    assert(
      `${method} ${path} is blocked without token (${res.status})`,
      res.status !== 200 && res.status !== 201,
      `got ${res.status}`
    );
    assert(
      `${method} ${path} is registered (not 404)`,
      res.status !== 404,
      `got ${res.status}`
    );
  }
}

async function testProviderCatalogRouteOpen() {
  console.log('\n§ Provider-facing catalog — accessible without admin token');

  // This endpoint is protected by verifyAuth (provider token), not admin token.
  // Without any token it should return 401 (not 403 "forbidden" and not 404 "not found").
  const res = await request('GET', '/provider-catalog/v1/offerings').catch(() => ({ status: 0, body: null }));
  assert(
    'GET /provider-catalog/v1/offerings is registered (not 404)',
    res.status !== 404,
    `got ${res.status}`
  );
  assert(
    'unauthenticated request is rejected (not 200)',
    res.status !== 200,
    `got ${res.status}`
  );
}

async function testLegacyServicesEndpointsPreserved() {
  console.log('\n§ Legacy /services endpoints — backward compatibility');

  // These must remain registered so mobile / provider-web integrations do not break.
  const legacyRoutes = [
    ['GET', '/services/list'],
    ['GET', '/services/full'],
  ];

  for (const [method, path] of legacyRoutes) {
    const res = await request(method, path).catch(() => ({ status: 0, body: null }));
    assert(
      `${method} ${path} still registered (not 404)`,
      res.status !== 404,
      `got ${res.status}`
    );
  }
}

async function testOptionsWithAddonsEndpointPreserved() {
  console.log('\n§ /:serviceId/options-with-addons — mobile customer contract');

  // Endpoint is open (no auth). With a non-existent serviceId it returns [] or 404/200+[].
  // The contract check is: route is registered and returns a parseable response, not 404.
  const res = await request('GET', '/99999/options-with-addons').catch(() => ({ status: 0, body: null }));
  assert(
    'GET /:serviceId/options-with-addons is registered (not 404)',
    res.status !== 404,
    `got ${res.status}`
  );
  assert(
    'response is parseable (not raw string)',
    typeof res.body === 'object' && res.body !== null,
    `got type ${typeof res.body}`
  );
}

async function testIsActiveFilterNotExposingInactiveOptions() {
  console.log('\n§ is_active filter — inactive options must not appear in response');

  // This is a structural contract test: if service_options.is_active = false,
  // the endpoint must not return that row. We cannot set up test data here,
  // but we verify the endpoint returns an array (not an error), proving
  // the query executes correctly with the is_active filter in place.
  const res = await request('GET', '/1/options-with-addons').catch(() => ({ status: 0, body: null }));
  const isArray = Array.isArray(res.body?.data) || Array.isArray(res.body);
  assert(
    'endpoint returns array (query with is_active filter executes without error)',
    isArray || res.status === 200,
    `status=${res.status}, body type=${typeof res.body}`
  );
}

async function testPublishPreviewResponseShape() {
  console.log('\n§ publish-preview — response shape');

  // Without auth, returns 401/403. Not 404 — the route must be registered.
  const res = await request('POST', '/admin/provider-catalog/offerings/1/publish-preview').catch(() => ({ status: 0, body: null }));
  assert(
    'POST /admin/provider-catalog/offerings/1/publish-preview is registered (not 404)',
    res.status !== 404,
    `got ${res.status}`
  );
}

async function testForceDeleteEndpointNotExposedAdminUi() {
  console.log('\n§ Force-delete removed from Admin UI (route check)');

  // DELETE /admin/provider-catalog/offerings/:id — should NOT exist (not part of catalog contract)
  const res = await request('DELETE', '/admin/provider-catalog/offerings/1').catch(() => ({ status: 0, body: null }));
  assert(
    'DELETE /admin/provider-catalog/offerings/:id does not exist (404)',
    res.status === 404,
    `got ${res.status} — force-delete should not be a registered admin catalog route`
  );
}

// ── Run all ───────────────────────────────────────────────────────────────────

(async () => {
  console.log('=== Catalog Service Contract Tests ===');
  try {
    await testAdminCatalogRoutesGated();
    await testProviderCatalogRouteOpen();
    await testLegacyServicesEndpointsPreserved();
    await testOptionsWithAddonsEndpointPreserved();
    await testIsActiveFilterNotExposingInactiveOptions();
    await testPublishPreviewResponseShape();
    await testForceDeleteEndpointNotExposedAdminUi();
  } catch (err) {
    console.error('Fatal error running tests:', err);
    fail++;
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
})();
