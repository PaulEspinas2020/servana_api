/**
 * Auto-assignment must respect a provider's own weekly schedule.
 *
 * assignNearestWorker only ever ruled out providers already booked elsewhere;
 * it never asked whether the provider works at that hour at all, so it could
 * hand someone a job on their day off.
 *
 * The subtle half is what "no schedule saved" means. Admin's explainAvailability
 * calls it a blocker — correct when a human asks "can I confirm this provider is
 * free?". Auto-assignment must NOT, because most providers have never saved a
 * schedule and treating that as unavailable would silently stop assigning
 * anyone. These lock both readings of that same state.
 */

jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn() },
}));
jest.mock('../src/config', () => ({ db: { schema: 'servana' } }));

import dbQuery from '../src/db/dbQuery';
import { filterUidsAvailableAt, scheduleCoversWindow } from '../src/services/providerAvailabilityEngine';

const q = dbQuery.query as jest.Mock;

/** Monday 2026-08-10, 10:00–11:00 in the operational Manila timezone. */
const START = new Date('2026-08-10T10:00:00+08:00').toISOString();
const END   = new Date('2026-08-10T11:00:00+08:00').toISOString();
const MONDAY = 1;

/** availability rows, then time-off rows; bootstrap DDL calls resolve empty. */
const respond = (availRows: any[], timeOffRows: any[] = []) => {
  q.mockReset();
  q.mockImplementation((sql: string) => {
    if (/worker_availability\s+WHERE worker_uid = ANY/i.test(sql)) return Promise.resolve({ rows: availRows, rowCount: availRows.length });
    if (/worker_time_off/i.test(sql) && /ANY/i.test(sql))          return Promise.resolve({ rows: timeOffRows, rowCount: timeOffRows.length });
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
};

const slot = (dayOfWeek: number, startTime: string, endTime: string, isAvailable = true) =>
  ({ dayOfWeek, startTime, endTime, isAvailable });

describe('scheduleCoversWindow', () => {
  test('a slot spanning the window covers it', () => {
    expect(scheduleCoversWindow([slot(MONDAY, '09:00', '17:00')], MONDAY, '10:00', '11:00')).toBe('covered');
  });

  test('an empty or missing schedule is reported distinctly, not as unavailable', () => {
    expect(scheduleCoversWindow([], MONDAY, '10:00', '11:00')).toBe('no_schedule');
    expect(scheduleCoversWindow(null, MONDAY, '10:00', '11:00')).toBe('no_schedule');
    expect(scheduleCoversWindow(undefined, MONDAY, '10:00', '11:00')).toBe('no_schedule');
  });

  test('a different weekday does not count', () => {
    expect(scheduleCoversWindow([slot(2, '09:00', '17:00')], MONDAY, '10:00', '11:00')).toBe('day_unavailable');
  });

  test('a slot ending before the window ends does not cover it', () => {
    expect(scheduleCoversWindow([slot(MONDAY, '09:00', '10:30')], MONDAY, '10:00', '11:00')).toBe('outside_window');
  });

  test('a slot flagged unavailable does not count even on the right day', () => {
    expect(scheduleCoversWindow([slot(MONDAY, '09:00', '17:00', false)], MONDAY, '10:00', '11:00')).toBe('day_unavailable');
  });

  test('snake_case rows from the mobile writer are read too', () => {
    const snake = [{ day_of_week: MONDAY, start_time: '09:00', end_time: '17:00', isAvailable: true }];
    expect(scheduleCoversWindow(snake, MONDAY, '10:00', '11:00')).toBe('covered');
  });
});

describe('filterUidsAvailableAt — auto-assignment reading', () => {
  test('keeps a provider whose schedule covers the booking', async () => {
    respond([{ worker_uid: 'w1', schedule: [slot(MONDAY, '09:00', '17:00')] }]);
    const r = await filterUidsAvailableAt(['w1'], START, END, { missingScheduleIsAvailable: true });
    expect(r.eligible).toEqual(['w1']);
    expect(r.excluded).toEqual([]);
  });

  test('drops a provider whose schedule excludes that day', async () => {
    respond([{ worker_uid: 'w1', schedule: [slot(3, '09:00', '17:00')] }]);
    const r = await filterUidsAvailableAt(['w1'], START, END, { missingScheduleIsAvailable: true });
    expect(r.eligible).toEqual([]);
    expect(r.excluded).toEqual([{ uid: 'w1', reason: 'DAY_NOT_AVAILABLE' }]);
  });

  test('drops a provider booked outside their hours', async () => {
    respond([{ worker_uid: 'w1', schedule: [slot(MONDAY, '13:00', '17:00')] }]);
    const r = await filterUidsAvailableAt(['w1'], START, END, { missingScheduleIsAvailable: true });
    expect(r.excluded).toEqual([{ uid: 'w1', reason: 'OUTSIDE_SCHEDULE_WINDOW' }]);
  });

  test('KEEPS a provider who has never configured a schedule', async () => {
    // The regression that matters: excluding these would empty the candidate
    // pool on live data, where most providers have no schedule row at all.
    respond([]);
    const r = await filterUidsAvailableAt(['w1', 'w2'], START, END, { missingScheduleIsAvailable: true });
    expect(r.eligible).toEqual(['w1', 'w2']);
    expect(r.excluded).toEqual([]);
  });

  test('drops a provider on active time-off even when the schedule fits', async () => {
    respond([{ worker_uid: 'w1', schedule: [slot(MONDAY, '09:00', '17:00')] }], [{ worker_uid: 'w1' }]);
    const r = await filterUidsAvailableAt(['w1'], START, END, { missingScheduleIsAvailable: true });
    expect(r.eligible).toEqual([]);
    expect(r.excluded).toEqual([{ uid: 'w1', reason: 'TIME_OFF' }]);
  });

  test('filters a mixed pool down to only the genuinely available', async () => {
    respond(
      [
        { worker_uid: 'fits',    schedule: [slot(MONDAY, '09:00', '17:00')] },
        { worker_uid: 'wrongday', schedule: [slot(6, '09:00', '17:00')] },
        { worker_uid: 'offhours', schedule: [slot(MONDAY, '18:00', '22:00')] },
      ],
      [{ worker_uid: 'onleave' }],
    );
    const r = await filterUidsAvailableAt(
      ['fits', 'wrongday', 'offhours', 'onleave', 'nosched'], START, END,
      { missingScheduleIsAvailable: true },
    );
    expect(r.eligible.sort()).toEqual(['fits', 'nosched']);
    expect(r.excluded.map(e => e.uid).sort()).toEqual(['offhours', 'onleave', 'wrongday']);
  });

  test('an empty candidate list short-circuits without querying', async () => {
    respond([]);
    const r = await filterUidsAvailableAt([], START, END, { missingScheduleIsAvailable: true });
    expect(r).toEqual({ eligible: [], excluded: [] });
    expect(q).not.toHaveBeenCalled();
  });

  test('queries once per concern, not once per provider', async () => {
    // A per-provider call would be an N+1 against the assignment hot path (§56).
    respond([{ worker_uid: 'w1', schedule: [slot(MONDAY, '09:00', '17:00')] }]);
    await filterUidsAvailableAt(['w1', 'w2', 'w3', 'w4', 'w5'], START, END, { missingScheduleIsAvailable: true });
    const setBased = q.mock.calls.filter(([sql]: [string]) => /ANY\(\$1::text\[\]\)/.test(sql));
    expect(setBased).toHaveLength(2); // availability + time-off
  });
});

describe('filterUidsAvailableAt — Admin reading', () => {
  test('drops an unconfigured provider when missing schedule is not treated as available', async () => {
    respond([]);
    const r = await filterUidsAvailableAt(['w1'], START, END, { missingScheduleIsAvailable: false });
    expect(r.eligible).toEqual([]);
    expect(r.excluded).toEqual([{ uid: 'w1', reason: 'NO_AVAILABILITY_SET' }]);
  });
});
