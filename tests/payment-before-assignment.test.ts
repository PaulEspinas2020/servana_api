import fs from 'fs';
import path from 'path';
import { deriveCanonicalState } from '../src/services/booking/canonicalState';
import { otpAppliesInState } from '../src/services/booking/experiencePolicy';

const read = (...parts: string[]) =>
  fs.readFileSync(path.join(__dirname, '..', 'src', ...parts), 'utf8');

describe('payment before worker assignment', () => {
  const payment = read('services', 'paymentService.ts');
  const booking = read('services', 'bookingService.ts');
  const dashboard = read('services', 'adminDashboardService.ts');

  test('PayMongo never overwrites the booking lifecycle with PAID', () => {
    const paidBranch = payment.slice(
      payment.indexOf('if (eventType === "checkout_session.payment.paid")'),
      payment.indexOf('if (eventType === "checkout_session.payment.failed")'),
    );
    expect(paidBranch).toContain("SET status = 'PAID'");
    expect(paidBranch).not.toMatch(
      /UPDATE\s+\$\{dbSchema\}\.bookings[\s\S]{0,100}SET status\s*=\s*'PAID'/,
    );
  });

  test('legacy paid-but-unassigned bookings can confirm and resend OTP', () => {
    // The guarantee: a payment-first booking holding a valid code must still be
    // confirmable, and must still be able to get a new code.
    //
    // The assertion has now followed the check TWICE. Confirmation moved to the
    // canonical executor in Phase C, so the SQL clause became the
    // `bookingAwaitsOtpConfirmation` guard. Resend's inline
    // `status === 'PAID' && !booking.worker_uid` moved in TAB 06 into the OTP
    // purpose's declared `validStates` — and it survives there because
    // `deriveCanonicalState` maps exactly that shape (PAID, no worker uid) to
    // AWAITING_ASSIGNMENT, which the purpose lists.
    //
    // Asserted through the real derivation rather than by reading source, so
    // this cannot pass on a list that merely LOOKS right.
    const rawPaidUnassigned = { bookingStatus: 'PAID', workerStatus: null, workerUid: null };
    expect(deriveCanonicalState(rawPaidUnassigned)).toBe('AWAITING_ASSIGNMENT');
    expect(otpAppliesInState('BOOKING_CONFIRMATION', deriveCanonicalState(rawPaidUnassigned)))
      .toBe(true);

    // And the narrowing that must NOT be lost: once a provider is on it, the
    // moment for confirmation has passed.
    expect(
      otpAppliesInState(
        'BOOKING_CONFIRMATION',
        deriveCanonicalState({ bookingStatus: 'PAID', workerStatus: null, workerUid: 'worker-1' }),
      ),
    ).toBe(false);

    const executor = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'services', 'booking', 'transitionExecutor.ts'),
      'utf8',
    );
    const guard = executor.slice(
      executor.indexOf('bookingAwaitsOtpConfirmation: (ctx)'),
      executor.indexOf('export const BOOKING_ACTIONS'),
    );
    expect(guard).toContain("status === 'PAID' && !ctx.metadata.hasProvider");
    expect(guard).toContain("status === 'PENDING_OTP'");
  });

  test('operations counts read authoritative payment status', () => {
    expect(dashboard).toMatch(
      /ops_status = 'awaiting_assignment'[\s\S]{0,80}pay_status = 'PAID'/,
    );
    expect(dashboard).not.toMatch(
      /ops_status = 'awaiting_assignment'[\s\S]{0,80}raw_status = 'PAID'/,
    );
  });
});
