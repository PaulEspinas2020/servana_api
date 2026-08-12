/**
 * Policy lives behind the executor, not in a controller.
 *
 * The 48-hour provider cancellation window was enforced in
 * `controllers/bookingCancellationPolicy.ts`. It was correct, and it was
 * checked on the one path that existed — but a controller is transport. A
 * policy there is optional depending on which caller reaches the executor,
 * which is exactly what centralising the lifecycle was supposed to end.
 *
 * These tests assert three things:
 *
 *   1. the rule is DISCOVERABLE — one named constant, one named guard;
 *   2. the executor ENFORCES it, so no backend caller can route around it;
 *   3. the transitions endpoint EVALUATES THE SAME GUARD, so the button a
 *      client draws and the action the executor authorizes cannot disagree.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' } }));
jest.mock('../src/db/dbQuery', () => require('./support/bookingDbFake').dbMock);
jest.mock('../src/db/mongodbQuery', () => ({ __esModule: true, default: {} }));

import fs from 'fs';
import path from 'path';
import { store, reset } from './support/bookingDbFake';
import {
  transitionBooking,
  getAvailableActions,
  TransitionError,
  BOOKING_GUARDS,
  BOOKING_ACTIONS,
  __resetTransitionSchema,
} from '../src/services/booking/transitionExecutor';
import {
  PROVIDER_CANCEL_WINDOW_HOURS,
  evaluateCancellation,
} from '../src/services/booking/bookingPolicies';

const PROVIDER = 'provider-a';
const BOOKING = 701;

const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

const seedAccepted = (scheduleIso: string | null) => {
  store.booking = {
    id: BOOKING, status: 'WORKER_ASSIGNED', user_id: 'customer-1',
    worker_uid: PROVIDER, worker_code: '123456', schedule: scheduleIso,
  };
  store.assignments = [{ booking_id: BOOKING, worker_uid: PROVIDER, status: 'ACCEPTED' }];
};

beforeEach(() => {
  reset();
  __resetTransitionSchema();
});

describe('the rule is discoverable', () => {
  it('lives in the domain layer, not in a controller', () => {
    expect(fs.existsSync(path.resolve(__dirname, '../src/services/booking/bookingPolicies.ts'))).toBe(true);
    expect(fs.existsSync(path.resolve(__dirname, '../src/controllers/bookingCancellationPolicy.ts'))).toBe(false);
  });

  it('the window is one named constant', () => {
    expect(PROVIDER_CANCEL_WINDOW_HOURS).toBe(48);
  });

  it('the action names its guard rather than hard-coding hours', () => {
    expect((BOOKING_ACTIONS.PROVIDER_CANCEL as { guard?: string }).guard)
      .toBe('providerCancellationWindow');
    const executor = fs.readFileSync(
      path.resolve(__dirname, '../src/services/booking/transitionExecutor.ts'), 'utf8',
    );
    // No second copy of the threshold anywhere in the machine.
    expect(executor).not.toMatch(/\b48\b\s*\*\s*3_?600_?000/);
    expect(executor).not.toMatch(/hoursUntilStart\s*<\s*48/);
  });
});

describe('the executor enforces the window', () => {
  it('allows a cancellation outside the window', async () => {
    seedAccepted(hoursFromNow(72));
    const result = await transitionBooking({
      action: 'PROVIDER_CANCEL', bookingId: BOOKING,
      actorRole: 'assigned_provider', actorUid: PROVIDER,
    });
    expect(result.toState).toBe('AWAITING_ASSIGNMENT');
  });

  it('refuses inside the window with a SPECIFIC reason, not a generic failure', async () => {
    seedAccepted(hoursFromNow(3));
    const error = await transitionBooking({
      action: 'PROVIDER_CANCEL', bookingId: BOOKING,
      actorRole: 'assigned_provider', actorUid: PROVIDER,
    }).catch((e) => e);

    expect(error).toBeInstanceOf(TransitionError);
    expect(error.code).toBe('POLICY_REFUSED');
    expect(error.detail.reasonCode).toBe('BOOKING_PROVIDER_CANCEL_WINDOW_EXPIRED');
    expect(error.detail.guard).toBe('providerCancellationWindow');
  });

  it('tells the client the deadline so it never recomputes the window', async () => {
    const schedule = hoursFromNow(3);
    seedAccepted(schedule);
    const error = await transitionBooking({
      action: 'PROVIDER_CANCEL', bookingId: BOOKING,
      actorRole: 'assigned_provider', actorUid: PROVIDER,
    }).catch((e) => e);

    const expected = new Date(new Date(schedule).getTime() - 48 * 3_600_000).toISOString();
    expect(error.detail.allowedUntil).toBe(expected);
    expect(error.detail.noticeHours).toBe(48);
  });

  it('fails CLOSED when the booking has no usable schedule', async () => {
    // The 48-hour guarantee cannot be proven, so the cancellation must not slip
    // through — an unprovable policy is a refused one.
    seedAccepted(null);
    const error = await transitionBooking({
      action: 'PROVIDER_CANCEL', bookingId: BOOKING,
      actorRole: 'assigned_provider', actorUid: PROVIDER,
    }).catch((e) => e);

    expect(error.code).toBe('POLICY_REFUSED');
    expect(error.detail.reasonCode).toBe('BOOKING_PROVIDER_CANCEL_SCHEDULE_UNKNOWN');
  });

  it('a refused cancellation writes NOTHING', async () => {
    // The guard runs before any mutation, so a policy refusal cannot leave a
    // half-released booking behind.
    seedAccepted(hoursFromNow(3));
    await transitionBooking({
      action: 'PROVIDER_CANCEL', bookingId: BOOKING,
      actorRole: 'assigned_provider', actorUid: PROVIDER,
    }).catch(() => undefined);

    expect(store.assignments[0].status).toBe('ACCEPTED');
    expect(store.booking).toMatchObject({ worker_uid: PROVIDER, worker_code: '123456' });
    expect(store.transitions).toHaveLength(0);
    expect(store.tracking).toHaveLength(0);
  });

  it('rejects a reason code outside the standardized list', async () => {
    seedAccepted(hoursFromNow(72));
    const error = await transitionBooking({
      action: 'PROVIDER_CANCEL', bookingId: BOOKING,
      actorRole: 'assigned_provider', actorUid: PROVIDER,
      metadata: { reasonCode: 'BECAUSE_I_SAID_SO' },
    }).catch((e) => e);

    expect(error.detail.reasonCode).toBe('BOOKING_PROVIDER_CANCEL_REASON_INVALID');
  });
});

describe('the transitions endpoint answers from the same guard', () => {
  it('reports PROVIDER_CANCEL unavailable, with the reason and the deadline', async () => {
    const schedule = hoursFromNow(3);
    seedAccepted(schedule);

    const actions = await getAvailableActions(BOOKING, PROVIDER, 'assigned_provider');
    const cancel = actions.find((a) => a.action === 'PROVIDER_CANCEL');

    expect(cancel).toBeDefined();
    expect(cancel!.allowed).toBe(false);
    expect(cancel!.reasonCode).toBe('BOOKING_PROVIDER_CANCEL_WINDOW_EXPIRED');
    expect(cancel!.detail?.allowedUntil)
      .toBe(new Date(new Date(schedule).getTime() - 48 * 3_600_000).toISOString());
  });

  it('reports it available outside the window', async () => {
    seedAccepted(hoursFromNow(72));
    const actions = await getAvailableActions(BOOKING, PROVIDER, 'assigned_provider');
    expect(actions.find((a) => a.action === 'PROVIDER_CANCEL')?.allowed).toBe(true);
  });

  /**
   * The property that makes this worth building: UI visibility and executor
   * authorization are the same decision. If they can disagree for ANY schedule,
   * some provider eventually taps a button that returns 409.
   */
  it('never disagrees with the executor, across the window boundary', async () => {
    /**
     * Half-hour offsets, deliberately.
     *
     * The policy floors `hoursUntilStart`, and the two calls below each take
     * their own `new Date()`. A schedule exactly 48 hours out reads as 48 on
     * the first call and 47 on the second the moment any wall-clock elapses
     * between them — so an integer-valued fixture makes this test fail under
     * load and pass in isolation, which teaches everyone to ignore it.
     *
     * Offsetting by half an hour keeps the boundary coverage (47.5 refuses,
     * 48.5 allows) while giving thirty minutes of slack against a floor that
     * genuinely can tick during the test.
     */
    for (const hours of [-10.5, 0.5, 1.5, 47.5, 48.5, 49.5, 72.5, 500.5]) {
      reset();
      __resetTransitionSchema();
      seedAccepted(hoursFromNow(hours));

      const advertised = (await getAvailableActions(BOOKING, PROVIDER, 'assigned_provider'))
        .find((a) => a.action === 'PROVIDER_CANCEL')!;

      const enforced = await transitionBooking({
        action: 'PROVIDER_CANCEL', bookingId: BOOKING,
        actorRole: 'assigned_provider', actorUid: PROVIDER,
      }).then(() => ({ allowed: true, reasonCode: undefined as string | undefined }))
        .catch((e) => ({ allowed: false, reasonCode: e.detail?.reasonCode }));

      expect({ hours, ...advertised, action: undefined, detail: undefined })
        .toMatchObject({ hours, allowed: enforced.allowed });
      if (!enforced.allowed) expect(advertised.reasonCode).toBe(enforced.reasonCode);
    }
  });

  it('offers nothing to a provider who is not the assigned one', async () => {
    seedAccepted(hoursFromNow(72));
    expect(await getAvailableActions(BOOKING, 'provider-b', 'assigned_provider')).toEqual([]);
  });
});

describe('the guard registry is honest', () => {
  it('every guard named by an action exists', () => {
    for (const [, spec] of Object.entries(BOOKING_ACTIONS)) {
      const name = (spec as { guard?: string }).guard;
      if (name) expect(Object.keys(BOOKING_GUARDS)).toContain(name);
    }
  });

  it('a guard returns a reason code whenever it refuses', () => {
    // A refusal with no reason is indistinguishable from a bug at the client.
    const refused = BOOKING_GUARDS.providerCancellationWindow({
      bookingStatus: 'WORKER_ASSIGNED', workerStatus: 'ACCEPTED',
      schedule: hoursFromNow(1), now: new Date(), metadata: {},
    });
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBeTruthy();
    expect(refused.message).toBeTruthy();
  });

  it('the guard delegates to the policy rather than reimplementing it', () => {
    // Same inputs, same verdict — if the guard ever grew its own arithmetic
    // this would drift the moment the constant changed.
    for (const hours of [1, 47, 48, 49]) {
      const schedule = hoursFromNow(hours);
      const policy = evaluateCancellation({
        workerStatus: 'ACCEPTED', schedule, now: new Date(),
      });
      const guard = BOOKING_GUARDS.providerCancellationWindow({
        bookingStatus: 'WORKER_ASSIGNED', workerStatus: 'ACCEPTED',
        schedule, now: new Date(), metadata: {},
      });
      expect(guard.allowed).toBe(policy.canCancel);
    }
  });
});

/**
 * ASSIGN and REASSIGN both end at ASSIGNED, and are not the same operation.
 *
 * `from` separates them structurally: ADMIN_ASSIGN only from
 * AWAITING_ASSIGNMENT, ADMIN_REASSIGN only from a live assignment. These
 * assertions cover the other half — that each does what its name says, so the
 * timeline keeps the distinction between
 *
 *   Assigned Provider A
 *   Reassigned Provider A → Provider B
 *
 * which cannot be reconstructed once it is lost.
 */
describe('assign and reassign are not interchangeable', () => {
  const seedUnassigned = () => {
    store.booking = {
      id: BOOKING, status: 'CONFIRMED', user_id: 'customer-1',
      worker_uid: null, schedule: hoursFromNow(72),
    };
    store.assignments = [];
  };

  it('ADMIN_ASSIGN places a provider on an unassigned booking', async () => {
    seedUnassigned();
    const result = await transitionBooking({
      action: 'ADMIN_ASSIGN', bookingId: BOOKING, actorRole: 'admin', actorUid: 'admin-1',
      metadata: { providerUid: 'provider-x' },
    });
    expect(result.fromState).toBe('AWAITING_ASSIGNMENT');
    expect(store.transitions[0]).toMatchObject({ action: 'ADMIN_ASSIGN', to_state: 'ASSIGNED' });
  });

  it('ADMIN_ASSIGN is refused when a provider is already on the booking', async () => {
    seedAccepted(hoursFromNow(72));
    const error = await transitionBooking({
      action: 'ADMIN_ASSIGN', bookingId: BOOKING, actorRole: 'admin', actorUid: 'admin-1',
      metadata: { providerUid: 'provider-x' },
    }).catch((e) => e);

    expect(error).toBeInstanceOf(TransitionError);
    // Refused by `from` before it can silently become a reassignment.
    expect(store.transitions).toHaveLength(0);
    expect(store.assignments[0].status).toBe('ACCEPTED');
  });

  it('ADMIN_REASSIGN is refused when there is nothing to replace', async () => {
    seedUnassigned();
    const error = await transitionBooking({
      action: 'ADMIN_REASSIGN', bookingId: BOOKING, actorRole: 'admin', actorUid: 'admin-1',
      metadata: { providerUid: 'provider-x' },
    }).catch((e) => e);

    expect(error).toBeInstanceOf(TransitionError);
    expect(store.transitions).toHaveLength(0);
  });

  it('ADMIN_REASSIGN closes the outgoing assignment rather than overwriting it', async () => {
    seedAccepted(hoursFromNow(72));
    await transitionBooking({
      action: 'ADMIN_REASSIGN', bookingId: BOOKING, actorRole: 'admin', actorUid: 'admin-1',
      metadata: { providerUid: 'provider-b' },
    });

    // The old provider's row survives as history; TAB 05 depends on an
    // assignment row being terminal rather than mutated.
    const outgoing = store.assignments.find((a) => a.worker_uid === PROVIDER);
    expect(outgoing?.status).toBe('REASSIGNED');
    expect(store.booking?.worker_uid).toBe('provider-b');
    expect(store.transitions[0]).toMatchObject({ action: 'ADMIN_REASSIGN' });
  });

  it('the timeline records WHICH operation happened', async () => {
    // Both end at ASSIGNED. Only the action name distinguishes them, which is
    // why the executor takes an action rather than a destination state.
    seedUnassigned();
    await transitionBooking({
      action: 'ADMIN_ASSIGN', bookingId: BOOKING, actorRole: 'admin', actorUid: 'admin-1',
      metadata: { providerUid: 'provider-x' },
    });
    await transitionBooking({
      action: 'ADMIN_REASSIGN', bookingId: BOOKING, actorRole: 'admin', actorUid: 'admin-1',
      metadata: { providerUid: 'provider-y' },
    });

    expect(store.transitions.map((t) => t.action)).toEqual(['ADMIN_ASSIGN', 'ADMIN_REASSIGN']);
    expect(store.transitions.map((t) => t.to_state)).toEqual(['ASSIGNED', 'ASSIGNED']);
  });
});
