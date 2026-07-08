import { Request, Response, NextFunction } from "express";

// Enforces that the authenticated user can only access their own resources.
// Must be used after verifyAuth (which populates req.user).
const verifyOwnership = (req: Request, res: Response, next: NextFunction): void => {
  const uid = req.params.uid || req.params.workerId;
  if (!req.user || req.user.uid !== uid) {
    res.status(403).json({ status: "failed", message: "Access denied" });
    return;
  }
  next();
};

export default verifyOwnership;
