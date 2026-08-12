/**
 * Phase C — CUSTOMER_CONFIRM_OTP on the canonical executor.
 *
 *   CUSTOMER_CONFIRM_OTP REQUIRES CREDENTIAL   PASS
 *   OTP-FREE EXECUTOR CONFIRM                  IMPOSSIBLE
 *   OTP SQL PREDICATE                          ATOMIC WITH WRITE
 *   STATE LIST IN OTP SQL                      ABSENT
 *   STATE LEGALITY                             CANONICAL MACHINE ONLY
 *   CUSTOMER AUTHORIZATION                     EXECUTOR-ENFORCED
 *   LEGACY assertBookingAccess                 COMPATIBILITY_ONLY
 *   OTP EXPIRY / ATTEMPT LIMIT / CONSUMPTION   NONE — PRESERVED
 *   REPLAY                                     ERROR / ZERO SECOND TRANSITION
 *   WRONG OTP                                  NO MUTATION / NO TIMELINE
 *   CANONICAL TIMELINE                         TRANSACTIONAL
 *   AUTO-ASSIGNMENT                            POST-COMMIT
 *   RAW WRITE                                  REMOVED
 *
 * The property that made this worth doing: before Phase C the executor's
 * CUSTOMER_CONFIRM_OTP branch wrote CONFIRMED with **no credential check at
 * all**, and was saved only by not yet being wired to an endpoint.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' } }));
jest.mock('../src/db/dbQuery', () => require('./support/bookingDbFake').dbMock);
jest.mock('../src/db/mongodbQuery', () => ({ __esModule: true, default: {} }));
jest.mock('../src/helpers/mailer', () => require('./support/bookingDbFake').sideEffectMocks.mailer);
jest.mock('../src/services/notification.service', () => require('./support/bookingDbFake').sideEffectMocks.notification);
jest.mock('../src/services/adminNotificationService', () => require('./support/bookingDbFake').sideEffectMocks.adminNotification);

const assigned: number[] = [];
let assignFails = false;
jest.mock('../src/services/technicianService', () => ({
  assignNearestWorker: jest.fn(async (bookingId: number) => {
    if (assignFails) throw new Error('no providers in range');
    assigned.push(bookingId);
    return { assigned: true };
  }),
}));
jest.mock('../src/services/address.service', () => ({
  getLatLonByLocationId: jest.fn(async () => [121.0, 14.6]),
}));

import fs from 'fs';
import path from 'path';
import { store, reset, flush } from './support/bookingDbFake';
import { confirmOtp } from '../src/services/bookingService';
import {
  transitionBooking,
  TransitionError,
  getAvailableActions,
  BOOKING_ACTIONS,
  __resetTransitionSchema,
} from '../src/services/booking/transitionExecutor';
import { deriveCanonicalState } from '../src/services/booking/canonicalState';

const CUSTOMER = 'customer-1';
const BOOKING = 1101;
const OTP = '246813';

const codeOf = (rel: string): string =>
  fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

const seed = (o: { status?: string; otp?: string | null; workerUid?: string | null } = {}) => {
  store.booking = {
    id: BOOKING,
    status: o.status ?? 'PENDING_OTP',
    user_id: CUSTOMER,
    worker_uid: o.workerUid ?? null,
    otp_code: o.otp === undefined ? OTP : o.otp,
    schedule: new Date(Date.now() + 240 * 3_600_000).toISOString(),
  };
  store.assignments = [];
};

beforeEach(() => {
  reset();
  __resetTransitionSchema();
  assigned.length = 0;
  assignFails = false;
});

describe('the credential is REQUIRED, structurally', () => {
  it('the action declares it', () => {
    expect((BOOKING_ACTIONS.CUSTOMER_CONFIRM_OTP as { requires?: string }).requires)
      .toBe('BOOKING_OTP');
  });

  it('OTP-FREE EXECUTOR CONFIRM: impossible, even for an internal caller', () => {
    // The hole this closes. Before Phase C the branch was
    // `UPDATE bookings SET status = 'CONFIRMED' WHERE id = $1` with no
    // credential at all — unreachable over HTTP, but reachable by anything
    // that called the executor directly.
    seed();
    return transitionBooking({
      action: 'CUSTOMER_CONFIRM_OTP', bookingId: BOOKING,
      actorRole: 'customer', actorUid: CUSTOMER,
      // no metadata.otp
    }).then(
      () => { throw new Error('the executor confirmed without a credential'); },
      (error) => {
        expect(error).toBeInstanceOf(TransitionError);
        expect(error.code).toBe('BOOKING_OTP_INVALID');
        expect(error.detail.missing).toBe(true);
      },
    );
  });

  it('an empty or whitespace code is not a credential', async () => {
    for (const otp of ['', '   ']) {
      reset();
      __resetTransitionSchema();
      seed();
      const error = await transitionBooking({
        action: 'CUSTOMER_CONFIRM_OTP', bookingId: BOOKING,
        actorRole: 'customer', actorUid: CUSTOMER, metadata: { otp },
      }).catch((e) => e);
      expect(error.code).toBe('BOOKING_OTP_INVALID');
      expect(store.booking?.status).toBe('PENDING_OTP');
    }
  });

  it('the missing-credential refusal happens BEFORE any write', async () => {
    seed();
    await transitionBooking({
      action: 'CUSTOMER_CONFIRM_OTP', bookingId: BOOKING,
      actorRole: 'customer', actorUid: CUSTOMER,
    }).catch(() => undefined);

    expect(store.sql.filter((q) => /^UPDATE|^INSERT/i.test(q))).toEqual([]);
    expect(store.transitions).toHaveLength(0);
  });
});

describe('OTP SQL PREDICATE: atomic with the write', () => {
  const executor = codeOf('src/services/booking/transitionExecutor.ts');
  const stmt = executor.slice(
    executor.indexOf("UPDATE ${s}.bookings SET status = 'CONFIRMED'"),
    executor.indexOf('if (!confirmed.rowCount)'),
  );

  it('the comparison is in the statement that writes', () => {
    expect(stmt).toContain('otp_code = $2::text');
    expect(stmt).toContain("SET status = 'CONFIRMED'");
  });

  it('STATE LIST IN OTP SQL: absent', () => {
    // The legacy statement also carried
    //   status = 'PENDING_OTP' OR (status = 'PAID' AND worker_uid IS NULL)
    // which was a second state machine in SQL.
    expect(stmt).not.toContain('PENDING_OTP');
    expect(stmt).not.toContain('PAID');
    expect(stmt).not.toMatch(/worker_uid IS NULL/);
  });

  it('the old copy is gone from bookingService too', () => {
    const svc = codeOf('src/services/bookingService.ts');
    const fn = svc.slice(svc.indexOf('export const confirmOtp'), svc.indexOf('export const getBookingById'));
    expect(fn).not.toMatch(/UPDATE \$\{dbSchema\}\.bookings/);
    expect(fn).toContain("action: 'CUSTOMER_CONFIRM_OTP'");
  });
});

describe('confirmation succeeds and is recorded once', () => {
  it('writes CONFIRMED and one canonical transition', async () => {
    seed();
    const booking = await confirmOtp(BOOKING, OTP, { actorUid: CUSTOMER });

    expect(store.booking?.status).toBe('CONFIRMED');
    expect(booking.status).toBe('CONFIRMED');
    expect(store.transitions).toHaveLength(1);
    expect(store.transitions[0]).toMatchObject({
      action: 'CUSTOMER_CONFIRM_OTP', from_state: 'PENDING_OTP', to_state: 'AWAITING_ASSIGNMENT',
    });
  });

  it('CANONICAL TIMELINE: transactional, with the legacy tracking row', async () => {
    seed();
    await confirmOtp(BOOKING, OTP, { actorUid: CUSTOMER });

    const tx = store.inTransaction.join(' | ');
    expect(tx).toContain("UPDATE servana.bookings SET status = 'CONFIRMED'");
    expect(tx).toContain('INSERT INTO servana.booking_transitions');
    expect(tx).toContain('INSERT INTO servana.booking_tracking');
    expect(store.tracking).toEqual([
      { booking_id: BOOKING, status: 'CONFIRMED', note: 'OTP verified' },
    ]);
  });

  it('the OTP never reaches the timeline', async () => {
    // §58 — the code authorises the transition; it is not evidence of it.
    seed();
    await confirmOtp(BOOKING, OTP, { actorUid: CUSTOMER });
    expect(JSON.stringify(store.transitions)).not.toContain(OTP);
    const inserts = store.sql.filter((q) => /INSERT INTO servana\.booking_transitions/.test(q));
    expect(inserts).toHaveLength(1);
  });

  it('a PAID booking with no provider can still be confirmed', async () => {
    // The legacy CAS accepted this source. Canonically it is already
    // AWAITING_ASSIGNMENT, so it is a self-transition — but not a no-op: it
    // writes CONFIRMED and releases the booking. Refusing it would strand
    // every payment-first booking holding a valid code.
    seed({ status: 'PAID' });
    await confirmOtp(BOOKING, OTP, { actorUid: CUSTOMER });
    expect(store.booking?.status).toBe('CONFIRMED');
    expect(store.transitions).toHaveLength(1);
  });
});

describe('WRONG OTP: no mutation, no timeline', () => {
  it('refuses and writes nothing', async () => {
    seed();
    await expect(confirmOtp(BOOKING, '000000', { actorUid: CUSTOMER }))
      .rejects.toThrow('Invalid OTP or booking is not in PENDING_OTP.');

    expect(store.booking?.status).toBe('PENDING_OTP');
    expect(store.transitions).toHaveLength(0);
    expect(store.tracking).toHaveLength(0);
    expect(store.sql).not.toContain('COMMIT');
  });

  it('does not trigger auto-assignment', async () => {
    seed();
    await confirmOtp(BOOKING, '000000', { actorUid: CUSTOMER }).catch(() => undefined);
    await flush();
    expect(assigned).toEqual([]);
  });
});

describe('CUSTOMER AUTHORIZATION is executor-enforced', () => {
  it('refuses a customer who does not own the booking, even with the right code', async () => {
    seed();
    const error = await transitionBooking({
      action: 'CUSTOMER_CONFIRM_OTP', bookingId: BOOKING,
      actorRole: 'customer', actorUid: 'someone-else', metadata: { otp: OTP },
    }).catch((e) => e);

    expect(error).toBeInstanceOf(TransitionError);
    expect(error.code).toBe('NOT_AUTHORIZED');
    expect(store.booking?.status).toBe('PENDING_OTP');
    expect(store.transitions).toHaveLength(0);
  });

  it('LEGACY assertBookingAccess is COMPATIBILITY_ONLY, and still present', () => {
    // Duplicated enforcement while the legacy endpoint is the only caller. The
    // executor's is the one that cannot be bypassed.
    const controller = codeOf('src/controllers/bookingController.ts');
    const fn = controller.slice(controller.indexOf('export const confirmOtp'));
    expect(fn).toContain('assertBookingAccess(bookingId');
    expect(fn).toContain('actorUid:');
  });
});

describe('REPLAY: existing contract preserved', () => {
  it('a second submission of the same valid code errors, and adds nothing', async () => {
    // NOT converted to an idempotent 200. Installed clients were built against
    // this, and Phase C is not the place to rewrite their semantics.
    //
    // Worth naming what refuses it. The OTP is never consumed, so the code is
    // still correct; and a CONFIRMED booking with no provider derives as
    // AWAITING_ASSIGNMENT, which the machine permits confirming FROM. Only
    // `bookingAwaitsOtpConfirmation` stands between a valid code and a second
    // confirmation — which is why the derivation being lossy here is written
    // down rather than left to be rediscovered.
    seed();
    store.withLocation = true;
    await confirmOtp(BOOKING, OTP, { actorUid: CUSTOMER });
    await flush();
    assigned.length = 0;

    await expect(confirmOtp(BOOKING, OTP, { actorUid: CUSTOMER }))
      .rejects.toThrow('Invalid OTP or booking is not in PENDING_OTP.');
    await flush();

    expect(store.transitions).toHaveLength(1);
    expect(store.tracking).toHaveLength(1);
    expect(assigned).toEqual([]);
  });
});

describe('OTP semantics PRESERVED, not upgraded', () => {
  it('CONSUMPTION: none — otp_code survives confirmation', async () => {
    seed();
    await confirmOtp(BOOKING, OTP, { actorUid: CUSTOMER });
    expect(store.booking?.otp_code).toBe(OTP);
  });

  it('EXPIRY: none — no expiry column is read or written', () => {
    const executor = codeOf('src/services/booking/transitionExecutor.ts');
    const svc = codeOf('src/services/bookingService.ts');
    for (const src of [executor, svc]) {
      expect(src).not.toMatch(/otp_expires|otp_expiry|otp_sent_at/);
    }
  });

  it('ATTEMPT LIMIT: none — no counter was introduced', () => {
    const executor = codeOf('src/services/booking/transitionExecutor.ts');
    expect(executor).not.toMatch(/otp_attempts|attemptCount/);
  });

  it('a wrong code can be retried, exactly as before', async () => {
    seed();
    for (let i = 0; i < 6; i++) {
      await confirmOtp(BOOKING, '111111', { actorUid: CUSTOMER }).catch(() => undefined);
    }
    // No lockout: the correct code still works.
    await confirmOtp(BOOKING, OTP, { actorUid: CUSTOMER });
    expect(store.booking?.status).toBe('CONFIRMED');
  });
});

describe('AUTO-ASSIGNMENT is post-commit and cannot fail the confirmation', () => {
  it('runs after COMMIT', async () => {
    seed();
    store.withLocation = true;
    await confirmOtp(BOOKING, OTP, { actorUid: CUSTOMER });
    await flush();
    expect(assigned).toEqual([BOOKING]);
    const commit = store.sql.lastIndexOf('COMMIT');
    const lookup = store.sql.findIndex((q) => /JOIN servana\.service_options/.test(q));
    expect(lookup).toBeGreaterThan(commit);
  });

  /**
   * The commit-then-throw defect, fixed.
   *
   * Legacy committed CONFIRMED, then threw `Address missing locationId.` from
   * the assignment lookup — so the customer received HTTP 400 for a booking
   * that was already confirmed. The address was only ever needed for
   * assignment: every earlier branch returned success without it.
   */
  it('a booking with no usable address still confirms', async () => {
    seed();
    store.withLocation = false;
    const booking = await confirmOtp(BOOKING, OTP, { actorUid: CUSTOMER });
    await flush();

    expect(booking.status).toBe('CONFIRMED');
    expect(store.booking?.status).toBe('CONFIRMED');
    expect(assigned).toEqual([]);
  });

  it('an assignment failure does not report the confirmation as failed', async () => {
    seed();
    store.withLocation = true;
    assignFails = true;
    const booking = await confirmOtp(BOOKING, OTP, { actorUid: CUSTOMER });
    await flush();

    expect(booking.status).toBe('CONFIRMED');
    expect(store.transitions).toHaveLength(1);
  });
});

describe('GET /transitions advertises the credential without validating it', () => {
  it('reports CUSTOMER_CONFIRM_OTP available, with requiresCredential', async () => {
    seed();
    const actions = await getAvailableActions(BOOKING, CUSTOMER, 'customer');
    const confirm = actions.find((a) => a.action === 'CUSTOMER_CONFIRM_OTP');

    expect(confirm).toMatchObject({ allowed: true, requiresCredential: 'BOOKING_OTP' });
  });

  it('never reads or compares the code', async () => {
    // The advisory endpoint does not hold the OTP and must not need one to
    // render a button — and must not become an oracle for whether a code is
    // correct.
    seed();
    store.sql.length = 0;
    await getAvailableActions(BOOKING, CUSTOMER, 'customer');
    expect(store.sql.join(' ')).not.toContain('otp_code =');
  });

  it('advertising is not proof — the POST still refuses a wrong code', async () => {
    seed();
    const actions = await getAvailableActions(BOOKING, CUSTOMER, 'customer');
    expect(actions.find((a) => a.action === 'CUSTOMER_CONFIRM_OTP')?.allowed).toBe(true);

    await expect(confirmOtp(BOOKING, '999999', { actorUid: CUSTOMER })).rejects.toThrow();
    expect(store.booking?.status).toBe('PENDING_OTP');
  });
});

/**
 * ─── A MODEL LIMITATION, MADE INTENTIONAL AND OBSERVABLE ─────────────────────
 *
 * `PAID + no worker` and `CONFIRMED + no worker` share one operational
 * reality — nobody is assigned — so both derive to AWAITING_ASSIGNMENT, and
 * that collapse is correct for every purpose except one: whether OTP
 * confirmation may still run.
 *
 * That is action eligibility, not a missing operational state, so it is
 * expressed as a precondition rather than by splitting the state. These tests
 * make the limitation deliberate rather than incidental, and hold the guard to
 * its narrow scope.
 *
 * PROMOTE TO A CANONICAL STATE IF any of these become true — see
 * docs/TAB04_OPEN_GAPS.md:
 *   more than one action needs the distinction; the UI must display it;
 *   notifications, analytics/SLA, assignment, or payment/refund depend on it.
 */
describe('the collapsed pair is intentional and observable', () => {
  const raw = (status: string) => ({ bookingStatus: status, workerStatus: null, workerUid: null });

  it('PAID + no worker: AWAITING_ASSIGNMENT, and confirmation IS allowed', async () => {
    expect(deriveCanonicalState(raw('PAID'))).toBe('AWAITING_ASSIGNMENT');

    seed({ status: 'PAID' });
    const actions = await getAvailableActions(BOOKING, CUSTOMER, 'customer');
    expect(actions.find((a) => a.action === 'CUSTOMER_CONFIRM_OTP')?.allowed).toBe(true);

    await confirmOtp(BOOKING, OTP, { actorUid: CUSTOMER });
    expect(store.booking?.status).toBe('CONFIRMED');
  });

  it('CONFIRMED + no worker: SAME canonical state, and confirmation is REFUSED', async () => {
    expect(deriveCanonicalState(raw('CONFIRMED'))).toBe('AWAITING_ASSIGNMENT');

    seed({ status: 'CONFIRMED' });
    const actions = await getAvailableActions(BOOKING, CUSTOMER, 'customer');
    const confirm = actions.find((a) => a.action === 'CUSTOMER_CONFIRM_OTP');
    expect(confirm?.allowed).toBe(false);
    expect(confirm?.reasonCode).toBe('BOOKING_ALREADY_CONFIRMED');

    await expect(confirmOtp(BOOKING, OTP, { actorUid: CUSTOMER })).rejects.toThrow();
    expect(store.transitions).toHaveLength(0);
  });

  it('the two are indistinguishable to the canonical machine — that is the point', () => {
    // Stated as an assertion so the limitation cannot quietly disappear or
    // quietly widen. If this ever fails because the derivation changed, the
    // guard should be DELETED, not adjusted.
    expect(deriveCanonicalState(raw('PAID'))).toBe(deriveCanonicalState(raw('CONFIRMED')));
  });
});

describe('the guard stays narrow', () => {
  const executor = codeOf('src/services/booking/transitionExecutor.ts');

  it('exactly one action names it', () => {
    // The failure this prevents: a precondition that starts influencing
    // cancellation, assignment, notifications or Admin grouping is a state
    // derivation wearing a guard's name. If a second legitimate consumer
    // appears, that is the signal the distinction is really a missing state.
    const namers = [...executor.matchAll(/guard: '(\w+)'/g)]
      .filter((m) => m[1] === 'bookingAwaitsOtpConfirmation');
    expect(namers).toHaveLength(1);

    const actions = executor.slice(
      executor.indexOf('export const BOOKING_ACTIONS'),
      executor.indexOf('export type BookingAction'),
    );
    const confirmEntry = actions.slice(
      actions.indexOf('CUSTOMER_CONFIRM_OTP:'),
      actions.indexOf('CUSTOMER_CANCEL:') > actions.indexOf('CUSTOMER_CONFIRM_OTP:')
        ? actions.indexOf('CUSTOMER_CANCEL:')
        : undefined,
    );
    expect(confirmEntry).toContain("guard: 'bookingAwaitsOtpConfirmation'");
  });

  it('nothing outside the executor reads it', () => {
    // A projection, controller or service consulting it would be a second
    // opinion about state, which is the thing this whole command removed.
    const SRC = path.resolve(__dirname, '..', 'src');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.ts')) continue;
        const rel = path.relative(SRC, full).split(path.sep).join('/');
        if (rel === 'services/booking/transitionExecutor.ts') continue;
        if (fs.readFileSync(full, 'utf8').includes('bookingAwaitsOtpConfirmation')) offenders.push(rel);
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });

  it('it answers eligibility only — it derives no state', () => {
    const guard = executor.slice(
      executor.indexOf('bookingAwaitsOtpConfirmation: (ctx)'),
      executor.indexOf('export const BOOKING_ACTIONS'),
    );
    expect(guard).not.toContain('deriveCanonicalState');
    expect(guard).not.toContain('canTransition');
    expect(guard).not.toContain('BOOKING_STATES');
  });
});
