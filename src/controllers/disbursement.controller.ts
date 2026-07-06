import { Request, Response } from "express";
import * as disbursementService from "../services/disbursement.service";
import { toCamel } from "../helpers/idGenerator";

export const list = async (req: Request, res: Response) => {
  try {
    const { status, workerUid } = req.query as Record<string, string>;
    const rows = await disbursementService.listDisbursements({ status, workerUid });
    res.json({ success: true, disbursements: rows.map(toCamel) });
  } catch (e: any) {
    res.status(500).json({ success: false, message: e.message });
  }
};

export const getByBooking = async (req: Request, res: Response) => {
  try {
    const bookingId = Number(req.params.bookingId);
    const row = await disbursementService.getDisbursementByBooking(bookingId);
    if (!row) return res.status(404).json({ success: false, message: "Disbursement not found" });
    res.json({ success: true, disbursement: toCamel(row) });
  } catch (e: any) {
    res.status(500).json({ success: false, message: e.message });
  }
};

export const retry = async (req: Request, res: Response) => {
  try {
    const disbursementId = Number(req.params.id);
    const row = await disbursementService.manualRetry(disbursementId);
    res.json({ success: true, disbursement: toCamel(row) });
  } catch (e: any) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const triggerNow = async (_req: Request, res: Response) => {
  try {
    await disbursementService.processPendingDisbursements();
    res.json({ success: true, message: "Disbursement run complete" });
  } catch (e: any) {
    res.status(500).json({ success: false, message: e.message });
  }
};
