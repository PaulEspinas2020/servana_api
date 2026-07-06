import { Router } from "express";
import * as paymentController from "../controllers/paymentController";
import verifyAuth from "../middleware/verifyAuth";

const router = Router();

router.post("/:bookingId/gcash-submit", paymentController.gcashSubmit);
router.post("/:bookingId/approve", verifyAuth, paymentController.approve);
router.post("/:bookingId/mark-cash-paid", verifyAuth, paymentController.markCashPaid);
router.post("/:bookingId/paymongo/create", paymentController.createPaymongoPayment);
router.post("/paymongo/webhook", paymentController.paymongoWebhook);

export default router;
