/**
 * Assignment response: idempotency and conflict classification.
 *
 * Command 18 §12/§47/§52. The compare-and-swap in `acceptJob`/`declineJob` was
 * always correct — two providers racing, or one double-tapping, cannot both
 * match `status = 'ASSIGNED'`. What was wrong is what happened on a miss: a
 * bare Error that both controllers flattened into `500 "Server error"`.
 *
 * So a double-tap, an expired offer, an admin reassignment and a real database
 * fault were indistinguishable. §52 requires acceptance and decline to be
 * idempotent; a duplicate tap returning 500 is the opposite of idempotent.
 */
jest.mock("../src/db/dbQuery", () => ({
  __esModule: true,
  default: { query: jest.fn() },
}));
jest.mock("../src/config", () => ({
  __esModule: true,
  db: { schema: "test" },
}));

import dbQuery from "../src/db/dbQuery";
import {
  classifyResponseMiss,
  BookingResponseConflict,
} from "../src/services/bookingResponseConflict";

const mockRow = (status: string | null) => {
  (dbQuery.query as jest.Mock).mockResolvedValueOnce({
    rows: status === null ? [] : [{ status }],
    rowCount: status === null ? 0 : 1,
  });
};

beforeEach(() => jest.clearAllMocks());

describe("repeating your own response is success, not an error", () => {
  it("accepting an already-accepted booking is idempotent", async () => {
    mockRow("ACCEPTED");
    const c = await classifyResponseMiss(1, "worker-A", "ACCEPT");
    expect(c.code).toBe("ALREADY_ACCEPTED_BY_YOU");
    expect(c.isAlreadySatisfied).toBe(true);
    expect(c.httpStatus).toBe(200);
  });

  it("declining an already-declined booking is idempotent", async () => {
    mockRow("DECLINED");
    const c = await classifyResponseMiss(1, "worker-A", "DECLINE");
    expect(c.code).toBe("ALREADY_DECLINED_BY_YOU");
    expect(c.isAlreadySatisfied).toBe(true);
    expect(c.httpStatus).toBe(200);
  });
});

describe("changing your mind is a conflict, never a silent success", () => {
  it("declining after accepting does not succeed", async () => {
    mockRow("ACCEPTED");
    const c = await classifyResponseMiss(1, "worker-A", "DECLINE");
    expect(c.code).toBe("ALREADY_RESPONDED");
    expect(c.isAlreadySatisfied).toBe(false);
    expect(c.httpStatus).toBe(409);
  });

  it("accepting after declining does not succeed", async () => {
    mockRow("DECLINED");
    const c = await classifyResponseMiss(1, "worker-A", "ACCEPT");
    expect(c.code).toBe("ALREADY_RESPONDED");
    expect(c.httpStatus).toBe(409);
  });
});

describe("the assignment is no longer answerable", () => {
  it("no row of the caller's at all", async () => {
    mockRow(null);
    const c = await classifyResponseMiss(1, "worker-A", "ACCEPT");
    expect(c.code).toBe("NO_LONGER_ASSIGNED");
    expect(c.currentStatus).toBeNull();
    expect(c.httpStatus).toBe(409);
  });

  it.each(["IN_PROGRESS", "COMPLETED"])("work already under way: %s", async (s) => {
    mockRow(s);
    const c = await classifyResponseMiss(1, "worker-A", "ACCEPT");
    expect(c.code).toBe("ALREADY_IN_PROGRESS");
  });

  it.each(["CANCELED", "CANCELLED"])("booking gone: %s", async (s) => {
    mockRow(s);
    const c = await classifyResponseMiss(1, "worker-A", "DECLINE");
    expect(c.code).toBe("BOOKING_CANCELLED");
  });

  it("an unrecognised status fails closed to NO_LONGER_ASSIGNED", async () => {
    // A status added server-side later must not accidentally read as success.
    mockRow("SOME_FUTURE_STATE");
    const c = await classifyResponseMiss(1, "worker-A", "ACCEPT");
    expect(c.code).toBe("NO_LONGER_ASSIGNED");
    expect(c.isAlreadySatisfied).toBe(false);
  });

  it("lowercase from the database is still recognised", async () => {
    mockRow("accepted");
    const c = await classifyResponseMiss(1, "worker-A", "ACCEPT");
    expect(c.code).toBe("ALREADY_ACCEPTED_BY_YOU");
  });
});

describe("no branch reveals another provider", () => {
  // §12: "Do not expose another provider's identity or response."
  it.each([
    [null, "ACCEPT"],
    ["IN_PROGRESS", "ACCEPT"],
    ["CANCELLED", "DECLINE"],
    ["SOME_FUTURE_STATE", "ACCEPT"],
  ])("status %s / intent %s says nothing about who holds it", async (s, intent) => {
    mockRow(s as string | null);
    const c = await classifyResponseMiss(1, "worker-A", intent as any);
    const text = `${c.providerMessage} ${c.message}`.toLowerCase();
    for (const leak of ["worker-", "provider b", "assigned to", "another provider"]) {
      expect(text).not.toContain(leak);
    }
  });

  it("only the caller's own uid is ever queried", async () => {
    mockRow("ACCEPTED");
    await classifyResponseMiss(42, "worker-A", "ACCEPT");
    const [, params] = (dbQuery.query as jest.Mock).mock.calls[0];
    expect(params).toEqual([42, "worker-A"]);
  });
});

describe("the error is still a real Error", () => {
  it("can be thrown and caught by instanceof", async () => {
    mockRow("ACCEPTED");
    const c = await classifyResponseMiss(1, "worker-A", "ACCEPT");
    expect(c).toBeInstanceOf(Error);
    expect(c).toBeInstanceOf(BookingResponseConflict);
    expect(() => {
      throw c;
    }).toThrow(BookingResponseConflict);
  });

  it("carries a provider-facing message, not a stack-trace string", async () => {
    mockRow(null);
    const c = await classifyResponseMiss(1, "worker-A", "ACCEPT");
    expect(c.providerMessage).toBe(
      "This assignment is no longer awaiting your response."
    );
    expect(c.providerMessage).not.toMatch(/error|exception|null|undefined/i);
  });
});
