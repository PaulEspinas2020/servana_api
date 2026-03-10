import { Request, Response } from "express";
import * as bookingService from "../services/bookingService";
import { toCamel } from "../helpers/idGenerator";
export const createBooking = async (req: any, res: any) => {
  try {
    const userId = req.query.userId as string;
    console.log("Creating booking for user", userId);
    const booking = await bookingService.createBooking(
      userId,
      req.body
    );

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

    // If you have auth: const userId = (req as any).user?.uid;
    const booking = await bookingService.confirmOtp(bookingId, otp /*, userId */);

    return res.json({ success: true, booking: toCamel(booking) });
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

    // If you have auth: const userId = (req as any).user?.uid;
    const booking = await bookingService.getBookingById(bookingId /*, userId */);

    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }

    return res.json({ success: true, booking: toCamel(booking) });
  } catch (e: any) {
    return res.status(500).json({ success: false, message: e.message });
  }
};

export const getTracking = async (req: Request, res: Response) => {
  try {
    const bookingId = Number(req.params.id);

    if (!bookingId || Number.isNaN(bookingId)) {
      return res.status(400).json({ success: false, message: "Invalid booking id" });
    }

    // If you have auth: const userId = (req as any).user?.uid;
    const tracking = await bookingService.getTracking(bookingId /*, userId */);
    const toCamelRows = (rows: any[]) => rows.map(toCamel);
    return res.json({ success: true, tracking: toCamelRows(tracking) });
  } catch (e: any) {
    return res.status(500).json({ success: false, message: e.message });
  }
};