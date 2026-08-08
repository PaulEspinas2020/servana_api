/**
 * Time off must never quietly free a provider who has accepted work.
 *
 * Command 22 §18. `createTimeOff` performed no booking check at all. It could
 * not cancel a booking — so the "silent cancellation" hazard never existed —
 * but it also gave the provider no warning that they had just booked leave over
 * accepted work. §18: "The provider must never assume that creating time off
 * automatically cancels an accepted booking."
 *
 * ── Report, do not block ────────────────────────────────────────────────────
 * The tempting design is to refuse the time off. That is wrong: time off is a
 * statement of fact, and a provider who is ill must be able to record it.
 * Refusing would leave them with no way to say so. So the record is created and
 * the conflicts come back with it, and the copy says the booking is still
 * theirs.
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
import {
  createTimeOff,
  findTimeOffBookingConflicts,
} from "../src/services/providerAvailabilityEngine";

const query = (dbQuery as any).query as jest.Mock;

const bookingRow = (over: Record<string, any> = {}) => ({
  id: 4242,
  schedule: "2026-08-10T02:00:00.000Z", // 10:00 Manila
  status: "ACCEPTED",
  service_name: "Deep cleaning",
  duration_mins: 120,
  local_date: "2026-08-10",
  local_time: "10:00",
  ...over,
});

const insertedRow = {
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
      all_day: true,
      start_time: null,
      end_time: null,
      note: null,
    },
  ],
  rowCount: 1,
};

/**
 * Routed by SQL, not call order: `bootstrap()` memoises on a module-level flag,
 * so it issues no DDL after the first test and any `mockResolvedValueOnce`
 * sequence lands on the wrong query.
 */
const route = (conflicts: any[]) => {
  query.mockReset();
  query.mockImplementation((sql: string) => {
    const text = String(sql);
    if (text.includes("assigned AS")) return Promise.resolve({ rows: conflicts });
    if (text.includes("INSERT INTO")) return Promise.resolve(insertedRow);
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
};

const makeTimeOff = () =>
  createTimeOff(
    "worker-A",
    { startDate: "2026-08-10", endDate: "2026-08-10", reason: "medical" },
    "worker-A"
  );

describe("the provider is told, and the time off is still created", () => {
  it("returns the colliding booking", async () => {
    route([bookingRow()]);
    const r = await makeTimeOff();

    expect(r.bookingConflicts).toHaveLength(1);
    expect(r.bookingConflicts[0]).toMatchObject({
      bookingId: "4242",
      serviceName: "Deep cleaning",
      localDate: "2026-08-10",
      localTime: "10:00",
      durationMins: 120,
      status: "ACCEPTED",
    });
  });

  it("creates the time off anyway — illness is not negotiable", async () => {
    route([bookingRow()]);
    const r = await makeTimeOff();

    // A refusal would leave a provider who cannot work with no way to say so.
    expect(r.id).toBe(1);
    expect(r.status).toBe("active");
  });

  it("reports an empty list when nothing collides", async () => {
    route([]);
    const r = await makeTimeOff();

    // An empty array, never undefined — the client branches on length, and
    // undefined would read as "no conflicts" for a failed lookup too.
    expect(r.bookingConflicts).toEqual([]);
  });

  it("looks for conflicts BEFORE inserting", async () => {
    route([bookingRow()]);
    await makeTimeOff();

    const order = query.mock.calls.map(([sql]: any[]) => String(sql));
    const conflictAt = order.findIndex((q) => q.includes("assigned AS"));
    const insertAt = order.findIndex((q) => q.includes("INSERT INTO"));

    // Otherwise a failure could leave time off recorded with conflicts nobody
    // was told about.
    expect(conflictAt).toBeGreaterThanOrEqual(0);
    expect(conflictAt).toBeLessThan(insertAt);
  });
});

describe("the query finds what it must", () => {
  const sqlOf = async (window: any) => {
    route([]);
    await findTimeOffBookingConflicts("worker-A", window);
    return String(query.mock.calls.find(([q]: any[]) => String(q).includes("assigned AS"))![0]);
  };

  const allDay = {
    startDate: "2026-08-10",
    endDate: "2026-08-10",
    allDay: true,
  };

  it("counts assignments recorded either way", async () => {
    // Admin-created bookings set worker_uid on the booking row AND write a
    // booking_workers row; older rows may have only one. Querying either alone
    // silently misses assignments.
    const sql = await sqlOf(allDay);
    expect(sql).toMatch(/booking_workers/);
    expect(sql).toMatch(/UNION/);
  });

  it("ignores cancelled and completed work", async () => {
    // Neither is a commitment the provider still holds.
    const sql = await sqlOf(allDay);
    expect(sql).toMatch(/NOT IN \('CANCELLED', 'COMPLETED'\)/);
  });

  it("compares dates in the operational timezone, not the server's", async () => {
    // The C22-01 defect in a new place: a UTC date comparison would miss a
    // booking before 08:00 Manila and catch one on the wrong day.
    const sql = await sqlOf(allDay);
    expect(sql).toMatch(/AT TIME ZONE/);
    const params = query.mock.calls.find(([q]: any[]) =>
      String(q).includes("assigned AS")
    )![1];
    expect(params).toContain("Asia/Manila");
  });

  it("uses the real service duration, not a fixed window", async () => {
    // A booking that STARTS before a partial window but runs into it must be
    // caught. service_options.duration_mins is the same source admin booking
    // creation uses.
    const sql = await sqlOf({
      startDate: "2026-08-10",
      endDate: "2026-08-10",
      allDay: false,
      startTime: "13:00",
      endTime: "15:00",
    });

    expect(sql).toMatch(/duration_mins/);
    expect(sql).toMatch(/interval/);
  });

  it("binds the partial window, and the whole day when all-day", async () => {
    route([]);
    await findTimeOffBookingConflicts("worker-A", {
      startDate: "2026-08-10",
      endDate: "2026-08-10",
      allDay: false,
      startTime: "09:00",
      endTime: "12:00",
    });
    let params = query.mock.calls.find(([q]: any[]) =>
      String(q).includes("assigned AS")
    )![1];
    expect(params).toContain("09:00");
    expect(params).toContain("12:00");

    route([]);
    await findTimeOffBookingConflicts("worker-A", allDay);
    params = query.mock.calls.find(([q]: any[]) => String(q).includes("assigned AS"))![1];
    // 24:00 rather than 23:59 — a booking starting at 23:30 is still inside
    // the day.
    expect(params).toContain("00:00");
    expect(params).toContain("24:00");
  });

  it("is bounded", async () => {
    // A provider with a year of bookings must not return all of them into a
    // confirmation sheet.
    const sql = await sqlOf(allDay);
    expect(sql).toMatch(/LIMIT \d+/);
  });
});

describe("the copy does not claim the work was cancelled", () => {
  const src = (require("fs") as typeof import("fs")).readFileSync(
    require("path").join(__dirname, "..", "src/controllers/providerController.ts"),
    "utf8"
  );
  const notice =
    src.slice(src.indexOf("conflictNotice"), src.indexOf("conflictNotice") + 600);

  it("says the booking is still assigned", () => {
    expect(notice).toMatch(/still assigned/i);
  });

  it("says explicitly that time off does not cancel accepted work", () => {
    // §18's whole point. Without this sentence a provider reasonably assumes
    // booking leave clears their day.
    expect(notice).toMatch(/does not cancel/i);
  });

  it("names what to do instead", () => {
    expect(notice).toMatch(/cancel or request a reschedule/i);
  });

  it("is null when there is nothing to warn about", () => {
    // A notice that always appears stops being read.
    expect(notice).toMatch(/: null/);
  });
});
