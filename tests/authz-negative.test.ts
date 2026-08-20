/**
 * Every permission refuses somebody (V2 TAB 04).
 *
 * ## Why positive tests cannot establish this
 *
 * A suite that grants a permission and checks the route answers proves the
 * happy path and nothing else. It passes identically against a guard that never
 * runs — a `requirePermission` mounted after the handler, a chain where an
 * earlier middleware already responded, a store that returns `true` for
 * everything. **The only way to know a guard refuses is to watch it refuse.**
 *
 * The book states it plainly: *for each permission, a token holding everything
 * EXCEPT it must receive 403 from every route requiring it.*
 *
 * ## What is mocked, and what is deliberately NOT
 *
 * `requirePermission` itself is **real**. That is the whole point — mocking it
 * would mean asserting against the mock, which is what
 * `tests/v1-router.test.ts` legitimately does for a different purpose and what
 * this suite must not do.
 *
 * What is replaced is the STORE beneath it: `adminPermissionService`, which
 * reads `admin_users` and the grant tables. So the real guard logic runs — the
 * super-admin bypass, the account-status check, the audit on refusal — against
 * a grant set this suite controls.
 *
 * ## The composition, stated so its limit is visible
 *
 * This suite proves *"`requirePermission(P)` refuses a caller without P"*.
 * `tests/admin-authz-matrix.test.ts` proves *"every admin route demands its P,
 * after `verifyAuth`, or is a documented exception"*. Together those give the
 * property the book asks for. Neither half is sufficient alone, and this file
 * does not pretend to carry both.
 */

import type { Request, Response } from 'express';
import { buildMountedRoutes } from '../scripts/lib/routeTable';
import { guardsOf } from '../scripts/lib/capabilityParity';
import fs from 'fs';
import path from 'path';

// ── the store, under this suite's control ────────────────────────────────────

const store = {
  granted: new Set<string>(),
  superAdmin: false,
  status: 'active' as string,
};

jest.mock('../src/services/adminPermissionService', () => ({
  __esModule: true,
  isSuperAdmin: async () => store.superAdmin,
  hasPermission: async (_uid: string, key: string) => store.granted.has(key),
  getAdminUser: async () => ({ admin_uid: 'admin-under-test', account_status: store.status }),
  ensureAdminUserRow: async () => undefined,
}));

const audits: Array<{ action: string; outcome: string; metadata?: Record<string, unknown> }> = [];
jest.mock('../src/services/adminAuditService', () => ({
  __esModule: true,
  auditFire: (e: { action: string; outcome: string; metadata?: Record<string, unknown> }) =>
    audits.push(e),
}));

// Real. Imported AFTER the mocks above so it binds to them.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { requirePermission } = require('../src/middleware/requirePermission');

/** Drives the real middleware and reports what it did. */
const call = async (
  permission: string,
): Promise<{ status: number; body: any; passed: boolean }> => {
  let status = 0;
  let body: any = null;
  let passed = false;

  const req = { user: { uid: 'admin-under-test' }, headers: {}, id: 'req-1' } as unknown as Request;
  const headers: Record<string, string> = {};
  const res = {
    // `adminError` stamps a request id before it answers, so a fake response
    // without setHeader throws inside the middleware and every case fails for
    // the wrong reason — a red suite that proves nothing about authorization.
    setHeader(name: string, value: string) {
      headers[name] = value;
      return this;
    },
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: unknown) {
      body = payload;
      return this;
    },
  } as unknown as Response;

  await new Promise<void>((resolve) => {
    const done = () => {
      passed = true;
      resolve();
    };
    requirePermission(permission)(req, res, done);
    // The middleware is async; give its promise chain a turn to settle.
    setImmediate(() => resolve());
  });

  return { status, body, passed };
};

/** Every distinct permission any admin route demands, read from the router. */
const demandedPermissions = (): string[] => {
  const cache = new Map<string, string>();
  const read = (rel: string): string => {
    let src = cache.get(rel);
    if (src === undefined) {
      src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
      cache.set(rel, src);
    }
    return src;
  };
  const found = new Set<string>();
  for (const r of buildMountedRoutes()) {
    if (!r.fullPath.startsWith('/api/admin')) continue;
    for (const p of guardsOf(r.handlers, read(r.file)).permissions) found.add(p);
  }
  return [...found].sort();
};

const PERMISSIONS = demandedPermissions();

beforeEach(() => {
  store.granted = new Set(PERMISSIONS);
  store.superAdmin = false;
  store.status = 'active';
  audits.length = 0;
});

describe('the fixture is real (positive control)', () => {
  it('reads a substantial set of permissions off the admin routes', () => {
    expect(PERMISSIONS.length).toBeGreaterThan(50);
  });

  it('a caller holding everything is allowed through', () => {
    // If this fails, every negative result below is meaningless — the middleware
    // would be refusing for some reason other than the missing grant.
    return call(PERMISSIONS[0]).then((r) => {
      expect(r.passed).toBe(true);
      expect(r.status).toBe(0);
    });
  });
});

describe('every permission refuses a caller who holds everything except it', () => {
  it.each(PERMISSIONS.map((p) => [p]))('%s', async (permission) => {
    store.granted = new Set(PERMISSIONS.filter((p) => p !== permission));

    const r = await call(String(permission));

    expect(r.passed).toBe(false);
    expect(r.status).toBe(403);
  });
});

describe('a refusal is recorded, not merely returned', () => {
  it('writes an audit naming the permission that was missing', async () => {
    store.granted = new Set();
    await call('payouts.trigger_due_run');

    const denied = audits.find((a) => a.action === 'admin_access_denied');
    expect(denied).toBeDefined();
    expect(denied!.outcome).toBe('blocked');
    // Which permission, not just that something was refused — a denial log that
    // does not name the key cannot answer "why was this person stopped".
    expect(denied!.metadata).toMatchObject({ permKey: 'payouts.trigger_due_run' });
  });

  it('says nothing when the caller is allowed', async () => {
    await call(PERMISSIONS[0]);
    expect(audits.filter((a) => a.action === 'admin_access_denied')).toEqual([]);
  });
});

describe('the two bypasses behave as designed', () => {
  it('a super admin passes without holding the grant', async () => {
    // Documented behaviour, and the reason a super admin is NOT evidence that
    // anybody else is covered when provisioning grants before a release.
    store.granted = new Set();
    store.superAdmin = true;

    const r = await call('payouts.trigger_due_run');
    expect(r.passed).toBe(true);
  });

  it('an inactive account is refused even holding every grant', async () => {
    store.granted = new Set(PERMISSIONS);
    store.status = 'suspended';

    const r = await call('payouts.view');
    expect(r.passed).toBe(false);
    expect(r.status).toBe(403);
    expect(audits.find((a) => a.action === 'admin_access_denied')?.metadata).toMatchObject({
      reason: 'account_inactive',
    });
  });
});

describe('the money permissions specifically', () => {
  // Named individually because these are the ones a release can lock somebody
  // out of, and the ones an attacker would most like to find unguarded.
  it.each([
    ['payouts.trigger_due_run'],
    ['payouts.retry_failed'],
    ['payouts.view'],
    ['payouts.details.view'],
    ['refunds.approve'],
  ])('%s refuses without the grant', async (permission) => {
    store.granted = new Set(PERMISSIONS.filter((p) => p !== permission));
    const r = await call(String(permission));
    expect({ permission, status: r.status }).toEqual({ permission, status: 403 });
  });
});
