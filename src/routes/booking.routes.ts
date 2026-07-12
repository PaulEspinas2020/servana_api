import { Router } from "express";
import * as bookingController from "../controllers/bookingController";
import verifyAuth from "../middleware/verifyAuth";
import verifyAuthOptional from "../middleware/verifyAuthOptional";
import verifyRoles from "../middleware/verifyRoles";

const router = Router();

// Specific named routes must be registered before wildcard param routes (/:id)
// to prevent Express from matching them as booking IDs.
// Admin-only: returns ALL bookings with no user filter; role guard prevents
// provider/customer tokens from enumerating all customer data.
router.get("/bookings/all", verifyAuth, verifyRoles([1]), bookingController.listAllBookings);
router.get("/dashboard/summary", verifyAuth, bookingController.getAnalytics);
// verifyAuthOptional: unauthenticated mobile calls pass through; authenticated browser sessions
// must own the userId in the path (enforced in the controller).
router.get("/users/:userId/bookings", verifyAuthOptional, bookingController.listUserBookings);

router.post("/bookings", bookingController.createBooking);
router.post("/:id/confirm-otp", bookingController.confirmOtp);
router.get("/:id", bookingController.getBooking);
router.get("/:id/tracking", bookingController.getTracking);
export default router;
