/**
 * B1.2 — PROVIDER_DECLINE runs on the canonical executor.
 *
 * Decline was the least atomic action in the lifecycle. Three separate
 * autocommit statements — close the assignment, reset the booking, write the
 * timeline row — so a failure between any two left a booking declined but not
 * released, or released with no timeline entry and no reassignment attempted.
 * They are now one transaction.
 *
 * What is checked:
 *
 *   - the full release, including `worker_code`, which is the only thing that
 *     invalidates the start code for the provider who walked away;
 *   - the five refusal codes decline can produce, with the 200 on a double tap;
 *   - the reassignment search running after the commit, once, never on replay;
 *   - the behaviour change: declining a CANCELLED booking is now refused, and
 *     no longer un-cancels it.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' } }));
jest.mock('../src/db/dbQuery', () => require('./support/bookingDbFake').dbMock);
jest.mock('../src/helpers/mailer', () => require('./support/bookingDbFake').sideEffectMocks.mailer);
jest.mock('../src/services/notification.service', () => require('./support/bookingDbFake').sideEffectMocks.notification);
jest.mock('../src/services/adminNotificationService', () => require('./support/bookingDbFake').sideEffectMocks.adminNotification);
jest.mock('../src/provider.realtime', () => require('./support/bookingDbFake').sideEffectMocks.realtime);
jest.mock('../src/chat/chat.service', () => require('./support/bookingDbFake').sideEffectMocks.chat);
jest.mock('../src/chat/chat.repository', () => require('./support/bookingDbFake').sideEffectMocks.chatRepo);
jest.mock('../src/services/user.service', () => require('./support/bookingDbFake').sideEffectMocks.user);
jest.mock('../src/db/mongodbQuery', () => ({ __esModule: true, default: {} }));
jest.mock('../src/services/providerAutoOnlineEngine', () => ({ getAutoBookableProviderUids: jest.fn() }));
jest.mock('../src/services/providerAvailabilityEngine', () => ({ filterUidsAvailableAt: jest.fn() }));
jest.mock('../src/services/pricingService', () => ({ computeTranspoFee: jest.fn() }));
jest.mock('../src/services/disbursement.service', () => ({ createDisbursement: jest.fn() }));

import { store, calls, reset, flush } from './support/bookingDbFake';
import { declineJob } from '../src/services/technicianService';
import { BookingResponseConflict } from '../src/services/bookingResponseConflict';
import { __resetTransitionSchema } from '../src/services/booking/transitionExecutor';

const PROVIDER = 'provider-a';
const BOOKING = 601;

const seed = (o: { bookingStatus?: string; assignmentStatus?: string; workerUid?: string | null } = {}) => {
  store.booking = {
    id: BOOKING,
    status: o.bookingStatus ?? 'WORKER_ASSIGNED',
    user_id: 'customer-1',
    worker_uid: o.workerUid === undefined ? PROVIDER : o.workerUid,
    worker_code: '123456',
    eta_minutes: 30,
    eta_at: '2026-08-12T01:00:00.000Z',
  };
  store.assignments = [{
    booking_id: BOOKING, worker_uid: PROVIDER,
    status: o.assignmentStatus ?? 'ASSIGNED', declined_at: null,
  }];
};

beforeEach(() => {
  reset();
  __resetTransitionSchema();
});

describe('the decline releases the booking in one transaction', () => {
  it('closes the assignment and stamps declined_at', async () => {
    seed();
    const out = await declineJob(BOOKING, PROVIDER);

    expect(out.declined).toBe(true);
    expect(store.assignments[0].status).toBe('DECLINED');
    expect(store.assignments[0].declined_at).toBe('2026-08-12T00:00:00.000Z');
  });

  it('returns the booking to the pool', async () => {
    seed();
    await declineJob(BOOKING, PROVIDER);

    expect(store.booking).toMatchObject({
      worker_uid: null, status: 'CONFIRMED', eta_minutes: null, eta_at: null,
    });
  });

  it('clears worker_code, which is what invalidates the start code', async () => {
    // The six-digit code is never consumed. If it survived a decline, the
    // provider who walked away could still start the job with a code they had
    // already been given.
    seed();
    expect(store.booking?.worker_code).toBe('123456');
    await declineJob(BOOKING, PROVIDER);
    expect(store.booking?.worker_code).toBeNull();
  });

  it('records the canonical transition and the legacy tracking row together', async () => {
    seed();
    await declineJob(BOOKING, PROVIDER);

    expect(store.transitions[0]).toMatchObject({
      action: 'PROVIDER_DECLINE', from_state: 'ASSIGNED', to_state: 'AWAITING_ASSIGNMENT',
    });
    // The tracking STATUS is where the booking landed, not the canonical state.
    expect(store.tracking).toEqual([
      { booking_id: BOOKING, status: 'CONFIRMED', note: 'Worker declined — seeking reassignment' },
    ]);
  });

  it('puts the close, the release, the timeline and the tracking row in ONE transaction', async () => {
    seed();
    await declineJob(BOOKING, PROVIDER);

    const tx = store.inTransaction.join(' | ');
    expect(tx).toContain('UPDATE servana.booking_workers SET status = $3, declined_at = CASE');
    expect(tx).toContain("UPDATE servana.bookings SET worker_uid = NULL, status = 'CONFIRMED'");
    expect(tx).toContain('INSERT INTO servana.booking_transitions');
    expect(tx).toContain('INSERT INTO servana.booking_tracking');
  });

  it('searches for a replacement only after the transition committed', async () => {
    seed();
    await declineJob(BOOKING, PROVIDER);
    await flush();

    const commit = store.sql.lastIndexOf('COMMIT');
    const search = store.sql.findIndex((q) => /JOIN servana\.service_options/.test(q));
    expect(search).toBeGreaterThan(commit);
  });

  it('notifies admin', async () => {
    seed();
    await declineJob(BOOKING, PROVIDER);
    await flush();
    expect(calls).toContain('adminNotify:provider_declined');
  });
});

describe('a failed tracking insert rolls the whole decline back', () => {
  it('leaves the assignment and the booking untouched', async () => {
    seed();
    store.trackingFails = true;

    await expect(declineJob(BOOKING, PROVIDER)).rejects.toThrow(/booking_tracking/);
    await flush();

    expect(store.assignments[0].status).toBe('ASSIGNED');
    expect(store.booking).toMatchObject({ worker_uid: PROVIDER, worker_code: '123456' });
    expect(store.transitions).toHaveLength(0);
    expect(store.sql).not.toContain('COMMIT');
  });

  it('does not search for a replacement provider', async () => {
    // The old sequence could reach the search with the booking half-released.
    seed();
    store.trackingFails = true;
    await declineJob(BOOKING, PROVIDER).catch(() => undefined);
    await flush();

    expect(store.sql.some((q) => /JOIN servana\.service_options/.test(q))).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('a replayed idempotency key', () => {
  it('does not reassign the booking a second time', async () => {
    seed();
    await declineJob(BOOKING, PROVIDER, { idempotencyKey: 'd-1' });
    await flush();

    const searchesAfterFirst = store.sql.filter((q) => /JOIN servana\.service_options/.test(q)).length;
    expect(searchesAfterFirst).toBe(1);

    const replay = await declineJob(BOOKING, PROVIDER, { idempotencyKey: 'd-1' });
    await flush();

    expect(replay.declined).toBe(true);
    expect(replay.reassignment).toEqual({ assigned: false, reason: 'IDEMPOTENT_REPLAY' });
    expect(store.sql.filter((q) => /JOIN servana\.service_options/.test(q))).toHaveLength(1);
    expect(store.transitions).toHaveLength(1);
    expect(store.tracking).toHaveLength(1);
  });
});

describe('the refusal vocabulary survives', () => {
  const refusal = async (
    seedWith: Parameters<typeof seed>[0],
    code: string,
    httpStatus: number,
  ) => {
    seed(seedWith);
    const error = await declineJob(BOOKING, PROVIDER).catch((e) => e);
    expect(error).toBeInstanceOf(BookingResponseConflict);
    expect(error.code).toBe(code);
    expect(error.httpStatus).toBe(httpStatus);
    return error as BookingResponseConflict;
  };

  it('ALREADY_DECLINED_BY_YOU on a double tap — and that one is a 200', async () => {
    // The case the actor's own row exists for. After the first decline the
    // booking has no provider at all, so only the caller's own row can tell
    // "you already did this" from "this was never yours".
    seed();
    await declineJob(BOOKING, PROVIDER);
    expect(store.booking?.worker_uid).toBeNull();

    const error = await declineJob(BOOKING, PROVIDER).catch((e) => e);
    expect(error).toBeInstanceOf(BookingResponseConflict);
    expect(error.code).toBe('ALREADY_DECLINED_BY_YOU');
    expect(error.httpStatus).toBe(200);
    expect(error.isAlreadySatisfied).toBe(true);
  });

  it('ALREADY_RESPONDED after accepting — declining is a different action', async () => {
    await refusal({ assignmentStatus: 'ACCEPTED' }, 'ALREADY_RESPONDED', 409);
  });

  it('ALREADY_IN_PROGRESS once work has started', async () => {
    await refusal(
      { bookingStatus: 'IN_PROGRESS', assignmentStatus: 'IN_PROGRESS' },
      'ALREADY_IN_PROGRESS',
      409,
    );
  });

  it('NO_LONGER_ASSIGNED after a reassignment, without naming the replacement', async () => {
    const error = await refusal({ workerUid: 'provider-b' }, 'NO_LONGER_ASSIGNED', 409);
    expect(error.providerMessage).not.toContain('provider-b');
  });

  it('NO_LONGER_ASSIGNED when the booking does not exist', async () => {
    store.booking = null;
    store.assignments = [];
    const error = await declineJob(BOOKING, PROVIDER).catch((e) => e);
    expect(error.code).toBe('NO_LONGER_ASSIGNED');
  });
});

/**
 * The one behaviour change in B1.2, pinned rather than discovered later.
 *
 * The legacy CAS checked only `booking_workers.status = 'ASSIGNED'`, so a
 * decline on a CANCELLED booking succeeded — and the release then reset
 * `bookings.status` to CONFIRMED and went looking for another provider. A
 * cancelled booking was being un-cancelled and reassigned by a provider tapping
 * decline.
 */
describe('BEHAVIOUR CHANGE: declining a cancelled booking is refused', () => {
  it.each(['CANCELLED', 'CANCELED'])('refuses when the booking is %s', async (bookingStatus) => {
    seed({ bookingStatus });
    const error = await declineJob(BOOKING, PROVIDER).catch((e) => e);
    expect(error).toBeInstanceOf(BookingResponseConflict);
  });

  /**
   * The invariant, stated as one thing rather than four.
   *
   * Asserting only that the status stayed CANCELLED would pass a refactor that
   * preserved the status while still firing the downstream matching engine —
   * which is the half that actually costs something, because it puts a new
   * provider on a cancelled job.
   */
  it('TERMINAL BOOKING: no release, no worker search, no status reset', async () => {
    seed({ bookingStatus: 'CANCELLED' });
    await declineJob(BOOKING, PROVIDER).catch(() => undefined);
    await flush();

    // no status reset
    expect(store.booking?.status).toBe('CANCELLED');
    // no assignment release
    expect(store.booking?.worker_uid).toBe(PROVIDER);
    expect(store.booking?.worker_code).toBe('123456');
    expect(store.assignments[0].status).toBe('ASSIGNED');
    // no replacement-provider lookup — the reassignment query never runs
    expect(store.sql.some((q) => /JOIN servana\.service_options/.test(q))).toBe(false);
    // and nothing recorded, since nothing happened
    expect(store.transitions).toHaveLength(0);
    expect(store.tracking).toHaveLength(0);
    expect(calls).toEqual([]);
  });

  it('the search assertion can actually fail (positive fixture)', () => {
    // The lookup is detected by one regex. If it stopped matching, every
    // "did not search" assertion above would pass vacuously.
    const real = 'SELECT b.schedule FROM servana.bookings b JOIN servana.service_options so ON so.id = b.service_option_id';
    expect(/JOIN servana\.service_options/.test(real)).toBe(true);
  });
});
