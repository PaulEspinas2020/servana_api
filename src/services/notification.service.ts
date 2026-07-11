import dbQuery from "../db/dbQuery";
import { db } from "../config";
import { emitToProvider } from "../provider.realtime";
import { logCommunicationEvent } from "./adminCommunicationService";
const dbSchema = db.schema;

// ─── Lazy table init ──────────────────────────────────────────────────────────
// Tables are created on first use and the promise is reused for all subsequent calls.

let tablesReady: Promise<void> | null = null;

async function initTables(): Promise<void> {
  await dbQuery.query(`
    CREATE TABLE IF NOT EXISTS ${dbSchema}.provider_notifications (
      id             BIGSERIAL PRIMARY KEY,
      notification_key VARCHAR(64) UNIQUE NOT NULL DEFAULT gen_random_uuid()::varchar,
      worker_uid     VARCHAR(128) NOT NULL,
      type           VARCHAR(64)  NOT NULL DEFAULT 'system',
      status         VARCHAR(32)  NOT NULL DEFAULT 'unread',
      severity       VARCHAR(32)  NOT NULL DEFAULT 'info',
      title          VARCHAR(255) NOT NULL,
      safe_body      TEXT         NOT NULL,
      safe_context_label VARCHAR(255),
      route          JSONB,
      can_mark_read  BOOLEAN      NOT NULL DEFAULT true,
      can_dismiss    BOOLEAN      NOT NULL DEFAULT true,
      can_open_detail BOOLEAN     NOT NULL DEFAULT false,
      read_at        TIMESTAMPTZ,
      expires_at     TIMESTAMPTZ,
      created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_pn_worker_uid
      ON ${dbSchema}.provider_notifications (worker_uid, created_at DESC);

    CREATE TABLE IF NOT EXISTS ${dbSchema}.provider_alerts (
      id         BIGSERIAL PRIMARY KEY,
      alert_key  VARCHAR(64)  UNIQUE NOT NULL DEFAULT gen_random_uuid()::varchar,
      worker_uid VARCHAR(128) NOT NULL,
      type       VARCHAR(64)  NOT NULL DEFAULT 'unknown',
      severity   VARCHAR(32)  NOT NULL DEFAULT 'high',
      title      VARCHAR(255) NOT NULL,
      safe_body  TEXT         NOT NULL,
      is_dismissable BOOLEAN  NOT NULL DEFAULT true,
      route      JSONB,
      created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_pa_worker_uid
      ON ${dbSchema}.provider_alerts (worker_uid, created_at DESC);

    CREATE TABLE IF NOT EXISTS ${dbSchema}.provider_support_tickets (
      id          BIGSERIAL PRIMARY KEY,
      ticket_key  VARCHAR(64)  UNIQUE NOT NULL DEFAULT gen_random_uuid()::varchar,
      worker_uid  VARCHAR(128) NOT NULL,
      category    VARCHAR(64)  NOT NULL DEFAULT 'other',
      status      VARCHAR(64)  NOT NULL DEFAULT 'submitted',
      title       VARCHAR(100) NOT NULL,
      description TEXT         NOT NULL,
      created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_pst_worker_uid
      ON ${dbSchema}.provider_support_tickets (worker_uid, created_at DESC);

    CREATE TABLE IF NOT EXISTS ${dbSchema}.provider_notification_preferences (
      worker_uid       VARCHAR(128) PRIMARY KEY,
      job_assigned     BOOLEAN NOT NULL DEFAULT true,
      job_reminder     BOOLEAN NOT NULL DEFAULT false,
      payment_received BOOLEAN NOT NULL DEFAULT true,
      new_message      BOOLEAN NOT NULL DEFAULT true,
      promotions       BOOLEAN NOT NULL DEFAULT false,
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ${dbSchema}.provider_support_ticket_replies (
      id          BIGSERIAL PRIMARY KEY,
      ticket_key  VARCHAR(64)  NOT NULL,
      sender_type VARCHAR(32)  NOT NULL DEFAULT 'provider',
      safe_body   TEXT         NOT NULL,
      is_read     BOOLEAN      NOT NULL DEFAULT false,
      created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_pstr_ticket_key
      ON ${dbSchema}.provider_support_ticket_replies (ticket_key, created_at ASC);
  `);
}

function ensureTables(): Promise<void> {
  if (!tablesReady) tablesReady = initTables();
  return tablesReady;
}

// ─── Notification filter → SQL WHERE fragment ─────────────────────────────────

const FILTER_TYPE_MAP: Record<string, string[]> = {
  jobs:         ['assigned_job', 'active_job', 'job_status', 'booking_code', 'additional_work'],
  messages:     ['message'],
  requirements: ['requirement_review', 'verification'],
  earnings:     ['earnings_payout'],
  support:      ['support'],
  account:      ['account_security', 'profile_settings'],
  system:       ['system', 'maintenance'],
};

function buildNotificationFilter(
  filter: string | undefined,
  workerUid: string,
): { sql: string; params: any[] } {
  const base = `worker_uid = $1 AND (expires_at IS NULL OR expires_at > NOW())`;
  const params: any[] = [workerUid];

  if (!filter || filter === 'all') {
    return { sql: `WHERE ${base}`, params };
  }
  if (filter === 'unread') {
    return { sql: `WHERE ${base} AND status = 'unread'`, params };
  }
  const types = FILTER_TYPE_MAP[filter];
  if (!types) {
    return { sql: `WHERE ${base}`, params };
  }
  const placeholders = types.map((_, i) => `$${i + 2}`).join(', ');
  return {
    sql: `WHERE ${base} AND type IN (${placeholders})`,
    params: [...params, ...types],
  };
}

// ─── Row mappers ──────────────────────────────────────────────────────────────

function mapNotificationRow(row: any) {
  return {
    notificationKey:  row.notification_key,
    type:             row.type,
    status:           row.status,
    severity:         row.severity,
    title:            row.title,
    safeBody:         row.safe_body,
    safeContextLabel: row.safe_context_label ?? null,
    createdAt:        row.created_at ?? null,
    readAt:           row.read_at ?? null,
    expiresAt:        row.expires_at ?? null,
    route:            row.route ?? null,
    canMarkRead:      row.can_mark_read && row.status === 'unread',
    canDismiss:       row.can_dismiss,
    canOpenDetail:    row.can_open_detail,
  };
}

function mapAlertRow(row: any) {
  return {
    alertKey:      row.alert_key,
    type:          row.type,
    severity:      row.severity,
    title:         row.title,
    safeBody:      row.safe_body,
    isDismissable: row.is_dismissable,
    route:         row.route ?? null,
    createdAt:     row.created_at ?? null,
  };
}

function mapSupportTicketRow(row: any) {
  const activeStatuses   = ['open', 'waiting_for_support', 'waiting_for_provider', 'escalated'];
  const closedStatuses   = ['resolved', 'closed'];
  return {
    ticketKey:            row.ticket_key,
    providerSafeReference: null,
    category:             row.category,
    status:               row.status,
    title:                row.title,
    safeSummary:          row.description ? row.description.substring(0, 120) : '',
    createdAt:            row.created_at ?? null,
    updatedAt:            row.updated_at ?? null,
    canReply:             activeStatuses.includes(row.status),
    canAttach:            false,
    canClose:             ['open', 'waiting_for_support', 'escalated'].includes(row.status),
    canReopen:            closedStatuses.includes(row.status),
  };
}

// ─── Notification operations ──────────────────────────────────────────────────

export async function listNotifications(workerUid: string, filter?: string) {
  await ensureTables();
  const { sql, params } = buildNotificationFilter(filter, workerUid);
  const { rows } = await dbQuery.query(
    `SELECT * FROM ${dbSchema}.provider_notifications ${sql} ORDER BY created_at DESC LIMIT 100`,
    params,
  );
  return rows.map(mapNotificationRow);
}

export async function countUnreadNotifications(workerUid: string): Promise<number> {
  await ensureTables();
  const { rows } = await dbQuery.query(
    `SELECT COUNT(*) AS cnt FROM ${dbSchema}.provider_notifications
     WHERE worker_uid = $1 AND status = 'unread' AND (expires_at IS NULL OR expires_at > NOW())`,
    [workerUid],
  );
  return parseInt(rows[0]?.cnt ?? '0', 10);
}

export async function markNotificationReadByKey(workerUid: string, key: string) {
  await ensureTables();
  const { rowCount } = await dbQuery.query(
    `UPDATE ${dbSchema}.provider_notifications
     SET status = 'read', read_at = NOW()
     WHERE notification_key = $1 AND worker_uid = $2 AND status = 'unread'`,
    [key, workerUid],
  );
  return { found: (rowCount ?? 0) > 0 };
}

export async function markAllNotificationsReadForWorker(workerUid: string) {
  await ensureTables();
  await dbQuery.query(
    `UPDATE ${dbSchema}.provider_notifications
     SET status = 'read', read_at = NOW()
     WHERE worker_uid = $1 AND status = 'unread'`,
    [workerUid],
  );
}

export async function deleteNotificationByKey(workerUid: string, key: string) {
  await ensureTables();
  const { rowCount } = await dbQuery.query(
    `DELETE FROM ${dbSchema}.provider_notifications
     WHERE notification_key = $1 AND worker_uid = $2`,
    [key, workerUid],
  );
  return { found: (rowCount ?? 0) > 0 };
}

// ─── Create notification + real-time push ────────────────────────────────────

export interface NotificationInput {
  type?: string;
  severity?: string;
  title: string;
  safeBody: string;
  safeContextLabel?: string | null;
  route?: object | null;
  canMarkRead?: boolean;
  canDismiss?: boolean;
  canOpenDetail?: boolean;
  expiresAt?: Date | null;
}

/**
 * Insert a notification for a provider and immediately push it via Socket.IO.
 * Callers (booking, payment, additional-work flows) use this instead of
 * inserting directly into the table.
 */
export async function createNotification(workerUid: string, data: NotificationInput) {
  await ensureTables();
  const { rows } = await dbQuery.query(
    `INSERT INTO ${dbSchema}.provider_notifications
       (worker_uid, type, severity, title, safe_body, safe_context_label, route,
        can_mark_read, can_dismiss, can_open_detail, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      workerUid,
      data.type || "system",
      data.severity || "info",
      data.title,
      data.safeBody,
      data.safeContextLabel || null,
      data.route ? JSON.stringify(data.route) : null,
      data.canMarkRead !== false,
      data.canDismiss !== false,
      !!data.canOpenDetail,
      data.expiresAt || null,
    ],
  );
  const notification = mapNotificationRow(rows[0]);
  // Push real-time — no-op when socket server is not initialised (e.g. during tests)
  emitToProvider(workerUid, "notification", notification);
  // Fire-and-forget admin log
  logCommunicationEvent({
    channel: 'socket',
    status: 'sent',
    severity: (data.severity as any) || 'info',
    category: 'notification',
    recipientUid: workerUid,
    recipientRole: 'provider',
    senderRole: 'system',
    subject: data.title,
    safeBody: data.safeBody ? data.safeBody.substring(0, 300) : null,
    templateName: data.type || 'system',
    metadata: { notificationKey: notification.notificationKey, type: notification.type },
  }).catch(() => {});
  return notification;
}

// ─── Alert operations ─────────────────────────────────────────────────────────

export async function listAlerts(workerUid: string) {
  await ensureTables();
  const { rows } = await dbQuery.query(
    `SELECT * FROM ${dbSchema}.provider_alerts
     WHERE worker_uid = $1 ORDER BY created_at DESC LIMIT 20`,
    [workerUid],
  );
  return rows.map(mapAlertRow);
}

export async function deleteAlertByKey(workerUid: string, key: string) {
  await ensureTables();
  const { rowCount } = await dbQuery.query(
    `DELETE FROM ${dbSchema}.provider_alerts WHERE alert_key = $1 AND worker_uid = $2`,
    [key, workerUid],
  );
  return { found: (rowCount ?? 0) > 0 };
}

// ─── Support ticket operations ────────────────────────────────────────────────

export async function listSupportTickets(workerUid: string) {
  await ensureTables();
  const { rows } = await dbQuery.query(
    `SELECT * FROM ${dbSchema}.provider_support_tickets
     WHERE worker_uid = $1 ORDER BY created_at DESC LIMIT 50`,
    [workerUid],
  );
  return rows.map(mapSupportTicketRow);
}

export async function createSupportTicketRecord(
  workerUid: string,
  title: string,
  description: string,
  category: string,
) {
  await ensureTables();
  const { rows } = await dbQuery.query(
    `INSERT INTO ${dbSchema}.provider_support_tickets
       (worker_uid, title, description, category, status)
     VALUES ($1, $2, $3, $4, 'submitted')
     RETURNING *`,
    [workerUid, title, description, category],
  );
  return mapSupportTicketRow(rows[0]);
}

// ─── Notification preferences operations ─────────────────────────────────────

const DEFAULT_PREFS = {
  jobAssigned: true,
  jobReminder: false,
  paymentReceived: true,
  newMessage: true,
  promotions: false,
};

export async function getNotificationPrefs(workerUid: string) {
  await ensureTables();
  const { rows } = await dbQuery.query(
    `SELECT * FROM ${dbSchema}.provider_notification_preferences WHERE worker_uid = $1`,
    [workerUid],
  );
  if (rows.length === 0) return { ...DEFAULT_PREFS };
  const r = rows[0];
  return {
    jobAssigned:     r.job_assigned,
    jobReminder:     r.job_reminder,
    paymentReceived: r.payment_received,
    newMessage:      r.new_message,
    promotions:      r.promotions,
  };
}

export async function saveNotificationPrefs(workerUid: string, prefs: Partial<typeof DEFAULT_PREFS>) {
  await ensureTables();
  const merged = { ...DEFAULT_PREFS, ...prefs };
  await dbQuery.query(
    `INSERT INTO ${dbSchema}.provider_notification_preferences
       (worker_uid, job_assigned, job_reminder, payment_received, new_message, promotions, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (worker_uid) DO UPDATE SET
       job_assigned     = EXCLUDED.job_assigned,
       job_reminder     = EXCLUDED.job_reminder,
       payment_received = EXCLUDED.payment_received,
       new_message      = EXCLUDED.new_message,
       promotions       = EXCLUDED.promotions,
       updated_at       = NOW()`,
    [
      workerUid,
      merged.jobAssigned,
      merged.jobReminder,
      merged.paymentReceived,
      merged.newMessage,
      merged.promotions,
    ],
  );
  return merged;
}

// ─── Support ticket follow-ons ────────────────────────────────────────────────

function mapReplyRow(row: any) {
  return {
    id:         String(row.id),
    senderType: row.sender_type,
    safeBody:   row.safe_body,
    isRead:     row.is_read,
    createdAt:  row.created_at ?? null,
  };
}

export async function getSupportTicketDetail(workerUid: string, ticketKey: string) {
  await ensureTables();
  const { rows } = await dbQuery.query(
    `SELECT * FROM ${dbSchema}.provider_support_tickets
     WHERE ticket_key = $1 AND worker_uid = $2 LIMIT 1`,
    [ticketKey, workerUid],
  );
  if (!rows.length) return null;
  const { rows: replyRows } = await dbQuery.query(
    `SELECT * FROM ${dbSchema}.provider_support_ticket_replies
     WHERE ticket_key = $1 ORDER BY created_at ASC`,
    [ticketKey],
  );
  return { ...mapSupportTicketRow(rows[0]), replies: replyRows.map(mapReplyRow) };
}

export async function addSupportTicketReply(workerUid: string, ticketKey: string, message: string) {
  await ensureTables();
  const { rows: ownerRows, rowCount } = await dbQuery.query(
    `SELECT status FROM ${dbSchema}.provider_support_tickets
     WHERE ticket_key = $1 AND worker_uid = $2`,
    [ticketKey, workerUid],
  );
  if (!rowCount) return null;
  const currentStatus: string = ownerRows[0].status;
  const activeStatuses = ['open', 'waiting_for_support', 'waiting_for_provider', 'escalated'];
  if (!activeStatuses.includes(currentStatus)) {
    return { error: 'Ticket is not open for replies', currentStatus };
  }
  await dbQuery.query(
    `INSERT INTO ${dbSchema}.provider_support_ticket_replies (ticket_key, sender_type, safe_body)
     VALUES ($1, 'provider', $2)`,
    [ticketKey, String(message).substring(0, 2000)],
  );
  const { rows } = await dbQuery.query(
    `UPDATE ${dbSchema}.provider_support_tickets
     SET status = 'waiting_for_support', updated_at = NOW()
     WHERE ticket_key = $1 RETURNING *`,
    [ticketKey],
  );
  return mapSupportTicketRow(rows[0]);
}

export async function closeSupportTicket(workerUid: string, ticketKey: string) {
  await ensureTables();
  const { rows, rowCount } = await dbQuery.query(
    `UPDATE ${dbSchema}.provider_support_tickets
     SET status = 'closed', updated_at = NOW()
     WHERE ticket_key = $1 AND worker_uid = $2
       AND status IN ('open', 'waiting_for_support', 'escalated')
     RETURNING *`,
    [ticketKey, workerUid],
  );
  if (!rowCount) return null;
  return mapSupportTicketRow(rows[0]);
}

export async function reopenSupportTicket(workerUid: string, ticketKey: string) {
  await ensureTables();
  const { rows, rowCount } = await dbQuery.query(
    `UPDATE ${dbSchema}.provider_support_tickets
     SET status = 'open', updated_at = NOW()
     WHERE ticket_key = $1 AND worker_uid = $2
       AND status IN ('resolved', 'closed')
     RETURNING *`,
    [ticketKey, workerUid],
  );
  if (!rowCount) return null;
  return mapSupportTicketRow(rows[0]);
}

export async function countUnreadSupportReplies(workerUid: string): Promise<number> {
  await ensureTables();
  const { rows } = await dbQuery.query(
    `SELECT COUNT(*) AS cnt
     FROM ${dbSchema}.provider_support_ticket_replies r
     JOIN ${dbSchema}.provider_support_tickets t ON t.ticket_key = r.ticket_key
     WHERE t.worker_uid = $1 AND r.is_read = false AND r.sender_type = 'support'`,
    [workerUid],
  );
  return parseInt(rows[0]?.cnt ?? '0', 10);
}
