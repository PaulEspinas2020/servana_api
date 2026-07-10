import { Router } from 'express';
import verifyAuth from '../middleware/verifyAuth';
import verifyRoles from '../middleware/verifyRoles';
import * as ctrl from '../controllers/adminBookingController';

const router = Router();
const adminOnly = [verifyAuth, verifyRoles([1])];

// IMPORTANT: /metrics must be registered BEFORE /:id to prevent Express matching it as a booking ID
router.get('/admin/bookings/metrics', ...adminOnly, ctrl.getMetrics);

router.get('/admin/bookings', ...adminOnly, ctrl.listBookings);
router.get('/admin/bookings/:id', ...adminOnly, ctrl.getBookingDetail);

router.get('/admin/bookings/:id/timeline', ...adminOnly, ctrl.getTimeline);
router.get('/admin/bookings/:id/notes', ...adminOnly, ctrl.getNotes);
router.post('/admin/bookings/:id/notes', ...adminOnly, ctrl.addNote);

router.get('/admin/bookings/:id/assignment-candidates', ...adminOnly, ctrl.getCandidates);

router.post('/admin/bookings/:id/assign', ...adminOnly, ctrl.assignProvider);
router.post('/admin/bookings/:id/reassign', ...adminOnly, ctrl.reassignProvider);
router.post('/admin/bookings/:id/reschedule', ...adminOnly, ctrl.rescheduleBooking);
router.post('/admin/bookings/:id/cancel', ...adminOnly, ctrl.cancelBooking);
router.post('/admin/bookings/:id/escalate', ...adminOnly, ctrl.escalateBooking);
router.post('/admin/bookings/:id/approve-completion', ...adminOnly, ctrl.approveCompletion);

export default router;
