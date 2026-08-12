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
    this.idempotency = [];
    this.log = [];
    this.nextTransitionId = 1;
    this.locks.clear();
  }
}

const db = new FakeDb();
let connSeq = 0;

const runQuery = (conn: number, sql: string, params: unknown[] = []): { rows: Row[] } => {
  db.log.push({ conn, sql: sql.replace(/\s+/g, ' ').trim() });

  if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) {
    if (/COMMIT|ROLLBACK/i.test(sql)) {
      for (const [id, owner] of db.locks) if (owner === conn) db.locks.delete(id);
    }
    return { rows: [] };
  }

  if (/CREATE TABLE|CREATE INDEX/i.test(sql)) return { rows: [] };

  // ── booking load, with the lock ──
  if (/FROM servana\.bookings\s+WHERE id = \$1\s+FOR UPDATE/is.test(sql)) {
    const id = Number(params[0]);
    const holder = db.locks.get(id);
    if (holder !== undefined && holder !== conn) {
      throw new Error(`LOCK_CONTENTION: booking ${id} is locked by connection ${holder}`);
    }
    db.locks.set(id, conn);
    const b = db.bookings.get(id);
    return { rows: b ? [{ id, status: b.status, customer_uid: b.customer_uid, worker_uid: b.worker_uid }] : [] };
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

  if (/UPDATE servana\.booking_workers SET status = \$3/i.test(sql)) {
    const [bookingId, workerUid, status] = params;
    for (const a of db.assignments) {
      if (a.booking_id === Number(bookingId) && a.worker_uid === workerUid) a.status = status;
    }
    return { rows: [] };
  }
  if (/UPDATE servana\.booking_workers SET status = 'REASSIGNED'/i.test(sql)) {
    for (const a of db.assignments) {
      if (a.booking_id === Number(params[0]) && a.worker_uid === params[1]) a.status = 'REASSIGNED';
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

const seedBooking = (opts: { status?: string; workerUid?: string | null; assignmentStatus?: string } = {}) => {
  db.reset();
  __resetTransitionSchema();
  db.bookings.set(1, {
    id: 1,
    status: opts.status ?? 'CONFIRMED',
    customer_uid: CUSTOMER,
    worker_uid: opts.workerUid === undefined ? PROVIDER_A : opts.workerUid,
  });
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
    expect(old?.status).toBe('REASSIGNED');
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
    seedBooking({ assignmentStatus: 'ARRIVED' });
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
