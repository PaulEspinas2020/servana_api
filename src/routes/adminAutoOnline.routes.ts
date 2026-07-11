import { Router } from 'express';
import verifyAuth from '../middleware/verifyAuth';
import verifyRoles from '../middleware/verifyRoles';
import * as ctrl from '../controllers/adminAutoOnlineController';

const router = Router();
const adminOnly = [verifyAuth, verifyRoles([1])];

// Per-provider auto-online readiness
// GET  /api/admin/providers/:uid/auto-online/readiness
// POST /api/admin/providers/:uid/auto-online/re-evaluate
// POST /api/admin/providers/:uid/auto-online/disable
// POST /api/admin/providers/:uid/auto-online/enable-override
router.get('/admin/providers/:uid/auto-online/readiness',      ...adminOnly, ctrl.getReadiness);
router.post('/admin/providers/:uid/auto-online/re-evaluate',   ...adminOnly, ctrl.reEvaluate);
router.post('/admin/providers/:uid/auto-online/disable',       ...adminOnly, ctrl.disableAutoOnline);
router.post('/admin/providers/:uid/auto-online/enable-override', ...adminOnly, ctrl.enableOverride);

// Global auto-online summary, blockers, and backfill
// GET  /api/admin/auto-online/summary
// GET  /api/admin/auto-online/blockers
// GET  /api/admin/auto-online/backfill-preview
// POST /api/admin/auto-online/backfill-apply
router.get('/admin/auto-online/summary',          ...adminOnly, ctrl.getSummary);
router.get('/admin/auto-online/blockers',         ...adminOnly, ctrl.getBlockers);
router.get('/admin/auto-online/backfill-preview', ...adminOnly, ctrl.backfillPreview);
router.post('/admin/auto-online/backfill-apply',  ...adminOnly, ctrl.backfillApply);

export default router;
