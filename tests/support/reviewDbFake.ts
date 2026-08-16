/**
 * A fake `pg` for the TAB 12 post-service support layer.
 *
 * ## Scope, deliberately narrow
 *
 * This routes the SUPPORT-CASE statements, not the review ones. The review
 * service's own guarantees — the advisory lock, the `client_request_id` replay,
 * the transactional existing-review check — are exercised by
 * `review-eligibility.test.ts` against the PURE decision function plus source
 * assertions, because the review write path is 150 lines of SQL against six
 * tables from migration 012 and a fake faithful enough to test it would be a
 * reimplementation of Postgres rather than a fixture.
 *
 * What IS modelled here is what TAB 12 added: the booking-scoped support case,
 * its ownership predicate, its open-case ceiling and its idempotency index. Those
 * are guarantees this tab is responsible for, so they are tested against real
 * statements.
 */

export interface Row { [k: string]: unknown }

let nextCaseId = 1;

export const store = {
  bookings: [] as Row[],
  bookingWorkers: [] as Row[],
  supportCases: [] as Row[],
  sql: [] as string[],
  /** Makes the next COMMIT throw, to prove the rollback path. */
  failNextCommit: false,
};

export const reset = (): void => {
  store.bookings = [];
  store.bookingWorkers = [];
  store.supportCases = [];
  store.sql = [];
  store.failNextCommit = false;
  nextCaseId = 1;
};

// ─── Seeding ──────────────────────────────────────────────────────────────────

export const seedBooking = (id: number, customerUid: string, status = 'COMPLETED'): void => {
  store.bookings.push({ id, user_id: customerUid, status });
};

export const seedAssignment = (bookingId: number, workerUid: string): void => {
  store.bookingWorkers.push({
    id: store.bookingWorkers.length + 1,
    booking_id: bookingId,
    worker_uid: workerUid,
  });
};

export const casesFor = (bookingId: number): Row[] =>
  store.supportCases.filter((c) => Number(c.booking_id) === bookingId);

// ─── Transactions ─────────────────────────────────────────────────────────────

let snapshot: Row[] | null = null;

const begin = () => { snapshot = store.supportCases.map((row) => ({ ...row })); };
const rollback = () => { if (snapshot) store.supportCases = snapshot; snapshot = null; };
const commit = () => {
  if (store.failNextCommit) {
    store.failNextCommit = false;
    rollback();
    throw new Error('commit failed');
  }
  snapshot = null;
};

// ─── The router ───────────────────────────────────────────────────────────────

const done = (rows: Row[]) => ({ rows, rowCount: rows.length });

export const run = (sql: string, params: unknown[] = []): { rows: Row[]; rowCount: number } => {
  const flat = sql.replace(/\s+/g, ' ').trim();
  store.sql.push(flat);

  if (/^BEGIN/i.test(flat)) { begin(); return done([]); }
  if (/^COMMIT/i.test(flat)) { commit(); return done([]); }
  if (/^ROLLBACK/i.test(flat)) { rollback(); return done([]); }
  if (/^SELECT pg_advisory_xact_lock/i.test(flat)) return done([]);
  if (/^(CREATE TABLE|CREATE INDEX|CREATE UNIQUE INDEX|ALTER TABLE|COMMENT ON)/i.test(flat)) {
    return done([]);
  }

  // ── replay on client_request_id ───────────────────────────────────────────
  if (/FROM servana\.booking_support_cases WHERE customer_uid = \$1 AND client_request_id = \$2/i.test(flat)) {
    const row = store.supportCases.find(
      (c) => c.customer_uid === params[0] && c.client_request_id === params[1],
    );
    return done(row ? [row] : []);
  }

  // ── the booking, OWNER-SCOPED ────────────────────────────────────────────
  if (/FROM servana\.bookings b WHERE b\.id = \$1 AND b\.user_id = \$2/i.test(flat)) {
    // The ownership predicate is in the WHERE clause. A fake that ignored it
    // would let the isolation test pass against a query that had none.
    const booking = store.bookings.find(
      (b) => Number(b.id) === Number(params[0]) && b.user_id === params[1],
    );
    if (!booking) return done([]);
    const assignment = store.bookingWorkers
      .filter((w) => Number(w.booking_id) === Number(booking.id))
      .slice(-1)[0];
    return done([{
      id: booking.id,
      status: booking.status,
      user_id: booking.user_id,
      provider_uid: assignment?.worker_uid ?? null,
    }]);
  }

  // ── the open-case ceiling ─────────────────────────────────────────────────
  if (/COUNT\(\*\)::int AS count FROM servana\.booking_support_cases/i.test(flat)) {
    const count = store.supportCases.filter(
      (c) => Number(c.booking_id) === Number(params[0])
        && c.customer_uid === params[1]
        && c.state === 'OPEN',
    ).length;
    return done([{ count }]);
  }

  // ── insert ────────────────────────────────────────────────────────────────
  if (/^INSERT INTO servana\.booking_support_cases/i.test(flat)) {
    const [bookingId, customerUid, providerUid, category, severity, routedTo, summary, detail, requestId] =
      params as any[];
    // The partial unique index on (customer_uid, client_request_id).
    if (requestId != null) {
      const clash = store.supportCases.find(
        (c) => c.customer_uid === customerUid && c.client_request_id === requestId,
      );
      if (clash) throw Object.assign(new Error('duplicate key'), { code: '23505' });
    }
    const row: Row = {
      case_id: nextCaseId++,
      booking_id: Number(bookingId),
      customer_uid: customerUid,
      provider_uid: providerUid,
      category,
      severity,
      routed_to: routedTo,
      state: 'OPEN',
      summary,
      detail,
      client_request_id: requestId,
      created_at: new Date().toISOString(),
      resolved_at: null,
    };
    store.supportCases.push(row);
    return done([row]);
  }

  // ── list, OWNER-SCOPED ────────────────────────────────────────────────────
  if (/FROM servana\.booking_support_cases WHERE booking_id = \$1 AND customer_uid = \$2/i.test(flat)) {
    return done(
      store.supportCases
        .filter((c) => Number(c.booking_id) === Number(params[0]) && c.customer_uid === params[1])
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))),
    );
  }

  throw new Error(`reviewDbFake: unrouted SQL — ${flat.slice(0, 220)}`);
};

export const dbQueryFake = {
  query: async (sql: string, params: unknown[] = []) => run(sql, params),
};

export const poolFake = {
  connect: async () => ({
    query: async (sql: string, params: unknown[] = []) => run(sql, params),
    release: () => undefined,
  }),
};
