import { Router } from 'express';
import verifyAuth from '../middleware/verifyAuth';
import verifyRoles from '../middleware/verifyRoles';
import * as ctrl from '../controllers/adminAuditController';

const router = Router();
const adminOnly = [verifyAuth, verifyRoles([1])];

// Global audit log list
router.get('/admin/audit-logs',                              ...adminOnly, ctrl.listAuditLogs);

// Metric summary counts
router.get('/admin/audit-logs/summary',                      ...adminOnly, ctrl.getAuditSummary);

// Action registry for filter dropdowns
router.get('/admin/audit-logs/actions',                      ...adminOnly, ctrl.getAuditActions);

// Entity-scoped timeline
router.get('/admin/audit-logs/entity/:entityType/:entityId', ...adminOnly, ctrl.getEntityTimeline);

// Actor history
router.get('/admin/audit-logs/actor/:actorUid',              ...adminOnly, ctrl.getActorHistory);

// Single event detail (after named params to avoid conflicts)
router.get('/admin/audit-logs/:eventId',                     ...adminOnly, ctrl.getAuditEventDetail);

// Export
router.post('/admin/audit-logs/export',                      ...adminOnly, ctrl.exportAuditLogs);

export default router;
