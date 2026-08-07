import { Request, Response } from 'express';
import { adminBadRequest, adminServerError } from '../helpers/adminError';
import * as service from '../services/adminNotificationService';

const uid = (req: any): string => req.user?.uid ?? '';

export async function list(req: Request, res: Response) {
  try {
    const limit = Number(req.query.limit ?? 30);
    const data = await service.listForAdmin(uid(req), Number.isFinite(limit) ? limit : 30);
    const unread = await service.unreadCount(uid(req));
    res.json({ status: 'success', data, meta: { unread } });
  } catch (error) { adminServerError(res, error); }
}

export async function read(req: Request, res: Response) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return adminBadRequest(res, 'Invalid notification id');
    await service.markRead(uid(req), id);
    res.json({ status: 'success' });
  } catch (error) { adminServerError(res, error); }
}

export async function readAll(req: Request, res: Response) {
  try {
    await service.markRead(uid(req));
    res.json({ status: 'success' });
  } catch (error) { adminServerError(res, error); }
}
