/**
 * A fake `pg` for the TAB 06 booking-experience services.
 *
 * ## Why not `bookingDbFake`
 *
 * That one is faithful to the LIFECYCLE path — it implements real transactions
 * so the executor's rollback behaviour can be tested, and its SQL router is
 * shaped around the statements `transitionBooking` issues. The experience
 * services ask different questions (an append-only code log, a proposal table, a
 * partial unique index, a provider-calendar overlap), and bending one fake
 * around both would make each suite depend on branches the other needs.
 *
 * This one is deliberately smaller: no transactions, no locks, and one table per
 * thing the experience services actually read or write.
 *
 * ## What it DOES enforce, because the tests would be worthless without it
 *
 * The partial unique index on `booking_escalations`. §66's duplicate prevention
 * has two layers — a policy check and a database constraint — and the second is
 * the one that holds when two callers race. A fake that accepted both inserts
 * would let the race test pass against a database that would have rejected one.
 */

export interface Row { [k: string]: unknown }

export const store = {
  booking: null as Row | null,
  /** Other bookings held by the same provider, for the conflict check. */
  otherBookings: [] as Row[],
  assignments: [] as Row[],
  transitions: [] as Row[],
  tracking: [] as Row[],
  timelineEvents: [] as Row[],
  otpEvents: [] as Row[],
  rescheduleRequests: [] as Row[],
  escalations: [] as Row[],
  payments: [] as Row[],
  additionalRequests: [] as Row[],
  sql: [] as string[],
  /** Makes the next escalation insert behave as a lost unique-index race. */
  forceEscalationRace: false,
  /** Makes the schema ensure fail, to prove it is not swallowed. */
  ensureFails: false,
};

export const reset = (): void => {
  store.booking = null;
  store.otherBookings = [];
  store.assignments = [];
  store.transitions = [];
  store.tracking = [];
  store.timelineEvents = [];
  store.otpEvents = [];
  store.rescheduleRequests = [];
  store.escalations = [];
  store.payments = [];
  store.additionalRequests = [];
  store.sql = [];
  store.forceEscalationRace = false;
  store.ensureFails = false;
};

/** Seeds one booking. Every field the experience services read has a default. */
export const seedBooking = (o: Partial<Row> = {}): Row => {
  store.booking = {
    id: 5001,
    user_id: 'customer-1',
    worker_uid: null,
    status: 'PENDING_OTP',
    schedule: null,
    otp_code: '246813',
    worker_code: null,
    service_option_id: 7,
    user_address_id: null,
    created_at: new Date().toISOString(),
    ...o,
  };
  return store.booking;
};

/** The current assignment's status, which drives the canonical derivation. */
export const seedAssignment = (workerUid: string, status: string): void => {
  store.booking = { ...(store.booking ?? seedBooking()), worker_uid: workerUid };
  store.assignments.push({ booking_id: store.booking.id, worker_uid: workerUid, status });
};

/** A canonical transition row, which is what the tracking window reads. */
export const seedTransition = (toState: string, occurredAt: Date): void => {
  store.transitions.push({
    id: store.transitions.length + 1,
    booking_id: store.booking?.id ?? 5001,
    to_state: toState,
    occurred_at: occurredAt.toISOString(),
  });
};

export const seedOtpEvent = (
  purpose: string,
  event: 'ISSUED' | 'VERIFIED' | 'FAILED',
  createdAt: Date,
): void => {
  store.otpEvents.push({
    booking_id: store.booking?.id ?? 5001,
    purpose,
    event,
    created_at: createdAt.toISOString(),
  });
};

const workerStatus = (): string | null => {
  const uid = store.booking?.worker_uid;
  if (!uid) return null;
  const mine = store.assignments.filter(
    (a) => a.booking_id === store.booking!.id && a.worker_uid === uid,
  );
  return mine.length ? String(mine[mine.length - 1].status) : null;
};

const hasOpenEscalation = (): boolean =>
  store.escalations.some((e) => e.booking_id === store.booking?.id && !e.resolved_at);

export const run = (sql: string, params: unknown[] = []): { rows: Row[]; rowCount: number } => {
  const flat = sql.replace(/\s+/g, ' ').trim();
  store.sql.push(flat);
  const done = (rows: Row[]) => ({ rows, rowCount: rows.length });

  if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(flat)) return done([]);

  if (/CREATE TABLE|CREATE INDEX|CREATE UNIQUE INDEX|ALTER TABLE/i.test(flat)) {
    if (store.ensureFails) throw Object.assign(new Error('permission denied'), { code: '42501' });
    return done([]);
  }

  // ── the booking, as each service projects it ──
  if (/SELECT b\.id, b\.user_id, b\.worker_uid, b\.status, b\.otp_code/i.test(flat)) {
    if (!store.booking || store.booking.id !== Number(params[0])) return done([]);
    return done([{ ...store.booking, worker_status: workerStatus(), has_escalation: hasOpenEscalation() }]);
  }
  if (/SELECT b\.id, b\.status, b\.worker_uid,/i.test(flat)) {
    if (!store.booking || store.booking.id !== Number(params[0])) return done([]);
    return done([{ ...store.booking, worker_status: workerStatus(), has_escalation: hasOpenEscalation() }]);
  }
  if (/SELECT b\.id, b\.status, b\.schedule, b\.worker_uid/i.test(flat)) {
    if (!store.booking || store.booking.id !== Number(params[0])) return done([]);
    const latest = store.payments[store.payments.length - 1];
    return done([{
      ...store.booking,
      worker_status: workerStatus(),
      has_escalation: hasOpenEscalation(),
      payment_status: latest ? String(latest.status ?? '').toUpperCase() : '',
      payment_method: latest ? String(latest.method ?? '').toUpperCase() : '',
    }]);
  }
  if (/SELECT schedule FROM servana\.bookings WHERE id = \$1/i.test(flat)) {
    return done(store.booking ? [{ schedule: store.booking.schedule }] : []);
  }

  // ── booking codes ──
  if (/SELECT event, created_at FROM servana\.booking_otp_events/i.test(flat)) {
    return done(
      store.otpEvents
        .filter((e) => e.booking_id === Number(params[0]) && e.purpose === params[1])
        .map((e) => ({ event: e.event, created_at: e.created_at })),
    );
  }
  if (/INSERT INTO servana\.booking_otp_events/i.test(flat)) {
    store.otpEvents.push({
      booking_id: Number(params[0]), purpose: params[1], event: params[2],
      actor_uid: params[3], actor_role: params[4],
      created_at: new Date().toISOString(),
    });
    return done([]);
  }
  if (/UPDATE servana\.bookings SET (otp_code|worker_code) = \$1 WHERE id = \$2/i.test(flat)) {
    const column = /otp_code/.test(flat) ? 'otp_code' : 'worker_code';
    if (store.booking && store.booking.id === Number(params[1])) store.booking[column] = params[0];
    return done([]);
  }

  // ── tracking ──
  if (/FROM servana\.booking_transitions WHERE booking_id = \$1 AND to_state = ANY/i.test(flat)) {
    const wanted = params[1] as string[];
    const hits = store.transitions
      .filter((t) => t.booking_id === Number(params[0]) && wanted.includes(String(t.to_state)))
      .sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at)));
    return done(hits.length ? [{ occurred_at: hits[0].occurred_at }] : []);
  }
  if (/FROM servana\.booking_tracking WHERE booking_id = \$1/i.test(flat)) {
    return done(store.tracking.filter((t) => t.booking_id === Number(params[0])));
  }

  // ── reschedule ──
  if (/WITH target AS \( SELECT \$2::timestamptz AS start_at/i.test(flat)) {
    // The overlap predicate itself is exercised against a real database by the
    // conflict suites; here the fixture simply declares whether the provider is
    // busy, so the reschedule policy can be tested without reimplementing SQL.
    const conflict = store.otherBookings.some((b) => b.worker_uid === params[0] && b.conflicts);
    return done([{ conflict }]);
  }
  if (/UPDATE servana\.bookings SET schedule = \$1/i.test(flat)) {
    const expected = params[2] ?? null;
    const current = store.booking?.schedule ?? null;
    const same = expected === null ? current === null : String(current) === String(expected);
    if (!store.booking || store.booking.id !== Number(params[1]) || !same) return done([]);
    store.booking.schedule = params[0];
    return done([{ schedule: params[0] }]);
  }
  if (/INSERT INTO servana\.booking_reschedule_requests/i.test(flat)) {
    const id = store.rescheduleRequests.length + 1;
    store.rescheduleRequests.push({
      id, booking_id: Number(params[0]), previous_schedule: params[1],
      proposed_schedule: params[2], reason_code: params[3], reason: params[4],
      status: params[5], refusal_code: params[6], requested_by: params[7],
      requested_role: params[8], decided_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    });
    return done([{ id }]);
  }
  if (/FROM servana\.booking_reschedule_requests WHERE booking_id = \$1/i.test(flat)) {
    return done(store.rescheduleRequests.filter((r) => r.booking_id === Number(params[0])));
  }

  // ── disputes ──
  if (/SELECT 1 FROM servana\.booking_escalations WHERE booking_id = \$1 AND resolved_at IS NULL/i.test(flat)) {
    return done(
      store.escalations.filter((e) => e.booking_id === Number(params[0]) && !e.resolved_at).length
        ? [{ '?column?': 1 }]
        : [],
    );
  }
  if (/INSERT INTO servana\.booking_escalations/i.test(flat)) {
    const bookingId = Number(params[0]);
    // The partial unique index, enforced. Without this the race test would pass
    // against a fake that permits what Postgres refuses.
    const alreadyOpen =
      store.forceEscalationRace ||
      store.escalations.some((e) => e.booking_id === bookingId && !e.resolved_at);
    if (alreadyOpen) {
      store.forceEscalationRace = false;
      throw Object.assign(new Error('duplicate key value violates unique constraint'), {
        code: '23505',
        constraint: 'uq_booking_escalations_one_open',
      });
    }
    const row: Row = {
      id: store.escalations.length + 1,
      booking_id: bookingId,
      reason_code: params[1], reason: params[2], severity: params[3],
      actor_uid: params[4], category: params[5], opened_by_role: params[6],
      state_snapshot: typeof params[7] === 'string' ? JSON.parse(params[7] as string) : params[7],
      resolved_at: null,
      created_at: new Date().toISOString(),
    };
    store.escalations.push(row);
    return done([row]);
  }
  if (/FROM servana\.booking_escalations WHERE booking_id = \$1 ORDER BY/i.test(flat)) {
    return done(store.escalations.filter((e) => e.booking_id === Number(params[0])));
  }

  // ── additional work ──
  if (/FROM servana\.booking_additional_requests WHERE booking_id = \$1/i.test(flat)) {
    return done(store.additionalRequests.filter((r) => r.booking_id === Number(params[0])));
  }

  // ── timeline ──
  if (/INSERT INTO servana\.booking_timeline_events/i.test(flat)) {
    store.timelineEvents.push({
      booking_id: Number(params[0]), event_type: params[1], title: params[2],
      description: params[3], actor_type: params[4], actor_uid: params[5],
      metadata: typeof params[6] === 'string' ? JSON.parse(params[6] as string) : params[6],
    });
    return done([]);
  }

  return done([]);
};

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

/** Lets a test await fire-and-forget side effects. */
export const flush = (): Promise<unknown> => new Promise((r) => setImmediate(r));
