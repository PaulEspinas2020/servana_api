import { Request, Response } from 'express';
import * as svc from '../services/adminGuestService';
import {
  adminServerError,
  adminNotFound,
  adminBadRequest,
  adminConflict,
} from '../helpers/adminError';

const actorUid = (req: any): string => req.user && req.user.uid ? req.user.uid : '';

// GET /admin/customers
export const listAllCustomers = async (req: Request, res: Response) => {
  try {
    const { search, identityType, page, limit } = req.query as any;
    const result = await svc.listAllCustomers({
      search:       search || undefined,
      identityType: identityType || 'all',
      page:         page  ? Number(page)  : 1,
      limit:        limit ? Number(limit) : 25,
    });
    return res.json({
      status: 'success',
      data:   result.data,
      meta: {
        total:      result.total,
        page:       result.page,
        limit:      result.limit,
        totalPages: Math.ceil(result.total / result.limit),
      },
    });
  } catch (err: any) {
    return adminServerError(res, err);
  }
};

// GET /admin/customers/metrics
export const getCustomerMetrics = async (_req: Request, res: Response) => {
  try {
    const metrics = await svc.getCustomerMetrics();
    return res.json({ status: 'success', data: metrics });
  } catch (err: any) {
    return adminServerError(res, err);
  }
};

// GET /admin/customers/guests
export const listGuests = async (req: Request, res: Response) => {
  try {
    const { search, sourceChannel, linkedStatus, page, limit } = req.query as any;
    const result = await svc.listGuests({
      search:       search || undefined,
      sourceChannel: sourceChannel || undefined,
      linkedStatus: linkedStatus || 'all',
      page:         page  ? Number(page)  : 1,
      limit:        limit ? Number(limit) : 25,
    });
    return res.json({
      status: 'success',
      data:   result.data,
      meta: {
        total:      result.total,
        page:       result.page,
        limit:      result.limit,
        totalPages: Math.ceil(result.total / result.limit),
      },
    });
  } catch (err: any) {
    return adminServerError(res, err);
  }
};

// GET /admin/customers/guests/:guestId
export const getGuestDetail = async (req: Request, res: Response) => {
  try {
    const { guestId } = req.params as { guestId: string };
    if (!guestId) return adminBadRequest(res, 'guestId is required');
    const detail = await svc.getGuestDetail(guestId);
    if (!detail) return adminNotFound(res, 'Guest customer');
    return res.json({ status: 'success', data: detail });
  } catch (err: any) {
    return adminServerError(res, err);
  }
};

// GET /admin/customers/guests/:guestId/bookings
export const getGuestBookings = async (req: Request, res: Response) => {
  try {
    const { guestId } = req.params as { guestId: string };
    if (!guestId) return adminBadRequest(res, 'guestId is required');
    const bookings = await svc.getGuestBookings(guestId);
    return res.json({ status: 'success', data: bookings });
  } catch (err: any) {
    return adminServerError(res, err);
  }
};

// PATCH /admin/customers/guests/:guestId
export const updateGuest = async (req: Request, res: Response) => {
  try {
    const { guestId } = req.params as { guestId: string };
    if (!guestId) return adminBadRequest(res, 'guestId is required');

    const { firstName, lastName, email, sourceChannel, sourceDetails, internalNotes } = req.body;
    const uid = actorUid(req);

    const updated = await svc.updateGuest(guestId, uid, {
      firstName,
      lastName,
      email,
      sourceChannel,
      sourceDetails,
      internalNotes,
    });

    if (!updated) return adminNotFound(res, 'Guest customer');
    return res.json({ status: 'success', data: updated });
  } catch (err: any) {
    if (err.code === 'NOT_FOUND') return adminNotFound(res, 'Guest customer');
    if ((err.statusCode || 0) === 400) return adminBadRequest(res, err.message);
    return adminServerError(res, err);
  }
};

// POST /admin/customers/guests/:guestId/link-client
export const linkGuestToClient = async (req: Request, res: Response) => {
  try {
    const { guestId } = req.params as { guestId: string };
    if (!guestId) return adminBadRequest(res, 'guestId is required');

    const { customerUid, reason } = req.body;
    if (!customerUid || !customerUid.trim()) {
      return adminBadRequest(res, 'customerUid is required');
    }

    const uid = actorUid(req);
    const result = await svc.linkGuestToClient(guestId, customerUid.trim(), uid, reason || '');

    return res.json({ status: 'success', data: result });
  } catch (err: any) {
    if (err.code === 'NOT_FOUND') return adminNotFound(res, err.message || 'Resource');
    if (err.code === 'CONFLICT')  return adminConflict(res, err.message);
    return adminServerError(res, err);
  }
};
