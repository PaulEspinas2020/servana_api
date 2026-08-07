import { db } from '../config';
import dbQuery from '../db/dbQuery';

const s = db.schema;

export interface AdminNotificationInput {
  type: string;
  title: string;
  body: string;
  severity?: 'info' | 'success' | 'warning' | 'error';
  bookingId?: number | null;
  conversationId?: number | null;
  notificationKey: string;
}

let ready: Promise<void> | null = null;
export const ensureAdminNotifications = (): Promise<void> => {
  ready ??= dbQuery.query(`
    CREATE TABLE IF NOT EXISTS ${s}.admin_notifications (
      id BIGSERIAL PRIMARY KEY,
      admin_uid TEXT NOT NULL,
      notification_key VARCHAR(160) NOT NULL,
      type VARCHAR(80) NOT NULL,
      severity VARCHAR(20) NOT NULL DEFAULT 'info',
      title VARCHAR(180) NOT NULL,
      body TEXT NOT NULL,
      booking_id INTEGER,
      conversation_id INTEGER,
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (admin_uid, notification_key)
    );
    CREATE INDEX IF NOT EXISTS idx_admin_notifications_inbox
      ON ${s}.admin_notifications (admin_uid, created_at DESC);
  `, []).then(() => undefined).catch(error => { ready = null; throw error; });
  return ready;
};

export async function notifyAllAdmins(input: AdminNotificationInput): Promise<number> {
  await ensureAdminNotifications();
  const result = await dbQuery.query(`
    INSERT INTO ${s}.admin_notifications
      (admin_uid, notification_key, type, severity, title, body, booking_id, conversation_id)
    SELECT uid, $1, $2, $3, $4, $5, $6, $7
      FROM ${s}.user_credentials
     WHERE role::int = 1 AND COALESCE(is_archive, false) = false
    ON CONFLICT (admin_uid, notification_key) DO NOTHING
  `, [
    input.notificationKey.slice(0, 160), input.type, input.severity ?? 'info',
    input.title, input.body, input.bookingId ?? null, input.conversationId ?? null,
  ]);
  return result.rowCount ?? 0;
}

export async function listForAdmin(adminUid: string, limit = 30) {
  await ensureAdminNotifications();
  const result = await dbQuery.query(`
    SELECT id, type, severity, title, body, booking_id, conversation_id, read_at, created_at
      FROM ${s}.admin_notifications
     WHERE admin_uid = $1
     ORDER BY created_at DESC LIMIT $2
  `, [adminUid, Math.min(100, Math.max(1, limit))]);
  return result.rows.map((row: any) => ({
    id: Number(row.id), type: row.type, severity: row.severity, title: row.title, body: row.body,
    bookingId: row.booking_id ?? null, conversationId: row.conversation_id ?? null,
    readAt: row.read_at ?? null, createdAt: row.created_at,
  }));
}

export async function unreadCount(adminUid: string): Promise<number> {
  await ensureAdminNotifications();
  const result = await dbQuery.query(
    `SELECT COUNT(*) AS count FROM ${s}.admin_notifications WHERE admin_uid = $1 AND read_at IS NULL`,
    [adminUid],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function markRead(adminUid: string, id?: number): Promise<number> {
  await ensureAdminNotifications();
  const result = await dbQuery.query(
    `UPDATE ${s}.admin_notifications SET read_at = COALESCE(read_at, NOW())
      WHERE admin_uid = $1 AND read_at IS NULL ${id ? 'AND id = $2' : ''}`,
    id ? [adminUid, id] : [adminUid],
  );
  return result.rowCount ?? 0;
}

export const notifyAdminsSafely = (input: AdminNotificationInput): void => {
  void notifyAllAdmins(input).catch(error => console.error('[admin-notification]', error?.message ?? error));
};
