import express from 'express'
import { rateLimit } from 'express-rate-limit';
const router = express.Router()
import * as authController from '../controllers/auth.controller';
import verifyAuth from '../middleware/verifyAuth';
import verifyRoles from '../middleware/verifyRoles';
import * as provider from '../controllers/providerController';

const signInLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 'error', message: 'Too many login attempts. Please try again in 15 minutes.' },
});

const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 'error', message: 'Too many password reset requests. Please try again in 1 hour.' },
});

const resetPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 'error', message: 'Too many password reset attempts. Please try again in 1 hour.' },
});

const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 'error', message: 'Too many OTP requests. Please try again in 10 minutes.' },
});

router.get("/auth/me", verifyAuth, provider.getMe);
router.post("/auth/signup", authController.signup);
router.post("/auth/verify-email-otp", authController.verifyEmailOtpController);
router.post("/auth/resend-email-otp", otpLimiter, authController.resendEmailOtpController);
router.post("/auth/signin", signInLimiter, authController.signin);
router.get("/auth/resendverification", otpLimiter, authController.resendVerification);
router.post("/auth/firebase-login", authController.firebaseAuthLoginController);
router.post("/auth/provider/register", authController.providerRegisterController);
router.post("/auth/add-employees", verifyAuth, verifyRoles([1]), authController.addEmployeesController);
router.patch("/auth/employees/:uid", verifyAuth, verifyRoles([1]), authController.updateEmployeeController);
router.post("/auth/forgot-password", forgotPasswordLimiter, authController.forgotPasswordController);
router.post("/auth/reset-password", resetPasswordLimiter, authController.resetPasswordController);
router.post("/auth/logout", verifyAuth, authController.logoutController);

export default router;
