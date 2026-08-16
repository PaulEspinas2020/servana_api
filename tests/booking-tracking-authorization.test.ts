/**
 * Tracking authorization, end to end through the service (TAB 06 §64).
 *
 *   POSITION READ         only after the visibility rule has already permitted it
 *   STATE LIMIT           EN_ROUTE / ARRIVED / IN_PROGRESS, and nothing else
 *   TIME WINDOW           measured from the last MOVEMENT, fails closed
 *   WITHHELD              200 with a reason, never a 403
 *   HISTORY               readable in every state — it is not location
 *
 * The defect this replaces: `GET /api/booking/:id/provider-location` was already
 * booking-scoped and authenticated, and answered in EVERY state — so a customer
 * could follow their provider on a booking that was cancelled last week.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' }, tempId: undefined }));
jest.mock('../src/db/dbQuery', () => require('./support/experienceDbFake').dbMock);
jest.mock('../src/db/mongodbQuery', () => ({ __esModule: true, default: {} }));

const locationReads: string[] = [];
let position: unknown = { lat: 14.6, lon: 121.0, at: '2026-08-20T09:00:00.000Z' };

jest.mock('../src/services/technicianService', () => ({
  getWorkerLocation: jest.fn(async (uid: string) => {
    locationReads.push(uid);
    return position;
  }),
}));

import { store, reset, seedBooking, seedAssignment, seedTransition } from './support/experienceDbFake';
import { getBookingTracking } from '../src/services/booking/bookingTrackingService';
import {
  TRACKING_LOCATION_STATES,
  TRACKING_MAX_HOURS_SINCE_MOVEMENT,
} from '../src/services/booking/experiencePolicy';

const BOOKING = 5001;
const PROVIDER = 'worker-9';
const NOW = new Date('2026-08-20T12:00:00.000Z');
const hoursAgo = (n: number) => new Date(NOW.getTime() - n * 3_600_000);

/** A booking with a provider who is on the way, ten minutes ago. */
const seedMoving = (state = 'EN_ROUTE', movedHoursAgo = 0.5) => {
  seedBooking({ status: 'WORKER_ASSIGNED', worker_uid: PROVIDER });
  seedAssignment(PROVIDER, state);
  seedTransition(state, hoursAgo(movedHoursAgo));
};

beforeEach(() => {
  reset();
  locationReads.length = 0;
  position = { lat: 14.6, lon: 121.0, at: '2026-08-20T09:00:00.000Z' };
});

describe('the position is disclosed only when all three rules hold', () => {
  it('discloses for a provider who is on the way', async () => {
    seedMoving('EN_ROUTE');
    const view = await getBookingTracking(BOOKING, NOW);
    expect(view.visibility.visibility).toBe('VISIBLE');
    expect(view.assignedProvider.location).toEqual(position);
    expect(view.state).toBe('EN_ROUTE');
  });

  it('discloses in every trackable state and in no other', async () => {
    for (const state of TRACKING_LOCATION_STATES) {
      reset();
      locationReads.length = 0;
      seedMoving(state);
      const view = await getBookingTracking(BOOKING, NOW);
      expect(view.visibility.visibility).toBe('VISIBLE');
    }

    for (const state of ['ASSIGNED', 'ACCEPTED'] as const) {
      reset();
      locationReads.length = 0;
      seedMoving(state);
      const view = await getBookingTracking(BOOKING, NOW);
      expect(view.visibility.visibility).toBe('WITHHELD');
      expect(view.visibility.reason).toBe('STATE_NOT_TRACKABLE');
    }
  });

  it('withholds on a booking with no provider', async () => {
    seedBooking({ status: 'CONFIRMED' });
    const view = await getBookingTracking(BOOKING, NOW);
    expect(view.visibility.reason).toBe('NO_ASSIGNMENT');
    expect(view.assignedProvider.assigned).toBe(false);
  });

  it('withholds on a completed booking, whatever the last movement was', async () => {
    seedBooking({ status: 'COMPLETED', worker_uid: PROVIDER });
    seedAssignment(PROVIDER, 'COMPLETED');
    seedTransition('IN_PROGRESS', hoursAgo(0.1));
    const view = await getBookingTracking(BOOKING, NOW);
    expect(view.state).toBe('COMPLETED');
    expect(view.visibility.reason).toBe('STATE_NOT_TRACKABLE');
    expect(view.assignedProvider.location).toBeNull();
  });

  it('withholds on a cancelled booking', async () => {
    seedBooking({ status: 'CANCELLED', worker_uid: PROVIDER });
    seedAssignment(PROVIDER, 'EN_ROUTE');
    seedTransition('EN_ROUTE', hoursAgo(0.1));
    const view = await getBookingTracking(BOOKING, NOW);
    expect(view.state).toBe('CANCELLED');
    expect(view.assignedProvider.location).toBeNull();
  });

  it('closes the window on a job that never finished', async () => {
    seedMoving('IN_PROGRESS', TRACKING_MAX_HOURS_SINCE_MOVEMENT + 2);
    const view = await getBookingTracking(BOOKING, NOW);
    expect(view.visibility.reason).toBe('WINDOW_EXPIRED');
    expect(view.assignedProvider.location).toBeNull();
  });

  it('FAILS CLOSED when no movement transition was ever recorded', async () => {
    seedBooking({ status: 'WORKER_ASSIGNED', worker_uid: PROVIDER });
    seedAssignment(PROVIDER, 'EN_ROUTE');
    // No transition row: the state cannot be proven recent.
    const view = await getBookingTracking(BOOKING, NOW);
    expect(view.visibility.reason).toBe('WINDOW_EXPIRED');
    expect(view.assignedProvider.location).toBeNull();
  });
});

describe('the position is not READ unless it may be disclosed', () => {
  it('never queries the provider location for an untrackable booking', async () => {
    // There must be no branch in which the value exists and is discarded on the
    // way out — that is the shape that leaks through a debug log or a new field.
    seedBooking({ status: 'CANCELLED', worker_uid: PROVIDER });
    seedAssignment(PROVIDER, 'EN_ROUTE');
    seedTransition('EN_ROUTE', hoursAgo(0.1));
    await getBookingTracking(BOOKING, NOW);
    expect(locationReads).toEqual([]);
  });

  it('never queries it once the window has closed', async () => {
    seedMoving('EN_ROUTE', TRACKING_MAX_HOURS_SINCE_MOVEMENT + 1);
    await getBookingTracking(BOOKING, NOW);
    expect(locationReads).toEqual([]);
  });

  it('queries it exactly once when permitted', async () => {
    seedMoving('ARRIVED');
    await getBookingTracking(BOOKING, NOW);
    expect(locationReads).toEqual([PROVIDER]);
  });
});

describe('a withheld position is not an access denial', () => {
  it('still returns the booking state and its tracking history', async () => {
    seedBooking({ status: 'CONFIRMED' });
    store.tracking.push(
      { booking_id: BOOKING, status: 'CREATED', note: 'Booking placed', created_at: hoursAgo(6) },
      { booking_id: BOOKING, status: 'CONFIRMED', note: 'Code verified', created_at: hoursAgo(5) },
    );

    const view = await getBookingTracking(BOOKING, NOW);
    expect(view.visibility.visibility).toBe('WITHHELD');
    expect(view.steps).toHaveLength(2);
    expect(view.steps[0]).toMatchObject({ status: 'CREATED', note: 'Booking placed' });
    expect(view.steps[0].at).toBe(hoursAgo(6).toISOString());
  });

  it('distinguishes "not reported" from "not permitted"', async () => {
    seedMoving('EN_ROUTE');
    position = null;
    const view = await getBookingTracking(BOOKING, NOW);
    expect(view.visibility.reason).toBe('NO_POSITION_REPORTED');
    expect(view.assignedProvider.assigned).toBe(true);
    expect(view.assignedProvider.location).toBeNull();
  });

  it('publishes the policy so no client recomputes the window', async () => {
    seedMoving('EN_ROUTE', 1);
    const view = await getBookingTracking(BOOKING, NOW);
    expect(view.policy.trackableStates).toEqual(TRACKING_LOCATION_STATES);
    expect(view.policy.maxHoursSinceMovement).toBe(TRACKING_MAX_HOURS_SINCE_MOVEMENT);
    expect(view.visibility.windowClosesAt).toBe(
      new Date(hoursAgo(1).getTime() + TRACKING_MAX_HOURS_SINCE_MOVEMENT * 3_600_000).toISOString(),
    );
  });

  it('a booking that does not exist is a real not-found, not an empty view', async () => {
    await expect(getBookingTracking(999999, NOW)).rejects.toMatchObject({
      code: 'BOOKING_NOT_FOUND',
    });
  });
});

describe('a disputed booking does not leak a position', () => {
  it('an open escalation outranks the movement state', async () => {
    seedMoving('IN_PROGRESS', 0.2);
    store.escalations.push({ booking_id: BOOKING, resolved_at: null });
    const view = await getBookingTracking(BOOKING, NOW);
    expect(view.state).toBe('DISPUTED');
    expect(view.visibility.reason).toBe('STATE_NOT_TRACKABLE');
    expect(locationReads).toEqual([]);
  });
});
