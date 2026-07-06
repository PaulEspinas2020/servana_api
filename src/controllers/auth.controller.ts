import { Request, Response, NextFunction } from "express";
import { successMessage, errorMessage, status } from "../helpers/status";
import * as authService from "../services/auth.service";
import * as firebaseFunction from "../services/firebaseFunctions.service";

const signin = async (req: Request, res: Response) => {
    const { email, password, fcmToken } = req.body;
    try {
        const dbResponse = await authService.loggedInUser(email, password);

        // TODO save fcm
        if (fcmToken) {
            await authService.updateFcmToken(dbResponse.id, fcmToken);
        }

        successMessage.data = dbResponse;
        res.status(status.success).send(successMessage);
    } catch (error) {
        errorMessage.error = "" + error;
        res.status(status.error).send(errorMessage);
    }
};

const signup = async (req: Request, res: Response) => {
    try {
        console.log("hello");
        const dbResponse = await authService.registerUser(req.body);
        successMessage.data = dbResponse;
        res.status(status.success).send(successMessage);
    } catch (error) {
        errorMessage.error = "" + error;
        res.status(status.error).send(errorMessage);
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
    const email= req.query.email as string;

    try {
        const dbResponse = await authService.getAndSendEmailVerificationLink(email)
        successMessage.data = dbResponse;
        res.status(status.success).send(successMessage);
    } catch (error) {
        errorMessage.error = "" + error;
        res.status(status.error).send(errorMessage);
    }
};

export const firebaseAuthLoginController = async (req: Request, res: Response) => {
  try {
    const { idToken } = req.body;

    const result = await firebaseFunction.firebaseAuthLogin(idToken);

    return res.status(200).json(result);
  } catch (error: any) {
    return res.status(401).json({
      message: error.message || "Authentication failed",
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
    provider: "https://servana.com.ph/provider/reset-password",
};

export const forgotPasswordController = async (req: Request, res: Response) => {
    try {
        const { email, platform } = req.body;

        if (!email) {
            return res.status(400).json({ status: "failed", message: "Email is required" });
        }

        // Resolve redirect URL only for known platforms. Unknown or absent platform
        // falls through to undefined, preserving Firebase's default hosted page.
        const redirectUrl = (platform && PLATFORM_RESET_URLS[platform]) || undefined;

        const result = await authService.forgotPassword(email, redirectUrl);
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
        const { oobCode, newPassword } = req.body;

        if (!oobCode || !newPassword) {
            return res.status(400).json({ status: "failed", message: "Missing required parameters" });
        }

        const result = await authService.resetPassword({ oobCode, newPassword });
        return res.status(200).json({ status: "success", ...result });
    } catch (error: any) {
        return res.status(400).json({
            status: "failed",
            message: error?.message || error || "Failed to reset password",
        });
    }
};

export const logoutController = async (req: Request, res: Response) => {
    try {
        const uid = req.user && req.user.uid;
        if (!uid) {
            return res.status(401).json({ status: "failed", message: "Unauthorized" });
        }
        // Best-effort server-side token revocation. Non-fatal if it fails (token expires naturally).
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
