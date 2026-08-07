import { Request, Response } from 'express';
import * as adminDashboardService from '../services/adminDashboardService';
import { adminServerError } from '../helpers/adminError';
import { hasPermission, isSuperAdmin } from '../services/adminPermissionService';

export const getOperations = async (req: Request, res: Response) => {
  try {
    const data = await adminDashboardService.getOperationsDashboard();
    const uid = (req as any).user?.uid ?? '';
    const superAdmin = await isSuperAdmin(uid);
    const can = async (key: string) => superAdmin || await hasPermission(uid, key);
    const projected = adminDashboardService.projectDashboardForAccess(data, {
      operations: await can('dashboard.operations_metrics.view'),
      revenue: await can('dashboard.revenue_metrics.view'),
      providers: await can('dashboard.provider_supply_metrics.view'),
      pipeline: await can('dashboard.booking_pipeline_metrics.view'),
      systemHealth: await can('dashboard.system_health.view'),
    });
    return res.json({ status: 'success', data: projected });
  } catch (err: any) {
    console.error('[AdminDashboard] getOperations error:', err?.message);
    return adminServerError(res, err);
  }
};
