/**
 * A fake `pg` faithful to the booking lifecycle path, shared by the B1/B2
 * migration suites.
 *
 * Extracted from `booking-b1-accept.test.ts` when the second action needed it.
 * One implementation means a later phase cannot quietly relax a property an
 * earlier one relied on — and there is one property here that is easy to get
 * wrong and expensive to get wrong silently:
 *
 * ## It implements real transactions
 *
 * BEGIN snapshots every mutable table; ROLLBACK restores it; COMMIT drops the
 * snapshot. Without that, a rollback test passes against a fake that never
 * rolled anything back, which is worse than not having the test.
 *
 * ## What it does NOT prove
 *
 * That PostgreSQL serialises two concurrent transactions on `FOR UPDATE`. The
 * lock is recorded, not enforced across connections. That gap is named in
 * docs/TAB04_OPEN_GAPS.md and closes with a real database, not here.
 */

export interface Row { [k: string]: unknown }

export const store = {
  booking: null as Row | null,
  assignments: [] as Row[],
  transitions: [] as Row[],
  idempotency: [] as Row[],
  tracking: [] as Row[],
  timelineEvents: [] as Row[],
  payments: [] as Row[],
  /** Every statement issued, flattened. */
  sql: [] as string[],
  /** Statements issued between BEGIN and COMMIT. */
  inTransaction: [] as string[],
  open: false,
  /** Makes the legacy tracking insert fail, to prove the rollback. */
  trackingFails: false,
  /** Makes the legacy timeline-event insert fail, to prove the rollback. */
  timelineEventFails: false,
  /**
   * Opt IN to an address the assignment lookup can use.
   *
   * Default false, so a suite that is not about assignment does not silently
   * start invoking the matching engine — which is what happened when this
   * defaulted the other way and every decline test began calling an
   * unmocked assignNearestWorker.
   */
  withLocation: false,
};

/** Side effects, captured in call order. */
export const calls: string[] = [];

/** The pre-transaction image, held between BEGIN and COMMIT/ROLLBACK. */
let snapshot: string | null = null;

export const reset = (): void => {
  store.booking = null;
  store.assignments = [];
  store.transitions = [];
  store.idempotency = [];
  store.tracking = [];
  store.timelineEvents = [];
  store.payments = [];
  store.sql = [];
  store.inTransaction = [];
  store.open = false;
  store.trackingFails = false;
  store.timelineEventFails = false;
  store.withLocation = false;
  snapshot = null;
  calls.length = 0;
};

const mine = (bookingId: number, uid: unknown) =>
  store.assignments.filter((a) => a.booking_id === bookingId && a.worker_uid === uid);

export const run = (sql: string, params: unknown[] = []): { rows: Row[]; rowCount: number } => {
  const flat = sql.replace(/\s+/g, ' ').trim();
  store.sql.push(flat);
  if (store.open && !/^COMMIT/i.test(flat)) store.inTransaction.push(flat);

  const done = (rows: Row[]) => ({ rows, rowCount: rows.length });

  if (/^BEGIN/i.test(flat)) {
    store.open = true;
    snapshot = JSON.stringify({
      booking: store.booking,
      assignments: store.assignments,
      transitions: store.transitions,
      idempotency: store.idempotency,
      tracking: store.tracking,
      timelineEvents: store.timelineEvents,
      payments: store.payments,
    });
    return done([]);
  }
  if (/^ROLLBACK/i.test(flat)) {
    store.open = false;
    if (snapshot) Object.assign(store, JSON.parse(snapshot));
    snapshot = null;
    return done([]);
  }
  if (/^COMMIT/i.test(flat)) { store.open = false; snapshot = null; return done([]); }
  if (/CREATE TABLE|CREATE INDEX|ALTER TABLE/i.test(flat)) return done([]);

  // ── reads ──
  // getAvailableActions: booking + its current provider's assignment + dispute.
  if (/SELECT b\.id, b\.status, b\.user_id AS customer_uid/i.test(flat)) {
    if (!store.booking) return done([]);
    const current = mine(Number(store.booking.id), store.booking.worker_uid);
    return done([{
      id: store.booking.id,
      status: store.booking.status,
      customer_uid: store.booking.user_id,
      worker_uid: store.booking.worker_uid,
      schedule: store.booking.schedule ?? null,
      worker_status: current.length ? current[current.length - 1].status : null,
      has_escalation: store.transitions.some((t) => t.to_state === 'DISPUTED'),
    }]);
  }
  if (/SELECT id, status, user_id AS customer_uid, worker_uid/i.test(flat)) {
    return done(store.booking ? [{ ...store.booking, customer_uid: store.booking.user_id }] : []);
  }
  if (/SELECT \* FROM servana\.bookings WHERE id = \$1/i.test(flat)) {
    return done(store.booking && store.booking.id === Number(params[0]) ? [{ ...store.booking }] : []);
  }
  if (/SELECT user_id FROM servana\.bookings/i.test(flat)) {
    return done(store.booking ? [{ user_id: store.booking.user_id }] : []);
  }
  if (/SELECT schedule FROM servana\.bookings/i.test(flat)) return done([{ schedule: null }]);
  if (/FROM servana\.user_credentials/i.test(flat)) return done([{ first_name: 'Pro', last_name: 'Vider' }]);
  if (/FROM servana\.bookings b JOIN servana\.service_options/i.test(flat)) {
    // Serves both the reassignment lookup and the post-confirm assignment
    // lookup. `noLocation` reproduces a booking whose address carries no
    // location_id — the case that used to throw AFTER the status was
    // committed.
    if (!store.booking) return done([]);
    return done([{
      schedule: null,
      service_address: null,
      service_id: 1,
      user_address_id: 55,
      location_id: store.withLocation ? 900 : null,
    }]);
  }

  // The cash-settlement guard: one round trip for the EXISTS plus the first
  // payment row, mirroring what the legacy UPDATE and its miss-handler read.
  if (/EXISTS \( SELECT 1 FROM servana\.payments/i.test(flat)) {
    const rows = store.payments.filter((p) => p.booking_id === Number(params[0]));
    const settled = rows.some(
      (p) => String(p.method ?? '').toUpperCase() !== 'CASH'
        || String(p.status ?? '').toUpperCase() === 'PAID',
    );
    return done([{
      settled,
      first_method: rows.length ? String(rows[0].method ?? '').toUpperCase() : null,
      first_status: rows.length ? String(rows[0].status ?? '').toUpperCase() : null,
    }]);
  }

  // OTP confirmation: the credential is compared IN the write, so the fake
  // must too — a fake that checked it separately would pass an implementation
  // that had split them.
  if (/UPDATE servana\.bookings SET status = 'CONFIRMED' WHERE id = \$1 AND otp_code = \$2/i.test(flat)) {
    if (!store.booking || store.booking.id !== Number(params[0])) return done([]);
    if (String(store.booking.otp_code ?? '') !== String(params[1])) return done([]);
    store.booking.status = 'CONFIRMED';
    return done([{ id: store.booking.id }]);
  }
  if (/UPDATE servana\.bookings SET status = \$2, cancelled_at = NOW\(\)/i.test(flat)) {
    if (store.booking && store.booking.id === Number(params[0])) {
      store.booking.status = params[1];
      store.booking.cancelled_at = '2026-08-12T00:00:00.000Z';
    }
    return done([]);
  }
  if (/UPDATE servana\.bookings SET status = 'COMPLETED'/i.test(flat)) {
    if (store.booking && store.booking.id === Number(params[0])) store.booking.status = 'COMPLETED';
    return done([]);
  }
  if (/UPDATE servana\.booking_workers SET status = 'COMPLETED', completed_at = NOW\(\)/i.test(flat)) {
    for (const a of mine(Number(params[0]), params[1])) {
      a.status = 'COMPLETED';
      a.completed_at = '2026-08-12T00:00:00.000Z';
    }
    return done([]);
  }
  // Admin force-completion closes whichever assignment row is still open.
  if (/UPDATE servana\.booking_workers[\s\S]*?status IN \('IN_PROGRESS','ACCEPTED','ASSIGNED'\)/i.test(flat)) {
    for (const a of store.assignments) {
      if (a.booking_id !== Number(params[0])) continue;
      if (['IN_PROGRESS', 'ACCEPTED', 'ASSIGNED'].includes(String(a.status))) {
        a.status = 'COMPLETED';
        a.completed_at = '2026-08-12T00:00:00.000Z';
      }
    }
    return done([]);
  }

  if (/SELECT \* FROM servana\.booking_workers/i.test(flat)) {
    const rows = mine(Number(params[0]), params[1]);
    return done(rows.length ? [rows[rows.length - 1]] : []);
  }
  if (/SELECT status FROM servana\.booking_workers/i.test(flat)) {
    const rows = mine(Number(params[0]), params[1]);
    return done(rows.length ? [{ status: rows[rows.length - 1].status }] : []);
  }

  if (/FROM servana\.booking_transitions WHERE booking_id = \$1 AND to_state = 'DISPUTED'/i.test(flat)) {
    return done(store.transitions.filter((t) => t.to_state === 'DISPUTED').slice(0, 1));
  }
  if (/FROM servana\.booking_transition_idempotency/i.test(flat)) {
    const [actor, bookingId, action, key] = params;
    const hit = store.idempotency.find(
      (r) => r.actor_uid === actor && r.booking_id === Number(bookingId)
        && r.action === action && r.idempotency_key === key,
    );
    return done(hit ? [hit] : []);
  }

  // ── writes ──
  if (/INSERT INTO servana\.booking_transition_idempotency/i.test(flat)) {
    store.idempotency.push({
      actor_uid: params[0], booking_id: Number(params[1]), action: params[2],
      idempotency_key: params[3], request_digest: params[4], result: JSON.parse(String(params[5])),
    });
    return done([]);
  }

  if (/UPDATE servana\.booking_workers SET status = \$3, accepted_at = NOW\(\)/i.test(flat)) {
    for (const a of mine(Number(params[0]), params[1])) {
      a.status = params[2];
      a.accepted_at = '2026-08-12T00:00:00.000Z';
    }
    return done([]);
  }
  // The arrival stages, which stamp the column their destination implies.
  if (/UPDATE servana\.booking_workers SET status = \$3, (en_route_at|arrived_at) = NOW\(\)/i.test(flat)) {
    const column = /en_route_at/.test(flat) ? 'en_route_at' : 'arrived_at';
    for (const a of mine(Number(params[0]), params[1])) {
      a.status = params[2];
      a[column] = '2026-08-12T00:00:00.000Z';
    }
    return done([]);
  }
  if (/UPDATE servana\.bookings SET status = \$2 WHERE id = \$1 AND worker_uid = \$3/i.test(flat)) {
    if (store.booking && store.booking.id === Number(params[0]) && store.booking.worker_uid === params[2]) {
      store.booking.status = params[1];
    }
    return done([]);
  }
  // The decline / provider-cancel close, which stamps declined_at conditionally.
  if (/UPDATE servana\.booking_workers SET status = \$3, declined_at = CASE/i.test(flat)) {
    for (const a of mine(Number(params[0]), params[1])) {
      a.status = params[2];
      if (params[3]) a.declined_at = '2026-08-12T00:00:00.000Z';
    }
    return done([]);
  }
  if (/UPDATE servana\.bookings SET worker_uid = NULL, status = 'CONFIRMED'/i.test(flat)) {
    if (store.booking && store.booking.id === Number(params[0])) {
      Object.assign(store.booking, {
        worker_uid: null, status: 'CONFIRMED',
        eta_minutes: null, eta_at: null, worker_code: null,
      });
    }
    return done([]);
  }

  /**
   * The atomic start: matches ONLY when the booking's worker_code equals $3.
   *
   * Modelled faithfully because the whole point of the statement is that the
   * credential check and the write are one operation. A fake that checked the
   * code separately would pass a implementation that had split them.
   */
  if (/UPDATE servana\.booking_workers bw[\s\S]*worker_code = \$3/i.test(flat)) {
    const [bookingId, workerUid, code] = params;
    if (!store.booking || store.booking.worker_code !== code) return done([]);
    const rows = mine(Number(bookingId), workerUid);
    for (const a of rows) {
      a.status = 'IN_PROGRESS';
      a.started_at = '2026-08-12T00:00:00.000Z';
    }
    return done(rows.length ? [{ booking_id: Number(bookingId) }] : []);
  }

  // ── assignment / reassignment ──
  // Reassignment closes the outgoing row as DECLINED, not REASSIGNED — see the
  // executor's ASSIGNED branch for why the accurate word is not used.
  if (/UPDATE servana\.booking_workers SET status = 'DECLINED' WHERE booking_id = \$1 AND worker_uid = \$2/i.test(flat)) {
    for (const a of mine(Number(params[0]), params[1])) a.status = 'DECLINED';
    return done([]);
  }
  if (/INSERT INTO servana\.booking_workers/i.test(flat)) {
    store.assignments.push({ booking_id: Number(params[0]), worker_uid: params[1], status: 'ASSIGNED' });
    return done([]);
  }
  if (/UPDATE servana\.bookings SET worker_uid = \$2/i.test(flat)) {
    if (store.booking && store.booking.id === Number(params[0])) store.booking.worker_uid = params[1];
    return done([]);
  }

  if (/INSERT INTO servana\.booking_timeline_events/i.test(flat)) {
    if (store.timelineEventFails) throw new Error('relation "booking_timeline_events" is locked');
    store.timelineEvents.push({
      booking_id: Number(params[0]), event_type: params[1], title: params[2],
      description: params[3], actor_type: params[4], actor_uid: params[5], metadata: params[6],
    });
    return done([]);
  }
  // Cancellation closes EVERY live assignment row, not only the pointer's.
  if (/UPDATE servana\.booking_workers SET status = \$2[\s\S]*?status IN \('ASSIGNED','ACCEPTED','EN_ROUTE','ARRIVED'\)/i.test(flat)) {
    for (const a of store.assignments) {
      if (a.booking_id !== Number(params[0])) continue;
      if (['ASSIGNED', 'ACCEPTED', 'EN_ROUTE', 'ARRIVED'].includes(String(a.status))) {
        a.status = params[1];
      }
    }
    return done([]);
  }
  if (/INSERT INTO servana\.booking_tracking/i.test(flat)) {
    if (store.trackingFails) throw new Error('relation "booking_tracking" is locked');
    store.tracking.push({ booking_id: Number(params[0]), status: params[1], note: params[2] });
    return done([]);
  }
  if (/INSERT INTO servana\.booking_transitions/i.test(flat)) {
    const id = store.transitions.length + 1;
    store.transitions.push({
      id, action: params[1], from_state: params[2], to_state: params[3],
      actor_role: params[4], actor_uid: params[5],
      // TRUE / FALSE are literals in the statement, not parameters, so the
      // fake reads them from the SQL exactly as Postgres would.
      state_changed: !/,\s*FALSE\s*\)/i.test(flat),
    });
    return done([{ id }]);
  }

  return done([]);
};

/** The shape `jest.mock('../src/db/dbQuery', …)` should return. */
export const dbMock = {
  __esModule: true,
  default: { query: async (sql: string, p?: unknown[]) => run(sql, p) },
  pool: {
    connect: async () => ({
      query: async (sql: string, p?: unknown[]) => run(sql, p),
      release: () => undefined,
    }),
  },
};

/** Every side effect the provider lifecycle fires, recorded not performed. */
export const sideEffectMocks = {
  mailer: { send: (...a: unknown[]) => { calls.push(`email:${String(a[1])}`); } },
  notification: {
    createCustomerNotification: async (uid: string) => { calls.push(`customerNotify:${uid}`); },
    createNotification: async (uid: string, p: { type: string }) => { calls.push(`providerNotify:${p.type}`); },
  },
  adminNotification: {
    notifyAdminsSafely: (p: { type: string }) => { calls.push(`adminNotify:${p.type}`); },
  },
  realtime: { emitToProvider: (uid: string, ev: string) => { calls.push(`emit:${ev}:${uid}`); } },
  chat: {
    getOrCreateConversation: async () => { calls.push('chat:conversation'); return { id: 77 }; },
    postSystemMessageOnce: async () => { calls.push('chat:systemMessage'); },
  },
  chatRepo: { findExistingConversationByBookingId: async () => ({ id: 77 }) },
  user: { getUserInfoByBookingId: async () => ({ email: 'c@x.co', firstName: 'Cee' }) },
};

/** Lets a test await the fire-and-forget side effects. */
export const flush = (): Promise<unknown> => new Promise((r) => setImmediate(r));
