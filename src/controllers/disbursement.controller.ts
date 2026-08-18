import { Request, Response } from "express";
import * as disbursementService from "../services/disbursement.service";
import * as financeService from "../services/adminFinanceService";
import { toCamel } from "../helpers/idGenerator";

/**
 * The legacy `/api/admin/disbursements/*` surface (TAB 01, F-01 / F-10).
 *
 * These four routes and `/api/admin/finance/payouts/*` operate the same
 * disbursement rows. The finance surface is CANONICAL — it is permissioned,
 * audited, capped, and it is the one the admin portal actually calls. This one
 * had `verifyAuth + verifyRoles([1])` and nothing else.
 *
 * What changed, and what deliberately did not:
 *
 *   - Both MUTATIONS now delegate to `adminFinanceService`, so there is one
 *     implementation of "retry a payout" and one of "run the due batch", each
 *     writing an audit record that names the admin whichever path was taken.
 *   - Both READS keep their own query and their own response shape. Converging
 *     them would mean changing `{ success, disbursements }` into the finance
 *     envelope, and that is a breaking change to a response an unmeasured
 *     client may parse (§4). Authorization is the defect; the payload is not.
 *
 * The routes are not deleted, because deleting a route while a caller may exist
 * is the one move §4 forbids outright. They are guarded, converged and queued
 * for retirement once telemetry shows observed silence — not once somebody
 * believes they are unused.
 */

// ── Reads: unchanged behaviour and shape, now behind a named permission ───────

export const list = async (req: Request, res: Response) => {
  try {
    const { status, workerUid } = req.query as Record<string, string>;
    const rows = await disbursementService.listDisbursements({ status, workerUid });
    res.json({ success: true, disbursements: rows.map(toCamel) });
  } catch (e: any) {
    res.status(500).json({ success: false, message: e.message });
  }
};

export const getByBooking = async (req: Request, res: Response) => {
  try {
    const bookingId = Number(req.params.bookingId);
    const row = await disbursementService.getDisbursementByBooking(bookingId);
    if (!row) return res.status(404).json({ success: false, message: "Disbursement not found" });
    res.json({ success: true, disbursement: toCamel(row) });
  } catch (e: any) {
    res.status(500).json({ success: false, message: e.message });
  }
};

// ── Helpers, matching adminFinanceController so the actor is resolved once ────

function actorFrom(req: Request): { uid: string; name: string | null } {
  const user = (req as any).user;
  return {
    uid: user?.uid ?? "unknown",
    name: user?.name ?? user?.email ?? null,
  };
}

function rid(req: Request): string | null {
  return (req as any).id ?? (req.headers["x-request-id"] as string) ?? null;
}

// ── Mutations: delegated to the canonical, audited, capped implementation ─────

/**
 * Retry a failed payout.
 *
 * Previously `disbursementService.manualRetry`, which is now deleted. It reset
 * the row and POSTed to PayMongo inside the request, with no permission, no
 * audit and no retry cap — it never read or incremented `retry_count`, so
 * `PAYOUT_MAX_RETRIES` was invisible to it. The weaker-guarded path was the
 * more powerful one.
 *
 * The behavioural change is stated rather than hidden: this now QUEUES. The row
 * goes to PENDING and the hourly job releases it, which is the behaviour the
 * admin portal already has, because the portal calls the finance surface.
 *
 * The response keeps its `{ success, disbursement }` shape by reading the row
 * back after the canonical service has updated it.
 */
export const retry = async (req: Request, res: Response) => {
  try {
    const disbursementId = Number(req.params.id);
    if (!Number.isSafeInteger(disbursementId) || disbursementId <= 0) {
      return res.status(400).json({ success: false, message: "Invalid disbursement ID" });
    }
    const { uid, name } = actorFrom(req);
    await financeService.retryPayout(disbursementId, uid, name, rid(req));

    const row = await financeService.getPayoutDetail(disbursementId);
    res.json({ success: true, disbursement: row });
  } catch (e: any) {
    // The canonical service throws tagged errors; NOT_FOUND is the only one
    // that is not a 400 here. The legacy shape returned 400 for everything,
    // so a 404 for a missing row is strictly more accurate and cannot be
    // mistaken by a client that was already handling non-2xx as failure.
    const status = e?.code === "NOT_FOUND" ? 404 : 400;
    res.status(status).json({ success: false, message: e?.message ?? "Retry failed" });
  }
};

/**
 * Run the due-payout batch on demand.
 *
 * The single most consequential money action on the platform. It ran behind a
 * role check alone, and `payouts.trigger_due_run` — already in the permission
 * catalogue, already flagged `is_dangerous: true` — was consulted by nothing.
 */
export const triggerNow = async (req: Request, res: Response) => {
  try {
    const { uid, name } = actorFrom(req);
    const summary = await financeService.runDuePayoutBatch(uid, name, rid(req));
    res.json({
      success: true,
      message: "Disbursement run complete",
      selected: summary.selected,
      attempted: summary.attempted,
      threw: summary.threw,
    });
  } catch (e: any) {
    res.status(500).json({ success: false, message: e.message });
  }
};
