import { Request, Response } from "express";
import * as pricingService from "../services/pricingService";

export const quote = async (req: Request, res: Response) => {
  try {
    const quote = await pricingService.computeQuote(req.body);
    res.json({ success: true, quote });
  } catch (e: any) {
    res.status(400).json({ success: false, message: e.message });
  }
};
