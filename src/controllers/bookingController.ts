import { Request, Response } from "express";
import {
  assertBookingAccess,
  sendBookingAccessError,
} from "../services/bookingAccessService";
import * as bookingService from "../services/bookingService";
import { formatBooking, formatBookings } from "../services/bookingService";
import { createCustomerNotification } from "../services/notification.service";
export const createBooking = async (req: any, res: any) => {
  try {
    // Identity comes from the verified token, never from the query string.
    // `?userId=` was previously authoritative, which let any caller create a
    // booking in any customer's name (§7: route params are not identity).
    // The parameter is still accepted and ignored so existing clients keep
    // working; a mismatch is logged without PII so drift stays visible.
    const userId = (req as any).user?.uid as string;
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
    const booking = await bookingService.createBooking(
      userId,
      req.body
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
    res.status(400).json({ success: false, message: e.message });
  }
};


export const confirmOtp = async (req: Request, res: Response) => {
  try {
    const bookingId = Number(req.params.id);
    const otp = (req.query?.otp || "").toString().trim();

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

    // When the caller has a verified JWT (browser session), enforce ownership.
    // Mobile clients call without a token — unauthenticated path is unchanged for parity.
    const actor = (req as any).user;
    if (actor?.uid && actor.uid !== userId) {
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