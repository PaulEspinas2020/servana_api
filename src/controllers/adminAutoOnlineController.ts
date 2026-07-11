import { Request, Response } from 'express';
import * as engine from '../services/providerAutoOnlineEngine';
import { adminError, adminServerError, AdminErrorCode } from '../helpers/adminError';

const getAdminUid = (req: Request): string => (req.user as any)?.uid ?? 'admin';
const uid = (req: Request): string => String(req.params.uid);

// GET /api/admin/providers/:uid/auto-online/readiness
export const getReadiness = async (req: Request, res: Response) => {
  try {
    const readiness = await engine.evaluateProvider(uid(req), 'admin', getAdminUid(req));
    return res.status(200).json({ status: 'success', data: readiness });
  } catch (err: any) {
    return adminServerError(res, err);
  }
};

// POST /api/admin/providers/:uid/auto-online/re-evaluate
export const reEvaluate = async (req: Request, res: Response) => {
  try {
    const readiness = await engine.evaluateProvider(uid(req), 'admin', getAdminUid(req));
    return res.status(200).json({ status: 'success', data: readiness });
  } catch (err: any) {
    return adminServerError(res, err);
  }
};

// POST /api/admin/providers/:uid/auto-online/disable
export const disableAutoOnline = async (req: Request, res: Response) => {
  try {
    const { reason } = req.body;
    if (!reason || typeof reason !== 'string' || reason.trim().length < 2) {
      return adminError(res, 400, 'VALIDATION_ERROR', 'reason is required (min 2 chars)');
    }
    await engine.disableAutoOnline(uid(req), reason.trim(), getAdminUid(req));
    return res.status(200).json({ status: 'success', data: { success: true } });
  } catch (err: any) {
    return adminServerError(res, err);
  }
};

// POST /api/admin/providers/:uid/auto-online/enable-override
export const enableOverride = async (req: Request, res: Response) => {
  try {
    const { reason } = req.body;
    if (!reason || typeof reason !== 'string' || reason.trim().length < 2) {
      return adminError(res, 400, 'VALIDATION_ERROR', 'reason is required (min 2 chars)');
    }
    await engine.enableAutoOnlineOverride(uid(req), reason.trim(), getAdminUid(req));
    const readiness = await engine.evaluateProvider(uid(req), 'admin', getAdminUid(req));
    return res.status(200).json({ status: 'success', data: readiness });
  } catch (err: any) {
    return adminServerError(res, err);
  }
};

// GET /api/admin/auto-online/summary
export const getSummary = async (_req: Request, res: Response) => {
  try {
    const summary = await engine.getAutoOnlineSummary();
    return res.status(200).json({ status: 'success', data: summary });
  } catch (err: any) {
    return adminServerError(res, err);
  }
};

// GET /api/admin/auto-online/blockers
export const getBlockers = async (req: Request, res: Response) => {
  try {
    const page  = Math.max(1, parseInt(String(req.query.page  ?? '1'),  10));
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '50'), 10)));
    const rows = await engine.getAutoOnlineBlockers(page, limit);
    return res.status(200).json({ status: 'success', data: rows });
  } catch (err: any) {
    return adminServerError(res, err);
  }
};

// GET /api/admin/auto-online/backfill-preview
export const backfillPreview = async (req: Request, res: Response) => {
  try {
    const result = await engine.evaluateAllProviders(false, getAdminUid(req));
    return res.status(200).json({ status: 'success', data: result });
  } catch (err: any) {
    return adminServerError(res, err);
  }
};

// POST /api/admin/auto-online/backfill-apply
export const backfillApply = async (req: Request, res: Response) => {
  try {
    const result = await engine.evaluateAllProviders(true, getAdminUid(req));
    return res.status(200).json({ status: 'success', data: result });
  } catch (err: any) {
    return adminServerError(res, err);
  }
};
