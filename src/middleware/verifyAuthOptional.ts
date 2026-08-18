import { Request, Response, NextFunction } from "express";
import { firebaseAdmin } from "./firebaseApp";
import { lazyValue } from "./lazyValue";
import { tempId } from "../config";
import { getAuth as getAuthAdmin } from "firebase-admin/auth";

// Deferred: `getAuthAdmin` resolves the credential eagerly, which made
// importing this module — and so the composed app — require a live key.
const defaultAuthAdmin = lazyValue(() => getAuthAdmin(firebaseAdmin));

/**
 * Soft auth middleware: if an Authorization header or __session cookie is present,
 * verify it and attach req.user. If absent, pass through with req.user = undefined.
 *
 * Use on routes that must remain accessible to unauthenticated mobile clients (mobile
 * parity) but should also enforce ownership when a JWT-authenticated browser session is
 * the caller. Controllers must check req.user themselves when it matters.
 */
const verifyAuthOptional = async (req: Request, _res: Response, next: NextFunction) => {
  // Dev bypass mirrors verifyAuth behaviour.
  if (tempId) {
    req["user"] = { uid: tempId };
    return next();
  }

  const authHeader = req.headers.authorization;
  const cookieToken = req.cookies?.__session;

  if (!authHeader?.startsWith("Bearer ") && !cookieToken) {
    return next(); // No token — pass through unauthenticated
  }

  const idToken = authHeader?.startsWith("Bearer ")
    ? authHeader.split("Bearer ")[1]
    : cookieToken;

  if (!idToken) return next();

  try {
    const decoded = await defaultAuthAdmin.verifyIdToken(idToken);
    req.user = decoded;
  } catch {
    // Invalid / expired token — treat as unauthenticated (don't reject)
  }

  return next();
};

export default verifyAuthOptional;
