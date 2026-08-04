import { Request, Response, NextFunction } from "express";
import { status } from "../helpers/status";
import * as authService from "../services/auth.service";
import * as firebaseFunction from "../services/firebaseFunctions.service";
import { upsertSourceAttribution } from "../services/providerOnboardingService";
import * as autoOnlineEngine from "../services/providerAutoOnlineEngine";
import { touchProviderActivity } from "../services/adminProviderService";
import { clearFcmToken } from "../services/notification.service";
import { refreshIdToken, TokenRefreshError } from '../services/tokenRefreshService';
import { sendAuthError } from "../errors/authErrors";
import { continueUrlFor } from "../constants/platformContinueUrls";

const signin = async (req: Request, res: Response) => {
    const { email, password, fcmToken } = req.body;
    try {
        const dbResponse = await authService.loggedInUser(email, password);

        // TODO save fcm
        if (fcmToken) {
            await authService.updateFcmToken(dbResponse.id, fcmToken);
        }

        // Inline the response to avoid the module-level successMessage singleton
        // which is a race condition under concurrent requests (Request A sets data,
        // Request B overwrites it before A's res.send fires).
        return res.status(200).json({ status: 'success', data: dbResponse });
    } catch (error: any) {
        if ((error as any)?.statusCode === 401 || error?.message === 'Invalid email or password.') {
            return sendAuthError(res, "INVALID_CREDENTIALS");
        }
        if ((error as any)?.statusCode === 403) {
            // Not an authentication failure: the credential was correct. Routing
            // this to a login screen is what makes people retype a password that
            // was never the problem.
            return sendAuthError(res, "IDENTIFIER_NOT_VERIFIED", error?.message || 'Email not verified.');
        }
        const msg = typeof error === 'string' ? error : error?.message;
        if (msg && (msg.includes('valid Email') || msg.includes('valid Password') || msg.includes('valid email'))) {
            return res.status(400).json({ status: 'error', message: 'Please enter a valid email and password.' });
        }
        return res.status(500).json({ status: "failed", message: 'An unexpected error occurred. Please try again.' });
    }
};

const signup = async (req: Request, res: Response) => {
    try {
        const dbResponse = await authService.registerUser(req.body);
        // Inline response — avoid singleton successMessage race condition under concurrent requests.
        // Only forward known safe string error messages; never expose Error objects (may contain Firebase internals).
        return res.status(200).json({
            status: 'success',
            data: {
                success: true,
                userId: (dbResponse as any).dbRegister?.uid || null,
                message: (dbResponse as any).message,
            },
        });
    } catch (error: any) {
        const safeMsg = typeof error === 'string'
            ? error
            : 'Registration failed. Please try again.';
        return res.status(400).json({ status: 'error', message: safeMsg });
    }
};

const verifyEmailOtpController = async (req: Request, res: Response) => {
    try {
        const result = await authService.verifyEmailOtp(req.body);

        return res.status(200).json({
            status: "success",
            data: result,
        });
    } catch (error: any) {
        return res.status(400).json({
            status: "failed",
            message: error?.message || error || "OTP verification failed",
        });
    }
};

const resendEmailOtpController = async (req: Request, res: Response) => {
    try {
        const result = await authService.resendEmailOtp(req.body);

        return res.status(200).json({
            status: "success",
            data: result,
        });
    } catch (error: any) {
        return res.status(400).json({
            status: "failed",
            message: error?.message || error || "Resend OTP failed",
        });
    }
};

const resendVerification = async (req: Request, res: Response) => {
    const email = req.query.email as string;
    if (!email) {
        return res.status(400).json({ status: 'error', message: 'Email is required' });
    }

    // Optional, and absent from every existing caller — the customer mobile app
    // and the provider portal both call this with `?email=` alone, so they keep
    // landing on Firebase's own page. A caller that names an allowlisted
    // platform gets a link home instead.
    const continueUrl = continueUrlFor('verify', req.query.platform);

    // Fixed response time floor collapses fast (user-not-found) vs slow (send-email) paths.
    const MIN_RESPONSE_MS = 600;
    const start = Date.now();
    try {
        await authService.getAndSendEmailVerificationLink(email, null, continueUrl);
    } catch (error: any) {
        console.error('resendVerification: failed', { email: email?.slice(0, 3) + '***', err: error?.message || error });
    }
    const elapsed = Date.now() - start;
    if (elapsed < MIN_RESPONSE_MS) {
        await new Promise(r => setTimeout(r, MIN_RESPONSE_MS - elapsed));
    }

    return res.status(200).json({
        status: 'success',
        data: { message: 'If this account exists, a verification link has been sent.' },
    });
};

export const firebaseAuthLoginController = async (req: Request, res: Response) => {
  try {
    const { idToken, sourceClient, fcmToken, role } = req.body;

    if (!idToken) {
      return res.status(400).json({ status: "failed", message: "idToken is required" });
    }

    // Validate role when provided. Accept "2" (provider) or "3" (customer).
    // Defaults to "2" inside firebaseAuthLogin when omitted, preserving provider-portal behaviour.
    // ServanaClient must pass role="3" so new customer accounts receive the correct role on INSERT.
    if (role !== undefined && role !== "2" && role !== "3") {
      return res.status(400).json({ status: "failed", message: "Invalid role value" });
    }

    const result = await firebaseFunction.firebaseAuthLogin(idToken, role);

    // Non-blocking attribution: only record when sourceClient is explicitly sent
    if (sourceClient && result?.data?.uid) {
      upsertSourceAttribution(result.data.uid, sourceClient, false).catch(() => {});
    }

    // Non-blocking last-activity update for provider activity tracking in admin portal
    if (result?.data?.uid) {
      touchProviderActivity(result.data.uid).catch(() => {});
    }

    // Non-blocking FCM token registration — ServanaClient sends fcmToken in this body;
    // without this call push notifications never reach customers who sign in via Firebase auth.
    if (fcmToken && result?.data?.uid) {
      authService.updateFcmToken(result.data.uid, fcmToken).catch(() => {});
    }

    return res.status(200).json({ status: 'success', data: result.data });
  } catch (error: any) {
    // Log before collapsing. Every failure here used to become a bare 401 with
    // the cause discarded, so a database constraint, a Firebase outage and a
    // genuinely bad token were indistinguishable in production — and the portal
    // renders all of them as "session expired", which points at the wrong thing.
    console.error("[firebase-login] failed:", error?.code ?? "", error?.message ?? error);

    // Signing in with an identifier that belongs to an existing account is not
    // an authentication failure. Told to try again, the person will keep failing
    // the same way; they need to know which identifier to use instead.
    if (error?.code === "ACCOUNT_LINK_REQUIRED") {
      // Keeps the specific message — it names which identifier to use, which is
      // the whole point. The generic one would send them round the same loop.
      return sendAuthError(res, "ACCOUNT_LINK_REQUIRED", error.message);
    }

    if (error?.message?.includes("disabled")) {
      return sendAuthError(res, "PROVIDER_DISABLED");
    }

    // Firebase distinguishes an expired or revoked token from a malformed one.
    // Collapsing both into one response is what makes a client unable to decide
    // between refreshing silently and interrupting the person.
    if (error?.code === "auth/id-token-expired" || error?.code === "auth/id-token-revoked") {
      return sendAuthError(res, "TOKEN_EXPIRED");
    }

    return sendAuthError(res, "INVALID_TOKEN");
  }
};

/**
 * Customer social login (Google / Facebook via Flutter app).
 * Accepts the Firebase ID token obtained after signing in with a social provider,
 * upserts the customer account (role=3) in user_credentials, and returns a session
 * shape identical to the email/password login so the Flutter client can parse it
 * with the same _loginWithFirebaseToken helper.
 *
 * The Firebase ID token IS the session token — subsequent authenticated requests send it
 * as Authorization: Bearer, which verifyAuth middleware validates via Firebase Admin SDK.
 */
export const customerFirebaseLoginController = async (req: Request, res: Response) => {
  try {
    const { idToken, fcmToken } = req.body;
    if (!idToken) {
      return res.status(400).json({ status: "failed", message: "idToken is required" });
    }
    const result = await firebaseFunction.customerFirebaseLogin(idToken);
    // Non-blocking FCM token registration (must run AFTER upsert so uid is guaranteed)
    if (fcmToken && result?.data?.id) {
      authService.updateFcmToken(result.data.id, fcmToken).catch(() => {});
    }
    return res.status(200).json(result);
  } catch (error: any) {
    const isDisabled = error?.disabled || error?.message?.includes("disabled");
    return res.status(isDisabled ? 403 : 401).json({
      status: "failed",
      message: isDisabled
        ? "This account has been disabled. Please contact support."
        : "Authentication failed.",
    });
  }
};

export const providerRegisterController = async (req: Request, res: Response) => {
  try {
    const { idToken, firstName, lastName, sourceClient } = req.body;

    if (!idToken) {
      return res.status(400).json({ status: "failed", message: "idToken is required" });
    }
    if (!firstName || !lastName) {
      return res.status(400).json({ status: "failed", message: "firstName and lastName are required" });
    }

    const result = await firebaseFunction.firebaseProviderRegister(
      idToken,
      String(firstName).trim(),
      String(lastName).trim(),
    );

    // Non-blocking attribution: record registration source for the newly created provider
    if (result?.data?.uid) {
      const src = (sourceClient as string) || 'provider_web';
      upsertSourceAttribution(result.data.uid, src as any, true, 'registration').catch(() => {});
      // Non-blocking auto-online eligibility check on new provider registration
      autoOnlineEngine.evaluateProvider(result.data.uid, 'system', null).catch(() => {});
    }

    return res.status(200).json(result);
  } catch (error: any) {
    const isDisabled = error?.message?.includes("disabled");
    return res.status(isDisabled ? 403 : 400).json({
      status: "failed",
      message: isDisabled ? "This account has been disabled. Please contact support." : "Registration failed. Please try again.",
    });
  }
};

export const addEmployeesController = async (req: Request, res: Response) => {
    try {
        const { employees } = req.body;

        if (!Array.isArray(employees) || employees.length === 0) {
            return res.status(400).json({ status: "failed", message: "employees must be a non-empty array" });
        }

        const results = await authService.addEmployees(employees);
        const failed = results.filter((r) => !r.success);

        results.filter((r) => r.success && (r as any).uid).forEach((r) => {
            autoOnlineEngine.evaluateProvider((r as any).uid, 'system', null).catch(() => {});
        });

        return res.status(200).json({
            status: "success",
            total: results.length,
            created: results.length - failed.length,
            failed: failed.length,
            results,
        });
    } catch (error: any) {
        return res.status(500).json({
            status: "failed",
            message: error?.message || "Failed to add employees",
        });
    }
};

export const forgotPasswordController = async (req: Request, res: Response) => {
    try {
        const { email, platform } = req.body;

        if (!email) {
            return res.status(400).json({ status: "error", message: "Email is required" });
        }

        // Only allowlisted platforms get a platform-specific continueUrl. Every
        // other caller — the customer mobile app and the admin portal, which
        // omit `platform` entirely — receives undefined and continues to land on
        // Firebase's own hosted page, exactly as before.
        //
        // The allowlist and the URL map live together in one file so they cannot
        // drift; see src/constants/platformContinueUrls.ts for why the caller
        // sends a NAME and never a URL.
        const continueUrl = continueUrlFor('reset', platform);

        const result = await authService.forgotPassword(email, continueUrl);
        return res.status(200).json({ status: "success", data: result });
    } catch (error: any) {
        const isClientError = typeof error === 'string' && error.toLowerCase().includes('valid email');
        return res.status(isClientError ? 400 : 500).json({
            status: "error",
            message: isClientError ? error : "Unable to process your request. Please try again.",
        });
    }
};

export const resetPasswordController = async (req: Request, res: Response) => {
    try {
        const { oobCode, newPassword } = req.body;

        if (!oobCode || !newPassword) {
            return res.status(400).json({ status: 'error', message: 'oobCode and newPassword are required' });
        }

        const result = await authService.resetPassword({ oobCode, newPassword });
        return res.status(200).json({ status: "success", data: result });
    } catch (error: any) {
        return res.status(400).json({
            status: 'error',
            message: 'Password reset failed. The link may have expired. Please request a new one.',
        });
    }
};

export const updateEmployeeController = async (req: Request, res: Response) => {
    try {
        const uid = req.params.uid as string;
        if (!uid) {
            return res.status(400).json({ status: "failed", message: "uid is required" });
        }
        const result = await authService.updateEmployee(uid, req.body);
        return res.status(200).json({ status: "success", ...result });
    } catch (error: any) {
        return res.status(500).json({
            status: "failed",
            message: error?.message || error || "Failed to update employee",
        });
    }
};

export const logoutController = async (req: Request, res: Response) => {
    try {
        const uid = req.user && req.user.uid;
        if (!uid) {
            return sendAuthError(res, "UNAUTHENTICATED");
        }
        await Promise.allSettled([
            firebaseFunction.revokeTokenInFirebase(uid),
            clearFcmToken(uid),
        ]);
        return res.status(200).json({ status: "success", data: { message: "Logged out." } });
    } catch (error: any) {
        return res.status(500).json({ status: "failed", message: error?.message || "Logout failed" });
    }
};


export { signup, signin, resendVerification, verifyEmailOtpController, resendEmailOtpController };

/**
 * POST /api/auth/refresh — exchange a refresh token for a fresh ID token.
 *
 * Deliberately unauthenticated: the caller's ID token has expired, which is the
 * entire reason they are here. The refresh token in the body IS the credential,
 * and Google validates it. Rate limited at the route.
 */
export const refreshTokenController = async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body ?? {};
    const session = await refreshIdToken(refreshToken);
    return res.status(200).json({ status: 'success', data: session });
  } catch (error: any) {
    if (error instanceof TokenRefreshError) {
      return res.status(error.statusCode).json({
        status: 'failed',
        code: error.code,
        message: error.message,
      });
    }
    // Never surface an unexpected error's text here — it can carry the token.
    return res.status(502).json({
      status: 'failed',
      code: 'REFRESH_UNAVAILABLE',
      message: 'Token refresh is unavailable',
    });
  }
};
