import { Request, Response } from "express";
import { additionalService } from "../services/additional.service";

export const createRequest = async (req: Request, res: Response) => {
   const { userId } = req.params as { userId: string };
  const { bookingId, items } = req.body;

  const result = await additionalService.createRequest(
    bookingId,
    items,
    userId
  );

  res.json({ success: true, data: result });
};

export const approveRequest = async (req: Request, res: Response) => {
  await additionalService.approve(Number(req.params.id));
  res.json({ success: true });
};

export const generatePayment = async (req: Request, res: Response) => {
  const link = await additionalService.generatePayment(Number(req.params.id));
  res.json({ success: true, data: link });
};

export const workerDecision = async (req: Request, res: Response) => {
  const { decision } = req.body;

  await additionalService.workerDecision(
    Number(req.params.id),
    decision
  );

  res.json({ success: true });
};

export const getByBooking = async (req: Request, res: Response) => {
  const data = await additionalService.getByBooking(Number(req.params.bookingId));
  res.json({ success: true, data });
};