import { Router } from "express";
import * as additionalController from "../controllers/additional.controller";
import verifyAuth from "../middleware/verifyAuth";
import verifyRoles from "../middleware/verifyRoles";

const router = Router();

// Booking-scoped read — unprotected (mobile queries by bookingId)
router.get("/additional/booking/:bookingId", additionalController.getByBooking);

// Customer/worker lifecycle — unprotected (mobile calls these without a token)
router.post("/additional/request/:userId", additionalController.createRequest);
router.post("/additional/:id/payment", additionalController.generatePayment);
router.post("/additional/:id/worker-decision", additionalController.workerDecision);
router.post("/additional/:id/withdraw", additionalController.workerWithdraw);
router.post("/additional/:id/confirm-proceed", additionalController.workerConfirmProceed);

// Admin approval — protected (admin portal only; mobile never calls this route)
router.post("/additional/:id/approve", verifyAuth, verifyRoles([1]), additionalController.approveRequest);

export default router;
