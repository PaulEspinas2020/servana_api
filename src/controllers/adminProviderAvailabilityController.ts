/**
 * Admin endpoints for supply-level availability signals:
 *   GET  /admin/provider-availability/summary
 *   GET  /admin/provider-availability/supply-gaps
 *   POST /admin/provider-availability/evaluate-booking
 *   GET  /admin/provider-availability/missing-setup
 */

import { Request, Response } from 'express';
import { adminError, AdminErrorCode } from '../helpers/adminError';
import * as supplyHealth  from '../services/providerSupplyHealthService';
import * as eligEngine    from '../services/providerEligibilityEngine';

const ok = (res: Response, data: any, meta?: any) =>
  res.status(200).json({ status: 'success', data, ...(meta ? { meta } : {}) });

const HTTP_TO_CODE: Record<number, AdminErrorCode> = {
  400: 'BUSINESS_RULE', 403: 'FORBIDDEN', 404: 'NOT_FOUND',
  409: 'CONFLICT', 422: 'VALIDATION_ERROR', 500: 'SERVER_ERROR',
};
const fail = (res: Response, httpStatus: number, message: string) =>
  adminError(res, httpStatus, HTTP_TO_CODE[httpStatus] ?? 'SERVER_ERROR', message);

export const getSupplySummary = async (_req: Request, res: Response) => {
  try {
    const summary = await supplyHealth.getProviderSetupSummary();
    return ok(res, summary);
  } catch (err: any) {
    return fail(res, 500, err?.message ?? 'Failed to get supply summary');
  }
};

export const getSupplyGaps = async (req: Request, res: Response) => {
  try {
    const daysAhead = Math.min(Number(req.query.days ?? 7), 30);
    const gaps = await supplyHealth.getSupplyGaps(daysAhead);
    return ok(res, gaps);
  } catch (err: any) {
    return fail(res, 500, err?.message ?? 'Failed to get supply gaps');
  }
};

export const getMissingSetup = async (req: Request, res: Response) => {
  try {
    const filter = (['availability', 'service_area', 'both', 'any'].includes(req.query.filter as string)
      ? req.query.filter as any
      : 'any');
    const limit  = Math.min(Number(req.query.limit ?? 50), 100);
    const list   = await supplyHealth.listProvidersMissingSetup(filter, limit);
    return ok(res, list);
  } catch (err: any) {
    return fail(res, 500, err?.message ?? 'Failed to list providers with missing setup');
  }
};

export const evaluateBooking = async (req: Request, res: Response) => {
  try {
    const { bookingId } = req.body ?? {};
    if (!bookingId) return fail(res, 400, 'bookingId is required');
    const candidates = await eligEngine.listAssignmentCandidates(String(bookingId));
    return ok(res, candidates);
  } catch (err: any) {
    return fail(res, err?.statusCode ?? 500, err?.message ?? 'Failed to evaluate booking');
  }
};
