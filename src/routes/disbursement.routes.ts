import { Router } from "express";
import * as disbursementController from "../controllers/disbursement.controller";

const router = Router();

// GET  /api/admin/disbursements?status=PENDING&workerUid=xxx
router.get("/admin/disbursements", disbursementController.list);

// GET  /api/admin/disbursements/booking/:bookingId
router.get("/admin/disbursements/booking/:bookingId", disbursementController.getByBooking);

// POST /api/admin/disbursements/:id/retry
router.post("/admin/disbursements/:id/retry", disbursementController.retry);

// POST /api/admin/disbursements/trigger  (manual run — dev/ops use)
router.post("/admin/disbursements/trigger", disbursementController.triggerNow);

export default router;
