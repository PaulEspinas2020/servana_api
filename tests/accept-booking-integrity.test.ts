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

  /**
   * B1.1 moved the transaction into the canonical executor. These two
   * properties are unchanged — they are simply no longer enforced in this
   * file, so the assertions follow them rather than the code that used to
   * carry them. Asserting the old location would have failed a migration that
   * kept every guarantee intact, which is how a real guard gets deleted.
   */
  const executor = fs.readFileSync(
    path.join(__dirname, '../src/services/booking/transitionExecutor.ts'),
    'utf8',
  );

  it('locks the booking and assignment before the write', () => {
    // acceptJob no longer takes locks itself; it must therefore take none.
    expect(body).toContain("action: 'PROVIDER_ACCEPT'");
    expect(body).not.toContain('FOR UPDATE');
    expect(executor.match(/FOR UPDATE/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('classifies a refusal from the snapshot read under that lock', () => {
    // The six-code contract survives only if it is derived from the same rows
    // the refusal was. A second read here would be a different moment.
    expect(body).toContain('asAcceptanceConflict(error, workerUid)');
    expect(source).toContain('error.snapshot?.bookingWorkerUid ?? null');
  });

  it('commits acceptance and customer timeline together', () => {
    const tracking = executor.indexOf("PROVIDER_ACCEPT: { status: 'ACCEPTED', note: 'Provider accepted the booking' }");
    expect(tracking).toBeGreaterThan(-1);
    // Written by the executor, inside the transaction, before COMMIT.
    expect(executor.indexOf('await writeLegacyTracking(client'))
      .toBeLessThan(executor.indexOf("client.query('COMMIT')"));
    // And no longer written twice.
    expect(body).not.toContain('booking_tracking');
  });

  it('uses recipient-scoped, PII-safe customer notification metadata', () => {
    expect(body).toContain('createCustomerNotification(customerUid');
    expect(body).toContain('notificationKey: `booking_accepted_${bookingId}`');
    expect(body).toContain('routeKey: "BOOKING_DETAILS"');
    expect(body).not.toContain('customerUid: workerUid');
  });
});
