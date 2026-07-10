import { Request, Response } from "express";
import * as svc from "../services/adminBookingService";

const actorUid = (req: any): string | null =>
  req.user?.uid ?? req.headers['x-admin-uid'] ?? null;

export const listBookings = async (req: Request, res: Response) => {
  try {
    const { search, operationsStatus, paymentMethod, paymentStatus,
            serviceId, fromDate, toDate, page, limit,
            isUnassigned, isLate, hasDispute, needsAdminAction } = req.query as any;

    const result = await svc.getAdminBookings({
      search,
      operationsStatus,
      paymentMethod,
      paymentStatus,
      serviceId:   serviceId  ? Number(serviceId)  : undefined,
      fromDate,
      toDate,
      page:        page  ? Number(page)  : 1,
      limit:       limit ? Number(limit) : 25,
      isUnassigned: isUnassigned === 'true',
      isLate:       isLate       === 'true',
      hasDispute:   hasDispute   === 'true',
      needsAdminAction: needsAdminAction === 'true',
    });

    const pg = page ? Number(page) : 1;
    const lm = limit ? Number(limit) : 25;

    return res.json({
      status: 'success',
      data: result.rows,
      meta: {
        total: result.total,
        page: pg,
        limit: lm,
        totalPages: Math.ceil(result.total / lm),
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (err: any) {
    return res.status(500).json({ status: 'error', message: err.message });
  }
};

export const getMetrics = async (_req: Request, res: Response) => {
  try {
    const metrics = await svc.getAdminBookingMetrics();
    return res.json({ status: 'success', data: metrics });
  } catch (err: any) {
    return res.status(500).json({ status: 'error', message: err.message });
  }
};

export const getBookingDetail = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!id || isNaN(id)) {
      return res.status(400).json({ status: 'error', message: 'Invalid booking id' });
    }
    const detail = await svc.getAdminBookingDetail(id);
    if (!detail) {
      return res.status(404).json({ status: 'error', message: 'Booking not found' });
    }
    return res.json({ status: 'success', data: detail });
  } catch (err: any) {
    return res.status(500).json({ status: 'error', message: err.message });
  }
};

export const getTimeline = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!id || isNaN(id)) {
      return res.status(400).json({ status: 'error', message: 'Invalid booking id' });
    }
    const events = await svc.getBookingTimeline(id);
    return res.json({ status: 'success', data: events });
  } catch (err: any) {
    return res.status(500).json({ status: 'error', message: err.message });
  }
};

export const getNotes = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!id || isNaN(id)) {
      return res.status(400).json({ status: 'error', message: 'Invalid booking id' });
    }
    const notes = await svc.getBookingNotes(id);
    return res.json({ status: 'success', data: notes });
  } catch (err: any) {
    return res.status(500).json({ status: 'error', message: err.message });
  }
};

export const addNote = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { text } = req.body;
    if (!id || isNaN(id)) {
      return res.status(400).json({ status: 'error', message: 'Invalid booking id' });
    }
    if (!text?.trim()) {
      return res.status(400).json({ status: 'error', message: 'Note text is required' });
    }
    const note = await svc.addBookingNote(id, text, actorUid(req));
    return res.status(201).json({ status: 'success', data: note });
  } catch (err: any) {
    return res.status(400).json({ status: 'error', message: err.message });
  }
};

export const getCandidates = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!id || isNaN(id)) {
      return res.status(400).json({ status: 'error', message: 'Invalid booking id' });
    }
    const candidates = await svc.getAssignmentCandidates(id);
    return res.json({ status: 'success', data: candidates });
  } catch (err: any) {
    return res.status(500).json({ status: 'error', message: err.message });
  }
};

export const assignProvider = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { providerUid, reason } = req.body;
    if (!id || isNaN(id)) {
      return res.status(400).json({ status: 'error', message: 'Invalid booking id' });
    }
    if (!providerUid) {
      return res.status(400).json({ status: 'error', message: 'providerUid is required' });
    }
    const result = await svc.adminAssignProvider(id, providerUid, actorUid(req), reason);
    return res.json({ status: 'success', data: result });
  } catch (err: any) {
    const status = err.message?.includes('not found') ? 404
                 : err.message?.includes('not qualified') ? 422
                 : err.message?.includes('archived') ? 422
                 : 400;
    return res.status(status).json({ status: 'error', message: err.message });
  }
};

export const reassignProvider = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { toProviderUid, reason } = req.body;
    if (!id || isNaN(id)) {
      return res.status(400).json({ status: 'error', message: 'Invalid booking id' });
    }
    if (!toProviderUid) {
      return res.status(400).json({ status: 'error', message: 'toProviderUid is required' });
    }
    if (!reason?.trim()) {
      return res.status(400).json({ status: 'error', message: 'reason is required for reassignment' });
    }
    const result = await svc.adminReassignProvider(id, toProviderUid, actorUid(req), reason);
    return res.json({ status: 'success', data: result });
  } catch (err: any) {
    return res.status(400).json({ status: 'error', message: err.message });
  }
};

export const rescheduleBooking = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { scheduledAt, reason } = req.body;
    if (!id || isNaN(id)) {
      return res.status(400).json({ status: 'error', message: 'Invalid booking id' });
    }
    if (!scheduledAt) {
      return res.status(400).json({ status: 'error', message: 'scheduledAt is required' });
    }
    if (!reason?.trim()) {
      return res.status(400).json({ status: 'error', message: 'reason is required for reschedule' });
    }
    const result = await svc.adminRescheduleBooking(id, scheduledAt, reason, actorUid(req));
    return res.json({ status: 'success', data: result });
  } catch (err: any) {
    return res.status(400).json({ status: 'error', message: err.message });
  }
};

export const cancelBooking = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { reason, reasonCode, refundAction } = req.body;
    if (!id || isNaN(id)) {
      return res.status(400).json({ status: 'error', message: 'Invalid booking id' });
    }
    if (!reason?.trim()) {
      return res.status(400).json({ status: 'error', message: 'reason is required for cancellation' });
    }
    const result = await svc.adminCancelBooking(id, reason, actorUid(req), reasonCode, refundAction);
    return res.json({ status: 'success', data: result });
  } catch (err: any) {
    const status = err.message?.includes('not found') ? 404 : 422;
    return res.status(status).json({ status: 'error', message: err.message });
  }
};

export const escalateBooking = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { reason, severity, reasonCode, assignedTeam } = req.body;
    if (!id || isNaN(id)) {
      return res.status(400).json({ status: 'error', message: 'Invalid booking id' });
    }
    if (!reason?.trim()) {
      return res.status(400).json({ status: 'error', message: 'reason is required for escalation' });
    }
    if (!['low','normal','high','urgent'].includes(severity)) {
      return res.status(400).json({ status: 'error', message: 'severity must be low|normal|high|urgent' });
    }
    const result = await svc.adminEscalateBooking(
      id, reason, severity, actorUid(req), { reasonCode, assignedTeam }
    );
    return res.status(201).json({ status: 'success', data: result });
  } catch (err: any) {
    return res.status(400).json({ status: 'error', message: err.message });
  }
};

export const approveCompletion = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { reason } = req.body;
    if (!id || isNaN(id)) {
      return res.status(400).json({ status: 'error', message: 'Invalid booking id' });
    }
    const result = await svc.adminApproveCompletion(id, actorUid(req), reason);
    return res.json({ status: 'success', data: result });
  } catch (err: any) {
    return res.status(400).json({ status: 'error', message: err.message });
  }
};
