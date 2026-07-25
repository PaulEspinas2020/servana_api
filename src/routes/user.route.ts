import express from 'express'
const router = express.Router()
import * as userController from '../controllers/user.controller';
import verifyAuth from '../middleware/verifyAuth';
import verifyRoles from '../middleware/verifyRoles';
import verifyAuthOptional from '../middleware/verifyAuthOptional';

router.get("/user/registereduser", verifyAuth, verifyRoles([1]), userController.userList);

router.get("/user/alluseraddresses", verifyAuth, verifyRoles([1]), userController.getAllAddressesOfUser);
// verifyAuthOptional: mobile may call without token; when JWT is present, controller scopes to JWT uid
router.get("/user/:userId/addresses", verifyAuthOptional, userController.getAddressesByUserId);
router.post("/user/adduseraddress", verifyAuth, userController.addUserAddress);
router.get("/user/getaddressbyid", verifyAuth, userController.getAddressByAddressId);

router.get("/user/profile", verifyAuth, userController.getUserProfile);
router.put("/user/updateprofile", verifyAuth, userController.updateUserProfile);
router.put("/user/makeaddressprimary", verifyAuth, userController.makeAddressPrimary);

router.delete("/user/deleteaddress", verifyAuth, userController.deleteAddress);

// archiveUser is an admin-only operation; the broken :userId param issue is fixed here
// by keeping the route as-is but adding the role guard so only admin can call it.
router.put("/user/archive", verifyAuth, verifyRoles([1]), userController.archiveUser);

export default router;
