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
 * **1. Not every machine action has an endpoint.**
 *
 * `providerCancel` is in the whitelist for `assigned_provider` from ACCEPTED,
 * EN_ROUTE and ARRIVED — TAB 04's E1 put it behind the executor. It has no
 * route. Generating the UI list naively would put a Cancel button in the
 * provider app whose request has nowhere to go, which is precisely the failure
 * `bookingActions.ts` was written to prevent: "the UI must never display an
 * unsupported action."
 *
 * So the mapping is an explicit allow-list, and an action the machine permits
 * but nothing routes is omitted **by name, with a reason**. When the route
 * lands, one line here turns the button on.
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
  | 'OPEN_DIRECTIONS'
  | 'VIEW_EARNINGS';

export interface BookingAction {
  code: BookingActionCode;
  /** The client must confirm deliberately before calling. */
  requiresConfirmation: boolean;
  /** A code the provider must supply — today only the job-start worker code. */
  requiresCode: boolean;
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
 * Machine actions a provider may perform that are deliberately NOT offered,
 * each with the reason. Omitting silently is how a broken button ships.
 */
export const UNROUTED_PROVIDER_ACTIONS: Record<string, string> = {
  providerCancel:
    'In the whitelist from ACCEPTED/EN_ROUTE/ARRIVED and enforced by the '
    + 'executor since TAB 04 E1, but no provider-facing route exists. Offering '
    + 'it would put a Cancel button in the app whose request has nowhere to go. '
    + 'Add the route, then delete this entry.',
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
export function providerActionsForState(state: BookingState): BookingAction[] {
  const transitions = allowedActions(state, 'assigned_provider')
    .filter((name) => name in ROUTED_ACTIONS)
    .map((name) => ROUTED_ACTIONS[name]);

  const viewOnly = (VIEW_ONLY_ACTIONS[state] ?? []).map((code) => action(code));

  // VIEW_DETAILS is unconditional. A provider can always read a job they hold,
  // including a terminal or disputed one — read-only is the fail-closed floor,
  // not a state-specific grant.
  return [action('VIEW_DETAILS'), ...viewOnly, ...transitions];
}
