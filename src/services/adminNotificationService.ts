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

/**
 * ── Schema (TAB 02) ──────────────────────────────────────────────────────────
 *
 * `admin_notifications` and `idx_admin_notifications_inbox` were created here at
 * runtime by `ensureAdminNotifications`, memoised and awaited at the top of all
 * four exported operations. That function is gone, and so are those awaits.
 *
 * The table comes from `scripts/baseline/000-baseline.sql:332`.
 *
 * ⚠ The UNIQUE (admin_uid, notification_key) constraint the removed DDL declared
 * is what `ON CONFLICT (admin_uid, notification_key) DO NOTHING` below resolves
 * against — it is the whole idempotency mechanism for admin fan-out, and without
 * it every re-notification inserts a duplicate row into every admin's inbox. The
 * baseline carries it as `admin_notifications_admin_uid_notification_key_key`
 * (line 4261). Do not drop that constraint believing it to be incidental.
 */

export async function notifyAllAdmins(input: AdminNotificationInput): Promise<number> {
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
  const result = await dbQuery.query(
    `SELECT COUNT(*) AS count FROM ${s}.admin_notifications WHERE admin_uid = $1 AND read_at IS NULL`,
    [adminUid],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function markRead(adminUid: string, id?: number): Promise<number> {
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
