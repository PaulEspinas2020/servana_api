/**
 * Provider cancellation policy — the 48-hour rule.
 *
 * Command 18 §26. The policy is the operator's, recorded verbatim:
 * 48 hours notice, RECORD ONLY (no penalty), auto-reassign, admin notified.
 *
 * §26 says "Do not invent penalties", so the assertions below also pin the
 * ABSENCE of any consequence — a future change that quietly adds a fee to this
 * response should fail here.
 */
import {
  evaluateCancellation,
  CANCELLATION_NOTICE_HOURS,
  PROVIDER_CANCELLATION_REASONS,
} from "../src/services/booking/bookingPolicies";

const NOW = new Date("2026-08-10T12:00:00.000Z");
const hoursFromNow = (h: number) =>
  new Date(NOW.getTime() + h * 3_600_000).toISOString();

const check = (opts: {
  status?: string | null;
  schedule?: unknown;
  reasonCode?: string | null;
}) =>
  evaluateCancellation({
    // `in` rather than `??` — an explicitly-null status must reach the
    // function under test, not be coalesced back to ACCEPTED.
    workerStatus: "status" in opts ? opts.status : "ACCEPTED",
    schedule: "schedule" in opts ? opts.schedule : hoursFromNow(72),
    now: NOW,
    reasonCode: opts.reasonCode,
  });

describe("the 48-hour notice window", () => {
  it("is exactly 48", () => {
    expect(CANCELLATION_NOTICE_HOURS).toBe(48);
  });

  it("well outside the window is allowed", () => {
    const r = check({ schedule: hoursFromNow(72) });
    expect(r.canCancel).toBe(true);
    expect(r.hoursUntilStart).toBe(72);
  });

  it("exactly 48 hours out is allowed — the boundary is inclusive", () => {
    const r = check({ schedule: hoursFromNow(48) });
    expect(r.canCancel).toBe(true);
  });

  it("one hour inside the window is blocked", () => {
    const r = check({ schedule: hoursFromNow(47) });
    expect(r.canCancel).toBe(false);
    expect(r.blockCode).toBe("INSIDE_NOTICE_WINDOW");
  });

  it("a booking starting imminently is blocked", () => {
    expect(check({ schedule: hoursFromNow(1) }).blockCode).toBe("INSIDE_NOTICE_WINDOW");
  });

  it("a booking already in the past is blocked", () => {
    const r = check({ schedule: hoursFromNow(-5) });
    expect(r.canCancel).toBe(false);
    expect(r.hoursUntilStart).toBe(-5);
  });
});

describe("which stages can cancel", () => {
  it.each(["ACCEPTED", "EN_ROUTE", "ARRIVED"])("%s can cancel", (s) => {
    expect(check({ status: s }).canCancel).toBe(true);
  });

  it("IN_PROGRESS cannot — abandoning live work is a support matter", () => {
    const r = check({ status: "IN_PROGRESS" });
    expect(r.canCancel).toBe(false);
    expect(r.blockCode).toBe("NOT_CANCELLABLE_AT_THIS_STAGE");
  });

  it("ASSIGNED cannot — declining is the mechanism before acceptance", () => {
    expect(check({ status: "ASSIGNED" }).blockCode).toBe("NOT_CANCELLABLE_AT_THIS_STAGE");
  });

  it.each(["COMPLETED", "DECLINED", "CANCELLED"])("%s cannot", (s) => {
    expect(check({ status: s }).blockCode).toBe("NOT_CANCELLABLE_AT_THIS_STAGE");
  });

  it.each(["SOMETHING_NEW", "", null])("unknown status %s fails closed", (s) => {
    expect(check({ status: s as any }).canCancel).toBe(false);
  });

  it("stage is checked before the clock", () => {
    // A COMPLETED booking is not "inside the window", it is simply finished —
    // and saying so is clearer than a notice-period message.
    const r = check({ status: "COMPLETED", schedule: hoursFromNow(1) });
    expect(r.blockCode).toBe("NOT_CANCELLABLE_AT_THIS_STAGE");
  });
});

describe("a missing schedule fails closed", () => {
  it.each([null, undefined, "", "not-a-date"])("schedule %s blocks", (v) => {
    const r = check({ schedule: v });
    expect(r.canCancel).toBe(false);
    expect(r.blockCode).toBe("SCHEDULE_UNKNOWN");
    expect(r.hoursUntilStart).toBeNull();
  });

  it("accepts a Date as well as an ISO string", () => {
    expect(check({ schedule: new Date(hoursFromNow(72)) }).canCancel).toBe(true);
  });
});

describe("reason codes", () => {
  it("a valid code passes", () => {
    expect(check({ reasonCode: "ILLNESS_OR_EMERGENCY" }).canCancel).toBe(true);
  });

  it("an unknown code is rejected", () => {
    const r = check({ reasonCode: "BECAUSE_I_SAID_SO" });
    expect(r.canCancel).toBe(false);
    expect(r.blockCode).toBe("INVALID_REASON");
  });

  it("omitting the code entirely is fine for an eligibility check", () => {
    // The GET endpoint asks "could I cancel?" before a reason is chosen.
    expect(evaluateCancellation({
      workerStatus: "ACCEPTED",
      schedule: hoursFromNow(72),
      now: NOW,
    }).canCancel).toBe(true);
  });

  it("reasons are offered only when cancellation is possible", () => {
    expect(check({}).reasons).toEqual(PROVIDER_CANCELLATION_REASONS);
    expect(check({ schedule: hoursFromNow(2) }).reasons).toEqual([]);
    expect(check({ status: "COMPLETED" }).reasons).toEqual([]);
  });

  it("reasons are codes, never free text", () => {
    for (const r of PROVIDER_CANCELLATION_REASONS) expect(r).toMatch(/^[A-Z_]+$/);
  });
});

describe("record only — no penalty is computed anywhere", () => {
  // §26: "Do not invent penalties." The operator specified record-only, so a
  // fee, strike or rating field appearing here later should break this.
  it("the result carries no consequence of any kind", () => {
    const r: any = check({});
    // `allowedUntil` is a DEADLINE, not a consequence — it exists so clients
    // render "you had until Thursday" instead of subtracting 48 hours from a
    // schedule themselves. The penalty assertions below are the actual guard
    // and are unchanged.
    expect(Object.keys(r).sort()).toEqual(
      ["allowedUntil", "blockCode", "canCancel", "hoursUntilStart", "noticeHours", "reasons"].sort()
    );
    for (const k of ["penalty", "fee", "strike", "ratingImpact", "charge"]) {
      expect(r[k]).toBeUndefined();
    }
  });

  it("blocked results carry none either", () => {
    const r: any = check({ schedule: hoursFromNow(1) });
    expect(JSON.stringify(r)).not.toMatch(/penalt|fee|strike|charge/i);
  });
});
