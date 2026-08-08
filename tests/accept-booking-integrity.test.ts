import fs from 'fs';
import path from 'path';

import { acceptanceConflictForSnapshot } from '../src/services/bookingResponseConflict';
import { deriveEffectiveBookingStatus } from '../src/services/bookingStatusProjection';

describe('accept booking ownership and stale-state policy', () => {
  const current = (overrides: Partial<Parameters<typeof acceptanceConflictForSnapshot>[0]> = {}) => ({
    bookingStatus: 'WORKER_ASSIGNED',
    bookingWorkerUid: 'provider-a',
    assignmentStatus: 'ASSIGNED',
    workerUid: 'provider-a',
    ...overrides,
  });

  it('allows only the provider named by both current projections', () => {
    expect(acceptanceConflictForSnapshot(current())).toBeNull();
  });

  it('rejects a stale ASSIGNED row after reassignment without leaking the replacement', () => {
    const conflict = acceptanceConflictForSnapshot(current({ bookingWorkerUid: 'provider-b' }));
    expect(conflict?.code).toBe('NO_LONGER_ASSIGNED');
    expect(conflict?.providerMessage).not.toContain('provider-b');
  });

  it.each(['CANCELLED', 'CANCELED'])('rejects acceptance after booking %s', (bookingStatus) => {
    expect(acceptanceConflictForSnapshot(current({ bookingStatus }))?.code).toBe('BOOKING_CANCELLED');
  });

  it('keeps a duplicate accept idempotent', () => {
    const conflict = acceptanceConflictForSnapshot(current({ assignmentStatus: 'ACCEPTED' }));
    expect(conflict?.code).toBe('ALREADY_ACCEPTED_BY_YOU');
    expect(conflict?.httpStatus).toBe(200);
  });
});

describe('cross-platform effective booking status', () => {
  it('surfaces provider acceptance without mutating bookings.status', () => {
    expect(deriveEffectiveBookingStatus('WORKER_ASSIGNED', 'ACCEPTED')).toBe('ACCEPTED');
  });

  it('lets booking cancellation override a stale accepted assignment', () => {
    expect(deriveEffectiveBookingStatus('CANCELLED', 'ACCEPTED')).toBe('CANCELLED');
  });

  it('does not promote assignment into acceptance', () => {
    expect(deriveEffectiveBookingStatus('WORKER_ASSIGNED', 'ASSIGNED')).toBe('WORKER_ASSIGNED');
  });
});

describe('transaction and notification contract', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/services/technicianService.ts'), 'utf8');
  const start = source.indexOf('export const acceptJob');
  const body = source.slice(start, source.indexOf('export const cancelAcceptedJob', start));

  it('locks the booking and assignment before the CAS', () => {
    expect(body.match(/FOR UPDATE/g)?.length).toBeGreaterThanOrEqual(2);
    expect(body).toContain('bookingWorkerUid: booking?.worker_uid ?? null');
  });

  it('commits acceptance and customer timeline together', () => {
    expect(body).toContain('await client.query("BEGIN")');
    expect(body).toContain("VALUES ($1, 'ACCEPTED', 'Provider accepted the booking')");
    expect(body).toContain('await client.query("COMMIT")');
    expect(body.indexOf("VALUES ($1, 'ACCEPTED'")).toBeLessThan(body.indexOf('await client.query("COMMIT")'));
  });

  it('uses recipient-scoped, PII-safe customer notification metadata', () => {
    expect(body).toContain('createCustomerNotification(customerUid');
    expect(body).toContain('notificationKey: `booking_accepted_${bookingId}`');
    expect(body).toContain('routeKey: "BOOKING_DETAILS"');
    expect(body).not.toContain('customerUid: workerUid');
  });
});
