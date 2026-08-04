import { Request, Response } from "express";
import * as svc from "../services/accountDeletionService";

/**
 * The acknowledgement is identical for every outcome — matched account,
 * unmatched identifier, malformed input, duplicate request. See the enumeration
 * note in accountDeletionService.
 */
const ACKNOWLEDGEMENT =
  "If an account exists for that email address or mobile number, a deletion " +
  "request has been recorded. We will action it within 30 days and contact you " +
  "at that address or number if we need to confirm anything.";

/** POST /api/account/deletion-request — public, unauthenticated. */
export async function requestDeletionPublic(req: Request, res: Response) {
  try {
    const { identifier } = req.body as Record<string, unknown>;
    await svc.recordDeletionRequest(identifier, "web");
    return res.status(202).json({ status: "success", message: ACKNOWLEDGEMENT });
  } catch (err) {
    console.error("requestDeletionPublic", err);
    // Deliberately NOT surfaced as a failure the caller can distinguish from
    // success: a 500 here on one identifier and a 202 on another would restore
    // exactly the oracle the flat response exists to remove. It is logged for
    // us and acknowledged for them.
    return res.status(202).json({ status: "success", message: ACKNOWLEDGEMENT });
  }
}

/** POST /api/account/deletion-request/me — authenticated, in-app route. */
export async function requestDeletionForSelf(req: Request, res: Response) {
  try {
    const uid = req.user?.uid as string;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });

    await svc.recordDeletionRequestForUid(uid);
    return res.status(202).json({
      status: "success",
      message:
        "Your account deletion request has been recorded. We will action it " +
        "within 30 days. Bookings and payment records are retained where we are " +
        "required to keep them.",
    });
  } catch (err) {
    console.error("requestDeletionForSelf", err);
    return res
      .status(500)
      .json({ status: "failed", message: "Could not record the request. Please try again." });
  }
}
