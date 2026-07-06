import { Router } from "express";
import * as additionalController from "../controllers/additional.controller";
// import { requireAuth } from "../middlewares/requireAuth";

const router = Router();


router.post("/additional/request/:userId", additionalController.createRequest);
router.post("/additional/:id/approve", additionalController.approveRequest);
router.post("/additional/:id/payment", additionalController.generatePayment);
router.post("/additional/:id/worker-decision", additionalController.workerDecision);
router.post("/additional/:id/withdraw", additionalController.workerWithdraw);
router.post("/additional/:id/confirm-proceed", additionalController.workerConfirmProceed);
router.get("/additional/booking/:bookingId", additionalController.getByBooking);

export default router;
