import { Request, Response } from "express";
import {
  ensureReviewTables,
  getReviewEligibility,
  createReview,
  getReviewByBooking,
  getReviewById,
  editReview,
  deleteReview,
  listCustomerReviews,
  listProviderReviews,
  getProviderAggregate,
  reportReview,
} from "../services/customerReviewService";

async function init() {
  await ensureReviewTables();
}
init().catch(console.error);

// ─── Eligibility ──────────────────────────────────────────────────────────────

export async function checkEligibility(req: Request, res: Response) {
  const customerUid = req.user?.uid as string;
  const { bookingId } = req.params;
  try {
    const result = await getReviewEligibility(bookingId, customerUid);
    return res.json(result);
  } catch (e: any) {
    return res.status(e.status || 500).json({ error: e.code || "SERVER_ERROR" });
  }
}

// ─── Create ───────────────────────────────────────────────────────────────────

export async function create(req: Request, res: Response) {
  const customerUid = req.user?.uid as string;
  const { bookingId } = req.params;
  const {
    overallRating,
    dimensions    = {},
    publicComment  = null,
    privateFeedback = null,
    visibility     = "PUBLIC",
    clientRequestId = null,
  } = req.body as Record<string, unknown>;

  try {
    const review = await createReview({
      bookingId,
      customerUid,
      overallRating:   Number(overallRating),
      dimensions:      (dimensions as Record<string, number>) || {},
      publicComment:   typeof publicComment  === "string" ? publicComment  : null,
      privateFeedback: typeof privateFeedback=== "string" ? privateFeedback: null,
      visibility:      typeof visibility     === "string" ? visibility     : "PUBLIC",
      clientRequestId: typeof clientRequestId=== "string" ? clientRequestId: null,
    });
    return res.status(201).json(review);
  } catch (e: any) {
    if (e.code === "REVIEW_DUPLICATE_REQUEST") {
      return res.status(409).json({ error: e.code, message: e.message });
    }
    return res.status(e.status || 500).json({ error: e.code || "SERVER_ERROR", message: e.message });
  }
}

// ─── Get by booking ───────────────────────────────────────────────────────────

export async function getByBooking(req: Request, res: Response) {
  const customerUid = req.user?.uid as string;
  const { bookingId } = req.params;
  try {
    const review = await getReviewByBooking(bookingId, customerUid);
    if (!review) return res.status(404).json({ error: "REVIEW_NOT_FOUND" });
    return res.json(review);
  } catch (e: any) {
    return res.status(e.status || 500).json({ error: e.code || "SERVER_ERROR" });
  }
}

// ─── Get by ID ────────────────────────────────────────────────────────────────

export async function getById(req: Request, res: Response) {
  const customerUid = req.user?.uid as string;
  const { reviewId } = req.params;
  try {
    const review = await getReviewById(reviewId, customerUid);
    if (!review) return res.status(404).json({ error: "REVIEW_NOT_FOUND" });
    return res.json(review);
  } catch (e: any) {
    return res.status(e.status || 500).json({ error: e.code || "SERVER_ERROR" });
  }
}

// ─── Edit ─────────────────────────────────────────────────────────────────────

export async function edit(req: Request, res: Response) {
  const customerUid = req.user?.uid as string;
  const { reviewId } = req.params;
  const {
    overallRating,
    dimensions    = {},
    publicComment  = null,
    privateFeedback = null,
    visibility     = "PUBLIC",
  } = req.body as Record<string, unknown>;

  try {
    const updated = await editReview(
      reviewId,
      customerUid,
      Number(overallRating),
      (dimensions as Record<string, number>) || {},
      typeof publicComment  === "string" ? publicComment  : null,
      typeof privateFeedback=== "string" ? privateFeedback: null,
      typeof visibility     === "string" ? visibility     : "PUBLIC",
    );
    return res.json(updated);
  } catch (e: any) {
    return res.status(e.status || 500).json({ error: e.code || "SERVER_ERROR", message: e.message });
  }
}

// ─── Delete ───────────────────────────────────────────────────────────────────

export async function remove(req: Request, res: Response) {
  const customerUid = req.user?.uid as string;
  const { reviewId } = req.params;
  try {
    await deleteReview(reviewId, customerUid);
    return res.json({ deleted: true });
  } catch (e: any) {
    return res.status(e.status || 500).json({ error: e.code || "SERVER_ERROR" });
  }
}

// ─── Customer review history ──────────────────────────────────────────────────

export async function listMine(req: Request, res: Response) {
  const customerUid = req.user?.uid as string;
  try {
    const reviews = await listCustomerReviews(customerUid);
    return res.json({ reviews });
  } catch (e: any) {
    return res.status(500).json({ error: "SERVER_ERROR" });
  }
}

// ─── Provider public reviews ──────────────────────────────────────────────────

export async function listForProvider(req: Request, res: Response) {
  const { providerUid } = req.params;
  const limit  = Math.min(Number(req.query.limit  ?? 20), 50);
  const offset = Number(req.query.offset ?? 0);
  try {
    const data = await listProviderReviews(providerUid, limit, offset);
    return res.json(data);
  } catch (e: any) {
    return res.status(500).json({ error: "SERVER_ERROR" });
  }
}

// ─── Provider aggregate ───────────────────────────────────────────────────────

export async function providerAggregate(req: Request, res: Response) {
  const { providerUid } = req.params;
  try {
    const agg = await getProviderAggregate(providerUid);
    return res.json(agg);
  } catch (e: any) {
    return res.status(500).json({ error: "SERVER_ERROR" });
  }
}

// ─── Report review ────────────────────────────────────────────────────────────

export async function report(req: Request, res: Response) {
  const reporterUid = req.user?.uid as string;
  const { reviewId } = req.params;
  const { reason = "OTHER", details = null } = req.body as Record<string, unknown>;
  try {
    await reportReview(
      reviewId,
      reporterUid,
      typeof reason === "string" ? reason : "OTHER",
      typeof details === "string" ? details : null,
    );
    return res.json({ reported: true });
  } catch (e: any) {
    return res.status(e.status || 500).json({ error: e.code || "SERVER_ERROR" });
  }
}
