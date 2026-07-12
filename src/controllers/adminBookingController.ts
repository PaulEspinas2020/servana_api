import { Request, Response } from "express";
import * as svc from "../services/adminBookingService";
import { adminServerError, adminNotFound, adminBadRequest } from "../helpers/adminError";
import { auditFire, writeSuccess } from "../services/adminAuditService";
import { listAssignmentCandidates } from "../services/providerEligibilityEngine";

const actorUid = (req: any): string | null =>
  req.user?.uid ?? null;

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
    return adminServerError(res, err);
  }
};

export const getMetrics = async (_req: Request, res: Response) => {
  try {
    const metrics = await svc.getAdminBookingMetrics();
    return res.json({ status: 'success', data: metrics });
  } catch (err: any) {
    return adminServerError(res, err);
  }
};

export const getBookingDetail = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!id || isNaN(id)) {
      return adminBadRequest(res, 'Invalid booking id');
    }
    const detail = await svc.getAdminBookingDetail(id);
    if (!detail) {
      return adminNotFound(res, 'Booking');
    }
    return res.json({ status: 'success', data: detail });
  } catch (err: any) {
    return adminServerError(res, err);
  }
};

export const getTimeline = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!id || isNaN(id)) {
      return adminBadRequest(res, 'Invalid booking id');
    }
    const events = await svc.getBookingTimeline(id);
    return res.json({ status: 'success', data: events });
  } catch (err: any) {
    return adminServerError(res, err);
  }
};

export const getNotes = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!id || isNaN(id)) {
      return adminBadRequest(res, 'Invalid booking id');
    }
    const notes = await svc.getBookingNotes(id);
    return res.json({ status: 'success', data: notes });
  } catch (err: any) {
    return adminServerError(res, err);
  }
};

export const addNote = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { text } = req.body;
    if (!id || isNaN(id)) {
      return adminBadRequest(res, 'Invalid booking id');
    }
    if (!text?.trim()) {
      return adminBadRequest(res, 'Note text is required');
    }
    const note = await svc.addBookingNote(id, text, actorUid(req));
    return res.status(201).json({ status: 'success', data: note });
  } catch (err: any) {
    return adminServerError(res, err);
  }
};

export const getCandidates = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!id || isNaN(id)) {
      return adminBadRequest(res, 'Invalid booking id');
    }
    const candidates = await listAssignmentCandidates(String(id));
    auditFire({
      action: 'assignment_candidates_viewed',
      actionCategory: 'booking',
      outcome: 'success',
      actorUid: actorUid(req) ?? '',
      entityType: 'booking',
      entityId: String(id),
      after: { candidateCount: candidates.length, eligibleCount: candidates.filter(c => c.eligible).length },
      requestId: (req as any).id ?? null,
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
    return res.json({ status: 'success', data: candidates });
  } catch (err: any) {
    return adminServerError(res, err);
  }
};

export const assignProvider = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { providerUid, reason } = req.body;
    if (!id || isNaN(id)) {
      return adminBadRequest(res, 'Invalid booking id');
    }
    if (!providerUid) {
      return adminBadRequest(res, 'providerUid is required');
    }
    const result = await svc.adminAssignProvider(id, providerUid, actorUid(req), reason);

    auditFire({
      action: 'booking_assigned',
      actionCategory: 'booking',
      outcome: 'success',
      actorUid: actorUid(req) ?? '',
      entityType: 'booking',
      entityId: String(id),
      after: { providerUid },
      reason: reason ?? null,
      requestId: (req as any).id ?? null,
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });

    return res.json({ status: 'success', data: result });
  } catch (err: any) {
    return adminServerError(res, err);
  }
};

export const reassignProvider = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { toProviderUid, reason } = req.body;
    if (!id || isNaN(id)) {
      return adminBadRequest(res, 'Invalid booking id');
    }
    if (!toProviderUid) {
      return adminBadRequest(res, 'toProviderUid is required');
    }
    if (!reason?.trim()) {
      return adminBadRequest(res, 'reason is required for reassignment');
    }
    const result = await svc.adminReassignProvider(id, toProviderUid, actorUid(req), reason);

    auditFire({
      action: 'booking_reassigned',
      actionCategory: 'booking',
      outcome: 'success',
      actorUid: actorUid(req) ?? '',
      entityType: 'booking',
      entityId: String(id),
      after: { providerUid: toProviderUid },
      reason: reason ?? null,
      requestId: (req as any).id ?? null,
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });

    return res.json({ status: 'success', data: result });
  } catch (err: any) {
    return adminServerError(res, err);
  }
};

export const rescheduleBooking = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { scheduledAt, reason } = req.body;
    if (!id || isNaN(id)) {
      return adminBadRequest(res, 'Invalid booking id');
    }
    if (!scheduledAt) {
      return adminBadRequest(res, 'scheduledAt is required');
    }
    if (!reason?.trim()) {
      return adminBadRequest(res, 'reason is required for reschedule');
    }
    const result = await svc.adminRescheduleBooking(id, scheduledAt, reason, actorUid(req));

    auditFire({
      action: 'booking_rescheduled',
      actionCategory: 'booking',
      outcome: 'success',
      actorUid: actorUid(req) ?? '',
      entityType: 'booking',
      entityId: String(id),
      after: { scheduledAt },
      reason: reason ?? null,
      requestId: (req as any).id ?? null,
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });

    return res.json({ status: 'success', data: result });
  } catch (err: any) {
    return adminServerError(res, err);
  }
};

export const cancelBooking = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { reason, reasonCode, refundAction } = req.body;
    if (!id || isNaN(id)) {
      return adminBadRequest(res, 'Invalid booking id');
    }
    if (!reason?.trim()) {
      return adminBadRequest(res, 'reason is required for cancellation');
    }
    const result = await svc.adminCancelBooking(id, reason, actorUid(req), reasonCode, refundAction);

    await writeSuccess({
      action: 'booking_cancelled',
      actionCategory: 'booking',
      actorUid: actorUid(req) ?? '',
      entityType: 'booking',
      entityId: String(id),
      after: { status: 'cancelled', reasonCode: reasonCode ?? null, refundAction: refundAction ?? null },
      reason: reason ?? null,
      requestId: (req as any).id ?? null,
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });

    return res.json({ status: 'success', data: result });
  } catch (err: any) {
    return adminServerError(res, err);
  }
};

export const escalateBooking = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { reason, severity, reasonCode, assignedTeam } = req.body;
    if (!id || isNaN(id)) {
      return adminBadRequest(res, 'Invalid booking id');
    }
    if (!reason?.trim()) {
      return adminBadRequest(res, 'reason is required for escalation');
    }
    if (!['low','normal','high','urgent'].includes(severity)) {
      return adminBadRequest(res, 'severity must be low|normal|high|urgent');
    }
    const result = await svc.adminEscalateBooking(
      id, reason, severity, actorUid(req), { reasonCode, assignedTeam }
    );

    auditFire({
      action: 'booking_escalated',
      actionCategory: 'booking',
      outcome: 'success',
      actorUid: actorUid(req) ?? '',
      entityType: 'booking',
      entityId: String(id),
      after: { severity, reasonCode: reasonCode ?? null, assignedTeam: assignedTeam ?? null },
      reason: reason ?? null,
      requestId: (req as any).id ?? null,
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });

    return res.status(201).json({ status: 'success', data: result });
  } catch (err: any) {
    return adminServerError(res, err);
  }
};

export const approveCompletion = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { reason } = req.body;
    if (!id || isNaN(id)) {
      return adminBadRequest(res, 'Invalid booking id');
    }
    const result = await svc.adminApproveCompletion(id, actorUid(req), reason);

    await writeSuccess({
      action: 'booking_completion_approved',
      actionCategory: 'booking',
      actorUid: actorUid(req) ?? '',
      entityType: 'booking',
      entityId: String(id),
      after: { status: 'completed' },
      reason: reason ?? null,
      requestId: (req as any).id ?? null,
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });

    return res.json({ status: 'success', data: result });
  } catch (err: any) {
    return adminServerError(res, err);
  }
};
