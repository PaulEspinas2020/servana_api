import { Router } from "express";
import * as disbursementController from "../controllers/disbursement.controller";
import verifyAuth from "../middleware/verifyAuth";
import verifyRoles from "../middleware/verifyRoles";
import { adminRateLimit } from '../middleware/adminRateLimit';
import { requirePermission } from "../middleware/requirePermission";

/**
 * Legacy admin disbursement surface — now permissioned to match its twin.
 *
 * ## The defect this closes (TAB 01, F-01)
 *
 * Every one of these four routes was `verifyAuth, verifyRoles([1])` and nothing
 * more, while `/api/admin/finance/payouts/*` — the SAME capability, on the SAME
 * rows — required a named `payouts.*` permission on every route and wrote an
 * audit record for every mutation.
 *
 * That is an authorization bypass even though each route looked reasonable on
 * its own. Servana provisions admins with permissions deliberately withheld:
 * one live admin holds 214 grants with 18 dangerous ones withheld. The model is
 * load-bearing — somebody is MEANT to be unable to move money — and a second
 * unguarded route to the same domain service silently made that untrue. A guard
 * is only as strong as the weakest path to the capability behind it.
 *
 * ## The permissions are copied from the twin, not chosen
 *
 *   GET  /admin/disbursements               → payouts.view
 *                                             twin: GET /admin/finance/payouts
 *   GET  /admin/disbursements/booking/:id   → payouts.details.view
 *                                             twin: GET /admin/finance/payouts/:id
 *   POST /admin/disbursements/:id/retry     → payouts.retry_failed
 *                                             twin: POST /admin/finance/payouts/:id/retry
 *   POST /admin/disbursements/trigger       → payouts.trigger_due_run
 *
 * The last one had no twin, and it did not need a new permission invented for
 * it either: `payouts.trigger_due_run` has been in the catalogue all along —
 * `action_type: 'system'`, `risk_level: 'critical'`, `is_dangerous: true` — and
 * no route in the repository consulted it. The control was designed, named and
 * flagged. Nothing ever asked it. Connecting it is the whole fix.
 *
 * ## Lockout is the real deployment risk, and the reversal is a GRANT
 *
 * Enforcing a permission can lock out an admin who legitimately lacked the
 * grant. Super Admins bypass `requirePermission`, so the batch stays reachable
 * for them; every other operator needs `payouts.trigger_due_run` granted first.
 * Grant first, enforce second — and if a lockout happens, the fix is a grant,
 * never a redeploy that removes the guard. Recorded in
 * `docs/MASTER_TODO_MANUAL_TASKS.md` as item 01.1, because the grant query is a
 * production read this environment is not authorised to perform.
 *
 * ## Why these routes still exist
 *
 * Because deleting a route while a caller may exist is the one thing §4 forbids
 * outright, and the caller count outside the admin portal has not been measured
 * — the other five consumer repositories are not on this machine. They are
 * guarded and converged now, and retired later on telemetry showing observed
 * silence. See `docs/audits/TAB01_PAYOUT_AUTHORIZATION.md`.
 */

const router = Router();

const adminOnly = [verifyAuth, verifyRoles([1]), adminRateLimit];

// GET  /api/admin/disbursements?status=PENDING&workerUid=xxx
router.get("/admin/disbursements", ...adminOnly, requirePermission('payouts.view'), disbursementController.list);

// GET  /api/admin/disbursements/booking/:bookingId
router.get("/admin/disbursements/booking/:bookingId", ...adminOnly, requirePermission('payouts.details.view'), disbursementController.getByBooking);

// POST /api/admin/disbursements/:id/retry
router.post("/admin/disbursements/:id/retry", ...adminOnly, requirePermission('payouts.retry_failed'), disbursementController.retry);

// POST /api/admin/disbursements/trigger  (runs the due-payout batch)
router.post("/admin/disbursements/trigger", ...adminOnly, requirePermission('payouts.trigger_due_run'), disbursementController.triggerNow);

export default router;
