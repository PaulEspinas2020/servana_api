/**
 * The API's security baseline (TAB 05, F-06 and F-07).
 *
 * ## What was missing
 *
 * F-06: `helmet` was not a dependency. Live responses carried no HSTS, no
 * `nosniff`, no `Referrer-Policy`. The only header control was
 * `app.disable('x-powered-by')`.
 *
 * F-07: limiters existed for auth, pricing and account deletion, and v1 had a
 * rate-limit policy. The 251 admin routes had none — including payout, refund
 * and permission mutations. The most consequential surface was the only
 * unthrottled one.
 *
 * ## The assertion that matters most is the ORDER
 *
 * `adminRateLimit` keys on the authenticated admin's uid, and `req.user` is set
 * by `verifyAuth`. A limiter placed BEFORE `verifyAuth` in the chain sees no
 * user, silently falls back to the IP, and every admin on the platform shares
 * one bucket — because they all arrive through the same nginx hop. It would
 * still return 429s. It would still look like it worked. It would throttle the
 * operations team as a group and catch no individual account behaving oddly.
 *
 * That failure is invisible to a test that only asks "is the limiter present",
 * so this asks where it is.
 */

import express from 'express';
import fs from 'fs';
import path from 'path';
import { buildMountedRoutes, REPO_ROOT } from '../scripts/lib/routeTable';
import { startTestServer, request } from './support/httpTestServer';
import { apiSecurityHeaders } from '../src/middleware/securityHeaders';
import { adminTierFor, ADMIN_BUCKETS } from '../src/api/v1/rateLimitPolicy';

// ── chain expansion ──────────────────────────────────────────────────────────

/**
 * `...adminOnly` is a spread of a module-local array. The route table records
 * handler EXPRESSIONS, so the spread has to be resolved against the file it was
 * written in before the chain can be read in order.
 */
/**
 * The elements of `const <name> = [ ... ]`, split on TOP-LEVEL commas.
 *
 * The first version of this used `\[([^\]]*)\]`, which stops at the first
 * closing bracket — and the very chain it had to read is
 * `[verifyAuth, verifyRoles([1]), adminRateLimit]`, whose first `]` is inside
 * `verifyRoles([1])`. It silently truncated every chain before the limiter and
 * reported 500 routes as unprotected.
 *
 * Recorded rather than quietly corrected, because the failure mode is the one
 * this whole suite exists to prevent: a check that is WRONG in the alarming
 * direction still has to be fixed, and the fix has to be the parser rather than
 * the expectation. Depth counting is what makes the answer independent of what
 * a handler expression happens to contain.
 */
function arrayLiteralAfter(src: string, name: string): string[] | null {
  const decl = new RegExp(`const\\s+${name}\\s*=\\s*\\[`).exec(src);
  if (!decl) return null;

  const open = decl.index + decl[0].length;
  let depth = 1;
  let i = open;
  for (; i < src.length && depth > 0; i += 1) {
    const c = src[i];
    if (c === '[' || c === '(') depth += 1;
    else if (c === ']' || c === ')') depth -= 1;
  }
  if (depth !== 0) return null;

  const inner = src.slice(open, i - 1);
  const parts: string[] = [];
  let buf = '';
  let d = 0;
  for (const c of inner) {
    if (c === '[' || c === '(') d += 1;
    if (c === ']' || c === ')') d -= 1;
    if (c === ',' && d === 0) {
      if (buf.trim()) parts.push(buf.trim());
      buf = '';
      continue;
    }
    buf += c;
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts;
}

function expandChain(file: string, handlers: string[]): string[] {
  const src = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
  const out: string[] = [];
  for (const h of handlers) {
    const spread = /^\.\.\.([A-Za-z_$][\w$]*)$/.exec(h.trim());
    if (!spread) {
      out.push(h.trim());
      continue;
    }
    const elements = arrayLiteralAfter(src, spread[1]);
    if (elements === null) {
      out.push(h.trim());
      continue;
    }
    out.push(...elements);
  }
  return out;
}

const adminRoutes = buildMountedRoutes()
  .filter((r) => r.fullPath.startsWith('/api/admin'))
  .map((r) => ({ ...r, chain: expandChain(r.file, r.handlers) }));

describe('every admin route is rate limited', () => {
  it('finds the admin surface at all (positive fixture)', () => {
    expect(adminRoutes.length).toBeGreaterThan(200);
  });

  it('expands a spread chain into its parts', () => {
    const sample = adminRoutes.find((r) => r.handlers.some((h) => h.startsWith('...')));
    expect(sample).toBeDefined();
    expect(sample!.chain).toContain('verifyAuth');
  });

  it('no admin route is missing the limiter', () => {
    const missing = adminRoutes
      .filter((r) => !r.chain.some((h) => h.includes('adminRateLimit')))
      .map((r) => `${r.verb.toUpperCase()} ${r.fullPath} (${r.file}:${r.line})`);
    expect(missing).toEqual([]);
  });

  /**
   * The load-bearing one. See the module docblock: a limiter before `verifyAuth`
   * keys on the IP, and every admin arrives through the same nginx hop.
   */
  it('the limiter runs AFTER verifyAuth, so it can key on the actor', () => {
    const wrongOrder = adminRoutes
      .filter((r) => {
        const auth = r.chain.findIndex((h) => h.includes('verifyAuth'));
        const limit = r.chain.findIndex((h) => h.includes('adminRateLimit'));
        return auth === -1 || limit === -1 || limit < auth;
      })
      .map((r) => `${r.verb.toUpperCase()} ${r.fullPath}`);
    expect(wrongOrder).toEqual([]);
  });
});

describe('the tier is chosen by what the request can do', () => {
  it('reads get the generous tier', () => {
    expect(adminTierFor('GET', '/api/admin/bookings')).toBe('adminRead');
  });

  it('writes get the mutation tier', () => {
    expect(adminTierFor('POST', '/api/admin/bookings/1/assign')).toBe('adminMutation');
  });

  it('money is sensitive regardless of method', () => {
    expect(adminTierFor('GET', '/api/admin/finance/payouts')).toBe('adminSensitive');
    expect(adminTierFor('POST', '/api/admin/disbursements/trigger')).toBe('adminSensitive');
  });

  it('permissions are sensitive — a grant is a money action one step removed', () => {
    expect(adminTierFor('POST', '/api/admin/permissions/grant')).toBe('adminSensitive');
  });

  /**
   * Found by the coverage test rather than by reading: `/api/admin/admin-users`
   * and `/api/admin/users` are DIFFERENT prefixes, and matching only the latter
   * left super-admin bootstrap on the ordinary mutation tier.
   */
  it('admin identity is sensitive — bootstrapping a super admin most of all', () => {
    expect(adminTierFor('POST', '/api/admin/admin-users/bootstrap-super-admin')).toBe(
      'adminSensitive',
    );
    expect(adminTierFor('PATCH', '/api/admin/admin-users/someone')).toBe('adminSensitive');
  });

  it('the sensitive tier is genuinely stricter, not just differently named', () => {
    expect(ADMIN_BUCKETS.adminSensitive.max).toBeLessThan(ADMIN_BUCKETS.adminMutation.max);
    expect(ADMIN_BUCKETS.adminMutation.max).toBeLessThan(ADMIN_BUCKETS.adminRead.max);
  });
});

describe('the headers are actually served, over a real socket', () => {
  let base: string;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    const app = express();
    app.use(apiSecurityHeaders);
    app.get('/anything', (_req, res) => {
      res.json({ ok: true });
    });
    app.get('/boom', (_req, res) => {
      res.status(500).json({ status: 'error' });
    });
    const server = await startTestServer(app);
    base = server.base;
    stop = server.close;
  });

  afterAll(async () => {
    await stop();
  });

  it('sends HSTS with a year and subdomains', async () => {
    const res = await request(base, 'GET', '/anything');
    expect(res.headers.get('strict-transport-security')).toBe(
      'max-age=31536000; includeSubDomains',
    );
  });

  it('does NOT send preload — that is a one-way door and a separate decision', async () => {
    const res = await request(base, 'GET', '/anything');
    expect(res.headers.get('strict-transport-security')).not.toMatch(/preload/);
  });

  it('sends nosniff and a referrer policy', async () => {
    const res = await request(base, 'GET', '/anything');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
  });

  it('refuses to be framed', async () => {
    const res = await request(base, 'GET', '/anything');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  /**
   * THE §4 ASSERTION. helmet's default is `same-origin`, which would refuse
   * cross-origin fetches of provider documents and catalog banners from all
   * five consumers — two of them installed mobile builds that cannot be
   * re-released to work around a response header.
   */
  it('does not break cross-origin resource fetches', async () => {
    const res = await request(base, 'GET', '/anything');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
  });

  it('sends no CSP on a JSON response', async () => {
    const res = await request(base, 'GET', '/anything');
    expect(res.headers.get('content-security-policy')).toBeNull();
  });

  it('sends the headers on an ERROR response too', async () => {
    // The headers that say how to treat the bytes matter most when the bytes
    // are unexpected.
    const res = await request(base, 'GET', '/boom');
    expect(res.status).toBe(500);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('strict-transport-security')).toBeTruthy();
  });
});

describe('a throttled admin gets a usable refusal, not the limiter\'s prose', () => {
  let base: string;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    jest.resetModules();
    process.env.ADMIN_RATE_LIMIT_LOG_ONLY = 'false';
    // Required afresh so the module-level limiters are built with this env.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { adminRateLimit } = require('../src/middleware/adminRateLimit');

    const app = express();
    // Stands in for verifyAuth: the limiter must see a user to key on one.
    app.use((req: any, _res, next) => {
      req.user = { uid: 'admin-under-test' };
      next();
    });
    app.use('/api/admin', adminRateLimit);
    app.post('/api/admin/finance/payouts/1/retry', (_req, res) => {
      res.json({ ok: true });
    });

    const server = await startTestServer(app);
    base = server.base;
    stop = server.close;
  });

  afterAll(async () => {
    await stop();
    delete process.env.ADMIN_RATE_LIMIT_LOG_ONLY;
    jest.resetModules();
  });

  it('refuses past the sensitive budget and says how long to wait', async () => {
    const path = '/api/admin/finance/payouts/1/retry';
    const budget = ADMIN_BUCKETS.adminSensitive.max;

    let limited: Awaited<ReturnType<typeof request>> | null = null;
    for (let i = 0; i < budget + 2; i += 1) {
      const res = await request(base, 'POST', path, { body: {} });
      if (res.status === 429) {
        limited = res;
        break;
      }
    }

    expect(limited).not.toBeNull();
    expect(limited!.headers.get('retry-after')).toBeTruthy();

    const body = limited!.body as any;
    // Both layouts, per helpers/rateLimitBody: a client following the canonical
    // contract reads error.code; already-shipped clients read the flat message.
    expect(body.status).toBe('error');
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.retryable).toBe(true);
    expect(typeof body.message).toBe('string');
  });

  it('leaks no budget, window or bucket name to the caller (§21)', async () => {
    const path = '/api/admin/finance/payouts/1/retry';
    let limited: any = null;
    for (let i = 0; i < ADMIN_BUCKETS.adminSensitive.max + 2; i += 1) {
      const res = await request(base, 'POST', path, { body: {} });
      if (res.status === 429) {
        limited = res;
        break;
      }
    }
    expect(limited).not.toBeNull();
    const text = JSON.stringify(limited.body);
    // Telling an attacker the exact budget tells them exactly how hard to push.
    expect(text).not.toMatch(/adminSensitive/);
    expect(text).not.toMatch(String(ADMIN_BUCKETS.adminSensitive.max));
    expect(text).not.toMatch(/window/i);
  });
});

describe('the one HTML page this API serves has a real CSP', () => {
  const { staticPageCsp } = require('../src/middleware/securityHeaders');

  const page =
    '<html><head><style>body{color:red}</style></head>' +
    '<body><script>console.log(1)</script></body></html>';

  it('hashes the inline script rather than allowing all inline script', () => {
    const csp = staticPageCsp(page);
    expect(csp).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).not.toMatch(/unsafe-eval/);
  });

  it('hashes the inline style too', () => {
    expect(staticPageCsp(page)).toMatch(/style-src 'sha256-[A-Za-z0-9+/=]+'/);
  });

  /**
   * The property a pasted hash cannot have. If the policy were a literal, an
   * edit to the page would leave it behind — and the page would silently stop
   * working for the Google Play reviewer it exists for.
   */
  it('a changed script yields a changed hash, so the policy cannot go stale', () => {
    const edited = page.replace('console.log(1)', 'console.log(2)');
    expect(staticPageCsp(edited)).not.toBe(staticPageCsp(page));
  });

  it('allows the same-origin fetch the page actually makes', () => {
    // default-src 'none' without this blocks the page's only action, which
    // looks fine and does nothing.
    expect(staticPageCsp(page)).toMatch(/connect-src 'self'/);
  });

  it('refuses framing through the control browsers honour', () => {
    expect(staticPageCsp(page)).toMatch(/frame-ancestors 'none'/);
  });

  it('the REAL page is covered — its script and style are both hashed', () => {
    // Reads the shipped document, not a fixture: a policy that only works on a
    // sample is not a policy.
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'routes', 'accountDeletion.routes.ts'),
      'utf8',
    );
    const scripts = src.match(/<script>[\s\S]*?<\/script>/g) ?? [];
    const styles = src.match(/<style>[\s\S]*?<\/style>/g) ?? [];
    expect(scripts.length).toBe(1);
    expect(styles.length).toBe(1);

    const csp = staticPageCsp(scripts[0] + styles[0]);
    expect(csp).toMatch(/script-src 'sha256-/);
    expect(csp).toMatch(/style-src 'sha256-/);
  });
});
