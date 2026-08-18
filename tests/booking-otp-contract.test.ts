/**
 * The booking-code contract, enforced (TAB 06 §63).
 *
 *   PURPOSE SCOPING       a code is minted FOR a booking AND a purpose
 *   CROSS-USE             refused by column, by actor, and by state
 *   EXPIRY                derived from the event log, not from a column
 *   RESEND COOLDOWN       enforced, with the seconds remaining reported
 *   ISSUE CEILING         bounded per booking and purpose
 *   ATTEMPT LIMIT         spent by a WRONG CODE only
 *   AUDIT                 every issue, acceptance and failure recorded
 *   THE CODE              never returned, never logged, never in an event
 *
 * The property worth naming: before this, both booking codes had no expiry, no
 * attempt limit and no cooldown, and `resendBookingOtp` could be called in a
 * loop to rotate a customer's code indefinitely.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' }, tempId: undefined }));
jest.mock('../src/db/dbQuery', () => require('./support/experienceDbFake').dbMock);
jest.mock('../src/db/mongodbQuery', () => ({ __esModule: true, default: {} }));

const transitions: any[] = [];
let transitionOutcome: 'ok' | 'wrongCode' | 'invalidTransition' = 'ok';

jest.mock('../src/services/booking/transitionExecutor', () => {
  const actual = jest.requireActual('../src/services/booking/transitionExecutor');
  return {
    ...actual,
    transitionBooking: jest.fn(async (input: any) => {
      transitions.push(input);
      if (transitionOutcome === 'wrongCode') {
        throw new actual.TransitionError(
          input.action === 'PROVIDER_START' ? 'WORKER_CODE_INVALID' : 'BOOKING_OTP_INVALID',
          'That code does not match this booking.',
        );
      }
      if (transitionOutcome === 'invalidTransition') {
        throw new actual.TransitionError('INVALID_TRANSITION', 'No such transition.');
      }
      return {
        bookingId: input.bookingId, action: input.action,
        fromState: 'PENDING_OTP', toState: 'AWAITING_ASSIGNMENT',
        idempotentReplay: false, stateChanged: true,
      };
    }),
  };
});

const assignments: number[] = [];
jest.mock('../src/services/bookingService', () => ({
  runPostConfirmationAssignment: jest.fn(async (id: number) => { assignments.push(id); }),
}));

import {
  store, reset, seedBooking, seedAssignment, seedOtpEvent,
} from './support/experienceDbFake';
import {
  requestBookingOtp,
  verifyBookingOtp,
  readCredentialState,
  parsePurpose,
  BookingOtpError,
} from '../src/services/booking/bookingOtpService';
import { __resetExperienceSchema } from '../src/services/booking/experienceStore';
import { BOOKING_OTP_PURPOSES } from '../src/services/booking/experiencePolicy';

const BOOKING = 5001;
const CUSTOMER = 'customer-1';
const PROVIDER = 'worker-9';
const CODE = '246813';

const CONFIRM = BOOKING_OTP_PURPOSES.BOOKING_CONFIRMATION;
const START = BOOKING_OTP_PURPOSES.SERVICE_START;

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
const secondsAgo = (n: number) => new Date(Date.now() - n * 1000);

beforeEach(() => {
  reset();
  __resetExperienceSchema();
  transitions.length = 0;
  assignments.length = 0;
  transitionOutcome = 'ok';
});

describe('purpose scoping', () => {
  it('defaults to BOOKING_CONFIRMATION and rejects an unknown purpose', () => {
    expect(parsePurpose(undefined)).toBe('BOOKING_CONFIRMATION');
    expect(parsePurpose('')).toBe('BOOKING_CONFIRMATION');
    expect(parsePurpose('SERVICE_START')).toBe('SERVICE_START');
    expect(() => parsePurpose('PASSWORD_RESET')).toThrow(BookingOtpError);
  });

  it('issues the confirmation code into otp_code and the start code into worker_code', async () => {
    seedBooking({ otp_code: null });
    await requestBookingOtp({
      bookingId: BOOKING, purpose: 'BOOKING_CONFIRMATION', actor: 'customer', actorUid: CUSTOMER,
    });
    expect(String(store.booking?.otp_code)).toMatch(/^\d{6}$/);
    expect(store.booking?.worker_code).toBeNull();

    seedBooking({ status: 'WORKER_ASSIGNED', worker_uid: PROVIDER, worker_code: null });
    seedAssignment(PROVIDER, 'ARRIVED');
    await requestBookingOtp({
      bookingId: BOOKING, purpose: 'SERVICE_START', actor: 'customer', actorUid: CUSTOMER,
    });
    expect(String(store.booking?.worker_code)).toMatch(/^\d{6}$/);
  });

  it('a purpose is refused in a state where it means nothing', async () => {
    seedBooking({ status: 'COMPLETED' });
    await expect(
      requestBookingOtp({
        bookingId: BOOKING, purpose: 'BOOKING_CONFIRMATION', actor: 'customer', actorUid: CUSTOMER,
      }),
    ).rejects.toMatchObject({ code: 'OTP_PURPOSE_NOT_APPLICABLE' });

    seedBooking({ status: 'PENDING_OTP' });
    await expect(
      requestBookingOtp({
        bookingId: BOOKING, purpose: 'SERVICE_START', actor: 'customer', actorUid: CUSTOMER,
      }),
    ).rejects.toMatchObject({ code: 'OTP_PURPOSE_NOT_APPLICABLE' });
  });

  it('the verify path chooses the executor field from the PURPOSE, never from the caller', async () => {
    seedBooking();
    await verifyBookingOtp({
      bookingId: BOOKING, purpose: 'BOOKING_CONFIRMATION', code: CODE,
      actor: 'customer', actorUid: CUSTOMER,
    });
    expect(transitions[0].metadata).toEqual({ otp: CODE });
    expect(transitions[0].action).toBe('CUSTOMER_CONFIRM_OTP');

    reset();
    __resetExperienceSchema();
    transitions.length = 0;
    seedBooking({ status: 'WORKER_ASSIGNED', worker_uid: PROVIDER, worker_code: CODE });
    seedAssignment(PROVIDER, 'ARRIVED');
    await verifyBookingOtp({
      bookingId: BOOKING, purpose: 'SERVICE_START', code: CODE,
      actor: 'assigned_provider', actorUid: PROVIDER,
    });
    expect(transitions[0].metadata).toEqual({ workerCode: CODE });
    expect(transitions[0].action).toBe('PROVIDER_START');
  });
});

describe('cross-use is refused', () => {
  it('a provider cannot REQUEST the code they must be told', async () => {
    // The inversion that makes the service-start code mean anything.
    seedBooking({ status: 'WORKER_ASSIGNED', worker_uid: PROVIDER });
    seedAssignment(PROVIDER, 'ARRIVED');
    await expect(
      requestBookingOtp({
        bookingId: BOOKING, purpose: 'SERVICE_START', actor: 'assigned_provider', actorUid: PROVIDER,
      }),
    ).rejects.toMatchObject({ code: 'OTP_ACTOR_NOT_PERMITTED' });
    // And nothing was rotated.
    expect(store.booking?.worker_code).toBeNull();
  });

  it('a customer cannot PRESENT the service-start code', async () => {
    seedBooking({ status: 'WORKER_ASSIGNED', worker_uid: PROVIDER, worker_code: CODE });
    seedAssignment(PROVIDER, 'ARRIVED');
    await expect(
      verifyBookingOtp({
        bookingId: BOOKING, purpose: 'SERVICE_START', code: CODE,
        actor: 'customer', actorUid: CUSTOMER,
      }),
    ).rejects.toMatchObject({ code: 'OTP_ACTOR_NOT_PERMITTED' });
    expect(transitions).toHaveLength(0);
  });

  it('a provider cannot present the confirmation code', async () => {
    seedBooking();
    await expect(
      verifyBookingOtp({
        bookingId: BOOKING, purpose: 'BOOKING_CONFIRMATION', code: CODE,
        actor: 'assigned_provider', actorUid: PROVIDER,
      }),
    ).rejects.toMatchObject({ code: 'OTP_ACTOR_NOT_PERMITTED' });
  });

  it('an actor refusal costs no attempt — it never reached the credential', async () => {
    seedBooking({ status: 'WORKER_ASSIGNED', worker_uid: PROVIDER, worker_code: CODE });
    seedAssignment(PROVIDER, 'ARRIVED');
    await verifyBookingOtp({
      bookingId: BOOKING, purpose: 'SERVICE_START', code: CODE,
      actor: 'customer', actorUid: CUSTOMER,
    }).catch(() => undefined);
    expect(store.otpEvents.filter((e) => e.event === 'FAILED')).toHaveLength(0);
  });
});

describe('expiry', () => {
  it('is derived from the newest ISSUED row', async () => {
    seedBooking();
    seedOtpEvent('BOOKING_CONFIRMATION', 'ISSUED', minutesAgo(5));
    const state = await readCredentialState(BOOKING, 'BOOKING_CONFIRMATION');
    expect(state.expired).toBe(false);
    expect(state.expiresAt!.getTime() - state.issuedAt!.getTime()).toBe(CONFIRM.expiryMinutes * 60_000);
  });

  it('refuses a code past its window, and says when it expired', async () => {
    seedBooking();
    seedOtpEvent('BOOKING_CONFIRMATION', 'ISSUED', minutesAgo(CONFIRM.expiryMinutes + 1));
    await expect(
      verifyBookingOtp({
        bookingId: BOOKING, purpose: 'BOOKING_CONFIRMATION', code: CODE,
        actor: 'customer', actorUid: CUSTOMER,
      }),
    ).rejects.toMatchObject({ code: 'OTP_EXPIRED' });
    expect(transitions).toHaveLength(0);
  });

  it('seeds an absent log from the booking creation, which is when the code was minted', async () => {
    // Not a fudge: the booking row and its code are written together, so
    // `created_at` is a true statement about the credential. Making pre-existing
    // codes immortal would be the policy this tab removed.
    seedBooking({ created_at: minutesAgo(CONFIRM.expiryMinutes + 30).toISOString() });
    const state = await readCredentialState(BOOKING, 'BOOKING_CONFIRMATION');
    expect(state.issueCount).toBe(0);
    expect(state.expired).toBe(true);
  });

  it('a rotation restarts the window', async () => {
    seedBooking({ created_at: minutesAgo(600).toISOString() });
    expect((await readCredentialState(BOOKING, 'BOOKING_CONFIRMATION')).expired).toBe(true);
    await requestBookingOtp({
      bookingId: BOOKING, purpose: 'BOOKING_CONFIRMATION', actor: 'customer', actorUid: CUSTOMER,
    });
    expect((await readCredentialState(BOOKING, 'BOOKING_CONFIRMATION')).expired).toBe(false);
  });
});

describe('resend cooldown and issue ceiling', () => {
  it('refuses inside the cooldown and reports the seconds remaining', async () => {
    seedBooking();
    seedOtpEvent('BOOKING_CONFIRMATION', 'ISSUED', secondsAgo(10));
    await expect(
      requestBookingOtp({
        bookingId: BOOKING, purpose: 'BOOKING_CONFIRMATION', actor: 'customer', actorUid: CUSTOMER,
      }),
    ).rejects.toMatchObject({
      code: 'OTP_RESEND_COOLDOWN',
      detail: { cooldownSeconds: CONFIRM.resendCooldownSeconds },
    });
  });

  it('permits a resend once the cooldown has passed', async () => {
    seedBooking();
    seedOtpEvent('BOOKING_CONFIRMATION', 'ISSUED', secondsAgo(CONFIRM.resendCooldownSeconds + 5));
    const result = await requestBookingOtp({
      bookingId: BOOKING, purpose: 'BOOKING_CONFIRMATION', actor: 'customer', actorUid: CUSTOMER,
    });
    expect(result.issuesRemaining).toBe(CONFIRM.maxIssues - 2);
  });

  it('bounds the total number of codes a booking can ever be issued', async () => {
    seedBooking();
    for (let i = 0; i < CONFIRM.maxIssues; i++) {
      seedOtpEvent('BOOKING_CONFIRMATION', 'ISSUED', minutesAgo(120 - i));
    }
    await expect(
      requestBookingOtp({
        bookingId: BOOKING, purpose: 'BOOKING_CONFIRMATION', actor: 'customer', actorUid: CUSTOMER,
      }),
    ).rejects.toMatchObject({ code: 'OTP_RESEND_LIMIT' });
  });

  it('the cooldown is per PURPOSE, not per booking', async () => {
    // Issuing a service-start code must not lock out a confirmation resend.
    seedBooking({ status: 'WORKER_ASSIGNED', worker_uid: PROVIDER });
    seedAssignment(PROVIDER, 'ARRIVED');
    seedOtpEvent('SERVICE_START', 'ISSUED', secondsAgo(1));
    const state = await readCredentialState(BOOKING, 'BOOKING_CONFIRMATION');
    expect(state.cooldownRemainingSeconds).toBe(0);
  });
});

describe('attempt limit', () => {
  it('a wrong code spends exactly one attempt and records it', async () => {
    seedBooking();
    transitionOutcome = 'wrongCode';
    await verifyBookingOtp({
      bookingId: BOOKING, purpose: 'BOOKING_CONFIRMATION', code: '000000',
      actor: 'customer', actorUid: CUSTOMER,
    }).catch(() => undefined);

    const state = await readCredentialState(BOOKING, 'BOOKING_CONFIRMATION');
    expect(state.failedAttempts).toBe(1);
    expect(state.attemptsRemaining).toBe(CONFIRM.maxVerifyAttempts - 1);
  });

  it('an invalid transition spends NO attempt', async () => {
    // Otherwise anyone could burn a customer's budget by calling at the wrong
    // moment, which turns a limit into a denial-of-service.
    seedBooking();
    transitionOutcome = 'invalidTransition';
    for (let i = 0; i < 6; i++) {
      await verifyBookingOtp({
        bookingId: BOOKING, purpose: 'BOOKING_CONFIRMATION', code: CODE,
        actor: 'customer', actorUid: CUSTOMER,
      }).catch(() => undefined);
    }
    expect((await readCredentialState(BOOKING, 'BOOKING_CONFIRMATION')).failedAttempts).toBe(0);
  });

  it('refuses once the budget is spent — even for the CORRECT code', async () => {
    seedBooking();
    seedOtpEvent('BOOKING_CONFIRMATION', 'ISSUED', minutesAgo(1));
    for (let i = 0; i < CONFIRM.maxVerifyAttempts; i++) {
      seedOtpEvent('BOOKING_CONFIRMATION', 'FAILED', minutesAgo(1));
    }
    transitionOutcome = 'ok';
    await expect(
      verifyBookingOtp({
        bookingId: BOOKING, purpose: 'BOOKING_CONFIRMATION', code: CODE,
        actor: 'customer', actorUid: CUSTOMER,
      }),
    ).rejects.toMatchObject({ code: 'OTP_ATTEMPTS_EXHAUSTED' });
    expect(transitions).toHaveLength(0);
  });

  it('only failures AFTER the current issue count against it', async () => {
    seedBooking();
    for (let i = 0; i < CONFIRM.maxVerifyAttempts; i++) {
      seedOtpEvent('BOOKING_CONFIRMATION', 'FAILED', minutesAgo(30));
    }
    seedOtpEvent('BOOKING_CONFIRMATION', 'ISSUED', minutesAgo(1));
    const state = await readCredentialState(BOOKING, 'BOOKING_CONFIRMATION');
    expect(state.failedAttempts).toBe(0);
    expect(state.attemptsRemaining).toBe(CONFIRM.maxVerifyAttempts);
  });

  it('refuses when no code has ever been issued', async () => {
    seedBooking({ otp_code: null });
    await expect(
      verifyBookingOtp({
        bookingId: BOOKING, purpose: 'BOOKING_CONFIRMATION', code: CODE,
        actor: 'customer', actorUid: CUSTOMER,
      }),
    ).rejects.toMatchObject({ code: 'OTP_NOT_ISSUED' });
  });
});

describe('the code itself never escapes', () => {
  it('is absent from the issue response', async () => {
    seedBooking({ otp_code: null });
    const result = await requestBookingOtp({
      bookingId: BOOKING, purpose: 'BOOKING_CONFIRMATION', actor: 'customer', actorUid: CUSTOMER,
    });
    const issued = String(store.booking?.otp_code);
    expect(JSON.stringify(result)).not.toContain(issued);
    expect(result.delivery).toBe(CONFIRM.delivery);
    expect(result.recipient).toBe('customer');
  });

  it('is absent from every audit row and every timeline event', async () => {
    seedBooking({ otp_code: null });
    await requestBookingOtp({
      bookingId: BOOKING, purpose: 'BOOKING_CONFIRMATION', actor: 'customer', actorUid: CUSTOMER,
    });
    const issued = String(store.booking?.otp_code);
    expect(JSON.stringify(store.otpEvents)).not.toContain(issued);
    expect(JSON.stringify(store.timelineEvents)).not.toContain(issued);
  });

  it('is delivered out of band for confirmation, and in the booking detail for start', () => {
    expect(CONFIRM.delivery).toBe('email');
    // Mailing the service-start code would put the credential the provider is
    // about to ask for into a channel the provider might also see.
    expect(START.delivery).toBe('booking_detail');
  });
});

describe('audit', () => {
  it('records an ISSUED row, and it is what the cooldown reads next time', async () => {
    seedBooking({ otp_code: null });
    await requestBookingOtp({
      bookingId: BOOKING, purpose: 'BOOKING_CONFIRMATION', actor: 'admin', actorUid: 'admin-1',
    });
    expect(store.otpEvents).toHaveLength(1);
    expect(store.otpEvents[0]).toMatchObject({
      purpose: 'BOOKING_CONFIRMATION', event: 'ISSUED', actor_role: 'admin', actor_uid: 'admin-1',
    });
    await expect(
      requestBookingOtp({
        bookingId: BOOKING, purpose: 'BOOKING_CONFIRMATION', actor: 'admin', actorUid: 'admin-1',
      }),
    ).rejects.toMatchObject({ code: 'OTP_RESEND_COOLDOWN' });
  });

  it('records VERIFIED on acceptance and puts it on the booking timeline', async () => {
    seedBooking();
    await verifyBookingOtp({
      bookingId: BOOKING, purpose: 'BOOKING_CONFIRMATION', code: CODE,
      actor: 'customer', actorUid: CUSTOMER,
    });
    expect(store.otpEvents.map((e) => e.event)).toContain('VERIFIED');
    expect(store.timelineEvents.map((e) => e.event_type)).toContain('booking_otp_verified');
  });

  it('records FAILED on a wrong code — a limit nobody can see is not evidence', async () => {
    seedBooking();
    transitionOutcome = 'wrongCode';
    await verifyBookingOtp({
      bookingId: BOOKING, purpose: 'BOOKING_CONFIRMATION', code: '000000',
      actor: 'customer', actorUid: CUSTOMER,
    }).catch(() => undefined);
    expect(store.otpEvents.map((e) => e.event)).toContain('FAILED');
    expect(store.timelineEvents.map((e) => e.event_type)).toContain('booking_otp_failed');
  });
});

describe('confirmation releases the booking to matching', () => {
  it('runs the post-confirmation assignment once', async () => {
    seedBooking();
    await verifyBookingOtp({
      bookingId: BOOKING, purpose: 'BOOKING_CONFIRMATION', code: CODE,
      actor: 'customer', actorUid: CUSTOMER,
    });
    expect(assignments).toEqual([BOOKING]);
  });

  it('does not run it when the legacy caller says it will', async () => {
    // One caller, one auto-assignment. `bookingService.confirmOtp` owns the call
    // on its own path.
    seedBooking();
    await verifyBookingOtp({
      bookingId: BOOKING, purpose: 'BOOKING_CONFIRMATION', code: CODE,
      actor: 'customer', actorUid: CUSTOMER,
      skipPostConfirmationAssignment: true,
    });
    expect(assignments).toEqual([]);
  });

  it('never runs it for a service-start code', async () => {
    seedBooking({ status: 'WORKER_ASSIGNED', worker_uid: PROVIDER, worker_code: CODE });
    seedAssignment(PROVIDER, 'ARRIVED');
    await verifyBookingOtp({
      bookingId: BOOKING, purpose: 'SERVICE_START', code: CODE,
      actor: 'assigned_provider', actorUid: PROVIDER,
    });
    expect(assignments).toEqual([]);
  });
});

// ─── The rotation boundary must not depend on the clock ───────────────────────

describe('an attempt budget is scoped by ORDER, not by timestamp equality', () => {
  /**
   * The bug this pins.
   *
   * `failedAttempts` was `created_at >= lastIssueAt`, which charged the NEW
   * credential for failures recorded at exactly the issue instant. That is not a
   * hypothetical tie: `booking_otp_events.created_at` defaults to `now()`, and
   * PostgreSQL's `now()` is TRANSACTION start time — every row written in one
   * transaction shares an identical timestamp.
   *
   * So a customer who exhausted their attempts and rotated could be handed a
   * fresh code whose budget was already spent, with the only symptom being a
   * refusal they could not explain.
   *
   * It surfaced as an intermittent TEST failure rather than a bug report,
   * because whether the events and the reissue landed in the same instant
   * depended on how fast the process was running. It passed in isolation and
   * failed inside a long suite, three times, before it was chased down.
   */
  it('a rotation clears failures recorded at the SAME instant as the issue', async () => {
    const sameInstant = minutesAgo(1);
    seedBooking({ status: 'PENDING_OTP', otp_code: '123456' });

    // Five failures, then a rotation, all stamped identically — the exact tie a
    // single transaction produces.
    for (let i = 0; i < 5; i++) {
      seedOtpEvent('BOOKING_CONFIRMATION', 'FAILED', sameInstant);
    }
    seedOtpEvent('BOOKING_CONFIRMATION', 'ISSUED', sameInstant);

    const state = await readCredentialState(BOOKING, 'BOOKING_CONFIRMATION');

    // The failures precede the issue in the declared order, so the new
    // credential starts clean. A `>=` timestamp comparison scores this 5.
    expect(state.failedAttempts).toBe(0);
    expect(state.attemptsRemaining).toBe(CONFIRM.maxVerifyAttempts);
  });

  it('still counts failures that genuinely follow the issue', async () => {
    // The negative half: if the boundary were "always clean", the limit would
    // never engage and this suite would be measuring nothing.
    const t = minutesAgo(1);
    seedBooking({ status: 'PENDING_OTP', otp_code: '123456' });
    seedOtpEvent('BOOKING_CONFIRMATION', 'ISSUED', t);
    seedOtpEvent('BOOKING_CONFIRMATION', 'FAILED', t);
    seedOtpEvent('BOOKING_CONFIRMATION', 'FAILED', t);

    const state = await readCredentialState(BOOKING, 'BOOKING_CONFIRMATION');
    expect(state.failedAttempts).toBe(2);
  });
});
