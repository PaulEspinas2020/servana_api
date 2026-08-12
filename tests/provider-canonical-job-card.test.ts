/**
 * The provider job card speaks the canonical vocabulary.
 *
 * One of TAB 05's two verdict criteria was failing: Job Order status could
 * diverge from canonical Booking status. `formatJobCard` emitted raw
 * `bookings.status` and `booking_workers.status` and nothing else, so every
 * provider client derived state for itself — the same condition that let
 * Admin's list and detail disagree about the same booking.
 *
 * The fix has good leverage: ONE formatter feeds all three provider surfaces.
 * These tests hold that shape in place.
 */

import fs from 'fs';
import path from 'path';

import { formatJobCard } from '../src/controllers/jobCardView';
import { actionsForWorkerStatus } from '../src/controllers/bookingActions';
import {
  providerActionsForState,
  UNADVERTISED_PROVIDER_ACTIONS,
  MAPPED_PROVIDER_ACTIONS,
} from '../src/services/booking/providerActions';
import {
  BOOKING_STATES,
  deriveCanonicalState,
  allowedActions,
  type BookingState,
} from '../src/services/booking/canonicalState';
import { toProviderProjection } from '../src/services/booking/projections';

const SRC = path.join(__dirname, '..', 'src');

const codeOf = (relative: string): string => fs
  .readFileSync(path.join(SRC, relative), 'utf8')
  .replace(/\r\n/g, '\n')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((l) => !l.trim().startsWith('//'))
  .join('\n');

/** A job-card row with only the fields the formatter reads. */
const row = (over: Record<string, unknown> = {}) => ({
  booking_id: 77,
  worker_uid: 'provider-1',
  status: 'WORKER_ASSIGNED',
  worker_status: 'ACCEPTED',
  has_escalation: false,
  schedule: '2026-09-01T02:00:00.000Z',
  customer_id: 'cust-1',
  first_name: 'Maria',
  last_name: 'Santos',
  phone_number: '+639171234567',
  post_town: 'Makati',
  country: 'PH',
  ...over,
});

const codes = (card: ReturnType<typeof formatJobCard>) =>
  card.availableActions.map((a) => a.code);

// ─── The verdict criterion ────────────────────────────────────────────────────

describe('VERDICT: job-order state cannot diverge from booking state', () => {
  it('every card carries a canonical state', () => {
    const card = formatJobCard(row());
    expect(BOOKING_STATES).toContain(card.canonicalState);
  });

  it('the canonical state agrees with the machine for EVERY column pair', () => {
    /**
     * The cross-product. If the formatter ever derives differently from
     * `deriveCanonicalState` — by caching, by reordering, by reading a column
     * it should not — this finds it.
     */
    const bookingStatuses = ['PENDING_OTP', 'CONFIRMED', 'PAID', 'WORKER_ASSIGNED',
      'COMPLETED', 'CANCELLED', 'CANCELED', 'REFUNDED', 'FAILED', 'EXPIRED', 'UNKNOWN_STATUS'];
    const workerStatuses = [null, 'ASSIGNED', 'ACCEPTED', 'EN_ROUTE', 'ARRIVED',
      'IN_PROGRESS', 'COMPLETED', 'DECLINED', 'REASSIGNED', 'CANCELLED'];

    const disagreements: string[] = [];
    for (const status of bookingStatuses) {
      for (const worker_status of workerStatuses) {
        for (const worker_uid of ['provider-1', null]) {
          for (const has_escalation of [false, true]) {
            const card = formatJobCard(row({ status, worker_status, worker_uid, has_escalation }));
            const expected = deriveCanonicalState({
              bookingStatus: status,
              workerStatus: worker_status,
              workerUid: worker_uid,
              hasEscalation: has_escalation,
            });
            if (card.canonicalState !== expected) {
              disagreements.push(
                `  ${status}/${worker_status}/uid=${worker_uid ? 'set' : 'null'}/esc=${has_escalation}`
                + ` → card=${card.canonicalState} machine=${expected}`,
              );
            }
          }
        }
      }
    }
    expect(disagreements.length ? disagreements.slice(0, 20).join('\n') : 'agree').toBe('agree');
  });

  it('reports DISPUTED when an escalation is open', () => {
    // The job-card query had no escalation column, so wiring the projection
    // without adding one would have INTRODUCED a divergence: the card saying
    // IN_PROGRESS while Admin says DISPUTED.
    const card = formatJobCard(row({ worker_status: 'IN_PROGRESS', has_escalation: true }));
    expect(card.canonicalState).toBe('DISPUTED');
  });

  it('a resolved escalation does not pin the card at DISPUTED', () => {
    // `has_escalation` is computed with `resolved_at IS NULL`, matching the
    // predicate Admin's list and metrics use.
    const card = formatJobCard(row({ worker_status: 'IN_PROGRESS', has_escalation: false }));
    expect(card.canonicalState).toBe('IN_PROGRESS');
  });
});

// ─── Compatibility ────────────────────────────────────────────────────────────

describe('the raw fields are preserved exactly', () => {
  it('keeps status and workerStatus untouched', () => {
    // Shipped provider clients read these today. §4: additive only.
    const card = formatJobCard(row({ status: 'WORKER_ASSIGNED', worker_status: 'EN_ROUTE' }));
    expect(card.status).toBe('WORKER_ASSIGNED');
    expect(card.workerStatus).toBe('EN_ROUTE');
  });

  it('passes raw values through even when they are unrecognised', () => {
    // A client matching on the raw string must keep seeing the raw string, not
    // a normalised one.
    const card = formatJobCard(row({ status: 'SOMETHING_ODD', worker_status: 'ALSO_ODD' }));
    expect(card.status).toBe('SOMETHING_ODD');
    expect(card.workerStatus).toBe('ALSO_ODD');
  });

  it('adds the canonical fields beside them, never instead', () => {
    const card = formatJobCard(row());
    for (const key of ['bookingId', 'workerId', 'status', 'workerStatus', 'customer',
      'address', 'service', 'addOns', 'assignedAt', 'startedAt', 'completedAt',
      'availableActions', 'canonicalState', 'stateLabel', 'nextAction', 'terminal']) {
      expect(Object.keys(card)).toContain(key);
    }
  });
});

// ─── Actions are generated, not switched ──────────────────────────────────────

describe('provider actions come from the transition whitelist', () => {
  it('offers exactly the routed machine actions, per state', () => {
    // The full matrix, pinned. Shipped clients render this list in order, so
    // both membership and order are part of the contract.
    const expected: Record<string, string[]> = {
      PENDING_OTP:         ['VIEW_DETAILS'],
      AWAITING_ASSIGNMENT: ['VIEW_DETAILS'],
      ASSIGNED:            ['VIEW_DETAILS', 'ACCEPT_ASSIGNMENT', 'DECLINE_ASSIGNMENT'],
      ACCEPTED:            ['VIEW_DETAILS', 'OPEN_DIRECTIONS', 'MARK_EN_ROUTE', 'START_JOB'],
      EN_ROUTE:            ['VIEW_DETAILS', 'OPEN_DIRECTIONS', 'MARK_ARRIVED', 'START_JOB'],
      ARRIVED:             ['VIEW_DETAILS', 'OPEN_DIRECTIONS', 'START_JOB'],
      IN_PROGRESS:         ['VIEW_DETAILS', 'OPEN_DIRECTIONS', 'COMPLETE_JOB'],
      COMPLETED:           ['VIEW_DETAILS', 'VIEW_EARNINGS'],
      CANCELLED:           ['VIEW_DETAILS'],
      DISPUTED:            ['VIEW_DETAILS'],
      EXPIRED:             ['VIEW_DETAILS'],
    };
    // No policy verdict supplied, so the conditional action is absent — the
    // matrix is the STATE-only answer, deliberately.
    for (const state of BOOKING_STATES) {
      expect(`${state}: ${providerActionsForState(state).map((a) => a.code).join(',')}`)
        .toBe(`${state}: ${expected[state].join(',')}`);
    }
  });

  it('never offers an action the machine forbids', () => {
    /**
     * The property that makes generation worth doing. A UI code that maps to a
     * transition must only appear where the whitelist permits that transition.
     */
    const uiToMachine: Record<string, string> = {
      ACCEPT_ASSIGNMENT: 'accept',
      DECLINE_ASSIGNMENT: 'decline',
      MARK_EN_ROUTE: 'markEnRoute',
      MARK_ARRIVED: 'markArrived',
      START_JOB: 'startJob',
      COMPLETE_JOB: 'complete',
    };
    for (const state of BOOKING_STATES) {
      const permitted = allowedActions(state, 'assigned_provider');
      for (const a of providerActionsForState(state)) {
        const machine = uiToMachine[a.code];
        if (!machine) continue; // view-only action, no transition
        expect(`${state}:${a.code} permitted=${permitted.includes(machine)}`)
          .toBe(`${state}:${a.code} permitted=true`);
      }
    }
  });

  it('CANCEL_JOB is advertised, driven by the guard and not by the state', () => {
    /**
     * The decision that retired the omission. `providerCancel` was hidden while
     * its product status was unresolved; the transport was always complete.
     *
     * It is advertised only when a POLICY VERDICT is supplied, because the
     * state alone cannot answer the 48-hour question. No verdict means the
     * caller could not run the policy, and offering it anyway would be guessing
     * on the provider's behalf.
     */
    const open = providerActionsForState('ACCEPTED', {
      cancellation: { canCancel: true, allowedUntil: '2026-09-05T09:00:00.000Z', blockCode: null },
    });
    const cancel = open.find((a) => a.code === 'CANCEL_JOB');
    expect(cancel).toBeDefined();
    expect(cancel!.enabled).toBe(true);
    expect(cancel!.requiresConfirmation).toBe(true);
    expect(cancel!.allowedUntil).toBe('2026-09-05T09:00:00.000Z');
    expect(cancel!.reasonCode).toBeUndefined();
  });

  it('inside the notice window it is DISABLED, with the code the POST would use', () => {
    const late = providerActionsForState('ACCEPTED', {
      cancellation: {
        canCancel: false, allowedUntil: '2026-09-05T09:00:00.000Z',
        blockCode: 'INSIDE_NOTICE_WINDOW',
      },
    });
    const cancel = late.find((a) => a.code === 'CANCEL_JOB');
    expect(cancel).toBeDefined();
    expect(cancel!.enabled).toBe(false);
    // The SAME wire code the executor's guard refuses with, so a greyed button
    // and a 409 name the same thing.
    expect(cancel!.reasonCode).toBe('BOOKING_PROVIDER_CANCEL_WINDOW_EXPIRED');
    // Supplied so a client can say "until Thursday" without doing the maths.
    expect(cancel!.allowedUntil).toBe('2026-09-05T09:00:00.000Z');
  });

  it('is OMITTED when no verdict is available — never offered optimistically', () => {
    // Advertising it unevaluated is exactly the "button says yes, backend says
    // no" failure this wiring exists to prevent.
    const blind = providerActionsForState('ACCEPTED');
    expect(blind.map((a) => a.code)).not.toContain('CANCEL_JOB');
  });

  it('is not offered where the MACHINE forbids it, whatever the verdict says', () => {
    /**
     * The policy can only narrow. A verdict claiming cancellation is fine does
     * not create a transition the whitelist does not have — IN_PROGRESS and
     * ASSIGNED are not provider-cancellable states.
     */
    for (const state of ['ASSIGNED', 'IN_PROGRESS', 'COMPLETED'] as BookingState[]) {
      const actions = providerActionsForState(state, {
        cancellation: { canCancel: true, allowedUntil: null, blockCode: null },
      });
      expect(actions.map((a) => a.code)).not.toContain('CANCEL_JOB');
    }
  });

  it('EN_ROUTE and ARRIVED follow the same canonical policy', () => {
    for (const state of ['EN_ROUTE', 'ARRIVED'] as BookingState[]) {
      expect(allowedActions(state, 'assigned_provider')).toContain('providerCancel');
      const actions = providerActionsForState(state, {
        cancellation: { canCancel: true, allowedUntil: null, blockCode: null },
      });
      expect(actions.map((a) => a.code)).toContain('CANCEL_JOB');
    }
  });

  it('THE COMPLETENESS GUARD: no executable action may be unreachable', () => {
    /**
     * Every action the machine lets a provider perform must have either a UI
     * mapping or a documented reason for being hidden. Without this the
     * unadvertised list becomes a graveyard of capabilities nobody remembers
     * deciding to hide — which is how `providerCancel` sat there.
     */
    const everyProviderAction = new Set(
      BOOKING_STATES.flatMap((s) => allowedActions(s, 'assigned_provider')),
    );
    const unreachable = [...everyProviderAction].filter(
      (name) => !MAPPED_PROVIDER_ACTIONS.includes(name)
        && !(name in UNADVERTISED_PROVIDER_ACTIONS),
    );
    expect(unreachable).toEqual([]);
  });

  it('the unadvertised list is now EMPTY, and any entry must carry a reason', () => {
    expect(Object.keys(UNADVERTISED_PROVIDER_ACTIONS)).toEqual([]);
    for (const reason of Object.values(UNADVERTISED_PROVIDER_ACTIONS)) {
      expect(reason.length).toBeGreaterThan(60);
    }
  });

  it('START_JOB asks for the worker code, wherever it appears', () => {
    for (const state of ['ACCEPTED', 'EN_ROUTE', 'ARRIVED'] as BookingState[]) {
      const start = providerActionsForState(state).find((a) => a.code === 'START_JOB');
      expect(start).toBeDefined();
      expect(start!.requiresCode).toBe(true);
      expect(start!.requiresConfirmation).toBe(true);
    }
  });

  it('directions appear exactly where the address is disclosed', () => {
    // OPEN_DIRECTIONS tracks disclosure, not lifecycle. Offering navigation
    // while the card shows only a city would promise a precision the payload
    // deliberately withholds.
    const withDirections = BOOKING_STATES.filter((s) =>
      providerActionsForState(s).some((a) => a.code === 'OPEN_DIRECTIONS'));
    expect(withDirections.sort()).toEqual(['ACCEPTED', 'ARRIVED', 'EN_ROUTE', 'IN_PROGRESS']);
  });
});

// ─── The declared behaviour change ────────────────────────────────────────────

describe('DECLARED CHANGE: inconsistent rows are now read-only', () => {
  /**
   * The old list keyed on the assignment row alone, so it answered a question
   * about the assignment when the right question was about the booking.
   */
  it('a cancelled booking offers nothing, even with a live assignment row', () => {
    const card = formatJobCard(row({ status: 'CANCELLED', worker_status: 'ACCEPTED' }));
    expect(card.canonicalState).toBe('CANCELLED');
    expect(codes(card)).toEqual(['VIEW_DETAILS']);
  });

  it('a cancelled booking no longer offers ACCEPT on a stale ASSIGNED row', () => {
    const card = formatJobCard(row({ status: 'CANCELLED', worker_status: 'ASSIGNED' }));
    expect(codes(card)).not.toContain('ACCEPT_ASSIGNMENT');
  });

  it('a declined assignment stays read-only', () => {
    // declineJob does not rewrite bookings.status, so this row reads
    // WORKER_ASSIGNED with a DECLINED assignment.
    const card = formatJobCard(row({ status: 'WORKER_ASSIGNED', worker_status: 'DECLINED' }));
    expect(card.canonicalState).toBe('AWAITING_ASSIGNMENT');
    expect(codes(card)).toEqual(['VIEW_DETAILS']);
  });

  it('consistent rows are UNCHANGED — the common case did not move', () => {
    const cases: Array<[string, string, string[]]> = [
      ['WORKER_ASSIGNED', 'ASSIGNED', ['VIEW_DETAILS', 'ACCEPT_ASSIGNMENT', 'DECLINE_ASSIGNMENT']],
      // CANCEL_JOB now appears on the provider-cancellable states. The job card
      // runs the real policy, and this fixture's schedule is 30 days out, so
      // the notice window is open and it is ENABLED.
      ['WORKER_ASSIGNED', 'ACCEPTED', ['VIEW_DETAILS', 'OPEN_DIRECTIONS', 'MARK_EN_ROUTE', 'START_JOB', 'CANCEL_JOB']],
      ['WORKER_ASSIGNED', 'EN_ROUTE', ['VIEW_DETAILS', 'OPEN_DIRECTIONS', 'MARK_ARRIVED', 'START_JOB', 'CANCEL_JOB']],
      ['WORKER_ASSIGNED', 'ARRIVED', ['VIEW_DETAILS', 'OPEN_DIRECTIONS', 'START_JOB', 'CANCEL_JOB']],
      ['WORKER_ASSIGNED', 'IN_PROGRESS', ['VIEW_DETAILS', 'OPEN_DIRECTIONS', 'COMPLETE_JOB']],
      ['COMPLETED', 'COMPLETED', ['VIEW_DETAILS', 'VIEW_EARNINGS']],
    ];
    for (const [status, worker_status, expected] of cases) {
      expect(`${status}/${worker_status}: ${codes(formatJobCard(row({ status, worker_status }))).join(',')}`)
        .toBe(`${status}/${worker_status}: ${expected.join(',')}`);
    }
  });

  it('the legacy adapter returns the same answers as before', () => {
    // `actionsForWorkerStatus` kept its signature and now delegates. Its own
    // pre-existing suite is the parity evidence; this pins the mapping.
    expect(actionsForWorkerStatus('ASSIGNED').map((a) => a.code))
      .toEqual(['VIEW_DETAILS', 'ACCEPT_ASSIGNMENT', 'DECLINE_ASSIGNMENT']);
    expect(actionsForWorkerStatus('COMPLETED').map((a) => a.code))
      .toEqual(['VIEW_DETAILS', 'VIEW_EARNINGS']);
    expect(actionsForWorkerStatus(null).map((a) => a.code)).toEqual(['VIEW_DETAILS']);
    expect(actionsForWorkerStatus('NONSENSE').map((a) => a.code)).toEqual(['VIEW_DETAILS']);
  });
});

// ─── Every surface goes through the formatter ─────────────────────────────────

describe('all three provider surfaces consume the canonical projection', () => {
  it('v1, Provider Web and legacy mobile all call formatJobCard', () => {
    /**
     * The leverage this whole change depends on. If a surface stopped calling
     * the formatter and built its own payload, it would go back to shipping raw
     * status with no canonical state — silently, because nothing else checks.
     */
    expect(codeOf('api/v1/domains/providerJobs.ts')).toContain('formatJobCard');
    expect(codeOf('controllers/providerController.ts')).toContain('formatJobCard');
    expect(codeOf('controllers/technicianController.ts')).toContain('formatJobCard');
  });

  it('the formatter derives once, from the canonical machine', () => {
    const view = codeOf('controllers/jobCardView.ts');
    expect(view).toContain('deriveCanonicalState');
    expect(view).toContain('toProviderProjection');
    expect(view).toContain('providerActionsForState');
  });

  it('the projection contract still matches what the card publishes', () => {
    const card = formatJobCard(row({ worker_status: 'EN_ROUTE' }));
    const projection = toProviderProjection('EN_ROUTE');
    expect(card.stateLabel).toBe(projection.label);
    expect(card.nextAction).toBe(projection.nextAction);
    expect(card.terminal).toBe(projection.terminal);
  });

  it('nextAction is never one the machine would refuse', () => {
    for (const state of BOOKING_STATES) {
      const next = toProviderProjection(state).nextAction;
      if (next === null) continue;
      expect(allowedActions(state, 'assigned_provider')).toContain(next);
    }
  });
});

// ─── The guard against a sixth derivation ─────────────────────────────────────

describe('no new provider-state derivation may appear', () => {
  /**
   * Files permitted to name provider lifecycle stages, each with the reason it
   * is not a derivation. Adding a file fails this test and forces somebody to
   * classify it — which is how the SQL derivation was eventually caught, one
   * tab too late.
   */
  const PERMITTED: Record<string, string> = {
    'services/booking/canonicalState.ts':
      'THE machine. The one place allowed to decide what a state is.',
    'services/booking/providerActions.ts':
      'Projects the machine into UI codes. Decides no state; keyed BY state.',
    'services/booking/projections.ts':
      'Labels every state. Decides nothing.',
    'controllers/bookingActions.ts':
      'A thin adapter for the one caller holding only a worker status. Delegates.',
    'controllers/jobCardView.ts':
      'Calls deriveCanonicalState once and passes the answer on.',
  };

  it('every file producing provider ACTIONS is a reviewed consumer', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.ts')) continue;
        const rel = path.relative(SRC, full).split(path.sep).join('/');
        const code = codeOf(rel);
        // The shape of a derivation: emitting UI action codes directly.
        const emitsActionCodes = /['"]ACCEPT_ASSIGNMENT['"]/.test(code)
          && /['"]START_JOB['"]/.test(code);
        if (!emitsActionCodes) continue;
        if (!(rel in PERMITTED)) offenders.push(rel);
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });

  it('the detector would catch a new one', () => {
    // Negative fixture: the shape it looks for is the shape a derivation has.
    const fixture = `const a = ["ACCEPT_ASSIGNMENT"]; const b = ["START_JOB"];`;
    expect(/['"]ACCEPT_ASSIGNMENT['"]/.test(fixture) && /['"]START_JOB['"]/.test(fixture)).toBe(true);
    expect(/['"]ACCEPT_ASSIGNMENT['"]/.test('const x = 1;')).toBe(false);
  });

  it('every permitted file still exists', () => {
    for (const rel of Object.keys(PERMITTED)) {
      expect(fs.existsSync(path.join(SRC, rel))).toBe(true);
    }
  });

  it('the old switch is gone, not merely unused', () => {
    // An orphaned switch is a second opinion waiting for a caller.
    const adapter = codeOf('controllers/bookingActions.ts');
    expect(adapter).not.toContain('case "ASSIGNED"');
    expect(adapter).not.toContain("case 'ASSIGNED'");
    expect(adapter).toContain('providerActionsForState');
  });
});
