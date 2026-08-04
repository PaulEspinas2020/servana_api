import { Request, Response } from 'express';
import * as auditSvc from '../services/adminAuditService';
import { adminError, adminNotFound, adminValidationError, adminServerError, AdminErrorCode } from '../helpers/adminError';

const HTTP_TO_CODE: Record<number, AdminErrorCode> = {
  400: 'BUSINESS_RULE', 403: 'FORBIDDEN', 404: 'NOT_FOUND',
  409: 'CONFLICT', 422: 'VALIDATION_ERROR', 500: 'SERVER_ERROR',
};

const fail = (res: Response, httpStatus: number, message: string) =>
  adminError(res, httpStatus, HTTP_TO_CODE[httpStatus] ?? 'SERVER_ERROR', message);

const ok = (res: Response, data: unknown, meta?: unknown) =>
  res.status(200).json({
    status: 'success',
    data,
    ...(meta ? { meta } : {}),
  });

const actorUid = (req: Request): string => req.user?.uid ?? '';
const requestId = (req: Request): string | null => (req as any).id ?? null;

// ── GET /admin/audit-logs ─────────────────────────────────────────────────────

export const listAuditLogs = async (req: Request, res: Response) => {
  try {
    const {
      from_date, to_date, action, action_category, outcome,
      actor_uid, entity_type, entity_id, request_id, search,
      page, limit,
    } = req.query as Record<string, string | undefined>;

    const result = await auditSvc.findEvents({
      fromDate: from_date,
      toDate: to_date,
      action,
      actionCategory: action_category,
      outcome,
      actorUid: actor_uid,
      entityType: entity_type,
      entityId: entity_id,
      requestId: request_id,
      search,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 50,
    });

    return ok(res, result.rows, {
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: Math.ceil(result.total / result.limit),
      requestId: requestId(req),
      generatedAt: new Date().toISOString(),
      timezone: 'Asia/Manila',
    });
  } catch (err: any) {
    return adminServerError(res, err);
  }
};

// ── GET /admin/audit-logs/summary ─────────────────────────────────────────────

export const getAuditSummary = async (req: Request, res: Response) => {
  try {
    const { from_date, to_date, action_category, outcome, actor_uid, entity_type } =
      req.query as Record<string, string | undefined>;

    const summary = await auditSvc.getSummary({
      fromDate: from_date,
      toDate: to_date,
      actionCategory: action_category,
      outcome,
      actorUid: actor_uid,
      entityType: entity_type,
    });

    return ok(res, summary);
  } catch (err: any) {
    return adminServerError(res, err);
  }
};

// ── GET /admin/audit-logs/actions ─────────────────────────────────────────────

export const getAuditActions = async (_req: Request, res: Response) => {
  return ok(res, auditSvc.getActionRegistry());
};

// ── GET /admin/audit-logs/:eventId ────────────────────────────────────────────

export const getAuditEventDetail = async (req: Request, res: Response) => {
  try {
    const { eventId } = req.params;
    if (!eventId) return fail(res, 400, 'eventId is required');

    const event = await auditSvc.getEventById(String(eventId));
    if (!event) return adminNotFound(res, 'Audit event');

    return ok(res, event, {
      requestId: requestId(req),
      generatedAt: new Date().toISOString(),
      timezone: 'Asia/Manila',
    });
  } catch (err: any) {
    return adminServerError(res, err);
  }
};

// ── GET /admin/audit-logs/entity/:entityType/:entityId ────────────────────────

export const getEntityTimeline = async (req: Request, res: Response) => {
  try {
    const { entityType, entityId } = req.params;
    const limit = Math.min(200, parseInt(String(req.query.limit ?? 50), 10));
    const page = Math.max(1, parseInt(String(req.query.page ?? 1), 10));

    const result = await auditSvc.findEntityTimeline(String(entityType), String(entityId), { limit, page });

    return ok(res, result.rows, {
      total: result.total,
      page,
      limit,
      totalPages: Math.ceil(result.total / limit),
      requestId: requestId(req),
      generatedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    return adminServerError(res, err);
  }
};

// ── GET /admin/audit-logs/actor/:actorUid ─────────────────────────────────────

export const getActorHistory = async (req: Request, res: Response) => {
  try {
    const { actorUid: uid } = req.params;
    const limit = Math.min(200, parseInt(String(req.query.limit ?? 50), 10));
    const page = Math.max(1, parseInt(String(req.query.page ?? 1), 10));

    const result = await auditSvc.findActorTimeline(String(uid), { limit, page });

    return ok(res, result.rows, {
      total: result.total,
      page,
      limit,
      totalPages: Math.ceil(result.total / limit),
      requestId: requestId(req),
      generatedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    return adminServerError(res, err);
  }
};

// ── POST /admin/audit-logs/export ─────────────────────────────────────────────

export const exportAuditLogs = async (req: Request, res: Response) => {
  try {
    const { filters = {}, format = 'json', reason } = req.body as {
      filters?: Record<string, string>;
      format?: 'csv' | 'json';
      reason?: string;
    };

    if (!reason || !String(reason).trim()) {
      return adminValidationError(res, 'reason is required for audit export');
    }
    if (!['csv', 'json'].includes(format)) {
      return adminValidationError(res, 'format must be csv or json');
    }

    const result = await auditSvc.exportEvents(
      {
        fromDate:       filters.from_date,
        toDate:         filters.to_date,
        action:         filters.action,
        actionCategory: filters.action_category,
        outcome:        filters.outcome,
        actorUid:       filters.actor_uid,
        entityType:     filters.entity_type,
        entityId:       filters.entity_id,
      },
      format as 'csv' | 'json',
      String(reason).trim(),
      actorUid(req),
      requestId(req)
    );

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="audit-logs.csv"');
      return res.status(200).send(result.content);
    }

    return ok(res, { content: result.content, count: result.count, format });
  } catch (err: any) {
    return adminServerError(res, err);
  }
};
