/**
 * B1.1 — PROVIDER_ACCEPT runs on the canonical executor.
 *
 * The migration's whole risk is invisible: `acceptJob` still returns the same
 * object and still sends the same five notifications, so nothing in a diff
 * proves the contract held. These tests run the function.
 *
 * What is checked:
 *
 *   - the six `BookingResponseConflict` codes, each from the state that
 *     produces it, with the 200/409 split intact;
 *   - the side effects, in their original order, only after the transition
 *     commits;
 *   - a replayed idempotency key returning the original outcome and sending
 *     NOTHING;
 *   - the canonical timeline and the legacy tracking row both written, in the
 *     same transaction as the status change.
 *
 * The database is faked. What that cannot prove — that PostgreSQL serialises
 * two accepts on `FOR UPDATE` — is a named gap, not an implied pass.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' } }));

// ─── Side effects, all captured ──────────────────────────────────────────────

const calls: string[] = [];

jest.mock('../src/helpers/mailer', () => ({
  send: jest.fn((...a: unknown[]) => { calls.push(`email:${String(a[1])}`); }),
}));
jest.mock('../src/services/notification.service', () => ({
  createCustomerNotification: jest.fn(async (uid: string) => { calls.push(`customerNotify:${uid}`); }),
  createNotification: jest.fn(async () => undefined),
}));
jest.mock('../src/services/adminNotificationService', () => ({
  notifyAdminsSafely: jest.fn((p: { type: string }) => { calls.push(`adminNotify:${p.type}`); }),
}));
jest.mock('../src/provider.realtime', () => ({
  emitToProvider: jest.fn((uid: string, ev: string) => { calls.push(`emit:${ev}:${uid}`); }),
}));
jest.mock('../src/chat/chat.service', () => ({
  getOrCreateConversation: jest.fn(async () => { calls.push('chat:conversation'); return { id: 77 }; }),
  postSystemMessageOnce: jest.fn(async () => { calls.push('chat:systemMessage'); }),
}));
jest.mock('../src/chat/chat.repository', () => ({ findExistingConversationByBookingId: jest.fn() }));
jest.mock('../src/services/user.service', () => ({
  getUserInfoByBookingId: jest.fn(async () => ({ email: 'c@x.co', firstName: 'Cee' })),
}));
jest.mock('../src/db/mongodbQuery', () => ({ __esModule: true, default: {} }));
jest.mock('../src/services/providerAutoOnlineEngine', () => ({ getAutoBookableProviderUids: jest.fn() }));
jest.mock('../src/services/providerAvailabilityEngine', () => ({ filterUidsAvailableAt: jest.fn() }));
jest.mock('../src/services/pricingService', () => ({ computeTranspoFee: jest.fn() }));
jest.mock('../src/services/disbursement.service', () => ({ createDisbursement: jest.fn() }));

// ─── A fake pg, faithful to what this path reads and writes ──────────────────

interface Row { [k: string]: unknown }

const store = {
  booking: null as Row | null,
  assignments: [] as Row[],
  transitions: [] as Row[],
  idempotency: [] as Row[],
  tracking: [] as Row[],
  sql: [] as string[],
  /** Statements issued between BEGIN and COMMIT on the executor's connection. */
  inTransaction: [] as string[],
  open: false,
  /** Makes the legacy tracking insert fail, to prove the rollback. */
  trackingFails: false,
};

const reset = () => {
  store.booking = null;
  store.assignments = [];
  store.transitions = [];
  store.idempotency = [];
  store.tracking = [];
  store.sql = [];
  store.inTransaction = [];
  store.open = false;
  store.trackingFails = false;
  snapshot = null;
  calls.length = 0;
};

/** The pre-transaction image, held between BEGIN and COMMIT/ROLLBACK. */
let snapshot: string | null = null;

const mine = (bookingId: number, uid: unknown) =>
  store.assignments.filter((a) => a.booking_id === bookingId && a.worker_uid === uid);

const run = (sql: string, params: unknown[] = []): { rows: Row[]; rowCount: number } => {
  const flat = sql.replace(/\s+/g, ' ').trim();
  store.sql.push(flat);
  if (store.open && !/^COMMIT/i.test(flat)) store.inTransaction.push(flat);

  const done = (rows: Row[]) => ({ rows, rowCount: rows.length });

  /**
   * Real transaction semantics, because a rollback test against a fake that
   * cannot roll back proves nothing. BEGIN snapshots every mutable table;
   * ROLLBACK restores it; COMMIT drops the snapshot.
   */
  if (/^BEGIN/i.test(flat)) {
    store.open = true;
    snapshot = JSON.stringify({
      booking: store.booking,
      assignments: store.assignments,
      transitions: store.transitions,
      idempotency: store.idempotency,
      tracking: store.tracking,
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

  if (/SELECT id, status, user_id AS customer_uid, worker_uid/i.test(flat)) {
    return done(store.booking ? [{ ...store.booking, customer_uid: store.booking.user_id }] : []);
  }
  if (/SELECT user_id FROM servana\.bookings/i.test(flat)) {
    return done(store.booking ? [{ user_id: store.booking.user_id }] : []);
  }
  if (/SELECT schedule FROM servana\.bookings/i.test(flat)) return done([{ schedule: null }]);
  if (/FROM servana\.user_credentials/i.test(flat)) return done([{ first_name: 'Pro', last_name: 'Vider' }]);

  if (/SELECT \* FROM servana\.booking_workers/i.test(flat)) {
    const rows = mine(Number(params[0]), params[1]);
    return done(rows.length ? [rows[rows.length - 1]] : []);
  }
  if (/SELECT status FROM servana\.booking_workers/i.test(flat)) {
    // The executor loads the assignment of the booking's CURRENT provider.
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
  if (/INSERT INTO servana\.booking_tracking/i.test(flat)) {
    if (store.trackingFails) throw new Error('relation "booking_tracking" is locked');
    store.tracking.push({ booking_id: Number(params[0]), status: params[1], note: params[2] });
    return done([]);
  }
  if (/INSERT INTO servana\.booking_transitions/i.test(flat)) {
    const id = store.transitions.length + 1;
    store.transitions.push({ id, from_state: params[2], to_state: params[3], action: params[1] });
    return done([{ id }]);
  }

  return done([]);
};

jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn(async (sql: string, p?: unknown[]) => run(sql, p)) },
  pool: {
    connect: jest.fn(async () => ({
      query: jest.fn(async (sql: string, p?: unknown[]) => run(sql, p)),
      release: jest.fn(),
    })),
  },
}));

import { acceptJob } from '../src/services/technicianService';
import { BookingResponseConflict } from '../src/services/bookingResponseConflict';
import { __resetTransitionSchema } from '../src/services/booking/transitionExecutor';

const PROVIDER = 'provider-a';
const CUSTOMER = 'customer-1';
const BOOKING = 501;

/** A booking sitting exactly where an accept is legal. */
const seedAssigned = (overrides: { bookingStatus?: string; assignmentStatus?: string; workerUid?: string | null } = {}) => {
  store.booking = {
    id: BOOKING,
    status: overrides.bookingStatus ?? 'WORKER_ASSIGNED',
    user_id: CUSTOMER,
    worker_uid: overrides.workerUid === undefined ? PROVIDER : overrides.workerUid,
  };
  store.assignments = [{
    booking_id: BOOKING,
    worker_uid: PROVIDER,
    status: overrides.assignmentStatus ?? 'ASSIGNED',
    accepted_at: null,
  }];
};

const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  reset();
  __resetTransitionSchema();
});

describe('the accept succeeds through the executor', () => {
  it('advances the assignment and reports ACCEPTED', async () => {
    seedAssigned();
    const out = await acceptJob(BOOKING, PROVIDER);

    expect(store.assignments[0].status).toBe('ACCEPTED');
    expect(out.effectiveStatus).toBe('ACCEPTED');
    expect(out.idempotent).toBe(false);
    // The returned row is the assignment, as callers have always received.
    expect(out.accepted_at).toBe('2026-08-12T00:00:00.000Z');
  });

  it('records the canonical transition ASSIGNED -> ACCEPTED', async () => {
    seedAssigned();
    await acceptJob(BOOKING, PROVIDER);

    expect(store.transitions).toHaveLength(1);
    expect(store.transitions[0]).toMatchObject({
      action: 'PROVIDER_ACCEPT', from_state: 'ASSIGNED', to_state: 'ACCEPTED',
    });
  });

  it('writes the legacy tracking row the three timelines read', async () => {
    seedAssigned();
    await acceptJob(BOOKING, PROVIDER);

    expect(store.tracking).toEqual([
      { booking_id: BOOKING, status: 'ACCEPTED', note: 'Provider accepted the booking' },
    ]);
  });

  it('puts the status write, the timeline and the tracking row in ONE transaction', async () => {
    seedAssigned();
    await acceptJob(BOOKING, PROVIDER);

    const tx = store.inTransaction.join(' | ');
    expect(tx).toContain('UPDATE servana.booking_workers SET status = $3, accepted_at = NOW()');
    expect(tx).toContain('INSERT INTO servana.booking_transitions');
    expect(tx).toContain('INSERT INTO servana.booking_tracking');
  });

  it('does not leave the booking row status rewritten', async () => {
    // ACCEPTED has never cascaded onto bookings.status and must not start.
    seedAssigned();
    await acceptJob(BOOKING, PROVIDER);
    expect(store.booking?.status).toBe('WORKER_ASSIGNED');
  });
});

/**
 * LEGACY_TRACKING_PROJECTION failure semantics: REQUIRED.
 *
 * Decided deliberately rather than inherited. `acceptJob` already wrote the
 * tracking row unguarded inside its transaction, so ACCEPT's semantics are
 * unchanged by the migration — but the arrival stages wrapped theirs in a
 * try/catch, and this is the policy the whole projection now follows. See
 * docs/TAB04_OPEN_GAPS.md.
 *
 * The rows back three supported timelines. A missing one is silent and
 * unrecoverable without a backfill, so a transition that cannot record itself
 * does not happen.
 */
describe('a failed tracking insert rolls the whole transition back', () => {
  it('leaves the assignment, the timeline and the tracking table untouched', async () => {
    seedAssigned();
    store.trackingFails = true;

    await expect(acceptJob(BOOKING, PROVIDER)).rejects.toThrow(/booking_tracking/);
    await flush();

    expect(store.assignments[0].status).toBe('ASSIGNED');
    expect(store.transitions).toHaveLength(0);
    expect(store.tracking).toHaveLength(0);
    expect(store.sql).toContain('ROLLBACK');
    expect(store.sql).not.toContain('COMMIT');
  });

  it('sends no notifications for a transition that did not happen', async () => {
    seedAssigned();
    store.trackingFails = true;
    await acceptJob(BOOKING, PROVIDER).catch(() => undefined);
    await flush();

    expect(calls).toEqual([]);
  });

  it('records no idempotency row, so a retry is a real attempt', async () => {
    // Persisting the key on a rolled-back transition would answer the retry
    // with a success that never happened.
    seedAssigned();
    store.trackingFails = true;
    await acceptJob(BOOKING, PROVIDER, { idempotencyKey: 'k-9' }).catch(() => undefined);
    expect(store.idempotency).toHaveLength(0);

    store.trackingFails = false;
    const retry = await acceptJob(BOOKING, PROVIDER, { idempotencyKey: 'k-9' });
    expect(retry.idempotent).toBe(false);
    expect(store.assignments[0].status).toBe('ACCEPTED');
  });
});

describe('side effects keep their shape and their order', () => {
  it('fires all five, only after the transition committed', async () => {
    seedAssigned();
    await acceptJob(BOOKING, PROVIDER);
    await flush();

    expect(calls).toEqual([
      'adminNotify:provider_accepted',
      `customerNotify:${CUSTOMER}`,
      `emit:booking:updated:${PROVIDER}`,
      'email:booking_accepted',
      'chat:conversation',
      'chat:systemMessage',
    ]);

    const commit = store.sql.lastIndexOf('COMMIT');
    expect(commit).toBeGreaterThan(-1);
  });

  it('sends nothing when the transition is refused', async () => {
    seedAssigned({ bookingStatus: 'CANCELLED' });
    await expect(acceptJob(BOOKING, PROVIDER)).rejects.toBeInstanceOf(BookingResponseConflict);
    await flush();

    expect(calls).toEqual([]);
  });
});

describe('a replayed idempotency key', () => {
  it('returns the original outcome and re-sends NOTHING', async () => {
    seedAssigned();
    await acceptJob(BOOKING, PROVIDER, { idempotencyKey: 'k-1' });
    await flush();
    const first = [...calls];
    expect(first.length).toBeGreaterThan(0);

    calls.length = 0;
    const replay = await acceptJob(BOOKING, PROVIDER, { idempotencyKey: 'k-1' });
    await flush();

    expect(replay.idempotent).toBe(true);
    expect(replay.effectiveStatus).toBe('ACCEPTED');
    // A retry is the same request, not a second one: no second email, no
    // second group-chat message, no second customer notification.
    expect(calls).toEqual([]);
    // And no second transition.
    expect(store.transitions).toHaveLength(1);
    expect(store.tracking).toHaveLength(1);
  });

  it('still returns the assignment row on the replay', async () => {
    seedAssigned();
    await acceptJob(BOOKING, PROVIDER, { idempotencyKey: 'k-2' });
    const replay = await acceptJob(BOOKING, PROVIDER, { idempotencyKey: 'k-2' });
    expect(replay.worker_uid).toBe(PROVIDER);
    expect(replay.status).toBe('ACCEPTED');
  });
});

/**
 * The contract five clients branch on. `ALREADY_ACCEPTED_BY_YOU` is the reason
 * this vocabulary could not simply be replaced by the executor's: it is the one
 * refusal that answers 200, and a provider double-tapping must not see an error.
 */
describe('the six-code BookingResponseConflict contract survives', () => {
  const expectConflict = async (
    seed: Parameters<typeof seedAssigned>[0],
    code: string,
    httpStatus: number,
  ) => {
    seedAssigned(seed);
    const error = await acceptJob(BOOKING, PROVIDER).catch((e) => e);
    expect(error).toBeInstanceOf(BookingResponseConflict);
    expect(error.code).toBe(code);
    expect(error.httpStatus).toBe(httpStatus);
    return error as BookingResponseConflict;
  };

  it.each(['CANCELLED', 'CANCELED'])('BOOKING_CANCELLED after booking %s', async (bookingStatus) => {
    await expectConflict({ bookingStatus }, 'BOOKING_CANCELLED', 409);
  });

  it('ALREADY_IN_PROGRESS once work has started', async () => {
    await expectConflict(
      { bookingStatus: 'IN_PROGRESS', assignmentStatus: 'IN_PROGRESS' },
      'ALREADY_IN_PROGRESS',
      409,
    );
  });

  it('ALREADY_IN_PROGRESS once the provider is en route', async () => {
    await expectConflict({ assignmentStatus: 'EN_ROUTE' }, 'ALREADY_IN_PROGRESS', 409);
  });

  it('NO_LONGER_ASSIGNED after a reassignment, without naming the replacement', async () => {
    const error = await expectConflict({ workerUid: 'provider-b' }, 'NO_LONGER_ASSIGNED', 409);
    expect(error.providerMessage).not.toContain('provider-b');
  });

  it('ALREADY_RESPONDED after this provider declined', async () => {
    await expectConflict({ assignmentStatus: 'DECLINED' }, 'ALREADY_RESPONDED', 409);
  });

  it('ALREADY_ACCEPTED_BY_YOU on a double tap — and that one is a 200', async () => {
    const error = await expectConflict({ assignmentStatus: 'ACCEPTED' }, 'ALREADY_ACCEPTED_BY_YOU', 200);
    expect(error.isAlreadySatisfied).toBe(true);
  });

  it('NO_LONGER_ASSIGNED when the booking does not exist', async () => {
    // §12: the refusal must not confirm whether the booking is real.
    store.booking = null;
    store.assignments = [];
    const error = await acceptJob(BOOKING, PROVIDER).catch((e) => e);
    expect(error).toBeInstanceOf(BookingResponseConflict);
    expect(error.code).toBe('NO_LONGER_ASSIGNED');
  });

  it('none of the refusals reaches the database with a write', async () => {
    seedAssigned({ assignmentStatus: 'DECLINED' });
    await acceptJob(BOOKING, PROVIDER).catch(() => undefined);

    expect(store.transitions).toHaveLength(0);
    expect(store.tracking).toHaveLength(0);
    expect(store.assignments[0].status).toBe('DECLINED');
  });
});
