import fs from 'fs';
import path from 'path';

/**
 * Providers who declined a booking must not be re-offered the same booking.
 *
 * Ranking in `assignNearestWorker` is by haversine distance alone, and
 * `releaseBookingAndReassign` calls straight back into it on decline. Without an
 * exclusion the nearest provider who just refused the job is deterministically
 * the next one offered it — production booking 94 recorded the same provider
 * declining three times and being re-selected each time.
 *
 * Source introspection matches the convention already used for this file in
 * `assigned-booking-integrity.test.ts`: `assignNearestWorker` reaches Postgres,
 * MongoDB and the availability engine, and mocking all three would test the
 * mocks. CRLF is normalised because these assertions run on Windows checkouts.
 */
const read = (relative: string) => fs.readFileSync(
  path.join(__dirname, '..', relative),
  'utf8',
).replace(/\r\n/g, '\n');

describe('decline exclusion in automatic assignment', () => {
  const source = read('src/services/technicianService.ts');
  const start = source.indexOf('export const assignNearestWorker');
  const auto = source.slice(start, source.indexOf('export const getWorkerSchedule', start));

  it('reads prior declines for THIS booking before ranking', () => {
    expect(auto).toContain('FROM ${dbSchema}.booking_workers');
    expect(auto).toContain("status = 'DECLINED'");
    // Scoped by booking_id — a decline is a statement about one job, not about
    // the provider. Filtering them out globally would remove a willing worker
    // from every future booking.
    expect(auto).toMatch(/WHERE booking_id = \$1 AND status = 'DECLINED'/);
  });

  it('removes decliners from the candidate pool, not merely logs them', () => {
    expect(auto).toMatch(/filter\(\(w: any\) => !declined\.has\(w\.uid\)\)/);
  });

  it('escalates instead of retrying when every eligible provider declined', () => {
    // §44: "Do not endlessly retry." A pool that has already refused this
    // booking has no new information to offer on a second pass.
    expect(auto).toContain('ALL_ELIGIBLE_WORKERS_DECLINED');
  });

  it('distinguishes "nobody available" from "everybody declined"', () => {
    // Two different operational problems needing two different responses:
    // recruit/adjust schedules, versus look at why this job is being refused.
    expect(auto).toContain('NO_WORKER_AVAILABLE_IN_SCHEDULE');
    expect(auto).toContain('ALL_ELIGIBLE_WORKERS_DECLINED');
  });

  it('fails open, so a broken query cannot strand a live booking', () => {
    // Deliberately unlike the availability filter, and the asymmetry is the
    // point: proceeding unfiltered past a failed AVAILABILITY check can hand a
    // provider a job on their day off, while proceeding past a failed DECLINE
    // check only restores the previous inefficiency.
    const block = auto.slice(auto.indexOf('3b. Exclude providers'));
    expect(block).toContain('decline filter failed, proceeding unfiltered');
  });

  it('still applies the transport fee on the escalation path', () => {
    // The pre-existing no-candidate path does this, and the new one must not
    // quietly skip it — the fee is derived from distance and the customer sees
    // it regardless of whether a provider was found.
    const escalation = auto.slice(auto.indexOf('ALL_ELIGIBLE_WORKERS_DECLINED') - 400);
    expect(escalation).toContain('applyNearestWorkerTranspoFee');
  });
});
