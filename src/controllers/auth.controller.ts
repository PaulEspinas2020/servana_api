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
        const msg = typeof error === 'string' ? error : error?.message;
        if (msg && (msg.includes('valid Email') || msg.includes('valid Password') || msg.includes('valid email'))) {
            return res.status(400).json({ status: 'error', message: 'Please enter a valid email and password.' });
        }
        return res.status(500).json({ status: "failed", message: msg || String(error) });
    }
};

const signup = async (req: Request, res: Response) => {
    try {
        const dbResponse = await authService.registerUser(req.body);
        successMessage.data = dbResponse;
        res.status(status.success).send(successMessage);
    } catch (error: any) {
        return res.status(500).json({ status: "failed", message: error?.message || String(error) });
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

    try {
        const dbResponse = await authService.getAndSendEmailVerificationLink(email);
        successMessage.data = dbResponse;
        res.status(status.success).send(successMessage);
    } catch (error: any) {
        return res.status(500).json({ status: "failed", message: error?.message || String(error) });
    }
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
      message: error?.message || "Authentication failed",
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
      message: error?.message || "Registration failed",
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

export const forgotPasswordController = async (req: Request, res: Response) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ status: "failed", message: "Email is required" });
        }

        const result = await authService.forgotPassword(email);
        return res.status(200).json({ status: "success", ...result });
    } catch (error: any) {
        return res.status(400).json({
            status: "failed",
            message: error?.message || error || "Failed to send password reset email",
        });
    }
};

export const resetPasswordController = async (req: Request, res: Response) => {
    try {
        const { email, newPassword } = req.body;

        const result = await authService.resetPassword({ email, newPassword });
        return res.status(200).json({ status: "success", ...result });
    } catch (error: any) {
        return res.status(400).json({
            status: "failed",
            message: error?.message || error || "Failed to reset password",
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
