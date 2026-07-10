import { Request, Response } from 'express';
import * as adminDashboardService from '../services/adminDashboardService';
import { adminServerError } from '../helpers/adminError';

export const getOperations = async (_req: Request, res: Response) => {
  try {
    const data = await adminDashboardService.getOperationsDashboard();
    return res.json({ status: 'success', data });
  } catch (err: any) {
    console.error('[AdminDashboard] getOperations error:', err?.message);
    return adminServerError(res, err);
  }
};
