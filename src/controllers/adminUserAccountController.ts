import { Request, Response } from 'express';
import * as svc from '../services/adminUserAccountService';
import { adminBadRequest, adminConflict, adminNotFound, adminServerError } from '../helpers/adminError';

const actorUid = (req: any): string => req.user?.uid ?? '';

export const listUsers = async (req: Request, res: Response) => {
  try {
    const result = await svc.listUsers({
      search: req.query.search ? String(req.query.search).slice(0, 200) : undefined,
      page: req.query.page ? Number(req.query.page) : 1,
      limit: req.query.limit ? Number(req.query.limit) : 25,
    });
    return res.json({ status: 'success', data: result.data, meta: {
      total: result.total, page: result.page, limit: result.limit,
      totalPages: Math.ceil(result.total / result.limit),
    } });
  } catch (error: any) {
    return adminServerError(res, error);
  }
};

export const setUserArchive = async (req: Request, res: Response) => {
  try {
    if (typeof req.body?.isArchive !== 'boolean') return adminBadRequest(res, 'isArchive must be a boolean');
    const result = await svc.setUserArchive(
      String(req.params.uid), req.body.isArchive, actorUid(req), String(req.body.reason ?? ''),
    );
    return res.json({ status: 'success', data: result });
  } catch (error: any) {
    if (error?.statusCode === 400) return adminBadRequest(res, error.message);
    if (error?.statusCode === 404) return adminNotFound(res, 'User');
    if (error?.statusCode === 409) return adminConflict(res, error.message);
    return adminServerError(res, error);
  }
};
