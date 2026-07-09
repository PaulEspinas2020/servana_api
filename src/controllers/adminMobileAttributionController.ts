import { Request, Response } from 'express';
import * as svc from '../services/adminMobileAttributionService';

const ok = (res: Response, data: unknown, meta?: unknown) =>
  res.json({ status: 'success', data, ...(meta ? { meta } : {}) });

const fail = (res: Response, statusCode: number, message: string) =>
  res.status(statusCode).json({ status: 'error', message });

export const getMobileMetrics = async (_req: Request, res: Response) => {
  try {
    const metrics = await svc.getMobileMetrics();
    return ok(res, metrics);
  } catch (err: any) {
    return fail(res, 500, err?.message ?? 'Failed to retrieve mobile metrics');
  }
};

export const getProviderAttribution = async (req: Request, res: Response) => {
  try {
    const uid = String(req.params.uid);
    const attribution = await svc.getProviderAttribution(uid);
    return ok(res, attribution);
  } catch (err: any) {
    return fail(res, 500, err?.message ?? 'Failed to retrieve provider attribution');
  }
};

export const getProviderCatalogAssociation = async (req: Request, res: Response) => {
  try {
    const uid = String(req.params.uid);
    const association = await svc.getProviderCatalogAssociation(uid);
    return ok(res, association);
  } catch (err: any) {
    return fail(res, 500, err?.message ?? 'Failed to retrieve catalog association');
  }
};

export const triggerBackfill = async (_req: Request, res: Response) => {
  try {
    const result = await svc.backfillAttribution();
    return ok(res, result);
  } catch (err: any) {
    return fail(res, 500, err?.message ?? 'Backfill failed');
  }
};
