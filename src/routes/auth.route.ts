import express from 'express'
const router = express.Router()
import * as authController from '../controllers/auth.controller';
import verifyAuth from '../middleware/verifyAuth';
import verifyRoles from '../middleware/verifyRoles';
import * as provider from '../controllers/providerController';
import * as phoneOtp from '../controllers/phoneOtpController';

router.get("/auth/me", verifyAuth, provider.getMe);
router.post("/auth/provider/request-otp", phoneOtp.requestOtp);
router.post("/auth/provider/verify-otp", phoneOtp.verifyOtp);
router.post("/auth/signup", authController.signup);
router.post("/auth/verify-email-otp", authController.verifyEmailOtpController);
router.post("/auth/resend-email-otp", authController.resendEmailOtpController);
router.post("/auth/signin", authController.signin);
router.get("/auth/resendverification", authController.resendVerification);
router.post("/auth/firebase-login", authController.firebaseAuthLoginController);
router.post("/auth/provider/register", authController.providerRegisterController);
router.post("/auth/add-employees", verifyAuth, verifyRoles([1]), authController.addEmployeesController);
router.patch("/auth/employees/:uid", verifyAuth, verifyRoles([1]), authController.updateEmployeeController);
router.post("/auth/forgot-password", authController.forgotPasswordController);
router.post("/auth/reset-password", authController.resetPasswordController);
router.post("/auth/logout", verifyAuth, authController.logoutController);

export default router;
