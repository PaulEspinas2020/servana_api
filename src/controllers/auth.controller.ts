import { Request, Response, NextFunction } from "express";
import { successMessage, errorMessage, status } from "../helpers/status";
import * as authService from "../services/auth.service";
import * as firebaseFunction from "../services/firebaseFunctions.service";

const signin = async (req: Request, res: Response) => {
    const { email, password, fcmToken } = req.body;
    try {
        const dbResponse = await authService.loggedInUser(email, password);

        // TODO save fcm

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

export { signup, signin, resendVerification };
