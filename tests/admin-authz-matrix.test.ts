/**
 * RBAC, from grant to route (TAB 10, §11 §12 §15).
 *
 * ## What this establishes
 *
 * The permission system is live and load-bearing — one admin holds 214 grants
 * with 18 deliberately withheld — but until TAB 01 nothing proved the withheld
 * 18 were actually unreachable, and TAB 01 found one place they were not. This
 * makes it a property of the system rather than a fact about one route.
 *
 * ## The matrix is DERIVED, and that is the whole point
 *
 * A hand-maintained authorization matrix becomes a confident lie: it describes
 * what somebody believed on the day they wrote it, and nothing makes it change
 * when the routes do. Every row here is read out of the mounted route table.
 *
 * ## The detector has to see ALL guards, not just the one it was written for
 *
 * The first version read only `requirePermission(…)` and reported eleven admin
 * routes as unguarded — every one of which is `requireSuperAdmin`, the
 * STRICTEST guard in the application. Super admins bypass `requirePermission`,
 * so demanding super-admin status is a stronger claim than any named
 * permission. A matrix that called those routes unprotected would have sent
 * somebody to "fix" the grant path.
 */

import fs from 'fs';
import path from 'path';
import { buildMountedRoutes, REPO_ROOT } from '../scripts/lib/routeTable';
import { guardsOf, closureOf, permissionRequires } from '../scripts/lib/capabilityParity';
import {
  ADMIN_AUTHZ_EXCEPTIONS,
  authzExceptionFor,
} from '../src/api/v1/adminAuthzExceptions';

const sourceCache = new Map<string, string>();
const readRouteFile = (rel: string): string => {
  let src = sourceCache.get(rel);
  if (src === undefined) {
    src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    sourceCache.set(rel, src);
  }
  return src;
};

const adminRoutes = buildMountedRoutes()
  .filter((r) => r.fullPath.startsWith('/api/admin'))
  .map((r) => ({ ...r, guards: guardsOf(r.handlers, readRouteFile(r.file)) }));

describe('the matrix describes the real router (positive control)', () => {
  it('covers the whole admin surface', () => {
    expect(adminRoutes.length).toBeGreaterThan(200);
  });

  it('sees requireSuperAdmin, not just requirePermission', () => {
    // The under-reporting bug: eleven grant-path routes carry this and no named
    // permission. If this stops being detected the matrix goes loud and wrong.
    const superAdminRoutes = adminRoutes.filter((r) => r.guards.superAdmin);
    expect(superAdminRoutes.length).toBeGreaterThan(5);
  });

  it('expands ...adminOnly rather than reading the route line alone', () => {
    const spread = adminRoutes.find((r) => r.handlers.some((h) => h.startsWith('...')));
    expect(spread).toBeDefined();
    expect(spread!.guards.roleGuard).toBe(true);
    expect(spread!.guards.authenticated).toBe(true);
  });
});

describe('every admin route proves who the caller is', () => {
  it('carries verifyAuth', () => {
    const missing = adminRoutes
      .filter((r) => !r.guards.authenticated)
      .map((r) => `${r.verb.toUpperCase()} ${r.fullPath}`);
    expect(missing).toEqual([]);
  });

  it('carries a role guard, or is one of the documented exceptions', () => {
    const missing = adminRoutes
      .filter((r) => !r.guards.roleGuard && !authzExceptionFor(r.verb, r.fullPath))
      .map((r) => `${r.verb.toUpperCase()} ${r.fullPath}`);
    expect(missing).toEqual([]);
  });
});

describe('every admin route names what it demands', () => {
  /**
   * The absolute rule: a named permission, OR super-admin status (stricter), OR
   * an enumerated exception carrying a reason. A rule broad enough to admit the
   * six legitimate exceptions by pattern would admit anything.
   */
  it('has a named permission, requireSuperAdmin, or a documented exception', () => {
    const unexplained = adminRoutes
      .filter(
        (r) =>
          r.guards.permissions.length === 0 &&
          !r.guards.superAdmin &&
          !authzExceptionFor(r.verb, r.fullPath),
      )
      .map((r) => `${r.verb.toUpperCase()} ${r.fullPath} (${r.file}:${r.line})`);
    expect(unexplained).toEqual([]);
  });

  it('every exception carries a substantive reason', () => {
    for (const e of ADMIN_AUTHZ_EXCEPTIONS) {
      // An exception without an argument is a hole with a comment.
      expect(e.reason.length).toBeGreaterThan(80);
    }
  });

  it('every exception still names a route that exists', () => {
    const live = new Set(adminRoutes.map((r) => `${r.verb} ${r.fullPath}`));
    const stale = ADMIN_AUTHZ_EXCEPTIONS
      .filter((e) => !live.has(`${e.method} ${e.path}`))
      .map((e) => `${e.method} ${e.path}`);
    expect(stale).toEqual([]);
  });

  /**
   * Two of the exceptions are labelled KNOWN DEFECT rather than considered.
   * They must keep saying so — an exception list where every entry reads as
   * "fine" is how a gap becomes permanent.
   */
  it('the two known defects are still labelled as defects, not as decisions', () => {
    for (const p of ['/api/admin/workers/:uid/archive', '/api/admin/provider/reconciliation']) {
      const e = ADMIN_AUTHZ_EXCEPTIONS.find((x) => x.path === p);
      expect(e).toBeDefined();
      expect(e!.reason).toMatch(/KNOWN DEFECT/);
      expect(e!.followUp).toBeTruthy();
    }
  });
});

describe('the grant path cannot be used to escalate yourself', () => {
  const grantRoutes = adminRoutes.filter(
    (r) => r.fullPath.startsWith('/api/admin/admin-users') && r.verb !== 'get',
  );

  it('finds the grant-path mutations', () => {
    expect(grantRoutes.length).toBeGreaterThan(3);
  });

  it('every grant mutation is super-admin only, except the documented bootstrap', () => {
    const weak = grantRoutes
      .filter((r) => !r.guards.superAdmin && !authzExceptionFor(r.verb, r.fullPath))
      .map((r) => `${r.verb.toUpperCase()} ${r.fullPath}`);
    // A non-super admin who could edit grants could grant themselves anything,
    // which makes every other permission in the system advisory.
    expect(weak).toEqual([]);
  });

  it('the bootstrap refuses when a super admin already exists, and audits the refusal', () => {
    const svc = fs.readFileSync(
      path.join(REPO_ROOT, 'src', 'services', 'adminPermissionService.ts'),
      'utf8',
    );
    const fn = svc.slice(svc.indexOf('export async function bootstrapSuperAdmin'));
    // Serialised, so two concurrent callers cannot both pass the count check.
    expect(fn).toMatch(/pg_advisory_xact_lock/);
    expect(fn).toMatch(/SUPER_ADMIN_EXISTS/);
    expect(fn).toMatch(/super_admin_bootstrap_denied/);
  });
});

describe('permission closure is the comparison, not string equality', () => {
  const requires = permissionRequires();

  it('a stricter permission satisfies the looser one it requires', () => {
    const strict = closureOf(['payouts.retry_failed'], requires);
    expect(strict.has('payouts.view')).toBe(true);
    expect(strict.has('payouts.details.view')).toBe(true);
  });

  it('an unrelated permission does not', () => {
    expect(closureOf(['bookings.view'], requires).has('payouts.view')).toBe(false);
  });

  /**
   * The adjudication of the 24 capability divergences TAB 01 surfaced.
   *
   * 17 dissolve once closure is applied — they were never defects, only two
   * spellings of one access level. The remaining 7 are recorded in
   * `docs/audits/TAB10_RBAC_END_TO_END.md` §3 and none is a privilege defect:
   * six are distinct capabilities deliberately given distinct permissions
   * (archive is not edit; reject is not approve), which is FINER-grained than
   * the check demands, and one compares an admin route against provider
   * self-service routes — two different authorization models, not a divergence.
   */
  it('archive and edit are allowed to differ, because they are different acts', () => {
    const archive = closureOf(['services.offering.archive'], requires);
    const edit = closureOf(['services.offering.edit'], requires);
    const comparable =
      [...edit].every((p) => archive.has(p)) || [...archive].every((p) => edit.has(p));
    // Deliberately incomparable. Recorded so nobody "fixes" it into one
    // permission and loses the distinction.
    expect(comparable).toBe(false);
  });
});
