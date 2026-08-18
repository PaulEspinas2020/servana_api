import { Router } from "express";
import * as bookingController from "../controllers/bookingController";
import verifyAuth from "../middleware/verifyAuth";
import verifyRoles from "../middleware/verifyRoles";

const router = Router();

// Specific named routes must be registered before wildcard param routes (/:id)
// to prevent Express from matching them as booking IDs.
// Admin-only: returns ALL bookings with no user filter; role guard prevents
// provider/customer tokens from enumerating all customer data.
router.get("/bookings/all", verifyAuth, verifyRoles([1]), bookingController.listAllBookings);
router.get("/dashboard/summary", verifyAuth, verifyRoles([1]), bookingController.getAnalytics);
// Hard auth. This was verifyAuthOptional on a "mobile may call without a token"
// premise, but the controller's ownership check reads
// `if (actor?.uid && actor.uid !== userId) deny` — so omitting the header
// skipped the check entirely and any anonymous caller could list any
// customer's bookings. Every real caller (ServanaClient, ServanaWorker,
// provider web) attaches a Bearer token, so the anonymous path was only ever
// reachable by someone deliberately dropping it (§11 fail closed).
router.get("/users/:userId/bookings", verifyAuth, bookingController.listUserBookings);

// Identity is taken from the token, not from ?userId= (§7).
router.post("/bookings", verifyAuth, bookingController.createBooking);
// BACKEND_GAP-C15-001: customer self-cancellation — must be before /:id wildcard
// Hard auth for the same reason, and worse here: customerCancelBooking guards
// with `if (customerUid && ownerId && ...)`, so an anonymous caller cancelled
// any booking AND the timeline event recorded actor_uid = NULL, leaving the
// cancellation unattributable (§11, §15, §16).
router.post("/bookings/:id/cancel", verifyAuth, bookingController.cancelBooking);
// Booking-scoped routes. verifyAuth establishes WHO is calling;
// assertBookingAccess in each controller establishes whether this booking is
// theirs (customer, actively-assigned provider, or admin). Both mobile apps
// already send a Bearer token on these calls, so this closes the hole without
// forcing a protected-client release (§2).
router.post("/:id/confirm-otp", verifyAuth, bookingController.confirmOtp);

// The client has called this since the OTP screen was written
// (servana_api_client.dart:597) and it did not exist, so Resend was the only
// recovery path on that screen and it always failed. verifyAuth + the
// controller's assertBookingAccess: rotating another customer's OTP would lock
// them out of confirming their own booking.
router.post("/:bookingId/resend-otp", verifyAuth, bookingController.resendOtp);
router.get("/:id", verifyAuth, bookingController.getBooking);
router.get("/:id/tracking", verifyAuth, bookingController.getTracking);

// Command 6 §11 — the customer's own booking history.
//
// The timeline builder already existed but was reachable only at
// /provider/bookings/:bookingId/timeline behind requireProviderRole, so a
// customer had no authoritative history of their own booking. The customer
// mobile app worked around it by delegating to /:id/tracking and filed the gap
// as BACKEND_GAP-C15-002.
//
// Additive: the provider route is untouched. Access is assertBookingAccess in
// the controller — the same check /:id and /:id/tracking use — and the events
// are re-voiced for the customer, because the shared builder is written from
// the provider's seat where "YOU" means the provider.
//
// Registered after /:id deliberately: a two-segment path cannot be shadowed by
// the single-segment wildcard above, and keeping it beside /:id/tracking is
// what makes the pair obvious to the next reader.
router.get("/:id/timeline", verifyAuth, bookingController.getCustomerBookingTimeline);
export default router;
