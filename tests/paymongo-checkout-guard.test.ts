import fs from 'fs';
import path from 'path';

const source = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'paymentService.ts'),
  'utf8',
);

describe('PayMongo checkout creation guard', () => {
  const start = source.indexOf('export const createCheckoutSession');
  const end = source.indexOf('const PAYMONGO_WEBHOOK_SECRET', start);
  const create = source.slice(start, end);

  test('isolates checkout from cash and terminal bookings', () => {
    expect(create).toContain('booking.method');
    expect(create).toContain('!== "PAYMONGO"');
    expect(create).toContain('This booking is not configured for PayMongo');
    expect(create).toContain('Payment cannot be started for an inactive booking');
  });

  test('does not create sessions for paid or invalid amounts', () => {
    expect(create).toContain('booking.payment_status');
    expect(create).toContain('This booking is already paid');
    expect(create).toContain('amount <= 0');
  });

  test('reuses only recent pending PayMongo checkout URLs', () => {
    expect(create).toContain('2 * 60 * 60 * 1000');
    expect(create).toContain('booking.checkout_url');
    expect(create).toContain('booking.provider');
    expect(create).toContain('=== "PENDING"');
  });

  test('remains independent from worker assignment', () => {
    expect(create).not.toContain('worker_uid');
    expect(create).not.toContain('booking_workers');
  });
});
