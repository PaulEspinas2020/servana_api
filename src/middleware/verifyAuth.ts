import { Request, Response, NextFunction } from "express";
import { firebaseAdmin } from "../middleware/firebaseApp";
import { tempId } from "../config";
import { getAuth as getAuthAdmin } from 'firebase-admin/auth';

const defaultAuthAdmin = getAuthAdmin(firebaseAdmin);

const validateFirebaseIdToken = async (req: Request, res: Response, next: NextFunction) => {
  if (!tempId) {
    const authHeader = req.headers.authorization;
    const cookieToken = req.cookies?.__session;

    if (!authHeader?.startsWith("Bearer ") && !cookieToken) {
      res.status(401).json({
        status: "failed",
        code: "UNAUTHENTICATED",
        message: "Authentication is required",
      });
      return;
    }

    const idToken = authHeader?.startsWith("Bearer ")
      ? authHeader.split("Bearer ")[1]
      : cookieToken;

    if (!idToken) {
      res.status(401).json({
        status: "failed",
        code: "UNAUTHENTICATED",
        message: "Authentication is required",
      });
      return;
    }

    try {
      const decodedIdToken = await defaultAuthAdmin.verifyIdToken(idToken);
      req.user = decodedIdToken;
      next();
    } catch (error: any) {
      if (error.code === "auth/id-token-expired" || error.code === "auth/argument-error") {
        res.status(401).json({
          status: "failed",
          code: "TOKEN_EXPIRED",
          message: "Session expired. Please log in again.",
        });
        return;
      }
      res.status(401).json({
        status: "failed",
        code: "INVALID_TOKEN",
        message: "Authentication token is invalid",
      });
    }
  } else {
    req['user'] = { uid: tempId };
    next();
  }
};

export default validateFirebaseIdToken;
