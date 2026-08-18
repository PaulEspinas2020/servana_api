import express from 'express'
import { rateLimit } from 'express-rate-limit';
import { rateLimitBody } from '../helpers/rateLimitBody';
const router = express.Router()
import * as authController from '../controllers/auth.controller';
import verifyAuth from '../middleware/verifyAuth';
import verifyRoles from '../middleware/verifyRoles';
import * as provider from '../controllers/providerController';

/**
 * Password sign-in — a genuine brute-force target, so ten in fifteen minutes.
 *
 * Applies only to the two routes that actually receive a password. It used to
 * cover the token routes below as well; see `tokenExchangeLimiter` for why that
 * was wrong.
 */
const signInLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: rateLimitBody('Too many login attempts. Please try again in 15 minutes.'),
});

/**
 * Token exchange and refresh — deliberately NOT the sign-in limit.
 *
 * ## Why these routes must not share the sign-in budget
 *
 * `/auth/firebase-login`, `/auth/customer-firebase-login` and `/auth/refresh`
 * never receive a password. The caller presents a token whose signature is
 * verified, so there is nothing here to guess: the protection is the
 * verification, not a counter. A brute-force limit is the wrong instrument.
 *
 * Worse, `express-rate-limit` keeps one counter per limiter instance keyed by
 * client IP, so while these shared `signInLimiter` a customer spent the *same*
 * ten as password logins. Two things followed, both real:
 *
 *   - The customer web portal re-exchanged its session on every full page load,
 *     so ten reloads in a quarter of an hour told a customer they had made too
 *     many login attempts. They had made none. (Fixed portal-side too, by
 *     caching the exchanged session — but the limit was the cause.)
 *
 *   - `/auth/refresh` is redeemed by the live customer app when a stored token
 *     is near expiry, for everyone who signed in with email and password. The
 *     key is an IP, and Philippine carriers use carrier-grade NAT, so a handful
 *     of unrelated customers behind one public address could exhaust the budget
 *     between them. The eleventh gets 429, falls back to the stale token, the
 *     server answers 401, and the app signs them out — looking, from the
 *     outside, exactly like a random unreproducible bug.
 *
 * ## Why the cap is raised rather than keyed by uid
 *
 * The obvious fix is a `keyGenerator` on the account, as `workerCodeLimiter`
 * does. It cannot work here: these routes run before `verifyAuth`, so
 * `req.user` is not populated, and keying on an *unverified* token's subject
 * would let a caller choose their own bucket. Raising the cap on a route that
 * cannot be brute-forced achieves the same thing with no forgeable input.
 *
 * The cap is a cost ceiling, not a security control — it still stops a runaway
 * client or a crude flood from spending unbounded token-verification work.
 */
const tokenExchangeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: rateLimitBody('Too many requests. Please try again shortly.'),
});

const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: rateLimitBody('Too many password reset requests. Please try again in 1 hour.'),
});

const resetPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: rateLimitBody('Too many password reset attempts. Please try again in 1 hour.'),
});

const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: rateLimitBody('Too many OTP requests. Please try again in 10 minutes.'),
});

const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: rateLimitBody('Too many registration attempts. Please try again in 1 hour.'),
});

router.get("/auth/me", verifyAuth, provider.getMe);
router.post("/auth/signup", signupLimiter, authController.signup);
router.post("/auth/verify-email-otp", otpLimiter, authController.verifyEmailOtpController);
router.post("/auth/resend-email-otp", otpLimiter, authController.resendEmailOtpController);
router.post("/auth/signin", signInLimiter, authController.signin);
router.post("/auth/admin-signin", signInLimiter, authController.adminSignin);

// Unauthenticated by design: the caller is here BECAUSE their ID token expired,
// so requiring a valid one would be circular. The refresh token in the body is
// the credential and Google validates it.
//
// This used to share signInLimiter, reasoned as "a refresh-token guessing
// attempt is a sign-in attempt by another name". That reasoning does not hold:
// a password is low-entropy and human-chosen, which is exactly why ten attempts
// is a meaningful bound, whereas a Google refresh token is a high-entropy random
// string. Ten guesses and two hundred are equally hopeless against it, so the
// tight limit bought no security here — and it cost real customers their
// session, because the key is a NAT-shared IP. See tokenExchangeLimiter.
router.post("/auth/refresh", tokenExchangeLimiter, authController.refreshTokenController);
router.get("/auth/resendverification", otpLimiter, authController.resendVerification);
router.post("/auth/firebase-login", tokenExchangeLimiter, authController.firebaseAuthLoginController);
router.post("/auth/customer-firebase-login", tokenExchangeLimiter, authController.customerFirebaseLoginController);
router.post("/auth/provider/register", signupLimiter, authController.providerRegisterController);
router.post("/auth/add-employees", verifyAuth, verifyRoles([1]), authController.addEmployeesController);
router.patch("/auth/employees/:uid", verifyAuth, verifyRoles([1]), authController.updateEmployeeController);
router.post("/auth/forgot-password", forgotPasswordLimiter, authController.forgotPasswordController);
router.post("/auth/reset-password", resetPasswordLimiter, authController.resetPasswordController);
router.post("/auth/logout", verifyAuth, authController.logoutController);

export default router;
