import { Request, Response } from "express";
import {
  assertBookingAccess,
  sendBookingAccessError,
} from "../services/bookingAccessService";
import * as bookingService from "../services/bookingService";
import { formatBooking, formatBookings } from "../services/bookingService";
import {
  normaliseIdempotencyKey,
  findBookingByIdempotencyKey,
} from "../services/bookingIdempotency";
import { createCustomerNotification } from "../services/notification.service";
import { validateCustomerBookingCreatePayload } from "../services/bookingCreateValidation";
export const createBooking = async (req: any, res: any) => {
  let idempotencyKey: string | null = null;
  let userId = '';
  try {
    // Identity comes from the verified token, never from the query string.
    // `?userId=` was previously authoritative, which let any caller create a
    // booking in any customer's name (§7: route params are not identity).
    // The parameter is still accepted and ignored so existing clients keep
    // working; a mismatch is logged without PII so drift stays visible.
    userId = (req as any).user?.uid as string;
    const claimedUserId = req.query.userId as string | undefined;
    if (claimedUserId && claimedUserId !== userId) {
      console.warn(
        "[booking.create] ignoring ?userId= that does not match the token subject",
      );
    }
    if (!userId) {
      return res.status(401).json({
        success: false,
        code: "UNAUTHENTICATED",
        message: "Authentication is required",
      });
    }
    // Duplicate-submission protection.
    //
    // ServanaClient generates a key per booking draft and sends it as
    // X-Idempotency-Key, holding it until the backend confirms
    // (draft_repository.getOrCreateIdempotencyKey). This endpoint read it
    // nowhere, so a retried submit created a SECOND booking and a second
    // payment row — and the client's whole recovery layer exists because
    // requests on Philippine mobile networks are expected to time out and be
    // retried. A timeout that had actually succeeded charged the customer twice
    // and dispatched two providers.
    //
    // The key is optional: older clients do not send one, and rejecting those
    // would break every shipped app in order to fix a duplicate-submission bug.
    // A caller without a key simply gets no protection, exactly as before.
    idempotencyKey = normaliseIdempotencyKey(
      req.header('X-Idempotency-Key'),
    );

    const alreadyCreated = await findBookingByIdempotencyKey(
      idempotencyKey,
      userId,
    );
    if (alreadyCreated) {
      // Return the ORIGINAL booking, not an error. A retry is the client
      // asking "did that land?", and the honest answer is the booking it
      // created. 200 with the same body makes the retry indistinguishable from
      // the first success, which is the point of idempotency (§17).
      const existing = await bookingService.getBookingById(alreadyCreated);
      if (existing) {
        return res.json({
          success: true,
          booking: formatBooking(existing),
          idempotentReplay: true,
        });
      }
      // The row is recorded but the booking is gone — deleted, or a partial
      // write. Falling through to create is wrong (it would duplicate) and so
      // is pretending success. Say so.
      return res.status(409).json({
        success: false,
        code: 'IDEMPOTENCY_KEY_REUSED',
        message:
          'This request was already processed but its booking is no longer available.',
      });
    }

    const validatedPayload = validateCustomerBookingCreatePayload(req.body);
    const booking = await bookingService.createBooking(
      userId,
      validatedPayload,
      idempotencyKey,
    );

    // Non-blocking: notify the customer that their booking was received
    if (userId && booking) {
      const bookingId = (booking as any)?.id ?? (booking as any)?.bookingId ?? '';
      createCustomerNotification(userId, {
        type: 'booking_created',
        severity: 'info',
        title: 'Booking received',
        safeBody: `Your booking has been placed. We'll notify you when a provider is assigned.`,
        route: bookingId
          ? { routeKey: 'BOOKING_DETAILS', resourceId: String(bookingId) }
          : null,
        canOpenDetail: !!bookingId,
      }).catch(() => {});
    }

    res.json({ success: true, booking });
  } catch (e: any) {
    if (
      e?.code === '23505' &&
      String(e?.constraint ?? '').includes('idempotency') &&
      idempotencyKey &&
      userId
    ) {
      const existingId = await findBookingByIdempotencyKey(idempotencyKey, userId);
      const existing = existingId
        ? await bookingService.getBookingById(existingId)
        : null;
      if (existing) {
        return res.json({
          success: true,
          booking: formatBooking(existing),
          idempotentReplay: true,
        });
      }
    }
    const status = Number.isInteger(e?.statusCode) ? e.statusCode : 400;
    res.status(status).json({ success: false, code: e?.code, message: e.message });
  }
};


export const confirmOtp = async (req: Request, res: Response) => {
  try {
    const bookingId = Number(req.params.id);

    // Body first, query as a fallback.
    //
    // The OTP used to arrive ONLY as `?otp=123456`. A query string is written
    // to the nginx access log for every request, so each booking verification
    // deposited a live credential into a plaintext log that is rotated, backed
    // up and readable by anyone with host access. The OTP is what proves the
    // customer is present, so that is a credential in a log.
    //
    // The route is already POST, so the body was always available and simply
    // unused. Reading both keeps every already-installed client working —
    // 1.0.0+36 sends the query form and cannot be changed retroactively — while
    // letting the app move the value into the body. Drop the query branch once
    // the query-sending builds are out of circulation.
    const otp = (req.body?.otp ?? req.query?.otp ?? "").toString().trim();

    if (!bookingId || Number.isNaN(bookingId)) {
      return res.status(400).json({ success: false, message: "Invalid booking id" });
    }
    if (!otp) {
      return res.status(400).json({ success: false, message: "otp is required" });
    }

    // The OTP proves the customer is present; it does not prove the caller is
    // entitled to this booking. Check both (§11).
    await assertBookingAccess(bookingId, (req as any).user?.uid);

    const booking = await bookingService.confirmOtp(bookingId, otp);

    return res.json({ success: true, booking: formatBooking(booking) });
  } catch (e: any) {
    return res.status(400).json({ success: false, message: e.message });
  }
};

/**
 * POST /api/:bookingId/resend-otp
 *
 * The OTP screen's Resend button has always called this; it did not exist. A
 * customer whose verification email never arrived had no recovery — the booking
 * sat in PENDING_OTP and the only way forward was a code they never received.
 */
export const resendOtp = async (req: Request, res: Response) => {
  try {
    const bookingId = Number(req.params.bookingId ?? req.params.id);

    if (!bookingId || Number.isNaN(bookingId)) {
      return res.status(400).json({ success: false, message: "Invalid booking id" });
    }

    // Same authorization as every other booking route: possession of an id is
    // not entitlement (§11). Without this, anyone could rotate the OTP on any
    // booking and lock the real customer out of confirming it.
    await assertBookingAccess(bookingId, (req as any).user?.uid);

    const result = await bookingService.resendBookingOtp(bookingId);
    return res.json({ success: true, ...result });
  } catch (e: any) {
    if (sendBookingAccessError(res, e)) return;
    return res
      .status(e?.statusCode === 409 ? 409 : 400)
      .json({ success: false, message: e.message });
  }
};

export const getBooking = async (req: Request, res: Response) => {
  try {
    const bookingId = Number(req.params.id);

    if (!bookingId || Number.isNaN(bookingId)) {
      return res.status(400).json({ success: false, message: "Invalid booking id" });
    }

    // Authorization before retrieval: booking ids are sequential integers,
    // so an unscoped read here exposed every customer's name, phone and
    // address by enumeration (§11).
    await assertBookingAccess(bookingId, (req as any).user?.uid);

    const booking = await bookingService.getBookingById(bookingId);

    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }

    return res.json({ success: true, booking: formatBooking(booking) });
  } catch (e: any) {
    if (sendBookingAccessError(res, e)) return;
    return res.status(500).json({ success: false, message: e.message });
  }
};

export const listAllBookings = async (req: Request, res: Response) => {
  try {
    const from = req.query.from as string | undefined;
    const to   = req.query.to   as string | undefined;
    const bookings = await bookingService.getAllBookings(from, to);
    res.json({ success: true, bookings: formatBookings(bookings) });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch bookings",
    });
  }
};

export const listUserBookings = async (req: Request, res: Response) => {
  try {
    const userId = req.params.userId as string;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "Invalid userId",
      });
    }

    // Fail closed: the actor must be present AND match.
    //
    // This previously required the actor to exist before comparing, so a missing
    // actor skipped ownership entirely. That was safe only for as long as the
    // route in front stayed authenticated — an invariant held in a comment
    // rather than in code. The same shape one layer down, in
    // customerCancelBooking, was NOT safe: it keyed on a booking owner that is
    // NULL for guest bookings, and let any authenticated user cancel any guest
    // booking. Removing verifyAuthOptional in bd8c355 removed the carrier of
    // this pattern, not the pattern.
    //
    // The "mobile calls without a token" note that used to sit here was wrong:
    // ServanaClient attaches a bearer token to every request
    // (servana_api_client.dart:37-47).
    const actor = (req as any).user;
    if (!actor?.uid || actor.uid !== userId) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    const bookings = await bookingService.getBookingsByUserId(userId);
    res.json({ success: true, bookings: formatBookings(bookings) });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch user bookings",
    });
  }
};

export const getTracking = async (req: Request, res: Response) => {
  try {
    const bookingId = Number(req.params.id);

    await assertBookingAccess(bookingId, (req as any).user?.uid);

    if (!bookingId || Number.isNaN(bookingId)) {
      return res.status(400).json({ success: false, message: "Invalid booking id" });
    }

    // If you have auth: const userId = (req as any).user?.uid;
    const tracking = await bookingService.getTracking(bookingId /*, userId */);
    return res.json({ success: true, tracking: formatBookings(tracking) });
  } catch (e: any) {
    if (sendBookingAccessError(res, e)) return;
    return res.status(500).json({ success: false, message: e.message });
  }
};

export const getAnalytics = async (_req: Request, res: Response) => {
  try {
    const data = await bookingService.getDashboardAnalytics();

    return res.json({
      success: true,
      data,
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch analytics",
    });
  }
};

// BACKEND_GAP-C15-001: customer self-cancellation (previously admin-only)
export const cancelBooking = async (req: Request, res: Response) => {
  try {
    const bookingId = Number(req.params.id);
    if (!bookingId || isNaN(bookingId)) {
      return res.status(400).json({ success: false, message: 'Invalid booking id' });
    }

    const { reason, reasonCode } = req.body;
    if (!reason?.trim()) {
      return res.status(400).json({ success: false, message: 'reason is required' });
    }

    const customerUid = (req as any).user?.uid ?? null;
    const booking = await bookingService.customerCancelBooking(
      bookingId, reason, customerUid, reasonCode,
    );

    return res.json({ success: true, booking: formatBooking(booking) });
  } catch (e: any) {
    const status = e.statusCode === 403 ? 403 : 400;
    return res.status(status).json({ success: false, message: e.message || 'Cancellation failed' });
  }
};

/**
 * The customer-facing booking timeline.
 *
 * Command 6 §11. The timeline logic already existed and was reachable only at
 * `GET /provider/bookings/:bookingId/timeline`, behind `requireProviderRole` —
 * so a customer had no authoritative history of their own booking, and the
 * customer mobile app worked around it by delegating to `/:id/tracking`
 * (BACKEND_GAP-C15-002 in `servana_api_client.dart`).
 *
 * This exposes the same builder to the booking's owner. It is additive: the
 * provider route, its query and its response are untouched, and
 * `booking-timeline-projection.test.ts` pins that the provider projection still
 * reads in provider voice.
 *
 * ## Two differences from the provider handler, both deliberate
 *
 * **The events are re-voiced.** `buildBookingTimeline` is provider-seat
 * throughout — see `projectTimelineForCustomer`. Serving its output verbatim
 * would tell a customer "You marked yourself arrived" about their professional
 * while attributing their own booking creation to somebody else.
 *
 * **The reassignment gate is not applied.** In the provider handler,
 * `is_current_assignee` stops a replaced provider seeing admin events that
 * happened after they lost the booking. A customer never loses their own
 * booking, so the gate has nothing to protect against here and withholding
 * their own history would be the bug.
 *
 * Access is `assertBookingAccess`, the same check `GET /:id` and `/:id/tracking`
 * use: the customer, the actively-assigned provider, or an admin. A booking
 * belonging to somebody else answers 403, and an unknown id answers 404, so this
 * cannot be used to probe which booking ids exist.
 */
export const getCustomerBookingTimeline = async (req: Request, res: Response) => {
  try {
    const bookingId = Number(req.params.id);
    if (!bookingId || Number.isNaN(bookingId)) {
      return res.status(400).json({ success: false, message: "Invalid booking id" });
    }

    await assertBookingAccess(bookingId, (req as any).user?.uid);

    const timeline = await bookingService.getCustomerBookingTimeline(bookingId);
    return res.json({ success: true, timeline });
  } catch (e: any) {
    if (sendBookingAccessError(res, e)) return;
    return res.status(500).json({ success: false, message: "Server error" });
  }
};
