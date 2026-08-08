/**
 * Availability matching must happen in the operational timezone.
 *
 * Command 22 §5. Production runs `Etc/UTC` with `TZ` unset — measured on the
 * host, not assumed. `windowParts` derived the weekday and HH:mm of a booking
 * with `Date.getDay()` and `Date.getHours()`, which are SERVER-LOCAL. In Manila
 * (UTC+8) that shifts every booking back eight hours:
 *
 *   Monday 09:00 Manila  ->  Monday 01:00 UTC   (right day, wrong hours)
 *   Monday 07:00 Manila  ->  Sunday 23:00 UTC   (wrong day AND hours)
 *
 * `scheduleCoversWindow` then compares those shifted values against rules the
 * provider entered in local time ("08:00"–"17:00"), so a provider working
 * ordinary daytime hours is judged OUTSIDE their own schedule.
 *
 * ── Why this became urgent ──────────────────────────────────────────────────
 * The bug was dormant: `filterUidsAvailableAt` treats a provider with NO saved
 * schedule as available, and almost nobody had one. Masterlist D-10 shipped a
 * working availability editor. From that point on, SAVING a schedule is what
 * makes a provider ineligible during their own working hours — the exact
 * opposite of what the editor promises.
 */
jest.mock("../src/db/dbQuery", () => ({
  __esModule: true,
  default: { query: jest.fn() },
}));
jest.mock("../src/config", () => ({
  __esModule: true,
  db: { schema: "test" },
}));

import {
  windowParts,
  scheduleCoversWindow,
  validateWeeklySchedule,
} from "../src/services/providerAvailabilityEngine";
import { zonedDateTimeToUtc } from "../src/services/operationalTimezone";

/** A provider working ordinary Philippine office hours, Monday to Friday. */
const WEEKDAY_9_TO_5 = [1, 2, 3, 4, 5].map((dayOfWeek) => ({
  dayOfWeek,
  isAvailable: true,
  startTime: "08:00",
  endTime: "17:00",
}));

describe('schedule boundary hardening', () => {
  it('rejects clock-shaped nonsense and invalid scalar types', () => {
    const errors = validateWeeklySchedule([{
      dayOfWeek: '1' as any,
      dayLabel: 'Monday',
      startTime: '29:99',
      endTime: '17:00',
      isAvailable: 'true' as any,
      maxJobs: 0,
    }]);
    expect(errors.join(' ')).toMatch(/dayOfWeek/);
    expect(errors.join(' ')).toMatch(/real HH:mm/);
    expect(errors.join(' ')).toMatch(/isAvailable/);
    expect(errors.join(' ')).toMatch(/maxJobs/);
  });

  it('converts Manila wall time without depending on the host clock', () => {
    expect(zonedDateTimeToUtc('2026-08-10', '09:00').toISOString())
      .toBe('2026-08-10T01:00:00.000Z');
  });
});

/**
 * The point is that the answer no longer depends on where it is computed.
 *
 * An earlier version of this asserted `getTimezoneOffset() === 0` to pin "the
 * production environment". That was the wrong test: it passes on the UTC
 * deploy host and fails on a UTC+8 developer machine, while the code under
 * test is correct on both. It pinned the runner instead of the behaviour.
 *
 * Every expectation in this file is an absolute Manila value, so the suite
 * passing under two different host timezones IS the host-independence proof.
 */
describe("the derivation cannot fall back to host-local time", () => {
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  const engine = fs
    .readFileSync(
      path.join(__dirname, "..", "src/services/providerAvailabilityEngine.ts"),
      "utf8"
    )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

  it("the engine no longer reads weekday or hours from the host clock", () => {
    // These are the exact calls that made production answer in UTC.
    expect(engine).not.toMatch(/\.getDay\(\)/);
    expect(engine).not.toMatch(/\.getHours\(\)/);
  });

  it("availability windows go through the operational timezone module", () => {
    expect(engine).toMatch(/from '\.\/operationalTimezone'/);
  });
});

describe("weekday and time come from the operational timezone", () => {
  it("a Monday 09:00 Manila booking is Monday 09:00, not Monday 01:00", () => {
    const p = windowParts("2026-08-10T09:00:00+08:00", "2026-08-10T11:00:00+08:00");

    expect(p.dow).toBe(1); // Monday
    expect(p.startTime).toBe("09:00");
    expect(p.endTime).toBe("11:00");
  });

  it("an early Monday booking does not fall back to Sunday", () => {
    // The sharpest case: 07:00 Manila is 23:00 the PREVIOUS day in UTC, so the
    // engine looked up Sunday's rule for a Monday booking.
    const p = windowParts("2026-08-10T07:00:00+08:00", "2026-08-10T09:00:00+08:00");

    expect(p.dow).toBe(1); // Monday, not 0
    expect(p.startTime).toBe("07:00"); // not "23:00"
  });

  it("a late Sunday booking does not roll forward to Monday", () => {
    // 23:00 Manila Sunday is 15:00 UTC Sunday — same day here, but the hours
    // still have to be local or the window comparison is meaningless.
    const p = windowParts("2026-08-09T23:00:00+08:00", "2026-08-09T23:30:00+08:00");

    expect(p.dow).toBe(0); // Sunday
    expect(p.startTime).toBe("23:00");
  });

  it("is unaffected by the offset the caller writes the instant in", () => {
    // The same instant, expressed three ways. Availability must not depend on
    // how the timestamp was serialised.
    const asManila = windowParts("2026-08-10T09:00:00+08:00", "2026-08-10T11:00:00+08:00");
    const asUtc = windowParts("2026-08-10T01:00:00Z", "2026-08-10T03:00:00Z");
    const asOther = windowParts("2026-08-09T21:00:00-04:00", "2026-08-09T23:00:00-04:00");

    expect(asUtc).toEqual(asManila);
    expect(asOther).toEqual(asManila);
  });
});

describe("a provider working normal hours is available during them", () => {
  it("covers a 09:00–11:00 Monday booking", () => {
    // This is the defect in one assertion. Before the fix windowParts returned
    // 01:00–03:00, and "01:00" < "08:00" made this 'outside_window' — so a
    // provider available Mon–Fri 08:00–17:00 was excluded from a Monday 9am
    // job for being outside their own schedule.
    const p = windowParts("2026-08-10T09:00:00+08:00", "2026-08-10T11:00:00+08:00");

    expect(scheduleCoversWindow(WEEKDAY_9_TO_5, p.dow, p.startTime, p.endTime)).toBe(
      "covered"
    );
  });

  it("is not available on a day it did not choose", () => {
    // The fix must not make everything 'covered' — Sunday is genuinely off.
    const p = windowParts("2026-08-09T09:00:00+08:00", "2026-08-09T11:00:00+08:00");

    expect(scheduleCoversWindow(WEEKDAY_9_TO_5, p.dow, p.startTime, p.endTime)).toBe(
      "day_unavailable"
    );
  });

  it("is not available outside the hours it chose", () => {
    const p = windowParts("2026-08-10T19:00:00+08:00", "2026-08-10T20:00:00+08:00");

    expect(scheduleCoversWindow(WEEKDAY_9_TO_5, p.dow, p.startTime, p.endTime)).toBe(
      "outside_window"
    );
  });

  it("a booking crossing the end of the window is not covered", () => {
    // 16:00–18:00 starts inside and ends outside. Partial coverage is not
    // coverage — the provider would be committed past their stated finish.
    const p = windowParts("2026-08-10T16:00:00+08:00", "2026-08-10T18:00:00+08:00");

    expect(scheduleCoversWindow(WEEKDAY_9_TO_5, p.dow, p.startTime, p.endTime)).toBe(
      "outside_window"
    );
  });

  it("an unconfigured schedule stays distinct from an unavailable one", () => {
    // filterUidsAvailableAt and explainAvailability need opposite answers for
    // this state, so it must not collapse into 'day_unavailable'.
    const p = windowParts("2026-08-10T09:00:00+08:00", "2026-08-10T11:00:00+08:00");

    expect(scheduleCoversWindow([], p.dow, p.startTime, p.endTime)).toBe("no_schedule");
    expect(scheduleCoversWindow(null, p.dow, p.startTime, p.endTime)).toBe("no_schedule");
  });
});

describe("midnight and date boundaries", () => {
  it("a booking at Manila midnight belongs to the day that starts", () => {
    // 00:00 Manila is 16:00 the PREVIOUS day in UTC — the worst case for a
    // date-only comparison, and the one that decides which day's time off
    // applies.
    const p = windowParts("2026-08-10T00:00:00+08:00", "2026-08-10T02:00:00+08:00");

    expect(p.dow).toBe(1); // Monday
    expect(p.startTime).toBe("00:00");
  });

  it("23:59 Manila stays on its own day", () => {
    const p = windowParts("2026-08-10T23:59:00+08:00", "2026-08-10T23:59:00+08:00");

    expect(p.dow).toBe(1);
    expect(p.startTime).toBe("23:59");
  });
});
