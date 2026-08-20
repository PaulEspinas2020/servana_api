import { Router } from 'express';
import verifyAuth  from '../middleware/verifyAuth';
import verifyRoles from '../middleware/verifyRoles';
import { adminRateLimit } from '../middleware/adminRateLimit';
import { requirePermission } from '../middleware/requirePermission';
import * as ctrl   from '../controllers/adminProviderAvailabilityController';

const router   = Router();
const adminOnly = [verifyAuth, verifyRoles([1]), adminRateLimit];

// GET  /api/admin/provider-availability/summary
// GET  /api/admin/provider-availability/supply-gaps
// GET  /api/admin/provider-availability/missing-setup
// POST /api/admin/provider-availability/evaluate-booking
router.get('/admin/provider-availability/summary',          ...adminOnly, requirePermission('provider_availability.view'), ctrl.getSupplySummary);
router.get('/admin/provider-availability/supply-gaps',      ...adminOnly, requirePermission('provider_supply_gaps.view'), ctrl.getSupplyGaps);
router.get('/admin/provider-availability/missing-setup',    ...adminOnly, requirePermission('provider_availability.view'), ctrl.getMissingSetup);
router.post('/admin/provider-availability/evaluate-booking',...adminOnly, requirePermission('provider_eligibility.preview'), ctrl.evaluateBooking);

export default router;
