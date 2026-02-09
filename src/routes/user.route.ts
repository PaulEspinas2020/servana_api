import express from 'express'
const router = express.Router()
import * as userController from '../controllers/user.controller';
import verifyAuth from '../middleware/verifyAuth';

router.get("/user/registereduser", userController.userList);

router.get("/user/alluseraddresses", verifyAuth, userController.getAllAddressesOfUser);
router.post("/user/adduseraddress", verifyAuth, userController.addUserAddress);
router.get("/user/getaddressbyid", verifyAuth, userController.getAddressByAddressId);

router.get("/user/profile", verifyAuth, userController.getUserProfile);
router.put("/user/updateprofile", verifyAuth, userController.updateUserProfile);
router.put("/user/makeaddressprimary", verifyAuth, userController.makeAddressPrimary);

router.delete("/user/deleteaddress", verifyAuth, userController.deleteAddress);

router.put("/user/archive", verifyAuth, userController.archiveUser);

export default router;
