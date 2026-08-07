import fs from 'fs';
import path from 'path';

const source = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'bookingService.ts'),
  'utf8',
);
const create = source.slice(
  source.indexOf('export const createBooking'),
  source.indexOf('export const resendBookingOtp'),
);

describe('customer booking creation contract', () => {
  test('accepts every payment method emitted by both client checkout flows', () => {
    expect(create).toMatch(
      /paymentMethod:\s*"CASH"\s*\|\s*"GCASH"\s*\|\s*"PAYMONGO"/,
    );
  });

  test('booking and payment rows share one database transaction', () => {
    expect(create).toContain('const client = await pool.connect()');
    expect(create).toContain("client.query('BEGIN')");
    expect(create).toContain("client.query('COMMIT')");
    expect(create).toContain("client.query('ROLLBACK')");
    expect(create).toContain('client.release()');

    const bookingInsert = create.indexOf('INSERT INTO ${dbSchema}.bookings');
    const paymentInsert = create.indexOf('INSERT INTO ${dbSchema}.payments');
    const commit = create.indexOf("client.query('COMMIT')");
    expect(bookingInsert).toBeGreaterThan(-1);
    expect(paymentInsert).toBeGreaterThan(bookingInsert);
    expect(commit).toBeGreaterThan(paymentInsert);
  });

  test('notification work happens only after the transaction commits', () => {
    expect(create.indexOf("client.query('COMMIT')")).toBeLessThan(
      create.indexOf('getEmailById(userId)'),
    );
  });

  test('idempotency record commits atomically with booking and payment', () => {
    const paymentInsert = create.indexOf('INSERT INTO ${dbSchema}.payments');
    const keyInsert = create.indexOf(
      'INSERT INTO ${dbSchema}.booking_create_idempotency',
    );
    const commit = create.indexOf("client.query('COMMIT')");
    expect(keyInsert).toBeGreaterThan(paymentInsert);
    expect(commit).toBeGreaterThan(keyInsert);
    expect(create).not.toContain('ON CONFLICT DO NOTHING');
  });
});
