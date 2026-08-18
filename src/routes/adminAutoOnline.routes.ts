import { Router } from 'express';
import verifyAuth from '../middleware/verifyAuth';
import verifyRoles from '../middleware/verifyRoles';
import { adminRateLimit } from '../middleware/adminRateLimit';
import { requirePermission } from '../middleware/requirePermission';
import * as ctrl from '../controllers/adminAutoOnlineController';

const router = Router();
const adminOnly = [verifyAuth, verifyRoles([1]), adminRateLimit];

// Per-provider auto-online readiness
// GET  /api/admin/providers/:uid/auto-online/readiness
// POST /api/admin/providers/:uid/auto-online/re-evaluate
// POST /api/admin/providers/:uid/auto-online/disable
// POST /api/admin/providers/:uid/auto-online/enable-override
router.get('/admin/providers/:uid/auto-online/readiness',        ...adminOnly, requirePermission('auto_online.readiness.view'), ctrl.getReadiness);
router.post('/admin/providers/:uid/auto-online/re-evaluate',     ...adminOnly, requirePermission('auto_online.reevaluate'), ctrl.reEvaluate);
router.post('/admin/providers/:uid/auto-online/disable',         ...adminOnly, requirePermission('auto_online.disable'), ctrl.disableAutoOnline);
router.post('/admin/providers/:uid/auto-online/enable-override', ...adminOnly, requirePermission('auto_online.enable_override'), ctrl.enableOverride);

// Global auto-online summary, blockers, and backfill
// GET  /api/admin/auto-online/summary
// GET  /api/admin/auto-online/blockers
// GET  /api/admin/auto-online/backfill-preview
// POST /api/admin/auto-online/backfill-apply
router.get('/admin/auto-online/summary',          ...adminOnly, requirePermission('auto_online.view'), ctrl.getSummary);
router.get('/admin/auto-online/blockers',         ...adminOnly, requirePermission('auto_online.view'), ctrl.getBlockers);
router.get('/admin/auto-online/backfill-preview', ...adminOnly, requirePermission('auto_online.backfill_preview'), ctrl.backfillPreview);
router.post('/admin/auto-online/backfill-apply',  ...adminOnly, requirePermission('auto_online.backfill_apply'), ctrl.backfillApply);

export default router;
