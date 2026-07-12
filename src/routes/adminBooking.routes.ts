import { Router } from 'express';
import verifyAuth from '../middleware/verifyAuth';
import verifyRoles from '../middleware/verifyRoles';
import { requirePermission } from '../middleware/requirePermission';
import * as ctrl from '../controllers/adminBookingController';

const router = Router();
const adminOnly = [verifyAuth, verifyRoles([1])];

// IMPORTANT: /metrics must be registered BEFORE /:id to prevent Express matching it as a booking ID
router.get('/admin/bookings/metrics', ...adminOnly, requirePermission('bookings.view'), ctrl.getMetrics);

router.get('/admin/bookings',      ...adminOnly, requirePermission('bookings.view'), ctrl.listBookings);
router.get('/admin/bookings/:id',  ...adminOnly, requirePermission('bookings.details.view'), ctrl.getBookingDetail);

router.get('/admin/bookings/:id/timeline', ...adminOnly, requirePermission('bookings.timeline.view'), ctrl.getTimeline);
router.get('/admin/bookings/:id/notes',    ...adminOnly, requirePermission('bookings.details.view'), ctrl.getNotes);
router.post('/admin/bookings/:id/notes',   ...adminOnly, requirePermission('bookings.notes.add'), ctrl.addNote);

router.get('/admin/bookings/:id/assignment-candidates', ...adminOnly, requirePermission('bookings.assign_provider'), ctrl.getCandidates);

router.post('/admin/bookings/:id/assign',                       ...adminOnly, requirePermission('bookings.assign_provider'),       ctrl.assignProvider);
router.post('/admin/bookings/:id/reassign',                     ...adminOnly, requirePermission('bookings.reassign_provider'),    ctrl.reassignProvider);
router.post('/admin/bookings/:id/confirm-provider-assignment',  ...adminOnly, requirePermission('bookings.confirm_on_behalf'),    ctrl.confirmProviderAssignment);
router.post('/admin/bookings/:id/reschedule',        ...adminOnly, requirePermission('bookings.reschedule'), ctrl.rescheduleBooking);
router.post('/admin/bookings/:id/cancel',            ...adminOnly, requirePermission('bookings.cancel'), ctrl.cancelBooking);
router.post('/admin/bookings/:id/escalate',          ...adminOnly, requirePermission('bookings.escalate'), ctrl.escalateBooking);
router.post('/admin/bookings/:id/approve-completion',...adminOnly, requirePermission('bookings.approve_completion'), ctrl.approveCompletion);

export default router;
