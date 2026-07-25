import { Request, Response, NextFunction } from "express";
import { successMessage, errorMessage, status } from "../helpers/status";
import * as authService from "../services/auth.service";
import * as firebaseFunction from "../services/firebaseFunctions.service";
import { upsertSourceAttribution } from "../services/providerOnboardingService";
import * as autoOnlineEngine from "../services/providerAutoOnlineEngine";
import { touchProviderActivity } from "../services/adminProviderService";

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
            return res.status(401).json({ status: 'error', message: 'Invalid email or password.' });
        }
        if ((error as any)?.statusCode === 403) {
            return res.status(403).json({ status: 'error', message: error?.message || 'Email not verified.' });
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

    // Swallow all errors — the response is always neutral to prevent account-existence enumeration.
    try {
        await authService.getAndSendEmailVerificationLink(email);
    } catch (error: any) {
        console.error('resendVerification: failed', { email: email?.slice(0, 3) + '***', err: error?.message || error });
    }

    return res.status(200).json({
        status: 'success',
        message: 'If this account exists, a verification link has been sent.',
    });
};

export const firebaseAuthLoginController = async (req: Request, res: Response) => {
  try {
    const { idToken, sourceClient } = req.body;

    if (!idToken) {
      return res.status(400).json({ status: "failed", message: "idToken is required" });
    }

    const result = await firebaseFunction.firebaseAuthLogin(idToken);

    // Non-blocking attribution: only record when sourceClient is explicitly sent
    if (sourceClient && result?.data?.uid) {
      upsertSourceAttribution(result.data.uid, sourceClient, false).catch(() => {});
    }

    // Non-blocking last-activity update for provider activity tracking in admin portal
    if (result?.data?.uid) {
      touchProviderActivity(result.data.uid).catch(() => {});
    }

    return res.status(200).json(result);
  } catch (error: any) {
    const isDisabled = error?.message?.includes("disabled");
    return res.status(isDisabled ? 403 : 401).json({
      status: "failed",
      message: isDisabled ? "This account has been disabled. Please contact support." : "Authentication failed.",
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

// Platform-specific reset redirect URLs.
// Client app and admin portal omit `platform`, so they continue to use Firebase's
// default hosted reset page — no change to their existing behavior.
const PLATFORM_RESET_URLS: Record<string, string> = {
    provider: process.env.PROVIDER_RESET_URL || "https://servana.com.ph/provider/reset-password",
};

// Only these platform values may override the reset URL — guards against prototype pollution.
const ALLOWED_PLATFORMS = new Set(['provider']);

export const forgotPasswordController = async (req: Request, res: Response) => {
    try {
        const { email, platform } = req.body;

        if (!email) {
            return res.status(400).json({ status: "error", message: "Email is required" });
        }

        // Only 'provider' callers get a platform-specific continueUrl.
        // All others (client app, admin) receive undefined so Firebase uses its own default page.
        const continueUrl = (typeof platform === 'string' && ALLOWED_PLATFORMS.has(platform))
            ? PLATFORM_RESET_URLS[platform]
            : undefined;

        const result = await authService.forgotPassword(email, continueUrl);
        return res.status(200).json({ status: "success", ...result });
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
        return res.status(200).json({ status: "success", ...result });
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
            return res.status(401).json({ status: "failed", message: "Unauthorized" });
        }
        try {
            await firebaseFunction.revokeTokenInFirebase(uid);
        } catch (_revokeErr) {
            // Non-fatal
        }
        return res.status(200).json({ status: "success", data: { message: "Logged out." } });
    } catch (error: any) {
        return res.status(500).json({ status: "failed", message: error?.message || "Logout failed" });
    }
};


export { signup, signin, resendVerification, verifyEmailOtpController, resendEmailOtpController };
