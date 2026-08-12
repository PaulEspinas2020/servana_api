/**
 * D3 — ADMIN_APPROVE_COMPLETION on the canonical executor.
 *
 *   FROM ASSIGNED / ACCEPTED / IN_PROGRESS   COMPLETED
 *   FROM CANCELLED                           REFUSED — NEVER REVIVES
 *   FROM COMPLETED                           STATE UNCHANGED, event recorded
 *   SECOND CANONICAL COMPLETION TRANSITION   0
 *   DISBURSEMENT                             0 new triggers
 *   REVIEW ELIGIBILITY                       0 new triggers
 *   PROVIDER CASH GUARD                      not applied
 *   SAME IDEMPOTENCY KEY                     no duplicate approval event
 *   NEW INTENTIONAL REQUEST                  may record another
 *   EVENT-ONLY CAPABILITY                    explicitly allow-listed
 *
 * The distinction this exists to keep true:
 *
 *   state transition  ≠  administrative event
 *
 * both written through the same transaction, and told apart by `state_changed`
 * so that two COMPLETED rows never read as a booking that completed twice.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' } }));
jest.mock('../src/db/dbQuery', () => require('./support/bookingDbFake').dbMock);
jest.mock('../src/db/mongodbQuery', () => ({ __esModule: true, default: {} }));

import fs from 'fs';
import path from 'path';
import { store, reset } from './support/bookingDbFake';
import {
  transitionBooking,
  TransitionError,
  BOOKING_ACTIONS,
  __resetTransitionSchema,
} from '../src/services/booking/transitionExecutor';

const ADMIN = 'admin-1';
const BOOKING = 1401;

const codeOf = (rel: string): string =>
  fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

const seed = (bookingStatus: string, assignmentStatus: string | null) => {
  store.booking = {
    id: BOOKING, status: bookingStatus, user_id: 'customer-1',
    worker_uid: assignmentStatus ? 'provider-a' : null,
    schedule: new Date(Date.now() + 48 * 3_600_000).toISOString(),
  };
  store.assignments = assignmentStatus
    ? [{ booking_id: BOOKING, worker_uid: 'provider-a', status: assignmentStatus }]
    : [];
  // An UNPAID CASH payment throughout: the provider guard would refuse on
  // this, and admin approval must not consult it.
  store.payments = [{ booking_id: BOOKING, method: 'CASH', status: 'PENDING' }];
};

const approve = (metadata: Record<string, unknown> = { reason: 'support settled' }, key?: string) =>
  transitionBooking({
    action: 'ADMIN_APPROVE_COMPLETION', bookingId: BOOKING,
    actorRole: 'admin', actorUid: ADMIN, metadata, idempotencyKey: key,
  });

beforeEach(() => {
  reset();
  __resetTransitionSchema();
});

describe('force completion, from the states legacy meaningfully supported', () => {
  it.each([
    ['ASSIGNED', 'ASSIGNED'],
    ['WORKER_ASSIGNED', 'ACCEPTED'],
    ['IN_PROGRESS', 'IN_PROGRESS'],
  ])('from %s / %s → COMPLETED', async (bookingStatus, assignmentStatus) => {
    seed(bookingStatus, assignmentStatus);
    const result = await approve();

    expect(result.toState).toBe('COMPLETED');
    expect(result.stateChanged).toBe(true);
    expect(store.booking?.status).toBe('COMPLETED');
    expect(store.assignments[0].status).toBe('COMPLETED');
    expect(store.transitions).toHaveLength(1);
  });

  it('the evidence row says the state MOVED', async () => {
    seed('IN_PROGRESS', 'IN_PROGRESS');
    await approve();
    expect(store.transitions[0]).toMatchObject({
      action: 'ADMIN_APPROVE_COMPLETION', from_state: 'IN_PROGRESS',
      to_state: 'COMPLETED', state_changed: true,
    });
  });
});

/**
 * The defect this migration fixes, declared rather than incidental.
 *
 * Legacy had no status precondition: it wrote COMPLETED unconditionally, so
 * approving a CANCELLED booking revived it. The mirror of the
 * decline-on-cancelled defect found in B1.2.
 */
describe('a cancelled booking is NEVER revived', () => {
  it('refuses, and changes nothing', async () => {
    seed('CANCELLED', 'CANCELLED');
    const error = await approve().catch((e) => e);

    expect(error).toBeInstanceOf(TransitionError);
    expect(store.booking?.status).toBe('CANCELLED');
    expect(store.transitions).toHaveLength(0);
    expect(store.timelineEvents).toHaveLength(0);
    expect(store.sql).not.toContain('COMMIT');
  });

  it('an EXPIRED booking is refused too', async () => {
    seed('EXPIRED', null);
    const error = await approve().catch((e) => e);
    expect(error).toBeInstanceOf(TransitionError);
    expect(store.booking?.status).toBe('EXPIRED');
  });

  it('event-only does NOT rescue a state it does not list', async () => {
    // The capability must never substitute for a refusal. CANCELLED is in
    // neither `from` nor `eventOnly.from`, so it falls through to the ordinary
    // refusal rather than quietly recording an event.
    seed('CANCELLED', 'CANCELLED');
    await approve().catch(() => undefined);
    expect(store.transitions).toHaveLength(0);
  });
});

describe('approving an ALREADY COMPLETED booking', () => {
  it('records the approval and does NOT transition again', async () => {
    seed('COMPLETED', 'COMPLETED');
    const result = await approve();

    expect(result.stateChanged).toBe(false);
    expect(result.fromState).toBe('COMPLETED');
    expect(result.toState).toBe('COMPLETED');
    expect(store.booking?.status).toBe('COMPLETED');
  });

  it('the evidence row says the state did NOT move', async () => {
    // Without this an analyst reading two COMPLETED rows would be right to
    // conclude the booking completed twice.
    seed('COMPLETED', 'COMPLETED');
    await approve();

    expect(store.transitions).toHaveLength(1);
    expect(store.transitions[0]).toMatchObject({
      action: 'ADMIN_APPROVE_COMPLETION',
      from_state: 'COMPLETED', to_state: 'COMPLETED', state_changed: false,
    });
  });

  it('writes the administrative timeline event legacy wrote', async () => {
    seed('COMPLETED', 'COMPLETED');
    await approve();
    expect(store.timelineEvents).toHaveLength(1);
    expect(store.timelineEvents[0]).toMatchObject({
      event_type: 'completion_approved',
      title: 'Completion approved by admin',
      actor_type: 'admin',
    });
  });

  it('touches no status column at all', async () => {
    seed('COMPLETED', 'COMPLETED');
    await approve();
    const writes = store.inTransaction.filter((q) => /^UPDATE/i.test(q));
    expect(writes).toEqual([]);
  });

  it('a NEW deliberate request records ANOTHER approval', async () => {
    // Measured legacy behaviour: an admin may approve repeatedly, and each is
    // a real administrative act.
    seed('COMPLETED', 'COMPLETED');
    await approve({ reason: 'first review' });
    await approve({ reason: 'second review after escalation' });

    expect(store.transitions).toHaveLength(2);
    expect(store.transitions.every((t) => t.state_changed === false)).toBe(true);
    expect(store.timelineEvents).toHaveLength(2);
  });

  it('the SAME idempotency key records only one', async () => {
    // Transport retry, not a second decision.
    seed('COMPLETED', 'COMPLETED');
    await approve({ reason: 'review' }, 'k-1');
    const replay = await approve({ reason: 'review' }, 'k-1');

    expect(replay.idempotentReplay).toBe(true);
    expect(store.transitions).toHaveLength(1);
    expect(store.timelineEvents).toHaveLength(1);
  });
});

describe('no provider-completion machinery is inherited', () => {
  it('the unpaid-cash guard is NOT applied', async () => {
    // Every seed above carries an unpaid CASH payment. PROVIDER_COMPLETE would
    // refuse; admin approval never consulted it and still does not.
    seed('IN_PROGRESS', 'IN_PROGRESS');
    expect(store.payments[0]).toMatchObject({ method: 'CASH', status: 'PENDING' });

    await approve();
    expect(store.booking?.status).toBe('COMPLETED');
  });

  it('the action declares no guard', () => {
    expect((BOOKING_ACTIONS.ADMIN_APPROVE_COMPLETION as { guard?: string }).guard)
      .toBeUndefined();
  });

  it('no payments query is issued at all', async () => {
    seed('IN_PROGRESS', 'IN_PROGRESS');
    await approve();
    expect(store.sql.some((q) => /servana\.payments/.test(q))).toBe(false);
  });

  it('the admin service triggers no disbursement, receipt or review', () => {
    const svc = codeOf('src/services/adminBookingService.ts');
    const fn = svc.slice(
      svc.indexOf('export const adminApproveCompletion'),
      svc.indexOf('const VALID_CONSENT_METHODS'),
    );
    expect(fn).not.toContain('createDisbursement');
    expect(fn).not.toMatch(/booking_completed|review/i);
    // Positive fixture: the slice is the right function.
    expect(fn).toContain("action: 'ADMIN_APPROVE_COMPLETION'");
  });
});

/**
 * EVENT-ONLY is an explicit action capability, never an executor fallback.
 *
 * Without the restriction someone eventually writes CUSTOMER_CANCEL as
 * event-only from COMPLETED and quietly bypasses terminal-state protection.
 */
describe('the event-only capability is allow-listed', () => {
  const EVENT_ONLY_ACTIONS = ['ADMIN_APPROVE_COMPLETION'];

  it('exactly the allow-listed actions declare it', () => {
    const declared = Object.entries(BOOKING_ACTIONS)
      .filter(([, spec]) => (spec as { eventOnly?: unknown }).eventOnly)
      .map(([name]) => name)
      .sort();
    expect(declared).toEqual([...EVENT_ONLY_ACTIONS].sort());
  });

  it('the type itself is a closed union, not a boolean', () => {
    // A boolean can be flipped anywhere. A union has to be edited here, in a
    // diff somebody reads.
    const executor = codeOf('src/services/booking/transitionExecutor.ts');
    expect(executor).toContain("export type EventOnlyAction = 'ADMIN_APPROVE_COMPLETION';");
  });

  it('the executor never falls back to event-only', () => {
    // It is reached ONLY through an action's own declaration — never because a
    // transition was refused, and never because from === to.
    const executor = codeOf('src/services/booking/transitionExecutor.ts');
    expect(executor).toContain('eventOnly?.from.includes(fromState)');
    expect(executor).not.toMatch(/if \(fromState === toState\)\s*\{[\s\S]{0,120}state_changed/);
  });

  it('ADMIN_COMPLETE is gone — it had no caller and collided', () => {
    // An unused action with no source restriction and no timeline projection,
    // sharing (COMPLETED, admin) with the real one. A future caller picking it
    // from an autocomplete list would have reached COMPLETED from any state
    // with no administrative record.
    expect(Object.keys(BOOKING_ACTIONS)).not.toContain('ADMIN_COMPLETE');
  });
});
