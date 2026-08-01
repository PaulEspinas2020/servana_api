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
router.get("/dashboard/summary", verifyAuth, verifyRoles([1]), bookingController.getAnalytics);
// verifyAuthOptional: unauthenticated mobile calls pass through; authenticated browser sessions
// must own the userId in the path (enforced in the controller).
router.get("/users/:userId/bookings", verifyAuthOptional, bookingController.listUserBookings);

// Identity is taken from the token, not from ?userId= (§7).
router.post("/bookings", verifyAuth, bookingController.createBooking);
// BACKEND_GAP-C15-001: customer self-cancellation — must be before /:id wildcard
router.post("/bookings/:id/cancel", verifyAuthOptional, bookingController.cancelBooking);
// Booking-scoped routes. verifyAuth establishes WHO is calling;
// assertBookingAccess in each controller establishes whether this booking is
// theirs (customer, actively-assigned provider, or admin). Both mobile apps
// already send a Bearer token on these calls, so this closes the hole without
// forcing a protected-client release (§2).
router.post("/:id/confirm-otp", verifyAuth, bookingController.confirmOtp);
router.get("/:id", verifyAuth, bookingController.getBooking);
router.get("/:id/tracking", verifyAuth, bookingController.getTracking);
export default router;
