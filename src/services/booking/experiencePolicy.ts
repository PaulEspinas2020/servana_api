/**
 * THE declaration of every booking-adjacent experience: tracking, OTP, cancel,
 * reschedule, additional work and disputes.
 *
 * ## Why one file, and why it holds no SQL
 *
 * Before this, each of these six capabilities was a rule implemented wherever
 * its first caller happened to live. Cancellation policy sat in the executor's
 * guards, tracking authorization sat in a controller, the OTP's lifetime sat in
 * a docblock saying it had none, and reschedule existed only as an admin
 * service that overwrote `bookings.schedule` with an UPDATE. Five clients then
 * each decided for themselves what those rules were, because there was nothing
 * to read.
 *
 * This module is the thing to read. It is pure data and pure functions — no
 * database handle, no Express types, no side effects — so that:
 *
 *   1. the services enforce it,
 *   2. `scripts/generate-booking-docs.ts` EXECUTES it to write
 *      `docs/booking/BOOKING_EXPERIENCES_V1_CONTRACT.md`, and
 *   3. the tests assert against it
 *
 * all from the same declaration. A policy that is described in prose alongside
 * its implementation drifts; one that is derived cannot.
 *
 * ## What is deliberately NOT here
 *
 * State transitions. `canonicalState.TRANSITIONS` and
 * `transitionExecutor.BOOKING_ACTIONS` remain the only lifecycle authority, and
 * every experience that changes a booking's state does so by naming an action
 * there. This file constrains WHEN an experience may be attempted; it never
 * decides what the booking becomes.
 */

import type { BookingState } from './canonicalState';
import { PROVIDER_CANCELLATION_REASONS } from './bookingPolicies';

// ─── Actors, as the experiences see them ──────────────────────────────────────

/**
 * Who is asking. The same four the state machine knows, minus `system` — every
 * experience here is initiated by a request, never by a scheduled job.
 */
export type ExperienceActor = 'customer' | 'assigned_provider' | 'admin';

export const EXPERIENCE_ACTORS: readonly ExperienceActor[] = [
  'customer',
  'assigned_provider',
  'admin',
];

// ─── The capability registry ──────────────────────────────────────────────────

/** The five surfaces the platform serves. Named so the matrix cannot omit one. */
export type ClientSurface =
  | 'customerMobile'
  | 'customerWeb'
  | 'providerMobile'
  | 'providerWeb'
  | 'admin';

export const CLIENT_SURFACES: readonly ClientSurface[] = [
  'customerMobile',
  'customerWeb',
  'providerMobile',
  'providerWeb',
  'admin',
];

export interface ExperienceCapability {
  /** Stable key. Also the prefix of every domain event this capability emits. */
  key: string;
  title: string;
  /** The canonical v1 contract ids that serve it. */
  contractIds: readonly string[];
  /** The ONE domain module behind every one of those endpoints. */
  domainModule: string;
  /** Actors permitted to invoke it at all, before any state rule. */
  actors: readonly ExperienceActor[];
  /**
   * Why a role-specific endpoint survives, or the assertion that none does.
   *
   * The command's centralization rule asks for exactly this sentence per
   * capability, so it is a required field rather than a comment.
   */
  roleSplitRationale: string;
}

export const EXPERIENCE_CAPABILITIES = [
  {
    key: 'tracking',
    title: 'Tracking',
    contractIds: ['bookings.tracking'],
    domainModule: 'services/booking/bookingTrackingService',
    actors: ['customer', 'assigned_provider', 'admin'],
    roleSplitRationale:
      'No role split. One booking-scoped endpoint answers all three actors; the ' +
      'provider position is withheld or disclosed by the SAME visibility rule ' +
      'regardless of who asks, so a provider reading their own job and a customer ' +
      'watching it see one authorization decision.',
  },
  {
    key: 'otp',
    title: 'Booking codes (OTP)',
    contractIds: ['bookings.otp.request', 'bookings.otp.verify'],
    domainModule: 'services/booking/bookingOtpService',
    actors: ['customer', 'assigned_provider', 'admin'],
    roleSplitRationale:
      'No role split. One request endpoint and one verify endpoint, both scoped ' +
      'by `purpose`. The actor rules differ PER PURPOSE, not per client: only the ' +
      'holder of a code may verify it, and a provider may never request the code ' +
      'they are required to be told.',
  },
  {
    key: 'cancel',
    title: 'Cancellation',
    contractIds: ['bookings.cancel', 'provider.jobs.cancel'],
    domainModule: 'services/booking/transitionExecutor',
    actors: ['customer', 'assigned_provider', 'admin'],
    roleSplitRationale:
      'Role-specific endpoints, one state machine. Customer, provider and admin ' +
      'cancellation are three different ACTIONS with three different guards and ' +
      'three different notification fan-outs — but all three are `transitionBooking` ' +
      'calls against the same transition whitelist, so no client can cancel from a ' +
      'state another client could not.',
  },
  {
    key: 'reschedule',
    title: 'Reschedule',
    contractIds: ['bookings.reschedule'],
    domainModule: 'services/booking/bookingRescheduleService',
    actors: ['customer', 'admin'],
    roleSplitRationale:
      'No role split. The admin path differs only in which policy checks apply ' +
      '(an admin may move a booking inside the customer notice window), and that ' +
      'difference is evaluated by the same function from the same declaration ' +
      'below rather than by a second endpoint.',
  },
  {
    key: 'additionalWork',
    title: 'Additional work',
    contractIds: ['bookings.additionalWork.create', 'bookings.additionalWork.list'],
    domainModule: 'services/additional.service',
    actors: ['assigned_provider', 'admin', 'customer'],
    roleSplitRationale:
      'Creation is provider-only because only the provider on site can observe ' +
      'work the booking did not cover; the READ is shared. Approval and payment ' +
      'remain on the legacy `/api/additional/*` family, which Provider Web calls ' +
      'today, and both families call the same `additionalService` instance.',
  },
  {
    key: 'disputes',
    title: 'Disputes',
    contractIds: ['bookings.disputes.open', 'bookings.disputes.list'],
    domainModule: 'services/booking/bookingDisputeService',
    actors: ['customer', 'assigned_provider', 'admin'],
    roleSplitRationale:
      'No role split. One open endpoint for all three actors writing one ' +
      '`booking_escalations` row, so admin, provider and customer cannot disagree ' +
      'about whether a booking is disputed. What each actor may READ back differs; ' +
      'what is RECORDED does not.',
  },
] as const satisfies readonly ExperienceCapability[];

export type ExperienceKey = (typeof EXPERIENCE_CAPABILITIES)[number]['key'];

// ─── OTP: purpose, issuer, recipient, expiry, cooldown, attempts ──────────────

/**
 * The booking codes, and everything true about each one.
 *
 * ## Two codes have always existed; neither had a lifetime
 *
 * `bookings.otp_code` proves the customer confirmed the booking.
 * `bookings.worker_code` proves the customer is present when work starts. Both
 * are six digits, both are compared inside the mutating statement, and before
 * this tab both had **no expiry, no attempt limit and no resend cooldown** —
 * `bookingService.confirmOtp`'s docblock said so outright, and preserving that
 * was the right call for a state-machine migration whose job was not to change
 * product policy.
 *
 * §63 of this command changes the policy deliberately: purpose, issuer,
 * recipient, expiry, resend cooldown, attempt limit and audit are all required.
 * The numbers below are therefore an operator decision recorded in one place,
 * not a constant discovered in a controller.
 *
 * ## Scoping is what stops cross-use
 *
 * A code is minted FOR a booking and FOR a purpose. `verify` compares it against
 * the column that purpose names, and refuses an actor the purpose does not list.
 * A confirmation code presented as a service-start code is therefore checked
 * against `worker_code` and fails — it cannot be "reused elsewhere" because
 * there is no elsewhere that reads `otp_code`.
 */
export interface BookingOtpPurposeSpec {
  /** The column on `bookings` that stores the current code for this purpose. */
  credentialColumn: 'otp_code' | 'worker_code';
  /** Who mints it. Always the server — a code a client can choose is not a code. */
  issuer: 'system';
  /** Who receives and holds it. */
  recipient: 'customer';
  /** How it reaches the recipient. */
  delivery: 'email' | 'booking_detail';
  /** The executor action a successful verification performs. */
  action: 'CUSTOMER_CONFIRM_OTP' | 'PROVIDER_START';
  /** Minutes a freshly issued code stays valid. */
  expiryMinutes: number;
  /** Seconds that must pass between two issues for this booking and purpose. */
  resendCooldownSeconds: number;
  /** Failed verifications allowed against one issued code before it is dead. */
  maxVerifyAttempts: number;
  /** Issues allowed for one booking and purpose, ever. Bounds a resend loop. */
  maxIssues: number;
  /** Who may ask for a (re)issue. */
  requestableBy: readonly ExperienceActor[];
  /** Who may present it. The holder is never the same actor for both purposes. */
  verifiableBy: readonly ExperienceActor[];
  /** Canonical states in which a request or a verify is meaningful. */
  validStates: readonly BookingState[];
  why: string;
}

export const BOOKING_OTP_PURPOSES = {
  /** The customer confirms the booking they created. */
  BOOKING_CONFIRMATION: {
    credentialColumn: 'otp_code',
    issuer: 'system',
    recipient: 'customer',
    delivery: 'email',
    action: 'CUSTOMER_CONFIRM_OTP',
    expiryMinutes: 60,
    resendCooldownSeconds: 60,
    maxVerifyAttempts: 5,
    maxIssues: 10,
    requestableBy: ['customer', 'admin'],
    verifiableBy: ['customer', 'admin'],
    validStates: ['PENDING_OTP', 'AWAITING_ASSIGNMENT'],
    why:
      'Emailed at creation and on request. Sixty minutes because it arrives by ' +
      'email and a customer who steps away from their inbox should not lose the ' +
      'booking; the resend path makes a longer window unnecessary.',
  },
  /**
   * The customer proves presence so the provider may start work.
   *
   * The RECIPIENT is the customer even though the VERIFIER is the provider —
   * that inversion is the entire security property. The customer reads the code
   * out on the doorstep; the provider types it in. So `requestableBy` excludes
   * the provider: a provider who could rotate this code could mint the proof
   * they are supposed to be given.
   */
  SERVICE_START: {
    credentialColumn: 'worker_code',
    issuer: 'system',
    recipient: 'customer',
    delivery: 'booking_detail',
    action: 'PROVIDER_START',
    expiryMinutes: 720,
    resendCooldownSeconds: 60,
    maxVerifyAttempts: 5,
    maxIssues: 10,
    requestableBy: ['customer', 'admin'],
    verifiableBy: ['assigned_provider'],
    validStates: ['ASSIGNED', 'ACCEPTED', 'EN_ROUTE', 'ARRIVED'],
    why:
      'Issued with the assignment and shown in the booking detail, so it must ' +
      'survive the whole approach — twelve hours covers a job assigned in the ' +
      'morning for an afternoon visit without lasting into another day.',
  },
} as const satisfies Record<string, BookingOtpPurposeSpec>;

export type BookingOtpPurpose = keyof typeof BOOKING_OTP_PURPOSES;

export const BOOKING_OTP_PURPOSE_NAMES = Object.keys(
  BOOKING_OTP_PURPOSES,
) as BookingOtpPurpose[];

export const isBookingOtpPurpose = (value: unknown): value is BookingOtpPurpose =>
  typeof value === 'string' &&
  Object.prototype.hasOwnProperty.call(BOOKING_OTP_PURPOSES, value);

/**
 * The three questions the purpose registry answers, as predicates.
 *
 * Callers ask these rather than reaching into the spec and calling `.includes`.
 * The declaration is `as const`, so its arrays are literal tuples and a direct
 * `includes` against a wider actor type does not compile — which is a real
 * property worth keeping (the tuple types document exactly who is permitted),
 * but it should cost the policy module one helper rather than costing every
 * caller a cast.
 */
export const canRequestOtp = (purpose: BookingOtpPurpose, actor: ExperienceActor): boolean =>
  (BOOKING_OTP_PURPOSES[purpose].requestableBy as readonly ExperienceActor[]).includes(actor);

export const canVerifyOtp = (purpose: BookingOtpPurpose, actor: ExperienceActor): boolean =>
  (BOOKING_OTP_PURPOSES[purpose].verifiableBy as readonly ExperienceActor[]).includes(actor);

export const otpAppliesInState = (purpose: BookingOtpPurpose, state: BookingState): boolean =>
  (BOOKING_OTP_PURPOSES[purpose].validStates as readonly BookingState[]).includes(state);

/**
 * The two purposes may not share a column.
 *
 * Asserted as a function rather than trusted, because the day they do share one
 * is the day a confirmation code starts a job.
 */
export const otpColumnsAreDisjoint = (): boolean => {
  const columns = BOOKING_OTP_PURPOSE_NAMES.map(
    (p) => BOOKING_OTP_PURPOSES[p].credentialColumn,
  );
  return new Set(columns).size === columns.length;
};

// ─── Tracking authorization ───────────────────────────────────────────────────

/**
 * When a provider's live position may be disclosed on a booking.
 *
 * §64: "Do not expose provider location outside eligible active jobs." The rule
 * has three independent conditions and a refusal names which one failed, so a
 * client can say "tracking starts when your professional sets off" instead of
 * showing an empty map — the defect the customer app already shipped once.
 *
 * The booking's TIMELINE, by contrast, is not location and is readable by any
 * entitled caller in any state. Collapsing the two would either leak position or
 * hide history.
 */
export const TRACKING_LOCATION_STATES: readonly BookingState[] = [
  'EN_ROUTE',
  'ARRIVED',
  'IN_PROGRESS',
];

/**
 * Hours after the provider's last movement event before the position goes dark.
 *
 * A job that is never completed would otherwise share a provider's position
 * forever. Measured from the last EN_ROUTE / ARRIVED / IN_PROGRESS transition
 * rather than from the schedule, because a job that started late is still live.
 */
export const TRACKING_MAX_HOURS_SINCE_MOVEMENT = 12;

export type TrackingVisibility = 'VISIBLE' | 'WITHHELD';

export type TrackingWithheldReason =
  /** The booking has no provider on it yet. */
  | 'NO_ASSIGNMENT'
  /** The provider has not set off; there is nothing to watch. */
  | 'STATE_NOT_TRACKABLE'
  /** The tracking window closed on a job that never reached a terminal state. */
  | 'WINDOW_EXPIRED'
  /** Assigned and moving, but the provider has reported no position. */
  | 'NO_POSITION_REPORTED';

export interface TrackingVerdict {
  visibility: TrackingVisibility;
  reason: TrackingWithheldReason | null;
  /** The states in which a position would be shown. For the client's copy. */
  trackableStates: readonly BookingState[];
  /** When the window closes, ISO-8601. Null when it has not opened. */
  windowClosesAt: string | null;
}

/**
 * The whole rule, as one pure function.
 *
 * Takes the derived state and the last movement instant rather than a booking
 * row, so the service, the tests and the documentation all evaluate the same
 * logic without a database.
 */
export function evaluateTrackingVisibility(params: {
  state: BookingState;
  hasAssignment: boolean;
  /** Last transition into a trackable state. Null when there was none. */
  lastMovementAt: Date | null;
  hasPosition: boolean;
  now: Date;
}): TrackingVerdict {
  const { state, hasAssignment, lastMovementAt, hasPosition, now } = params;

  const windowClosesAt = lastMovementAt
    ? new Date(
        lastMovementAt.getTime() + TRACKING_MAX_HOURS_SINCE_MOVEMENT * 3_600_000,
      ).toISOString()
    : null;

  const withheld = (reason: TrackingWithheldReason): TrackingVerdict => ({
    visibility: 'WITHHELD',
    reason,
    trackableStates: TRACKING_LOCATION_STATES,
    windowClosesAt,
  });

  // Order matters: "nobody is assigned" is a truer answer than "not in a
  // trackable state" for a booking still waiting for a provider.
  if (!hasAssignment) return withheld('NO_ASSIGNMENT');
  if (!TRACKING_LOCATION_STATES.includes(state)) return withheld('STATE_NOT_TRACKABLE');

  // Fails closed on an unknown movement time. A trackable state reached without
  // a recorded transition cannot be proven to be recent, and a stale position is
  // exactly what the window exists to stop.
  if (!lastMovementAt) return withheld('WINDOW_EXPIRED');
  if (now.getTime() > lastMovementAt.getTime() + TRACKING_MAX_HOURS_SINCE_MOVEMENT * 3_600_000) {
    return withheld('WINDOW_EXPIRED');
  }

  if (!hasPosition) return withheld('NO_POSITION_REPORTED');

  return {
    visibility: 'VISIBLE',
    reason: null,
    trackableStates: TRACKING_LOCATION_STATES,
    windowClosesAt,
  };
}

// ─── Reschedule ───────────────────────────────────────────────────────────────

/**
 * Whether the assigned provider must agree before a booking moves.
 *
 * **false**, and the reason is recorded rather than assumed. §62 asks for
 * proposal/acceptance "if both parties must agree"; the operator has already
 * decided they do not — `adminBookingService.adminRescheduleBooking` states the
 * C18 §14/§24 policy verbatim: "the provider is NOT a party to rescheduling —
 * per operator policy only the customer and admin may move a booking, and the
 * provider only responds to the outcome."
 *
 * That policy is preserved. What is NOT preserved is the silent overwrite: every
 * accepted move now writes a proposal row first, so a schedule change has a
 * proposer, a before, an after and a reason. Flipping this flag turns the same
 * record into an acceptance workflow without a second schema.
 */
export const RESCHEDULE_REQUIRES_PROVIDER_ACCEPTANCE = false;

/** Minimum notice a CUSTOMER must give to move their own booking, in hours. */
export const CUSTOMER_RESCHEDULE_NOTICE_HOURS = 24;

/**
 * How far ahead a booking may be moved, in days.
 *
 * A bound rather than a preference: an unbounded new date lets a caller park a
 * booking beyond every operational report and outside any provider's calendar.
 */
export const RESCHEDULE_MAX_LEAD_DAYS = 180;

/**
 * States a booking may be rescheduled from.
 *
 * IN_PROGRESS is absent deliberately — work that has started is finished,
 * cancelled or disputed, never moved. DISPUTED is absent for the same reason a
 * disputed booking is not silently edited.
 */
export const RESCHEDULABLE_STATES: readonly BookingState[] = [
  'PENDING_OTP',
  'AWAITING_ASSIGNMENT',
  'ASSIGNED',
  'ACCEPTED',
  'EN_ROUTE',
  'ARRIVED',
];

export const RESCHEDULE_REASONS = [
  'CUSTOMER_UNAVAILABLE',
  'PROPERTY_NOT_READY',
  'WEATHER',
  'PROVIDER_SUPPLY',
  'OPERATIONAL',
  'OTHER',
] as const;

export type RescheduleReason = (typeof RESCHEDULE_REASONS)[number];

export type RescheduleRefusal =
  /** The booking is in a state that may not be moved. */
  | 'STATE_NOT_RESCHEDULABLE'
  /** The new instant is unparseable, in the past, or beyond the lead bound. */
  | 'SCHEDULE_INVALID'
  /** A customer inside their notice window. Admin is exempt. */
  | 'INSIDE_NOTICE_WINDOW'
  /** Reason code outside the standardized list. */
  | 'REASON_INVALID'
  /** The assigned provider is already booked across the proposed span. */
  | 'PROVIDER_CONFLICT'
  /** The caller read one schedule and the booking has since moved. */
  | 'SCHEDULE_CHANGED';

export interface RescheduleVerdict {
  allowed: boolean;
  refusal: RescheduleRefusal | null;
  /** ISO-8601 of the earliest instant this actor could still have moved it to. */
  noticeCutoff: string | null;
  noticeHours: number;
  reasons: readonly string[];
}

/**
 * The policy half of a reschedule: everything decidable without the provider's
 * calendar.
 *
 * `PROVIDER_CONFLICT` is deliberately NOT decided here — it needs a query, and
 * this module holds no database handle. The service runs this first and the
 * conflict check second, so a refusal that can be given cheaply is.
 */
export function evaluateReschedule(params: {
  state: BookingState;
  actor: ExperienceActor;
  currentSchedule: unknown;
  proposedSchedule: unknown;
  reasonCode?: string | null;
  now: Date;
}): RescheduleVerdict {
  const { state, actor, currentSchedule, proposedSchedule, reasonCode, now } = params;

  const current =
    currentSchedule instanceof Date
      ? currentSchedule
      : currentSchedule
        ? new Date(String(currentSchedule))
        : null;
  const currentValid = !!current && !Number.isNaN(current.getTime());

  const noticeHours = actor === 'admin' ? 0 : CUSTOMER_RESCHEDULE_NOTICE_HOURS;
  const noticeCutoff =
    currentValid && noticeHours > 0
      ? new Date(current!.getTime() - noticeHours * 3_600_000).toISOString()
      : null;

  const refuse = (refusal: RescheduleRefusal): RescheduleVerdict => ({
    allowed: false,
    refusal,
    noticeCutoff,
    noticeHours,
    reasons: [],
  });

  if (!RESCHEDULABLE_STATES.includes(state)) return refuse('STATE_NOT_RESCHEDULABLE');

  const proposed =
    proposedSchedule instanceof Date
      ? proposedSchedule
      : proposedSchedule
        ? new Date(String(proposedSchedule))
        : null;
  if (!proposed || Number.isNaN(proposed.getTime())) return refuse('SCHEDULE_INVALID');
  if (proposed.getTime() <= now.getTime()) return refuse('SCHEDULE_INVALID');
  if (proposed.getTime() > now.getTime() + RESCHEDULE_MAX_LEAD_DAYS * 86_400_000) {
    return refuse('SCHEDULE_INVALID');
  }

  if (reasonCode !== undefined && reasonCode !== null) {
    if (!RESCHEDULE_REASONS.includes(reasonCode as RescheduleReason)) {
      return refuse('REASON_INVALID');
    }
  }

  /**
   * The notice window is measured against the CURRENT start, not the new one.
   *
   * Moving a booking that starts in an hour is the disruption, whatever the new
   * date is — the provider has already planned their day around the old one.
   */
  if (noticeHours > 0) {
    if (!currentValid) return refuse('INSIDE_NOTICE_WINDOW'); // fails closed
    if (current!.getTime() - now.getTime() < noticeHours * 3_600_000) {
      return refuse('INSIDE_NOTICE_WINDOW');
    }
  }

  return {
    allowed: true,
    refusal: null,
    noticeCutoff,
    noticeHours,
    reasons: RESCHEDULE_REASONS,
  };
}

// ─── Cancellation, as one matrix ──────────────────────────────────────────────

/**
 * Who may cancel from where, and what each actor's reason vocabulary is.
 *
 * This is a PROJECTION of rules that already exist and are already enforced —
 * `BOOKING_ACTIONS.CUSTOMER_CANCEL` / `PROVIDER_CANCEL` / `ADMIN_CANCEL` and
 * their guards. It is declared here so the release gate "cancellation rules are
 * identical across clients" is checkable in one place and printable in one
 * table, and `tests/booking-cancellation-matrix.test.ts` asserts the projection
 * against the executor rather than letting the two drift.
 *
 * Nothing here is enforcement. The executor refuses; this describes.
 */
export interface CancellationRule {
  actor: ExperienceActor;
  action: 'CUSTOMER_CANCEL' | 'PROVIDER_CANCEL' | 'ADMIN_CANCEL';
  /** Canonical states this actor may cancel from. */
  from: readonly BookingState[];
  /** The executor guard that enforces it, or null when only the whitelist does. */
  guard: string | null;
  reasonCodes: readonly string[];
  /** Whether a free-text reason is refused when absent. */
  reasonRequired: boolean;
  /** What the operator has decided this cancellation costs. */
  financialConsequence: string;
  notifies: readonly string[];
}

export const CANCELLATION_MATRIX: readonly CancellationRule[] = [
  {
    actor: 'customer',
    action: 'CUSTOMER_CANCEL',
    from: ['PENDING_OTP', 'AWAITING_ASSIGNMENT', 'ASSIGNED', 'ACCEPTED'],
    guard: 'customerCancellationStage',
    reasonCodes: [],
    reasonRequired: false,
    financialConsequence:
      'None declared. No fee, no penalty and no refund rule has been specified by ' +
      'the operator, and inventing one would be worse than having none.',
    notifies: ['assigned provider', 'admin'],
  },
  {
    actor: 'assigned_provider',
    action: 'PROVIDER_CANCEL',
    from: ['ACCEPTED', 'EN_ROUTE', 'ARRIVED'],
    guard: 'providerCancellationWindow',
    reasonCodes: PROVIDER_CANCELLATION_REASONS,
    reasonRequired: true,
    financialConsequence:
      'Record only. C18 §26 says outright "do not invent penalties": no fee, no ' +
      'rating impact. Cancelling releases the booking for reassignment.',
    notifies: ['customer', 'admin'],
  },
  {
    actor: 'admin',
    action: 'ADMIN_CANCEL',
    from: [
      'PENDING_OTP', 'AWAITING_ASSIGNMENT', 'ASSIGNED', 'ACCEPTED',
      'EN_ROUTE', 'ARRIVED', 'IN_PROGRESS', 'DISPUTED',
    ],
    guard: null,
    reasonCodes: [],
    reasonRequired: true,
    financialConsequence:
      'Carries an explicit `refundAction`. An admin cancelling live work is the ' +
      'support case the other two policies escalate TO, which is why it holds ' +
      'neither of their guards.',
    notifies: ['customer', 'assigned provider'],
  },
];

// ─── Disputes ─────────────────────────────────────────────────────────────────

/**
 * The categories anyone may raise.
 *
 * A superset of `controllers/bookingDisputeView.PROVIDER_DISPUTE_CATEGORIES`,
 * which is the provider-facing list already shipped and which must remain a
 * subset — a provider offered a category the canonical service rejects is a
 * dead menu. Asserted by test rather than by comment.
 */
export const DISPUTE_CATEGORIES = [
  'SCOPE_DISAGREEMENT',
  'PAYMENT_ISSUE',
  'CUSTOMER_CONDUCT',
  'PROVIDER_SAFETY',
  'CANCELLATION_DISAGREEMENT',
  'COMPLETION_DISAGREEMENT',
  'DAMAGE_CLAIM',
  'SERVICE_QUALITY',
  'NO_SHOW',
] as const;

export type DisputeCategory = (typeof DISPUTE_CATEGORIES)[number];

export const isDisputeCategory = (v: unknown): v is DisputeCategory =>
  typeof v === 'string' && (DISPUTE_CATEGORIES as readonly string[]).includes(v);

export const DISPUTE_SEVERITIES = ['low', 'normal', 'high'] as const;
export type DisputeSeverity = (typeof DISPUTE_SEVERITIES)[number];

/**
 * States from which a dispute may be opened.
 *
 * A booking nobody has committed to has nothing to dispute — declining is the
 * mechanism before acceptance, and a complaint about a booking with no provider
 * is a support ticket, not an escalation against a job. This matches the
 * provider-facing `ACTIONABLE_WORKER_STATUSES` list already shipped.
 */
export const DISPUTABLE_STATES: readonly BookingState[] = [
  'ACCEPTED',
  'EN_ROUTE',
  'ARRIVED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'DISPUTED',
];

export type DisputeRefusal =
  /** An unresolved escalation already exists on this booking. */
  | 'ALREADY_OPEN'
  /** Too early in the lifecycle for a dispute to mean anything. */
  | 'NOT_YET_ACTIONABLE'
  /** Category outside the standardized list. */
  | 'CATEGORY_INVALID'
  /** Free text missing. */
  | 'REASON_REQUIRED';

export interface DisputeVerdict {
  allowed: boolean;
  refusal: DisputeRefusal | null;
  categories: readonly string[];
}

export function evaluateDisputeOpening(params: {
  state: BookingState;
  hasOpenDispute: boolean;
  category?: string | null;
  reason?: string | null;
}): DisputeVerdict {
  const { state, hasOpenDispute, category, reason } = params;

  const refuse = (refusal: DisputeRefusal): DisputeVerdict => ({
    allowed: false,
    refusal,
    categories: [],
  });

  // §66: "Prevent duplicate open disputes." Checked before anything else — the
  // booking is already under review, and WHO raised the open one is irrelevant.
  if (hasOpenDispute) return refuse('ALREADY_OPEN');
  if (!DISPUTABLE_STATES.includes(state)) return refuse('NOT_YET_ACTIONABLE');
  if (!isDisputeCategory(category)) return refuse('CATEGORY_INVALID');
  if (!String(reason ?? '').trim()) return refuse('REASON_REQUIRED');

  return { allowed: true, refusal: null, categories: DISPUTE_CATEGORIES };
}

// ─── Canonical domain events (§67) ────────────────────────────────────────────

/**
 * One event per accepted experience transition.
 *
 * §67 asks for canonical events "so messaging/notifications/admin timelines
 * react consistently". The catalog is closed: an event that is not declared here
 * cannot be emitted, so a new side effect has to be named in a diff rather than
 * appearing as a string literal at a call site.
 *
 * `timelineType` is the value written to `booking_timeline_events.event_type`.
 * Several are values the admin portal already renders — `booking_rescheduled`,
 * `dispute_opened` — and those are reused rather than renamed, because a new
 * spelling for an existing event is a silent break of every timeline reader.
 */
export interface DomainEventSpec {
  /** `<capability>.<past-tense verb>`. */
  name: string;
  capability: ExperienceKey;
  timelineType: string;
  /** Who is told, beyond the timeline. */
  notifies: readonly ExperienceActor[];
  why: string;
}

export const BOOKING_EXPERIENCE_EVENTS = [
  {
    name: 'otp.issued',
    capability: 'otp',
    timelineType: 'booking_otp_issued',
    notifies: [],
    why: 'The audit trail for a code being minted. Never carries the code itself.',
  },
  {
    name: 'otp.verified',
    capability: 'otp',
    timelineType: 'booking_otp_verified',
    notifies: [],
    why: 'The transition it authorized is recorded separately by the executor; this records that the CREDENTIAL was accepted.',
  },
  {
    name: 'otp.failed',
    capability: 'otp',
    timelineType: 'booking_otp_failed',
    notifies: [],
    why: 'A wrong code is evidence. Without it an attempt limit is invisible to support.',
  },
  {
    name: 'reschedule.proposed',
    capability: 'reschedule',
    timelineType: 'booking_reschedule_proposed',
    notifies: [],
    why: 'Written BEFORE the schedule moves, so a move always has a proposer even if applying it fails.',
  },
  {
    name: 'reschedule.applied',
    capability: 'reschedule',
    timelineType: 'booking_rescheduled',
    notifies: ['assigned_provider', 'customer'],
    why: 'The existing admin event type, reused. The provider is not a party to the decision but must be told the outcome.',
  },
  {
    name: 'reschedule.refused',
    capability: 'reschedule',
    timelineType: 'booking_reschedule_refused',
    notifies: [],
    why: 'A refused move is the interesting one when a customer complains that they tried.',
  },
  {
    name: 'disputes.opened',
    capability: 'disputes',
    timelineType: 'dispute_opened',
    notifies: ['admin'],
    why: 'The existing admin event type, reused so the admin timeline and the hasDispute filter keep working unchanged.',
  },
  {
    name: 'additionalWork.requested',
    capability: 'additionalWork',
    timelineType: 'additional_work_requested',
    notifies: ['admin'],
    why: 'A change order is a price change. It belongs on the booking timeline, not only in the additional-work table.',
  },
  {
    name: 'tracking.viewed',
    capability: 'tracking',
    timelineType: 'booking_tracking_viewed',
    notifies: [],
    why:
      'DECLARED, NOT EMITTED. A row per poll would write more history than the ' +
      'booking has, and location access is already bounded by the visibility ' +
      'rule. Kept in the catalog so the decision is visible rather than missing.',
  },
] as const satisfies readonly DomainEventSpec[];

export type BookingExperienceEventName = (typeof BOOKING_EXPERIENCE_EVENTS)[number]['name'];

/** The one event that is catalogued and deliberately never emitted. */
export const UNEMITTED_EVENTS: readonly BookingExperienceEventName[] = ['tracking.viewed'];

export const eventSpec = (name: BookingExperienceEventName): DomainEventSpec =>
  BOOKING_EXPERIENCE_EVENTS.find((e) => e.name === name)!;
