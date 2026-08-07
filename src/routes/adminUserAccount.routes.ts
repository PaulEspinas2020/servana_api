import { Router } from 'express';
import verifyAuth from '../middleware/verifyAuth';
import verifyRoles from '../middleware/verifyRoles';
import { requirePermission } from '../middleware/requirePermission';
import * as ctrl from '../controllers/adminUserAccountController';

const router = Router();
const adminOnly = [verifyAuth, verifyRoles([1])];

router.get('/admin/users', ...adminOnly, requirePermission('users.view'), ctrl.listUsers);
router.patch('/admin/users/:uid/archive', ...adminOnly, requirePermission('users.archive'), ctrl.setUserArchive);

export default router;
