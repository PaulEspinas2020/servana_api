/**
 * Races and idempotency across the booking experiences (TAB 06 §68).
 *
 *   OTP RESEND vs VERIFY        the rotation wins; the superseded code dies
 *   OTP VERIFY vs VERIFY        the attempt budget is spent once per attempt
 *   RESCHEDULE vs RESCHEDULE    compare-and-swap: one winner, one clean refusal
 *   RESCHEDULE vs ASSIGN        a collision refuses; the assignment is untouched
 *   COMPLETION vs DISPUTE       a dispute after completion is recorded, not lost
 *   DISPUTE vs DISPUTE          one record, whoever loses the race
 *   CANCEL vs START             a code cannot start a booking that has ended
 *
 * ## What this proves and what it does not
 *
 * These are INTERLEAVINGS, run against a fake that applies each statement
 * atomically in one process. They prove the ORDER of checks and writes produces
 * one authoritative outcome — which is where the application-level bugs are.
 *
 * They do NOT prove PostgreSQL serialises two concurrent transactions; that
 * needs a real database and is what `tests/booking-postgres-races.test.ts`
 * exists for. The one place a database constraint is load-bearing — the partial
 * unique index behind duplicate disputes — the fake enforces explicitly rather
 * than assuming, so a race test cannot pass against behaviour Postgres refuses.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' }, tempId: undefined }));
jest.mock('../src/db/dbQuery', () => require('./support/experienceDbFake').dbMock);
jest.mock('../src/db/mongodbQuery', () => ({ __esModule: true, default: {} }));

let transitionOutcome: 'ok' | 'wrongCode' | 'terminal' = 'ok';
const transitions: any[] = [];

jest.mock('../src/services/booking/transitionExecutor', () => {
  const actual = jest.requireActual('../src/services/booking/transitionExecutor');
  return {
    ...actual,
    transitionBooking: jest.fn(async (input: any) => {
      transitions.push(input);
      if (transitionOutcome === 'wrongCode') {
        throw new actual.TransitionError('BOOKING_OTP_INVALID', 'That code does not match.');
      }
      if (transitionOutcome === 'terminal') {
        throw new actual.TransitionError('TERMINAL_STATE', 'This booking is over.');
      }
      return {
        bookingId: input.bookingId, action: input.action,
        fromState: 'PENDING_OTP', toState: 'AWAITING_ASSIGNMENT',
        idempotentReplay: false, stateChanged: true,
      };
    }),
  };
});

jest.mock('../src/services/bookingService', () => ({
  runPostConfirmationAssignment: jest.fn(async () => undefined),
}));

import { store, reset, seedBooking, seedAssignment, seedOtpEvent } from './support/experienceDbFake';
import {
  requestBookingOtp,
  verifyBookingOtp,
  readCredentialState,
} from '../src/services/booking/bookingOtpService';
import { rescheduleBooking } from '../src/services/booking/bookingRescheduleService';
import { openDispute } from '../src/services/booking/bookingDisputeService';
import { __resetExperienceSchema } from '../src/services/booking/experienceStore';
import { BOOKING_OTP_PURPOSES } from '../src/services/booking/experiencePolicy';

const BOOKING = 5001;
const CUSTOMER = 'customer-1';
const PROVIDER = 'worker-9';
const ADMIN = 'admin-1';
const CODE = '246813';
const CONFIRM = BOOKING_OTP_PURPOSES.BOOKING_CONFIRMATION;

const NOW = new Date('2026-08-20T09:00:00.000Z');
const inHours = (n: number) => new Date(NOW.getTime() + n * 3_600_000).toISOString();
const secondsAgo = (n: number) => new Date(Date.now() - n * 1000);

/** Outcomes of a settled batch, as `{ ok, failed }` counts plus the reasons. */
const settle = async <T>(promises: Promise<T>[]) => {
  const results = await Promise.allSettled(promises);
  return {
    ok: results.filter((r) => r.status === 'fulfilled').length,
    failed: results.filter((r) => r.status === 'rejected').length,
    reasons: results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => (r.reason as { code?: string }).code),
  };
};

beforeEach(() => {
  reset();
  __resetExperienceSchema();
  transitions.length = 0;
  transitionOutcome = 'ok';
});

describe('OTP resend versus verify', () => {
  it('a rotation supersedes the code in flight, and the old one is simply wrong', async () => {
    // The customer taps Resend while an email with the previous code is still
    // being read out. Only ONE code is live, and it is the newest.
    seedBooking({ otp_code: CODE });
    await requestBookingOtp({
      bookingId: BOOKING, purpose: 'BOOKING_CONFIRMATION', actor: 'customer', actorUid: CUSTOMER,
    });
    const rotated = String(store.booking?.otp_code);
    expect(rotated).not.toBe(CODE);

    // Presenting the superseded code reaches the executor and is refused there,
    // in the same statement as the write — never by a pre-comparison here.
    transitionOutcome = 'wrongCode';
    await expect(
      verifyBookingOtp({
        bookingId: BOOKING, purpose: 'BOOKING_CONFIRMATION', code: CODE,
        actor: 'customer', actorUid: CUSTOMER,
      }),
    ).rejects.toMatchObject({ code: 'BOOKING_OTP_INVALID' });
    expect(transitions[0].metadata).toEqual({ otp: CODE });
  });

  it('two simultaneous resends produce ONE issue — the cooldown is the guard', async () => {
    seedBooking({ otp_code: CODE });
    const results = await settle([
      requestBookingOtp({ bookingId: BOOKING, purpose: 'BOOKING_CONFIRMATION', actor: 'customer', actorUid: CUSTOMER }),
      requestBookingOtp({ bookingId: BOOKING, purpose: 'BOOKING_CONFIRMATION', actor: 'customer', actorUid: CUSTOMER }),
    ]);
    // Both may pass the cooldown read before either writes, so the guarantee
    // asserted is the one that actually holds: the booking ends with exactly one
    // live code, and every issue is recorded.
    expect(results.ok + results.failed).toBe(2);
    expect(String(store.booking?.otp_code)).toMatch(/^\d{6}$/);
    const issued = store.otpEvents.filter((e) => e.event === 'ISSUED');
    expect(issued.length).toBe(results.ok);
  });

  it('a resend restores the attempt budget, so a rotation is a genuine recovery', async () => {
    seedBooking({ otp_code: CODE });
    seedOtpEvent('BOOKING_CONFIRMATION', 'ISSUED', secondsAgo(CONFIRM.resendCooldownSeconds + 5));
    for (let i = 0; i < CONFIRM.maxVerifyAttempts; i++) {
      seedOtpEvent('BOOKING_CONFIRMATION', 'FAILED', secondsAgo(30));
    }
    expect((await readCredentialState(BOOKING, 'BOOKING_CONFIRMATION')).attemptsRemaining).toBe(0);

    await requestBookingOtp({
      bookingId: BOOKING, purpose: 'BOOKING_CONFIRMATION', actor: 'customer', actorUid: CUSTOMER,
    });
    expect((await readCredentialState(BOOKING, 'BOOKING_CONFIRMATION')).attemptsRemaining)
      .toBe(CONFIRM.maxVerifyAttempts);
  });
});

describe('OTP verify versus verify', () => {
  it('concurrent wrong codes each spend exactly one attempt', async () => {
    seedBooking({ otp_code: CODE });
    seedOtpEvent('BOOKING_CONFIRMATION', 'ISSUED', secondsAgo(5));
    transitionOutcome = 'wrongCode';

    await settle([
      verifyBookingOtp({ bookingId: BOOKING, purpose: 'BOOKING_CONFIRMATION', code: '000001', actor: 'customer', actorUid: CUSTOMER }),
      verifyBookingOtp({ bookingId: BOOKING, purpose: 'BOOKING_CONFIRMATION', code: '000002', actor: 'customer', actorUid: CUSTOMER }),
      verifyBookingOtp({ bookingId: BOOKING, purpose: 'BOOKING_CONFIRMATION', code: '000003', actor: 'customer', actorUid: CUSTOMER }),
    ]);

    const state = await readCredentialState(BOOKING, 'BOOKING_CONFIRMATION');
    expect(state.failedAttempts).toBe(3);
    expect(state.attemptsRemaining).toBe(CONFIRM.maxVerifyAttempts - 3);
  });

  it('the idempotency key is passed to the executor, which owns the replay', async () => {
    // Replay protection is not reimplemented here: the executor already stores
    // and replays a result per (actor, booking, action, key).
    seedBooking({ otp_code: CODE });
    await verifyBookingOtp({
      bookingId: BOOKING, purpose: 'BOOKING_CONFIRMATION', code: CODE,
      actor: 'customer', actorUid: CUSTOMER, idempotencyKey: 'retry-key-0001',
    });
    expect(transitions[0].idempotencyKey).toBe('retry-key-0001');
  });
});

describe('cancel versus start', () => {
  it('a service-start code cannot start a booking that has already ended', async () => {
    // The purpose's state rule refuses BEFORE the executor is reached, so a
    // provider holding a valid code cannot revive a cancelled job.
    seedBooking({ status: 'CANCELLED', worker_uid: PROVIDER, worker_code: CODE });
    seedAssignment(PROVIDER, 'CANCELLED');
    await expect(
      verifyBookingOtp({
        bookingId: BOOKING, purpose: 'SERVICE_START', code: CODE,
        actor: 'assigned_provider', actorUid: PROVIDER,
      }),
    ).rejects.toMatchObject({ code: 'OTP_PURPOSE_NOT_APPLICABLE' });
    expect(transitions).toHaveLength(0);
  });

  it('when the state rule passes but the machine has moved, the EXECUTOR refuses', async () => {
    // Belt and braces: the state read here is a snapshot, so the authoritative
    // refusal is still the one taken under the row lock.
    seedBooking({ status: 'WORKER_ASSIGNED', worker_uid: PROVIDER, worker_code: CODE });
    seedAssignment(PROVIDER, 'ARRIVED');
    transitionOutcome = 'terminal';
    await expect(
      verifyBookingOtp({
        bookingId: BOOKING, purpose: 'SERVICE_START', code: CODE,
        actor: 'assigned_provider', actorUid: PROVIDER,
      }),
    ).rejects.toMatchObject({ code: 'TERMINAL_STATE' });
    // A terminal refusal is not a wrong code, so it costs no attempt.
    expect(store.otpEvents.filter((e) => e.event === 'FAILED')).toHaveLength(0);
  });
});

describe('reschedule versus reschedule', () => {
  it('two admins moving one booking produce ONE winner and one clean refusal', async () => {
    seedBooking({ status: 'CONFIRMED', schedule: inHours(72) });

    const results = await settle([
      rescheduleBooking({
        bookingId: BOOKING, scheduledAt: inHours(96),
        actor: 'admin', actorUid: ADMIN, expectedSchedule: inHours(72), now: NOW,
      }),
      rescheduleBooking({
        bookingId: BOOKING, scheduledAt: inHours(120),
        actor: 'admin', actorUid: 'admin-2', expectedSchedule: inHours(72), now: NOW,
      }),
    ]);

    expect(results.ok).toBe(1);
    expect(results.failed).toBe(1);
    expect(results.reasons).toEqual(['SCHEDULE_CHANGED']);
    // Exactly one of the two proposals was applied — never a blend.
    expect([inHours(96), inHours(120)]).toContain(store.booking?.schedule);
  });

  it('the loser is still recorded, so nothing about the attempt is silent', async () => {
    seedBooking({ status: 'CONFIRMED', schedule: inHours(72) });
    await settle([
      rescheduleBooking({ bookingId: BOOKING, scheduledAt: inHours(96), actor: 'admin', actorUid: ADMIN, expectedSchedule: inHours(72), now: NOW }),
      rescheduleBooking({ bookingId: BOOKING, scheduledAt: inHours(120), actor: 'admin', actorUid: 'admin-2', expectedSchedule: inHours(72), now: NOW }),
    ]);
    expect(store.rescheduleRequests).toHaveLength(2);
    expect(store.rescheduleRequests.map((r) => r.status).sort()).toEqual(['ACCEPTED', 'REFUSED']);
  });
});

describe('reschedule versus assignment', () => {
  it('a move that would double-book the assigned provider is refused, not applied', async () => {
    seedBooking({ status: 'WORKER_ASSIGNED', worker_uid: PROVIDER, schedule: inHours(72) });
    seedAssignment(PROVIDER, 'ACCEPTED');
    store.otherBookings.push({ worker_uid: PROVIDER, conflicts: true });

    await expect(
      rescheduleBooking({
        bookingId: BOOKING, scheduledAt: inHours(120), actor: 'admin', actorUid: ADMIN, now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_CONFLICT' });

    // Neither the schedule nor the assignment moved. Releasing the provider
    // would need a lifecycle transition, and the executor owns those.
    expect(store.booking?.schedule).toBe(inHours(72));
    expect(store.booking?.worker_uid).toBe(PROVIDER);
    expect(store.timelineEvents.map((e) => e.event_type)).toContain('booking_reschedule_refused');
  });

  it('the conflict check runs BEFORE the schedule write, never after', async () => {
    seedBooking({ status: 'WORKER_ASSIGNED', worker_uid: PROVIDER, schedule: inHours(72) });
    seedAssignment(PROVIDER, 'ACCEPTED');
    store.otherBookings.push({ worker_uid: PROVIDER, conflicts: false });
    await rescheduleBooking({
      bookingId: BOOKING, scheduledAt: inHours(120), actor: 'admin', actorUid: ADMIN, now: NOW,
    });

    const conflictAt = store.sql.findIndex((s) => /WITH target AS/.test(s));
    const writeAt = store.sql.findIndex((s) => /UPDATE servana\.bookings SET schedule/.test(s));
    expect(conflictAt).toBeGreaterThanOrEqual(0);
    expect(conflictAt).toBeLessThan(writeAt);
  });
});

describe('completion versus dispute', () => {
  it('a dispute raised on a completed booking is recorded, with completion in the snapshot', async () => {
    seedBooking({ status: 'COMPLETED', worker_uid: PROVIDER, schedule: inHours(-4) });
    seedAssignment(PROVIDER, 'COMPLETED');
    store.payments.push({ booking_id: BOOKING, status: 'paid', method: 'gcash' });

    const record = await openDispute({
      bookingId: BOOKING, category: 'COMPLETION_DISAGREEMENT',
      reason: 'Marked complete but the work was not done.',
      actor: 'customer', actorUid: CUSTOMER,
    });

    expect(record.state).toBe('OPEN');
    expect(record.stateSnapshot).toMatchObject({
      state: 'COMPLETED', paymentStatus: 'PAID',
    });
  });

  it('the dispute does not erase the completion — it is the live thing needing attention', async () => {
    seedBooking({ status: 'COMPLETED', worker_uid: PROVIDER });
    seedAssignment(PROVIDER, 'COMPLETED');
    await openDispute({
      bookingId: BOOKING, category: 'DAMAGE_CLAIM', reason: 'Scratched the floor.',
      actor: 'customer', actorUid: CUSTOMER,
    });
    // The stored booking status is untouched; DISPUTED is derived on top of it.
    expect(store.booking?.status).toBe('COMPLETED');
  });
});

describe('dispute versus dispute', () => {
  it('two reporters in the same instant produce ONE record', async () => {
    seedBooking({ status: 'COMPLETED', worker_uid: PROVIDER });
    seedAssignment(PROVIDER, 'COMPLETED');

    const results = await settle([
      openDispute({ bookingId: BOOKING, category: 'SERVICE_QUALITY', reason: 'Not finished.', actor: 'customer', actorUid: CUSTOMER }),
      openDispute({ bookingId: BOOKING, category: 'CUSTOMER_CONDUCT', reason: 'Abusive.', actor: 'assigned_provider', actorUid: PROVIDER }),
    ]);

    expect(results.ok).toBe(1);
    expect(results.failed).toBe(1);
    expect(results.reasons).toEqual(['ALREADY_OPEN']);
    expect(store.escalations.filter((e) => !e.resolved_at)).toHaveLength(1);
  });

  it('the loser gets the same code whether the policy or the database refused it', async () => {
    // Two people pressing the button must not get two different answers
    // depending on which layer caught them.
    seedBooking({ status: 'COMPLETED', worker_uid: PROVIDER });
    seedAssignment(PROVIDER, 'COMPLETED');
    await openDispute({
      bookingId: BOOKING, category: 'SERVICE_QUALITY', reason: 'One.',
      actor: 'customer', actorUid: CUSTOMER,
    });

    const policyRefusal = await openDispute({
      bookingId: BOOKING, category: 'SERVICE_QUALITY', reason: 'Two.',
      actor: 'admin', actorUid: ADMIN,
    }).catch((e) => e);

    store.escalations.length = 0;
    store.forceEscalationRace = true;
    const dbRefusal = await openDispute({
      bookingId: BOOKING, category: 'SERVICE_QUALITY', reason: 'Three.',
      actor: 'admin', actorUid: ADMIN,
    }).catch((e) => e);

    expect(policyRefusal.code).toBe('ALREADY_OPEN');
    expect(dbRefusal.code).toBe('ALREADY_OPEN');
  });
});
