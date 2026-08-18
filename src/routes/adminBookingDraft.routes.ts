import { Router } from 'express';
import verifyAuth from '../middleware/verifyAuth';
import verifyRoles from '../middleware/verifyRoles';
import { adminRateLimit } from '../middleware/adminRateLimit';
import { requirePermission } from '../middleware/requirePermission';
import * as ctrl from '../controllers/adminBookingDraftController';

const router = Router();
const adminOnly = [verifyAuth, verifyRoles([1]), adminRateLimit];

// Drafts are gated behind bookings.create — same permission as the wizard
router.post(
  '/admin/booking-drafts',
  ...adminOnly,
  requirePermission('bookings.create'),
  ctrl.createAdminBookingDraft
);

router.get(
  '/admin/booking-drafts',
  ...adminOnly,
  requirePermission('bookings.view'),
  ctrl.listAdminBookingDrafts
);

router.get(
  '/admin/booking-drafts/:draftId',
  ...adminOnly,
  requirePermission('bookings.create'),
  ctrl.getAdminBookingDraft
);

router.patch(
  '/admin/booking-drafts/:draftId',
  ...adminOnly,
  requirePermission('bookings.create'),
  ctrl.patchAdminBookingDraft
);

router.delete(
  '/admin/booking-drafts/:draftId',
  ...adminOnly,
  requirePermission('bookings.create'),
  ctrl.discardAdminBookingDraft
);

router.post(
  '/admin/booking-drafts/:draftId/convert',
  ...adminOnly,
  requirePermission('bookings.create'),
  ctrl.convertAdminBookingDraft
);

export default router;
