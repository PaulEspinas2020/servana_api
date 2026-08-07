import { Request, Response } from "express";
import { additionalService } from "../services/additional.service";

export const createRequest = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ success: false, message: "Unauthorized" });
    const { bookingId, items } = req.body;
    const booking = await additionalService.authorizeBookingActor(Number(bookingId), uid, "provider");
    const result = await additionalService.createRequest(Number(bookingId), items, String(booking.user_id));
    res.json({ success: true, data: result });
  } catch (e: any) {
    const status = e?.statusCode ?? 500;
    res.status(status).json({ success: false, message: status === 500 ? "Server error" : e.message });
  }
};

export const approveRequest = async (req: Request, res: Response) => {
  try {
    await additionalService.approve(Number(req.params.id));
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ success: false, message: e.message });
  }
};

export const generatePayment = async (req: Request, res: Response) => {
  try {
    const link = await additionalService.generatePayment(Number(req.params.id));
    res.json({ success: true, data: link });
  } catch (e: any) {
    res.status(500).json({ success: false, message: e.message });
  }
};

export const workerDecision = async (req: Request, res: Response) => {
  try {
    const { decision } = req.body;
    await additionalService.workerDecision(Number(req.params.id), decision);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ success: false, message: e.message });
  }
};

export const workerWithdraw = async (req: Request, res: Response) => {
  try {
    await additionalService.workerWithdraw(Number(req.params.id));
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ success: false, message: e.message });
  }
};

export const workerConfirmProceed = async (req: Request, res: Response) => {
  try {
    await additionalService.workerConfirmProceed(Number(req.params.id));
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ success: false, message: e.message });
  }
};

export const getByBooking = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ success: false, message: "Unauthorized" });
    const bookingId = Number(req.params.bookingId);
    await additionalService.authorizeBookingActor(bookingId, uid, "participant");
    const data = await additionalService.getByBooking(bookingId);
    res.json({ success: true, data });
  } catch (e: any) {
    const status = e?.statusCode ?? 500;
    res.status(status).json({ success: false, message: status === 500 ? "Server error" : e.message });
  }
};
