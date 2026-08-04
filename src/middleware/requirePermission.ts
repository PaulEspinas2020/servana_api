import { Request, Response, NextFunction, RequestHandler } from 'express';
import {
  isSuperAdmin,
  hasPermission,
  getAdminUser,
  ensureAdminUserRow,
} from '../services/adminPermissionService';
import { auditFire } from '../services/adminAuditService';
import { adminError } from '../helpers/adminError';

function uid(req: Request): string {
  return (req as any).user?.uid ?? '';
}

function actorName(req: Request): string | null {
  const u = (req as any).user;
  return u?.name ?? u?.email ?? null;
}

function rid(req: Request): string | null {
  return (req as any).id ?? req.headers['x-request-id'] as string ?? null;
}

async function baseCheck(
  req: Request,
  res: Response,
  permKey: string | null
): Promise<'pass' | 'deny'> {
  const adminUid = uid(req);
  if (!adminUid) {
    adminError(res, 401, 'UNAUTHORIZED', 'Authentication required');
    return 'deny';
  }

  // Ensure row exists (auto-create on first admin access)
  try {
    await ensureAdminUserRow(adminUid);
  } catch {
    // Non-fatal — row might already exist
  }

  // Super Admins bypass all permission checks
  if (await isSuperAdmin(adminUid)) return 'pass';

  // Check account status
  const admin = await getAdminUser(adminUid);
  if (!admin || admin.account_status !== 'active') {
    auditFire({
      actionCategory: 'admin', action: 'admin_access_denied',
      entityType: 'admin_user' as any, entityId: adminUid,
      actorUid: adminUid, actorDisplayName: actorName(req),
      outcome: 'blocked',
      metadata: { reason: 'account_inactive', permKey: permKey ?? 'n/a' },
      requestId: rid(req),
    });
    adminError(res, 403, 'FORBIDDEN', 'Account is not active');
    return 'deny';
  }

  if (permKey === null) return 'pass';

  // Check specific permission
  const granted = await hasPermission(adminUid, permKey);
  if (!granted) {
    auditFire({
      actionCategory: 'admin', action: 'admin_access_denied',
      entityType: 'admin_user' as any, entityId: adminUid,
      actorUid: adminUid, actorDisplayName: actorName(req),
      outcome: 'blocked',
      metadata: { reason: 'missing_permission', permKey },
      requestId: rid(req),
    });
    adminError(res, 403, 'FORBIDDEN', `Missing required permission: ${permKey}`);
    return 'deny';
  }

  return 'pass';
}

// Factory: check a single permission key
export function requirePermission(key: string): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const result = await baseCheck(req, res, key).catch(err => {
      console.error('[requirePermission]', err);
      adminError(res, 500, 'SERVER_ERROR', 'Permission check failed');
      return 'deny' as const;
    });
    if (result === 'pass') next();
  };
}

// Factory: require at least one of the given keys
export function requireAnyPermission(keys: string[]): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const adminUid = uid(req);
      if (!adminUid) { adminError(res, 401, 'UNAUTHORIZED', 'Authentication required'); return; }
      await ensureAdminUserRow(adminUid).catch(() => {});
      if (await isSuperAdmin(adminUid)) { next(); return; }
      const admin = await getAdminUser(adminUid);
      if (!admin || admin.account_status !== 'active') {
        adminError(res, 403, 'FORBIDDEN', 'Account is not active');
        return;
      }
      for (const key of keys) {
        if (await hasPermission(adminUid, key)) { next(); return; }
      }
      adminError(res, 403, 'FORBIDDEN', `Requires one of: ${keys.join(', ')}`);
    } catch (err) {
      console.error('[requireAnyPermission]', err);
      adminError(res, 500, 'SERVER_ERROR', 'Permission check failed');
    }
  };
}

// Factory: require ALL of the given keys
export function requireAllPermissions(keys: string[]): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const adminUid = uid(req);
      if (!adminUid) { adminError(res, 401, 'UNAUTHORIZED', 'Authentication required'); return; }
      await ensureAdminUserRow(adminUid).catch(() => {});
      if (await isSuperAdmin(adminUid)) { next(); return; }
      const admin = await getAdminUser(adminUid);
      if (!admin || admin.account_status !== 'active') {
        adminError(res, 403, 'FORBIDDEN', 'Account is not active');
        return;
      }
      for (const key of keys) {
        if (!(await hasPermission(adminUid, key))) {
          adminError(res, 403, 'FORBIDDEN', `Missing required permission: ${key}`);
          return;
        }
      }
      next();
    } catch (err) {
      console.error('[requireAllPermissions]', err);
      adminError(res, 500, 'SERVER_ERROR', 'Permission check failed');
    }
  };
}

// Single middleware: require Super Admin status
export const requireSuperAdmin: RequestHandler = async (
  req: Request, res: Response, next: NextFunction
) => {
  try {
    const adminUid = uid(req);
    if (!adminUid) { adminError(res, 401, 'UNAUTHORIZED', 'Authentication required'); return; }
    await ensureAdminUserRow(adminUid).catch(() => {});
    if (await isSuperAdmin(adminUid)) { next(); return; }

    auditFire({
      actionCategory: 'admin', action: 'admin_access_denied',
      entityType: 'admin_user' as any, entityId: adminUid,
      actorUid: adminUid, actorDisplayName: actorName(req),
      outcome: 'blocked',
      metadata: { reason: 'not_super_admin' },
      requestId: rid(req),
    });
    adminError(res, 403, 'FORBIDDEN', 'Super Admin access required');
  } catch (err) {
    console.error('[requireSuperAdmin]', err);
    adminError(res, 500, 'SERVER_ERROR', 'Permission check failed');
  }
};
