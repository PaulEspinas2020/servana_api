import express from 'express'
const router = express.Router()
import * as authController from '../controllers/auth.controller';

router.post("/auth/signup", authController.signup);
router.post("/auth/verify-email-otp", authController.verifyEmailOtpController);
router.post("/auth/resend-email-otp", authController.resendEmailOtpController);
router.post("/auth/signin", authController.signin);
router.get("/auth/resendverification", authController.resendVerification);
router.post("/auth/firebase-login", authController.firebaseAuthLoginController);
router.post("/auth/add-employees", authController.addEmployeesController);
router.patch("/auth/employees/:uid", authController.updateEmployeeController);
router.post("/auth/forgot-password", authController.forgotPasswordController);
router.post("/auth/reset-password", authController.resetPasswordController);

export default router;
