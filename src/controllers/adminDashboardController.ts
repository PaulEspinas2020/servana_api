import { Request, Response } from 'express';
import * as adminDashboardService from '../services/adminDashboardService';

export const getOperations = async (_req: Request, res: Response) => {
  try {
    const data = await adminDashboardService.getOperationsDashboard();
    return res.json({ status: 'success', data });
  } catch (err: any) {
    console.error('[AdminDashboard] getOperations error:', err?.message);
    return res.status(500).json({
      status: 'error',
      code: 'DASHBOARD_LOAD_FAILED',
      message: err?.message ?? 'Failed to load dashboard',
    });
  }
};
