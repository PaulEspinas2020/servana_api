import { Request, Response } from "express";
import { additionalService } from "../services/additional.service";

export const createRequest = async (req: Request, res: Response) => {
  try {
    const { userId } = req.params as { userId: string };
    const { bookingId, items } = req.body;
    const result = await additionalService.createRequest(bookingId, items, userId);
    res.json({ success: true, data: result });
  } catch (e: any) {
    res.status(500).json({ success: false, message: e.message });
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
    const data = await additionalService.getByBooking(Number(req.params.bookingId));
    res.json({ success: true, data });
  } catch (e: any) {
    res.status(500).json({ success: false, message: e.message });
  }
};
