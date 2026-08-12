import fs from 'fs';
import path from 'path';

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
    // Resend still checks it inline. Confirmation moved to the canonical
    // executor in Phase C, so the SQL clause it used to assert is gone — the
    // capability is now carried by the `bookingAwaitsOtpConfirmation` guard,
    // which is where the assertion follows it. Deleting the check would drop a
    // real guarantee: a payment-first booking holding a valid code must still
    // be confirmable.
    expect(booking).toContain("status === 'PAID' && !booking.worker_uid");

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
