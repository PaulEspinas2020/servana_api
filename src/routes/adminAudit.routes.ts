import { Router } from 'express';
import verifyAuth from '../middleware/verifyAuth';
import verifyRoles from '../middleware/verifyRoles';
import { adminRateLimit } from '../middleware/adminRateLimit';
import { requirePermission } from '../middleware/requirePermission';
import * as ctrl from '../controllers/adminAuditController';

const router = Router();
const adminOnly = [verifyAuth, verifyRoles([1]), adminRateLimit];

// Global audit log list
router.get('/admin/audit-logs',                              ...adminOnly, requirePermission('audit_logs.view'), ctrl.listAuditLogs);

// Metric summary counts
router.get('/admin/audit-logs/summary',                      ...adminOnly, requirePermission('audit_logs.view'), ctrl.getAuditSummary);

// Action registry for filter dropdowns
router.get('/admin/audit-logs/actions',                      ...adminOnly, requirePermission('audit_logs.view'), ctrl.getAuditActions);

// Entity-scoped timeline
router.get('/admin/audit-logs/entity/:entityType/:entityId', ...adminOnly, requirePermission('audit_logs.entity_timeline.view'), ctrl.getEntityTimeline);

// Actor history
router.get('/admin/audit-logs/actor/:actorUid',              ...adminOnly, requirePermission('audit_logs.actor_history.view'), ctrl.getActorHistory);

// Single event detail (after named params to avoid conflicts)
router.get('/admin/audit-logs/:eventId',                     ...adminOnly, requirePermission('audit_logs.details.view'), ctrl.getAuditEventDetail);

// Export
router.post('/admin/audit-logs/export',                      ...adminOnly, requirePermission('audit_logs.export'), ctrl.exportAuditLogs);

export default router;
