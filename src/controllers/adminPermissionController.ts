import { Request, Response } from 'express';
import * as inviteSvc from '../services/adminInviteService';
import {
  adminServerError,
  adminNotFound,
  adminBadRequest,
  adminConflict,
  adminValidationError,
  adminError,
} from '../helpers/adminError';
import * as svc from '../services/adminPermissionService';

// ── Helpers ───────────────────────────────────────────────────────────────────

function actorFrom(req: Request): { uid: string; name: string | null } {
  const user = (req as any).user;
  return {
    uid:  user?.uid ?? 'unknown',
    name: user?.name ?? user?.email ?? null,
  };
}

function rid(req: Request): string | null {
  return (req as any).id ?? req.headers['x-request-id'] as string ?? null;
}

function handleSvcError(res: Response, err: unknown): Response {
  const e = err as any;
  if (e?.code === 'NOT_FOUND')      return adminNotFound(res, e.message);
  if (e?.code === 'CONFLICT')       return adminConflict(res, e.message);
  if (e?.code === 'BUSINESS_RULE')  return adminBadRequest(res, e.message);
  if (e?.code === 'FORBIDDEN')      return adminError(res, 403, 'FORBIDDEN', e.message);
  return adminServerError(res, err);
}

// ── Own permissions ───────────────────────────────────────────────────────────

export async function getMyPermissions(req: Request, res: Response): Promise<void> {
  try {
    const uid = (req as any).user?.uid;
    if (!uid) { adminBadRequest(res, 'User UID not found'); return; }
    await svc.ensureAdminUserRow(uid);
    const data = await svc.getEffectivePermissions(uid);
    res.json({ status: 'success', data });
  } catch (err) {
    handleSvcError(res, err);
  }
}

// ── Permission definitions ────────────────────────────────────────────────────

export async function getPermissionDefinitions(req: Request, res: Response): Promise<void> {
  try {
    const data = await svc.getPermissionDefinitions();
    res.json({ status: 'success', data });
  } catch (err) {
    handleSvcError(res, err);
  }
}

// ── Admin user list ───────────────────────────────────────────────────────────

export async function listAdminUsers(req: Request, res: Response): Promise<void> {
  try {
    const { status, search, page, limit } = req.query as Record<string, string>;
    const data = await svc.listAdminUsers({
      status, search,
      page:  page  ? Number(page)  : undefined,
      limit: limit ? Number(limit) : undefined,
    });
    res.json({ status: 'success', data });
  } catch (err) {
    handleSvcError(res, err);
  }
}

// ── Admin user create ─────────────────────────────────────────────────────────

export async function createAdminUser(req: Request, res: Response): Promise<void> {
  try {
    const { adminUid, email, displayName, isSuperAdmin } = req.body;
    if (!adminUid?.trim() || !email?.trim()) {
      adminValidationError(res, 'adminUid and email are required');
      return;
    }
    const { uid, name } = actorFrom(req);
    const data = await svc.createAdminUser(
      { adminUid: adminUid.trim(), email: email.trim(), displayName: displayName?.trim() ?? null,
        isSuperAdmin: isSuperAdmin === true },
      uid, name, rid(req)
    );
    res.status(201).json({ status: 'success', data });
  } catch (err) {
    handleSvcError(res, err);
  }
}

// ── Admin user INVITE (email only, no Firebase UID) ───────────────────────────

/**
 * POST /api/admin/admin-users/invite
 *
 * Creates the Firebase account, the admin record, and emails a set-password
 * link — so an operator only needs an email address.
 *
 * The existing POST /admin/admin-users still takes a Firebase UID and is
 * unchanged: it remains the right call when the account demonstrably already
 * exists and someone is granting it access.
 */
export async function inviteAdminUser(req: Request, res: Response): Promise<void> {
  try {
    const { email, displayName, isSuperAdmin } = req.body;
    if (!email?.trim()) {
      adminValidationError(res, 'email is required');
      return;
    }
    const { uid, name } = actorFrom(req);
    const data = await inviteSvc.inviteAdminUser(
      {
        email: email.trim(),
        displayName: displayName?.trim() || null,
        isSuperAdmin: isSuperAdmin === true,
      },
      uid, name, rid(req)
    );

    // 201 whether or not the mail hop succeeded — the admin record exists
    // either way, and `emailSent: false` tells the portal to offer Resend
    // rather than implying the whole invitation failed.
    res.status(201).json({ status: 'success', data });
  } catch (err) {
    handleSvcError(res, err);
  }
}

/** POST /api/admin/admin-users/:adminUid/resend-invite */
export async function resendAdminInvite(req: Request, res: Response): Promise<void> {
  try {
    const { name } = actorFrom(req);
    const data = await inviteSvc.resendAdminInvite(String(req.params.adminUid), name);
    res.status(200).json({ status: 'success', data });
  } catch (err) {
    handleSvcError(res, err);
  }
}

// ── Admin user detail ─────────────────────────────────────────────────────────

export async function getAdminUserById(req: Request, res: Response): Promise<void> {
  try {
    const adminUid = String(req.params.adminUid ?? '').trim();
    if (!adminUid) { adminBadRequest(res, 'adminUid required'); return; }
    const data = await svc.getAdminUserDetail(adminUid);
    if (!data) { adminNotFound(res, 'Admin user'); return; }
    res.json({ status: 'success', data });
  } catch (err) {
    handleSvcError(res, err);
  }
}

// ── Admin user update ─────────────────────────────────────────────────────────

export async function updateAdminUser(req: Request, res: Response): Promise<void> {
  try {
    const adminUid = String(req.params.adminUid ?? '').trim();
    if (!adminUid) { adminBadRequest(res, 'adminUid required'); return; }
    const { displayName, email } = req.body;
    const { uid, name } = actorFrom(req);
    const data = await svc.updateAdminUser(
      adminUid,
      { displayName: displayName ?? undefined, email: email ?? undefined },
      uid, name, rid(req)
    );
    res.json({ status: 'success', data });
  } catch (err) {
    handleSvcError(res, err);
  }
}

// ── Admin user status ─────────────────────────────────────────────────────────

export async function updateAdminUserStatus(req: Request, res: Response): Promise<void> {
  try {
    const adminUid = String(req.params.adminUid ?? '').trim();
    if (!adminUid) { adminBadRequest(res, 'adminUid required'); return; }
    const { status } = req.body;
    const valid: svc.AdminAccountStatus[] = ['active', 'inactive', 'suspended', 'archived'];
    if (!status || !valid.includes(status)) {
      adminValidationError(res, `status must be one of: ${valid.join(', ')}`);
      return;
    }
    const { uid, name } = actorFrom(req);
    await svc.updateAdminUserStatus(adminUid, status as svc.AdminAccountStatus, uid, name, rid(req));
    res.json({ status: 'success', data: { adminUid, accountStatus: status } });
  } catch (err) {
    handleSvcError(res, err);
  }
}

// ── Admin user permissions ────────────────────────────────────────────────────

export async function getAdminUserPermissions(req: Request, res: Response): Promise<void> {
  try {
    const adminUid = String(req.params.adminUid ?? '').trim();
    if (!adminUid) { adminBadRequest(res, 'adminUid required'); return; }
    const data = await svc.getAdminUserPermissions(adminUid);
    res.json({ status: 'success', data });
  } catch (err) {
    handleSvcError(res, err);
  }
}

export async function updateAdminUserPermissions(req: Request, res: Response): Promise<void> {
  try {
    const adminUid = String(req.params.adminUid ?? '').trim();
    if (!adminUid) { adminBadRequest(res, 'adminUid required'); return; }
    const { permissions, reason } = req.body;
    if (!Array.isArray(permissions)) {
      adminValidationError(res, 'permissions must be an array of permission keys');
      return;
    }
    if (!reason?.trim()) {
      adminValidationError(res, 'reason is required for permission changes');
      return;
    }
    const { uid, name } = actorFrom(req);
    const data = await svc.updateAdminUserPermissions(
      adminUid, permissions, reason.trim(), uid, name, rid(req)
    );
    res.json({ status: 'success', data });
  } catch (err) {
    handleSvcError(res, err);
  }
}

// ── Permission preview ────────────────────────────────────────────────────────

export async function previewPermissionChange(req: Request, res: Response): Promise<void> {
  try {
    const adminUid = String(req.params.adminUid ?? '').trim();
    if (!adminUid) { adminBadRequest(res, 'adminUid required'); return; }
    const { permissions } = req.body;
    if (!Array.isArray(permissions)) {
      adminValidationError(res, 'permissions must be an array of permission keys');
      return;
    }
    const data = await svc.previewPermissionChange(adminUid, permissions);
    res.json({ status: 'success', data });
  } catch (err) {
    handleSvcError(res, err);
  }
}

// ── Permission history ────────────────────────────────────────────────────────

export async function getPermissionHistory(req: Request, res: Response): Promise<void> {
  try {
    const adminUid = String(req.params.adminUid ?? '').trim();
    if (!adminUid) { adminBadRequest(res, 'adminUid required'); return; }
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    const data = await svc.getPermissionHistory(adminUid, Math.min(200, Math.max(1, limit)));
    res.json({ status: 'success', data });
  } catch (err) {
    handleSvcError(res, err);
  }
}

// ── Bootstrap Super Admin ─────────────────────────────────────────────────────

export async function bootstrapSuperAdmin(req: Request, res: Response): Promise<void> {
  try {
    const user = (req as any).user;
    const uid  = user?.uid;
    const email = user?.email ?? uid;
    const displayName = user?.name ?? user?.displayName ?? null;
    if (!uid) { adminBadRequest(res, 'User UID not found'); return; }
    const data = await svc.bootstrapSuperAdmin(uid, email, displayName, rid(req));
    res.json({ status: 'success', data });
  } catch (err) {
    handleSvcError(res, err);
  }
}
