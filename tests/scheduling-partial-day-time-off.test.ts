/**
 * Partial-day time off must not cost a provider the whole day.
 *
 * Command 22 §17. The provider web portal has shipped a partial-day form all
 * along — an "All day" checkbox that, when cleared, collects and validates a
 * start and end time, and submits them. The backend destructured
 * `allDay, startTime, endTime, note` off the request body and then passed only
 * `{ startDate, endDate, reason }` to the engine. There were no columns to hold
 * them, the blocking queries compared dates only, and the response hardcoded
 * `allDay: true`.
 *
 * So a provider asking for two hours off lost the entire day, was told it was
 * all-day, and had their note discarded — with no error anywhere.
 *
 * These assert the two halves that make the fix real: the times are STORED,
 * and the query that decides bookability actually honours them. Storing them
 * without the second half would be the "foundations without callers" defect.
 */
const mockDbQuery = jest.fn();
const mockTxQuery = jest.fn((sql: string, params?: any[]) => {
  const text = String(sql);
  if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text) || text.includes('pg_advisory_xact_lock'))
    return Promise.resolve({ rows: [], rowCount: 0 });
  if (text.includes('SELECT id FROM test.worker_time_off'))
    return Promise.resolve({ rows: [], rowCount: 0 });
  return mockDbQuery(sql, params);
});
jest.mock("../src/db/dbQuery", () => ({
  __esModule: true,
  default: { query: mockDbQuery },
  pool: { connect: jest.fn(async () => ({ query: mockTxQuery, release: jest.fn() })) },
}));
jest.mock("../src/config", () => ({ __esModule: true, db: { schema: "test" } }));

import dbQuery from "../src/db/dbQuery";
import { createTimeOff, filterUidsAvailableAt } from "../src/services/providerAvailabilityEngine";

const query = (dbQuery as any).query as jest.Mock;

/** Bootstrap issues DDL; every test needs those to resolve first. */
const ddlOk = { rows: [], rowCount: 0 };

const storedRow = (over: Record<string, any> = {}) => ({
  rows: [
    {
      id: 1,
      start_date: "2026-08-10",
      end_date: "2026-08-10",
      reason: "medical",
      created_at: "2026-08-07T00:00:00.000Z",
      created_by: "worker-A",
      status: "active",
      cancelled_at: null,
      cancelled_by: null,
      all_day: false,
      start_time: "09:00",
      end_time: "12:00",
      note: "Clinic appointment",
      ...over,
    },
  ],
  rowCount: 1,
});

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue(ddlOk);
});

/** The INSERT is the last call; bootstrap DDL comes first. */
const lastCall = () => query.mock.calls[query.mock.calls.length - 1];

describe("the times are persisted, not dropped", () => {
  it("stores allDay, start, end and note", async () => {
    query.mockResolvedValue(ddlOk);
    query.mockResolvedValueOnce(ddlOk).mockResolvedValueOnce(ddlOk);
    query.mockResolvedValue(storedRow());

    await createTimeOff(
      "worker-A",
      {
        startDate: "2026-08-10",
        endDate: "2026-08-10",
        reason: "medical",
        allDay: false,
        startTime: "09:00",
        endTime: "12:00",
        note: "Clinic appointment",
      },
      "worker-A"
    );

    const [sql, params] = lastCall();
    expect(String(sql)).toMatch(/INSERT INTO/);
    expect(String(sql)).toMatch(/all_day, start_time, end_time, note/);
    // false, '09:00', '12:00', note — the four values that used to vanish.
    expect(params).toContain(false);
    expect(params).toContain("09:00");
    expect(params).toContain("12:00");
    expect(params).toContain("Clinic appointment");
  });

  it("returns what was stored rather than echoing the request", async () => {
    // The response used to hardcode allDay: true, which made it agree with the
    // client by construction and hid the whole defect.
    query.mockResolvedValue(storedRow());

    const r = await createTimeOff(
      "worker-A",
      { startDate: "2026-08-10", endDate: "2026-08-10", allDay: false, startTime: "09:00", endTime: "12:00" },
      "worker-A"
    );

    expect(r.allDay).toBe(false);
    expect(r.startTime).toBe("09:00");
    expect(r.endTime).toBe("12:00");
    expect(r.note).toBe("Clinic appointment");
  });

  it("a full day stores no times", async () => {
    query.mockResolvedValue(
      storedRow({ all_day: true, start_time: null, end_time: null, note: null })
    );

    await createTimeOff(
      "worker-A",
      { startDate: "2026-08-10", endDate: "2026-08-12", reason: "personal" },
      "worker-A"
    );

    const [, params] = lastCall();
    expect(params).toContain(true);
    // Nulls, not empty strings — an empty string is a valid TIME cast failure.
    expect(params.filter((p: any) => p === null).length).toBeGreaterThanOrEqual(2);
  });

  it("defaults to all-day when the caller says nothing", async () => {
    // Every existing caller — including the mobile app — omits allDay.
    query.mockResolvedValue(storedRow({ all_day: true, start_time: null, end_time: null }));

    await createTimeOff(
      "worker-A",
      { startDate: "2026-08-10", endDate: "2026-08-10" },
      "worker-A"
    );

    const [, params] = lastCall();
    expect(params).toContain(true);
  });
});

describe("validation refuses rather than guessing", () => {
  const rejects = async (payload: any, matching: RegExp) => {
    await expect(createTimeOff("worker-A", payload, "worker-A")).rejects.toThrow(matching);
  };

  it("a multi-day range cannot be partial-day", async () => {
    // "09:00 to 12:00" across three days could mean those hours each day or one
    // continuous window. Inventing a meaning silently is the original defect.
    await rejects(
      {
        startDate: "2026-08-10",
        endDate: "2026-08-12",
        allDay: false,
        startTime: "09:00",
        endTime: "12:00",
      },
      /same date/i
    );
  });

  it("partial-day without times is refused", async () => {
    await rejects(
      { startDate: "2026-08-10", endDate: "2026-08-10", allDay: false },
      /required/i
    );
  });

  it("an end at or before the start is refused", async () => {
    for (const [st, en] of [["12:00", "09:00"], ["09:00", "09:00"]]) {
      await rejects(
        { startDate: "2026-08-10", endDate: "2026-08-10", allDay: false, startTime: st, endTime: en },
        /later than/i
      );
    }
  });

  it("a malformed time is refused, not coerced", async () => {
    // Coercing "9am" to something would silently book the wrong hours.
    for (const bad of ["9am", "25:00", "09:70", "", "0900"]) {
      await rejects(
        { startDate: "2026-08-10", endDate: "2026-08-10", allDay: false, startTime: bad, endTime: "17:00" },
        /required|later than/i
      );
    }
  });

  it("carries a 422 so the message reaches the provider", async () => {
    // The route flattened every failure to "Server error"; a validation
    // message nobody sees is not validation.
    await expect(
      createTimeOff(
        "worker-A",
        { startDate: "2026-08-10", endDate: "2026-08-10", allDay: false },
        "worker-A"
      )
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("rejects impossible calendar dates and oversized private notes", async () => {
    await rejects(
      { startDate: "2026-02-30", endDate: "2026-02-30" },
      /real dates/i,
    );
    await rejects(
      { startDate: "2026-08-10", endDate: "2026-08-10", note: "x".repeat(501) },
      /at most 500/i,
    );
  });
});

describe("the blocking query honours the times — otherwise storing them is theatre", () => {
  /** Feeds the availability filter one provider with a schedule covering the day. */
  // Routed by SQL rather than call order: `bootstrap()` memoises on a
  // module-level flag, so by the time these run it issues no DDL at all and
  // any mockResolvedValueOnce sequence lands on the wrong query.
  const runFilter = async (timeOffRows: any[], startAt: string, endAt: string) => {
    query.mockReset();
    query.mockImplementation((sql: string) => {
      const text = String(sql);
      if (text.includes("worker_time_off") && text.includes("SELECT")) {
        return Promise.resolve({ rows: timeOffRows });
      }
      if (text.includes("worker_availability") && text.includes("SELECT")) {
        return Promise.resolve({
          rows: [
            {
              worker_uid: "worker-A",
              schedule: [
                { dayOfWeek: 1, isAvailable: true, startTime: "08:00", endTime: "17:00" },
              ],
            },
          ],
        });
      }
      return Promise.resolve(ddlOk);
    });

    return filterUidsAvailableAt(["worker-A"], startAt, endAt, {
      missingScheduleIsAvailable: false,
    } as any);
  };

  it("the SQL compares times, not only dates", async () => {
    await runFilter([], "2026-08-10T09:00:00+08:00", "2026-08-10T11:00:00+08:00");

    const timeOffSql = String(
      query.mock.calls.find((c) => String(c[0]).includes("worker_time_off"))?.[0] ?? ""
    );
    expect(timeOffSql).toMatch(/all_day/);
    expect(timeOffSql).toMatch(/start_time/);
    // The booking's local start and end are bound, so a partial day can be
    // compared against the window rather than the whole date.
    const params = query.mock.calls.find((c) => String(c[0]).includes("worker_time_off"))?.[1];
    expect(params).toContain("09:00");
    expect(params).toContain("11:00");
  });

  it("a provider whose partial time off does not overlap stays eligible", async () => {
    // Morning off, afternoon booking. Under the old date-only query this
    // provider was excluded for the entire day.
    const r = await runFilter([], "2026-08-10T14:00:00+08:00", "2026-08-10T16:00:00+08:00");

    expect(r.eligible).toContain("worker-A");
    expect(r.excluded).toHaveLength(0);
  });

  it("a provider whose time off DOES overlap is excluded", async () => {
    // The database applies the overlap predicate, so a returned row means it
    // matched — the engine must still act on it.
    const r = await runFilter(
      [{ worker_uid: "worker-A" }],
      "2026-08-10T10:00:00+08:00",
      "2026-08-10T11:00:00+08:00"
    );

    expect(r.eligible).toHaveLength(0);
    expect(r.excluded[0]).toMatchObject({ uid: "worker-A", reason: "TIME_OFF" });
  });
});
