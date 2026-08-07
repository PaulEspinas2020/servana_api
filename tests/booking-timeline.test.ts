/**
 * The provider-facing booking timeline.
 *
 * Command 18 §21. The rule that matters most: events come from authoritative
 * timestamps, and a stage with no timestamp produces no invented one. A
 * fabricated time reads as fact.
 *
 * §21 also forbids exposing internal metadata or another provider's identity,
 * so actors are categories and no label names anyone.
 */
import {
  buildBookingTimeline,
  currentTimelineStep,
  mergeStoredEvents,
  TimelineEventCode,
} from "../src/controllers/bookingTimeline";

const T = {
  created: "2026-08-01T00:00:00.000Z",
  assigned: "2026-08-02T00:00:00.000Z",
  accepted: "2026-08-03T00:00:00.000Z",
  enRoute: "2026-08-04T00:00:00.000Z",
  arrived: "2026-08-04T01:00:00.000Z",
  started: "2026-08-04T02:00:00.000Z",
  completed: "2026-08-04T05:00:00.000Z",
};

const codes = (row: any): TimelineEventCode[] =>
  buildBookingTimeline(row).map((e) => e.code);

describe("events come only from real timestamps", () => {
  it("a freshly assigned booking has just the two events that happened", () => {
    expect(
      codes({
        created_at: T.created,
        assigned_at: T.assigned,
        worker_status: "ASSIGNED",
      })
    ).toEqual(["BOOKING_CREATED", "ASSIGNED"]);
  });

  it("stages that never happened produce no events", () => {
    const out = codes({
      created_at: T.created,
      assigned_at: T.assigned,
      accepted_at: T.accepted,
      worker_status: "ACCEPTED",
    });
    expect(out).not.toContain("PROVIDER_EN_ROUTE");
    expect(out).not.toContain("JOB_STARTED");
    expect(out).not.toContain("JOB_COMPLETED");
  });

  it("a full lifecycle emits every stage in canonical order", () => {
    expect(
      codes({
        created_at: T.created,
        assigned_at: T.assigned,
        accepted_at: T.accepted,
        en_route_at: T.enRoute,
        arrived_at: T.arrived,
        started_at: T.started,
        completed_at: T.completed,
        worker_status: "COMPLETED",
      })
    ).toEqual([
      "BOOKING_CREATED",
      "ASSIGNED",
      "PROVIDER_ACCEPTED",
      "PROVIDER_EN_ROUTE",
      "PROVIDER_ARRIVED",
      "JOB_STARTED",
      "JOB_COMPLETED",
    ]);
  });

  it("skipped optional arrival stages leave no gap markers", () => {
    // Both arrival taps are optional; a provider who starts directly from
    // ACCEPTED must not show phantom en-route/arrived steps.
    expect(
      codes({
        created_at: T.created,
        assigned_at: T.assigned,
        accepted_at: T.accepted,
        started_at: T.started,
        worker_status: "IN_PROGRESS",
      })
    ).toEqual(["BOOKING_CREATED", "ASSIGNED", "PROVIDER_ACCEPTED", "JOB_STARTED"]);
  });
});

describe("acceptance without a timestamp is reported honestly", () => {
  it("an accepted row predating accepted_at shows the event with a null time", () => {
    // accepted_at was added lazily, so rows accepted before the deploy have
    // none. The acceptance demonstrably happened — the status proves it — but
    // its time is unknown, and a guessed time would read as fact.
    const events = buildBookingTimeline({
      created_at: T.created,
      assigned_at: T.assigned,
      worker_status: "IN_PROGRESS",
      started_at: T.started,
    });
    const accepted = events.find((e) => e.code === "PROVIDER_ACCEPTED");
    expect(accepted).toBeDefined();
    expect(accepted!.at).toBeNull();
  });

  it.each(["ACCEPTED", "EN_ROUTE", "ARRIVED", "IN_PROGRESS", "COMPLETED"])(
    "%s implies acceptance happened",
    (s) => {
      expect(codes({ worker_status: s })).toContain("PROVIDER_ACCEPTED");
    }
  );

  it("ASSIGNED does NOT imply acceptance", () => {
    expect(codes({ assigned_at: T.assigned, worker_status: "ASSIGNED" })).not.toContain(
      "PROVIDER_ACCEPTED"
    );
  });
});

describe("declining is terminal", () => {
  it("nothing is emitted after a decline", () => {
    const out = codes({
      created_at: T.created,
      assigned_at: T.assigned,
      declined_at: T.accepted,
      // A stale timestamp on the row must not resurrect later stages.
      started_at: T.started,
      worker_status: "DECLINED",
    });
    expect(out).toEqual(["BOOKING_CREATED", "ASSIGNED", "PROVIDER_DECLINED"]);
    expect(out).not.toContain("PROVIDER_ACCEPTED");
    expect(out).not.toContain("JOB_STARTED");
  });
});

describe("cancellation", () => {
  it.each(["CANCELED", "CANCELLED"])("booking_status %s appends a cancellation", (s) => {
    expect(codes({ assigned_at: T.assigned, worker_status: "ACCEPTED", booking_status: s })).toContain(
      "BOOKING_CANCELLED"
    );
  });

  it("cancellation is last", () => {
    const out = codes({
      created_at: T.created,
      assigned_at: T.assigned,
      accepted_at: T.accepted,
      worker_status: "ACCEPTED",
      booking_status: "CANCELLED",
    });
    expect(out[out.length - 1]).toBe("BOOKING_CANCELLED");
  });
});

describe("nothing identifies a person", () => {
  it("actors are categories, never names or uids", () => {
    const events = buildBookingTimeline({
      created_at: T.created,
      assigned_at: T.assigned,
      accepted_at: T.accepted,
      worker_status: "ACCEPTED",
      booking_status: "CANCELLED",
    });
    for (const e of events) {
      expect(["YOU", "CUSTOMER", "SERVANA"]).toContain(e.actor);
      expect(e.label).not.toMatch(/worker-|uid|@|\+63/);
    }
  });

  it("no label names a replacement provider", () => {
    // §27: "Do not reveal the replacement provider."
    const events = buildBookingTimeline({
      assigned_at: T.assigned,
      worker_status: "DECLINED",
      declined_at: T.accepted,
    });
    const text = events.map((e) => e.label).join(" ").toLowerCase();
    expect(text).not.toContain("reassigned to");
    expect(text).not.toContain("another provider");
  });
});

describe("ordering is by sequence, not by clock", () => {
  it("skewed timestamps do not reorder a known lifecycle", () => {
    // If en_route_at somehow lands before assigned_at, the lifecycle order is
    // still the truth — a state machine that only moves forwards cannot have
    // genuinely gone backwards.
    const events = buildBookingTimeline({
      created_at: T.completed,
      assigned_at: T.completed,
      accepted_at: T.created,
      en_route_at: T.created,
      worker_status: "EN_ROUTE",
    });
    const seq = events.map((e) => e.sequence);
    expect(seq).toEqual([...seq].sort((a, b) => a - b));
    expect(events[0].code).toBe("BOOKING_CREATED");
  });
});

describe("timestamp handling", () => {
  it("accepts Date objects as well as ISO strings", () => {
    const events = buildBookingTimeline({
      assigned_at: new Date(T.assigned),
      worker_status: "ASSIGNED",
    });
    expect(events.find((e) => e.code === "ASSIGNED")!.at).toBe(T.assigned);
  });

  it("an unparseable timestamp yields no event rather than Invalid Date", () => {
    expect(codes({ assigned_at: "not-a-date", worker_status: "ASSIGNED" })).not.toContain(
      "ASSIGNED"
    );
  });

  it("empty string and null are both treated as absent", () => {
    expect(codes({ assigned_at: "", created_at: null, worker_status: "ASSIGNED" })).toEqual([]);
  });
});

describe("currentTimelineStep", () => {
  it("is the last event that happened", () => {
    const events = buildBookingTimeline({
      created_at: T.created,
      assigned_at: T.assigned,
      accepted_at: T.accepted,
      en_route_at: T.enRoute,
      worker_status: "EN_ROUTE",
    });
    expect(currentTimelineStep(events)).toBe("PROVIDER_EN_ROUTE");
  });

  it("is null for an empty timeline", () => {
    expect(currentTimelineStep([])).toBeNull();
  });
});

describe("stored admin-side events (C18-04)", () => {
  const derived = () =>
    buildBookingTimeline({
      created_at: T.created,
      assigned_at: T.assigned,
      accepted_at: T.accepted,
      worker_status: "ACCEPTED",
    });

  const stored = [
    { event_type: "booking_rescheduled", created_at: T.enRoute },
    { event_type: "dispute_opened", created_at: T.arrived },
  ];

  const merged = (rows: any[] = stored, isAssignee = true) =>
    mergeStoredEvents(derived(), rows, isAssignee).map((e) => e.code);

  it("a provider who still holds the booking sees admin actions", () => {
    const out = merged();
    expect(out).toContain("ADMIN_RESCHEDULED");
    expect(out).toContain("DISPUTE_OPENED");
  });

  it("a provider whose booking was reassigned away sees NONE of them", () => {
    // They keep their own history — a record of what they did — but not
    // surveillance of a booking that is no longer theirs.
    const out = merged(stored, false);
    expect(out).not.toContain("ADMIN_RESCHEDULED");
    expect(out).not.toContain("DISPUTE_OPENED");
    expect(out).toEqual(["BOOKING_CREATED", "ASSIGNED", "PROVIDER_ACCEPTED"]);
  });

  it("internal admin notes never cross", () => {
    // §22: admin-only notes are not provider-visible.
    const out = merged([{ event_type: "admin_note_added", created_at: T.enRoute }]);
    expect(out).toEqual(["BOOKING_CREATED", "ASSIGNED", "PROVIDER_ACCEPTED"]);
  });

  it("provider_reassigned is not surfaced", () => {
    // §27: do not reveal the replacement provider. Telling someone they were
    // replaced invites asking by whom.
    const out = merged([{ event_type: "provider_reassigned", created_at: T.enRoute }]);
    expect(out).not.toContain("ADMIN_ASSIGNED");
    expect(out.length).toBe(3);
  });

  it("an unknown event type is dropped, not passed through", () => {
    const out = merged([{ event_type: "some_future_admin_action", created_at: T.enRoute }]);
    expect(out).toEqual(["BOOKING_CREATED", "ASSIGNED", "PROVIDER_ACCEPTED"]);
  });

  it("a stored event with no usable timestamp is dropped", () => {
    for (const bad of [null, "", "nonsense", undefined]) {
      const out = merged([{ event_type: "booking_rescheduled", created_at: bad }]);
      expect(out).not.toContain("ADMIN_RESCHEDULED");
    }
  });

  it("no admin-authored text reaches the payload", () => {
    // Only event_type and created_at are selected server-side; labels are
    // fixed here. Even if title/description arrive, they must not surface.
    const events = mergeStoredEvents(
      derived(),
      [{
        event_type: "dispute_opened",
        created_at: T.arrived,
        title: "Dispute opened by admin Jane Cruz",
        description: "Provider accused of damage; withhold payout pending review",
        metadata: { severity: "high", assignedTeam: "trust-and-safety" },
      } as any],
      true
    );
    const json = JSON.stringify(events);
    expect(json).not.toContain("Jane Cruz");
    expect(json).not.toContain("withhold payout");
    expect(json).not.toContain("trust-and-safety");
    expect(json).toContain("A dispute was opened");
  });

  it("admin events are attributed to SERVANA, never a person", () => {
    const events = mergeStoredEvents(derived(), stored, true);
    for (const e of events.filter((x) => x.code.startsWith("ADMIN_") || x.code === "DISPUTE_OPENED")) {
      expect(e.actor).toBe("SERVANA");
    }
  });

  it("admin events slot into the lifecycle by time, not at the end", () => {
    // A reschedule that happened right after acceptance belongs there, not
    // after a completion that came later.
    const full = buildBookingTimeline({
      created_at: T.created,
      assigned_at: T.assigned,
      accepted_at: T.accepted,
      completed_at: T.completed,
      worker_status: "COMPLETED",
    });
    const out = mergeStoredEvents(
      full,
      [{ event_type: "booking_rescheduled", created_at: T.enRoute }],
      true
    ).map((e) => e.code);
    expect(out.indexOf("ADMIN_RESCHEDULED")).toBeLessThan(out.indexOf("JOB_COMPLETED"));
    expect(out.indexOf("ADMIN_RESCHEDULED")).toBeGreaterThan(out.indexOf("PROVIDER_ACCEPTED"));
  });

  it("an empty stored list changes nothing", () => {
    expect(mergeStoredEvents(derived(), [], true)).toEqual(derived());
  });
});
