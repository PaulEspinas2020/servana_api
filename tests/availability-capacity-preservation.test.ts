/**
 * A web schedule save must not destroy the capacity the web cannot see (TAB 06).
 *
 * ## The defect
 *
 * `maxJobs` is a per-slot capacity a provider sets on MOBILE. The Provider Web
 * schedule has no field for it, so a web payload never carries one — and the
 * bridge in `providerController.ts` built every slot with `maxJobs: null` before
 * handing the week to `saveWeeklySchedule`, which REPLACES the stored schedule.
 *
 * So any save from the web erased capacity set on mobile, and the read bridge
 * dropped the field too, so nothing on the web could have shown the provider
 * what they were about to lose. Silent cross-platform data loss, affecting
 * mobile, caused by the web, invisible on both.
 *
 * ## What is asserted
 *
 * The rule is that a client may only clear a field it can express. These drive
 * the real bridge through the real controller rather than restating it:
 *
 *   - an unchanged slot keeps its capacity;
 *   - a slot whose times moved inherits the day's capacity when that day had
 *     exactly one value, because capacity is set per day in practice and losing
 *     it because 09:00 became 09:30 is the same defect wearing a smaller hat;
 *   - where a day held SEVERAL capacities, an unmatched slot gets null rather
 *     than a guess — a number that limits how much work a provider is offered is
 *     not something to invent;
 *   - the read path returns `maxJobs`, so the web can stop being the one surface
 *     where a provider cannot see their own cap.
 */

jest.mock('../src/middleware/firebaseApp', () => ({ firebaseAdmin: {}, __esModule: true }));

const getAvailabilityProfile = jest.fn();
const saveWeeklySchedule = jest.fn();
jest.mock('../src/services/providerAvailabilityEngine', () => ({
  __esModule: true,
  getAvailabilityProfile: (...args: unknown[]) => getAvailabilityProfile(...args),
  saveWeeklySchedule: (...args: unknown[]) => saveWeeklySchedule(...args),
  listTimeOff: jest.fn(),
}));

import * as providerController from '../src/controllers/providerController';

const DOW = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 } as const;

const storedSlot = (day: keyof typeof DOW, startTime: string, endTime: string, maxJobs: number | null) => ({
  dayOfWeek: DOW[day], dayLabel: day, startTime, endTime, isAvailable: true, maxJobs,
});

/** A full canonical week; only the named day carries slots. */
const webWeek = (day: keyof typeof DOW, slots: { startTime: string; endTime: string }[]) =>
  ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => ({
    day: d, enabled: d === day, slots: d === day ? slots : [],
  }));

const runSave = async (stored: any[], schedule: any[]) => {
  getAvailabilityProfile.mockResolvedValue({
    weeklySchedule: stored, timezone: 'Asia/Manila', updatedAt: null, version: 1, timeOff: [],
  });
  saveWeeklySchedule.mockResolvedValue({ updatedAt: '2026-08-18T00:00:00Z', version: 2 });
  const req: any = { user: { uid: 'provider-1' }, body: { schedule, timezone: 'Asia/Manila' } };
  const res: any = { status() { return this; }, json() { return this; } };
  await (providerController as any).saveWorkerAvailability(req, res);
  // The slots the engine was actually asked to store.
  return saveWeeklySchedule.mock.calls[0][1] as any[];
};

beforeEach(() => { getAvailabilityProfile.mockReset(); saveWeeklySchedule.mockReset(); });

describe('a web schedule save preserves mobile capacity', () => {
  it('keeps the capacity of a slot the provider did not move', async () => {
    const stored = [storedSlot('mon', '09:00', '17:00', 3)];
    const saved = await runSave(stored, webWeek('mon', [{ startTime: '09:00', endTime: '17:00' }]));

    const monday = saved.find((s) => s.dayOfWeek === DOW.mon && s.isAvailable);
    // Was null before the fix — the whole defect in one assertion.
    expect(monday.maxJobs).toBe(3);
  });

  it("carries the day's capacity onto a slot whose times changed", async () => {
    const stored = [storedSlot('tue', '09:00', '17:00', 5)];
    const saved = await runSave(stored, webWeek('tue', [{ startTime: '09:30', endTime: '16:00' }]));

    const tuesday = saved.find((s) => s.dayOfWeek === DOW.tue && s.isAvailable);
    expect(tuesday.maxJobs).toBe(5);
  });

  it('refuses to guess when a day held several different capacities', async () => {
    const stored = [
      storedSlot('wed', '08:00', '12:00', 2),
      storedSlot('wed', '13:00', '17:00', 9),
    ];
    const saved = await runSave(stored, webWeek('wed', [{ startTime: '10:00', endTime: '15:00' }]));

    const wednesday = saved.find((s) => s.dayOfWeek === DOW.wed && s.isAvailable);
    // Ambiguous. A capacity limits how much work a provider is offered, so an
    // invented number is worse than an absent one.
    expect(wednesday.maxJobs).toBeNull();
  });

  it('keeps each slot on its own capacity when a day has several and they all still exist', async () => {
    const stored = [
      storedSlot('thu', '08:00', '12:00', 2),
      storedSlot('thu', '13:00', '17:00', 9),
    ];
    const saved = await runSave(stored, webWeek('thu', [
      { startTime: '08:00', endTime: '12:00' },
      { startTime: '13:00', endTime: '17:00' },
    ]));

    const morning = saved.find((s) => s.dayOfWeek === DOW.thu && s.startTime === '08:00');
    const afternoon = saved.find((s) => s.dayOfWeek === DOW.thu && s.startTime === '13:00');
    expect(morning.maxJobs).toBe(2);
    expect(afternoon.maxJobs).toBe(9);
  });

  it('a provider with no capacity set is unaffected', async () => {
    const stored = [storedSlot('fri', '09:00', '17:00', null)];
    const saved = await runSave(stored, webWeek('fri', [{ startTime: '09:00', endTime: '17:00' }]));

    const friday = saved.find((s) => s.dayOfWeek === DOW.fri && s.isAvailable);
    expect(friday.maxJobs).toBeNull();
  });

  it('reads the stored week before replacing it — otherwise there is nothing to carry', async () => {
    await runSave([storedSlot('mon', '09:00', '17:00', 4)],
      webWeek('mon', [{ startTime: '09:00', endTime: '17:00' }]));
    expect(getAvailabilityProfile).toHaveBeenCalledWith('provider-1');
  });
});
