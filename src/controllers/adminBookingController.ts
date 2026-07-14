import { Request, Response } from "express";
import * as svc from "../services/adminBookingService";
import * as createSvc from "../services/adminCreateBookingService";
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

export const confirmProviderAssignment = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { providerUid, reason, consentMethod, consentReference } = req.body;
    if (!id || isNaN(id))                           return adminBadRequest(res, 'Invalid booking id');
    if (!providerUid)                               return adminBadRequest(res, 'providerUid is required');
    if (typeof providerUid !== 'string' || providerUid.length > 256) return adminBadRequest(res, 'providerUid invalid');
    if (!reason?.trim())                            return adminBadRequest(res, 'reason is required');
    if (!consentMethod || typeof consentMethod !== 'string') return adminBadRequest(res, 'consentMethod is required');

    const result = await svc.adminConfirmProviderAssignment(
      id, providerUid, actorUid(req), reason, consentMethod, consentReference ?? null
    );

    await writeSuccess({
      action: 'booking_provider_accepted_on_behalf',
      actionCategory: 'booking',
      actorUid: actorUid(req) ?? '',
      entityType: 'booking',
      entityId: String(id),
      after: { providerUid, consentMethod },
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

// ── Admin Create Booking ───��───────────────────────────────────────────────────

export const searchClientsForBooking = async (req: Request, res: Response) => {
  try {
    const q = String(req.query['q'] ?? '').trim();
    if (!q || q.length < 2) {
      return res.json({ status: 'success', data: [] });
    }
    const results = await createSvc.searchClients(q);
    return res.json({ status: 'success', data: results });
  } catch (err: any) {
    return adminServerError(res, err);
  }
};

export const checkGuestDuplicate = async (req: Request, res: Response) => {
  try {
    const phone = String(req.query['phone'] ?? '').trim();
    if (!phone) return adminBadRequest(res, 'phone is required');
    const normalized = createSvc.normalizePhilippinePhone(phone);
    const result = await createSvc.detectGuestDuplicate(normalized);
    return res.json({ status: 'success', data: { ...result, normalizedPhone: normalized } });
  } catch (err: any) {
    return adminServerError(res, err);
  }
};

export const getBookableServices = async (_req: Request, res: Response) => {
  try {
    const services = await createSvc.getBookableServicesForAdmin();
    return res.json({ status: 'success', data: services });
  } catch (err: any) {
    return adminServerError(res, err);
  }
};

export const getSlotCandidates = async (req: Request, res: Response) => {
  try {
    const { startAt, endAt, serviceId, cityId, branchId } = req.query as any;
    if (!startAt) return adminBadRequest(res, 'startAt is required');
    const derivedEnd = endAt ?? new Date(new Date(startAt).getTime() + 2 * 60 * 60 * 1000).toISOString();
    const candidates = await createSvc.listCandidatesForSlot({
      startAt,
      endAt: derivedEnd,
      serviceId: serviceId ?? null,
      cityId:    cityId   ?? null,
      branchId:  branchId ?? null,
    });
    return res.json({ status: 'success', data: candidates });
  } catch (err: any) {
    return adminServerError(res, err);
  }
};

export const createAdminBooking = async (req: Request, res: Response) => {
  try {
    const body = req.body ?? {};
    const {
      idempotencyKey, customerType,
      guest, customerUid,
      serviceOptionId, addonOptionIds,
      scheduledAt,
      addressLine, city, lat, lon,
      providerUid,
      paymentMethod, paymentStatus,
      paymentEvidence,
    } = body;

    if (!idempotencyKey?.trim())           return adminBadRequest(res, 'idempotencyKey is required');
    if (!['guest','client'].includes(customerType)) return adminBadRequest(res, 'customerType must be guest or client');
    if (!serviceOptionId)                  return adminBadRequest(res, 'serviceOptionId is required');
    if (!scheduledAt)                      return adminBadRequest(res, 'scheduledAt is required');
    if (!addressLine?.trim())              return adminBadRequest(res, 'addressLine is required');
    // city (post_town) is best-effort — Google Places may not return locality for all PH addresses;
    // store empty string rather than blocking the booking entirely
    const effectiveCity: string = city?.trim() || '';
    if (lat == null || lon == null)        return adminBadRequest(res, 'lat and lon are required');
    const latN = Number(lat), lonN = Number(lon);
    if (isNaN(latN) || latN < -90  || latN > 90)  return adminBadRequest(res, 'lat must be between -90 and 90');
    if (isNaN(lonN) || lonN < -180 || lonN > 180)  return adminBadRequest(res, 'lon must be between -180 and 180');
    if (!providerUid?.trim())              return adminBadRequest(res, 'providerUid is required');
    if (!['CASH','GCASH','ONLINE'].includes(paymentMethod)) return adminBadRequest(res, 'paymentMethod must be CASH, GCASH, or ONLINE');
    if (!['PAID','PAY_LATER'].includes(paymentStatus))      return adminBadRequest(res, 'paymentStatus must be PAID or PAY_LATER');

    const result = await createSvc.adminCreateBooking({
      idempotencyKey,
      adminActorUid: actorUid(req) ?? '',
      customerType,
      guest: customerType === 'guest' ? guest : undefined,
      customerUid: customerType === 'client' ? customerUid : undefined,
      serviceOptionId: Number(serviceOptionId),
      addonOptionIds: Array.isArray(addonOptionIds) ? addonOptionIds.map(Number) : [],
      scheduledAt,
      addressLine, city: effectiveCity,
      lat: Number(lat), lon: Number(lon),
      providerUid,
      paymentMethod,
      paymentStatus,
      paymentEvidence: paymentEvidence ?? null,
    });

    await writeSuccess({
      action: 'booking_created_by_admin',
      actionCategory: 'booking',
      actorUid: actorUid(req) ?? '',
      entityType: 'booking',
      entityId: String(result.bookingId),
      after: { bookingId: result.bookingId, customerType, providerUid, paymentStatus },
      requestId: (req as any).id ?? null,
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });

    return res.status(201).json({ status: 'success', data: result });
  } catch (err: any) {
    if (err?.statusCode) {
      return res.status(err.statusCode).json({ status: 'failed', message: err.message });
    }
    return adminServerError(res, err);
  }
};

export const uploadPaymentEvidence = async (req: Request, res: Response) => {
  try {
    const { file, fileName } = req.body ?? {};
    if (!file)      return adminBadRequest(res, 'file (data URI) is required');
    if (!fileName)  return adminBadRequest(res, 'fileName is required');
    if (typeof file !== 'string' || !file.startsWith('data:')) {
      return res.status(422).json({ status: 'failed', message: 'file must be a base64 data URI' });
    }
    const result = await createSvc.validateAndUploadEvidence({
      dataUri: file,
      originalFileName: String(fileName).slice(0, 255),
      adminUid: actorUid(req) ?? 'unknown',
    });
    return res.json({ status: 'success', data: result });
  } catch (err: any) {
    if (err?.statusCode) {
      return res.status(err.statusCode).json({ status: 'failed', message: err.message });
    }
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
