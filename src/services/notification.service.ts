import dbQuery from "../db/dbQuery";
import { db } from "../config";
import { emitToProvider } from "../provider.realtime";
import { logCommunicationEvent } from "./adminCommunicationService";
const dbSchema = db.schema;

/**
 * Sends a provider push.
 *
 * The `data` payload is what makes the notification ACTIONABLE. Without it the
 * message carried title and body only, so tapping it could open the app but
 * never the thing it was about — the `route` was written to the notification
 * row and dropped from the push.
 *
 * FCM requires every data value to be a string, hence the coercion. Only safe
 * identifiers travel: a page name, a booking id and the notification key. No
 * customer name, address or note is ever put here — §39 forbids exposing that
 * on a lock screen, and `data` is readable by the OS before the app decides
 * anything.
 */
async function sendFcmPushToWorker(
  workerUid: string,
  title: string,
  body: string,
  route?: { page?: string; screen?: string; bookingId?: string; caseId?: string; applicationId?: string; contextType?: string } | null,
  meta?: { type?: string; notificationKey?: string },
): Promise<void> {
  const type = normalizeNotificationType(meta?.type);
  const preferences = await getNotificationPrefs(workerUid);
  const preferenceKey = providerPushPreferenceForType(type);
  if (!preferences[preferenceKey]) return;

  const { rows } = await dbQuery.query(
    `SELECT token FROM ${dbSchema}.provider_notification_device_tokens WHERE worker_uid = $1
     UNION
     SELECT fcm_token AS token FROM ${dbSchema}.user_credentials
     WHERE uid = $1 AND fcm_token IS NOT NULL`,
    [workerUid],
  );
  const tokens = rows.map((row: any) => String(row.token ?? '')).filter(Boolean).slice(0, 500);
  if (!tokens.length) return;

  const data: Record<string, string> = {};
  if (route?.page) data.page = String(route.page);
  if (route?.screen) data.screen = String(route.screen);
  if (route?.bookingId) data.bookingId = String(route.bookingId);
  if (route?.caseId) data.caseId = String(route.caseId);
  if (route?.applicationId) data.applicationId = String(route.applicationId);
  if (route?.contextType) data.contextType = String(route.contextType);
  if (meta?.type) data.type = String(meta.type);
  if (meta?.notificationKey) data.notificationKey = String(meta.notificationKey);

  const { getMessaging } = await import('firebase-admin/messaging');
  const { firebaseAdmin } = await import('../middleware/firebaseApp');
  await Promise.allSettled(tokens.map((token: string) =>
    getMessaging(firebaseAdmin).send({
      token,
      notification: { title, body },
      data,
      android: { priority: 'high' },
      apns: { payload: { aps: { contentAvailable: true } } },
    }),
  ));
}

type ProviderPushPreferenceKey = keyof typeof DEFAULT_PREFS;

function providerPushPreferenceForType(type: string): ProviderPushPreferenceKey {
  if (type.includes('reminder')) return 'jobReminder';
  if (type.includes('booking') || type.includes('job') || type === 'assigned_job') return 'jobAssigned';
  if (type.includes('payment') || type.includes('payout') || type.includes('earning')) return 'paymentReceived';
  if (type.includes('message') || type.includes('chat')) return 'newMessage';
  if (type.includes('promotion')) return 'promotions';
  if (type.includes('requirement') || type.includes('verification') || type.includes('review') || type.includes('moderated')) return 'requirementReview';
  if (type.includes('support') || type.includes('safety')) return 'support';
  if (type.includes('account') || type.includes('security') || type.includes('profile')) return 'accountSecurity';
  return 'system';
}

// ─── Lazy table init ──────────────────────────────────────────────────────────
// Tables are created on first use and the promise is reused for all subsequent calls.

let tablesReady: Promise<void> | null = null;

async function initTables(): Promise<void> {
  await dbQuery.query(`
    CREATE TABLE IF NOT EXISTS ${dbSchema}.provider_notifications (
      id             BIGSERIAL PRIMARY KEY,
      notification_key VARCHAR(64) NOT NULL DEFAULT gen_random_uuid()::varchar,
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

    CREATE TABLE IF NOT EXISTS ${dbSchema}.provider_notification_device_tokens (
      token       TEXT PRIMARY KEY,
      worker_uid  VARCHAR(128) NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_pndt_worker_uid
      ON ${dbSchema}.provider_notification_device_tokens (worker_uid);

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
      worker_uid         VARCHAR(128) PRIMARY KEY,
      job_assigned       BOOLEAN NOT NULL DEFAULT true,
      job_reminder       BOOLEAN NOT NULL DEFAULT false,
      payment_received   BOOLEAN NOT NULL DEFAULT true,
      new_message        BOOLEAN NOT NULL DEFAULT true,
      promotions         BOOLEAN NOT NULL DEFAULT false,
      requirement_review BOOLEAN NOT NULL DEFAULT true,
      support            BOOLEAN NOT NULL DEFAULT true,
      account_security   BOOLEAN NOT NULL DEFAULT true,
      system             BOOLEAN NOT NULL DEFAULT true,
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- Additive columns for tables that may already exist without them (ST-P1-06)
    ALTER TABLE ${dbSchema}.provider_notification_preferences ADD COLUMN IF NOT EXISTS requirement_review BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE ${dbSchema}.provider_notification_preferences ADD COLUMN IF NOT EXISTS support            BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE ${dbSchema}.provider_notification_preferences ADD COLUMN IF NOT EXISTS account_security   BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE ${dbSchema}.provider_notification_preferences ADD COLUMN IF NOT EXISTS system             BOOLEAN NOT NULL DEFAULT true;

    -- Idempotency is owner-scoped. A global notification_key constraint caused
    -- fan-out jobs (for example the daily reminder) to insert for the first
    -- provider only and silently suppress every subsequent provider.
    ALTER TABLE ${dbSchema}.provider_notifications
      DROP CONSTRAINT IF EXISTS provider_notifications_notification_key_key;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_notifications_owner_key
      ON ${dbSchema}.provider_notifications (worker_uid, notification_key);

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

const FILTER_SQL_MAP: Record<string, string> = {
  jobs: `(LOWER(type) IN ('assigned_job','active_job','job_status','booking_code','additional_work')
          OR LOWER(type) LIKE 'booking_%' OR LOWER(type) LIKE 'job_%')`,
  messages: `(LOWER(type) LIKE '%message%' OR LOWER(type) LIKE '%chat%')`,
  requirements: `(LOWER(type) LIKE '%requirement%' OR LOWER(type) LIKE '%verification%'
                  OR LOWER(type) LIKE '%review%' OR LOWER(type) LIKE '%moderated%')`,
  earnings: `(LOWER(type) LIKE '%earning%' OR LOWER(type) LIKE '%payment%' OR LOWER(type) LIKE '%payout%')`,
  support: `(LOWER(type) LIKE '%support%' OR LOWER(type) LIKE '%safety%')`,
  account: `(LOWER(type) LIKE '%account%' OR LOWER(type) LIKE '%profile%')`,
  system: `(LOWER(type) IN ('system','maintenance'))`,
};

const SAFE_KEY = /^[A-Za-z0-9._:-]{1,64}$/;
const SAFE_ROUTE_VALUE = /^[A-Za-z0-9._:/-]{1,160}$/;
const SAFE_ROUTE_KEYS = new Set([
  'page', 'screen', 'bookingId', 'caseId', 'applicationId', 'routeKey',
  'resourceId', 'routeLabel', 'commandsRoute', 'queryParams',
  'requiresAccessCheck', 'contextType',
]);

/** Route metadata is navigation intent, never arbitrary producer data. */
export function sanitizeNotificationRoute(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const route: Record<string, unknown> = {};
  for (const key of SAFE_ROUTE_KEYS) {
    const raw = input[key];
    if (raw === undefined || raw === null) continue;
    if (key === 'requiresAccessCheck' && typeof raw === 'boolean') {
      route[key] = raw;
    } else if (key === 'commandsRoute' && Array.isArray(raw)) {
      const commands = raw.filter((part): part is string => typeof part === 'string').slice(0, 4);
      const providerRoot = commands[0];
      const safeTail = commands.slice(1).every((part) =>
        /^[A-Za-z0-9._:-]{1,128}$/.test(part) && !part.includes('..'),
      );
      if (
        typeof providerRoot === 'string' &&
        /^\/provider\/[A-Za-z0-9/_-]{1,140}$/.test(providerRoot) &&
        !providerRoot.includes('..') &&
        safeTail
      ) route[key] = commands;
    } else if (key === 'queryParams' && typeof raw === 'object' && !Array.isArray(raw)) {
      const params: Record<string, string> = {};
      for (const [paramKey, paramValue] of Object.entries(raw as Record<string, unknown>).slice(0, 8)) {
        if (SAFE_ROUTE_VALUE.test(paramKey) && typeof paramValue === 'string' && SAFE_ROUTE_VALUE.test(paramValue)) {
          params[paramKey] = paramValue;
        }
      }
      if (Object.keys(params).length) route[key] = params;
    } else if (typeof raw === 'string' && SAFE_ROUTE_VALUE.test(raw)) {
      route[key] = raw;
    }
  }
  return Object.keys(route).length ? route : null;
}

export function isSafeNotificationKey(value: unknown): value is string {
  return typeof value === 'string' && SAFE_KEY.test(value);
}

function cleanNotificationText(value: unknown, maxLength: number): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted email]')
    .replace(/(?<!\d)(?:\+?63|0)9\d{9}(?!\d)/g, '[redacted phone]')
    .replace(/\b(?:pay|src|pi|link|pm)_[A-Za-z0-9_-]{8,}\b/g, '[redacted payment reference]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '[redacted id]')
    .replace(/\b\d{13,19}\b/g, '[redacted number]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalizeNotificationType(value: unknown): string {
  const normalized = String(value ?? 'system').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
  return normalized.slice(0, 64) || 'system';
}

function normalizeSeverity(value: unknown): string {
  const normalized = String(value ?? 'info').trim().toLowerCase();
  return ['critical', 'high', 'medium', 'low', 'info', 'success', 'warning', 'danger', 'neutral'].includes(normalized)
    ? normalized
    : 'info';
}

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
  const filterSql = FILTER_SQL_MAP[filter];
  if (!filterSql) {
    return { sql: `WHERE ${base}`, params };
  }
  return {
    sql: `WHERE ${base} AND ${filterSql}`,
    params,
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
  const current = await dbQuery.query(
    `SELECT status, can_mark_read FROM ${dbSchema}.provider_notifications
     WHERE notification_key = $1 AND worker_uid = $2 LIMIT 1`,
    [key, workerUid],
  );
  if (!current.rowCount) return { found: false, allowed: false, changed: false };
  if (!current.rows[0].can_mark_read) return { found: true, allowed: false, changed: false };
  if (current.rows[0].status !== 'unread') return { found: true, allowed: true, changed: false };
  const { rowCount } = await dbQuery.query(
    `UPDATE ${dbSchema}.provider_notifications
     SET status = 'read', read_at = NOW()
     WHERE notification_key = $1 AND worker_uid = $2 AND status = 'unread' AND can_mark_read = true`,
    [key, workerUid],
  );
  const changed = (rowCount ?? 0) > 0;
  if (changed) emitToProvider(workerUid, 'notification:read', { notificationKey: key });
  return { found: true, allowed: true, changed };
}

export async function markAllNotificationsReadForWorker(workerUid: string) {
  await ensureTables();
  const { rowCount } = await dbQuery.query(
    `UPDATE ${dbSchema}.provider_notifications
     SET status = 'read', read_at = NOW()
     WHERE worker_uid = $1 AND status = 'unread' AND can_mark_read = true`,
    [workerUid],
  );
  emitToProvider(workerUid, 'notification:all-read', {});
  return { changed: rowCount ?? 0 };
}

export async function deleteNotificationByKey(workerUid: string, key: string) {
  await ensureTables();
  const current = await dbQuery.query(
    `SELECT can_dismiss FROM ${dbSchema}.provider_notifications
     WHERE notification_key = $1 AND worker_uid = $2 LIMIT 1`,
    [key, workerUid],
  );
  if (!current.rowCount) return { found: false, allowed: false };
  if (!current.rows[0].can_dismiss) return { found: true, allowed: false };
  const { rowCount } = await dbQuery.query(
    `DELETE FROM ${dbSchema}.provider_notifications
     WHERE notification_key = $1 AND worker_uid = $2 AND can_dismiss = true`,
    [key, workerUid],
  );
  const found = (rowCount ?? 0) > 0;
  if (found) emitToProvider(workerUid, 'notification:dismissed', { notificationKey: key });
  return { found, allowed: true };
}

// ─── Create notification + real-time push ────────────────────────────────────

export interface NotificationInput {
  notificationKey?: string;  // deterministic key for idempotency; omit for auto UUID
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
 * When `data.notificationKey` is supplied the INSERT uses ON CONFLICT DO NOTHING.
 * Returns null if the key already existed (idempotent — notification was previously
 * sent); returns the notification row on first insert.
 */
export async function createNotification(
  workerUid: string,
  data: NotificationInput,
): Promise<ReturnType<typeof mapNotificationRow> | null> {
  await ensureTables();

  const type = normalizeNotificationType(data.type);
  const severity = normalizeSeverity(data.severity);
  const title = cleanNotificationText(data.title, 255);
  const safeBody = cleanNotificationText(data.safeBody, 1000);
  const safeContextLabel = data.safeContextLabel == null
    ? null
    : cleanNotificationText(data.safeContextLabel, 255);
  const route = sanitizeNotificationRoute(data.route);
  if (!title || !safeBody) throw new Error('Notification title and safe body are required.');
  if (data.notificationKey && !isSafeNotificationKey(data.notificationKey)) {
    throw new Error('Invalid notification key.');
  }

  const params: any[] = [
    workerUid,
    type,
    severity,
    title,
    safeBody,
    safeContextLabel,
    route ? JSON.stringify(route) : null,
    data.canMarkRead !== false,
    data.canDismiss !== false,
    !!data.canOpenDetail,
    data.expiresAt || null,
  ];

  let rows: any[];

  if (data.notificationKey) {
    const result = await dbQuery.query(
      `INSERT INTO ${dbSchema}.provider_notifications
         (notification_key, worker_uid, type, severity, title, safe_body, safe_context_label,
          route, can_mark_read, can_dismiss, can_open_detail, expires_at)
       VALUES ($12, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (worker_uid, notification_key) DO NOTHING
       RETURNING *`,
      [...params, data.notificationKey],
    );
    if ((result.rowCount ?? 0) === 0) return null;  // idempotent: already sent
    rows = result.rows;
  } else {
    const result = await dbQuery.query(
      `INSERT INTO ${dbSchema}.provider_notifications
         (worker_uid, type, severity, title, safe_body, safe_context_label, route,
          can_mark_read, can_dismiss, can_open_detail, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      params,
    );
    rows = result.rows;
  }

  const notification = mapNotificationRow(rows[0]);
  // Push real-time — no-op when socket server is not initialised (e.g. during tests)
  emitToProvider(workerUid, "notification", notification);
  // FCM push for background/offline devices
  sendFcmPushToWorker(workerUid, title, safeBody, route as any, {
    type,
    notificationKey: notification.notificationKey,
  }).catch(() => {});
  // Fire-and-forget admin log
  logCommunicationEvent({
    channel: 'socket',
    status: 'sent',
    severity: severity as any,
    category: 'notification',
    recipientUid: workerUid,
    recipientRole: 'provider',
    senderRole: 'system',
    subject: title,
    safeBody: safeBody.substring(0, 300),
    templateName: type,
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
  const current = await dbQuery.query(
    `SELECT is_dismissable FROM ${dbSchema}.provider_alerts
     WHERE alert_key = $1 AND worker_uid = $2 LIMIT 1`,
    [key, workerUid],
  );
  if (!current.rowCount) return { found: false, allowed: false };
  if (!current.rows[0].is_dismissable) return { found: true, allowed: false };
  const { rowCount } = await dbQuery.query(
    `DELETE FROM ${dbSchema}.provider_alerts
     WHERE alert_key = $1 AND worker_uid = $2 AND is_dismissable = true`,
    [key, workerUid],
  );
  return { found: (rowCount ?? 0) > 0, allowed: true };
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
  jobAssigned:       true,
  jobReminder:       false,
  paymentReceived:   true,
  newMessage:        true,
  promotions:        false,
  requirementReview: true,
  support:           true,
  accountSecurity:   true,
  system:            true,
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
    jobAssigned:       r.job_assigned,
    jobReminder:       r.job_reminder,
    paymentReceived:   r.payment_received,
    newMessage:        r.new_message,
    promotions:        r.promotions,
    requirementReview: r.requirement_review ?? true,
    support:           r.support           ?? true,
    accountSecurity:   r.account_security  ?? true,
    system:            r.system            ?? true,
  };
}

export async function saveNotificationPrefs(workerUid: string, prefs: Partial<typeof DEFAULT_PREFS>) {
  await ensureTables();
  const current = await getNotificationPrefs(workerUid);
  const merged = { ...current };
  for (const key of Object.keys(DEFAULT_PREFS) as Array<keyof typeof DEFAULT_PREFS>) {
    if (prefs[key] === undefined) continue;
    if (typeof prefs[key] !== 'boolean') throw new Error(`Invalid notification preference: ${key}`);
    merged[key] = prefs[key] as boolean;
  }
  await dbQuery.query(
    `INSERT INTO ${dbSchema}.provider_notification_preferences
       (worker_uid, job_assigned, job_reminder, payment_received, new_message, promotions,
        requirement_review, support, account_security, system, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
     ON CONFLICT (worker_uid) DO UPDATE SET
       job_assigned       = EXCLUDED.job_assigned,
       job_reminder       = EXCLUDED.job_reminder,
       payment_received   = EXCLUDED.payment_received,
       new_message        = EXCLUDED.new_message,
       promotions         = EXCLUDED.promotions,
       requirement_review = EXCLUDED.requirement_review,
       support            = EXCLUDED.support,
       account_security   = EXCLUDED.account_security,
       system             = EXCLUDED.system,
       updated_at         = NOW()`,
    [
      workerUid,
      merged.jobAssigned,
      merged.jobReminder,
      merged.paymentReceived,
      merged.newMessage,
      merged.promotions,
      merged.requirementReview,
      merged.support,
      merged.accountSecurity,
      merged.system,
    ],
  );
  return merged;
}

function validDeviceToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const token = value.trim();
  return token.length >= 10 && token.length <= 4096 && !/[\s\u0000-\u001F\u007F]/.test(token)
    ? token
    : null;
}

/** Additive multi-device provider push registration; legacy column is dual-written. */
export async function registerProviderDeviceToken(workerUid: string, rawToken: unknown): Promise<boolean> {
  const token = validDeviceToken(rawToken);
  if (!token) return false;
  await ensureTables();
  await dbQuery.query(
    `INSERT INTO ${dbSchema}.provider_notification_device_tokens (token, worker_uid, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (token) DO UPDATE SET worker_uid = EXCLUDED.worker_uid, updated_at = NOW()`,
    [token, workerUid],
  );
  await dbQuery.query(
    `UPDATE ${dbSchema}.user_credentials SET fcm_token = NULL WHERE fcm_token = $1 AND uid <> $2`,
    [token, workerUid],
  );
  await dbQuery.query(
    `UPDATE ${dbSchema}.user_credentials SET fcm_token = $1 WHERE uid = $2`,
    [token, workerUid],
  );
  return true;
}

export async function releaseProviderDeviceToken(workerUid: string, rawToken?: unknown): Promise<void> {
  await ensureTables();
  const token = validDeviceToken(rawToken);
  if (token) {
    await dbQuery.query(
      `DELETE FROM ${dbSchema}.provider_notification_device_tokens WHERE worker_uid = $1 AND token = $2`,
      [workerUid, token],
    );
    await dbQuery.query(
      `UPDATE ${dbSchema}.user_credentials SET fcm_token = NULL WHERE uid = $1 AND fcm_token = $2`,
      [workerUid, token],
    );
    return;
  }
  await dbQuery.query(
    `DELETE FROM ${dbSchema}.provider_notification_device_tokens WHERE worker_uid = $1`,
    [workerUid],
  );
  await dbQuery.query(
    `UPDATE ${dbSchema}.user_credentials SET fcm_token = NULL WHERE uid = $1`,
    [workerUid],
  );
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

// ═══════════════════════════════════════════════════════════════════════════════
// CUSTOMER NOTIFICATIONS — separate table scoped to user_uid (not worker_uid)
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Customer FCM push ────────────────────────────────────────────────────────

async function sendFcmPushToCustomer(
  userUid: string,
  title: string,
  body: string,
  data?: Record<string, string>,
): Promise<void> {
  const { rows } = await dbQuery.query(
    `SELECT fcm_token FROM ${dbSchema}.user_credentials WHERE uid = $1 LIMIT 1`,
    [userUid],
  );
  const token: string | undefined = rows[0]?.fcm_token;
  if (!token) return;

  const { getMessaging } = await import('firebase-admin/messaging');
  const { firebaseAdmin } = await import('../middleware/firebaseApp');
  await getMessaging(firebaseAdmin).send({
    token,
    notification: { title, body },
    data: data ?? {},
    android: { priority: 'high' },
    apns: { payload: { aps: { contentAvailable: true } } },
  });
}

// ─── Customer table init ──────────────────────────────────────────────────────

let customerTablesReady: Promise<void> | null = null;

async function initCustomerTables(): Promise<void> {
  await dbQuery.query(`
    CREATE TABLE IF NOT EXISTS ${dbSchema}.customer_notifications (
      id               BIGSERIAL PRIMARY KEY,
      notification_key VARCHAR(64)  NOT NULL DEFAULT gen_random_uuid()::varchar,
      user_uid         VARCHAR(128) NOT NULL,
      type             VARCHAR(64)  NOT NULL DEFAULT 'system',
      status           VARCHAR(32)  NOT NULL DEFAULT 'unread',
      severity         VARCHAR(32)  NOT NULL DEFAULT 'info',
      title            VARCHAR(255) NOT NULL,
      safe_body        TEXT         NOT NULL,
      safe_context_label VARCHAR(255),
      route            JSONB,
      can_mark_read    BOOLEAN      NOT NULL DEFAULT true,
      can_dismiss      BOOLEAN      NOT NULL DEFAULT true,
      can_open_detail  BOOLEAN      NOT NULL DEFAULT false,
      read_at          TIMESTAMPTZ,
      expires_at       TIMESTAMPTZ,
      created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_cn_user_uid
      ON ${dbSchema}.customer_notifications (user_uid, created_at DESC);
    ALTER TABLE ${dbSchema}.customer_notifications
      DROP CONSTRAINT IF EXISTS customer_notifications_notification_key_key;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_notifications_owner_key
      ON ${dbSchema}.customer_notifications (user_uid, notification_key);
  `);
}

function ensureCustomerTables(): Promise<void> {
  if (!customerTablesReady) customerTablesReady = initCustomerTables();
  return customerTablesReady;
}

// ─── Customer row mapper ──────────────────────────────────────────────────────

function mapCustomerNotificationRow(row: any) {
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

// ─── FCM token management ─────────────────────────────────────────────────────

export async function clearFcmToken(uid: string): Promise<void> {
  await dbQuery.query(
    `UPDATE ${dbSchema}.user_credentials SET fcm_token = NULL WHERE uid = $1`,
    [uid],
  );
}

// ─── Customer notification CRUD ───────────────────────────────────────────────

export async function listCustomerNotifications(userUid: string, filter?: string) {
  await ensureCustomerTables();
  const base = `user_uid = $1 AND (expires_at IS NULL OR expires_at > NOW())`;
  let sql = `WHERE ${base}`;
  const params: any[] = [userUid];
  if (filter === 'unread') {
    sql = `WHERE ${base} AND status = 'unread'`;
  }
  const { rows } = await dbQuery.query(
    `SELECT * FROM ${dbSchema}.customer_notifications ${sql} ORDER BY created_at DESC LIMIT 100`,
    params,
  );
  return rows.map(mapCustomerNotificationRow);
}

export async function countCustomerUnreadNotifications(userUid: string): Promise<number> {
  await ensureCustomerTables();
  const { rows } = await dbQuery.query(
    `SELECT COUNT(*) AS cnt FROM ${dbSchema}.customer_notifications
     WHERE user_uid = $1 AND status = 'unread' AND (expires_at IS NULL OR expires_at > NOW())`,
    [userUid],
  );
  return parseInt(rows[0]?.cnt ?? '0', 10);
}

export async function markCustomerNotificationReadByKey(userUid: string, key: string) {
  await ensureCustomerTables();
  const current = await dbQuery.query(
    `SELECT status, can_mark_read FROM ${dbSchema}.customer_notifications
     WHERE notification_key = $1 AND user_uid = $2 LIMIT 1`,
    [key, userUid],
  );
  if (!current.rowCount) return { found: false, allowed: false, changed: false };
  if (!current.rows[0].can_mark_read) return { found: true, allowed: false, changed: false };
  if (current.rows[0].status !== 'unread') return { found: true, allowed: true, changed: false };
  const { rowCount } = await dbQuery.query(
    `UPDATE ${dbSchema}.customer_notifications
     SET status = 'read', read_at = NOW()
     WHERE notification_key = $1 AND user_uid = $2 AND status = 'unread' AND can_mark_read = true`,
    [key, userUid],
  );
  return { found: true, allowed: true, changed: (rowCount ?? 0) > 0 };
}

export async function markAllCustomerNotificationsRead(userUid: string) {
  await ensureCustomerTables();
  await dbQuery.query(
    `UPDATE ${dbSchema}.customer_notifications
     SET status = 'read', read_at = NOW()
     WHERE user_uid = $1 AND status = 'unread' AND can_mark_read = true`,
    [userUid],
  );
}

export async function deleteCustomerNotificationByKey(userUid: string, key: string) {
  await ensureCustomerTables();
  const current = await dbQuery.query(
    `SELECT can_dismiss FROM ${dbSchema}.customer_notifications
     WHERE notification_key = $1 AND user_uid = $2 LIMIT 1`,
    [key, userUid],
  );
  if (!current.rowCount) return { found: false, allowed: false };
  if (!current.rows[0].can_dismiss) return { found: true, allowed: false };
  const { rowCount } = await dbQuery.query(
    `DELETE FROM ${dbSchema}.customer_notifications
     WHERE notification_key = $1 AND user_uid = $2 AND can_dismiss = true`,
    [key, userUid],
  );
  return { found: (rowCount ?? 0) > 0, allowed: true };
}

// ─── Customer notification creation (with FCM push) ──────────────────────────

export interface CustomerNotificationInput {
  notificationKey?: string;
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

export async function createCustomerNotification(
  userUid: string,
  data: CustomerNotificationInput,
): Promise<ReturnType<typeof mapCustomerNotificationRow> | null> {
  await ensureCustomerTables();

  const type = normalizeNotificationType(data.type);
  const severity = normalizeSeverity(data.severity);
  const title = cleanNotificationText(data.title, 255);
  const safeBody = cleanNotificationText(data.safeBody, 1000);
  const safeContextLabel = data.safeContextLabel == null ? null : cleanNotificationText(data.safeContextLabel, 255);
  const route = sanitizeNotificationRoute(data.route);
  if (!title || !safeBody) throw new Error('Notification title and safe body are required.');
  if (data.notificationKey && !isSafeNotificationKey(data.notificationKey)) throw new Error('Invalid notification key.');

  const params: any[] = [
    userUid,
    type,
    severity,
    title,
    safeBody,
    safeContextLabel,
    route ? JSON.stringify(route) : null,
    data.canMarkRead !== false,
    data.canDismiss !== false,
    !!data.canOpenDetail,
    data.expiresAt || null,
  ];

  let rows: any[];

  if (data.notificationKey) {
    const result = await dbQuery.query(
      `INSERT INTO ${dbSchema}.customer_notifications
         (notification_key, user_uid, type, severity, title, safe_body, safe_context_label,
          route, can_mark_read, can_dismiss, can_open_detail, expires_at)
       VALUES ($12, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (user_uid, notification_key) DO NOTHING
       RETURNING *`,
      [...params, data.notificationKey],
    );
    if ((result.rowCount ?? 0) === 0) return null;
    rows = result.rows;
  } else {
    const result = await dbQuery.query(
      `INSERT INTO ${dbSchema}.customer_notifications
         (user_uid, type, severity, title, safe_body, safe_context_label, route,
          can_mark_read, can_dismiss, can_open_detail, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      params,
    );
    rows = result.rows;
  }

  const notification = mapCustomerNotificationRow(rows[0]);

  // FCM push — safe routing metadata only, no sensitive data
  const fcmData: Record<string, string> = {
    notificationKey: notification.notificationKey,
    type: notification.type,
    schemaVersion: '1',
  };
  if (notification.route) {
    const route = notification.route as any;
    if (route.routeKey) fcmData.routeKey = String(route.routeKey);
    if (route.resourceId) fcmData.resourceId = String(route.resourceId);
  }
  sendFcmPushToCustomer(userUid, title, safeBody, fcmData).catch(() => {});

  return notification;
}
