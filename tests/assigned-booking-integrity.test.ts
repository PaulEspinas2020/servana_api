import fs from 'fs';
import path from 'path';

import { formatJobCard } from '../src/controllers/jobCardView';

const read = (relative: string) => fs.readFileSync(
  path.join(__dirname, '..', relative),
  'utf8',
).replace(/\r\n/g, '\n');

describe('canonical provider assignment transaction', () => {
  const source = read('src/services/technicianService.ts');
  const start = source.indexOf('const persistWorkerAssignment');
  const body = source.slice(start, source.indexOf('const publishWorkerAssignment', start));

  it('serializes by provider and locks the booking before its CAS', () => {
    expect(body).toContain('pg_advisory_xact_lock');
    expect(body).toContain('FOR UPDATE');
    expect(body).toContain("AND worker_uid IS NULL");
    expect(body).toContain("AND status IN ('CONFIRMED','PAID')");
  });

  it('commits booking, assignment and tracking as one unit', () => {
    expect(body).toContain('await client.query("BEGIN")');
    expect(body).toContain('INSERT INTO ${dbSchema}.booking_workers');
    expect(body).toContain('INSERT INTO ${dbSchema}.booking_tracking');
    expect(body).toContain('await client.query("COMMIT")');
    expect(body).toContain('await client.query("ROLLBACK")');
  });

  it('treats both cancellation spellings and terminal payment states as non-busy', () => {
    expect(body).toContain("'COMPLETED','CANCELED','CANCELLED','REFUNDED','FAILED','EXPIRED'");
  });

  it('never returns the worker verification code from auto assignment', () => {
    const autoStart = source.indexOf('export const assignNearestWorker');
    const auto = source.slice(autoStart, source.indexOf('export const getWorkerSchedule', autoStart));
    expect(auto).not.toMatch(/return\s*\{[^}]*otpCode/s);
  });
});

describe('assignment read projections', () => {
  const service = read('src/services/technicianService.ts');
  const provider = read('src/controllers/providerController.ts');
  const legacy = read('src/controllers/technicianController.ts');

  it('selects one latest worker row and one latest payment row per booking', () => {
    const start = service.indexOf('export const getJobCardsByWorker');
    const body = service.slice(start, service.indexOf('/**', start));
    expect(body).toContain('JOIN LATERAL');
    expect(body).toContain('ORDER BY bw1.assigned_at DESC NULLS LAST, bw1.id DESC');
    expect(body).toContain('ORDER BY p1.id DESC');
  });

  it('loads a single provider card directly instead of filtering the whole feed', () => {
    expect(provider).toContain('technicianService.getJobCardByWorker(uid, bookingId)');
    expect(provider).not.toContain('jobs.find((j: any) => j.booking_id === bookingId)');
  });

  it('uses the same privacy formatter for legacy mobile and provider web', () => {
    expect(legacy).toContain('jobs.map(formatJobCard)');
    expect(provider).toContain('jobs.map(formatJobCard)');
  });

  it('uses worker lifecycle state for provider-web dashboard assignment', () => {
    expect(provider).toContain('bw.worker_status');
    expect(provider).toContain("bw.worker_status IN ('ASSIGNED','ACCEPTED','EN_ROUTE','ARRIVED')");
  });
});

describe('assigned job-card privacy', () => {
  const assigned = formatJobCard({
    booking_id: 42,
    worker_uid: 'provider-1',
    status: 'WORKER_ASSIGNED',
    worker_status: 'ASSIGNED',
    first_name: 'Maria',
    last_name: 'Santos',
    phone_number: '+639171234567',
    customer_id: 'customer-1',
    address_one: '45 Ayala Avenue',
    address_two: 'Unit 5',
    post_town: 'Makati',
    zip_code: '1226',
    country: 'PH',
    label: 'Home',
    delivery_instructions: 'Use the side entrance',
  });

  it('keeps provider ownership while withholding pre-acceptance PII', () => {
    expect(assigned.workerId).toBe('provider-1');
    expect(assigned.customer.name).toBe('Maria S.');
    expect(assigned.customer.phone).toBeNull();
    expect(assigned.address.addressOne).toBeNull();
    expect(assigned.address.instructions).toBeNull();
    expect(assigned.address.city).toBe('Makati');
  });
});

describe('admin assignment writes are transactional', () => {
  const source = read('src/services/adminBookingService.ts');

  /**
   * ADMIN_ASSIGN moved into the canonical executor in D4, so the transaction it
   * runs in is no longer opened here. The property is unchanged and the
   * assertion follows it; `adminReassignProvider` still owns its own
   * transaction until D5, and is still asserted where it lives.
   */
  it('adminAssignProvider commits through the executor transaction', () => {
    const executor = read('src/services/booking/transitionExecutor.ts');
    expect(executor).toContain("await client.query('BEGIN')");
    expect(executor).toContain('FOR UPDATE');
    expect(executor).toContain("await client.query('COMMIT')");
    expect(executor).toContain("await client.query('ROLLBACK')");
    // The tracking row ADMIN_ASSIGN has always written, now a declared
    // projection rather than an inline INSERT.
    expect(executor).toContain("ADMIN_ASSIGN: { status: 'WORKER_ASSIGNED'");

    // And the service no longer runs a transaction of its own.
    const body = source.slice(
      source.indexOf('export const adminAssignProvider'),
      source.indexOf('export const adminReassignProvider'),
    );
    expect(body).not.toContain("await client.query('BEGIN')");
    expect(body).toContain("action: 'ADMIN_ASSIGN'");
  });

  it('adminReassignProvider locks and commits its timeline', () => {
    const start = source.indexOf('export const adminReassignProvider');
    const body = source.slice(start, source.indexOf('export const adminRescheduleBooking', start + 20));
    expect(body).toContain("await client.query('BEGIN')");
    expect(body).toContain('FOR UPDATE');
    expect(body).toContain("await client.query('COMMIT')");
    expect(body).toContain("await client.query('ROLLBACK')");
    expect(body).toContain('booking_tracking');
  });
});
