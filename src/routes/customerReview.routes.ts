import { Router } from "express";
import verifyAuth from "../middleware/verifyAuth";
import verifyRoles from "../middleware/verifyRoles";
import {
  checkEligibility,
  create,
  getByBooking,
  getById,
  edit,
  remove,
  listMine,
  listForProvider,
  providerAggregate,
  report,
} from "../controllers/customerReviewController";

const router = Router();

// ─── Customer: booking-scoped ─────────────────────────────────────────────────
// GET  /api/bookings/:bookingId/review-eligibility
// POST /api/bookings/:bookingId/reviews
// GET  /api/bookings/:bookingId/reviews
router.get(   "/bookings/:bookingId/review-eligibility", verifyAuth, verifyRoles([3]), checkEligibility);
router.post(  "/bookings/:bookingId/reviews",            verifyAuth, verifyRoles([3]), create);
router.get(   "/bookings/:bookingId/reviews",            verifyAuth, verifyRoles([3]), getByBooking);

// ─── Customer: review history (MUST precede /:reviewId to avoid route shadowing)
// GET /api/reviews/me
router.get("/reviews/me", verifyAuth, verifyRoles([3]), listMine);

// ─── Customer: review-scoped ──────────────────────────────────────────────────
// GET    /api/reviews/:reviewId
// PUT    /api/reviews/:reviewId
// DELETE /api/reviews/:reviewId
// POST   /api/reviews/:reviewId/report
router.get(   "/reviews/:reviewId",        verifyAuth, verifyRoles([3]), getById);
router.put(   "/reviews/:reviewId",        verifyAuth, verifyRoles([3]), edit);
router.delete("/reviews/:reviewId",        verifyAuth, verifyRoles([3]), remove);
router.post(  "/reviews/:reviewId/report", verifyAuth, verifyRoles([3]), report);

// ─── Public: provider reviews (no auth required) ──────────────────────────────
// GET /api/providers/:providerUid/reviews
// GET /api/providers/:providerUid/rating
router.get("/providers/:providerUid/reviews", listForProvider);
router.get("/providers/:providerUid/rating",  providerAggregate);

export default router;
