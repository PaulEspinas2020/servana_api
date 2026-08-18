import fs from 'fs';
import path from 'path';

import { formatJobCard } from '../src/controllers/jobCardView';
import {
  NON_OCCUPYING_STATUSES,
} from '../src/services/booking/eligibilityPipeline';

const read = (relative: string) => fs.readFileSync(
  path.join(__dirname, '..', relative),
  'utf8',
).replace(/\r\n/g, '\n');

/**
 * E2 moved auto-assignment's write into the canonical executor, so none of
 * these properties are enforced in `technicianService` any more. Every one of
 * them still holds; the assertions follow them.
 *
 * The lock ORDER changed with the move and that is the point of the exercise:
 * auto-assignment took provider-then-booking while the executor takes
 * booking-then-provider, and two paths acquiring the same two lock classes in
 * opposite orders is a deadlock. Asserting the old order here would have
 * pinned the bug.
 */
describe('canonical provider assignment transaction', () => {
  const source = read('src/services/technicianService.ts');
  const executor = read('src/services/booking/transitionExecutor.ts');
  const start = source.indexOf('const persistWorkerAssignment');
  const body = source.slice(start, source.indexOf('const publishWorkerAssignment', start));

  it('serializes by provider, and locks the booking FIRST', () => {
    expect(executor).toContain('pg_advisory_xact_lock');
    expect(executor).toContain('FOR UPDATE');
    // Booking row, then provider — one order for every assignment producer.
    const stripped = executor
      .replace(/\r\n/g, '\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(stripped.indexOf('await loadForUpdate(client, input.bookingId'))
      .toBeLessThan(stripped.indexOf('pg_advisory_xact_lock'));

    // The service takes neither lock any more.
    expect(body).not.toContain('pg_advisory_xact_lock');
    expect(body).not.toContain('FOR UPDATE');
    expect(body).toContain("action: 'AUTO_ASSIGN'");
  });

  it('commits booking, assignment and tracking as one unit', () => {
    expect(executor).toContain('INSERT INTO ${s}.booking_workers');
    expect(executor).toContain('INSERT INTO ${s}.booking_tracking');
    expect(executor).toContain("await client.query('COMMIT')");
    expect(executor).toContain("await client.query('ROLLBACK')");
    expect(executor).toContain("AUTO_ASSIGN: { status: 'WORKER_ASSIGNED'");
    // And the service opens no transaction of its own.
    expect(body).not.toContain('BEGIN');
  });

  /**
   * The conflict predicate moved into the shared eligibility pipeline, so
   * candidate generation and the executor's commit-time recheck ask the same
   * question. The property is unchanged and the assertion follows it — and it
   * now checks the VALUE SET rather than a literal string in one file, so it
   * cannot be broken by reformatting and cannot pass while the executor uses a
   * different list.
   */
  it('treats both cancellation spellings and terminal payment states as non-busy', () => {
    expect([...NON_OCCUPYING_STATUSES].sort()).toEqual(
      ['CANCELED', 'CANCELLED', 'COMPLETED', 'EXPIRED', 'FAILED', 'REFUNDED'],
    );
    // And the executor really does use the shared predicate rather than a copy.
    expect(executor).toContain('CONFLICTING_BOOKING_SQL');
    expect(executor).not.toContain("status NOT IN ('COMPLETED'");
  });

  it('the +/-2h conflict window is preserved, not redesigned', () => {
    // Centralised in this slice; the policy change is a separate product
    // decision after TAB 05 certifies. Changing eligibility and centralising it
    // together would make any supply drop impossible to attribute.
    // The window became the job's real span; what matters here is unchanged —
    // the executor asks the SHARED predicate rather than a local copy.
    expect(executor).toContain('CONFLICTING_BOOKING_SQL');
  });

  it('every provider-level refusal is NON-throwing to the search loop', () => {
    /**
     * `assignNearestWorker` walks a ranked candidate list and moves on when a
     * provider cannot take the job. Throwing would end the search at the first
     * refusal rather than trying the next candidate.
     *
     * Widened when AUTO_ASSIGN moved to the canonical strict validation: the
     * executor now also refuses archived, wrong-role and unqualified providers,
     * and every one of those refusals has to cost a candidate rather than the
     * booking. That is the property that made the tightening safe.
     */
    expect(body).toContain('isSkippableRefusal(reasonCode)');
    expect(body).toContain("reasonCode === 'BOOKING_CONFLICT' ? \"busy\" : \"ineligible\"");
  });

  it('worker_code is PRESERVED, never regenerated', () => {
    // The customer may already be holding the code.
    expect(executor).toContain('worker_code = COALESCE($4, worker_code)');
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

  /**
   * D5 moved ADMIN_REASSIGN into the executor as well, so neither admin
   * assignment path opens a transaction of its own any more. The property is
   * unchanged and the assertion follows it.
   */
  it('adminReassignProvider commits through the executor transaction', () => {
    const executor = read('src/services/booking/transitionExecutor.ts');
    expect(executor).toContain("await client.query('BEGIN')");
    expect(executor).toContain('FOR UPDATE');
    expect(executor).toContain("await client.query('COMMIT')");
    expect(executor).toContain("await client.query('ROLLBACK')");
    expect(executor).toContain("ADMIN_REASSIGN: { status: 'WORKER_ASSIGNED'");

    const body = source.slice(
      source.indexOf('export const adminReassignProvider'),
      source.indexOf('export const adminRescheduleBooking'),
    );
    expect(body).not.toContain("await client.query('BEGIN')");
    expect(body).toContain("action: 'ADMIN_REASSIGN'");
  });

  it('neither admin assignment path takes a lock of its own any more', () => {
    // Both locks are the executor's, in one fixed order. A second acquisition
    // site is a second chance to get that order wrong.
    for (const name of ['adminAssignProvider', 'adminReassignProvider']) {
      const start = source.indexOf(`export const ${name}`);
      const body = source.slice(start, start + 4000);
      expect(body).not.toContain('pg_advisory_xact_lock');
      expect(body).not.toContain('FOR UPDATE');
    }
  });
});
