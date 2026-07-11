import { Router } from 'express';
import verifyAuth  from '../middleware/verifyAuth';
import verifyRoles from '../middleware/verifyRoles';
import * as ctrl   from '../controllers/adminProviderAvailabilityController';

const router   = Router();
const adminOnly = [verifyAuth, verifyRoles([1])];

// GET  /api/admin/provider-availability/summary
// GET  /api/admin/provider-availability/supply-gaps
// GET  /api/admin/provider-availability/missing-setup
// POST /api/admin/provider-availability/evaluate-booking
router.get('/admin/provider-availability/summary',          ...adminOnly, ctrl.getSupplySummary);
router.get('/admin/provider-availability/supply-gaps',      ...adminOnly, ctrl.getSupplyGaps);
router.get('/admin/provider-availability/missing-setup',    ...adminOnly, ctrl.getMissingSetup);
router.post('/admin/provider-availability/evaluate-booking',...adminOnly, ctrl.evaluateBooking);

export default router;
