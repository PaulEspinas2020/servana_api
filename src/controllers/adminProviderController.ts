import { Request, Response } from 'express';
import * as svc from '../services/adminProviderService';
import * as appSvc from '../services/serviceApplicationService';
import { adminError, AdminErrorCode } from '../helpers/adminError';
import { auditFire, writeSuccess } from '../services/adminAuditService';
import * as availEngine from '../services/providerAvailabilityEngine';
import * as areaEngine  from '../services/providerServiceAreaEngine';
import * as eligEngine  from '../services/providerEligibilityEngine';
import * as autoOnlineEngine from '../services/providerAutoOnlineEngine';

// ── Helpers ───────────────────────────────────────────────────────────────────

const ok = (res: Response, data: any, meta?: any) =>
  res.status(200).json({ status: 'success', data, ...(meta ? { meta } : {}) });

const HTTP_TO_CODE: Record<number, AdminErrorCode> = {
  400: 'BUSINESS_RULE', 403: 'FORBIDDEN', 404: 'NOT_FOUND',
  409: 'CONFLICT', 422: 'VALIDATION_ERROR', 500: 'SERVER_ERROR',
};
const fail = (res: Response, httpStatus: number, message: string) =>
  adminError(res, httpStatus, HTTP_TO_CODE[httpStatus] ?? 'SERVER_ERROR', message);

const parseIntQ = (val: any, fallback: number) => {
  const n = parseInt(val, 10);
  return isNaN(n) ? fallback : n;
};

const adminUid = (req: Request): string => req.user?.uid ?? '';

// ── Provider List ─────────────────────────────────────────────────────────────

export const listProviders = async (req: Request, res: Response) => {
  try {
    const { search, role, account_status, is_archive, sort_by, sort_dir,
            has_documents, has_pending_apps, has_active_services, has_availability, has_service_area,
            has_auto_online, has_bookable } = req.query;
    const page = parseIntQ(req.query.page, 1);
    const limit = Math.min(parseIntQ(req.query.limit, 50), 200);

    const parseBool = (v: any) => v === undefined ? undefined : v === 'true';

    const result = await svc.listProviders({
      search: search as string | undefined,
      role: role !== undefined ? Number(role) : undefined,
      accountStatus: account_status as string | undefined,
      isArchive: is_archive !== undefined ? is_archive === 'true' : undefined,
      hasDocuments:      parseBool(has_documents),
      hasPendingApps:    parseBool(has_pending_apps),
      hasActiveServices: parseBool(has_active_services),
      hasAvailability:   parseBool(has_availability),
      hasServiceArea:    parseBool(has_service_area),
      hasAutoOnline:     parseBool(has_auto_online),
      hasBookable:       parseBool(has_bookable),
      page,
      limit,
      sortBy: (sort_by as any) ?? 'created_date',
      sortDir: (sort_dir as any) ?? 'desc',
    });

    const rows = result.rows.map((r: any) => ({
      uid:             r.uid,
      firstName:       r.first_name        ?? null,
      lastName:        r.last_name         ?? null,
      email:           r.email             ?? null,
      phoneNumber:     r.phone_number      ?? null,
      role:            Number(r.role),
      providerType:    Number(r.role) === 2 ? 'marketplace_provider' : Number(r.role) === 4 ? 'internal_provider' : 'unknown',
      accountStatus:   r.account_status    ?? null,
      isArchive:       r.is_archive        ?? false,
      isEmailVerified: r.is_email_verified ?? false,
      createdDate:     r.created_date      ?? null,
      photoUrl:        r.photo_url         ?? null,
      // Consolidated summaries — backend resolves, frontend displays
      documentSummary: { total: Number(r.doc_total ?? 0) },
      serviceSummary:  { pendingApplications: Number(r.pending_apps ?? 0), activeServices: Number(r.active_svc ?? 0) },
      availabilityStatus: r.avail_status ?? 'unknown',
      serviceAreaStatus:  r.area_status  ?? 'unknown',
      isAutoOnline: r.is_auto_online ?? false,
      isBookable:   r.is_bookable    ?? false,
      autoOnlineSource: r.activation_mode ?? null,
    }));

    return ok(res, rows, {
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: Math.ceil(result.total / result.limit),
    });
  } catch (err: any) {
    return fail(res, 500, err?.message ?? 'Failed to fetch providers');
  }
};

// ── Summary Metrics ───────────────────────────────────────────────────────────

export const getProviderMetrics = async (_req: Request, res: Response) => {
  try {
    const metrics = await svc.getProviderMetrics();
    return ok(res, metrics);
  } catch (err: any) {
    return fail(res, 500, err?.message ?? 'Failed to fetch metrics');
  }
};

// ── Provider Identity ─────────────────────────────────────────────────────────

export const getProvider = async (req: Request, res: Response) => {
  try {
    const uid = String(req.params.uid);
    const provider = await svc.getProviderIdentity(uid);
    if (!provider) return fail(res, 404, 'Provider not found');
    return ok(res, provider);
  } catch (err: any) {
    return fail(res, 500, err?.message ?? 'Failed to fetch provider');
  }
};

// ── Active Services ───────────────────────────────────────────────────────────

export const getProviderServices = async (req: Request, res: Response) => {
  try {
    const uid = String(req.params.uid);
    const services = await svc.getProviderActiveServices(uid);
    return ok(res, services);
  } catch (err: any) {
    return fail(res, 500, err?.message ?? 'Failed to fetch services');
  }
};

// ── Service Applications ──────────────────────────────────────────────────────

export const getProviderServiceApplications = async (req: Request, res: Response) => {
  try {
    const uid = String(req.params.uid);
    const applications = await svc.getProviderServiceApplications(uid);
    return ok(res, applications);
  } catch (err: any) {
    return fail(res, 500, err?.message ?? 'Failed to fetch service applications');
  }
};

// ── All Service Applications (global, paginated) ──────────────────────────────

export const listAllServiceApplications = async (req: Request, res: Response) => {
  try {
    const { status } = req.query;
    const page = parseIntQ(req.query.page, 1);
    const limit = Math.min(parseIntQ(req.query.limit, 50), 200);
    const offset = (page - 1) * limit;

    const params: any[] = [];
    const where: string[] = [];

    if (status) {
      params.push(status);
      where.push(`wsa.status = $${params.length}`);
    }

    const { default: dbQuery } = await import('../db/dbQuery');
    const { db } = await import('../config');
    const schema = db.schema;
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    params.push(limit, offset);
    const limitP = params.length - 1;
    const offsetP = params.length;

    const [rowsRes, countRes] = await Promise.all([
      dbQuery.query(
        `SELECT wsa.id, wsa.worker_uid, wsa.service_id, wsa.status,
                wsa.submitted_at, wsa.reviewed_at, wsa.reviewed_by, wsa.review_reason, wsa.version,
                s.name AS category, '' AS service_name,
                uc.first_name, uc.last_name, uc.email
         FROM ${schema}.worker_service_applications wsa
         LEFT JOIN ${schema}.services s ON s.id = wsa.service_id
         LEFT JOIN ${schema}.user_credentials uc ON uc.uid = wsa.worker_uid
         ${whereClause}
         ORDER BY wsa.submitted_at DESC
         LIMIT $${limitP} OFFSET $${offsetP}`,
        params
      ),
      dbQuery.query(
        `SELECT COUNT(*) FROM ${schema}.worker_service_applications wsa ${whereClause}`,
        params.slice(0, -2)
      ),
    ]);

    const rows = rowsRes.rows.map((r: any) => ({
      id: r.id,
      workerUid: r.worker_uid,
      workerName: `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || r.email,
      serviceId: r.service_id,
      category: r.category ?? '',
      serviceName: r.service_name ?? '',
      status: r.status,
      submittedAt: r.submitted_at,
      reviewedAt: r.reviewed_at ?? null,
      reviewedBy: r.reviewed_by ?? null,
      reviewReason: r.review_reason ?? null,
      version: r.version,
    }));

    return ok(res, rows, {
      total: Number(countRes.rows[0]?.count ?? 0),
      page,
      limit,
    });
  } catch (err: any) {
    return fail(res, 500, err?.message ?? 'Failed to fetch service applications');
  }
};

// ── Approve / Reject Application ──────────────────────────────────────────────

export const approveServiceApplication = async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const { expectedVersion, reason } = req.body ?? {};
    const admin = adminUid(req);

    if (typeof expectedVersion !== 'number') {
      return fail(res, 400, 'expectedVersion (number) is required');
    }

    const { default: dbQuery } = await import('../db/dbQuery');
    const { db } = await import('../config');
    const schema = db.schema;

    const appRes = await dbQuery.query(
      `SELECT * FROM ${schema}.worker_service_applications WHERE id = $1 LIMIT 1`,
      [id]
    );
    if (!appRes.rowCount) return fail(res, 404, 'Application not found');

    const app = appRes.rows[0];
    if (app.version !== expectedVersion) {
      return fail(res, 409, `Version conflict: expected ${expectedVersion}, got ${app.version}`);
    }
    if (app.status !== 'pending_review' && app.status !== 'action_required') {
      return fail(res, 409, `Cannot approve an application with status '${app.status}'`);
    }

    await dbQuery.query('BEGIN');
    try {
      await dbQuery.query(
        `UPDATE ${schema}.worker_service_applications
         SET status = 'approved', approved_at = NOW(), reviewed_at = NOW(),
             reviewed_by = $1, review_reason = $2, updated_at = NOW(), version = version + 1
         WHERE id = $3`,
        [admin, reason ?? null, id]
      );

      await dbQuery.query(
        `INSERT INTO ${schema}.employee_services (employee_uid, service_id, created_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT DO NOTHING`,
        [app.worker_uid, app.service_id]
      );

      await dbQuery.query('COMMIT');
    } catch (txErr) {
      await dbQuery.query('ROLLBACK');
      throw txErr;
    }

    // Awaited: high-risk action requires strong audit consistency
    await writeSuccess({
      action: 'provider_application_approved',
      actionCategory: 'provider',
      actorUid: admin,
      entityType: 'provider_application',
      entityId: String(id),
      relatedEntities: [{ entityType: 'provider', entityId: app.worker_uid }],
      before: { status: app.status },
      after: { status: 'approved' },
      changedFields: ['status'],
      reason: reason ?? null,
      requestId: (req as any).id ?? null,
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });

    autoOnlineEngine.evaluateProvider(app.worker_uid, 'admin', admin).catch(() => {});
    return ok(res, { id, status: 'approved' });
  } catch (err: any) {
    const code = err?.statusCode ?? 500;
    return fail(res, code, err?.message ?? 'Failed to approve application');
  }
};

export const rejectServiceApplication = async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const { expectedVersion, reason } = req.body ?? {};
    const admin = adminUid(req);

    if (typeof expectedVersion !== 'number') {
      return fail(res, 400, 'expectedVersion (number) is required');
    }

    const { default: dbQuery } = await import('../db/dbQuery');
    const { db } = await import('../config');
    const schema = db.schema;

    const appRes = await dbQuery.query(
      `SELECT * FROM ${schema}.worker_service_applications WHERE id = $1 LIMIT 1`,
      [id]
    );
    if (!appRes.rowCount) return fail(res, 404, 'Application not found');

    const app = appRes.rows[0];
    if (app.version !== expectedVersion) {
      return fail(res, 409, `Version conflict: expected ${expectedVersion}, got ${app.version}`);
    }
    if (app.status !== 'pending_review' && app.status !== 'action_required') {
      return fail(res, 409, `Cannot reject an application with status '${app.status}'`);
    }

    await dbQuery.query(
      `UPDATE ${schema}.worker_service_applications
       SET status = 'rejected', reviewed_at = NOW(), reviewed_by = $1,
           review_reason = $2, updated_at = NOW(), version = version + 1
       WHERE id = $3`,
      [admin, reason ?? null, id]
    );

    // Awaited: high-risk action requires strong audit consistency
    await writeSuccess({
      action: 'provider_application_rejected',
      actionCategory: 'provider',
      actorUid: admin,
      entityType: 'provider_application',
      entityId: String(id),
      relatedEntities: [{ entityType: 'provider', entityId: app.worker_uid }],
      before: { status: app.status },
      after: { status: 'rejected' },
      changedFields: ['status'],
      reason: reason ?? null,
      requestId: (req as any).id ?? null,
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });

    autoOnlineEngine.evaluateProvider(app.worker_uid, 'admin', admin).catch(() => {});
    return ok(res, { id, status: 'rejected' });
  } catch (err: any) {
    const code = err?.statusCode ?? 500;
    return fail(res, code, err?.message ?? 'Failed to reject application');
  }
};

// ── Catalog Capabilities ──────────────────────────────────────────────────────

export const getProviderCatalogCapabilities = async (req: Request, res: Response) => {
  try {
    const uid = String(req.params.uid);
    const caps = await svc.getProviderCatalogCapabilities(uid);
    return ok(res, caps);
  } catch (err: any) {
    return fail(res, 500, err?.message ?? 'Failed to fetch catalog capabilities');
  }
};

// ── Requirements ──────────────────────────────────────────────────────────────

export const getProviderRequirements = async (req: Request, res: Response) => {
  try {
    const uid = String(req.params.uid);
    const docs = await svc.getProviderRequirements(uid);
    return ok(res, docs);
  } catch (err: any) {
    return fail(res, 500, err?.message ?? 'Failed to fetch requirements');
  }
};

export const uploadProviderRequirement = async (req: Request, res: Response) => {
  try {
    const uid = String(req.params.uid);
    const { file, name, requirementType } = req.body;
    if (!file || !name) return fail(res, 400, 'file (data URI) and name are required');
    if (!String(file).startsWith('data:')) return fail(res, 422, 'file must be a data URI');
    const doc = await svc.uploadProviderRequirement(uid, String(file), String(name), requirementType ? String(requirementType) : undefined);

    auditFire({
      action: 'provider_document_uploaded',
      actionCategory: 'file',
      outcome: 'success',
      actorUid: adminUid(req),
      entityType: 'provider_requirement',
      entityId: String(doc?.id ?? 'unknown'),
      entityDisplayName: String(name),
      relatedEntities: [{ entityType: 'provider', entityId: uid }],
      after: { requirementType: requirementType ?? null, name },
      requestId: (req as any).id ?? null,
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });

    autoOnlineEngine.evaluateProvider(uid, 'admin', adminUid(req)).catch(() => {});
    return ok(res, doc);
  } catch (err: any) {
    const status = err.message?.includes('not allowed') ? 422 : 500;
    return fail(res, status, err?.message ?? 'Failed to upload requirement');
  }
};

export const deleteProviderRequirement = async (req: Request, res: Response) => {
  try {
    const uid = String(req.params.uid);
    const id = Number(req.params.id);
    if (!id) return fail(res, 400, 'Invalid requirement id');
    const deleted = await svc.deleteProviderRequirement(uid, id);

    auditFire({
      action: 'provider_document_deleted',
      actionCategory: 'file',
      outcome: 'success',
      actorUid: adminUid(req),
      entityType: 'provider_requirement',
      entityId: String(id),
      relatedEntities: [{ entityType: 'provider', entityId: uid }],
      requestId: (req as any).id ?? null,
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });

    autoOnlineEngine.evaluateProvider(uid, 'admin', adminUid(req)).catch(() => {});
    return ok(res, deleted);
  } catch (err: any) {
    return fail(res, 404, err?.message ?? 'Requirement not found');
  }
};

export const verifyProviderRequirement = async (req: Request, res: Response) => {
  try {
    const uid = String(req.params.uid);
    const id = Number(req.params.id);
    if (!id) return fail(res, 400, 'Invalid requirement id');
    const { internalNote } = req.body;
    const result = await svc.verifyProviderRequirement(id, adminUid(req), uid, internalNote ? String(internalNote) : undefined);

    auditFire({
      action: 'provider_document_verified',
      actionCategory: 'onboarding',
      outcome: 'success',
      actorUid: adminUid(req),
      entityType: 'provider_requirement',
      entityId: String(id),
      relatedEntities: [{ entityType: 'provider', entityId: uid }],
      after: { decision: 'approved' },
      requestId: (req as any).id ?? null,
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });

    autoOnlineEngine.evaluateProvider(uid, 'admin', adminUid(req)).catch(() => {});
    return ok(res, result);
  } catch (err: any) {
    const status = err?.statusCode ?? (err?.message?.includes('not found') ? 404 : 500);
    return fail(res, status, err?.message ?? 'Failed to verify document');
  }
};

export const rejectProviderRequirement = async (req: Request, res: Response) => {
  try {
    const uid = String(req.params.uid);
    const id = Number(req.params.id);
    if (!id) return fail(res, 400, 'Invalid requirement id');
    const { reasonCode, providerMessage, internalNote } = req.body;
    if (!providerMessage || !String(providerMessage).trim()) {
      return fail(res, 400, 'providerMessage is required to reject a document');
    }
    const result = await svc.rejectProviderRequirement(
      id, adminUid(req), uid,
      reasonCode ? String(reasonCode) : 'unspecified',
      String(providerMessage),
      internalNote ? String(internalNote) : undefined,
    );

    auditFire({
      action: 'provider_document_rejected',
      actionCategory: 'onboarding',
      outcome: 'success',
      actorUid: adminUid(req),
      entityType: 'provider_requirement',
      entityId: String(id),
      relatedEntities: [{ entityType: 'provider', entityId: uid }],
      after: { decision: 'rejected', reasonCode: reasonCode ?? null },
      requestId: (req as any).id ?? null,
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });

    autoOnlineEngine.evaluateProvider(uid, 'admin', adminUid(req)).catch(() => {});
    return ok(res, result);
  } catch (err: any) {
    const status = err?.statusCode ?? (err?.message?.includes('not found') ? 404 : 500);
    return fail(res, status, err?.message ?? 'Failed to reject document');
  }
};

export const needsResubmissionProviderRequirement = async (req: Request, res: Response) => {
  try {
    const uid = String(req.params.uid);
    const id = Number(req.params.id);
    if (!id) return fail(res, 400, 'Invalid requirement id');
    const { reasonCode, providerMessage, internalNote } = req.body;
    if (!providerMessage || !String(providerMessage).trim()) {
      return fail(res, 400, 'providerMessage is required when requesting resubmission');
    }
    const result = await svc.needsResubmissionProviderRequirement(
      id, adminUid(req), uid,
      reasonCode ? String(reasonCode) : 'unspecified',
      String(providerMessage),
      internalNote ? String(internalNote) : undefined,
    );

    auditFire({
      action: 'provider_document_needs_resubmission',
      actionCategory: 'onboarding',
      outcome: 'success',
      actorUid: adminUid(req),
      entityType: 'provider_requirement',
      entityId: String(id),
      relatedEntities: [{ entityType: 'provider', entityId: uid }],
      after: { decision: 'needs_resubmission', reasonCode: reasonCode ?? null },
      requestId: (req as any).id ?? null,
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });

    autoOnlineEngine.evaluateProvider(uid, 'admin', adminUid(req)).catch(() => {});
    return ok(res, result);
  } catch (err: any) {
    const status = err?.statusCode ?? (err?.message?.includes('not found') ? 404 : 500);
    return fail(res, status, err?.message ?? 'Failed to request resubmission');
  }
};

// ── Jobs ──────────────────────────────────────────────────────────────────────

export const getProviderJobs = async (req: Request, res: Response) => {
  try {
    const uid = String(req.params.uid);
    const { status } = req.query;
    const page = parseIntQ(req.query.page, 1);
    const limit = Math.min(parseIntQ(req.query.limit, 30), 100);
    const result = await svc.getProviderJobs(uid, { status: status as string, page, limit });
    return ok(res, result.rows, {
      total: result.total,
      page: result.page,
      limit: result.limit,
    });
  } catch (err: any) {
    return fail(res, 500, err?.message ?? 'Failed to fetch jobs');
  }
};

// ── Performance ───────────────────────────────────────────────────────────────

export const getProviderPerformance = async (req: Request, res: Response) => {
  try {
    const uid = String(req.params.uid);
    const perf = await svc.getProviderPerformance(uid);
    return ok(res, perf);
  } catch (err: any) {
    return fail(res, 500, err?.message ?? 'Failed to fetch performance');
  }
};

// ── Earnings ──────────────────────────────────────────────────────────────────

export const getProviderEarnings = async (req: Request, res: Response) => {
  try {
    const uid = String(req.params.uid);
    const earnings = await svc.getProviderEarningsSummary(uid);
    return ok(res, earnings);
  } catch (err: any) {
    return fail(res, 500, err?.message ?? 'Failed to fetch earnings');
  }
};

// ── Availability ──────────────────────────────────────────────────────────────

export const getProviderAvailability = async (req: Request, res: Response) => {
  try {
    const uid = String(req.params.uid);
    const profile = await availEngine.getAvailabilityProfile(uid);
    return ok(res, profile);
  } catch (err: any) {
    return fail(res, err?.statusCode ?? 500, err?.message ?? 'Failed to fetch availability');
  }
};

export const getProviderTimeOff = async (req: Request, res: Response) => {
  try {
    const uid = String(req.params.uid);
    const timeOff = await availEngine.listTimeOff(uid);
    return ok(res, timeOff);
  } catch (err: any) {
    return fail(res, err?.statusCode ?? 500, err?.message ?? 'Failed to fetch time-off');
  }
};

export const createProviderTimeOff = async (req: Request, res: Response) => {
  try {
    const uid = String(req.params.uid);
    const created = await availEngine.createTimeOff(uid, req.body, adminUid(req));
    auditFire({
      action: 'provider_time_off_created',
      actionCategory: 'provider',
      outcome: 'success',
      actorUid: adminUid(req),
      entityType: 'provider',
      entityId: uid,
      after: { timeOffId: created.id, startDate: created.startDate, endDate: created.endDate },
      requestId: (req as any).id ?? null,
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
    return res.status(201).json({ status: 'success', data: created });
  } catch (err: any) {
    return fail(res, err?.statusCode ?? 500, err?.message ?? 'Failed to create time-off');
  }
};

export const cancelProviderTimeOff = async (req: Request, res: Response) => {
  try {
    const uid      = String(req.params.uid);
    const timeOffId = Number(req.params.timeOffId);
    const cancelled = await availEngine.cancelTimeOff(uid, timeOffId, adminUid(req), req.body?.reason);
    auditFire({
      action: 'provider_time_off_cancelled',
      actionCategory: 'provider',
      outcome: 'success',
      actorUid: adminUid(req),
      entityType: 'provider',
      entityId: uid,
      after: { timeOffId, cancelledAt: cancelled.cancelledAt },
      requestId: (req as any).id ?? null,
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
    return ok(res, cancelled);
  } catch (err: any) {
    return fail(res, err?.statusCode ?? 500, err?.message ?? 'Failed to cancel time-off');
  }
};

export const eligibilityPreviewAdmin = async (req: Request, res: Response) => {
  try {
    const uid     = String(req.params.uid);
    const { startAt, endAt, bookingId } = req.body ?? {};

    let result;
    if (bookingId) {
      result = await eligEngine.evaluateProviderForBooking(uid, String(bookingId));
    } else if (startAt) {
      result = await eligEngine.evaluateProviderForSlot(uid, {
        startAt,
        endAt: endAt ?? new Date(new Date(startAt).getTime() + 2 * 3600000).toISOString(),
        serviceId: req.body.serviceId ?? null,
        cityId:    null,
        branchId:  req.body.branchId  ?? null,
      });
    } else {
      return fail(res, 400, 'Provide either bookingId or startAt');
    }

    auditFire({
      action: 'provider_eligibility_preview_run',
      actionCategory: 'provider',
      outcome: 'success',
      actorUid: adminUid(req),
      entityType: 'provider',
      entityId: uid,
      after: { eligible: result.eligible, score: result.score },
      requestId: (req as any).id ?? null,
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });

    return ok(res, result);
  } catch (err: any) {
    return fail(res, err?.statusCode ?? 500, err?.message ?? 'Failed to run eligibility preview');
  }
};

export const getAvailabilityTimeline = async (req: Request, res: Response) => {
  try {
    const uid = String(req.params.uid);
    const profile  = await availEngine.getAvailabilityProfile(uid);
    const timeOff  = profile.timeOff.filter(t => t.status === 'active');

    // Build next 14 days timeline
    const today = new Date();
    const days: Array<{ date: string; dayLabel: string; available: boolean; timeOffBlocked: boolean; slots: any[] }> = [];

    for (let i = 0; i < 14; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      const dateStr   = d.toISOString().slice(0, 10);
      const dow       = d.getDay();
      const blocked   = timeOff.some(t => t.startDate <= dateStr && t.endDate >= dateStr);
      const daySlots  = profile.weeklySchedule.filter(sl => sl.dayOfWeek === dow && sl.isAvailable);

      days.push({
        date:            dateStr,
        dayLabel:        d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
        available:       !blocked && daySlots.length > 0,
        timeOffBlocked:  blocked,
        slots:           daySlots,
      });
    }

    return ok(res, { providerUid: uid, timezone: profile.timezone, days });
  } catch (err: any) {
    return fail(res, err?.statusCode ?? 500, err?.message ?? 'Failed to get availability timeline');
  }
};

// ── Service Area ──────────────────────────────────────────────────────────────

export const getProviderServiceArea = async (req: Request, res: Response) => {
  try {
    const uid     = String(req.params.uid);
    const profile = await areaEngine.getServiceAreaProfile(uid);
    return ok(res, profile);
  } catch (err: any) {
    return fail(res, err?.statusCode ?? 500, err?.message ?? 'Failed to fetch service area');
  }
};

// ── Account Status Mutation ───────────────────────────────────────────────────

export const updateProviderAccountStatus = async (req: Request, res: Response) => {
  try {
    const uid = String(req.params.uid);
    const { accountStatus, reason } = req.body ?? {};

    if (!accountStatus) return fail(res, 400, 'accountStatus is required');

    const updated = await svc.updateProviderAccountStatus(uid, accountStatus, adminUid(req), reason);

    auditFire({
      action: 'provider_status_changed',
      actionCategory: 'provider',
      outcome: 'success',
      actorUid: adminUid(req),
      entityType: 'provider',
      entityId: uid,
      after: { accountStatus },
      reason: reason ?? null,
      requestId: (req as any).id ?? null,
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });

    autoOnlineEngine.evaluateProvider(uid, 'admin', adminUid(req)).catch(() => {});
    return ok(res, { uid: updated.uid, accountStatus: updated.account_status });
  } catch (err: any) {
    const code = err?.statusCode ?? 500;
    return fail(res, code, err?.message ?? 'Failed to update account status');
  }
};

// ── Archive / Restore ─────────────────────────────────────────────────────────

export const setProviderArchive = async (req: Request, res: Response) => {
  try {
    const uid = String(req.params.uid);
    const { isArchive } = req.body ?? {};

    if (typeof isArchive !== 'boolean') {
      return fail(res, 400, 'isArchive (boolean) is required');
    }

    const updated = await svc.setProviderArchive(uid, isArchive);

    auditFire({
      action: isArchive ? 'provider_archived' : 'provider_restored',
      actionCategory: 'provider',
      outcome: 'success',
      actorUid: adminUid(req),
      entityType: 'provider',
      entityId: uid,
      after: { isArchive },
      requestId: (req as any).id ?? null,
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });

    autoOnlineEngine.evaluateProvider(uid, 'admin', adminUid(req)).catch(() => {});
    return ok(res, { uid: updated.uid, isArchive: updated.is_archive });
  } catch (err: any) {
    const code = err?.statusCode ?? 500;
    return fail(res, code, err?.message ?? 'Failed to update archive status');
  }
};

// ── Availability Write (admin-scoped, canonical engine) ───────────────────────

export const saveProviderAvailabilityAdmin = async (req: Request, res: Response) => {
  try {
    const uid = String(req.params.uid);
    const { schedule, weeklySchedule, timezone, expectedVersion } = req.body ?? {};
    const slots = weeklySchedule ?? schedule ?? [];

    const result = await availEngine.saveWeeklySchedule(
      uid, slots, timezone ?? 'Asia/Manila', adminUid(req), expectedVersion
    );

    auditFire({
      action: 'provider_availability_updated',
      actionCategory: 'provider',
      outcome: 'success',
      actorUid: adminUid(req),
      entityType: 'provider',
      entityId: uid,
      after: { version: result.version, slotCount: slots.length },
      requestId: (req as any).id ?? null,
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });

    return ok(res, { uid, saved: true, version: result.version, updatedAt: result.updatedAt });
  } catch (err: any) {
    return fail(res, err?.statusCode ?? 500, err?.message ?? 'Failed to save availability');
  }
};

export const deleteProviderAvailabilityAdmin = async (req: Request, res: Response) => {
  try {
    const uid = String(req.params.uid);
    const result = await availEngine.saveWeeklySchedule(uid, [], 'Asia/Manila', adminUid(req));
    auditFire({
      action: 'provider_availability_updated',
      actionCategory: 'provider',
      outcome: 'success',
      actorUid: adminUid(req),
      entityType: 'provider',
      entityId: uid,
      after: { cleared: true, version: result.version },
      requestId: (req as any).id ?? null,
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
    return ok(res, { uid, deleted: true, version: result.version });
  } catch (err: any) {
    return fail(res, err?.statusCode ?? 500, err?.message ?? 'Failed to delete availability');
  }
};

// ── Service Area Write (admin-scoped, canonical engine) ───────────────────────

// ── Requirement Definitions ───────────────────────────────────────────────────

export const getRequirementDefinitions = async (_req: Request, res: Response) => {
  try {
    return ok(res, svc.getRequirementDefinitions());
  } catch (err: any) {
    return fail(res, 500, err.message || 'Failed to load requirement definitions');
  }
};

// ── Provider Profile Update ───────────────────────────────────────────────────

export const updateProviderProfile = async (req: Request, res: Response) => {
  try {
    const uid = String(req.params.uid);
    const { firstName, lastName, phoneNumber, birthdate, gender } = req.body || {};

    const fields: any = {};
    if (firstName !== undefined) fields.firstName = firstName;
    if (lastName  !== undefined) fields.lastName  = lastName;
    if (phoneNumber !== undefined) fields.phoneNumber = phoneNumber;
    if (birthdate !== undefined) fields.birthdate = birthdate;
    if (gender !== undefined) fields.gender = gender;

    const updated = await svc.updateProviderProfile(uid, fields, adminUid(req));

    await writeSuccess({
      action: 'PROVIDER.PROFILE.UPDATED_BY_ADMIN',
      actionCategory: 'provider',
      actorUid: adminUid(req),
      entityType: 'provider',
      entityId: uid,
      changedFields: Object.keys(fields),
      reason: (req.body && req.body.reason) || null,
      requestId: (req as any).id || null,
      ipAddress: req.ip || null,
      userAgent: req.headers['user-agent'] || null,
    });

    return ok(res, updated);
  } catch (err: any) {
    const code = err.statusCode || 500;
    return fail(res, code, err.message || 'Failed to update provider profile');
  }
};

// ── Remove Provider Service Association ───────────────────────────────────────

export const removeProviderService = async (req: Request, res: Response) => {
  try {
    const uid = String(req.params.uid);
    const serviceId = Number(req.params.serviceId);
    if (!serviceId) return fail(res, 400, 'Invalid serviceId');

    const { reason } = req.body || {};
    if (!reason || !String(reason).trim()) {
      return fail(res, 400, 'reason is required to remove a provider service');
    }

    const result = await svc.removeProviderService(uid, serviceId, adminUid(req), String(reason));

    await writeSuccess({
      action: 'PROVIDER.SERVICE.REMOVED',
      actionCategory: 'provider',
      actorUid: adminUid(req),
      entityType: 'service',
      entityId: String(serviceId),
      relatedEntities: [{ entityType: 'provider', entityId: uid }],
      after: { serviceId, serviceName: result.serviceName, removed: true },
      reason: String(reason),
      requestId: (req as any).id || null,
      ipAddress: req.ip || null,
      userAgent: req.headers['user-agent'] || null,
    });

    autoOnlineEngine.evaluateProvider(uid, 'admin', adminUid(req)).catch(function() {});
    return ok(res, result);
  } catch (err: any) {
    const code = err.statusCode || (String(err.message || '').includes('not found') ? 404 : 500);
    return fail(res, code, err.message || 'Failed to remove provider service');
  }
};

export const saveProviderServiceAreaAdmin = async (req: Request, res: Response) => {
  try {
    const uid = String(req.params.uid);
    const { coverageMode, cityIds, branchIds, radiusKm, label, expectedVersion } = req.body ?? {};

    const result = await areaEngine.saveServiceArea(
      uid, { coverageMode, cityIds, branchIds, radiusKm, label }, adminUid(req), expectedVersion
    );

    auditFire({
      action: 'provider_service_area_updated',
      actionCategory: 'provider',
      outcome: 'success',
      actorUid: adminUid(req),
      entityType: 'provider',
      entityId: uid,
      after: { coverageMode, version: result.version },
      requestId: (req as any).id ?? null,
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });

    return ok(res, { uid, saved: true, version: result.version, updatedAt: result.updatedAt });
  } catch (err: any) {
    return fail(res, err?.statusCode ?? 500, err?.message ?? 'Failed to save service area');
  }
};

