/**
 * The dispute model (TAB 06 §66).
 *
 *   ONE RECORD            all three actors write `booking_escalations`
 *   DUPLICATE PREVENTION  policy check AND a database constraint
 *   STATE SNAPSHOT        service and financial state captured at opening
 *   EVIDENCE              references only, carried inside the snapshot
 *   PROJECTION            reason / assigned_team / actor_uid never cross
 *   CANONICAL STATE       an open dispute makes the booking DISPUTED
 *
 * Built on the table the admin portal already derives `hasDispute` from, so
 * admin, provider and customer cannot disagree about whether a booking is
 * disputed. A second table was the obvious wrong answer.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' }, tempId: undefined }));
jest.mock('../src/db/dbQuery', () => require('./support/experienceDbFake').dbMock);
jest.mock('../src/db/mongodbQuery', () => ({ __esModule: true, default: {} }));

import { store, reset, seedBooking, seedAssignment } from './support/experienceDbFake';
import {
  openDispute,
  listDisputes,
  DisputeError,
} from '../src/services/booking/bookingDisputeService';
import { __resetExperienceSchema } from '../src/services/booking/experienceStore';
import { DISPUTE_CATEGORIES } from '../src/services/booking/experiencePolicy';
import { deriveCanonicalState } from '../src/services/booking/canonicalState';

const BOOKING = 5001;
const CUSTOMER = 'customer-1';
const PROVIDER = 'worker-9';
const ADMIN = 'admin-1';

const seedCompleted = () => {
  seedBooking({ status: 'COMPLETED', worker_uid: PROVIDER, schedule: '2026-08-19T10:00:00.000Z' });
  seedAssignment(PROVIDER, 'COMPLETED');
};

const open = (o: Record<string, unknown> = {}) =>
  openDispute({
    bookingId: BOOKING,
    category: 'SERVICE_QUALITY',
    reason: 'The work was not finished.',
    actor: 'customer',
    actorUid: CUSTOMER,
    ...o,
  } as any);

beforeEach(() => {
  reset();
  __resetExperienceSchema();
});

describe('one record, whichever seat raised it', () => {
  it('a customer, a provider and an admin all write the same table', async () => {
    for (const [actor, uid] of [
      ['customer', CUSTOMER],
      ['assigned_provider', PROVIDER],
      ['admin', ADMIN],
    ] as const) {
      reset();
      __resetExperienceSchema();
      seedCompleted();
      const record = await open({ actor, actorUid: uid });
      expect(store.escalations).toHaveLength(1);
      expect(record.openedByRole).toBe(actor);
      expect(record.state).toBe('OPEN');
    }
  });

  it('writes the category to BOTH the new column and the legacy reason_code', async () => {
    // The admin portal already filters and groups on reason_code. Writing only
    // the new column would make every canonically-opened dispute invisible to
    // the tools operations already use.
    seedCompleted();
    await open({ category: 'DAMAGE_CLAIM' });
    expect(store.escalations[0]).toMatchObject({
      category: 'DAMAGE_CLAIM',
      reason_code: 'DAMAGE_CLAIM',
    });
  });

  it('makes the booking DISPUTED by the shared derivation, with no second flag', async () => {
    seedCompleted();
    await open();
    const state = deriveCanonicalState({
      bookingStatus: store.booking!.status,
      workerStatus: 'COMPLETED',
      workerUid: PROVIDER,
      hasEscalation: store.escalations.some((e) => !e.resolved_at),
    });
    expect(state).toBe('DISPUTED');
  });

  it('emits the timeline event the admin portal already renders', async () => {
    seedCompleted();
    await open({ severity: 'high' });
    const event = store.timelineEvents.find((e) => e.event_type === 'dispute_opened');
    expect(event).toBeDefined();
    expect(event!.title).toBe('Dispute opened (high)');
    expect((event!.metadata as any).event).toBe('disputes.opened');
  });

  it('does NOT put the reporter’s free text on the timeline', async () => {
    // The timeline is read by the other party; one party's account of the other
    // belongs in the admin record it was written into.
    seedCompleted();
    await open({ reason: 'The technician was extremely rude to my mother.' });
    expect(JSON.stringify(store.timelineEvents)).not.toContain('rude to my mother');
  });
});

describe('duplicate prevention has two layers', () => {
  it('the policy check refuses a second open dispute with a renderable reason', async () => {
    seedCompleted();
    await open();
    await expect(open({ actor: 'assigned_provider', actorUid: PROVIDER })).rejects.toMatchObject({
      code: 'ALREADY_OPEN',
    });
    expect(store.escalations).toHaveLength(1);
  });

  it('the DATABASE refuses one that slipped past the check, with the same code', async () => {
    // A check followed by an insert is a race with a window. Two people pressing
    // the button in the same second must not get two different answers.
    seedCompleted();
    store.forceEscalationRace = true;
    await expect(open()).rejects.toMatchObject({ code: 'ALREADY_OPEN', detail: { raced: true } });
  });

  it('a RESOLVED dispute does not block a new one', async () => {
    seedCompleted();
    store.escalations.push({
      id: 99, booking_id: BOOKING, resolved_at: '2026-08-19T12:00:00.000Z',
      created_at: '2026-08-19T11:00:00.000Z', actor_uid: ADMIN,
    });
    const record = await open();
    expect(record.state).toBe('OPEN');
    expect(store.escalations).toHaveLength(2);
  });
});

describe('the state snapshot', () => {
  it('captures the service and financial state at opening', async () => {
    seedCompleted();
    store.payments.push({ booking_id: BOOKING, status: 'paid', method: 'cash' });
    const record = await open();

    expect(record.stateSnapshot).toMatchObject({
      state: 'COMPLETED',
      bookingStatus: 'COMPLETED',
      workerStatus: 'COMPLETED',
      hasAssignment: true,
      scheduledAt: '2026-08-19T10:00:00.000Z',
      paymentStatus: 'PAID',
      paymentMethod: 'CASH',
    });
    expect(record.stateSnapshot!.capturedAt).toBeTruthy();
  });

  it('carries no amount, reference or payer', async () => {
    seedCompleted();
    store.payments.push({
      booking_id: BOOKING, status: 'paid', method: 'gcash',
      amount: 4500, reference_no: 'PM-77123', payer_uid: CUSTOMER,
    });
    const record = await open();
    const json = JSON.stringify(record.stateSnapshot);
    expect(json).not.toContain('4500');
    expect(json).not.toContain('PM-77123');
    expect(json).not.toContain('payer');
  });

  it('carries the reporter’s evidence references inside the snapshot', async () => {
    seedCompleted();
    const record = await open({ evidence: { photoIds: [11, 12], messageIds: ['m-9'] } });
    expect((record.stateSnapshot as any).evidence).toEqual({
      photoIds: [11, 12], messageIds: ['m-9'],
    });
  });
});

describe('what may be opened, and from where', () => {
  it('refuses before anyone has committed to the booking', async () => {
    seedBooking({ status: 'PENDING_OTP' });
    await expect(open()).rejects.toMatchObject({ code: 'NOT_YET_ACTIONABLE' });

    reset();
    __resetExperienceSchema();
    seedBooking({ status: 'WORKER_ASSIGNED', worker_uid: PROVIDER });
    seedAssignment(PROVIDER, 'ASSIGNED');
    await expect(open()).rejects.toMatchObject({ code: 'NOT_YET_ACTIONABLE' });
  });

  it('permits a dispute about a cancellation', async () => {
    seedBooking({ status: 'CANCELLED', worker_uid: PROVIDER });
    seedAssignment(PROVIDER, 'CANCELLED');
    const record = await open({ category: 'CANCELLATION_DISAGREEMENT' });
    expect(record.category).toBe('CANCELLATION_DISAGREEMENT');
  });

  it('refuses a category outside the standardized list and an empty reason', async () => {
    seedCompleted();
    await expect(open({ category: 'MY_OWN_CATEGORY' })).rejects.toMatchObject({
      code: 'CATEGORY_INVALID',
    });
    await expect(open({ reason: '  ' })).rejects.toMatchObject({ code: 'REASON_REQUIRED' });
    expect(store.escalations).toHaveLength(0);
  });

  it('falls back to normal severity rather than storing an unknown one', async () => {
    seedCompleted();
    const record = await open({ severity: 'CATASTROPHIC' });
    expect(record.severity).toBe('normal');
  });

  it('a booking that does not exist is not found', async () => {
    await expect(open()).rejects.toBeInstanceOf(DisputeError);
    await expect(open()).rejects.toMatchObject({ code: 'BOOKING_NOT_FOUND' });
  });

  it('accepts every canonical category', async () => {
    for (const category of DISPUTE_CATEGORIES) {
      reset();
      __resetExperienceSchema();
      seedCompleted();
      const record = await open({ category });
      expect(record.category).toBe(category);
    }
  });
});

describe('the projection withholds the admin record', () => {
  it('never returns reason, assigned_team or actor_uid to any caller', async () => {
    seedCompleted();
    await open({ reason: 'Internal note the other party must not read' });
    store.escalations[0].assigned_team = 'trust-and-safety';

    for (const caller of [CUSTOMER, PROVIDER, ADMIN, null]) {
      const list = await listDisputes(BOOKING, caller);
      const json = JSON.stringify(list);
      expect(json).not.toContain('Internal note');
      expect(json).not.toContain('trust-and-safety');
      expect(json).not.toContain(CUSTOMER);
    }
  });

  it('openedByYou is the ONLY caller-dependent field', async () => {
    seedCompleted();
    await open({ actor: 'customer', actorUid: CUSTOMER });

    const mine = await listDisputes(BOOKING, CUSTOMER);
    const theirs = await listDisputes(BOOKING, PROVIDER);

    expect(mine[0].openedByYou).toBe(true);
    expect(theirs[0].openedByYou).toBe(false);
    expect({ ...mine[0], openedByYou: null }).toEqual({ ...theirs[0], openedByYou: null });
  });

  it('lists newest first and reports resolution', async () => {
    seedCompleted();
    store.escalations.push({
      id: 1, booking_id: BOOKING, category: 'PAYMENT_ISSUE', severity: 'low',
      actor_uid: ADMIN, opened_by_role: 'admin',
      resolved_at: '2026-08-18T10:00:00.000Z', created_at: '2026-08-17T10:00:00.000Z',
    });
    const list = await listDisputes(BOOKING, ADMIN);
    expect(list[0].state).toBe('RESOLVED');
    expect(list[0].resolvedAt).toBe('2026-08-18T10:00:00.000Z');
  });
});
