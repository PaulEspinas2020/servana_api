import { Request, Response } from "express";
import * as paymentService from "../services/paymentService";

export const gcashSubmit = async (req: Request, res: Response) => {
  try {
    const bookingId = Number(req.params.bookingId);
    const { reference_no, proof_url } = req.body;

    if (!reference_no) {
      return res.status(400).json({ success: false, message: "reference_no is required" });
    }

    const payment = await paymentService.submitGcash(bookingId, reference_no, proof_url);
    res.json({ success: true, payment });
  } catch (e: any) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const approve = async (req: Request, res: Response) => {
  try {
    const bookingId = Number(req.params.bookingId);
    const payment = await paymentService.approvePayment(bookingId);
    res.json({ success: true, payment });
  } catch (e: any) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const markCashPaid = async (req: Request, res: Response) => {
  try {
    const bookingId = Number(req.params.bookingId);
    const payment = await paymentService.markCashPaid(bookingId);
    res.json({ success: true, payment });
  } catch (e: any) {
    res.status(400).json({ success: false, message: e.message });
  }
};
