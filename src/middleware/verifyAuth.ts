import { Request, Response, NextFunction } from "express";
import { firebaseAdmin } from "../middleware/firebaseApp";
import { tempId } from "../config";
import { getAuth as getAuthAdmin } from 'firebase-admin/auth';
import { isRevoked } from "../services/tokenRevocation";

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

      /**
       * Signature and expiry are not the whole question (Command 7 §20).
       *
       * `revokeAllProviderSessions`, password reset and every admin security
       * action call `revokeRefreshTokens`, which stops Firebase issuing NEW id
       * tokens and does nothing about the ones already held. Without this
       * check, a device that had just been signed out of every session kept
       * full access to every protected route until its token expired — up to
       * an hour, on the very device the provider was trying to remove.
       *
       * See services/tokenRevocation.ts for why this is not simply
       * `verifyIdToken(idToken, true)`: that fetches the user record on every
       * request, and a security fix that costs a network round trip per call
       * is a security fix that gets reverted.
       */
      if (await isRevoked(decodedIdToken as any)) {
        res.status(401).json({
          status: "failed",
          code: "TOKEN_REVOKED",
          message: "You were signed out. Please sign in again.",
          error: {
            code: "TOKEN_REVOKED",
            recovery: "REAUTHENTICATE",
            retryable: false,
          },
        });
        return;
      }

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
    const DEV_ENVS = new Set(['development', 'local', 'test']);
    if (!DEV_ENVS.has(process.env.NODE_ENV || '')) {
      console.error('FATAL: TEMP_ID is set in a non-development environment. Exiting.');
      process.exit(1);
    }
    req['user'] = { uid: tempId };
    next();
  }
};

export default validateFirebaseIdToken;
