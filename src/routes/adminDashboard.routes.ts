import { Router } from 'express';
import verifyAuth from '../middleware/verifyAuth';
import verifyRoles from '../middleware/verifyRoles';
import { requirePermission } from '../middleware/requirePermission';
import * as ctrl from '../controllers/adminDashboardController';

const router = Router();
const adminOnly = [verifyAuth, verifyRoles([1])];

// GET /api/admin/dashboard/operations
// Returns full Admin Operations Dashboard (snapshot, pipeline, provider health, etc.)
router.get('/admin/dashboard/operations', ...adminOnly, requirePermission('dashboard.view'), ctrl.getOperations);

export default router;
