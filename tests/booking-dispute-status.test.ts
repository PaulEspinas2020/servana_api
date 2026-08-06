/**
 * Provider-facing dispute status and eligibility.
 *
 * Command 18 §29 — entry point and status summary only.
 *
 * Built on `booking_escalations`, the table the admin portal already derives
 * `hasDispute` from, so admin and provider cannot disagree about whether a
 * booking is disputed. The row is an ADMIN record, and §29 forbids exposing
 * internal investigation notes — the assertions below pin what must not cross.
 */
import {
  buildDisputeSummary,
  PROVIDER_DISPUTE_CATEGORIES,
} from "../src/controllers/bookingDisputeView";

const ME = "worker-A";
const summary = (
  workerStatus: string | null,
  escalation: any = null,
  callerUid = ME
) => buildDisputeSummary({ workerStatus, callerUid, escalation });

const OPEN_ESC = {
  actor_uid: ME,
  created_at: "2026-08-05T10:00:00.000Z",
  resolved_at: null,
};
const RESOLVED_ESC = {
  actor_uid: "admin-1",
  created_at: "2026-08-01T10:00:00.000Z",
  resolved_at: "2026-08-03T10:00:00.000Z",
};

describe("state derives from the escalation row", () => {
  it("no escalation is NONE and openable", () => {
    const s = summary("ACCEPTED");
    expect(s.state).toBe("NONE");
    expect(s.canOpen).toBe(true);
    expect(s.openedAt).toBeNull();
  });

  it("an unresolved escalation is OPEN", () => {
    const s = summary("ACCEPTED", OPEN_ESC);
    expect(s.state).toBe("OPEN");
    expect(s.openedAt).toBe("2026-08-05T10:00:00.000Z");
    expect(s.resolvedAt).toBeNull();
  });

  it("a resolved escalation is RESOLVED and openable again", () => {
    const s = summary("COMPLETED", RESOLVED_ESC);
    expect(s.state).toBe("RESOLVED");
    expect(s.resolvedAt).toBe("2026-08-03T10:00:00.000Z");
    expect(s.canOpen).toBe(true);
  });
});

describe("duplicate disputes are prevented", () => {
  // §29: "Prevent duplicate disputes."
  it("an open escalation blocks a new one", () => {
    const s = summary("IN_PROGRESS", OPEN_ESC);
    expect(s.canOpen).toBe(false);
    expect(s.ineligibleReason).toBe("ALREADY_OPEN");
  });

  it("someone else's open escalation blocks it too", () => {
    // The booking is already under review; who raised it is irrelevant.
    const s = summary("IN_PROGRESS", { ...OPEN_ESC, actor_uid: "admin-1" });
    expect(s.canOpen).toBe(false);
    expect(s.ineligibleReason).toBe("ALREADY_OPEN");
    expect(s.openedByYou).toBe(false);
  });

  it("openedByYou is true only for the caller's own escalation", () => {
    expect(summary("ACCEPTED", OPEN_ESC).openedByYou).toBe(true);
    expect(summary("ACCEPTED", { ...OPEN_ESC, actor_uid: "worker-B" }).openedByYou).toBe(false);
  });
});

describe("eligibility follows the lifecycle", () => {
  it.each(["ACCEPTED", "EN_ROUTE", "ARRIVED", "IN_PROGRESS", "COMPLETED", "CANCELLED"])(
    "%s can raise a dispute",
    (s) => {
      expect(summary(s).canOpen).toBe(true);
    }
  );

  it("ASSIGNED cannot — declining is the mechanism there", () => {
    const s = summary("ASSIGNED");
    expect(s.canOpen).toBe(false);
    expect(s.ineligibleReason).toBe("NOT_YET_ACTIONABLE");
  });

  it("DECLINED cannot — there is no relationship left", () => {
    expect(summary("DECLINED").canOpen).toBe(false);
  });

  it.each(["SOME_NEW_STATE", "", null])("unknown status %s fails closed", (s) => {
    const out = summary(s as any);
    expect(out.canOpen).toBe(false);
    expect(out.ineligibleReason).toBe("NOT_YET_ACTIONABLE");
  });
});

describe("categories appear only with a usable entry point", () => {
  it("eligible bookings offer the standardized list", () => {
    expect(summary("ACCEPTED").categories).toEqual(PROVIDER_DISPUTE_CATEGORIES);
  });

  it("ineligible bookings offer none, so no dead menu is rendered", () => {
    expect(summary("ASSIGNED").categories).toEqual([]);
    expect(summary("IN_PROGRESS", OPEN_ESC).categories).toEqual([]);
  });

  it("categories are codes, never free text", () => {
    for (const c of PROVIDER_DISPUTE_CATEGORIES) {
      expect(c).toMatch(/^[A-Z_]+$/);
    }
  });
});

describe("no internal investigation detail crosses to the provider", () => {
  // §29: "Do not expose internal investigation notes."
  const ADMIN_ROW = {
    actor_uid: "admin-7",
    created_at: "2026-08-05T10:00:00.000Z",
    resolved_at: null,
    reason: "Customer alleges provider was rude; check CCTV before payout",
    reason_code: "INTERNAL_CONDUCT_REVIEW",
    severity: "high",
    assigned_team: "trust-and-safety",
  };

  it("omits reason, severity, team and actor uid entirely", () => {
    const s: any = summary("IN_PROGRESS", ADMIN_ROW);
    const json = JSON.stringify(s);
    expect(json).not.toContain("CCTV");
    expect(json).not.toContain("rude");
    expect(json).not.toContain("trust-and-safety");
    expect(json).not.toContain("admin-7");
    expect(json).not.toContain("high");
    expect(s.reason).toBeUndefined();
    expect(s.severity).toBeUndefined();
    expect(s.assignedTeam).toBeUndefined();
    expect(s.actorUid).toBeUndefined();
  });

  it("returns only the agreed public surface", () => {
    const s = summary("IN_PROGRESS", ADMIN_ROW);
    expect(Object.keys(s).sort()).toEqual(
      [
        "canOpen", "categories", "ineligibleReason", "openedAt",
        "openedByYou", "resolvedAt", "state",
      ].sort()
    );
  });
});

describe("timestamp handling", () => {
  it("accepts Date objects", () => {
    const s = summary("ACCEPTED", {
      ...OPEN_ESC,
      created_at: new Date("2026-08-05T10:00:00.000Z"),
    });
    expect(s.openedAt).toBe("2026-08-05T10:00:00.000Z");
  });

  it("an unparseable created_at does not produce Invalid Date", () => {
    const s = summary("ACCEPTED", { ...OPEN_ESC, created_at: "nonsense" });
    expect(s.openedAt).toBeNull();
    // Still unresolved, so still OPEN and still blocking.
    expect(s.state).toBe("OPEN");
    expect(s.canOpen).toBe(false);
  });
});
