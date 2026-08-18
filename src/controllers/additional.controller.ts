import { Request, Response } from "express";
import { additionalService } from "../services/additional.service";
import {
  assertBookingAccess,
  sendBookingAccessError,
} from "../services/bookingAccessService";
import { resolvePaymentReturnOrigin } from "../services/paymentReturnOrigin";

const actorUid = (req: Request): string | undefined => (req as any).user?.uid;

const sendError = (res: Response, error: any) => {
  if (sendBookingAccessError(res, error)) return;
  const status = [400, 404, 409].includes(Number(error?.statusCode))
    ? Number(error.statusCode)
    : 500;
  res.status(status).json({
    success: false,
    code: error?.code ?? "ADDITIONAL_WORK_FAILED",
    message: status === 500 ? "Additional work request failed" : error.message,
  });
};

const requestBookingId = async (rawId: unknown): Promise<number> => {
  const id = Number(rawId);
  const context = await additionalService.getRequestContext(id);
  return Number(context.booking_id);
};

export const createRequest = async (req: Request, res: Response) => {
  try {
    const { bookingId, items } = req.body;
    const parsedBookingId = Number(bookingId);
    const uid = actorUid(req);
    const role = await assertBookingAccess(parsedBookingId, uid);
    if (role !== "provider") {
      return res.status(403).json({
        success: false,
        code: "PROVIDER_ACTION_REQUIRED",
        message: "Only the assigned provider can submit additional work",
      });
    }
    // Keep :userId in the URL for already-deployed provider-web builds, but do
    // not use it as identity. The authenticated provider and booking relation
    // are authoritative.
    const result = await additionalService.createRequest(parsedBookingId, items, uid!);
    res.json({ success: true, data: result });
  } catch (e: any) {
    sendError(res, e);
  }
};

export const approveRequest = async (req: Request, res: Response) => {
  try {
    const result = await additionalService.approve(Number(req.params.id));
    res.json({ success: true, data: result });
  } catch (e: any) {
    sendError(res, e);
  }
};

export const generatePayment = async (req: Request, res: Response) => {
  try {
    const bookingId = await requestBookingId(req.params.id);
    const role = await assertBookingAccess(bookingId, actorUid(req));
    if (role === "provider") {
      return res.status(403).json({
        success: false,
        code: "CUSTOMER_PAYMENT_REQUIRED",
        message: "Only the booking customer or an administrator can create this payment",
      });
    }
    const link = await additionalService.generatePayment(Number(req.params.id), {
      returnOrigin: resolvePaymentReturnOrigin(req),
    });
    res.json({ success: true, data: link });
  } catch (e: any) {
    sendError(res, e);
  }
};

export const workerDecision = async (req: Request, res: Response) => {
  try {
    const { decision } = req.body;
    if (!["ACCEPT", "REJECT"].includes(decision)) {
      return res.status(400).json({ success: false, message: "decision must be ACCEPT or REJECT" });
    }
    const bookingId = await requestBookingId(req.params.id);
    const role = await assertBookingAccess(bookingId, actorUid(req));
    if (role !== "provider") {
      return res.status(403).json({ success: false, code: "PROVIDER_ACTION_REQUIRED", message: "Provider access required" });
    }
    const data = await additionalService.workerDecision(
      Number(req.params.id),
      decision as "ACCEPT" | "REJECT",
    );
    res.json({ success: true, data });
  } catch (e: any) {
    sendError(res, e);
  }
};

export const workerWithdraw = async (req: Request, res: Response) => {
  try {
    const bookingId = await requestBookingId(req.params.id);
    const role = await assertBookingAccess(bookingId, actorUid(req));
    if (role !== "provider") {
      return res.status(403).json({ success: false, code: "PROVIDER_ACTION_REQUIRED", message: "Provider access required" });
    }
    const data = await additionalService.workerWithdraw(Number(req.params.id));
    res.json({ success: true, data });
  } catch (e: any) {
    sendError(res, e);
  }
};

export const workerConfirmProceed = async (req: Request, res: Response) => {
  try {
    const bookingId = await requestBookingId(req.params.id);
    const role = await assertBookingAccess(bookingId, actorUid(req));
    if (role !== "provider") {
      return res.status(403).json({ success: false, code: "PROVIDER_ACTION_REQUIRED", message: "Provider access required" });
    }
    const data = await additionalService.workerConfirmProceed(Number(req.params.id));
    res.json({ success: true, data });
  } catch (e: any) {
    sendError(res, e);
  }
};

export const getByBooking = async (req: Request, res: Response) => {
  try {
    const bookingId = Number(req.params.bookingId);
    await assertBookingAccess(bookingId, actorUid(req));
    const data = await additionalService.getByBooking(bookingId);
    res.json({ success: true, data });
  } catch (e: any) {
    sendError(res, e);
  }
};
