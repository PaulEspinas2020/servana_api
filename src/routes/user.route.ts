import express from 'express'
const router = express.Router()
import * as userController from '../controllers/user.controller';
import verifyAuth from '../middleware/verifyAuth';
import verifyRoles from '../middleware/verifyRoles';

router.get("/user/registereduser", verifyAuth, verifyRoles([1]), userController.userList);

// verifyAuth (no role guard): service layer scopes by role — admin gets all customer
// addresses, role 2/3 gets only their own. verifyRoles([1]) was incorrect here because
// ServanaClient (role 3) calls this endpoint to list the customer's own addresses.
router.get("/user/alluseraddresses", verifyAuth, userController.getAllAddressesOfUser);
// Hard auth — same anonymous-bypass shape as the booking routes. Saved home
// addresses are among the most sensitive data we hold (§58), and the only
// caller is the provider web portal, which sends a Bearer token on every
// request via its AuthorizeInterceptor.
router.get("/user/:userId/addresses", verifyAuth, userController.getAddressesByUserId);
router.post("/user/adduseraddress", verifyAuth, userController.addUserAddress);
router.get("/user/getaddressbyid", verifyAuth, userController.getAddressByAddressId);

router.get("/user/profile", verifyAuth, userController.getUserProfile);
router.put("/user/updateprofile", verifyAuth, userController.updateUserProfile);
router.put("/user/makeaddressprimary", verifyAuth, userController.makeAddressPrimary);

router.delete("/user/deleteaddress", verifyAuth, userController.deleteAddress);

// archiveUser is an admin-only operation; the broken :userId param issue is fixed here
// by keeping the route as-is but adding the role guard so only admin can call it.
router.put("/user/archive", verifyAuth, verifyRoles([1]), userController.archiveUser);

// ─── FCM token management ────────────────────────────────────────────────────
router.post("/user/fcm-token", verifyAuth, userController.registerFcmToken);
router.delete("/user/fcm-token", verifyAuth, userController.clearCustomerFcmToken);

// ─── Customer notifications ──────────────────────────────────────────────────
// Named routes BEFORE wildcard param routes to prevent Express matching e.g.
// "unread-count" as a notification key.
router.get("/user/notifications/unread-count", verifyAuth, userController.countCustomerUnreadHandler);
router.post("/user/notifications/mark-all-read", verifyAuth, userController.markAllCustomerNotificationsReadHandler);
router.get("/user/notifications", verifyAuth, userController.listCustomerNotificationsHandler);
router.patch("/user/notifications/:key/read", verifyAuth, userController.markCustomerNotificationReadHandler);
router.delete("/user/notifications/:key", verifyAuth, userController.deleteCustomerNotificationHandler);

export default router;
