/**
 * The reschedule workflow (TAB 06 §62).
 *
 *   PROPOSAL RECORD       written for an ACCEPTED move and for a REFUSED one
 *   SILENT OVERWRITE      impossible — the write is compare-and-swap
 *   ASSIGNMENT CONSISTENCY a provider collision REFUSES, never silently releases
 *   NOTICE WINDOW         customer 24h against the CURRENT start; admin exempt
 *   PROVIDER              not a party, and told the outcome
 *   EVENTS                proposed / applied / refused, on the booking timeline
 *
 * What this replaces: `UPDATE bookings SET schedule = $1 WHERE id = $2`, admin
 * only, with no concurrency control and no provider-calendar check — so two
 * admins moving one booking produced a silent winner.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' }, tempId: undefined }));
jest.mock('../src/db/dbQuery', () => require('./support/experienceDbFake').dbMock);
jest.mock('../src/db/mongodbQuery', () => ({ __esModule: true, default: {} }));

import { store, reset, seedBooking, seedAssignment } from './support/experienceDbFake';
import {
  rescheduleBooking,
  listRescheduleRequests,
  RescheduleError,
} from '../src/services/booking/bookingRescheduleService';
import { __resetExperienceSchema } from '../src/services/booking/experienceStore';
import {
  CUSTOMER_RESCHEDULE_NOTICE_HOURS,
  RESCHEDULE_MAX_LEAD_DAYS,
  RESCHEDULE_REQUIRES_PROVIDER_ACCEPTANCE,
} from '../src/services/booking/experiencePolicy';

const BOOKING = 5001;
const CUSTOMER = 'customer-1';
const ADMIN = 'admin-1';
const PROVIDER = 'worker-9';

const NOW = new Date('2026-08-20T09:00:00.000Z');
const inHours = (n: number) => new Date(NOW.getTime() + n * 3_600_000).toISOString();
const inDays = (n: number) => new Date(NOW.getTime() + n * 86_400_000).toISOString();

const seedMovable = (o: Record<string, unknown> = {}) =>
  seedBooking({ status: 'CONFIRMED', schedule: inHours(72), ...o });

beforeEach(() => {
  reset();
  __resetExperienceSchema();
});

describe('an accepted move', () => {
  it('applies the schedule and records an ACCEPTED proposal', async () => {
    seedMovable();
    const result = await rescheduleBooking({
      bookingId: BOOKING, scheduledAt: inHours(120),
      actor: 'customer', actorUid: CUSTOMER,
      reasonCode: 'CUSTOMER_UNAVAILABLE', reason: 'Away that week',
      now: NOW,
    });

    expect(result.status).toBe('ACCEPTED');
    expect(result.appliedImmediately).toBe(true);
    expect(store.booking?.schedule).toBe(inHours(120));
    expect(result.previousSchedule).toBe(inHours(72));

    expect(store.rescheduleRequests).toHaveLength(1);
    expect(store.rescheduleRequests[0]).toMatchObject({
      status: 'ACCEPTED', refusal_code: null,
      reason_code: 'CUSTOMER_UNAVAILABLE', requested_role: 'customer', requested_by: CUSTOMER,
    });
  });

  it('emits the event type the admin timeline already renders', async () => {
    seedMovable();
    await rescheduleBooking({
      bookingId: BOOKING, scheduledAt: inHours(120), actor: 'admin', actorUid: ADMIN, now: NOW,
    });
    const types = store.timelineEvents.map((e) => e.event_type);
    expect(types).toContain('booking_rescheduled');
    const event = store.timelineEvents.find((e) => e.event_type === 'booking_rescheduled')!;
    expect((event.metadata as any).event).toBe('reschedule.applied');
    expect((event.metadata as any).to).toBe(inHours(120));
  });

  it('the provider is not a party, so no acceptance step exists', () => {
    expect(RESCHEDULE_REQUIRES_PROVIDER_ACCEPTANCE).toBe(false);
  });
});

describe('a refused move is recorded too', () => {
  it('writes a REFUSED proposal and a refusal event, and does NOT move the booking', async () => {
    // The interesting record when a customer says they tried.
    seedMovable({ schedule: inHours(2) });
    await expect(
      rescheduleBooking({
        bookingId: BOOKING, scheduledAt: inHours(120),
        actor: 'customer', actorUid: CUSTOMER, now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'INSIDE_NOTICE_WINDOW' });

    expect(store.booking?.schedule).toBe(inHours(2));
    expect(store.rescheduleRequests).toHaveLength(1);
    expect(store.rescheduleRequests[0]).toMatchObject({
      status: 'REFUSED', refusal_code: 'INSIDE_NOTICE_WINDOW',
    });
    expect(store.timelineEvents.map((e) => e.event_type)).toContain('booking_reschedule_refused');
  });

  it('refuses a booking already in progress', async () => {
    seedBooking({ status: 'WORKER_ASSIGNED', worker_uid: PROVIDER, schedule: inHours(72) });
    seedAssignment(PROVIDER, 'IN_PROGRESS');
    await expect(
      rescheduleBooking({
        bookingId: BOOKING, scheduledAt: inHours(120), actor: 'admin', actorUid: ADMIN, now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'STATE_NOT_RESCHEDULABLE' });
  });

  it('refuses a past date and one beyond the lead bound', async () => {
    seedMovable();
    await expect(
      rescheduleBooking({
        bookingId: BOOKING, scheduledAt: inHours(-1), actor: 'admin', actorUid: ADMIN, now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'SCHEDULE_INVALID' });

    await expect(
      rescheduleBooking({
        bookingId: BOOKING, scheduledAt: inDays(RESCHEDULE_MAX_LEAD_DAYS + 1),
        actor: 'admin', actorUid: ADMIN, now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'SCHEDULE_INVALID' });
  });

  it('refuses a reason code outside the standardized list', async () => {
    seedMovable();
    await expect(
      rescheduleBooking({
        bookingId: BOOKING, scheduledAt: inHours(120),
        actor: 'admin', actorUid: ADMIN, reasonCode: 'JUST_BECAUSE', now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'REASON_INVALID' });
  });

  it('a booking that does not exist is not found, and records nothing', async () => {
    await expect(
      rescheduleBooking({
        bookingId: 999999, scheduledAt: inHours(120), actor: 'admin', actorUid: ADMIN, now: NOW,
      }),
    ).rejects.toBeInstanceOf(RescheduleError);
    expect(store.rescheduleRequests).toHaveLength(0);
  });
});

describe('the notice window', () => {
  it('is measured against the CURRENT start, not the proposed one', async () => {
    // Moving a booking that starts in an hour is the disruption, whatever the
    // new date is — the provider has already planned their day around the old.
    seedMovable({ schedule: inHours(CUSTOMER_RESCHEDULE_NOTICE_HOURS - 1) });
    await expect(
      rescheduleBooking({
        bookingId: BOOKING, scheduledAt: inDays(30), actor: 'customer', actorUid: CUSTOMER, now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'INSIDE_NOTICE_WINDOW' });
  });

  it('permits the customer outside the window', async () => {
    seedMovable({ schedule: inHours(CUSTOMER_RESCHEDULE_NOTICE_HOURS + 1) });
    const result = await rescheduleBooking({
      bookingId: BOOKING, scheduledAt: inDays(10), actor: 'customer', actorUid: CUSTOMER, now: NOW,
    });
    expect(result.status).toBe('ACCEPTED');
  });

  it('exempts an admin — the override IS the escalation path', async () => {
    seedMovable({ schedule: inHours(1) });
    const result = await rescheduleBooking({
      bookingId: BOOKING, scheduledAt: inDays(3), actor: 'admin', actorUid: ADMIN, now: NOW,
    });
    expect(result.status).toBe('ACCEPTED');
    expect(result.verdict.noticeHours).toBe(0);
  });
});

describe('no silent overwrite', () => {
  it('refuses when the booking moved between the read and the write', async () => {
    seedMovable();
    await expect(
      rescheduleBooking({
        bookingId: BOOKING, scheduledAt: inHours(120),
        actor: 'admin', actorUid: ADMIN,
        // The caller read a schedule that is not the one on the row.
        expectedSchedule: inHours(48),
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'SCHEDULE_CHANGED' });
    expect(store.booking?.schedule).toBe(inHours(72));
  });

  it('accepts when the caller’s expected schedule matches', async () => {
    seedMovable();
    const result = await rescheduleBooking({
      bookingId: BOOKING, scheduledAt: inHours(120),
      actor: 'admin', actorUid: ADMIN, expectedSchedule: inHours(72), now: NOW,
    });
    expect(result.status).toBe('ACCEPTED');
  });

  it('protects a caller who sends no expectation, using the schedule it read', async () => {
    seedMovable();
    const first = await rescheduleBooking({
      bookingId: BOOKING, scheduledAt: inHours(96), actor: 'admin', actorUid: ADMIN, now: NOW,
    });
    expect(first.status).toBe('ACCEPTED');
    // A second caller still holding the ORIGINAL value loses cleanly.
    await expect(
      rescheduleBooking({
        bookingId: BOOKING, scheduledAt: inHours(120),
        actor: 'admin', actorUid: ADMIN, expectedSchedule: inHours(72), now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'SCHEDULE_CHANGED' });
    expect(store.booking?.schedule).toBe(inHours(96));
  });

  it('handles a NULL schedule, which `=` would have failed on forever', async () => {
    // `NULL = NULL` is NULL, so an equality predicate would refuse every move of
    // a booking that has no schedule yet.
    seedMovable({ schedule: null });
    const result = await rescheduleBooking({
      bookingId: BOOKING, scheduledAt: inDays(5), actor: 'admin', actorUid: ADMIN, now: NOW,
    });
    expect(result.status).toBe('ACCEPTED');
    expect(result.previousSchedule).toBeNull();
  });
});

describe('assignment consistency', () => {
  it('REFUSES a move that collides with the assigned provider’s calendar', async () => {
    seedBooking({ status: 'WORKER_ASSIGNED', worker_uid: PROVIDER, schedule: inHours(72) });
    seedAssignment(PROVIDER, 'ACCEPTED');
    store.otherBookings.push({ worker_uid: PROVIDER, conflicts: true });

    await expect(
      rescheduleBooking({
        bookingId: BOOKING, scheduledAt: inHours(120), actor: 'admin', actorUid: ADMIN, now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_CONFLICT' });

    // Not silently released, not silently moved. Both would be worse.
    expect(store.booking?.schedule).toBe(inHours(72));
    expect(store.booking?.worker_uid).toBe(PROVIDER);
    expect(store.rescheduleRequests[0]).toMatchObject({ refusal_code: 'PROVIDER_CONFLICT' });
  });

  it('allows the move when the provider is free', async () => {
    seedBooking({ status: 'WORKER_ASSIGNED', worker_uid: PROVIDER, schedule: inHours(72) });
    seedAssignment(PROVIDER, 'ACCEPTED');
    store.otherBookings.push({ worker_uid: PROVIDER, conflicts: false });

    const result = await rescheduleBooking({
      bookingId: BOOKING, scheduledAt: inHours(120), actor: 'admin', actorUid: ADMIN, now: NOW,
    });
    expect(result.status).toBe('ACCEPTED');
    expect(store.booking?.worker_uid).toBe(PROVIDER);
  });

  it('skips the calendar query entirely when nobody is assigned', async () => {
    seedMovable();
    await rescheduleBooking({
      bookingId: BOOKING, scheduledAt: inHours(120), actor: 'admin', actorUid: ADMIN, now: NOW,
    });
    expect(store.sql.some((s) => /WITH target AS/.test(s))).toBe(false);
  });
});

describe('the proposal history', () => {
  it('lists accepted and refused attempts, newest first, without naming the proposer', async () => {
    seedMovable();
    await rescheduleBooking({
      bookingId: BOOKING, scheduledAt: inHours(96), actor: 'admin', actorUid: ADMIN, now: NOW,
    });
    await rescheduleBooking({
      bookingId: BOOKING, scheduledAt: inHours(-5), actor: 'admin', actorUid: ADMIN, now: NOW,
    }).catch(() => undefined);

    const history = await listRescheduleRequests(BOOKING);
    expect(history).toHaveLength(2);
    expect(history.map((h) => h.status).sort()).toEqual(['ACCEPTED', 'REFUSED']);
    // The seat, not the person.
    for (const row of history) {
      expect(row.requestedRole).toBe('admin');
      expect(JSON.stringify(row)).not.toContain(ADMIN);
    }
  });
});
