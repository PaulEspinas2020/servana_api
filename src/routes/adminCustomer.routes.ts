import { Router } from 'express';
import verifyAuth from '../middleware/verifyAuth';
import verifyRoles from '../middleware/verifyRoles';
import { requirePermission } from '../middleware/requirePermission';
import * as ctrl from '../controllers/adminGuestController';

const router = Router();
const adminOnly = [verifyAuth, verifyRoles([1])];

// IMPORTANT: static sub-paths must be registered BEFORE /:guestId routes

// Unified customer list (clients + guests)
router.get('/admin/customers',         ...adminOnly, requirePermission('customers.read'),         ctrl.listAllCustomers);
router.get('/admin/customers/metrics', ...adminOnly, requirePermission('customers.read'),         ctrl.getCustomerMetrics);

// Client-specific endpoints
router.get('/admin/customers/clients/:identityId', ...adminOnly, requirePermission('customers.read'), ctrl.getClientDetail);
router.get('/admin/customers/clients/:identityId/addresses', ...adminOnly, requirePermission('customers.addresses.view'), ctrl.getClientAddresses);

// Guest-specific endpoints
router.get('/admin/customers/guests',                   ...adminOnly, requirePermission('customers.read_guests'),         ctrl.listGuests);
router.get('/admin/customers/guests/:guestId',          ...adminOnly, requirePermission('customers.read_guests'),         ctrl.getGuestDetail);
router.get('/admin/customers/guests/:guestId/bookings', ...adminOnly, requirePermission('customers.read_guests'),         ctrl.getGuestBookings);

router.patch('/admin/customers/guests/:guestId',             ...adminOnly, requirePermission('customers.edit_guest'),       ctrl.updateGuest);
router.post('/admin/customers/guests/:guestId/link-client',  ...adminOnly, requirePermission('customers.link_guest_client'), ctrl.linkGuestToClient);

export default router;
