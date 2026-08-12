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
 * **1. Not every machine action is ADVERTISED.**
 *
 * The mapping is an explicit allow-list, and an action the machine permits but
 * this list omits is recorded **by name, with a reason**, so the omission is a
 * decision somebody can find rather than an accident.
 *
 * `providerCancel` is the current case, and the reason is NOT that it lacks a
 * route — an earlier version of this comment said so and was wrong.
 * `POST /api/provider/bookings/:bookingId/cancel` exists, is authenticated and
 * role-guarded, runs through the executor, and ServanaWorker already calls it
 * along with its `cancellation-eligibility` companion. The transport is
 * complete on both sides.
 *
 * What is missing is a decision: whether the job card should ADVERTISE cancel
 * as a first-class action, which changes what every provider sees on every
 * accepted job. Advertising it is a product change with its own blast radius —
 * the 48-hour window means most taps would be refused — so it stays omitted
 * until that is decided, not because it cannot work.
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
export const UNADVERTISED_PROVIDER_ACTIONS: Record<string, string> = {
  providerCancel:
    'ROUTED AND WORKING: POST /api/provider/bookings/:bookingId/cancel, behind '
    + 'verifyAuth + requireProviderRole + requireActiveProvider, executing '
    + 'PROVIDER_CANCEL through the executor with the 48-hour window guard. '
    + 'ServanaWorker already calls it and its cancellation-eligibility '
    + 'companion. It is omitted from the advertised action list because '
    + 'surfacing cancel on every accepted job is a PRODUCT decision, not a '
    + 'transport gap — most taps would hit the notice window and be refused. '
    + 'Decide, then either add the UI code or remove the action from the '
    + 'provider-advertisable set.',
};

/** @deprecated Renamed — the omission is about advertising, not routing. */
export const UNROUTED_PROVIDER_ACTIONS = UNADVERTISED_PROVIDER_ACTIONS;

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
