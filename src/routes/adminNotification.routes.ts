import { Router } from 'express';
import verifyAuth from '../middleware/verifyAuth';
import verifyRoles from '../middleware/verifyRoles';
import * as controller from '../controllers/adminNotificationController';

const router = Router();
const adminOnly = [verifyAuth, verifyRoles([1])];
router.get('/admin/notifications', ...adminOnly, controller.list);
router.patch('/admin/notifications/read-all', ...adminOnly, controller.readAll);
router.patch('/admin/notifications/:id/read', ...adminOnly, controller.read);
export default router;
