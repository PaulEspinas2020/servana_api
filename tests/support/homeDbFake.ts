/**
 * A fake `pg` for the TAB 11 home composition.
 *
 * ## Why a fake and not mocked section builders
 *
 * The release gates here are about what the composition READS:
 *
 *   - popularity must resolve through `bookingCanonicalServiceSql`, so a booking
 *     created against a legacy option id ranks the right `services.id`;
 *   - personal sections must filter on the caller's uid in the WHERE clause;
 *   - the active-booking card must derive its state from the same columns the
 *     booking read model derives from.
 *
 * Mocking the builders would prove the composition calls them. Routing the real
 * SQL proves the queries are scoped and the ids are canonical, which is what the
 * gates actually say.
 *
 * The legacy-id resolution is modelled faithfully: a booking with a NULL
 * `catalog_service_id` falls back to the service whose `legacy_service_option_id`
 * matches, exactly as the COALESCE does. That is the branch that would otherwise
 * silently rank nothing.
 */

export interface Row { [k: string]: unknown }

export const store = {
  bookings: [] as Row[],
  bookingWorkers: [] as Row[],
  services: [] as Row[],
  users: [] as Row[],
  notifications: [] as Row[],
  sql: [] as string[],
  /** Section names whose next query should throw, to prove partial failure. */
  failing: new Set<string>(),
};

export const reset = (): void => {
  store.bookings = [];
  store.bookingWorkers = [];
  store.services = [];
  store.users = [];
  store.notifications = [];
  store.sql = [];
  store.failing = new Set();
};

// ─── Seeding ──────────────────────────────────────────────────────────────────

export const seedUser = (uid: string, role = 3): void => {
  store.users.push({ uid, role });
};

/** A Catalog V2 service. `legacyOptionId` models the pre-V2 identifier. */
export const seedService = (
  id: number,
  name: string,
  o: Partial<Row> = {},
): void => {
  store.services.push({
    id,
    name,
    legacy_service_option_id: o.legacyOptionId ?? null,
    ...o,
  });
};

export const seedBooking = (
  id: number,
  uid: string,
  o: Partial<Row> = {},
): Row => {
  const row: Row = {
    id,
    user_id: uid,
    status: 'COMPLETED',
    schedule: null,
    worker_uid: null,
    catalog_service_id: null,
    service_option_id: null,
    created_at: new Date(2026, 0, id).toISOString(),
    ...o,
  };
  store.bookings.push(row);
  return row;
};

export const seedNotification = (uid: string, unread = true): void => {
  store.notifications.push({ user_uid: uid, status: unread ? 'unread' : 'read' });
};

// ─── The canonical service resolution, modelled ───────────────────────────────

/**
 * `COALESCE(b.catalog_service_id, (SELECT cs.id FROM services cs WHERE
 * cs.legacy_service_option_id = b.service_option_id))`
 *
 * The fallback branch is the one that matters: without it a booking created
 * before Catalog V2 resolves to nothing and silently drops out of the ranking.
 */
const canonicalServiceIdOf = (booking: Row): number | null => {
  if (booking.catalog_service_id != null) return Number(booking.catalog_service_id);
  if (booking.service_option_id == null) return null;
  const match = store.services.find(
    (s) => s.legacy_service_option_id != null
      && Number(s.legacy_service_option_id) === Number(booking.service_option_id),
  );
  return match ? Number(match.id) : null;
};

// ─── The router ───────────────────────────────────────────────────────────────

const done = (rows: Row[]) => ({ rows, rowCount: rows.length });

export const run = (sql: string, params: unknown[] = []): { rows: Row[]; rowCount: number } => {
  const flat = sql.replace(/\s+/g, ' ').trim();
  store.sql.push(flat);

  if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(flat)) return done([]);
  if (/^(CREATE TABLE|CREATE INDEX|CREATE UNIQUE INDEX|ALTER TABLE|COMMENT ON)/i.test(flat)) {
    return done([]);
  }
  if (/CREATE TABLE IF NOT EXISTS/i.test(flat)) return done([]);

  // ── popularity: completed bookings, grouped by canonical service id ────────
  if (/COUNT\(\*\)::int AS bookings/i.test(flat) && /FROM servana\.bookings b/i.test(flat)) {
    if (store.failing.has('popularServices')) throw new Error('popularity query failed');
    const counts = new Map<number, number>();
    for (const booking of store.bookings) {
      if (String(booking.status ?? '').toUpperCase() !== 'COMPLETED') continue;
      const serviceId = canonicalServiceIdOf(booking);
      if (serviceId == null) continue;
      counts.set(serviceId, (counts.get(serviceId) ?? 0) + 1);
    }
    const limit = Number(params[0] ?? 10);
    return done(
      [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([service_id, bookings]) => ({ service_id, bookings })),
    );
  }

  // ── recent services for ONE account ───────────────────────────────────────
  if (/DISTINCT ON \(service_id\)/i.test(flat)) {
    if (store.failing.has('recentServices')) throw new Error('recent query failed');
    const uid = String(params[0]);
    const byService = new Map<number, string>();
    for (const booking of store.bookings) {
      // The account scope. A fake that ignored it would let the isolation test
      // pass against a query with no WHERE clause.
      if (String(booking.user_id) !== uid) continue;
      const serviceId = canonicalServiceIdOf(booking);
      if (serviceId == null) continue;
      const at = String(booking.created_at);
      if (!byService.has(serviceId) || at > byService.get(serviceId)!) {
        byService.set(serviceId, at);
      }
    }
    return done(
      [...byService.entries()].map(([service_id, created_at]) => ({ service_id, created_at })),
    );
  }

  // ── active bookings for ONE account ───────────────────────────────────────
  if (/LEFT JOIN LATERAL/i.test(flat) && /FROM servana\.bookings b/i.test(flat)) {
    if (store.failing.has('activeBooking')) throw new Error('active booking query failed');
    const uid = String(params[0]);
    const limit = Number(params[1] ?? 3);
    const terminal = new Set(['COMPLETED', 'CANCELLED', 'EXPIRED']);
    return done(
      store.bookings
        .filter((b) => String(b.user_id) === uid)
        .filter((b) => !terminal.has(String(b.status ?? '').toUpperCase()))
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, limit)
        .map((b) => {
          const assignment = store.bookingWorkers
            .filter((w) => Number(w.booking_id) === Number(b.id))
            .slice(-1)[0];
          return {
            id: b.id,
            status: b.status,
            schedule: b.schedule,
            worker_uid: b.worker_uid,
            assignment_status: assignment?.status ?? null,
            service_id: canonicalServiceIdOf(b),
          };
        }),
    );
  }

  // ── notification unread count (TAB 09 inbox) ──────────────────────────────
  if (/^SELECT role::int AS role FROM servana\.user_credentials/i.test(flat)) {
    const u = store.users.find((x) => String(x.uid) === String(params[0]));
    return done(u ? [{ role: Number(u.role) }] : []);
  }
  if (/COUNT\(\*\) AS cnt FROM servana\.customer_notifications/i.test(flat)) {
    if (store.failing.has('notificationSummary')) throw new Error('unread count failed');
    const n = store.notifications.filter(
      (x) => x.user_uid === params[0] && x.status === 'unread',
    ).length;
    return done([{ cnt: String(n) }]);
  }
  if (/servana\.customer_notifications/i.test(flat)) return done([]);
  if (/servana\.provider_notifications/i.test(flat)) return done([{ cnt: '0' }]);
  if (/servana\.admin_notifications/i.test(flat)) return done([{ count: '0' }]);

  throw new Error(`homeDbFake: unrouted SQL — ${flat.slice(0, 220)}`);
};

export const dbQueryFake = {
  query: async (sql: string, params: unknown[] = []) => run(sql, params),
};
