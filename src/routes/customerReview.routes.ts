import { Router } from "express";
import { verifyAuth } from "../middleware/verifyAuth";
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
router.get(   "/bookings/:bookingId/review-eligibility", verifyAuth, checkEligibility);
router.post(  "/bookings/:bookingId/reviews",            verifyAuth, create);
router.get(   "/bookings/:bookingId/reviews",            verifyAuth, getByBooking);

// ─── Customer: review-scoped ──────────────────────────────────────────────────
// GET    /api/reviews/:reviewId
// PUT    /api/reviews/:reviewId
// DELETE /api/reviews/:reviewId
// POST   /api/reviews/:reviewId/report
router.get(   "/reviews/:reviewId",        verifyAuth, getById);
router.put(   "/reviews/:reviewId",        verifyAuth, edit);
router.delete("/reviews/:reviewId",        verifyAuth, remove);
router.post(  "/reviews/:reviewId/report", verifyAuth, report);

// ─── Customer: review history ─────────────────────────────────────────────────
// GET /api/reviews/me
router.get("/reviews/me", verifyAuth, listMine);

// ─── Public: provider reviews (no auth required) ──────────────────────────────
// GET /api/providers/:providerUid/reviews
// GET /api/providers/:providerUid/rating
router.get("/providers/:providerUid/reviews", listForProvider);
router.get("/providers/:providerUid/rating",  providerAggregate);

export default router;
