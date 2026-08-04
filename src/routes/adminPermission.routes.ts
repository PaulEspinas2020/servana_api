import express from 'express';
import verifyAuth from '../middleware/verifyAuth';
import verifyRoles from '../middleware/verifyRoles';
import { requirePermission, requireSuperAdmin } from '../middleware/requirePermission';
import * as ctrl from '../controllers/adminPermissionController';

const router = express.Router();
const adminOnly = [verifyAuth, verifyRoles([1])];

// ── Own permissions (no permission check — every admin can call this) ─────────
router.get('/admin/me/permissions', verifyAuth, ctrl.getMyPermissions);

// ── Permission definitions (all admins can view) ──────────────────────────────
router.get('/admin/permission-definitions', ...adminOnly, ctrl.getPermissionDefinitions);

// ── Admin user list ───────────────────────────────────────────────────────────
router.get('/admin/admin-users',
  ...adminOnly, requirePermission('admin_users.view'), ctrl.listAdminUsers);

// ── Create admin user (Super Admin only) ──────────────────────────────────────
router.post('/admin/admin-users',
  ...adminOnly, requireSuperAdmin, ctrl.createAdminUser);

// ── Invite an admin by EMAIL (Super Admin only) ───────────────────────────────
// Same authorization as create: only a Super Admin may grant admin access. The
// difference is only that this one does not demand a Firebase UID up front.
router.post('/admin/admin-users/invite',
  ...adminOnly, requireSuperAdmin, ctrl.inviteAdminUser);

router.post('/admin/admin-users/:adminUid/resend-invite',
  ...adminOnly, requireSuperAdmin, ctrl.resendAdminInvite);

// ── Bootstrap Super Admin (any authenticated user; service enforces first-caller-wins) ───
router.post('/admin/admin-users/bootstrap-super-admin',
  verifyAuth, ctrl.bootstrapSuperAdmin);

// ── Admin user detail ─────────────────────────────────────────────────────────
router.get('/admin/admin-users/:adminUid',
  ...adminOnly, requirePermission('admin_users.view'), ctrl.getAdminUserById);

// ── Update admin user (Super Admin only) ─────────────────────────────────────
router.patch('/admin/admin-users/:adminUid',
  ...adminOnly, requireSuperAdmin, ctrl.updateAdminUser);

// ── Update admin user status (Super Admin only) ───────────────────────────────
router.patch('/admin/admin-users/:adminUid/status',
  ...adminOnly, requireSuperAdmin, ctrl.updateAdminUserStatus);

// ── Get admin user permissions (Super Admin only) ─────────────────────────────
router.get('/admin/admin-users/:adminUid/permissions',
  ...adminOnly, requireSuperAdmin, ctrl.getAdminUserPermissions);

// ── Update admin user permissions (Super Admin only) ─────────────────────────
router.patch('/admin/admin-users/:adminUid/permissions',
  ...adminOnly, requireSuperAdmin, ctrl.updateAdminUserPermissions);

// ── Permission history (Super Admin only) ─────────────────────────────────────
router.get('/admin/admin-users/:adminUid/permission-history',
  ...adminOnly, requireSuperAdmin, ctrl.getPermissionHistory);

// ── Preview permission change (Super Admin only) ──────────────────────────────
router.post('/admin/admin-users/:adminUid/permissions/preview',
  ...adminOnly, requireSuperAdmin, ctrl.previewPermissionChange);

export default router;
