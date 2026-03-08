import { Router } from "express";
import * as paymentController from "../controllers/paymentController";

const router = Router();


router.post("/:bookingId/gcash-submit", paymentController.gcashSubmit);
router.post("/:bookingId/approve", paymentController.approve);
router.post("/:bookingId/mark-cash-paid", paymentController.markCashPaid);

export default router;
