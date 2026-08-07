import { Request, Response } from 'express';
import {
  adminServerError, adminNotFound, adminBadRequest,
  adminValidationError, adminConflict, adminError,
} from '../helpers/adminError';
import * as svc from '../services/adminCommunicationService';
import { auditFire } from '../services/adminAuditService';

function boundedLimit(value: string | undefined, fallback = 50, max = 100): number {
  const parsed = value == null ? fallback : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

function positivePage(value: string | undefined): number {
  const parsed = value == null ? 1 : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

// ── GET /admin/communications/summary ────────────────────────────────────────

export async function getSummary(req: Request, res: Response) {
  try {
    const summary = await svc.getCommunicationSummary();
    res.json({ status: 'success', data: summary });
  } catch (err) {
    adminServerError(res, err);
  }
}

// ── GET /admin/communications/events ─────────────────────────────────────────

export async function listEvents(req: Request, res: Response) {
  try {
    const q = req.query as Record<string, string | undefined>;
    const filters: svc.CommFilters = {
      channel:        q.channel,
      status:         q.status,
      severity:       q.severity,
      category:       q.category,
      entityType:     q.entity_type,
      entityId:       q.entity_id,
      recipientUid:   q.recipient_uid,
      recipientEmail: q.recipient_email,
      templateName:   q.template_name,
      fromDate:       q.from_date,
      toDate:         q.to_date,
      search:         q.search,
      page:           positivePage(q.page),
      limit:          boundedLimit(q.limit),
    };
    const result = await svc.listCommunicationEvents(filters);
    res.json({ status: 'success', data: result });
  } catch (err) {
    adminServerError(res, err);
  }
}

// ── GET /admin/communications/events/:eventKey ────────────────────────────────

export async function getEventDetail(req: Request, res: Response) {
  try {
    const event = await svc.getCommunicationEventDetail(String(req.params.eventKey));
    if (!event) return adminNotFound(res, 'Communication event');
    res.json({ status: 'success', data: event });
  } catch (err) {
    adminServerError(res, err);
  }
}

// ── GET /admin/communications/entity/:entityType/:entityId ────────────────────

export async function getEntityTimeline(req: Request, res: Response) {
  try {
    const q = req.query as Record<string, string | undefined>;
    const limit = boundedLimit(q.limit);
    const items = await svc.getEntityCommunicationTimeline(
      String(req.params.entityType),
      String(req.params.entityId),
      limit,
    );
    res.json({ status: 'success', data: items });
  } catch (err) {
    adminServerError(res, err);
  }
}

// ── GET /admin/communications/recipient/:recipientUid ─────────────────────────

export async function getRecipientTimeline(req: Request, res: Response) {
  try {
    const q = req.query as Record<string, string | undefined>;
    const limit = boundedLimit(q.limit);
    const items = await svc.getRecipientCommunicationTimeline(String(req.params.recipientUid), limit);
    res.json({ status: 'success', data: items });
  } catch (err) {
    adminServerError(res, err);
  }
}

// ── GET /admin/communications/failures ───────────────────────────────────────

export async function listFailures(req: Request, res: Response) {
  try {
    const q = req.query as Record<string, string | undefined>;
    const limit = boundedLimit(q.limit);
    const items = await svc.findRetryableFailures(limit);
    res.json({ status: 'success', data: items });
  } catch (err) {
    adminServerError(res, err);
  }
}

// ── POST /admin/communications/events/:eventKey/retry ────────────────────────

export async function retryEvent(req: Request, res: Response) {
  try {
    const actor: string = (req as any).user?.uid ?? 'unknown';
    const eventKey = String(req.params.eventKey);
    const success = await svc.markEventRetried(eventKey, actor);
    if (!success) return adminError(res, 404, 'NOT_FOUND', 'Event not found or not in failed state');
    auditFire({
      action: 'comm_event_retried',
      actionCategory: 'notification',
      outcome: 'success',
      actorUid: actor,
      actorType: 'admin',
      entityType: 'notification',
      entityId: eventKey,
      source: 'admin_portal',
      requestId: (req as any).id,
    });
    res.json({ status: 'success', data: { eventKey, retried: true } });
  } catch (err) {
    adminServerError(res, err);
  }
}

// ── POST /admin/communications/events/bulk-retry ─────────────────────────────

export async function bulkRetryEvents(req: Request, res: Response) {
  try {
    const actor: string = (req as any).user?.uid ?? 'unknown';
    const { eventKeys } = req.body as { eventKeys: string[] };
    if (!Array.isArray(eventKeys) || eventKeys.length === 0) {
      return adminValidationError(res, 'eventKeys must be a non-empty array');
    }
    if (eventKeys.length > 50) {
      return adminValidationError(res, 'Max 50 events per bulk retry');
    }
    const results = await Promise.all(eventKeys.map((k) => svc.markEventRetried(k, actor)));
    const retried = results.filter(Boolean).length;
    auditFire({
      action: 'comm_bulk_retry',
      actionCategory: 'notification',
      outcome: 'success',
      actorUid: actor,
      actorType: 'admin',
      entityType: 'system',
      entityId: 'bulk',
      metadata: { count: retried },
      source: 'admin_portal',
      requestId: (req as any).id,
    });
    res.json({ status: 'success', data: { requested: eventKeys.length, retried } });
  } catch (err) {
    adminServerError(res, err);
  }
}

// ── GET /admin/communications/templates ──────────────────────────────────────

export async function listTemplates(req: Request, res: Response) {
  try {
    const q = req.query as Record<string, string | undefined>;
    const includeArchived = q.include_archived === 'true';
    const items = await svc.listNotificationTemplates(q.channel, includeArchived);
    res.json({ status: 'success', data: items });
  } catch (err) {
    adminServerError(res, err);
  }
}

// ── GET /admin/communications/templates/:templateKey ─────────────────────────

export async function getTemplate(req: Request, res: Response) {
  try {
    const tpl = await svc.getNotificationTemplate(String(req.params.templateKey));
    if (!tpl) return adminNotFound(res, 'Template');
    res.json({ status: 'success', data: tpl });
  } catch (err) {
    adminServerError(res, err);
  }
}

// ── POST /admin/communications/templates ─────────────────────────────────────

export async function createTemplate(req: Request, res: Response) {
  try {
    const actor: string = (req as any).user?.uid ?? 'unknown';
    const { templateKey, name, channel, category, subject, bodyTemplate, variables } = req.body as Record<string, any>;
    if (!templateKey || !name || !channel || !bodyTemplate) {
      return adminValidationError(res, 'templateKey, name, channel, bodyTemplate are required');
    }
    const tpl = await svc.createNotificationTemplate({
      templateKey:  String(templateKey),
      name:         String(name),
      channel,
      category:     category   || null,
      subject:      subject    || null,
      bodyTemplate: String(bodyTemplate),
      variables:    Array.isArray(variables) ? variables : [],
    });
    auditFire({
      action: 'comm_template_created',
      actionCategory: 'notification',
      outcome: 'success',
      actorUid: actor,
      actorType: 'admin',
      entityType: 'notification',
      entityId: tpl.id,
      after: { templateKey: tpl.templateKey, name: tpl.name, channel: tpl.channel },
      source: 'admin_portal',
      requestId: (req as any).id,
    });
    res.status(201).json({ status: 'success', data: tpl });
  } catch (err: any) {
    if (err.code === '23505') return adminConflict(res, 'A template with that key already exists');
    adminServerError(res, err);
  }
}

// ── PATCH /admin/communications/templates/:templateKey ───────────────────────

export async function updateTemplate(req: Request, res: Response) {
  try {
    const actor: string = (req as any).user?.uid ?? 'unknown';
    const { name, channel, category, subject, bodyTemplate, variables } = req.body as Record<string, any>;
    const tpl = await svc.updateNotificationTemplate(String(req.params.templateKey), {
      name,
      channel,
      category:     category    || null,
      subject:      subject     || null,
      bodyTemplate,
      variables:    Array.isArray(variables) ? variables : undefined,
    });
    if (!tpl) return adminNotFound(res, 'Template');
    auditFire({
      action: 'comm_template_updated',
      actionCategory: 'notification',
      outcome: 'success',
      actorUid: actor,
      actorType: 'admin',
      entityType: 'notification',
      entityId: tpl.id,
      source: 'admin_portal',
      requestId: (req as any).id,
    });
    res.json({ status: 'success', data: tpl });
  } catch (err) {
    adminServerError(res, err);
  }
}

// ── DELETE /admin/communications/templates/:templateKey ──────────────────────

export async function archiveTemplate(req: Request, res: Response) {
  try {
    const actor: string = (req as any).user?.uid ?? 'unknown';
    const templateKey = String(req.params.templateKey);
    const success = await svc.archiveNotificationTemplate(templateKey);
    if (!success) return adminNotFound(res, 'Template');
    auditFire({
      action: 'comm_template_archived',
      actionCategory: 'notification',
      outcome: 'success',
      actorUid: actor,
      actorType: 'admin',
      entityType: 'notification',
      entityId: templateKey,
      source: 'admin_portal',
      requestId: (req as any).id,
    });
    res.json({ status: 'success', data: { templateKey, archived: true } });
  } catch (err) {
    adminServerError(res, err);
  }
}

// ── POST /admin/communications/templates/:templateKey/preview ────────────────

export async function previewTemplate(req: Request, res: Response) {
  try {
    const tpl = await svc.getNotificationTemplate(String(req.params.templateKey));
    if (!tpl) return adminNotFound(res, 'Template');
    const variables: Record<string, string> = req.body.variables || {};
    const preview = svc.previewNotificationTemplate(tpl.bodyTemplate, variables);
    res.json({ status: 'success', data: { preview, subject: tpl.subject, channel: tpl.channel } });
  } catch (err) {
    adminServerError(res, err);
  }
}

// ── GET /admin/communications/conversations/:id ───────────────────────────────

export async function getConversationDetail(req: Request, res: Response) {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isInteger(id) || id <= 0) return adminBadRequest(res, 'Invalid conversation id');
    const detail = await svc.getAdminConversationDetail(id);
    if (!detail) return adminNotFound(res, 'Conversation');
    res.json({ status: 'success', data: detail });
  } catch (err) {
    adminServerError(res, err);
  }
}

// ── GET /admin/communications/conversations/:id/messages ──────────────────────

export async function getConversationMessages(req: Request, res: Response) {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isInteger(id) || id <= 0) return adminBadRequest(res, 'Invalid conversation id');
    const q = req.query as Record<string, string | undefined>;
    const limit = boundedLimit(q.limit);
    const parsedBefore = q.before ? parseInt(q.before, 10) : undefined;
    const before = parsedBefore && parsedBefore > 0 ? parsedBefore : undefined;
    const result = await svc.getAdminConversationMessages(id, limit, before);
    res.json({ status: 'success', data: result });
  } catch (err) {
    adminServerError(res, err);
  }
}

// ── POST /admin/communications/conversations/:id/messages ─────────────────────

export async function sendConversationMessage(req: Request, res: Response) {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isInteger(id) || id <= 0) return adminBadRequest(res, 'Invalid conversation id');
    const actor: string = (req as any).user?.uid ?? '';
    if (!actor) return adminBadRequest(res, 'Actor uid required');
    const { body, clientMsgId } = req.body as Record<string, string>;
    if (!body || !body.trim()) return adminBadRequest(res, 'body is required');
    if (!clientMsgId || clientMsgId.trim().length < 16 || clientMsgId.trim().length > 128) {
      return adminBadRequest(res, 'clientMsgId must be between 16 and 128 characters');
    }
    const message = await svc.sendAdminMessage(id, actor, body.trim(), clientMsgId);
    auditFire({
      action: 'chat_message_sent',
      actionCategory: 'notification',
      outcome: 'success',
      actorUid: actor,
      actorType: 'admin',
      entityType: 'notification',
      entityId: String(id),
      source: 'admin_portal',
      requestId: (req as any).id,
    });
    res.status(201).json({ status: 'success', data: message });
  } catch (err) {
    adminServerError(res, err);
  }
}

// ── GET /admin/communications/reports ────────────────────────────────────────

export async function listReports(req: Request, res: Response) {
  try {
    const q = req.query as Record<string, string | undefined>;
    const limit = boundedLimit(q.limit);
    const items = await svc.listMessageReports(limit);
    res.json({ status: 'success', data: items });
  } catch (err) {
    adminServerError(res, err);
  }
}

// ── PATCH /admin/communications/reports/:reportId ─────────────────────────────

export async function resolveReport(req: Request, res: Response) {
  try {
    const reportId = parseInt(String(req.params.reportId), 10);
    const actor: string = (req as any).user?.uid ?? '';
    if (!Number.isInteger(reportId) || reportId <= 0) return adminBadRequest(res, 'Invalid report id');
    if (!actor) return adminBadRequest(res, 'Actor uid required');
    const { action, note } = req.body as Record<string, string>;
    if (!action || !['dismiss', 'redact', 'warn'].includes(action)) {
      return adminBadRequest(res, 'action must be dismiss, redact, or warn');
    }
    const result = await svc.resolveMessageReport(reportId, actor, action as 'dismiss' | 'redact' | 'warn', note);
    if (!result) return adminNotFound(res, 'Report');
    auditFire({
      action: `chat_report_${action}`,
      actionCategory: 'notification',
      outcome: 'success',
      actorUid: actor,
      actorType: 'admin',
      entityType: 'notification',
      entityId: String(reportId),
      source: 'admin_portal',
      requestId: (req as any).id,
    });
    res.json({ status: 'success', data: result });
  } catch (err) {
    adminServerError(res, err);
  }
}

// ── GET /admin/communications/conversations ───────────────────────────────────

export async function getConversations(req: Request, res: Response) {
  try {
    const q = req.query as Record<string, string | undefined>;
    const limit = boundedLimit(q.limit);
    const items = await svc.getChatConversationSummaries(limit, q.booking_id);
    res.json({ status: 'success', data: items });
  } catch (err) {
    adminServerError(res, err);
  }
}

// ── CSV helper ────────────────────────────────────────────────────────────────

function csvField(val: unknown): string {
  const s = val == null ? '' : String(val).replace(/\r?\n/g, ' ');
  // Quote fields containing commas, double-quotes, or formula-injection chars
  if (/[,"]/.test(s) || /^[=+\-@\t]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// ── POST /admin/communications/export ────────────────────────────────────────

export async function exportEvents(req: Request, res: Response) {
  try {
    const actor: string = (req as any).user?.uid ?? 'unknown';
    const body = req.body as Record<string, any>;
    const filters: svc.CommFilters = {
      channel:    body.channel,
      status:     body.status,
      category:   body.category,
      entityType: body.entity_type,
      fromDate:   body.from_date,
      toDate:     body.to_date,
      limit:      500,
      page:       1,
    };
    const result = await svc.listCommunicationEvents(filters);
    auditFire({
      action: 'comm_export_requested',
      actionCategory: 'notification',
      outcome: 'success',
      actorUid: actor,
      actorType: 'admin',
      entityType: 'system',
      entityId: 'export',
      metadata: { rowCount: result.total },
      source: 'admin_portal',
      requestId: (req as any).id,
    });
    const header = 'event_key,channel,direction,status,severity,category,recipient_email,entity_type,entity_id,template_name,subject,created_at';
    const rows = result.items.map((e: any) =>
      [
        csvField(e.eventKey), csvField(e.channel), csvField(e.direction),
        csvField(e.status), csvField(e.severity), csvField(e.category),
        csvField(e.recipientEmail), csvField(e.entityType), csvField(e.entityId),
        csvField(e.templateName), csvField(e.subject), csvField(e.createdAt),
      ].join(','),
    );
    const csv = [header, ...rows].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="comm_events.csv"');
    res.send(csv);
  } catch (err) {
    adminServerError(res, err);
  }
}
