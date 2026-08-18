/**
 * The booking-experience DECLARATION, checked against the things it claims to
 * describe.
 *
 *   CAPABILITY REGISTRY        one domain module each, contract ids resolve
 *   CALLER MATRIX              all five surfaces stated for every endpoint
 *   OTP PURPOSES               disjoint columns, non-overlapping actor rules
 *   CANCELLATION MATRIX        agrees with the executor, not with prose
 *   DISPUTE CATEGORIES         provider-facing list is a strict subset
 *   TRACKING RULE              three independent conditions, fails closed
 *   RESCHEDULE RULE            notice measured on the CURRENT start
 *   EVENT CATALOG              closed, and its timeline types are the live ones
 *
 * The declaration is executed by `scripts/generate-booking-docs.ts` to write
 * BOOKING_EXPERIENCES_V1_CONTRACT.md, so anything asserted here is also
 * something the published contract cannot misstate.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' }, tempId: undefined }));
jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
  pool: { connect: jest.fn() },
}));

import {
  EXPERIENCE_CAPABILITIES,
  CLIENT_SURFACES,
  EXPERIENCE_ACTORS,
  BOOKING_OTP_PURPOSES,
  BOOKING_OTP_PURPOSE_NAMES,
  otpColumnsAreDisjoint,
  canRequestOtp,
  canVerifyOtp,
  otpAppliesInState,
  isBookingOtpPurpose,
  TRACKING_LOCATION_STATES,
  TRACKING_MAX_HOURS_SINCE_MOVEMENT,
  evaluateTrackingVisibility,
  RESCHEDULE_REQUIRES_PROVIDER_ACCEPTANCE,
  CUSTOMER_RESCHEDULE_NOTICE_HOURS,
  RESCHEDULE_MAX_LEAD_DAYS,
  RESCHEDULABLE_STATES,
  RESCHEDULE_REASONS,
  evaluateReschedule,
  CANCELLATION_MATRIX,
  DISPUTE_CATEGORIES,
  DISPUTABLE_STATES,
  evaluateDisputeOpening,
  BOOKING_EXPERIENCE_EVENTS,
  UNEMITTED_EVENTS,
  eventSpec,
} from '../src/services/booking/experiencePolicy';
import { BOOKING_ACTIONS } from '../src/services/booking/transitionExecutor';
import { BOOKING_STATES } from '../src/services/booking/canonicalState';
import { V1_CONTRACT } from '../src/api/v1/contract';
import { PROVIDER_DISPUTE_CATEGORIES } from '../src/controllers/bookingDisputeView';
import { PROVIDER_CANCELLATION_REASONS } from '../src/services/booking/bookingPolicies';

const NOW = new Date('2026-08-20T09:00:00.000Z');
const hours = (n: number) => new Date(NOW.getTime() + n * 3_600_000);

describe('the capability registry is real, not aspirational', () => {
  it('covers exactly the six capabilities the command names', () => {
    expect(EXPERIENCE_CAPABILITIES.map((c) => c.key).sort()).toEqual(
      ['additionalWork', 'cancel', 'disputes', 'otp', 'reschedule', 'tracking'],
    );
  });

  it('every contract id it names actually exists', () => {
    for (const capability of EXPERIENCE_CAPABILITIES) {
      for (const id of capability.contractIds) {
        expect(V1_CONTRACT.find((e) => e.id === id)).toBeDefined();
      }
    }
  });

  it('every capability states WHY a role split does or does not remain', () => {
    // The command's cross-platform rule asks for exactly this sentence per
    // capability. A required field beats a comment that can be omitted.
    for (const capability of EXPERIENCE_CAPABILITIES) {
      expect(capability.roleSplitRationale.length).toBeGreaterThan(60);
      expect(capability.domainModule).toMatch(/^services\//);
    }
  });

  it('every endpoint states a caller state for all five surfaces', () => {
    const ids = EXPERIENCE_CAPABILITIES.flatMap((c) => c.contractIds);
    for (const id of ids) {
      const entry = V1_CONTRACT.find((e) => e.id === id)!;
      for (const surface of CLIENT_SURFACES) {
        expect(['migrated', 'legacy', 'planned', 'n/a']).toContain(entry.callers[surface]);
      }
    }
  });

  it('no capability claims two different domain modules for one business operation', () => {
    // The centralization rule, made checkable: a capability is ONE module.
    const byModule = new Map<string, string[]>();
    for (const c of EXPERIENCE_CAPABILITIES) {
      byModule.set(c.domainModule, [...(byModule.get(c.domainModule) ?? []), c.key]);
    }
    // additionalWork and the rest each own their module; cancel shares the
    // executor with nothing else in this registry.
    for (const [, keys] of byModule) expect(keys.length).toBe(1);
  });
});

describe('OTP purposes cannot be cross-used', () => {
  it('the two purposes read different columns', () => {
    expect(otpColumnsAreDisjoint()).toBe(true);
    expect(BOOKING_OTP_PURPOSES.BOOKING_CONFIRMATION.credentialColumn).toBe('otp_code');
    expect(BOOKING_OTP_PURPOSES.SERVICE_START.credentialColumn).toBe('worker_code');
  });

  it('every purpose names an action the executor actually has', () => {
    for (const name of BOOKING_OTP_PURPOSE_NAMES) {
      expect(Object.keys(BOOKING_ACTIONS)).toContain(BOOKING_OTP_PURPOSES[name].action);
    }
  });

  it('the provider may verify the service-start code and may NEVER request it', () => {
    // The inversion is the security property: the customer holds it, the
    // provider types it in. A provider who could rotate it could mint the proof
    // they are supposed to be given.
    expect(canVerifyOtp('SERVICE_START', 'assigned_provider')).toBe(true);
    expect(canRequestOtp('SERVICE_START', 'assigned_provider')).toBe(false);
    expect(canRequestOtp('BOOKING_CONFIRMATION', 'assigned_provider')).toBe(false);
  });

  it('the customer may not present the service-start code, nor the provider the confirmation', () => {
    expect(canVerifyOtp('SERVICE_START', 'customer')).toBe(false);
    expect(canVerifyOtp('BOOKING_CONFIRMATION', 'assigned_provider')).toBe(false);
  });

  it('every purpose has a bounded expiry, cooldown, attempt budget and issue ceiling', () => {
    for (const name of BOOKING_OTP_PURPOSE_NAMES) {
      const p = BOOKING_OTP_PURPOSES[name];
      expect(p.expiryMinutes).toBeGreaterThan(0);
      expect(p.resendCooldownSeconds).toBeGreaterThan(0);
      expect(p.maxVerifyAttempts).toBeGreaterThan(0);
      expect(p.maxIssues).toBeGreaterThan(0);
      // Unbounded in either direction would be the policy this tab removed.
      expect(p.expiryMinutes).toBeLessThanOrEqual(24 * 60);
      expect(p.maxVerifyAttempts).toBeLessThanOrEqual(10);
    }
  });

  it('the valid states of the two purposes do not overlap on the state that matters', () => {
    // A booking cannot simultaneously be awaiting confirmation and ready to
    // start, so a single state accepting both codes would be a design error.
    const confirmation: string[] = [...BOOKING_OTP_PURPOSES.BOOKING_CONFIRMATION.validStates];
    const start = new Set<string>(BOOKING_OTP_PURPOSES.SERVICE_START.validStates);
    const both = confirmation.filter((s) => start.has(s));
    expect(both).toEqual([]);
  });

  it('every valid state is a real canonical state', () => {
    for (const name of BOOKING_OTP_PURPOSE_NAMES) {
      for (const state of BOOKING_OTP_PURPOSES[name].validStates) {
        expect(BOOKING_STATES).toContain(state);
      }
    }
    expect(otpAppliesInState('SERVICE_START', 'ARRIVED')).toBe(true);
    expect(otpAppliesInState('SERVICE_START', 'COMPLETED')).toBe(false);
  });

  it('the purpose vocabulary is closed', () => {
    expect(isBookingOtpPurpose('BOOKING_CONFIRMATION')).toBe(true);
    expect(isBookingOtpPurpose('PASSWORD_RESET')).toBe(false);
    expect(isBookingOtpPurpose('')).toBe(false);
  });
});

describe('the cancellation matrix agrees with the executor', () => {
  it('every rule names an action the machine has, with the same actor', () => {
    for (const rule of CANCELLATION_MATRIX) {
      const spec = BOOKING_ACTIONS[rule.action] as Record<string, unknown>;
      expect(spec).toBeDefined();
      expect(spec.actor).toBe(rule.actor);
    }
  });

  it('every rule names the guard the executor actually runs', () => {
    for (const rule of CANCELLATION_MATRIX) {
      const spec = BOOKING_ACTIONS[rule.action] as Record<string, unknown>;
      expect(spec.guard ?? null).toBe(rule.guard);
    }
  });

  it("the provider rule's source states are the executor's, not a second list", () => {
    const spec = BOOKING_ACTIONS.PROVIDER_CANCEL as Record<string, unknown>;
    const rule = CANCELLATION_MATRIX.find((r) => r.action === 'PROVIDER_CANCEL')!;
    expect([...rule.from]).toEqual([...(spec.from as string[])]);
  });

  it("the admin rule's source states are the executor's", () => {
    const spec = BOOKING_ACTIONS.ADMIN_CANCEL as Record<string, unknown>;
    const rule = CANCELLATION_MATRIX.find((r) => r.action === 'ADMIN_CANCEL')!;
    expect([...rule.from]).toEqual([...(spec.from as string[])]);
  });

  it('the provider reason vocabulary is the shipped one, not a copy', () => {
    const rule = CANCELLATION_MATRIX.find((r) => r.action === 'PROVIDER_CANCEL')!;
    expect([...rule.reasonCodes]).toEqual([...PROVIDER_CANCELLATION_REASONS]);
  });

  it('all three actors are covered, and only those three', () => {
    expect(CANCELLATION_MATRIX.map((r) => r.actor).sort()).toEqual(
      ['admin', 'assigned_provider', 'customer'],
    );
    for (const actor of CANCELLATION_MATRIX.map((r) => r.actor)) {
      expect(EXPERIENCE_ACTORS).toContain(actor);
    }
  });

  it('every rule states a financial consequence, including "none"', () => {
    // "Do not invent penalties" is only a real instruction if the absence is
    // written down; an empty field reads as an oversight.
    for (const rule of CANCELLATION_MATRIX) {
      expect(rule.financialConsequence.length).toBeGreaterThan(40);
    }
  });

  it('an admin may cancel from strictly more states than a customer', () => {
    const customer = CANCELLATION_MATRIX.find((r) => r.actor === 'customer')!;
    const admin = CANCELLATION_MATRIX.find((r) => r.actor === 'admin')!;
    for (const state of customer.from) expect(admin.from).toContain(state);
    expect(admin.from.length).toBeGreaterThan(customer.from.length);
    // IN_PROGRESS is the one that matters: live work is an admin matter.
    expect(admin.from).toContain('IN_PROGRESS');
    expect(customer.from).not.toContain('IN_PROGRESS');
  });
});

describe('tracking visibility: three conditions, failing closed', () => {
  const base = {
    state: 'EN_ROUTE' as const,
    hasAssignment: true,
    lastMovementAt: hours(-1),
    hasPosition: true,
    now: NOW,
  };

  it('discloses only when all three hold', () => {
    expect(evaluateTrackingVisibility(base).visibility).toBe('VISIBLE');
  });

  it('withholds with NO_ASSIGNMENT before it considers the state', () => {
    // A truer answer for a booking still waiting for a provider.
    const v = evaluateTrackingVisibility({ ...base, hasAssignment: false, state: 'AWAITING_ASSIGNMENT' });
    expect(v.reason).toBe('NO_ASSIGNMENT');
  });

  it('withholds in every state outside the trackable list', () => {
    for (const state of BOOKING_STATES) {
      const v = evaluateTrackingVisibility({ ...base, state });
      if (TRACKING_LOCATION_STATES.includes(state)) {
        expect(v.visibility).toBe('VISIBLE');
      } else {
        expect(v.visibility).toBe('WITHHELD');
        expect(v.reason).toBe('STATE_NOT_TRACKABLE');
      }
    }
  });

  it('a cancelled or completed booking never discloses a position', () => {
    for (const state of ['CANCELLED', 'COMPLETED', 'EXPIRED', 'DISPUTED'] as const) {
      expect(evaluateTrackingVisibility({ ...base, state }).visibility).toBe('WITHHELD');
    }
  });

  it('closes the window after the declared hours since the last movement', () => {
    const stale = evaluateTrackingVisibility({
      ...base,
      lastMovementAt: hours(-(TRACKING_MAX_HOURS_SINCE_MOVEMENT + 1)),
    });
    expect(stale.reason).toBe('WINDOW_EXPIRED');

    const fresh = evaluateTrackingVisibility({
      ...base,
      lastMovementAt: hours(-(TRACKING_MAX_HOURS_SINCE_MOVEMENT - 1)),
    });
    expect(fresh.visibility).toBe('VISIBLE');
  });

  it('FAILS CLOSED when the movement time is unknown', () => {
    // A trackable state reached with no recorded transition cannot be proven
    // recent, and a stale position is what the window exists to stop.
    const v = evaluateTrackingVisibility({ ...base, lastMovementAt: null });
    expect(v.visibility).toBe('WITHHELD');
    expect(v.reason).toBe('WINDOW_EXPIRED');
  });

  it('distinguishes "no position reported" from "not allowed to see it"', () => {
    const v = evaluateTrackingVisibility({ ...base, hasPosition: false });
    expect(v.reason).toBe('NO_POSITION_REPORTED');
  });

  it('publishes the window close so a client need not compute it', () => {
    const v = evaluateTrackingVisibility(base);
    expect(v.windowClosesAt).toBe(
      new Date(base.lastMovementAt!.getTime() + TRACKING_MAX_HOURS_SINCE_MOVEMENT * 3_600_000).toISOString(),
    );
    expect(v.trackableStates).toEqual(TRACKING_LOCATION_STATES);
  });
});

describe('reschedule policy', () => {
  const base = {
    state: 'ACCEPTED' as const,
    actor: 'customer' as const,
    currentSchedule: hours(72).toISOString(),
    proposedSchedule: hours(120).toISOString(),
    reasonCode: 'CUSTOMER_UNAVAILABLE',
    now: NOW,
  };

  it('the provider is not a party, and that is declared rather than implied', () => {
    expect(RESCHEDULE_REQUIRES_PROVIDER_ACCEPTANCE).toBe(false);
  });

  it('allows a well-formed customer move', () => {
    const v = evaluateReschedule(base);
    expect(v.allowed).toBe(true);
    expect(v.noticeHours).toBe(CUSTOMER_RESCHEDULE_NOTICE_HOURS);
  });

  it('refuses from a state that may not be moved', () => {
    for (const state of BOOKING_STATES) {
      const v = evaluateReschedule({ ...base, state });
      if (RESCHEDULABLE_STATES.includes(state)) expect(v.allowed).toBe(true);
      else expect(v.refusal).toBe('STATE_NOT_RESCHEDULABLE');
    }
    // The two that matter most.
    expect(evaluateReschedule({ ...base, state: 'IN_PROGRESS' }).refusal).toBe('STATE_NOT_RESCHEDULABLE');
    expect(evaluateReschedule({ ...base, state: 'DISPUTED' }).refusal).toBe('STATE_NOT_RESCHEDULABLE');
  });

  it('measures the notice window against the CURRENT start, not the new one', () => {
    // Moving a booking that starts in an hour is the disruption, whatever the
    // new date is — the provider has already planned their day around the old.
    const v = evaluateReschedule({ ...base, currentSchedule: hours(2).toISOString() });
    expect(v.refusal).toBe('INSIDE_NOTICE_WINDOW');
    expect(v.noticeCutoff).toBe(new Date(hours(2).getTime() - CUSTOMER_RESCHEDULE_NOTICE_HOURS * 3_600_000).toISOString());
  });

  it('exempts an admin from the notice window', () => {
    const v = evaluateReschedule({ ...base, actor: 'admin', currentSchedule: hours(1).toISOString() });
    expect(v.allowed).toBe(true);
    expect(v.noticeHours).toBe(0);
  });

  it('fails closed when the current schedule is unusable and notice applies', () => {
    expect(evaluateReschedule({ ...base, currentSchedule: null }).refusal).toBe('INSIDE_NOTICE_WINDOW');
    // An admin has no notice to satisfy, so the same booking is movable.
    expect(evaluateReschedule({ ...base, actor: 'admin', currentSchedule: null }).allowed).toBe(true);
  });

  it('refuses a past, unparseable or far-future instant', () => {
    expect(evaluateReschedule({ ...base, proposedSchedule: hours(-1).toISOString() }).refusal).toBe('SCHEDULE_INVALID');
    expect(evaluateReschedule({ ...base, proposedSchedule: 'not-a-date' }).refusal).toBe('SCHEDULE_INVALID');
    expect(evaluateReschedule({ ...base, proposedSchedule: null }).refusal).toBe('SCHEDULE_INVALID');
    expect(
      evaluateReschedule({
        ...base,
        proposedSchedule: new Date(NOW.getTime() + (RESCHEDULE_MAX_LEAD_DAYS + 1) * 86_400_000).toISOString(),
      }).refusal,
    ).toBe('SCHEDULE_INVALID');
  });

  it('refuses a reason code outside the standardized list, and permits none at all', () => {
    expect(evaluateReschedule({ ...base, reasonCode: 'BECAUSE' }).refusal).toBe('REASON_INVALID');
    expect(evaluateReschedule({ ...base, reasonCode: null }).allowed).toBe(true);
    for (const code of RESCHEDULE_REASONS) {
      expect(evaluateReschedule({ ...base, reasonCode: code }).allowed).toBe(true);
    }
  });
});

describe('dispute opening', () => {
  const base = {
    state: 'COMPLETED' as const,
    hasOpenDispute: false,
    category: 'SERVICE_QUALITY',
    reason: 'The work was not finished.',
  };

  it('allows a well-formed dispute', () => {
    expect(evaluateDisputeOpening(base).allowed).toBe(true);
  });

  it('refuses a duplicate BEFORE anything else', () => {
    // §66. Who raised the open one is irrelevant — the booking is under review.
    const v = evaluateDisputeOpening({ ...base, hasOpenDispute: true, category: 'nonsense', reason: '' });
    expect(v.refusal).toBe('ALREADY_OPEN');
  });

  it('refuses from a state nobody has committed to', () => {
    for (const state of BOOKING_STATES) {
      const v = evaluateDisputeOpening({ ...base, state });
      if (DISPUTABLE_STATES.includes(state)) expect(v.allowed).toBe(true);
      else expect(v.refusal).toBe('NOT_YET_ACTIONABLE');
    }
    expect(evaluateDisputeOpening({ ...base, state: 'PENDING_OTP' }).refusal).toBe('NOT_YET_ACTIONABLE');
    expect(evaluateDisputeOpening({ ...base, state: 'ASSIGNED' }).refusal).toBe('NOT_YET_ACTIONABLE');
  });

  it('refuses an unknown category and an empty reason', () => {
    expect(evaluateDisputeOpening({ ...base, category: 'MY_OWN_REASON' }).refusal).toBe('CATEGORY_INVALID');
    expect(evaluateDisputeOpening({ ...base, category: null }).refusal).toBe('CATEGORY_INVALID');
    expect(evaluateDisputeOpening({ ...base, reason: '   ' }).refusal).toBe('REASON_REQUIRED');
  });

  it('the shipped provider category list is a strict SUBSET of the canonical one', () => {
    // A provider offered a category the canonical service rejects is a dead
    // menu — the exact failure a second vocabulary produces.
    for (const category of PROVIDER_DISPUTE_CATEGORIES) {
      expect(DISPUTE_CATEGORIES).toContain(category);
    }
    expect(DISPUTE_CATEGORIES.length).toBeGreaterThan(PROVIDER_DISPUTE_CATEGORIES.length);
  });

  it('offers categories only alongside a usable entry point', () => {
    expect(evaluateDisputeOpening(base).categories).toEqual(DISPUTE_CATEGORIES);
    expect(evaluateDisputeOpening({ ...base, hasOpenDispute: true }).categories).toEqual([]);
  });
});

describe('the domain-event catalog is closed and honest', () => {
  it('every event name is unique and namespaced by its capability', () => {
    const names = BOOKING_EXPERIENCE_EVENTS.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
    for (const event of BOOKING_EXPERIENCE_EVENTS) {
      expect(event.name.startsWith(`${event.capability}.`)).toBe(true);
    }
  });

  it('every event belongs to a declared capability', () => {
    const keys = EXPERIENCE_CAPABILITIES.map((c) => c.key);
    for (const event of BOOKING_EXPERIENCE_EVENTS) {
      expect(keys).toContain(event.capability);
    }
  });

  it('reuses the timeline types the admin portal already renders', () => {
    // A new spelling for an existing event is a silent break of every reader.
    expect(eventSpec('reschedule.applied').timelineType).toBe('booking_rescheduled');
    expect(eventSpec('disputes.opened').timelineType).toBe('dispute_opened');
  });

  it('names the one event that is deliberately NOT emitted, and says why', () => {
    expect(UNEMITTED_EVENTS).toEqual(['tracking.viewed']);
    expect(eventSpec('tracking.viewed').why).toMatch(/DECLARED, NOT EMITTED/);
  });

  it('every event explains itself', () => {
    for (const event of BOOKING_EXPERIENCE_EVENTS) {
      expect(event.why.length).toBeGreaterThan(30);
    }
  });
});
