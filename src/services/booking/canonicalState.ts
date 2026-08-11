/**
 * THE canonical booking state machine.
 *
 * ## The problem this exists to end
 *
 * A booking's lifecycle lives in two columns — `bookings.status` and
 * `booking_workers.status` — and until now TWO independent functions collapsed
 * them into "the" status, with different vocabularies and different answers:
 *
 *   `deriveEffectiveBookingStatus`  Customer + Provider.  Returns EN_ROUTE / ARRIVED.
 *   `mapOperationsStatus`           Admin only.           Collapses both to `accepted`,
 *                                                         and alone knows about disputes.
 *
 * For one booking that means: a provider taps *en route*, the customer app
 * shows EN_ROUTE, and the admin portal shows Accepted. A booking is escalated,
 * Admin shows Disputed and the customer sees the raw status. Three surfaces,
 * three truths, no single place that says which is right.
 *
 * This module is that place. Both of those functions become PROJECTIONS of the
 * state derived here.
 *
 *              ┌─────────── canonical state ───────────┐
 *              ↓               ↓                       ↓
 *          Admin DTO      Customer DTO           Provider DTO
 *        (may GROUP,     (friendly wording)   (action-oriented)
 *      never destroy)
 *
 * ## Operator decision, 2026-08-12
 *
 * `EN_ROUTE` and `ARRIVED` are FIRST-CLASS canonical states, not presentation
 * detail. They carry operational meaning for tracking, SLA measurement,
 * support, notifications and — already, in code — cancellation eligibility:
 * `bookingCancellationPolicy` lists ACCEPTED, EN_ROUTE and ARRIVED as the
 * stages a provider may self-cancel from. Collapsing them would corrupt that
 * today, not hypothetically.
 *
 * An Admin dashboard may GROUP them under "Pre-Service" for filtering. It must
 * never persist or report the booking as merely `accepted`.
 *
 * ## This module derives; it does not store
 *
 * The physical columns do not move (§4). Canonical state is computed from them,
 * so nothing about storage changes and every existing reader keeps working. The
 * machine's job is to give one answer, validate transitions, and refuse the
 * impossible.
 */

export const BOOKING_STATES = [
  /** Created, awaiting the customer's confirmation code. */
  'PENDING_OTP',
  /** Confirmed and payable/paid, no provider yet. */
  'AWAITING_ASSIGNMENT',
  /** A provider has been assigned and has not yet answered. */
  'ASSIGNED',
  /** The assigned provider confirmed. */
  'ACCEPTED',
  /** On the way. */
  'EN_ROUTE',
  /** At the address, work not started. */
  'ARRIVED',
  /** Work started — gated on the customer's worker code. */
  'IN_PROGRESS',
  /** Work finished. Terminal. */
  'COMPLETED',
  /** Ended before completion. Terminal. */
  'CANCELLED',
  /** Escalated. A branch, not a terminal state — it resolves. */
  'DISPUTED',
  /** Never confirmed in time. Terminal. */
  'EXPIRED',
] as const;

export type BookingState = (typeof BOOKING_STATES)[number];

/** Once here, the booking's operational life is over. */
export const TERMINAL_STATES: readonly BookingState[] = ['COMPLETED', 'CANCELLED', 'EXPIRED'];

export const isTerminal = (state: BookingState): boolean => TERMINAL_STATES.includes(state);

/**
 * The pre-service group the operator asked for.
 *
 * A GROUPING, exposed alongside the state — never instead of it. An Admin
 * dashboard filters on this; the booking is still specifically EN_ROUTE.
 */
export const STATE_GROUPS = {
  INTAKE: ['PENDING_OTP', 'AWAITING_ASSIGNMENT'],
  PRE_SERVICE: ['ASSIGNED', 'ACCEPTED', 'EN_ROUTE', 'ARRIVED'],
  SERVICE: ['IN_PROGRESS'],
  CLOSED: ['COMPLETED', 'CANCELLED', 'EXPIRED'],
  EXCEPTION: ['DISPUTED'],
} as const satisfies Record<string, readonly BookingState[]>;

export type StateGroup = keyof typeof STATE_GROUPS;

export const groupOf = (state: BookingState): StateGroup => {
  for (const [group, members] of Object.entries(STATE_GROUPS)) {
    if ((members as readonly BookingState[]).includes(state)) return group as StateGroup;
  }
  /* istanbul ignore next — unreachable while STATE_GROUPS covers BOOKING_STATES,
     which `tests/booking-state-machine.test.ts` asserts. */
  return 'EXCEPTION';
};

// ─── Actors ───────────────────────────────────────────────────────────────────

export type Actor =
  /** The booking's own customer. */
  | 'customer'
  /** The provider CURRENTLY assigned to this booking. Never any provider. */
  | 'assigned_provider'
  /** An admin with the relevant permission. */
  | 'admin'
  /** A scheduled job or an internal effect. Never a request. */
  | 'system';

// ─── Transitions ──────────────────────────────────────────────────────────────

export interface TransitionRule {
  from: BookingState;
  to: BookingState;
  /** The named operation. Action endpoints, not a PATCH of a status field. */
  action: string;
  /** Who may perform it. An actor absent here cannot, whatever it claims. */
  actors: readonly Actor[];
  /** Extra conditions the caller must satisfy, named so a refusal can cite one. */
  requires?: readonly string[];
  /** Why the rule is shaped this way, where that is not obvious. */
  note?: string;
}

/**
 * Every legal transition. Anything not listed is forbidden — the machine is a
 * whitelist, so a new state cannot become reachable by accident.
 */
export const TRANSITIONS: readonly TransitionRule[] = [
  // ── Intake ────────────────────────────────────────────────────────────────
  {
    from: 'PENDING_OTP',
    to: 'AWAITING_ASSIGNMENT',
    action: 'confirmOtp',
    actors: ['customer', 'admin'],
    requires: ['valid_booking_otp'],
  },
  {
    from: 'PENDING_OTP',
    to: 'EXPIRED',
    action: 'expire',
    actors: ['system'],
    note: 'The scheduler ages out unconfirmed bookings. No human performs this.',
  },
  {
    from: 'PENDING_OTP',
    to: 'CANCELLED',
    action: 'cancel',
    actors: ['customer', 'admin'],
  },

  // ── Assignment ────────────────────────────────────────────────────────────
  {
    from: 'AWAITING_ASSIGNMENT',
    to: 'ASSIGNED',
    action: 'assignProvider',
    actors: ['admin', 'system'],
    requires: ['provider_eligible'],
    note: 'Admin assigns, or auto-assignment does. A provider cannot assign themselves.',
  },
  {
    from: 'AWAITING_ASSIGNMENT',
    to: 'CANCELLED',
    action: 'cancel',
    actors: ['customer', 'admin'],
  },

  {
    from: 'ASSIGNED',
    to: 'ACCEPTED',
    action: 'accept',
    actors: ['assigned_provider', 'admin'],
    requires: ['current_assignment'],
    note:
      'Admin may confirm ON BEHALF (§23) — recorded with confirmationSource = ' +
      'admin_on_behalf_of_provider, never as if the provider clicked Accept.',
  },
  {
    from: 'ASSIGNED',
    to: 'AWAITING_ASSIGNMENT',
    action: 'decline',
    actors: ['assigned_provider'],
    requires: ['current_assignment'],
    note: 'A decline returns the booking to the pool; it does not cancel it.',
  },
  {
    from: 'ASSIGNED',
    to: 'ASSIGNED',
    action: 'reassignProvider',
    actors: ['admin'],
    requires: ['reason', 'provider_eligible'],
    note: 'Same state, different provider. The assignment history keeps both.',
  },
  {
    from: 'ASSIGNED',
    to: 'CANCELLED',
    action: 'cancel',
    actors: ['customer', 'admin'],
  },

  // ── Pre-service progression ───────────────────────────────────────────────
  //
  // The operator's rule: these are distinct states and each requires the SAME
  // active assignment. A provider who is no longer assigned cannot advance a
  // booking they used to hold.
  {
    from: 'ACCEPTED',
    to: 'EN_ROUTE',
    action: 'markEnRoute',
    actors: ['assigned_provider'],
    requires: ['current_assignment'],
  },
  {
    from: 'EN_ROUTE',
    to: 'ARRIVED',
    action: 'markArrived',
    actors: ['assigned_provider'],
    requires: ['current_assignment'],
  },
  {
    from: 'ARRIVED',
    to: 'IN_PROGRESS',
    action: 'startJob',
    actors: ['assigned_provider'],
    requires: ['current_assignment', 'worker_code'],
    note:
      'The worker code is the six-digit secret the CUSTOMER reads out. It is the ' +
      'only gate on starting a chargeable job, which is why it is rate-limited ' +
      'per provider (middleware/workerCodeLimiter).',
  },
  {
    from: 'ACCEPTED',
    to: 'IN_PROGRESS',
    action: 'startJob',
    actors: ['assigned_provider'],
    requires: ['current_assignment', 'worker_code'],
    note:
      'EN_ROUTE and ARRIVED remain OPTIONAL stages — the live app has always ' +
      'allowed starting from ACCEPTED, and refusing it now would strand any ' +
      'provider whose app predates the tracking screens. The states are ' +
      'first-class, not mandatory.',
  },
  {
    from: 'EN_ROUTE',
    to: 'IN_PROGRESS',
    action: 'startJob',
    actors: ['assigned_provider'],
    requires: ['current_assignment', 'worker_code'],
  },

  // ── Cancellation from pre-service ─────────────────────────────────────────
  //
  // Eligibility differs by state and is computed by `bookingCancellationPolicy`,
  // which already lists exactly these three. That policy is the reason
  // collapsing EN_ROUTE and ARRIVED into ACCEPTED would corrupt real logic.
  ...(['ACCEPTED', 'EN_ROUTE', 'ARRIVED'] as const).flatMap((from) => [
    {
      from,
      to: 'CANCELLED' as const,
      action: 'cancel',
      actors: ['customer', 'admin'] as const,
      requires: ['cancellation_eligible'] as const,
    },
    {
      from,
      to: 'AWAITING_ASSIGNMENT' as const,
      action: 'providerCancel',
      actors: ['assigned_provider'] as const,
      requires: ['current_assignment', 'reason', 'outside_notice_window'] as const,
      note:
        'A provider cancelling returns the booking to the pool and triggers ' +
        'reassignment. 48 hours notice; inside that window support handles it.',
    },
    {
      from,
      to: 'ASSIGNED' as const,
      action: 'reassignProvider',
      actors: ['admin'] as const,
      requires: ['reason', 'provider_eligible'] as const,
      note:
        'REASSIGNMENT RESETS THE PROGRESSION. A booking whose old provider was ' +
        'EN_ROUTE goes back to ASSIGNED for the new one — the new provider is ' +
        'not on the way, and silently carrying the old operational state over ' +
        'would tell the customer somebody is arriving who has not left.',
    },
  ]),

  // ── Service and completion ────────────────────────────────────────────────
  {
    from: 'IN_PROGRESS',
    to: 'COMPLETED',
    action: 'complete',
    actors: ['assigned_provider', 'admin'],
    requires: ['current_assignment'],
  },
  {
    from: 'IN_PROGRESS',
    to: 'CANCELLED',
    action: 'cancel',
    actors: ['admin'],
    note:
      'ADMIN ONLY. Abandoning live work is a support and safety matter, not a ' +
      'self-service action — neither the customer nor the provider may do it.',
  },

  // ── Dispute branch ────────────────────────────────────────────────────────
  {
    from: 'COMPLETED',
    to: 'DISPUTED',
    action: 'raiseDispute',
    actors: ['customer', 'admin'],
    note:
      'The one route out of a terminal state, and it is deliberate: a dispute is ' +
      'raised precisely because the booking finished wrongly. It does not undo ' +
      'COMPLETED — the timeline keeps it — it opens an exception on top.',
  },
  {
    from: 'IN_PROGRESS',
    to: 'DISPUTED',
    action: 'raiseDispute',
    actors: ['customer', 'admin'],
  },
  {
    from: 'DISPUTED',
    to: 'COMPLETED',
    action: 'resolveDispute',
    actors: ['admin'],
    requires: ['resolution'],
  },
  {
    from: 'DISPUTED',
    to: 'CANCELLED',
    action: 'resolveDispute',
    actors: ['admin'],
    requires: ['resolution'],
  },
];

// ─── Verdicts ─────────────────────────────────────────────────────────────────

export type TransitionRefusal =
  /** No rule connects these two states, in this direction. */
  | 'NO_SUCH_TRANSITION'
  /** The rule exists; this actor may not perform it. */
  | 'ACTOR_NOT_PERMITTED'
  /** The booking has already finished. */
  | 'TERMINAL_STATE'
  /** Already there. Safe to treat as success on a retry. */
  | 'ALREADY_IN_STATE';

export type TransitionVerdict =
  | { allowed: true; rule: TransitionRule }
  | { allowed: false; reason: TransitionRefusal; /** Named guards the caller must still satisfy. */ requires?: readonly string[] };

/**
 * May `actor` move this booking from `from` to `to`?
 *
 * Pure. No database, no clock, no request. The guards named in
 * `rule.requires` are NOT evaluated here — they need rows — but they are
 * returned so the caller cannot forget one silently.
 *
 * ## Terminal states cannot regress
 *
 * Checked before anything else. A COMPLETED booking becoming IN_PROGRESS again
 * because a retry arrived late is the failure this ordering prevents. The only
 * exception is the dispute branch, which is an explicit rule and does not undo
 * the terminal state — it opens an exception beside it.
 */
export function canTransition(from: BookingState, to: BookingState, actor: Actor): TransitionVerdict {
  const rules = TRANSITIONS.filter((r) => r.from === from && r.to === to);

  // A SELF-transition is only ALREADY_IN_STATE when no rule declares one.
  //
  // Reassignment inside ASSIGNED is a real operation — same state, different
  // provider — and an unconditional `from === to` short-circuit forbade it. A
  // test caught that: `allowedNextStates` offered ASSIGNED → ASSIGNED while
  // `canTransition` refused it, so the two disagreed about the same machine.
  if (from === to && !rules.length) {
    return { allowed: false, reason: 'ALREADY_IN_STATE' };
  }

  if (isTerminal(from) && !rules.length) {
    return { allowed: false, reason: 'TERMINAL_STATE' };
  }
  if (!rules.length) return { allowed: false, reason: 'NO_SUCH_TRANSITION' };

  const permitted = rules.find((r) => r.actors.includes(actor));
  if (!permitted) {
    return { allowed: false, reason: 'ACTOR_NOT_PERMITTED', requires: rules[0].requires };
  }
  return { allowed: true, rule: permitted };
}

/** Every state this actor can currently reach. Drives the client's action list. */
export function allowedNextStates(from: BookingState, actor: Actor): BookingState[] {
  return [...new Set(
    TRANSITIONS.filter((r) => r.from === from && r.actors.includes(actor)).map((r) => r.to),
  )];
}

/** Every named action this actor can currently perform. */
export function allowedActions(from: BookingState, actor: Actor): string[] {
  return [...new Set(
    TRANSITIONS.filter((r) => r.from === from && r.actors.includes(actor)).map((r) => r.action),
  )];
}

// ─── Derivation from the physical columns ─────────────────────────────────────

export interface RawBookingState {
  /** `bookings.status` */
  bookingStatus: unknown;
  /** `booking_workers.status` for the CURRENT assignment, if any. */
  workerStatus: unknown;
  /** `bookings.worker_uid` — presence distinguishes assigned from awaiting. */
  workerUid?: unknown;
  /** An open escalation exists. */
  hasEscalation?: boolean;
}

const upper = (v: unknown): string => String(v ?? '').toUpperCase();

/**
 * One canonical state from the two columns.
 *
 * ## Ordering is the whole design
 *
 * `bookings` owns terminal and cancellation state; `booking_workers` owns the
 * provider lifecycle after acceptance. So terminal wins first, then the
 * exception branch, then the worker lifecycle, then the booking's own intake
 * states. Reversing any pair produces a booking that is simultaneously
 * cancelled and in progress.
 *
 * `CANCELED` and `CANCELLED` are both accepted. Both spellings exist in
 * production — 54 sites write one, 28 the other — and reading only one would
 * silently treat a cancelled booking as live.
 */
export function deriveCanonicalState(raw: RawBookingState): BookingState {
  const bs = upper(raw.bookingStatus);
  const ws = upper(raw.workerStatus);

  if (['CANCELLED', 'CANCELED'].includes(bs)) return 'CANCELLED';
  if (bs === 'EXPIRED') return 'EXPIRED';
  if (bs === 'REFUNDED' || bs === 'FAILED') return 'CANCELLED';

  if (raw.hasEscalation) return 'DISPUTED';

  if (ws === 'COMPLETED' || bs === 'COMPLETED') return 'COMPLETED';
  if (ws === 'IN_PROGRESS') return 'IN_PROGRESS';
  if (ws === 'ARRIVED') return 'ARRIVED';
  if (ws === 'EN_ROUTE') return 'EN_ROUTE';
  if (ws === 'ACCEPTED') return 'ACCEPTED';
  if (ws === 'ASSIGNED' || bs === 'WORKER_ASSIGNED') return 'ASSIGNED';

  if (bs === 'PENDING_OTP') return 'PENDING_OTP';

  if (['CONFIRMED', 'PAID'].includes(bs)) {
    return raw.workerUid ? 'ASSIGNED' : 'AWAITING_ASSIGNMENT';
  }

  // An unrecognised status is intake, not an error. A booking whose status this
  // machine has never seen is certainly not in progress, and treating it as
  // AWAITING_ASSIGNMENT surfaces it to an admin instead of hiding it.
  return 'AWAITING_ASSIGNMENT';
}
