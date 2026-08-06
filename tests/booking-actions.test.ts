/**
 * Server-decided provider actions.
 *
 * Command 18 §1/§5. The client inferred actions from status labels, which §1
 * forbids. These assertions pin two things:
 *
 *   1. Every action offered maps to an endpoint that actually exists. §5:
 *      "UI must not display unsupported actions." Offering REQUEST_RESCHEDULE
 *      before a reschedule endpoint exists puts a dead button in the app.
 *   2. Actions follow the REAL transition graph in technicianService, not the
 *      aspirational one in the command text.
 */
import {
  actionsForWorkerStatus,
  BookingActionCode,
} from "../src/controllers/bookingActions";

const codes = (status: string | null | undefined): BookingActionCode[] =>
  actionsForWorkerStatus(status).map((a) => a.code);

/** Actions the command names but this backend cannot perform. */
const UNSUPPORTED = [
  "REQUEST_RESCHEDULE",
  "RESPOND_TO_RESCHEDULE",
  "REQUEST_CANCELLATION",
  "OPEN_DISPUTE",
  "PAUSE_JOB",
  "RESUME_JOB",
  "UPLOAD_EVIDENCE",
  "REPORT_NO_SHOW",
  "VERIFY_OTP",
  "SCAN_QR",
];

const EVERY_STATUS = [
  "ASSIGNED", "ACCEPTED", "EN_ROUTE", "ARRIVED", "IN_PROGRESS",
  "COMPLETED", "DECLINED", "CANCELED", "CANCELLED", "WEIRD_NEW_STATE", "", null,
];

describe("no action is offered without an endpoint behind it", () => {
  it.each(EVERY_STATUS)("%s offers nothing unsupported", (s) => {
    const offered = codes(s as string) as string[];
    for (const bad of UNSUPPORTED) expect(offered).not.toContain(bad);
  });
});

describe("the response stage", () => {
  it("ASSIGNED can accept or decline, both confirmed", () => {
    expect(codes("ASSIGNED")).toEqual([
      "VIEW_DETAILS", "ACCEPT_ASSIGNMENT", "DECLINE_ASSIGNMENT",
    ]);
    for (const a of actionsForWorkerStatus("ASSIGNED")) {
      if (a.code !== "VIEW_DETAILS") expect(a.requiresConfirmation).toBe(true);
    }
  });

  it("ASSIGNED does NOT offer directions", () => {
    // The address is withheld before acceptance, so offering navigation would
    // promise data the API deliberately does not return.
    expect(codes("ASSIGNED")).not.toContain("OPEN_DIRECTIONS");
  });

  it("responding is impossible once responded", () => {
    for (const s of ["ACCEPTED", "EN_ROUTE", "ARRIVED", "IN_PROGRESS", "COMPLETED", "DECLINED"]) {
      expect(codes(s)).not.toContain("ACCEPT_ASSIGNMENT");
      expect(codes(s)).not.toContain("DECLINE_ASSIGNMENT");
    }
  });
});

describe("the arrival stages follow the real guards", () => {
  it("EN_ROUTE is offered only from ACCEPTED", () => {
    // markEnRoute requires exactly ACCEPTED.
    expect(codes("ACCEPTED")).toContain("MARK_EN_ROUTE");
    for (const s of ["ASSIGNED", "EN_ROUTE", "ARRIVED", "IN_PROGRESS", "COMPLETED"]) {
      expect(codes(s)).not.toContain("MARK_EN_ROUTE");
    }
  });

  it("ARRIVED is offered only from EN_ROUTE", () => {
    // markArrived requires exactly EN_ROUTE.
    expect(codes("EN_ROUTE")).toContain("MARK_ARRIVED");
    for (const s of ["ASSIGNED", "ACCEPTED", "ARRIVED", "IN_PROGRESS", "COMPLETED"]) {
      expect(codes(s)).not.toContain("MARK_ARRIVED");
    }
  });

  it("START_JOB is offered from all three stages startJob accepts", () => {
    // startJob permits ACCEPTED, EN_ROUTE and ARRIVED — the arrival taps are
    // optional, and a provider who skips them can still start.
    for (const s of ["ACCEPTED", "EN_ROUTE", "ARRIVED"]) {
      expect(codes(s)).toContain("START_JOB");
    }
    for (const s of ["ASSIGNED", "IN_PROGRESS", "COMPLETED", "DECLINED"]) {
      expect(codes(s)).not.toContain("START_JOB");
    }
  });

  it("START_JOB declares that it needs a code", () => {
    const start = actionsForWorkerStatus("ACCEPTED").find((a) => a.code === "START_JOB");
    expect(start?.requiresCode).toBe(true);
    expect(start?.requiresConfirmation).toBe(true);
  });

  it("directions are available across the whole operational window", () => {
    for (const s of ["ACCEPTED", "EN_ROUTE", "ARRIVED", "IN_PROGRESS"]) {
      expect(codes(s)).toContain("OPEN_DIRECTIONS");
    }
  });
});

describe("completion and terminal states", () => {
  it("only IN_PROGRESS can complete", () => {
    expect(codes("IN_PROGRESS")).toContain("COMPLETE_JOB");
    for (const s of ["ASSIGNED", "ACCEPTED", "EN_ROUTE", "ARRIVED", "COMPLETED"]) {
      expect(codes(s)).not.toContain("COMPLETE_JOB");
    }
  });

  it("COMPLETED is read-only plus earnings", () => {
    expect(codes("COMPLETED")).toEqual(["VIEW_DETAILS", "VIEW_EARNINGS"]);
  });

  it.each(["DECLINED", "CANCELED", "CANCELLED"])("%s is read-only", (s) => {
    expect(codes(s)).toEqual(["VIEW_DETAILS"]);
  });
});

describe("unknown status fails closed", () => {
  it.each(["WEIRD_NEW_STATE", "", null, undefined])("%s is read-only", (s) => {
    expect(codes(s as any)).toEqual(["VIEW_DETAILS"]);
  });

  it("lowercase from the database still resolves", () => {
    expect(codes("accepted")).toContain("START_JOB");
  });
});

describe("VIEW_DETAILS is always available", () => {
  it.each(EVERY_STATUS)("%s can still be opened", (s) => {
    expect(codes(s as string)).toContain("VIEW_DETAILS");
  });
});
