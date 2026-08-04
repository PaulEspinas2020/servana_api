import { Request, Response } from "express";
import { getProviderAccountState } from "../services/providerAccountStateService";

/**
 * GET /api/provider/account-state — Command 6 §5.
 *
 * The one place a client asks "what may this provider do". Deliberately
 * authenticated-only rather than behind `requireActiveProvider`: a suspended or
 * pending provider needs this endpoint precisely BECAUSE they are restricted —
 * gating it behind active status would leave the restricted states unable to
 * discover why they are restricted.
 */
export async function getAccountState(req: Request, res: Response) {
  const uid = (req as any).user?.uid as string | undefined;
  if (!uid) {
    return res.status(401).json({
      status: "failed",
      message: "Authentication is required",
      error: { code: "UNAUTHENTICATED", recovery: "REAUTHENTICATE", retryable: false },
    });
  }

  try {
    const state = await getProviderAccountState(uid);
    // No caching: the whole point is that it is current. A stale copy of this
    // is a client believing it may still work after being suspended (§22).
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ status: "success", data: state });
  } catch (err) {
    console.error("[account-state]", err);
    // A state lookup that fails must not widen access, and must not be
    // mistaken for a verdict — it routes to retry, not to a status screen the
    // provider can do nothing about.
    return res.status(503).json({
      status: "failed",
      message: "Your account status could not be verified. Please try again.",
      error: {
        code: "ACCOUNT_STATUS_UNAVAILABLE",
        recovery: "RETRY",
        retryable: true,
      },
    });
  }
}
