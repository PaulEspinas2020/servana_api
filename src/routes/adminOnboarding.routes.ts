import { Router } from 'express';
import verifyAuth from '../middleware/verifyAuth';
import verifyRoles from '../middleware/verifyRoles';
import * as ctrl from '../controllers/adminOnboardingController';

const router = Router();
const adminOnly = [verifyAuth, verifyRoles([1])];

// ── Queue & Case List ─────────────────────────────────────────────────────────

router.get('/admin/provider-onboarding/queues', ...adminOnly, ctrl.getQueueSummary);
router.get('/admin/provider-onboarding/cases', ...adminOnly, ctrl.listCases);

// ── Reason Codes (no :caseId so must come before /:caseId routes) ─────────────

router.get('/admin/provider-onboarding/reason-codes', ...adminOnly, ctrl.getReasonCodes);

// ── Case Workspace ────────────────────────────────────────────────────────────

router.get('/admin/provider-onboarding/cases/:caseId', ...adminOnly, ctrl.getCaseDetail);
router.patch('/admin/provider-onboarding/cases/:caseId/assign', ...adminOnly, ctrl.assignCase);
router.patch('/admin/provider-onboarding/cases/:caseId/priority', ...adminOnly, ctrl.setPriority);
router.patch('/admin/provider-onboarding/cases/:caseId/move', ...adminOnly, ctrl.moveCase);
router.get('/admin/provider-onboarding/cases/:caseId/readiness', ...adminOnly, ctrl.getCaseReadiness);
router.post('/admin/provider-onboarding/cases/:caseId/final-approve', ...adminOnly, ctrl.finalApproveProvider);
router.post('/admin/provider-onboarding/cases/:caseId/final-reject', ...adminOnly, ctrl.finalRejectProvider);

// ── Timeline & Notes ──────────────────────────────────────────────────────────

router.get('/admin/provider-onboarding/cases/:caseId/timeline', ...adminOnly, ctrl.getTimeline);
router.get('/admin/provider-onboarding/cases/:caseId/notes', ...adminOnly, ctrl.getCaseNotes);
router.post('/admin/provider-onboarding/cases/:caseId/notes', ...adminOnly, ctrl.addCaseNote);

// ── Requirement Decisions ─────────────────────────────────────────────────────

router.post('/admin/provider-onboarding/requirements/:id/approve', ...adminOnly, ctrl.approveRequirement);
router.post('/admin/provider-onboarding/requirements/:id/reject', ...adminOnly, ctrl.rejectRequirement);
router.post('/admin/provider-onboarding/requirements/:id/request-resubmission', ...adminOnly, ctrl.requestResubmission);

export default router;
