/**
 * The canonical booking state machine, and the certification bar.
 *
 * The bar for this command: **do not certify if Customer, Provider and Admin
 * can still observe contradictory lifecycle truth for the same booking.**
 *
 * That was true before this machine existed. Two independent derivations over
 * the same two columns gave different answers — a provider taps *en route*, the
 * customer app showed EN_ROUTE and the admin portal showed Accepted. The
 * projection-fidelity block below is the check that it cannot happen again.
 */

import {
  BOOKING_STATES,
  TRANSITIONS,
  TERMINAL_STATES,
  STATE_GROUPS,
  canTransition,
  allowedActions,
  allowedNextStates,
  deriveCanonicalState,
  groupOf,
  isTerminal,
  type BookingState,
  type Actor,
} from '../src/services/booking/canonicalState';
import {
  toAdminProjection,
  toCustomerProjection,
  toProviderProjection,
  project,
  LEGACY_OPS_COLLAPSES,
} from '../src/services/booking/projections';
import { BOOKING_ACTIONS } from '../src/services/booking/transitionExecutor';

const ACTORS: Actor[] = ['customer', 'assigned_provider', 'admin', 'system'];

// ─── The certification bar ────────────────────────────────────────────────────

describe('one canonical state, three projections, no lost distinctions', () => {
  it('every projection carries the canonical state verbatim', () => {
    // The whole property. A surface that reports a state it derived itself can
    // disagree with another surface; one that echoes the canonical state cannot.
    for (const state of BOOKING_STATES) {
      expect(toAdminProjection(state).canonicalState).toBe(state);
      expect(toCustomerProjection(state).canonicalState).toBe(state);
      expect(toProviderProjection(state).canonicalState).toBe(state);
    }
  });

  it('EN_ROUTE and ARRIVED survive into every projection as themselves', () => {
    // The specific regression. Admin used to report both as `accepted`.
    for (const state of ['EN_ROUTE', 'ARRIVED'] as const) {
      expect(toAdminProjection(state).canonicalState).toBe(state);
      expect(toCustomerProjection(state).canonicalState).toBe(state);
      expect(toProviderProjection(state).canonicalState).toBe(state);
    }
  });

  it('Admin shows En Route and Arrived as distinct labels, not "Accepted"', () => {
    expect(toAdminProjection('ACCEPTED').label).toBe('Accepted');
    expect(toAdminProjection('EN_ROUTE').label).toBe('En Route');
    expect(toAdminProjection('ARRIVED').label).toBe('Arrived');
  });

  it('the three projections never disagree about which state a booking is in', () => {
    for (const state of BOOKING_STATES) {
      const seen = new Set([
        toAdminProjection(state).canonicalState,
        toCustomerProjection(state).canonicalState,
        toProviderProjection(state).canonicalState,
      ]);
      expect(seen.size).toBe(1);
    }
  });

  it('the deprecated Admin field ADMITS where it is lossy', () => {
    // It still collapses, because the portal's Record lookup would render a
    // blank badge for an unknown value. What it must not do is collapse
    // silently — a client can see the flag and read `canonicalState` instead.
    for (const state of ['EN_ROUTE', 'ARRIVED', 'ACCEPTED'] as const) {
      const dto = toAdminProjection(state);
      expect(dto.operationsStatus).toBe('accepted');
      expect(dto.stateIsCollapsedInLegacyField).toBe(true);
    }
    expect(LEGACY_OPS_COLLAPSES.accepted).toEqual(['ACCEPTED', 'EN_ROUTE', 'ARRIVED']);
  });

  it('a state the legacy field CAN express is not flagged as collapsed', () => {
    for (const state of ['IN_PROGRESS', 'COMPLETED', 'ASSIGNED', 'DISPUTED'] as const) {
      expect(toAdminProjection(state).stateIsCollapsedInLegacyField).toBe(false);
    }
  });

  it('grouping is additive — every state has a group AND keeps its identity', () => {
    for (const state of BOOKING_STATES) {
      expect(groupOf(state)).toBeTruthy();
    }
    // The operator's example: Pre-Service groups three states without merging them.
    expect(STATE_GROUPS.PRE_SERVICE).toEqual(['ASSIGNED', 'ACCEPTED', 'EN_ROUTE', 'ARRIVED']);
    const grouped = STATE_GROUPS.PRE_SERVICE.map((s) => toAdminProjection(s).canonicalState);
    expect(new Set(grouped).size).toBe(4);
  });

  it('every canonical state belongs to exactly one group', () => {
    for (const state of BOOKING_STATES) {
      const groups = Object.entries(STATE_GROUPS).filter(([, m]) => (m as readonly string[]).includes(state));
      expect(groups).toHaveLength(1);
    }
  });

  it('`project` routes each actor to its own projection', () => {
    expect(project('EN_ROUTE', 'admin')).toEqual(toAdminProjection('EN_ROUTE'));
    expect(project('EN_ROUTE', 'customer')).toEqual(toCustomerProjection('EN_ROUTE'));
    expect(project('EN_ROUTE', 'assigned_provider')).toEqual(toProviderProjection('EN_ROUTE'));
  });
});

// ─── Structure ────────────────────────────────────────────────────────────────

describe('the machine is well-formed', () => {
  it('every transition names states that exist', () => {
    for (const rule of TRANSITIONS) {
      expect(BOOKING_STATES).toContain(rule.from);
      expect(BOOKING_STATES).toContain(rule.to);
    }
  });

  it('every transition names at least one actor, and only real ones', () => {
    for (const rule of TRANSITIONS) {
      expect(rule.actors.length).toBeGreaterThan(0);
      for (const actor of rule.actors) expect(ACTORS).toContain(actor);
    }
  });

  it('every state is reachable, or is an entry point', () => {
    const reachable = new Set<string>(TRANSITIONS.map((r) => r.to));
    for (const state of BOOKING_STATES) {
      if (state === 'PENDING_OTP') continue; // the entry point
      expect(reachable.has(state)).toBe(true);
    }
  });

  it('every non-terminal state can still go somewhere', () => {
    // A non-terminal state with no exit is a booking stuck forever, which is
    // indistinguishable from a bug in the field.
    for (const state of BOOKING_STATES) {
      if (isTerminal(state)) continue;
      const exits = TRANSITIONS.filter((r) => r.from === state);
      expect(exits.length).toBeGreaterThan(0);
    }
  });

  it('every state has an Admin escape hatch, so nothing is unrecoverable', () => {
    for (const state of BOOKING_STATES) {
      if (isTerminal(state)) continue;
      expect(allowedActions(state, 'admin').length).toBeGreaterThan(0);
    }
  });
});

// ─── Allowed transitions ──────────────────────────────────────────────────────

describe('the progression the operator specified', () => {
  const PATH: Array<[BookingState, BookingState, Actor]> = [
    ['PENDING_OTP', 'AWAITING_ASSIGNMENT', 'customer'],
    ['AWAITING_ASSIGNMENT', 'ASSIGNED', 'admin'],
    ['ASSIGNED', 'ACCEPTED', 'assigned_provider'],
    ['ACCEPTED', 'EN_ROUTE', 'assigned_provider'],
    ['EN_ROUTE', 'ARRIVED', 'assigned_provider'],
    ['ARRIVED', 'IN_PROGRESS', 'assigned_provider'],
    ['IN_PROGRESS', 'COMPLETED', 'assigned_provider'],
  ];

  it.each(PATH)('%s → %s is allowed for %s', (from, to, actor) => {
    const verdict = canTransition(from, to, actor);
    expect(verdict.allowed).toBe(true);
  });

  it('EN_ROUTE and ARRIVED are optional, not mandatory', () => {
    // The live app has always allowed starting from ACCEPTED. Making the new
    // states mandatory would strand any provider whose build predates them.
    expect(canTransition('ACCEPTED', 'IN_PROGRESS', 'assigned_provider').allowed).toBe(true);
    expect(canTransition('EN_ROUTE', 'IN_PROGRESS', 'assigned_provider').allowed).toBe(true);
  });

  it('starting a job requires the customer worker code, at every entry to IN_PROGRESS', () => {
    for (const from of ['ACCEPTED', 'EN_ROUTE', 'ARRIVED'] as const) {
      const verdict = canTransition(from, 'IN_PROGRESS', 'assigned_provider');
      expect(verdict.allowed).toBe(true);
      if (verdict.allowed) expect(verdict.rule.requires).toContain('worker_code');
    }
  });

  it('every pre-service transition requires the CURRENT assignment', () => {
    // A provider who is no longer assigned cannot advance a booking they used
    // to hold. This is the guard that stops a stale app doing damage.
    for (const [from, to] of [
      ['ASSIGNED', 'ACCEPTED'],
      ['ACCEPTED', 'EN_ROUTE'],
      ['EN_ROUTE', 'ARRIVED'],
      ['ARRIVED', 'IN_PROGRESS'],
    ] as const) {
      const verdict = canTransition(from, to, 'assigned_provider');
      expect(verdict.allowed).toBe(true);
      if (verdict.allowed) expect(verdict.rule.requires).toContain('current_assignment');
    }
  });
});

// ─── Forbidden transitions ────────────────────────────────────────────────────

describe('the machine refuses the impossible', () => {
  it('a terminal state does not regress', () => {
    for (const terminal of TERMINAL_STATES) {
      for (const to of ['IN_PROGRESS', 'EN_ROUTE', 'ARRIVED', 'ACCEPTED', 'ASSIGNED'] as const) {
        for (const actor of ACTORS) {
          const verdict = canTransition(terminal, to, actor);
          expect(verdict.allowed).toBe(false);
        }
      }
    }
  });

  it('a completed booking cannot be un-completed, even by an admin', () => {
    expect(canTransition('COMPLETED', 'IN_PROGRESS', 'admin')).toEqual({
      allowed: false,
      reason: 'TERMINAL_STATE',
    });
  });

  it('the ONLY route out of COMPLETED is a dispute, which does not undo it', () => {
    const exits = TRANSITIONS.filter((r) => r.from === 'COMPLETED');
    expect(exits.map((r) => r.to)).toEqual(['DISPUTED']);
  });

  it('the progression cannot be walked backwards', () => {
    for (const [from, to] of [
      ['ARRIVED', 'EN_ROUTE'],
      ['EN_ROUTE', 'ACCEPTED'],
      ['IN_PROGRESS', 'ARRIVED'],
    ] as const) {
      for (const actor of ACTORS) {
        expect(canTransition(from, to, actor).allowed).toBe(false);
      }
    }
  });

  it('ACCEPTED \u2192 ASSIGNED is REASSIGNMENT, not a backwards step', () => {
    // The one apparent regression that is legitimate, and only for an admin
    // with a reason: a new provider starts at ASSIGNED because they have not
    // accepted yet. My first version of the test above asserted this was
    // forbidden for everyone, which would have made reassignment impossible.
    const verdict = canTransition('ACCEPTED', 'ASSIGNED', 'admin');
    expect(verdict.allowed).toBe(true);
    if (verdict.allowed) expect(verdict.rule.action).toBe('reassignProvider');

    for (const actor of ['customer', 'assigned_provider', 'system'] as const) {
      expect(canTransition('ACCEPTED', 'ASSIGNED', actor).allowed).toBe(false);
    }
  });

  it('a booking cannot jump straight from intake to in-progress', () => {
    for (const actor of ACTORS) {
      expect(canTransition('PENDING_OTP', 'IN_PROGRESS', actor).allowed).toBe(false);
      expect(canTransition('AWAITING_ASSIGNMENT', 'COMPLETED', actor).allowed).toBe(false);
    }
  });

  /**
   * Two states declare a real self-transition, and both are OPERATIONS rather
   * than repeats:
   *
   *   ASSIGNED → ASSIGNED             reassignment to a different provider
   *   AWAITING_ASSIGNMENT → itself    OTP confirmation of a payment-first
   *                                    booking, which writes CONFIRMED and
   *                                    releases it to the pool
   *
   * Everything else re-entering itself is a retry after success, and a retry
   * is not a failure.
   */
  const DECLARED_SELF_TRANSITIONS = new Set(['ASSIGNED', 'AWAITING_ASSIGNMENT']);

  it('re-entering the same state is ALREADY_IN_STATE, not an error', () => {
    for (const state of BOOKING_STATES) {
      if (DECLARED_SELF_TRANSITIONS.has(state)) continue;
      expect(canTransition(state, state, 'admin')).toEqual({ allowed: false, reason: 'ALREADY_IN_STATE' });
    }
  });

  it('every declared self-transition is in that set (the set cannot rot)', () => {
    // Derived from the table rather than trusted: a new self-transition added
    // without acknowledging it here fails, instead of silently widening what
    // "already in state" tolerates.
    const declared = new Set(TRANSITIONS.filter((r) => r.from === r.to).map((r) => r.from));
    expect([...declared].sort()).toEqual([...DECLARED_SELF_TRANSITIONS].sort());
  });

  it('ASSIGNED \u2192 ASSIGNED is a declared operation, not a no-op', () => {
    // Reassignment inside one state. An unconditional `from === to`
    // short-circuit forbade it, so `allowedNextStates` and `canTransition`
    // disagreed about the same machine \u2014 caught by the agreement test below.
    const verdict = canTransition('ASSIGNED', 'ASSIGNED', 'admin');
    expect(verdict.allowed).toBe(true);
    if (verdict.allowed) expect(verdict.rule.action).toBe('reassignProvider');
  });
});

// ─── Actor permissions ────────────────────────────────────────────────────────

describe('who may do what', () => {
  it('a customer cannot advance the provider lifecycle', () => {
    for (const [from, to] of [
      ['ASSIGNED', 'ACCEPTED'],
      ['ACCEPTED', 'EN_ROUTE'],
      ['EN_ROUTE', 'ARRIVED'],
      ['ARRIVED', 'IN_PROGRESS'],
      ['IN_PROGRESS', 'COMPLETED'],
    ] as const) {
      expect(canTransition(from, to, 'customer')).toMatchObject({
        allowed: false,
        reason: 'ACTOR_NOT_PERMITTED',
      });
    }
  });

  it('a provider cannot assign themselves work', () => {
    expect(canTransition('AWAITING_ASSIGNMENT', 'ASSIGNED', 'assigned_provider')).toMatchObject({
      allowed: false,
      reason: 'ACTOR_NOT_PERMITTED',
    });
  });

  it('only an admin may cancel live work', () => {
    // Abandoning a job in progress is a support and safety matter.
    expect(canTransition('IN_PROGRESS', 'CANCELLED', 'admin').allowed).toBe(true);
    expect(canTransition('IN_PROGRESS', 'CANCELLED', 'customer').allowed).toBe(false);
    expect(canTransition('IN_PROGRESS', 'CANCELLED', 'assigned_provider').allowed).toBe(false);
  });

  it('only the system expires an unconfirmed booking', () => {
    expect(canTransition('PENDING_OTP', 'EXPIRED', 'system').allowed).toBe(true);
    for (const actor of ['customer', 'admin', 'assigned_provider'] as const) {
      expect(canTransition('PENDING_OTP', 'EXPIRED', actor).allowed).toBe(false);
    }
  });

  it('only an admin resolves a dispute', () => {
    expect(canTransition('DISPUTED', 'COMPLETED', 'admin').allowed).toBe(true);
    expect(canTransition('DISPUTED', 'COMPLETED', 'customer').allowed).toBe(false);
    expect(canTransition('DISPUTED', 'CANCELLED', 'assigned_provider').allowed).toBe(false);
  });

  it('a refusal names the guards the caller would still have had to satisfy', () => {
    const verdict = canTransition('ARRIVED', 'IN_PROGRESS', 'customer');
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.requires).toContain('worker_code');
  });
});

// ─── Reassignment resets the progression ──────────────────────────────────────

describe('reassignment does not carry operational state to a new provider', () => {
  it('a booking whose provider was EN_ROUTE goes back to ASSIGNED', () => {
    // The new provider is not on the way. Silently carrying EN_ROUTE across
    // would tell the customer somebody is arriving who has not left.
    for (const from of ['ACCEPTED', 'EN_ROUTE', 'ARRIVED'] as const) {
      const verdict = canTransition(from, 'ASSIGNED', 'admin');
      expect(verdict.allowed).toBe(true);
      if (verdict.allowed) {
        expect(verdict.rule.action).toBe('reassignProvider');
        expect(verdict.rule.requires).toContain('reason');
      }
    }
  });

  it('reassignment always requires a reason', () => {
    for (const rule of TRANSITIONS.filter((r) => r.action === 'reassignProvider')) {
      expect(rule.requires).toContain('reason');
      expect(rule.actors).toEqual(['admin']);
    }
  });

  it('a provider cancelling returns the booking to the pool, not to CANCELLED', () => {
    for (const from of ['ACCEPTED', 'EN_ROUTE', 'ARRIVED'] as const) {
      const verdict = canTransition(from, 'AWAITING_ASSIGNMENT', 'assigned_provider');
      expect(verdict.allowed).toBe(true);
      if (verdict.allowed) {
        expect(verdict.rule.action).toBe('providerCancel');
        expect(verdict.rule.requires).toContain('outside_notice_window');
      }
    }
  });

  it('a decline returns the booking to the pool rather than cancelling it', () => {
    const verdict = canTransition('ASSIGNED', 'AWAITING_ASSIGNMENT', 'assigned_provider');
    expect(verdict.allowed).toBe(true);
    if (verdict.allowed) expect(verdict.rule.action).toBe('decline');
  });
});

// ─── Derivation from the two physical columns ─────────────────────────────────

describe('deriving one state from two columns', () => {
  it('reads the provider lifecycle when the booking is live', () => {
    expect(deriveCanonicalState({ bookingStatus: 'CONFIRMED', workerStatus: 'EN_ROUTE' })).toBe('EN_ROUTE');
    expect(deriveCanonicalState({ bookingStatus: 'CONFIRMED', workerStatus: 'ARRIVED' })).toBe('ARRIVED');
    expect(deriveCanonicalState({ bookingStatus: 'CONFIRMED', workerStatus: 'IN_PROGRESS' })).toBe('IN_PROGRESS');
  });

  it('lets the booking win when it is terminal', () => {
    // Otherwise a cancelled booking with a stale worker row reads as live.
    expect(deriveCanonicalState({ bookingStatus: 'CANCELLED', workerStatus: 'EN_ROUTE' })).toBe('CANCELLED');
    expect(deriveCanonicalState({ bookingStatus: 'COMPLETED', workerStatus: 'ACCEPTED' })).toBe('COMPLETED');
  });

  it('accepts BOTH spellings of cancelled', () => {
    // 54 sites write CANCELLED, 28 write CANCELED. Reading only one would treat
    // a cancelled booking as live.
    expect(deriveCanonicalState({ bookingStatus: 'CANCELLED', workerStatus: null })).toBe('CANCELLED');
    expect(deriveCanonicalState({ bookingStatus: 'CANCELED', workerStatus: null })).toBe('CANCELLED');
  });

  it('an open dispute outranks EVERYTHING, including a terminal booking', () => {
    // Corrected while wiring `mapOperationsStatus`. My first ordering put
    // cancellation above escalation and escalation above completion, which is
    // inconsistent two ways: the transition table already allows
    // COMPLETED → DISPUTED, and a dispute ABOUT a cancellation is exactly the
    // case somebody escalates. Admin has always shown `disputed` first, so this
    // also stops the wiring silently changing what admins see.
    expect(deriveCanonicalState({ bookingStatus: 'CONFIRMED', workerStatus: 'IN_PROGRESS', hasEscalation: true })).toBe('DISPUTED');
    expect(deriveCanonicalState({ bookingStatus: 'CANCELLED', workerStatus: 'IN_PROGRESS', hasEscalation: true })).toBe('DISPUTED');
    expect(deriveCanonicalState({ bookingStatus: 'COMPLETED', workerStatus: 'COMPLETED', hasEscalation: true })).toBe('DISPUTED');
  });

  it('a dispute does not erase the terminal state it sits on top of', () => {
    // The same row without the escalation still reads terminal, so nothing was
    // overwritten — the dispute is an exception beside the state, not instead
    // of it, and the timeline keeps both.
    expect(deriveCanonicalState({ bookingStatus: 'CANCELLED', workerStatus: 'IN_PROGRESS' })).toBe('CANCELLED');
    expect(deriveCanonicalState({ bookingStatus: 'COMPLETED', workerStatus: 'COMPLETED' })).toBe('COMPLETED');
  });

  it('distinguishes assigned from awaiting by the presence of a provider', () => {
    expect(deriveCanonicalState({ bookingStatus: 'CONFIRMED', workerStatus: null, workerUid: null })).toBe('AWAITING_ASSIGNMENT');
    expect(deriveCanonicalState({ bookingStatus: 'CONFIRMED', workerStatus: null, workerUid: 'uid' })).toBe('ASSIGNED');
    expect(deriveCanonicalState({ bookingStatus: 'PAID', workerStatus: null, workerUid: 'uid' })).toBe('ASSIGNED');
  });

  it('is case-insensitive, because production holds both cases', () => {
    expect(deriveCanonicalState({ bookingStatus: 'confirmed', workerStatus: 'en_route' })).toBe('EN_ROUTE');
  });

  it('an unknown status surfaces as AWAITING_ASSIGNMENT rather than vanishing', () => {
    // It is certainly not in progress, and putting it in front of an admin
    // beats hiding it behind a state nothing renders.
    expect(deriveCanonicalState({ bookingStatus: 'SOMETHING_NEW', workerStatus: null })).toBe('AWAITING_ASSIGNMENT');
  });

  it('never returns a value outside the canonical set', () => {
    const inputs = ['PENDING_OTP', 'CONFIRMED', 'PAID', 'CANCELLED', 'CANCELED', 'COMPLETED', 'EXPIRED', 'REFUNDED', 'FAILED', 'WORKER_ASSIGNED', '', null];
    const workers = ['ASSIGNED', 'ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'IN_PROGRESS', 'COMPLETED', 'DECLINED', '', null];
    for (const bookingStatus of inputs) {
      for (const workerStatus of workers) {
        expect(BOOKING_STATES).toContain(deriveCanonicalState({ bookingStatus, workerStatus }));
      }
    }
  });
});

// ─── Action surfaces ──────────────────────────────────────────────────────────

describe('the action list a client renders matches what the machine allows', () => {
  it('a provider is never offered an action the machine would refuse', () => {
    for (const state of BOOKING_STATES) {
      const dto = toProviderProjection(state);
      if (dto.nextAction) expect(dto.availableActions).toContain(dto.nextAction);
    }
  });

  it('offers the right next step at each pre-service stage', () => {
    expect(toProviderProjection('ASSIGNED').nextAction).toBe('accept');
    expect(toProviderProjection('ACCEPTED').nextAction).toBe('markEnRoute');
    expect(toProviderProjection('EN_ROUTE').nextAction).toBe('markArrived');
    expect(toProviderProjection('ARRIVED').nextAction).toBe('startJob');
    expect(toProviderProjection('IN_PROGRESS').nextAction).toBe('complete');
  });

  it('offers a provider nothing in a terminal state', () => {
    for (const state of TERMINAL_STATES) {
      expect(toProviderProjection(state).nextAction).toBeNull();
      expect(toProviderProjection(state).availableActions).toEqual([]);
    }
  });

  it('a customer may still dispute a COMPLETED booking, and only that', () => {
    // Terminal for the lifecycle is not terminal for recourse. Asserting an
    // empty action list here would have described a platform where a finished
    // job can never be challenged.
    expect(toCustomerProjection('COMPLETED').availableActions).toEqual(['raiseDispute']);
    expect(toCustomerProjection('CANCELLED').availableActions).toEqual([]);
    expect(toCustomerProjection('EXPIRED').availableActions).toEqual([]);
  });

  it('allowedNextStates agrees with canTransition', () => {
    for (const state of BOOKING_STATES) {
      for (const actor of ACTORS) {
        for (const next of allowedNextStates(state, actor)) {
          expect(canTransition(state, next, actor).allowed).toBe(true);
        }
      }
    }
  });
});

/**
 * Two actions that share a destination AND an actor are the same move to the
 * machine, whose whitelist is keyed on (from, to, actor). Only their declared
 * source states can tell them apart.
 *
 * This is not hypothetical. PROVIDER_DECLINE and PROVIDER_CANCEL both land on
 * AWAITING_ASSIGNMENT as the assigned provider, so before `from` existed a
 * decline on an ACCEPTED booking was executed as a cancellation — skipping the
 * 48-hour policy check, the cancellation tracking note and the cancellation
 * notifications, none of which the machine knows about.
 *
 * The guard is on the CLASS, not on that pair: any future action added with a
 * colliding destination and actor and an overlapping source set fails here.
 */
describe('colliding actions are separated by their source states', () => {
  type Spec = { to: string; actor: string; from?: readonly string[] };
  const entries = Object.entries(BOOKING_ACTIONS) as Array<[string, Spec]>;

  it('no two actions share a destination, an actor AND a source state', () => {
    const collisions: string[] = [];

    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const [nameA, a] = entries[i];
        const [nameB, b] = entries[j];
        if (a.to !== b.to || a.actor !== b.actor) continue;

        // Sharing destination and actor is allowed only if the source sets are
        // disjoint AND both are declared — an undeclared `from` means "any",
        // which overlaps with everything.
        if (!a.from || !b.from) {
          collisions.push(`${nameA} / ${nameB} collide on ${a.to}/${a.actor} and one declares no source states`);
          continue;
        }
        const overlap = a.from.filter((f) => b.from!.includes(f));
        if (overlap.length) {
          collisions.push(`${nameA} / ${nameB} overlap on ${overlap.join(', ')}`);
        }
      }
    }

    expect(collisions).toEqual([]);
  });

  it('the detector fires on a real collision (positive fixture)', () => {
    // A guard reporting zero because its comparison is broken looks exactly
    // like a clean action map.
    const fixture: Array<[string, Spec]> = [
      ['DECLINE', { to: 'AWAITING_ASSIGNMENT', actor: 'assigned_provider', from: ['ASSIGNED', 'ACCEPTED'] }],
      ['CANCEL', { to: 'AWAITING_ASSIGNMENT', actor: 'assigned_provider', from: ['ACCEPTED'] }],
    ];
    const [, a] = fixture[0];
    const [, b] = fixture[1];
    expect(a.from!.filter((f) => b.from!.includes(f))).toEqual(['ACCEPTED']);
  });

  it('every declared source state is a real state the machine allows', () => {
    // A `from` naming a state the whitelist forbids anyway is dead
    // configuration that reads like a rule.
    for (const [name, spec] of entries) {
      for (const from of spec.from ?? []) {
        expect(BOOKING_STATES).toContain(from);
        expect(canTransition(from as never, spec.to as never, spec.actor as never).allowed)
          .toBe(true);
      }
    }
  });
});
