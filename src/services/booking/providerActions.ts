/**
 * The provider's action list, GENERATED from the canonical transition machine.
 *
 * ## What this replaces
 *
 * `controllers/bookingActions.actionsForWorkerStatus` was a `switch` over the
 * raw `booking_workers.status` string — a fifth derivation of booking state,
 * living beside the four TAB 04 and the Admin work consolidated. It was pinned
 * to the machine by an agreement test rather than derived from it, and an
 * agreement test only proves the two match for the cases somebody thought to
 * enumerate. A state added to the machine did not appear here; it fell through
 * to the read-only default and the provider silently lost the ability to act.
 *
 * Now the transition whitelist decides, and the UI vocabulary is a projection
 * of it.
 *
 * ## Two things the machine alone cannot decide
 *
 * **1. Some actions are CONDITIONAL on a policy, not on the state.**
 *
 * `providerCancel` is permitted by the machine from ACCEPTED, EN_ROUTE and
 * ARRIVED, but whether it is actually available depends on the 48-hour notice
 * window — a policy the state alone cannot answer.
 *
 * It is advertised, and the availability comes from RUNNING THE GUARD'S OWN
 * POLICY FUNCTION, never from re-deriving the rule here. The client therefore
 * never calculates 48 hours, and discovery cannot disagree with enforcement:
 * both call `evaluateCancellation`.
 *
 * When the caller cannot supply an eligibility verdict — the legacy adapter
 * holds a worker status and no schedule — the action is OMITTED rather than
 * offered optimistically. Advertising it unevaluated is precisely the
 * "button says yes, backend says no" failure the wiring exists to prevent.
 *
 * **2. Not every UI action is a transition.**
 *
 * `VIEW_DETAILS`, `OPEN_DIRECTIONS` and `VIEW_EARNINGS` change no state. They
 * are declared per canonical state below, because "can the provider open
 * directions" is a disclosure question, not a lifecycle one — directions are
 * offered exactly where the address is disclosed.
 */

import {
  allowedActions,
  type BookingState,
} from './canonicalState';

export type BookingActionCode =
  | 'VIEW_DETAILS'
  | 'ACCEPT_ASSIGNMENT'
  | 'DECLINE_ASSIGNMENT'
  | 'MARK_EN_ROUTE'
  | 'MARK_ARRIVED'
  | 'START_JOB'
  | 'COMPLETE_JOB'
  | 'CANCEL_JOB'
  | 'OPEN_DIRECTIONS'
  | 'VIEW_EARNINGS';

export interface BookingAction {
  code: BookingActionCode;
  /** The client must confirm deliberately before calling. */
  requiresConfirmation: boolean;
  /** A code the provider must supply — today only the job-start worker code. */
  requiresCode: boolean;
  /**
   * Whether the provider may invoke it RIGHT NOW.
   *
   * Absent means yes — additive, so a client that predates this field behaves
   * exactly as before. Present and false means the action exists for this state
   * but a policy currently refuses it, and `reasonCode` says which.
   */
  enabled?: boolean;
  /** Why it is disabled. The same code the POST would refuse with. */
  reasonCode?: string;
  /**
   * The instant after which the action stops being available, ISO-8601.
   *
   * Supplied so a client can say "until Thursday 09:00" WITHOUT subtracting a
   * notice period from a schedule itself. Null when there is no usable
   * schedule; a client must not invent one.
   */
  allowedUntil?: string | null;
}

const action = (
  code: BookingActionCode,
  requiresConfirmation = false,
  requiresCode = false,
): BookingAction => ({ code, requiresConfirmation, requiresCode });

/**
 * Machine action → the UI code that invokes it, for actions that are ROUTED.
 *
 * The confirmation and code flags live here because they are properties of the
 * interaction, not of the transition: `startJob` needs the customer's worker
 * code, and every state-changing tap is deliberate.
 */
const ROUTED_ACTIONS: Record<string, BookingAction> = {
  accept:       action('ACCEPT_ASSIGNMENT', true),
  decline:      action('DECLINE_ASSIGNMENT', true),
  markEnRoute:  action('MARK_EN_ROUTE', true),
  markArrived:  action('MARK_ARRIVED', true),
  startJob:     action('START_JOB', true, true),
  complete:     action('COMPLETE_JOB', true),
};

/**
 * Machine actions whose availability depends on a POLICY the state cannot
 * answer, mapped to the UI code that invokes them.
 *
 * These are advertised, but only when the caller supplies the policy verdict.
 */
const CONDITIONAL_ACTIONS: Record<string, BookingActionCode> = {
  providerCancel: 'CANCEL_JOB',
};

/**
 * Machine actions deliberately NOT offered, each with the reason.
 *
 * Empty, and the guard keeps it honest: every executable provider action must
 * have either a UI mapping or an entry here. A capability that is neither is a
 * capability nobody can reach and nobody remembers deciding to hide, which is
 * how this list started.
 */
export const UNADVERTISED_PROVIDER_ACTIONS: Record<string, string> = {};

/** @deprecated Renamed — the omission was never about routing. */
export const UNROUTED_PROVIDER_ACTIONS = UNADVERTISED_PROVIDER_ACTIONS;

/**
 * A policy verdict the action list can consume.
 *
 * Deliberately the shape `evaluateCancellation` already returns, so a caller
 * passes the guard's own answer through rather than translating it — a
 * translation layer is somewhere the two could differ.
 */
export interface ActionPolicyContext {
  cancellation?: {
    canCancel: boolean;
    allowedUntil: string | null;
    blockCode: string | null;
  } | null;
}

/**
 * Block codes to the wire codes the POST refuses with.
 *
 * Same mapping the executor's guard uses, so a disabled button and a refused
 * request name the same thing.
 */
const CANCEL_REASON_CODES: Record<string, string> = {
  INSIDE_NOTICE_WINDOW: 'BOOKING_PROVIDER_CANCEL_WINDOW_EXPIRED',
  NOT_CANCELLABLE_AT_THIS_STAGE: 'BOOKING_PROVIDER_CANCEL_STAGE_INVALID',
  SCHEDULE_UNKNOWN: 'BOOKING_PROVIDER_CANCEL_SCHEDULE_UNKNOWN',
  INVALID_REASON: 'BOOKING_PROVIDER_CANCEL_REASON_INVALID',
};

/**
 * Non-transition actions, per canonical state.
 *
 * `OPEN_DIRECTIONS` tracks ADDRESS DISCLOSURE, not the lifecycle: it appears
 * exactly where `jobCardView` releases the street address and coordinates.
 * Offering navigation while the card still shows only a city would promise a
 * precision the payload deliberately withholds.
 */
const VIEW_ONLY_ACTIONS: Partial<Record<BookingState, BookingActionCode[]>> = {
  ACCEPTED:    ['OPEN_DIRECTIONS'],
  EN_ROUTE:    ['OPEN_DIRECTIONS'],
  ARRIVED:     ['OPEN_DIRECTIONS'],
  IN_PROGRESS: ['OPEN_DIRECTIONS'],
  COMPLETED:   ['VIEW_EARNINGS'],
};

/**
 * The provider's actions for a canonical state.
 *
 * Order is stable and deliberate: `VIEW_DETAILS` first, then any view-only
 * action, then the transitions in whitelist order. Shipped clients render this
 * list in order, so reordering it is a visible change.
 */
export function providerActionsForState(
  state: BookingState,
  policy: ActionPolicyContext = {},
): BookingAction[] {
  const permitted = allowedActions(state, 'assigned_provider');

  const transitions = permitted
    .filter((name) => name in ROUTED_ACTIONS)
    .map((name) => ROUTED_ACTIONS[name]);

  /**
   * Conditional actions are advertised ONLY when a verdict was supplied.
   *
   * No verdict means the caller could not run the policy, and offering the
   * action anyway would be guessing on the provider's behalf. Omitting is the
   * honest answer to "I do not know whether you may do this".
   */
  const conditional: BookingAction[] = [];
  for (const name of permitted) {
    const code = CONDITIONAL_ACTIONS[name];
    if (!code) continue;
    if (name === 'providerCancel') {
      const verdict = policy.cancellation;
      if (!verdict) continue;
      conditional.push({
        code,
        requiresConfirmation: true,
        requiresCode: false,
        enabled: verdict.canCancel,
        ...(verdict.canCancel ? {} : {
          reasonCode: CANCEL_REASON_CODES[verdict.blockCode ?? '']
            ?? 'BOOKING_PROVIDER_CANCEL_REFUSED',
        }),
        allowedUntil: verdict.allowedUntil,
      });
    }
  }

  const viewOnly = (VIEW_ONLY_ACTIONS[state] ?? []).map((code) => action(code));

  // VIEW_DETAILS is unconditional. A provider can always read a job they hold,
  // including a terminal or disputed one — read-only is the fail-closed floor,
  // not a state-specific grant.
  return [action('VIEW_DETAILS'), ...viewOnly, ...transitions, ...conditional];
}

/** Every machine action this module knows how to advertise. */
export const MAPPED_PROVIDER_ACTIONS: readonly string[] = [
  ...Object.keys(ROUTED_ACTIONS),
  ...Object.keys(CONDITIONAL_ACTIONS),
];
