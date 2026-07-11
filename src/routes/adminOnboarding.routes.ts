import { Router } from 'express';
import verifyAuth from '../middleware/verifyAuth';
import verifyRoles from '../middleware/verifyRoles';
import { requirePermission } from '../middleware/requirePermission';
import * as ctrl from '../controllers/adminOnboardingController';

const router = Router();
const adminOnly = [verifyAuth, verifyRoles([1])];

// ── Queue & Case List ─────────────────────────────────────────────────────────

router.get('/admin/provider-onboarding/queues', ...adminOnly, requirePermission('onboarding.view'), ctrl.getQueueSummary);
router.get('/admin/provider-onboarding/cases',  ...adminOnly, requirePermission('onboarding.view'), ctrl.listCases);

// ── Reason Codes (no :caseId so must come before /:caseId routes) ─────────────

router.get('/admin/provider-onboarding/reason-codes', ...adminOnly, requirePermission('onboarding.view'), ctrl.getReasonCodes);

// ── Case Workspace ────────────────────────────────────────────────────────────

router.get('/admin/provider-onboarding/cases/:caseId',           ...adminOnly, requirePermission('onboarding.case.view'), ctrl.getCaseDetail);
router.patch('/admin/provider-onboarding/cases/:caseId/assign',  ...adminOnly, requirePermission('onboarding.case.assign'), ctrl.assignCase);
router.patch('/admin/provider-onboarding/cases/:caseId/priority',...adminOnly, requirePermission('onboarding.priority.change'), ctrl.setPriority);
router.patch('/admin/provider-onboarding/cases/:caseId/move',    ...adminOnly, requirePermission('onboarding.status.move'), ctrl.moveCase);
router.get('/admin/provider-onboarding/cases/:caseId/readiness', ...adminOnly, requirePermission('onboarding.readiness.run'), ctrl.getCaseReadiness);
router.post('/admin/provider-onboarding/cases/:caseId/final-approve', ...adminOnly, requirePermission('onboarding.final_approve'), ctrl.finalApproveProvider);
router.post('/admin/provider-onboarding/cases/:caseId/final-reject',  ...adminOnly, requirePermission('onboarding.final_reject'), ctrl.finalRejectProvider);

// ── Timeline & Notes ──────────────────────────────────────────────────────────

router.get('/admin/provider-onboarding/cases/:caseId/timeline', ...adminOnly, requirePermission('onboarding.timeline.view'), ctrl.getTimeline);
router.get('/admin/provider-onboarding/cases/:caseId/notes',    ...adminOnly, requirePermission('onboarding.case.view'), ctrl.getCaseNotes);
router.post('/admin/provider-onboarding/cases/:caseId/notes',   ...adminOnly, requirePermission('onboarding.notes.add'), ctrl.addCaseNote);

// ── Requirement Decisions ─────────────────────────────────────────────────────

router.post('/admin/provider-onboarding/requirements/:id/approve',             ...adminOnly, requirePermission('onboarding.requirement.approve'), ctrl.approveRequirement);
router.post('/admin/provider-onboarding/requirements/:id/reject',              ...adminOnly, requirePermission('onboarding.requirement.reject'), ctrl.rejectRequirement);
router.post('/admin/provider-onboarding/requirements/:id/request-resubmission',...adminOnly, requirePermission('onboarding.requirement.request_resubmission'), ctrl.requestResubmission);

export default router;
