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
    expect(booking).toContain("status='PAID' AND worker_uid IS NULL");
    expect(booking).toContain("status === 'PAID' && !booking.worker_uid");
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
