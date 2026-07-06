import { Request, Response } from "express";
import * as paymentService from "../services/paymentService";
import { toCamel } from "../helpers/idGenerator";
export const gcashSubmit = async (req: Request, res: Response) => {
  try {
    const bookingId = Number(req.params.bookingId);
    const { referenceNo, proofUrl } = req.body;

    if (!referenceNo) {
      return res.status(400).json({ success: false, message: "referenceNo is required" });
    }

    const payment = await paymentService.submitGcash(bookingId, referenceNo, proofUrl);
    res.json({ success: true, payment: toCamel(payment) });
  } catch (e: any) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const approve = async (req: Request, res: Response) => {
  try {
    const bookingId = Number(req.params.bookingId);
    const payment = await paymentService.approvePayment(bookingId);
    res.json({ status: "success", data: toCamel(payment) });
  } catch (e: any) {
    res.status(400).json({ status: "failed", message: e.message });
  }
};

export const markCashPaid = async (req: Request, res: Response) => {
  try {
    const bookingId = Number(req.params.bookingId);
    const payment = await paymentService.markCashPaid(bookingId);
    res.json({ status: "success", data: toCamel(payment) });
  } catch (e: any) {
    res.status(400).json({ status: "failed", message: e.message });
  }
};

export const createPaymongoPayment = async (req: Request, res: Response) => {
  try {
    const bookingId = Number(req.params.bookingId);

    const result = await paymentService.createCheckoutSession(bookingId);

    return res.json({
      success: true,
      checkout_url: result.checkout_url
    });

  } catch (error: any) {

    return res.status(400).json({
      success: false,
      message: error.message
    });

  }
};

export const paymongoWebhook = async (req: Request, res: Response) => {
  try {
    console.log("PAYMONGO WEBHOOK HIT");
    console.log("Headers:", req.headers);
    console.log("Body:", req.body);
    console.log("RawBody:", (req as any).rawBody);

    await paymentService.processWebhook(req, res);

    res.status(200).json({ received: true });

  } catch (error: any) {

    res.status(400).json({
      success: false,
      message: error.message
    });

  }
};