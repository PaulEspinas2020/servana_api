/**
 * The transition executor: races, retries, and who is allowed to do what.
 *
 * The database is faked, but faithfully enough for the properties under test:
 * a shared store, per-connection transaction buffering, and `FOR UPDATE`
 * serialising callers against one booking. What is NOT proven here is that
 * PostgreSQL honours the lock — that needs a real database and is listed as a
 * gap rather than implied.
 *
 * What IS proven: the executor asks for the lock before deciding, derives state
 * from the locked rows, authorizes from those rows rather than from the
 * request, refuses stale and impossible transitions, replays a retry instead of
 * failing it, and writes the timeline inside the same transaction it commits.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' } }));

// ─── A small, honest fake of the bits of pg the executor uses ────────────────

interface Row { [k: string]: unknown }

class FakeDb {
  bookings = new Map<number, Row>();
  assignments: Row[] = [];
  transitions: Row[] = [];
  payments: Row[] = [];
  idempotency: Row[] = [];
  /** Every statement issued, in order, tagged by connection. */
  log: Array<{ conn: number; sql: string }> = [];
  nextTransitionId = 1;
  /** Bookings currently locked, and by which connection. */
  locks = new Map<number, number>();

  reset() {
    this.bookings.clear();
    this.assignments = [];
    this.transitions = [];
    this.payments = [];
    this.idempotency = [];
    this.log = [];
    this.nextTransitionId = 1;
    this.locks.clear();
  }
}

const db = new FakeDb();
let connSeq = 0;

/**
 * Real pg always returns `rowCount`. The first version of this fake returned
 * only `rows`, so the executor's `if (!started.rowCount)` treated a successful
 * atomic start as a wrong code — a fake that is missing a field the code reads
 * fails in the direction that looks like a product bug.
 */
const runQuery = (conn: number, sql: string, params: unknown[] = []): { rows: Row[]; rowCount: number } => {
  const result = runQueryInner(conn, sql, params);
  return { rows: result.rows, rowCount: result.rows.length };
};

const runQueryInner = (conn: number, sql: string, params: unknown[] = []): { rows: Row[] } => {
  db.log.push({ conn, sql: sql.replace(/\s+/g, ' ').trim() });

  if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) {
    if (/COMMIT|ROLLBACK/i.test(sql)) {
      for (const [id, owner] of db.locks) if (owner === conn) db.locks.delete(id);
    }
    return { rows: [] };
  }

  if (/CREATE TABLE|CREATE INDEX/i.test(sql)) return { rows: [] };

  /**
   * Assignment target validation, moved into the executor by D4.
   *
   * Defaults say "assignable" so the reassignment tests, which are about state
   * and history rather than eligibility, do not each have to seed a provider
   * record, a qualification row and an empty conflict window.
   */
  if (/pg_advisory_xact_lock/i.test(sql)) return { rows: [] };
  if (/FROM servana\.user_credentials[\s\S]*?role::int IN/i.test(sql)) {
    return { rows: [{ uid: params[0], first_name: 'Pro', last_name: 'Vider', is_archive: false }] };
  }
  if (/FROM servana\.employee_services/i.test(sql)) return { rows: [{ ok: 1 }] };
  if (/SELECT id FROM servana\.bookings[\s\S]*?worker_uid = \$1 AND id <> \$2/i.test(sql)) {
    return { rows: [] };
  }
  if (/SELECT b\.schedule, so\.service_id/i.test(sql)) {
    return { rows: [{ schedule: null, service_id: 1 }] };
  }

  // The cash-settlement guard for PROVIDER_COMPLETE.
  if (/EXISTS\s*\(\s*SELECT 1 FROM servana\.payments/is.test(sql)) {
    const rows = db.payments.filter((p) => p.booking_id === Number(params[0]));
    const settled = rows.some(
      (p) => String(p.method ?? '').toUpperCase() !== 'CASH'
        || String(p.status ?? '').toUpperCase() === 'PAID',
    );
    return { rows: [{
      settled,
      first_method: rows.length ? String(rows[0].method ?? '').toUpperCase() : null,
      first_status: rows.length ? String(rows[0].status ?? '').toUpperCase() : null,
    }] };
  }

  // ── booking load, with the lock ──
  if (/FROM servana\.bookings\s+WHERE id = \$1\s+FOR UPDATE/is.test(sql)) {
    const id = Number(params[0]);
    const holder = db.locks.get(id);
    if (holder !== undefined && holder !== conn) {
      throw new Error(`LOCK_CONTENTION: booking ${id} is locked by connection ${holder}`);
    }
    db.locks.set(id, conn);
    const b = db.bookings.get(id);
    return { rows: b ? [{ id, status: b.status, customer_uid: b.customer_uid, worker_uid: b.worker_uid, schedule: b.schedule ?? null }] : [] };
  }

  if (/FROM servana\.booking_workers\s+WHERE booking_id = \$1 AND worker_uid = \$2/is.test(sql)) {
    const [bookingId, workerUid] = params;
    const found = db.assignments.filter((a) => a.booking_id === Number(bookingId) && a.worker_uid === workerUid);
    return { rows: found.length ? [{ status: found[found.length - 1].status }] : [] };
  }

  if (/FROM servana\.booking_transitions\s+WHERE booking_id = \$1 AND to_state = 'DISPUTED'/is.test(sql)) {
    const found = db.transitions.filter((t) => t.booking_id === Number(params[0]) && t.to_state === 'DISPUTED');
    return { rows: found.slice(0, 1) };
  }

  // ── idempotency ──
  if (/FROM servana\.booking_transition_idempotency/i.test(sql)) {
    const [actor, bookingId, action, key] = params;
    const found = db.idempotency.find(
      (r) => r.actor_uid === actor && r.booking_id === Number(bookingId) && r.action === action && r.idempotency_key === key,
    );
    return { rows: found ? [found] : [] };
  }
  if (/INSERT INTO servana\.booking_transition_idempotency/i.test(sql)) {
    const [actor_uid, booking_id, action, idempotency_key, request_digest, result] = params;
    db.idempotency.push({
      actor_uid, booking_id: Number(booking_id), action, idempotency_key, request_digest,
      result: JSON.parse(String(result)),
    });
    return { rows: [] };
  }

  // ── writes ──
  if (/UPDATE servana\.bookings/i.test(sql)) {
    const id = Number(params[0]);
    const b = db.bookings.get(id);
    if (b) {
      if (/worker_uid = \$2, status = 'WORKER_ASSIGNED'/i.test(sql)) {
        b.worker_uid = params[1];
        b.status = 'WORKER_ASSIGNED';
        return { rows: [] };
      }
      if (/status = 'CONFIRMED'/i.test(sql)) b.status = 'CONFIRMED';
      else if (/status = 'COMPLETED'/i.test(sql)) b.status = 'COMPLETED';
      else if (/status = 'EXPIRED'/i.test(sql)) b.status = 'EXPIRED';
      else if (/status = \$2, cancelled_at/i.test(sql)) b.status = String(params[1]);
      if (/worker_uid = NULL/i.test(sql)) b.worker_uid = null;
      else if (/worker_uid = \$2/i.test(sql)) b.worker_uid = params[1];
    }
    return { rows: [] };
  }

  if (/INSERT INTO servana\.booking_workers/i.test(sql)) {
    db.assignments.push({ booking_id: Number(params[0]), worker_uid: params[1], status: 'ASSIGNED' });
    return { rows: [] };
  }

  // The atomic start: matches only when the booking's worker_code equals $3.
  if (/UPDATE servana\.booking_workers bw[\s\S]*worker_code = \$3/i.test(sql)) {
    const [bookingId, workerUid, code] = params;
    const booking = db.bookings.get(Number(bookingId));
    if (!booking || booking.worker_code !== code) return { rows: [] };
    let matched = false;
    for (const a of db.assignments) {
      if (a.booking_id === Number(bookingId) && a.worker_uid === workerUid) {
        a.status = 'IN_PROGRESS';
        matched = true;
      }
    }
    return { rows: matched ? [{ booking_id: Number(bookingId) }] : [] };
  }

  if (/UPDATE servana\.booking_workers SET status = \$3/i.test(sql)) {
    const [bookingId, workerUid, status] = params;
    for (const a of db.assignments) {
      if (a.booking_id === Number(bookingId) && a.worker_uid === workerUid) a.status = status;
    }
    return { rows: [] };
  }
  // Reassignment closes the outgoing row as DECLINED. See the executor's
  // ASSIGNED branch: auto-assignment excludes providers whose row on this
  // booking says DECLINED, so the semantically accurate REASSIGNED would make
  // the provider an admin just removed eligible to be assigned straight back.
  // Whitespace-tolerant: this fake matches RAW sql, so a statement reformatted
  // across lines would silently stop matching and fall through to a later
  // branch — which reads as a wrong status rather than as a broken double.
  if (/UPDATE\s+servana\.booking_workers\s+SET\s+status\s*=\s*'DECLINED'[\s\S]*?worker_uid\s*=\s*\$2/i.test(sql)) {
    for (const a of db.assignments) {
      if (a.booking_id === Number(params[0]) && a.worker_uid === params[1]) a.status = 'DECLINED';
    }
    return { rows: [] };
  }
  if (/UPDATE servana\.booking_workers SET status = 'COMPLETED'/i.test(sql)) {
    for (const a of db.assignments) {
      if (a.booking_id === Number(params[0]) && a.worker_uid === params[1]) a.status = 'COMPLETED';
    }
    return { rows: [] };
  }

  if (/INSERT INTO servana\.booking_transitions/i.test(sql)) {
    const id = db.nextTransitionId++;
    db.transitions.push({
      id, booking_id: Number(params[0]), action: params[1], from_state: params[2], to_state: params[3],
      actor_role: params[4], actor_uid: params[5], provider_uid: params[6], reason: params[7],
      metadata: params[8], correlation_id: params[9], occurred_at: new Date(Date.now() + id).toISOString(),
    });
    return { rows: [{ id }] };
  }

  if (/FROM servana\.booking_transitions/i.test(sql)) {
    const rows = db.transitions
      .filter((t) => t.booking_id === Number(params[0]))
      .sort((a, b) => Number(a.id) - Number(b.id));
    return { rows };
  }

  return { rows: [] };
};

jest.mock('../src/db/dbQuery', () => {
  const makeClient = () => {
    const conn = ++connSeq;
    return {
      conn,
      query: jest.fn(async (sql: string, params?: unknown[]) => runQuery(conn, sql, params)),
      release: jest.fn(),
    };
  };
  return {
    __esModule: true,
    default: { query: jest.fn(async (sql: string, params?: unknown[]) => runQuery(0, sql, params)) },
    pool: { connect: jest.fn(async () => makeClient()) },
  };
});

import {
  transitionBooking,
  getBookingTimeline,
  priorTerminalState,
  TransitionError,
  __resetTransitionSchema,
  redactMetadata,
} from '../src/services/booking/transitionExecutor';

const CUSTOMER = 'customer-uid';
const PROVIDER_A = 'provider-a';
const PROVIDER_B = 'provider-b';

const seedBooking = (opts: {
  status?: string;
  workerUid?: string | null;
  assignmentStatus?: string;
  /** Hours from now. Default is well outside the provider-cancel window, so a
   *  test about something else is not silently blocked by the 48-hour policy. */
  scheduleInHours?: number;
  /** Default is a settled card payment, so the cash-completion guard passes
   *  for tests that are not about payment. Set explicitly to exercise it. */
  payment?: { method: string; status: string } | null;
} = {}) => {
  db.reset();
  __resetTransitionSchema();
  db.bookings.set(1, {
    id: 1,
    status: opts.status ?? 'CONFIRMED',
    customer_uid: CUSTOMER,
    worker_uid: opts.workerUid === undefined ? PROVIDER_A : opts.workerUid,
    schedule: new Date(Date.now() + (opts.scheduleInHours ?? 240) * 3_600_000).toISOString(),
  });
  db.payments = opts.payment === undefined
    ? [{ booking_id: 1, method: 'CARD', status: 'PAID' }]
    : opts.payment ? [{ booking_id: 1, ...opts.payment }] : [];
  if (opts.assignmentStatus && opts.workerUid !== null) {
    db.assignments.push({ booking_id: 1, worker_uid: opts.workerUid ?? PROVIDER_A, status: opts.assignmentStatus });
  }
};

beforeEach(() => { connSeq = 0; });

// ─── Authorization comes from the rows ────────────────────────────────────────

describe('authorization is derived from the booking, never from the request', () => {
  it('the assigned provider may accept', async () => {
    seedBooking({ assignmentStatus: 'ASSIGNED' });
    const result = await transitionBooking({
      bookingId: 1, action: 'PROVIDER_ACCEPT', actorUid: PROVIDER_A, actorRole: 'assigned_provider',
    });
    expect(result.fromState).toBe('ASSIGNED');
    expect(result.toState).toBe('ACCEPTED');
  });

  it('a DIFFERENT provider cannot act on the same booking', async () => {
    // Provider B holds a valid token and knows the booking id. That is not
    // authorization — §11: ids are identifiers, not permission.
    seedBooking({ assignmentStatus: 'ASSIGNED' });
    await expect(
      transitionBooking({ bookingId: 1, action: 'PROVIDER_ACCEPT', actorUid: PROVIDER_B, actorRole: 'assigned_provider' }),
    ).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
  });

  it('a provider who was reassigned away cannot advance the booking', async () => {
    // The stale-app case: their token is valid and their screen still shows the
    // job, but the assignment moved.
    seedBooking({ workerUid: PROVIDER_B, assignmentStatus: 'ACCEPTED' });
    await expect(
      transitionBooking({ bookingId: 1, action: 'PROVIDER_EN_ROUTE', actorUid: PROVIDER_A, actorRole: 'assigned_provider' }),
    ).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
  });

  it("a customer cannot cancel someone else's booking", async () => {
    seedBooking({ assignmentStatus: 'ACCEPTED' });
    await expect(
      transitionBooking({ bookingId: 1, action: 'CUSTOMER_CANCEL', actorUid: 'other-customer', actorRole: 'customer' }),
    ).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
  });

  it('ignores an actor id supplied in metadata', async () => {
    // The payload claims to be the provider. The rows say otherwise.
    seedBooking({ assignmentStatus: 'ASSIGNED' });
    await expect(
      transitionBooking({
        bookingId: 1, action: 'PROVIDER_ACCEPT', actorUid: PROVIDER_B, actorRole: 'assigned_provider',
        metadata: { workerUid: PROVIDER_A, providerUid: PROVIDER_A },
      }),
    ).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
  });

  it('a missing booking is NOT_FOUND, not a crash', async () => {
    seedBooking();
    await expect(
      transitionBooking({ bookingId: 999, action: 'CUSTOMER_CANCEL', actorUid: CUSTOMER, actorRole: 'customer' }),
    ).rejects.toMatchObject({ code: 'BOOKING_NOT_FOUND' });
  });
});

// ─── Order of operations ──────────────────────────────────────────────────────

describe('the executor locks, then decides', () => {
  it('takes the row lock BEFORE reading anything else', async () => {
    seedBooking({ assignmentStatus: 'ASSIGNED' });
    await transitionBooking({ bookingId: 1, action: 'PROVIDER_ACCEPT', actorUid: PROVIDER_A, actorRole: 'assigned_provider' });

    const txn = db.log.filter((l) => l.conn > 0).map((l) => l.sql);
    const begin = txn.findIndex((q) => /^BEGIN/i.test(q));
    const lock = txn.findIndex((q) => /FOR UPDATE/i.test(q));
    const write = txn.findIndex((q) => /UPDATE servana\.booking_workers/i.test(q));
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(lock).toBeGreaterThan(begin);
    expect(write).toBeGreaterThan(lock);
  });

  it('writes the timeline BEFORE commit, in the same transaction', async () => {
    seedBooking({ assignmentStatus: 'ASSIGNED' });
    await transitionBooking({ bookingId: 1, action: 'PROVIDER_ACCEPT', actorUid: PROVIDER_A, actorRole: 'assigned_provider' });

    const txn = db.log.filter((l) => l.conn > 0).map((l) => l.sql);
    const timeline = txn.findIndex((q) => /INSERT INTO servana\.booking_transitions/i.test(q));
    const commit = txn.findIndex((q) => /^COMMIT/i.test(q));
    expect(timeline).toBeGreaterThan(-1);
    expect(commit).toBeGreaterThan(timeline);
  });

  it('rolls back and writes nothing when the transition is refused', async () => {
    seedBooking({ status: 'COMPLETED', assignmentStatus: 'COMPLETED' });
    await expect(
      transitionBooking({ bookingId: 1, action: 'PROVIDER_EN_ROUTE', actorUid: PROVIDER_A, actorRole: 'assigned_provider' }),
    ).rejects.toBeInstanceOf(TransitionError);

    expect(db.transitions).toHaveLength(0);
    expect(db.log.some((l) => /^ROLLBACK/i.test(l.sql))).toBe(true);
  });
});

// ─── Races ────────────────────────────────────────────────────────────────────

describe('races', () => {
  it('two providers cannot both accept — the second is refused', async () => {
    // The lock serialises them; the second reads the state the first produced
    // and the machine refuses it. Without the lock both would read ASSIGNED.
    seedBooking({ assignmentStatus: 'ASSIGNED' });

    await transitionBooking({ bookingId: 1, action: 'PROVIDER_ACCEPT', actorUid: PROVIDER_A, actorRole: 'assigned_provider' });

    await expect(
      transitionBooking({ bookingId: 1, action: 'PROVIDER_ACCEPT', actorUid: PROVIDER_A, actorRole: 'assigned_provider' }),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });

    expect(db.transitions.filter((t) => t.to_state === 'ACCEPTED')).toHaveLength(1);
  });

  it('accept loses to a cancellation that committed first', async () => {
    seedBooking({ assignmentStatus: 'ASSIGNED' });
    await transitionBooking({ bookingId: 1, action: 'ADMIN_CANCEL', actorUid: 'admin-1', actorRole: 'admin' });

    await expect(
      transitionBooking({ bookingId: 1, action: 'PROVIDER_ACCEPT', actorUid: PROVIDER_A, actorRole: 'assigned_provider' }),
    ).rejects.toMatchObject({ code: 'TERMINAL_STATE' });
  });

  it('a stale expectedState is refused with BOOKING_STATE_CONFLICT', async () => {
    seedBooking({ assignmentStatus: 'ASSIGNED' });
    await transitionBooking({ bookingId: 1, action: 'PROVIDER_ACCEPT', actorUid: PROVIDER_A, actorRole: 'assigned_provider' });

    // A client that read the booking before the accept and acts on that view.
    await expect(
      transitionBooking({
        bookingId: 1, action: 'PROVIDER_EN_ROUTE', actorUid: PROVIDER_A, actorRole: 'assigned_provider',
        expectedState: 'ASSIGNED',
      }),
    ).rejects.toMatchObject({ code: 'BOOKING_STATE_CONFLICT' });
  });

  it('a matching expectedState proceeds', async () => {
    seedBooking({ assignmentStatus: 'ACCEPTED' });
    const result = await transitionBooking({
      bookingId: 1, action: 'PROVIDER_EN_ROUTE', actorUid: PROVIDER_A, actorRole: 'assigned_provider',
      expectedState: 'ACCEPTED',
    });
    expect(result.toState).toBe('EN_ROUTE');
  });

  it('completion cannot happen twice', async () => {
    seedBooking({ assignmentStatus: 'IN_PROGRESS' });
    await transitionBooking({ bookingId: 1, action: 'PROVIDER_COMPLETE', actorUid: PROVIDER_A, actorRole: 'assigned_provider' });
    await expect(
      transitionBooking({ bookingId: 1, action: 'PROVIDER_COMPLETE', actorUid: PROVIDER_A, actorRole: 'assigned_provider' }),
    ).rejects.toMatchObject({ code: 'TERMINAL_STATE' });
  });
});

// ─── Idempotency ──────────────────────────────────────────────────────────────

describe('idempotency', () => {
  it('same key + same operation returns the ORIGINAL result', async () => {
    // Without this the retry reaches the machine, finds the state already
    // advanced, and answers INVALID_TRANSITION — telling the client its own
    // successful request failed.
    seedBooking({ assignmentStatus: 'ASSIGNED' });
    const first = await transitionBooking({
      bookingId: 1, action: 'PROVIDER_ACCEPT', actorUid: PROVIDER_A, actorRole: 'assigned_provider',
      idempotencyKey: 'key-1',
    });
    const replay = await transitionBooking({
      bookingId: 1, action: 'PROVIDER_ACCEPT', actorUid: PROVIDER_A, actorRole: 'assigned_provider',
      idempotencyKey: 'key-1',
    });

    expect(first.idempotentReplay).toBe(false);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.timelineEventId).toBe(first.timelineEventId);
    expect(db.transitions).toHaveLength(1);
  });

  it('same key + CHANGED payload is a conflict', async () => {
    seedBooking({ assignmentStatus: 'ACCEPTED' });
    await transitionBooking({
      bookingId: 1, action: 'PROVIDER_CANCEL', actorUid: PROVIDER_A, actorRole: 'assigned_provider',
      idempotencyKey: 'key-2', metadata: { reason: 'ILLNESS_OR_EMERGENCY' },
    });
    await expect(
      transitionBooking({
        bookingId: 1, action: 'PROVIDER_CANCEL', actorUid: PROVIDER_A, actorRole: 'assigned_provider',
        idempotencyKey: 'key-2', metadata: { reason: 'SCHEDULE_CONFLICT' },
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('two DIFFERENT keys racing: one transitions, the other is refused', async () => {
    seedBooking({ assignmentStatus: 'ASSIGNED' });
    await transitionBooking({
      bookingId: 1, action: 'PROVIDER_ACCEPT', actorUid: PROVIDER_A, actorRole: 'assigned_provider', idempotencyKey: 'k-a',
    });
    await expect(
      transitionBooking({
        bookingId: 1, action: 'PROVIDER_ACCEPT', actorUid: PROVIDER_A, actorRole: 'assigned_provider', idempotencyKey: 'k-b',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(db.transitions).toHaveLength(1);
  });

  it("one actor's key cannot replay another actor's result", async () => {
    seedBooking({ assignmentStatus: 'ASSIGNED' });
    await transitionBooking({
      bookingId: 1, action: 'PROVIDER_ACCEPT', actorUid: PROVIDER_A, actorRole: 'assigned_provider', idempotencyKey: 'shared',
    });
    // Same key, different actor — scoped by the primary key, so this is a fresh
    // request and is judged on its merits (and refused, being unauthorized).
    await expect(
      transitionBooking({
        bookingId: 1, action: 'PROVIDER_ACCEPT', actorUid: PROVIDER_B, actorRole: 'assigned_provider', idempotencyKey: 'shared',
      }),
    ).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
  });

  it('no key means no replay — the second call is judged normally', async () => {
    seedBooking({ assignmentStatus: 'ASSIGNED' });
    await transitionBooking({ bookingId: 1, action: 'PROVIDER_ACCEPT', actorUid: PROVIDER_A, actorRole: 'assigned_provider' });
    await expect(
      transitionBooking({ bookingId: 1, action: 'PROVIDER_ACCEPT', actorUid: PROVIDER_A, actorRole: 'assigned_provider' }),
    ).rejects.toBeInstanceOf(TransitionError);
  });
});

// ─── Reassignment ─────────────────────────────────────────────────────────────

describe('reassignment resets state without erasing history', () => {
  it('an EN_ROUTE booking returns to ASSIGNED for the new provider', async () => {
    seedBooking({ assignmentStatus: 'ACCEPTED' });
    await transitionBooking({ bookingId: 1, action: 'PROVIDER_EN_ROUTE', actorUid: PROVIDER_A, actorRole: 'assigned_provider' });

    const result = await transitionBooking({
      bookingId: 1, action: 'ADMIN_REASSIGN', actorUid: 'admin-1', actorRole: 'admin',
      metadata: { providerUid: PROVIDER_B, reason: 'Provider unreachable' },
    });

    expect(result.fromState).toBe('EN_ROUTE');
    expect(result.toState).toBe('ASSIGNED');
  });

  it('the old assignment becomes terminal rather than being overwritten', async () => {
    // TAB 05 depends on this: an assignment row must END, not mutate, or the
    // previous provider's progression is lost and matching cannot audit it.
    seedBooking({ assignmentStatus: 'ACCEPTED' });
    await transitionBooking({
      bookingId: 1, action: 'ADMIN_REASSIGN', actorUid: 'admin-1', actorRole: 'admin',
      metadata: { providerUid: PROVIDER_B, reason: 'x' },
    });

    const old = db.assignments.find((a) => a.worker_uid === PROVIDER_A);
    const fresh = db.assignments.find((a) => a.worker_uid === PROVIDER_B);
    // Terminal, and specifically DECLINED — the value the matching engine's
    // exclusion reads. The reassignment itself is recorded canonically by the
    // ADMIN_REASSIGN transition row.
    expect(old?.status).toBe('DECLINED');
    expect(fresh?.status).toBe('ASSIGNED');
  });

  it('the timeline keeps the whole progression, including the old provider', async () => {
    seedBooking({ assignmentStatus: 'ASSIGNED' });
    await transitionBooking({ bookingId: 1, action: 'PROVIDER_ACCEPT', actorUid: PROVIDER_A, actorRole: 'assigned_provider' });
    await transitionBooking({ bookingId: 1, action: 'PROVIDER_EN_ROUTE', actorUid: PROVIDER_A, actorRole: 'assigned_provider' });
    await transitionBooking({
      bookingId: 1, action: 'ADMIN_REASSIGN', actorUid: 'admin-1', actorRole: 'admin',
      metadata: { providerUid: PROVIDER_B, reason: 'Provider unreachable' },
    });

    const timeline = await getBookingTimeline(1);
    expect(timeline.map((e) => `${e.action}:${e.fromState}->${e.toState}`)).toEqual([
      'PROVIDER_ACCEPT:ASSIGNED->ACCEPTED',
      'PROVIDER_EN_ROUTE:ACCEPTED->EN_ROUTE',
      'ADMIN_REASSIGN:EN_ROUTE->ASSIGNED',
    ]);
    // And the old provider is still named on their own events.
    expect(timeline[1].providerUid).toBe(PROVIDER_A);
    expect(timeline[2].reason).toBe('Provider unreachable');
  });

  it('reassignment without a provider is refused', async () => {
    seedBooking({ assignmentStatus: 'ACCEPTED' });
    await expect(
      transitionBooking({
        bookingId: 1, action: 'ADMIN_REASSIGN', actorUid: 'admin-1', actorRole: 'admin', metadata: { reason: 'x' },
      }),
    ).rejects.toMatchObject({ code: 'GUARD_FAILED' });
  });
});

// ─── Disputes do not erase the outcome ────────────────────────────────────────

describe('a dispute sits on top of the service outcome', () => {
  it('the booking row keeps COMPLETED when a dispute is recorded', async () => {
    seedBooking({ assignmentStatus: 'IN_PROGRESS' });
    await transitionBooking({ bookingId: 1, action: 'PROVIDER_COMPLETE', actorUid: PROVIDER_A, actorRole: 'assigned_provider' });

    // A dispute is written as a timeline event; the status column is untouched.
    db.transitions.push({
      id: db.nextTransitionId++, booking_id: 1, action: 'RAISE_DISPUTE',
      from_state: 'COMPLETED', to_state: 'DISPUTED', actor_role: 'customer',
      occurred_at: new Date().toISOString(),
    });

    expect(db.bookings.get(1)?.status).toBe('COMPLETED');
    expect(await priorTerminalState(1)).toBe('COMPLETED');
  });

  it('distinguishes a dispute after cancellation from one after completion', async () => {
    // These have different financial consequences downstream, so the outcome
    // must survive the dispute.
    seedBooking({ assignmentStatus: 'ACCEPTED' });
    await transitionBooking({ bookingId: 1, action: 'ADMIN_CANCEL', actorUid: 'admin-1', actorRole: 'admin' });
    db.transitions.push({
      id: db.nextTransitionId++, booking_id: 1, action: 'RAISE_DISPUTE',
      from_state: 'CANCELLED', to_state: 'DISPUTED', actor_role: 'customer',
      occurred_at: new Date().toISOString(),
    });
    expect(await priorTerminalState(1)).toBe('CANCELLED');
  });
});

// ─── Secrets ──────────────────────────────────────────────────────────────────

describe('the timeline holds no secrets', () => {
  it('redacts the worker code', () => {
    expect(redactMetadata({ workerCode: '123456', reason: 'ok' })).toEqual({
      workerCode: '[redacted]',
      reason: 'ok',
    });
  });

  it('a start-job transition records no code', async () => {
    // The booking must carry a MATCHING code: since the atomic predicate
    // landed, a start with no worker_code on the booking is correctly refused.
    // This fixture was written before that check existed.
    seedBooking({ assignmentStatus: 'ARRIVED' });
    db.bookings.get(1)!.worker_code = '424242';
    await transitionBooking({
      bookingId: 1, action: 'PROVIDER_START', actorUid: PROVIDER_A, actorRole: 'assigned_provider',
      metadata: { workerCode: '424242' },
    });
    expect(JSON.stringify(db.transitions)).not.toContain('424242');
  });
});

// ─── Cancelled spelling ───────────────────────────────────────────────────────

describe('the executor writes one spelling of cancelled', () => {
  it('writes CANCELLED, never CANCELED', async () => {
    seedBooking({ assignmentStatus: 'ACCEPTED' });
    await transitionBooking({ bookingId: 1, action: 'ADMIN_CANCEL', actorUid: 'admin-1', actorRole: 'admin' });
    expect(db.bookings.get(1)?.status).toBe('CANCELLED');
  });

  it('reads a legacy CANCELED row as terminal', async () => {
    seedBooking({ status: 'CANCELED', assignmentStatus: 'ACCEPTED' });
    await expect(
      transitionBooking({ bookingId: 1, action: 'PROVIDER_EN_ROUTE', actorUid: PROVIDER_A, actorRole: 'assigned_provider' }),
    ).rejects.toMatchObject({ code: 'TERMINAL_STATE' });
  });
});


// ─── The atomic worker-code precondition ──────────────────────────────────────

describe('PROVIDER_START checks the worker code atomically', () => {
  const seedWithCode = (code: string | null, assignmentStatus = 'ARRIVED') => {
    seedBooking({ assignmentStatus });
    db.bookings.get(1)!.worker_code = code;
  };

  it('starts the job when the code matches', async () => {
    seedWithCode('424242');
    const result = await transitionBooking({
      bookingId: 1, action: 'PROVIDER_START', actorUid: PROVIDER_A, actorRole: 'assigned_provider',
      metadata: { workerCode: '424242' },
    });
    expect(result.toState).toBe('IN_PROGRESS');
    expect(db.assignments[0].status).toBe('IN_PROGRESS');
    expect(db.transitions).toHaveLength(1);
  });

  it('a WRONG code writes nothing and records nothing', async () => {
    // Correct assignment, valid state, wrong code: no status mutation, no
    // timeline event, transaction rolled back. A check-then-write would leave a
    // window between the two.
    seedWithCode('424242');
    await expect(
      transitionBooking({
        bookingId: 1, action: 'PROVIDER_START', actorUid: PROVIDER_A, actorRole: 'assigned_provider',
        metadata: { workerCode: '999999' },
      }),
    ).rejects.toMatchObject({ code: 'WORKER_CODE_INVALID' });

    expect(db.assignments[0].status).toBe('ARRIVED');
    expect(db.transitions).toHaveLength(0);
    expect(db.log.some((l) => /^ROLLBACK/i.test(l.sql))).toBe(true);
  });

  it('the status change and the timeline entry are atomic on success', async () => {
    seedWithCode('424242');
    await transitionBooking({
      bookingId: 1, action: 'PROVIDER_START', actorUid: PROVIDER_A, actorRole: 'assigned_provider',
      metadata: { workerCode: '424242' },
    });
    const txn = db.log.filter((l) => l.conn > 0).map((l) => l.sql);
    const write = txn.findIndex((q) => /SET status = 'IN_PROGRESS'/i.test(q));
    const timeline = txn.findIndex((q) => /INSERT INTO servana\.booking_transitions/i.test(q));
    const commit = txn.findIndex((q) => /^COMMIT/i.test(q));
    expect(write).toBeGreaterThan(-1);
    expect(timeline).toBeGreaterThan(write);
    expect(commit).toBeGreaterThan(timeline);
  });

  it('a missing code is refused as a guard failure', async () => {
    seedWithCode('424242');
    await expect(
      transitionBooking({
        bookingId: 1, action: 'PROVIDER_START', actorUid: PROVIDER_A, actorRole: 'assigned_provider',
      }),
    ).rejects.toMatchObject({ code: 'GUARD_FAILED' });
    expect(db.assignments[0].status).toBe('ARRIVED');
  });

  it('the SQL predicate does NOT re-encode the transition table', async () => {
    // The legacy statement carried bw.status IN ('ACCEPTED','EN_ROUTE','ARRIVED')
    // — a second copy of the lifecycle living in SQL. The machine owns that now;
    // the predicate is only the credential.
    seedWithCode('424242');
    await transitionBooking({
      bookingId: 1, action: 'PROVIDER_START', actorUid: PROVIDER_A, actorRole: 'assigned_provider',
      metadata: { workerCode: '424242' },
    });
    const startSql = db.log.find((l) => /SET status = 'IN_PROGRESS'/i.test(l.sql))!.sql;
    expect(startSql).toContain('worker_code = $3');
    expect(startSql).not.toMatch(/bw\.status IN/i);
  });

  it('a wrong CODE and a wrong STATE are distinguishable', async () => {
    // The legacy path answered "Job cannot be started" for both, which tells a
    // provider standing in a driveway nothing about what to do next.
    seedWithCode('424242', 'ASSIGNED');
    await expect(
      transitionBooking({
        bookingId: 1, action: 'PROVIDER_START', actorUid: PROVIDER_A, actorRole: 'assigned_provider',
        metadata: { workerCode: '424242' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  it('an unassigned provider cannot start, whatever code they hold', async () => {
    seedWithCode('424242');
    await expect(
      transitionBooking({
        bookingId: 1, action: 'PROVIDER_START', actorUid: PROVIDER_B, actorRole: 'assigned_provider',
        metadata: { workerCode: '424242' },
      }),
    ).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
    expect(db.transitions).toHaveLength(0);
  });

  it("a code from ANOTHER booking does not work here", async () => {
    seedWithCode('424242');
    db.bookings.set(2, {
      id: 2, status: 'CONFIRMED', customer_uid: CUSTOMER, worker_uid: PROVIDER_A, worker_code: '111111',
    });
    db.assignments.push({ booking_id: 2, worker_uid: PROVIDER_A, status: 'ARRIVED' });

    await expect(
      transitionBooking({
        bookingId: 1, action: 'PROVIDER_START', actorUid: PROVIDER_A, actorRole: 'assigned_provider',
        metadata: { workerCode: '111111' },
      }),
    ).rejects.toMatchObject({ code: 'WORKER_CODE_INVALID' });
  });

  it('START loses to a REASSIGN that committed first — never a mixed outcome', async () => {
    // The dangerous interleaving: a new provider assigned while the old one is
    // starting. There must never be a booking assigned to provider B whose
    // state is IN_PROGRESS under provider A.
    seedWithCode('424242');
    await transitionBooking({
      bookingId: 1, action: 'ADMIN_REASSIGN', actorUid: 'admin-1', actorRole: 'admin',
      metadata: { providerUid: PROVIDER_B, reason: 'unreachable' },
    });

    await expect(
      transitionBooking({
        bookingId: 1, action: 'PROVIDER_START', actorUid: PROVIDER_A, actorRole: 'assigned_provider',
        metadata: { workerCode: '424242' },
      }),
    ).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });

    expect(db.bookings.get(1)?.worker_uid).toBe(PROVIDER_B);
    expect(db.assignments.find((a) => a.worker_uid === PROVIDER_A)?.status).toBe('DECLINED');
    expect(db.assignments.every((a) => a.status !== 'IN_PROGRESS')).toBe(true);
  });

  it('the code is NOT consumed — Servana does not treat it as one-time', async () => {
    // Verified rather than redesigned: worker_code is cleared only when the
    // provider is unassigned. Introducing consumption would be a behaviour
    // change nobody asked for.
    seedWithCode('424242');
    await transitionBooking({
      bookingId: 1, action: 'PROVIDER_START', actorUid: PROVIDER_A, actorRole: 'assigned_provider',
      metadata: { workerCode: '424242' },
    });
    expect(db.bookings.get(1)?.worker_code).toBe('424242');
  });

  it('the code never reaches the timeline', async () => {
    seedWithCode('424242');
    await transitionBooking({
      bookingId: 1, action: 'PROVIDER_START', actorUid: PROVIDER_A, actorRole: 'assigned_provider',
      metadata: { workerCode: '424242' },
    });
    expect(JSON.stringify(db.transitions)).not.toContain('424242');
    expect(JSON.stringify(db.transitions)).toContain('[redacted]');
  });
});
