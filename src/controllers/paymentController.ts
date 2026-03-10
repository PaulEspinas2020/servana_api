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
    res.json({ success: true, payment: toCamel(payment) });
  } catch (e: any) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const markCashPaid = async (req: Request, res: Response) => {
  try {
    const bookingId = Number(req.params.bookingId);
    const payment = await paymentService.markCashPaid(bookingId);
    res.json({ success: true, payment: toCamel(payment) });
  } catch (e: any) {
    res.status(400).json({ success: false, message: e.message });
  }
};
