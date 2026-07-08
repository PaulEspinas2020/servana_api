import { Router } from "express";
import * as bookingController from "../controllers/bookingController";
import verifyAuth from "../middleware/verifyAuth";

const router = Router();

// Specific named routes must be registered before wildcard param routes (/:id)
// to prevent Express from matching them as booking IDs.
router.get("/bookings/all", verifyAuth, bookingController.listAllBookings);
router.get("/dashboard/summary", verifyAuth, bookingController.getAnalytics);
router.get("/users/:userId/bookings", bookingController.listUserBookings);

router.post("/bookings", bookingController.createBooking);
router.post("/:id/confirm-otp", bookingController.confirmOtp);
router.get("/:id", bookingController.getBooking);
router.get("/:id/tracking", bookingController.getTracking);
export default router;
