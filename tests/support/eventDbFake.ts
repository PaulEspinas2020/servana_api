/**
 * A fake `pg` for the TAB 09 event and notification layer.
 *
 * ## Why a fake and not mocked services
 *
 * The guarantees this tab rests on are SQL:
 *
 *   - the outbox dedupe is a partial unique index on `(event_name, dedupe_key)`;
 *   - the notification dedupe is an owner-scoped unique index on
 *     `(owner_uid, notification_key)` with `ON CONFLICT DO NOTHING`;
 *   - the device registry moves a token between accounts because the TOKEN is
 *     the primary key, not `(uid, token)`.
 *
 * A suite that stubbed those out would prove the services call each other, which
 * is not what anybody is worried about. The dedup test in particular would pass
 * against a database that would have written two rows.
 *
 * So this routes the real statements and enforces the real constraints. It is
 * deliberately smaller than `chatDbFake`: no transactions, because the only
 * transactional publisher is the booking executor and its transaction is
 * exercised by `bookingDbFake` in its own suite.
 */

export interface Row { [k: string]: unknown }

let nextEventId = 1;
let nextNotificationId = 1;

export const store = {
  users: [] as Row[],
  bookings: [] as Row[],
  bookingWorkers: [] as Row[],
  outbox: [] as Row[],
  providerNotifications: [] as Row[],
  customerNotifications: [] as Row[],
  adminNotifications: [] as Row[],
  preferences: [] as Row[],
  accountDeviceTokens: [] as Row[],
  providerDeviceTokens: [] as Row[],
  sql: [] as string[],
};

export const reset = (): void => {
  store.users = [];
  store.bookings = [];
  store.bookingWorkers = [];
  store.outbox = [];
  store.providerNotifications = [];
  store.customerNotifications = [];
  store.adminNotifications = [];
  store.preferences = [];
  store.accountDeviceTokens = [];
  store.providerDeviceTokens = [];
  store.sql = [];
  nextEventId = 1;
  nextNotificationId = 1;
};

// ─── Seeding ──────────────────────────────────────────────────────────────────

export const seedUser = (uid: string, role: number): void => {
  store.users.push({ uid, role, fcm_token: null });
};

export const seedBooking = (id: number, customerUid: string): void => {
  store.bookings.push({ id, user_id: customerUid });
};

export const seedAssignment = (bookingId: number, workerUid: string, status = 'ACCEPTED'): void => {
  store.bookingWorkers.push({ booking_id: bookingId, worker_uid: workerUid, status });
};

/** The notifications a given account already holds, whichever store. */
export const notificationsFor = (uid: string): Row[] => [
  ...store.providerNotifications.filter((n) => n.worker_uid === uid),
  ...store.customerNotifications.filter((n) => n.user_uid === uid),
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

const done = (rows: Row[]) => ({ rows, rowCount: rows.length });

const ACTIVE_WORKER_STATUSES = [
  'ASSIGNED', 'ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'IN_PROGRESS', 'COMPLETED',
];

// ─── The router ───────────────────────────────────────────────────────────────

export const run = (sql: string, params: unknown[] = []): { rows: Row[]; rowCount: number } => {
  const flat = sql.replace(/\s+/g, ' ').trim();
  store.sql.push(flat);

  if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(flat)) return done([]);
  if (/^(CREATE TABLE|CREATE INDEX|CREATE UNIQUE INDEX|ALTER TABLE|COMMENT ON)/i.test(flat)) {
    return done([]);
  }
  // The notification service creates its tables with a multi-statement string.
  if (/CREATE TABLE IF NOT EXISTS/i.test(flat)) return done([]);

  // ── outbox ────────────────────────────────────────────────────────────────
  if (/^INSERT INTO servana\.domain_event_outbox/i.test(flat)) {
    const [name, version, dedupeKey, refs, display, metadata, occurredAt] = params as any[];
    // The partial unique index on (event_name, dedupe_key). This is the guard
    // the publish-idempotency test depends on.
    if (dedupeKey != null) {
      const clash = store.outbox.find(
        (e) => e.event_name === name && e.dedupe_key === dedupeKey,
      );
      if (clash) return done([]);
    }
    const row: Row = {
      id: nextEventId++,
      event_name: name,
      event_version: version,
      dedupe_key: dedupeKey,
      refs: typeof refs === 'string' ? JSON.parse(refs) : refs,
      display: typeof display === 'string' ? JSON.parse(display) : display,
      metadata: typeof metadata === 'string' ? JSON.parse(metadata) : metadata,
      status: 'PENDING',
      attempts: 0,
      last_error: null,
      occurred_at: occurredAt,
      dispatched_at: null,
    };
    store.outbox.push(row);
    return done([{ id: row.id }]);
  }
  if (/^SELECT id FROM servana\.domain_event_outbox WHERE event_name = \$1 AND dedupe_key = \$2$/i.test(flat)) {
    const row = store.outbox.find(
      (e) => e.event_name === params[0] && e.dedupe_key === params[1],
    );
    return done(row ? [{ id: row.id }] : []);
  }
  if (/^SELECT \* FROM servana\.domain_event_outbox WHERE id = \$1$/i.test(flat)) {
    const row = store.outbox.find((e) => Number(e.id) === Number(params[0]));
    return done(row ? [row] : []);
  }
  if (/^UPDATE servana\.domain_event_outbox SET attempts = attempts \+ 1/i.test(flat)) {
    const limit = Number(params[0]);
    const claimed = store.outbox
      .filter((e) => e.status === 'PENDING')
      .sort((a, b) => Number(a.id) - Number(b.id))
      .slice(0, limit);
    for (const row of claimed) row.attempts = Number(row.attempts) + 1;
    return done(claimed);
  }
  if (/^UPDATE servana\.domain_event_outbox SET status = 'DISPATCHED'/i.test(flat)) {
    const row = store.outbox.find((e) => Number(e.id) === Number(params[0]));
    if (row) {
      row.status = 'DISPATCHED';
      row.dispatched_at = new Date().toISOString();
      row.last_error = null;
    }
    return done([]);
  }
  if (/^UPDATE servana\.domain_event_outbox SET status = \$2, last_error = \$3/i.test(flat)) {
    const row = store.outbox.find((e) => Number(e.id) === Number(params[0]));
    if (row) {
      row.status = params[1];
      row.last_error = params[2];
    }
    return done([]);
  }
  if (/FROM servana\.domain_event_outbox$/i.test(flat) && /COUNT\(\*\) FILTER/i.test(flat)) {
    const pending = store.outbox.filter((e) => e.status === 'PENDING');
    return done([{
      pending: pending.length,
      failed: store.outbox.filter((e) => e.status === 'FAILED').length,
      oldest_pending_at: pending.length
        ? pending.map((e) => String(e.occurred_at)).sort()[0]
        : null,
    }]);
  }

  // ── booking-derived recipients ────────────────────────────────────────────
  if (/^SELECT user_id FROM servana\.bookings WHERE id = \$1$/i.test(flat)) {
    const b = store.bookings.find((x) => Number(x.id) === Number(params[0]));
    return done(b ? [{ user_id: b.user_id }] : []);
  }
  if (/^SELECT worker_uid FROM servana\.booking_workers WHERE booking_id = \$1 AND status = ANY/i.test(flat)) {
    const active = (params[1] as string[]) ?? ACTIVE_WORKER_STATUSES;
    return done(
      store.bookingWorkers
        .filter((w) => Number(w.booking_id) === Number(params[0]) && active.includes(String(w.status)))
        .map((w) => ({ worker_uid: w.worker_uid })),
    );
  }
  if (/^SELECT role::int AS role FROM servana\.user_credentials WHERE uid = \$1$/i.test(flat)) {
    const u = store.users.find((x) => String(x.uid) === String(params[0]));
    return done(u ? [{ role: Number(u.role) }] : []);
  }

  // ── notifications: provider ───────────────────────────────────────────────
  if (/^INSERT INTO servana\.provider_notifications \(notification_key, worker_uid/i.test(flat)) {
    const key = params[11];
    const uid = params[0];
    // The owner-scoped unique index. THE guard the dedup test rests on.
    if (store.providerNotifications.some((n) => n.worker_uid === uid && n.notification_key === key)) {
      return done([]);
    }
    const row = providerRow(params, key);
    store.providerNotifications.push(row);
    return done([row]);
  }
  if (/^INSERT INTO servana\.provider_notifications \(worker_uid/i.test(flat)) {
    const row = providerRow(params, `auto-${nextNotificationId}`);
    store.providerNotifications.push(row);
    return done([row]);
  }
  if (/^SELECT \* FROM servana\.provider_notifications WHERE/i.test(flat)
      || /^SELECT \* FROM servana\.provider_notifications ORDER BY/i.test(flat)) {
    return done(
      store.providerNotifications
        .filter((n) => n.worker_uid === params[0])
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))),
    );
  }
  if (/^SELECT COUNT\(\*\) AS cnt FROM servana\.provider_notifications/i.test(flat)) {
    return done([{
      cnt: String(store.providerNotifications.filter(
        (n) => n.worker_uid === params[0] && n.status === 'unread',
      ).length),
    }]);
  }
  if (/^SELECT status, can_mark_read FROM servana\.provider_notifications/i.test(flat)) {
    const row = store.providerNotifications.find(
      (n) => n.notification_key === params[0] && n.worker_uid === params[1],
    );
    return done(row ? [{ status: row.status, can_mark_read: row.can_mark_read }] : []);
  }
  if (/^UPDATE servana\.provider_notifications SET status = 'read'/i.test(flat)
      && /WHERE notification_key = \$1/i.test(flat)) {
    const row = store.providerNotifications.find(
      (n) => n.notification_key === params[0] && n.worker_uid === params[1] && n.status === 'unread',
    );
    if (!row) return done([]);
    row.status = 'read';
    row.read_at = new Date().toISOString();
    return { rows: [], rowCount: 1 };
  }
  if (/^UPDATE servana\.provider_notifications/i.test(flat) && /status = 'read'/i.test(flat)) {
    const rows = store.providerNotifications.filter(
      (n) => n.worker_uid === params[0] && n.status === 'unread',
    );
    for (const row of rows) { row.status = 'read'; row.read_at = new Date().toISOString(); }
    return { rows: [], rowCount: rows.length };
  }

  // ── notifications: customer ───────────────────────────────────────────────
  if (/^INSERT INTO servana\.customer_notifications \(notification_key, user_uid/i.test(flat)) {
    const key = params[11];
    const uid = params[0];
    if (store.customerNotifications.some((n) => n.user_uid === uid && n.notification_key === key)) {
      return done([]);
    }
    const row = customerRow(params, key);
    store.customerNotifications.push(row);
    return done([row]);
  }
  if (/^INSERT INTO servana\.customer_notifications \(user_uid/i.test(flat)) {
    const row = customerRow(params, `auto-${nextNotificationId}`);
    store.customerNotifications.push(row);
    return done([row]);
  }
  if (/FROM servana\.customer_notifications/i.test(flat) && /^SELECT \*/i.test(flat)) {
    return done(
      store.customerNotifications
        .filter((n) => n.user_uid === params[0])
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))),
    );
  }
  if (/^SELECT COUNT\(\*\) AS cnt FROM servana\.customer_notifications/i.test(flat)) {
    return done([{
      cnt: String(store.customerNotifications.filter(
        (n) => n.user_uid === params[0] && n.status === 'unread',
      ).length),
    }]);
  }
  if (/^SELECT status, can_mark_read FROM servana\.customer_notifications/i.test(flat)) {
    const row = store.customerNotifications.find(
      (n) => n.notification_key === params[0] && n.user_uid === params[1],
    );
    return done(row ? [{ status: row.status, can_mark_read: row.can_mark_read }] : []);
  }
  if (/^UPDATE servana\.customer_notifications SET status = 'read'/i.test(flat)
      && /WHERE notification_key = \$1/i.test(flat)) {
    const key = params[0];
    const uid = params[1];
    const rows = key === undefined || uid === undefined
      ? []
      : store.customerNotifications.filter(
          (n) => n.notification_key === key && n.user_uid === uid && n.status === 'unread',
        );
    for (const row of rows) { row.status = 'read'; row.read_at = new Date().toISOString(); }
    return { rows: [], rowCount: rows.length };
  }
  if (/^UPDATE servana\.customer_notifications/i.test(flat) && /status = 'read'/i.test(flat)) {
    const rows = store.customerNotifications.filter(
      (n) => n.user_uid === params[0] && n.status === 'unread',
    );
    for (const row of rows) { row.status = 'read'; row.read_at = new Date().toISOString(); }
    return { rows: [], rowCount: rows.length };
  }

  // ── notifications: admin ──────────────────────────────────────────────────
  if (/^INSERT INTO servana\.admin_notifications/i.test(flat)) {
    const admins = store.users.filter((u) => Number(u.role) === 1);
    let inserted = 0;
    for (const admin of admins) {
      if (store.adminNotifications.some(
        (n) => n.admin_uid === admin.uid && n.notification_key === params[0],
      )) continue;
      store.adminNotifications.push({
        id: nextNotificationId++,
        admin_uid: admin.uid,
        notification_key: params[0],
        type: params[1],
        severity: params[2],
        title: params[3],
        body: params[4],
        booking_id: params[5],
        conversation_id: params[6],
        read_at: null,
        created_at: new Date().toISOString(),
      });
      inserted += 1;
    }
    return { rows: [], rowCount: inserted };
  }
  if (/FROM servana\.admin_notifications/i.test(flat) && /^SELECT id, type/i.test(flat)) {
    return done(store.adminNotifications.filter((n) => n.admin_uid === params[0]));
  }
  if (/^SELECT COUNT\(\*\)/i.test(flat) && /servana\.admin_notifications/i.test(flat)) {
    const n = store.adminNotifications.filter(
      (r) => r.admin_uid === params[0] && r.read_at == null,
    ).length;
    return done([{ count: String(n), cnt: String(n) }]);
  }
  if (/^UPDATE servana\.admin_notifications/i.test(flat)) {
    const rows = store.adminNotifications.filter(
      (r) => r.admin_uid === params[0] && r.read_at == null
        && (params[1] === undefined || Number(r.id) === Number(params[1])),
    );
    for (const row of rows) row.read_at = new Date().toISOString();
    return { rows: [], rowCount: rows.length };
  }

  // ── preferences ───────────────────────────────────────────────────────────
  if (/^SELECT \* FROM servana\.provider_notification_preferences WHERE worker_uid = \$1$/i.test(flat)) {
    const row = store.preferences.find((p) => p.worker_uid === params[0]);
    return done(row ? [row] : []);
  }
  if (/^INSERT INTO servana\.provider_notification_preferences/i.test(flat)) {
    const [uid, jobAssigned, jobReminder, paymentReceived, newMessage, promotions,
      requirementReview, support, accountSecurity, system] = params as any[];
    const existing = store.preferences.find((p) => p.worker_uid === uid);
    const row: Row = {
      worker_uid: uid,
      job_assigned: jobAssigned,
      job_reminder: jobReminder,
      payment_received: paymentReceived,
      new_message: newMessage,
      promotions,
      requirement_review: requirementReview,
      support,
      account_security: accountSecurity,
      system,
    };
    if (existing) Object.assign(existing, row);
    else store.preferences.push(row);
    return done([]);
  }

  // ── device tokens ─────────────────────────────────────────────────────────
  if (/^INSERT INTO servana\.account_device_tokens/i.test(flat)) {
    const [token, uid, platform, app] = params as any[];
    const existing = store.accountDeviceTokens.find((t) => t.token === token);
    // The TOKEN is the primary key: registering a device another account holds
    // MOVES it rather than adding a second owner.
    if (existing) {
      existing.uid = uid;
      if (platform) existing.platform = platform;
      if (app) existing.app = app;
    } else {
      store.accountDeviceTokens.push({ token, uid, platform, app });
    }
    return done([]);
  }
  if (/^DELETE FROM servana\.account_device_tokens WHERE uid = \$1 AND token = \$2$/i.test(flat)) {
    store.accountDeviceTokens = store.accountDeviceTokens.filter(
      (t) => !(t.uid === params[0] && t.token === params[1]),
    );
    return done([]);
  }
  if (/^DELETE FROM servana\.account_device_tokens WHERE uid = \$1$/i.test(flat)) {
    store.accountDeviceTokens = store.accountDeviceTokens.filter((t) => t.uid !== params[0]);
    return done([]);
  }
  if (/^DELETE FROM servana\.account_device_tokens WHERE token = \$1$/i.test(flat)) {
    store.accountDeviceTokens = store.accountDeviceTokens.filter((t) => t.token !== params[0]);
    return done([]);
  }
  if (/^INSERT INTO servana\.provider_notification_device_tokens/i.test(flat)) {
    const [token, uid] = params as any[];
    const existing = store.providerDeviceTokens.find((t) => t.token === token);
    if (existing) existing.worker_uid = uid;
    else store.providerDeviceTokens.push({ token, worker_uid: uid });
    return done([]);
  }
  if (/^DELETE FROM servana\.provider_notification_device_tokens WHERE worker_uid = \$1 AND token = \$2$/i.test(flat)) {
    store.providerDeviceTokens = store.providerDeviceTokens.filter(
      (t) => !(t.worker_uid === params[0] && t.token === params[1]),
    );
    return done([]);
  }
  if (/^DELETE FROM servana\.provider_notification_device_tokens WHERE worker_uid = \$1$/i.test(flat)) {
    store.providerDeviceTokens = store.providerDeviceTokens.filter((t) => t.worker_uid !== params[0]);
    return done([]);
  }
  if (/^DELETE FROM servana\.provider_notification_device_tokens WHERE token = \$1$/i.test(flat)) {
    store.providerDeviceTokens = store.providerDeviceTokens.filter((t) => t.token !== params[0]);
    return done([]);
  }
  if (/^SELECT token FROM servana\.account_device_tokens WHERE uid = \$1 UNION/i.test(flat)) {
    const uid = String(params[0]);
    const tokens = new Set<string>();
    for (const t of store.accountDeviceTokens) if (t.uid === uid) tokens.add(String(t.token));
    for (const t of store.providerDeviceTokens) if (t.worker_uid === uid) tokens.add(String(t.token));
    for (const u of store.users) {
      if (u.uid === uid && u.fcm_token) tokens.add(String(u.fcm_token));
    }
    return done([...tokens].map((token) => ({ token })));
  }
  if (/^UPDATE servana\.user_credentials SET fcm_token = NULL WHERE fcm_token = \$1 AND uid <> \$2$/i.test(flat)) {
    for (const u of store.users) {
      if (u.fcm_token === params[0] && u.uid !== params[1]) u.fcm_token = null;
    }
    return done([]);
  }
  if (/^UPDATE servana\.user_credentials SET fcm_token = \$1 WHERE uid = \$2$/i.test(flat)) {
    const u = store.users.find((x) => x.uid === params[1]);
    if (u) u.fcm_token = params[0];
    return done([]);
  }
  if (/^UPDATE servana\.user_credentials SET fcm_token = NULL WHERE uid = \$1 AND fcm_token = \$2$/i.test(flat)) {
    const u = store.users.find((x) => x.uid === params[0] && x.fcm_token === params[1]);
    if (u) u.fcm_token = null;
    return done([]);
  }
  if (/^UPDATE servana\.user_credentials SET fcm_token = NULL WHERE uid = \$1$/i.test(flat)) {
    const u = store.users.find((x) => x.uid === params[0]);
    if (u) u.fcm_token = null;
    return done([]);
  }
  if (/^UPDATE servana\.user_credentials SET fcm_token = NULL WHERE fcm_token = \$1$/i.test(flat)) {
    for (const u of store.users) if (u.fcm_token === params[0]) u.fcm_token = null;
    return done([]);
  }
  if (/^SELECT fcm_token FROM servana\.user_credentials WHERE uid = \$1/i.test(flat)) {
    const u = store.users.find((x) => x.uid === params[0]);
    return done(u?.fcm_token ? [{ fcm_token: u.fcm_token }] : []);
  }

  throw new Error(`eventDbFake: unrouted SQL — ${flat.slice(0, 220)}`);
};

const providerRow = (params: unknown[], key: unknown): Row => ({
  id: nextNotificationId++,
  notification_key: key,
  worker_uid: params[0],
  type: params[1],
  severity: params[2],
  title: params[3],
  safe_body: params[4],
  safe_context_label: params[5],
  route: typeof params[6] === 'string' ? JSON.parse(params[6] as string) : params[6],
  can_mark_read: params[7],
  can_dismiss: params[8],
  can_open_detail: params[9],
  expires_at: params[10],
  status: 'unread',
  read_at: null,
  created_at: new Date(Date.now() + nextNotificationId).toISOString(),
});

const customerRow = (params: unknown[], key: unknown): Row => ({
  ...providerRow(params, key),
  user_uid: params[0],
});

/** The `dbQuery` shape the services import. */
export const dbQueryFake = {
  query: async (sql: string, params: unknown[] = []) => run(sql, params),
};
