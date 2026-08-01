import { Request, Response } from "express";
import {
  assertBookingAccess,
  sendBookingAccessError,
  BookingAccessError,
} from "../services/bookingAccessService";
import * as paymentService from "../services/paymentService";
import { toCamel } from "../helpers/idGenerator";
export const gcashSubmit = async (req: Request, res: Response) => {
  try {
    const bookingId = Number(req.params.bookingId);
    // Payment evidence is attached to someone's booking — prove entitlement
    // before accepting it (§11, §43).
    await assertBookingAccess(bookingId, (req as any).user?.uid);
    const { referenceNo, proofUrl } = req.body;

    if (!referenceNo) {
      return res.status(400).json({ success: false, message: "referenceNo is required" });
    }

    const payment = await paymentService.submitGcash(bookingId, referenceNo, proofUrl);
    res.json({ success: true, payment: toCamel(payment) });
  } catch (e: any) {
    if (sendBookingAccessError(res, e)) return;
    res.status(400).json({ success: false, message: e.message });
  }
};

/**
 * Settling a payment is not the same as submitting evidence for one.
 *
 * `gcashSubmit` only attaches a reference the customer claims to have paid;
 * these two flip `payments.status` to PAID and fire an earnings notification to
 * the provider. That must never be self-service: a customer declaring their own
 * cash collected is the fraud case (§43 separates declaration, evidence and
 * verification).
 *
 * So ownership alone is not enough here — the actor must also be the provider
 * doing the collecting or an admin.
 */
const assertMaySettlePayment = async (req: Request, bookingId: number) => {
  const role = await assertBookingAccess(bookingId, (req as any).user?.uid);
  if (role === "customer") {
    throw new BookingAccessError(
      "Payment settlement is recorded by the provider or Servana, not by the customer",
      403,
      "BOOKING_ACCESS_DENIED",
    );
  }
  return role;
};

export const approve = async (req: Request, res: Response) => {
  try {
    const bookingId = Number(req.params.bookingId);
    await assertMaySettlePayment(req, bookingId);
    const payment = await paymentService.approvePayment(bookingId);
    res.json({ status: "success", data: toCamel(payment) });
  } catch (e: any) {
    if (sendBookingAccessError(res, e)) return;
    res.status(400).json({ status: "failed", message: e.message });
  }
};

export const markCashPaid = async (req: Request, res: Response) => {
  try {
    const bookingId = Number(req.params.bookingId);
    await assertMaySettlePayment(req, bookingId);
    const payment = await paymentService.markCashPaid(bookingId);
    res.json({ status: "success", data: toCamel(payment) });
  } catch (e: any) {
    if (sendBookingAccessError(res, e)) return;
    res.status(400).json({ status: "failed", message: e.message });
  }
};

export const createPaymongoPayment = async (req: Request, res: Response) => {
  try {
    const bookingId = Number(req.params.bookingId);
    await assertBookingAccess(bookingId, (req as any).user?.uid);

    const result = await paymentService.createCheckoutSession(bookingId);

    return res.json({
      success: true,
      checkout_url: result.checkout_url
    });

  } catch (error: any) {
    if (sendBookingAccessError(res, error)) return;

    return res.status(400).json({
      success: false,
      message: error.message
    });

  }
};

export const paymongoWebhook = async (req: Request, res: Response) => {
  try {
    await paymentService.processWebhook(req, res);
    // processWebhook now throws on all error paths — this 200 is the only response sent.
    res.status(200).json({ received: true });
  } catch (error: any) {
    const isSignatureError = error?.message === "Invalid signature" || error?.message === "Missing signature header";
    res.status(isSignatureError ? 401 : 400).json({
      success: false,
      message: error.message,
    });
  }
};