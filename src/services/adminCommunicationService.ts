import { randomUUID } from 'crypto';
import dbQuery from '../db/dbQuery';
import { db } from '../config';

const dbSchema = db.schema;

// ── Types ────────────────────────────────────────────────────────────────────

export type CommChannel = 'email' | 'socket' | 'chat' | 'sms' | 'fcm';
export type CommDirection = 'outbound' | 'inbound';
export type CommStatus = 'sent' | 'delivered' | 'failed' | 'retried' | 'pending';
export type CommSeverity = 'info' | 'warning' | 'error';
export type CommCategory =
  | 'auth' | 'booking' | 'payment' | 'onboarding' | 'support'
  | 'notification' | 'chat' | 'system';

export interface CommLogInput {
  channel: CommChannel;
  direction?: CommDirection;
  status: CommStatus;
  severity?: CommSeverity;
  category?: CommCategory;
  recipientUid?: string | null;
  recipientEmail?: string | null;
  recipientName?: string | null;
  recipientRole?: string | null;
  senderUid?: string | null;
  senderRole?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  templateName?: string | null;
  subject?: string | null;
  safeBody?: string | null;
  providerResponse?: Record<string, unknown> | null;
  errorMessage?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface CommFilters {
  channel?: string;
  status?: string;
  severity?: string;
  category?: string;
  entityType?: string;
  entityId?: string;
  recipientUid?: string;
  recipientEmail?: string;
  templateName?: string;
  fromDate?: string;
  toDate?: string;
  search?: string;
  page?: number;
  limit?: number;
}

export interface TemplateInput {
  templateKey: string;
  name: string;
  channel: CommChannel;
  category?: CommCategory | null;
  subject?: string | null;
  bodyTemplate: string;
  variables?: string[];
}

// ── Sensitive field redaction ─────────────────────────────────────────────────

const REDACT_KEYS = [
  'password', 'token', 'authorization', 'secret', 'apikey', 'privatekey',
  'otp', 'resettoken', 'fcmtoken', 'fcm_token', 'sendgridkey', 'cometchatkey',
];

function redactValue(key: string, value: unknown): unknown {
  const lk = key.toLowerCase().replace(/_/g, '');
  if (REDACT_KEYS.some(p => lk.includes(p))) return '[REDACTED]';
  if (typeof value === 'string') {
    if (value.startsWith('data:')) return '[REDACTED_DATA_URI]';
    if (value.length > 500 && /^[A-Za-z0-9+/=]+$/.test(value)) return '[REDACTED_BASE64]';
  }
  return value;
}

export function redactForComm(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = redactValue(k, v);
  }
  return out;
}

// -- Schema (TAB 02) ----------------------------------------------------------
//
// `admin_communication_events` (+4 indexes), `admin_notification_templates`
// (+1 index) and `chat_message_reports` were created here at runtime by
// `initSchema`, memoised behind `ensureCommunicationSchema`, awaited at the top
// of nine operations, and declared as a startup dependency. All eight objects
// come from `scripts/baseline/000-baseline.sql`.
//
// `event_key` is UNIQUE with a gen_random_uuid() default
// (`admin_communication_events_event_key_key`). It is the external handle, not
// the BIGSERIAL id, and it is what makes a retried send idempotent rather than
// duplicated in an operator feed.
//
// -- chat_message_reports had TWO definitions, and this was the SUPERSET -------
//
// `chat/chat.repository.ts` also creates it, without `status`, `resolved_by`,
// `resolved_at` or `resolution_note` — the four moderation columns this service
// reads. Two `CREATE TABLE IF NOT EXISTS` for one object is a race with a silent
// loser, and had the subset won on a fresh database, every moderation query here
// would have failed with 42703. It never did, because the baseline creates the
// full table and both statements were no-ops against it.
//
// The subset definition still exists (chat.repository is deferred — it also runs
// a DML derivation of `chat_conversations.status`). That is safe ONLY because the
// baseline owns the table. Do not promote the subset to "the" definition.

// ── Row mappers ──────────────────────────────────────────────────────────────

function mapEventRow(row: any) {
  return {
    id:               String(row.id),
    eventKey:         row.event_key,
    channel:          row.channel,
    direction:        row.direction,
    status:           row.status,
    severity:         row.severity,
    category:         row.category ?? null,
    recipientUid:     row.recipient_uid ?? null,
    recipientEmail:   row.recipient_email ?? null,
    recipientName:    row.recipient_name ?? null,
    recipientRole:    row.recipient_role ?? null,
    senderUid:        row.sender_uid ?? null,
    senderRole:       row.sender_role ?? null,
    entityType:       row.entity_type ?? null,
    entityId:         row.entity_id ?? null,
    templateName:     row.template_name ?? null,
    subject:          row.subject ?? null,
    safeBody:         row.safe_body ?? null,
    providerResponse: row.provider_response ?? null,
    retryCount:       row.retry_count,
    lastRetryAt:      row.last_retry_at ?? null,
    errorMessage:     row.error_message ?? null,
    metadata:         row.metadata ?? null,
    createdAt:        row.created_at,
    updatedAt:        row.updated_at,
  };
}

function mapTemplateRow(row: any) {
  return {
    id:           String(row.id),
    templateKey:  row.template_key,
    name:         row.name,
    channel:      row.channel,
    category:     row.category ?? null,
    subject:      row.subject ?? null,
    bodyTemplate: row.body_template,
    variables:    row.variables ?? [],
    isActive:     row.is_active,
    createdAt:    row.created_at,
    updatedAt:    row.updated_at,
    archivedAt:   row.archived_at ?? null,
  };
}

// ── WHERE builder ─────────────────────────────────────────────────────────────

function buildEventWhere(filters: CommFilters): { clauses: string[]; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  if (filters.channel) {
    clauses.push(`channel = $${i++}`); params.push(filters.channel);
  }
  if (filters.status) {
    clauses.push(`status = $${i++}`); params.push(filters.status);
  }
  if (filters.severity) {
    clauses.push(`severity = $${i++}`); params.push(filters.severity);
  }
  if (filters.category) {
    clauses.push(`category = $${i++}`); params.push(filters.category);
  }
  if (filters.entityType) {
    clauses.push(`entity_type = $${i++}`); params.push(filters.entityType);
  }
  if (filters.entityId) {
    clauses.push(`entity_id = $${i++}`); params.push(filters.entityId);
  }
  if (filters.recipientUid) {
    clauses.push(`recipient_uid = $${i++}`); params.push(filters.recipientUid);
  }
  if (filters.recipientEmail) {
    clauses.push(`recipient_email ILIKE $${i++}`); params.push(`%${filters.recipientEmail}%`);
  }
  if (filters.templateName) {
    clauses.push(`template_name = $${i++}`); params.push(filters.templateName);
  }
  if (filters.fromDate) {
    clauses.push(`created_at >= $${i++}`); params.push(filters.fromDate);
  }
  if (filters.toDate) {
    clauses.push(`created_at <= $${i++}`); params.push(filters.toDate);
  }
  if (filters.search) {
    clauses.push(`(
      subject ILIKE $${i} OR
      safe_body ILIKE $${i} OR
      recipient_email ILIKE $${i} OR
      template_name ILIKE $${i} OR
      entity_id ILIKE $${i}
    )`);
    params.push(`%${filters.search}%`); i++;
  }

  return { clauses, params };
}

// ── Event log operations ──────────────────────────────────────────────────────

export async function logCommunicationEvent(input: CommLogInput): Promise<string> {
  const eventKey = randomUUID();
  await dbQuery.query(
    `INSERT INTO ${dbSchema}.admin_communication_events
       (event_key, channel, direction, status, severity, category,
        recipient_uid, recipient_email, recipient_name, recipient_role,
        sender_uid, sender_role, entity_type, entity_id,
        template_name, subject, safe_body, provider_response,
        error_message, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
    [
      eventKey,
      input.channel,
      input.direction || 'outbound',
      input.status,
      input.severity || 'info',
      input.category || null,
      input.recipientUid || null,
      input.recipientEmail || null,
      input.recipientName || null,
      input.recipientRole || null,
      input.senderUid || null,
      input.senderRole || 'system',
      input.entityType || null,
      input.entityId || null,
      input.templateName || null,
      input.subject || null,
      input.safeBody || null,
      input.providerResponse ? JSON.stringify(input.providerResponse) : null,
      input.errorMessage || null,
      input.metadata ? JSON.stringify(input.metadata) : null,
    ],
  );
  return eventKey;
}

export async function updateEventStatus(
  eventKey: string,
  status: CommStatus,
  opts?: { errorMessage?: string; providerResponse?: Record<string, unknown> },
): Promise<void> {
  await dbQuery.query(
    `UPDATE ${dbSchema}.admin_communication_events
     SET status = $1,
         error_message = COALESCE($2, error_message),
         provider_response = COALESCE($3, provider_response),
         updated_at = NOW()
     WHERE event_key = $4`,
    [
      status,
      opts && opts.errorMessage || null,
      opts && opts.providerResponse ? JSON.stringify(opts.providerResponse) : null,
      eventKey,
    ],
  );
}

export async function listCommunicationEvents(filters: CommFilters) {
  const page = Math.max(1, filters.page || 1);
  const limit = Math.min(100, Math.max(1, filters.limit || 50));
  const offset = (page - 1) * limit;

  const { clauses, params } = buildEventWhere(filters);
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const countParams = [...params];
  const rowParams = [...params, limit, offset];

  const [countRes, rowRes] = await Promise.all([
    dbQuery.query(
      `SELECT COUNT(*) AS total FROM ${dbSchema}.admin_communication_events ${where}`,
      countParams,
    ),
    dbQuery.query(
      `SELECT * FROM ${dbSchema}.admin_communication_events ${where}
       ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      rowParams,
    ),
  ]);

  return {
    total: parseInt(countRes.rows[0]?.total ?? '0', 10),
    page,
    limit,
    items: rowRes.rows.map(mapEventRow),
  };
}

export async function getCommunicationEventDetail(eventKey: string) {
  const { rows } = await dbQuery.query(
    `SELECT * FROM ${dbSchema}.admin_communication_events WHERE event_key = $1 LIMIT 1`,
    [eventKey],
  );
  return rows.length ? mapEventRow(rows[0]) : null;
}

export async function getCommunicationSummary() {
  const { rows } = await dbQuery.query(`
    SELECT
      COUNT(*)                                                            AS total,
      COUNT(*) FILTER (WHERE status = 'failed')                          AS failed,
      COUNT(*) FILTER (WHERE status IN ('failed','retried') AND retry_count > 0) AS retried,
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours') AS last_24h,
      COUNT(*) FILTER (WHERE channel = 'email')                          AS email_count,
      COUNT(*) FILTER (WHERE channel = 'socket')                         AS socket_count,
      COUNT(*) FILTER (WHERE channel = 'chat')                           AS chat_count,
      COUNT(*) FILTER (WHERE channel = 'fcm')                            AS fcm_count,
      COUNT(*) FILTER (WHERE status = 'failed' AND created_at >= NOW() - INTERVAL '24 hours') AS failed_24h
    FROM ${dbSchema}.admin_communication_events
  `);
  const r = rows[0] || {};
  return {
    total:       parseInt(r.total     || '0', 10),
    failed:      parseInt(r.failed    || '0', 10),
    retried:     parseInt(r.retried   || '0', 10),
    last24h:     parseInt(r.last_24h  || '0', 10),
    failed24h:   parseInt(r.failed_24h || '0', 10),
    byChannel: {
      email:   parseInt(r.email_count  || '0', 10),
      socket:  parseInt(r.socket_count || '0', 10),
      chat:    parseInt(r.chat_count   || '0', 10),
      fcm:     parseInt(r.fcm_count    || '0', 10),
    },
  };
}

export async function getEntityCommunicationTimeline(
  entityType: string,
  entityId: string,
  limit = 50,
) {
  const { rows } = await dbQuery.query(
    `SELECT * FROM ${dbSchema}.admin_communication_events
     WHERE entity_type = $1 AND entity_id = $2
     ORDER BY created_at DESC LIMIT $3`,
    [entityType, entityId, limit],
  );
  return rows.map(mapEventRow);
}

export async function getRecipientCommunicationTimeline(
  recipientUid: string,
  limit = 50,
) {
  const { rows } = await dbQuery.query(
    `SELECT * FROM ${dbSchema}.admin_communication_events
     WHERE recipient_uid = $1
     ORDER BY created_at DESC LIMIT $2`,
    [recipientUid, limit],
  );
  return rows.map(mapEventRow);
}

// ── Retry operations ──────────────────────────────────────────────────────────

export async function findRetryableFailures(limit = 50) {
  const { rows } = await dbQuery.query(
    `SELECT * FROM ${dbSchema}.admin_communication_events
     WHERE status = 'failed' AND retry_count < 5
     ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return rows.map(mapEventRow);
}

export async function markEventRetried(
  eventKey: string,
  adminUid: string,
  newStatus: CommStatus = 'retried',
): Promise<boolean> {
  const { rowCount } = await dbQuery.query(
    `UPDATE ${dbSchema}.admin_communication_events
     SET status = $1,
         retry_count = retry_count + 1,
         last_retry_at = NOW(),
         metadata = jsonb_set(
           COALESCE(metadata, '{}'::jsonb),
           '{lastRetriedBy}',
           $2::jsonb
         ),
         updated_at = NOW()
     WHERE event_key = $3 AND status = 'failed'`,
    [newStatus, JSON.stringify(adminUid), eventKey],
  );
  return (rowCount ?? 0) > 0;
}

export async function markEventNonRetryable(eventKey: string): Promise<boolean> {
  const { rowCount } = await dbQuery.query(
    `UPDATE ${dbSchema}.admin_communication_events
     SET retry_count = 5, updated_at = NOW()
     WHERE event_key = $1`,
    [eventKey],
  );
  return (rowCount ?? 0) > 0;
}

// ── Template operations ───────────────────────────────────────────────────────

export async function listNotificationTemplates(channel?: string, includeArchived = false) {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  if (channel) {
    conditions.push(`channel = $${i++}`); params.push(channel);
  }
  if (!includeArchived) {
    conditions.push(`archived_at IS NULL`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await dbQuery.query(
    `SELECT * FROM ${dbSchema}.admin_notification_templates ${where} ORDER BY name ASC`,
    params,
  );
  return rows.map(mapTemplateRow);
}

export async function getNotificationTemplate(templateKey: string) {
  const { rows } = await dbQuery.query(
    `SELECT * FROM ${dbSchema}.admin_notification_templates WHERE template_key = $1 LIMIT 1`,
    [templateKey],
  );
  return rows.length ? mapTemplateRow(rows[0]) : null;
}

export async function createNotificationTemplate(input: TemplateInput) {
  const { rows } = await dbQuery.query(
    `INSERT INTO ${dbSchema}.admin_notification_templates
       (template_key, name, channel, category, subject, body_template, variables)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING *`,
    [
      input.templateKey,
      input.name,
      input.channel,
      input.category || null,
      input.subject || null,
      input.bodyTemplate,
      JSON.stringify(input.variables || []),
    ],
  );
  return mapTemplateRow(rows[0]);
}

export async function updateNotificationTemplate(
  templateKey: string,
  patch: Partial<Omit<TemplateInput, 'templateKey'>>,
) {
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  if (patch.name !== undefined)         { sets.push(`name = $${i++}`);          params.push(patch.name); }
  if (patch.channel !== undefined)      { sets.push(`channel = $${i++}`);       params.push(patch.channel); }
  if (patch.category !== undefined)     { sets.push(`category = $${i++}`);      params.push(patch.category); }
  if (patch.subject !== undefined)      { sets.push(`subject = $${i++}`);       params.push(patch.subject); }
  if (patch.bodyTemplate !== undefined) { sets.push(`body_template = $${i++}`); params.push(patch.bodyTemplate); }
  if (patch.variables !== undefined)    { sets.push(`variables = $${i++}`);     params.push(JSON.stringify(patch.variables)); }

  if (!sets.length) return null;
  sets.push(`updated_at = NOW()`);
  params.push(templateKey);

  const { rows } = await dbQuery.query(
    `UPDATE ${dbSchema}.admin_notification_templates
     SET ${sets.join(', ')}
     WHERE template_key = $${i} AND archived_at IS NULL
     RETURNING *`,
    params,
  );
  return rows.length ? mapTemplateRow(rows[0]) : null;
}

export async function archiveNotificationTemplate(templateKey: string): Promise<boolean> {
  const { rowCount } = await dbQuery.query(
    `UPDATE ${dbSchema}.admin_notification_templates
     SET archived_at = NOW(), is_active = false, updated_at = NOW()
     WHERE template_key = $1 AND archived_at IS NULL`,
    [templateKey],
  );
  return (rowCount ?? 0) > 0;
}

export function previewNotificationTemplate(bodyTemplate: string, variables: Record<string, string>): string {
  let result = bodyTemplate;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g'), value);
  }
  return result;
}

// ── Admin conversation operations (booking group chat) ────────────────────────

export async function getAdminConversationDetail(conversationId: number) {
  try {
    const { rows } = await dbQuery.query(
      `SELECT
         c.id, c.booking_id, c.is_closed, c.last_message_at, c.created_at,
         b.status AS booking_status,
         b.final_price,
         b.schedule,
         b.user_id   AS customer_uid,
         b.worker_uid AS provider_uid,
         COALESCE(
           NULLIF(TRIM(COALESCE(uc_client.first_name, '') || ' ' || COALESCE(uc_client.last_name, '')), ''),
           NULLIF(TRIM(COALESCE(gc.first_name, '') || ' ' || COALESCE(gc.last_name, '')), '')
         ) AS customer_name,
         COALESCE(uc_client.email, gc.email) AS customer_email,
         uc_worker.first_name || ' ' || uc_worker.last_name AS provider_name,
         uc_worker.email AS provider_email,
         so.level_2 AS service_title,
         (SELECT COUNT(*) FROM ${dbSchema}.chat_messages m WHERE m.conversation_id = c.id AND m.deleted_at IS NULL) AS message_count
       FROM ${dbSchema}.chat_conversations c
       LEFT JOIN ${dbSchema}.bookings b ON b.id = c.booking_id
       LEFT JOIN ${dbSchema}.user_credentials uc_client ON uc_client.uid = b.user_id
       LEFT JOIN ${dbSchema}.guest_customers gc ON gc.guest_customer_id = b.guest_customer_id
       LEFT JOIN ${dbSchema}.user_credentials uc_worker ON uc_worker.uid = b.worker_uid
       LEFT JOIN ${dbSchema}.service_options so ON so.id = b.service_option_id
       WHERE c.id = $1`,
      [conversationId]
    );
    if (!rows.length) return null;
    const r = rows[0];
    // Participants
    const parts = await dbQuery.query(
      `SELECT p.user_uid, p.role, p.joined_at, p.left_at
         FROM ${dbSchema}.chat_participants p
        WHERE p.conversation_id = $1 ORDER BY p.joined_at ASC`,
      [conversationId]
    );
    return {
      id:            r.id,
      bookingId:     r.booking_id,
      isClosed:      r.is_closed,
      lastMessageAt: r.last_message_at,
      createdAt:     r.created_at,
      messageCount:  parseInt(r.message_count || '0', 10),
      bookingRef:    r.booking_id ? String(r.booking_id) : null,
      serviceTitle:  r.service_title ?? null,
      customerUid:   r.customer_uid ?? null,
      customerName:  r.customer_name ?? null,
      customerEmail: r.customer_email ?? null,
      providerUid:   r.provider_uid ?? null,
      providerName:  r.provider_name ?? null,
      providerEmail: r.provider_email ?? null,
      participants:  parts.rows.map((p: any) => ({
        uid:      p.user_uid,
        role:     p.role,
        joinedAt: p.joined_at,
        leftAt:   p.left_at ?? null,
      })),
    };
  } catch (error) {
    throw error;
  }
}

export async function getAdminConversationMessages(conversationId: number, limit = 50, before?: number) {
  const params: unknown[] = [conversationId, Math.min(limit, 100)];
  let cursor = '';
  if (before) { cursor = `AND m.id < $3`; params.push(before); }
  try {
    const { rows } = await dbQuery.query(
      `SELECT m.*,
              uc.first_name, uc.last_name,
              COALESCE(
                json_agg(a.*) FILTER (WHERE a.id IS NOT NULL AND m.deleted_at IS NULL), '[]'
              ) AS attachments
         FROM ${dbSchema}.chat_messages m
         LEFT JOIN ${dbSchema}.user_credentials uc ON uc.uid = m.sender_uid
         LEFT JOIN ${dbSchema}.chat_message_attachments a ON a.message_id = m.id
        WHERE m.conversation_id = $1 ${cursor}
        GROUP BY m.id, uc.first_name, uc.last_name
        ORDER BY m.id DESC LIMIT $2`,
      params
    );
    const capped = Math.min(limit, 100);
    // Fetched DESC for keyset pagination; reverse to display oldest-first in chat transcript
    const messages = rows.reverse().map((r: any) => ({
      id:           r.id,
      conversationId,
      senderUid:    r.sender_uid,
      senderRole:   r.sender_role,
      senderName:   r.first_name ? `${r.first_name} ${r.last_name}` : null,
      type:         r.type,
      body:         r.deleted_at ? null : r.body,
      metadata:     r.metadata,
      clientMsgId:  r.client_msg_id,
      editedAt:     r.edited_at,
      deletedAt:    r.deleted_at,
      createdAt:    r.created_at,
      attachments:  Array.isArray(r.attachments) ? r.attachments : [],
    }));
    const hasMore = rows.length === capped;
    const oldestId = messages.length ? messages[0].id : null;
    return { messages, hasMore, oldestId };
  } catch (error) {
    throw error;
  }
}

export async function sendAdminMessage(
  conversationId: number,
  adminUid: string,
  body: string,
  clientMsgId?: string
) {
  const { sendMessage } = await import('../chat/chat.service');
  const actor = { uid: adminUid, role: 1 };
  return sendMessage(actor, conversationId, {
    type: 'text',
    body,
    clientMsgId: clientMsgId || null,
  });
}

export async function listMessageReports(limit = 50) {
  try {
    const { rows } = await dbQuery.query(
      `SELECT r.*, m.body AS message_body, m.sender_uid, m.conversation_id,
              uc_rep.first_name || ' ' || uc_rep.last_name AS reporter_name
         FROM ${dbSchema}.chat_message_reports r
         LEFT JOIN ${dbSchema}.chat_messages m ON m.id = r.message_id
         LEFT JOIN ${dbSchema}.user_credentials uc_rep ON uc_rep.uid = r.reporter_uid
        ORDER BY r.created_at DESC LIMIT $1`,
      [limit]
    );
    return rows.map((r: any) => ({
      id:              r.id,
      messageId:       r.message_id,
      reportedByUid:   r.reporter_uid,
      reason:          r.category,
      messageBody:     r.message_body ?? null,
      conversationId:  r.conversation_id,
      status:          r.status,
      resolvedByUid:   r.resolved_by ?? null,
      resolvedAt:      r.resolved_at ?? null,
      resolutionNote:  r.resolution_note ?? null,
      createdAt:       r.created_at,
    }));
  } catch {
    return [];
  }
}

export async function resolveMessageReport(
  reportId: number,
  adminUid: string,
  action: 'dismiss' | 'redact' | 'warn',
  note?: string
) {
  const { rows } = await dbQuery.query(
    `UPDATE ${dbSchema}.chat_message_reports
     SET status = $1, resolved_by = $2, resolved_at = NOW(), resolution_note = $3
     WHERE id = $4 AND COALESCE(status, 'pending') = 'pending' RETURNING *`,
    [action === 'dismiss' ? 'dismissed' : 'actioned', adminUid, note || null, reportId]
  );
  if (!rows.length) return null;

  if (action === 'redact') {
    const report = rows[0];
    const { deleteMessage } = await import('../chat/chat.service');
    await deleteMessage(
      { uid: adminUid, role: 1 },
      Number(report.conversation_id),
      Number(report.message_id),
    );
  }
  return rows[0];
}

// ── Chat conversation summaries (custom Socket.IO chat system) ────────────────

export async function getChatConversationSummaries(limit = 50, bookingId?: string) {
  // Uses the existing chat_conversations + chat_messages tables
  let where = '';
  const params: unknown[] = [limit];
  if (bookingId) {
    where = 'WHERE c.booking_id = $2';
    params.push(bookingId);
  }
  try {
    const { rows } = await dbQuery.query(
      `SELECT
         c.id              AS conversation_id,
         c.booking_id,
         c.is_closed,
         c.last_message_at,
         c.created_at,
         (SELECT COUNT(*) FROM ${dbSchema}.chat_messages m WHERE m.conversation_id = c.id AND m.deleted_at IS NULL) AS message_count,
         (SELECT m2.body FROM ${dbSchema}.chat_messages m2 WHERE m2.conversation_id = c.id AND m2.deleted_at IS NULL ORDER BY m2.created_at DESC LIMIT 1) AS last_message_body,
         (SELECT m3.sender_role FROM ${dbSchema}.chat_messages m3 WHERE m3.conversation_id = c.id AND m3.deleted_at IS NULL ORDER BY m3.created_at DESC LIMIT 1) AS last_sender_role
       FROM ${dbSchema}.chat_conversations c
       ${where}
       ORDER BY c.last_message_at DESC NULLS LAST LIMIT $1`,
      params,
    );
    return rows.map((r: any) => ({
      conversationId:  String(r.conversation_id),
      bookingId:       r.booking_id ? String(r.booking_id) : null,
      isClosed:        r.is_closed,
      lastMessageAt:   r.last_message_at,
      createdAt:       r.created_at,
      messageCount:    parseInt(r.message_count || '0', 10),
      lastMessageBody: r.last_message_body ? String(r.last_message_body).substring(0, 120) : null,
      lastSenderRole:  r.last_sender_role ?? null,
    }));
  } catch (error) {
    throw error;
  }
}
