import { Router } from "express";
import * as bookingController from "../controllers/bookingController";
// import { requireAuth } from "../middlewares/requireAuth";

const router = Router();


router.post("/bookings", bookingController.createBooking);
router.post("/:id/confirm-otp", bookingController.confirmOtp);
router.get("/:id", bookingController.getBooking);
router.get("/:id/tracking", bookingController.getTracking);

export default router;
