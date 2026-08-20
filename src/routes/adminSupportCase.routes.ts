import { Router } from 'express';
import verifyAuth from '../middleware/verifyAuth';
import verifyRoles from '../middleware/verifyRoles';
import { adminRateLimit } from '../middleware/adminRateLimit';
import { requirePermission } from '../middleware/requirePermission';
import * as ctrl from '../controllers/adminSupportCaseController';

const router = Router();
const adminOnly = [verifyAuth, verifyRoles([1]), adminRateLimit];

router.get('/admin/support/cases', ...adminOnly, requirePermission('support.cases.view'), ctrl.list);
router.post('/admin/support/cases/sla-sweep', ...adminOnly, requirePermission('support.sla.manage'), ctrl.sweepSla);
router.get('/admin/support/cases/:caseId', ...adminOnly, requirePermission('support.cases.view'), ctrl.detail);
router.post('/admin/support/cases/:caseId/messages', ...adminOnly, requirePermission('support.cases.reply'), ctrl.reply);
router.post('/admin/support/cases/:caseId/internal-notes', ...adminOnly, requirePermission('support.cases.internal_notes'), ctrl.note);
router.patch('/admin/support/cases/:caseId/state', ...adminOnly, requirePermission('support.cases.transition'), ctrl.transition);
router.post('/admin/support/cases/:caseId/escalations', ...adminOnly, requirePermission('support.cases.escalate'), ctrl.escalate);
router.post('/admin/support/cases/:caseId/resolutions', ...adminOnly, requirePermission('support.cases.resolve'), ctrl.resolve);
router.patch('/admin/support/cases/:caseId/appeals/:appealId', ...adminOnly, requirePermission('support.appeals.decide'), ctrl.decideAppeal);
router.get('/admin/support/cases/:caseId/attachments/:attachmentId/preview', ...adminOnly, requirePermission('support.evidence.sensitive.view'), ctrl.preview);

export default router;
