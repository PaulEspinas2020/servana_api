import { Router } from "express";
import * as disbursementController from "../controllers/disbursement.controller";
import verifyAuth from "../middleware/verifyAuth";
import verifyRoles from "../middleware/verifyRoles";

const router = Router();

// GET  /api/admin/disbursements?status=PENDING&workerUid=xxx
router.get("/admin/disbursements", verifyAuth, verifyRoles([1]), disbursementController.list);

// GET  /api/admin/disbursements/booking/:bookingId
router.get("/admin/disbursements/booking/:bookingId", verifyAuth, verifyRoles([1]), disbursementController.getByBooking);

// POST /api/admin/disbursements/:id/retry
router.post("/admin/disbursements/:id/retry", verifyAuth, verifyRoles([1]), disbursementController.retry);

// POST /api/admin/disbursements/trigger  (manual run — dev/ops use)
router.post("/admin/disbursements/trigger", verifyAuth, verifyRoles([1]), disbursementController.triggerNow);

export default router;
