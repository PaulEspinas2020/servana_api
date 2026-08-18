/**
 * Admin, Customer and Provider projections of ONE canonical booking state.
 *
 * ```
 *              ┌─────────── canonical state ───────────┐
 *              ↓               ↓                       ↓
 *          Admin DTO      Customer DTO           Provider DTO
 *        (may GROUP,     (friendly wording)   (action-oriented)
 *      never destroy)
 * ```
 *
 * ## The rule these obey
 *
 * A projection may reword and may group. It may not lose a distinction. Every
 * projection here carries the canonical state verbatim alongside whatever
 * presentation it adds, so no surface can report a booking as being in a state
 * it is not in.
 *
 * ## Why `operationsStatus` still collapses EN_ROUTE and ARRIVED
 *
 * It should not, and the operator has ruled that it must not remain so. But the
 * Admin portal types that field as a closed union and looks its label and
 * colour up in `Record<AdminBookingOperationsStatus, string>` maps
 * (`admin-booking.dto.ts:216, 228`). An unknown key returns `undefined`, so
 * emitting `en_route` today renders a BLANK badge with no colour — a visibly
 * broken status column on a live platform.
 *
 * So the collapse is not removed from that field; it is made harmless. The
 * canonical state travels in NEW fields beside it — `canonicalState` and
 * `stateGroup` — which the current portal ignores and the next version reads.
 * `operationsStatus` is marked deprecated and becomes a pure legacy projection.
 *
 * That is the additive path. Deleting the collapse in the backend alone would
 * satisfy the letter of the instruction by breaking the client it was meant to
 * help.
 */

import {
  type BookingState,
  type StateGroup,
  type Actor,
  groupOf,
  allowedActions,
  isTerminal,
} from './canonicalState';

// ─── Admin ────────────────────────────────────────────────────────────────────

/**
 * The vocabulary the Admin portal understands TODAY. Closed, and not extended
 * here — see the module docblock.
 *
 * @deprecated Read `canonicalState` instead. This field cannot represent
 * EN_ROUTE or ARRIVED and reports both as `accepted`.
 */
export type LegacyOperationsStatus =
  | 'new'
  | 'awaiting_assignment'
  | 'assigned'
  | 'accepted'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'disputed';

/** Lossy by necessity. The loss is named in the type and in the DTO. */
const LEGACY_OPS: Record<BookingState, LegacyOperationsStatus> = {
  PENDING_OTP: 'new',
  AWAITING_ASSIGNMENT: 'awaiting_assignment',
  ASSIGNED: 'assigned',
  ACCEPTED: 'accepted',
  // ↓ The collapse. Preserved ONLY because the portal's Record lookup would
  //   render a blank badge for anything else. `canonicalState` carries the truth.
  EN_ROUTE: 'accepted',
  ARRIVED: 'accepted',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  DISPUTED: 'disputed',
  EXPIRED: 'cancelled',
};

/** Which canonical states this legacy value cannot tell apart. */
export const LEGACY_OPS_COLLAPSES: Partial<Record<LegacyOperationsStatus, BookingState[]>> = {
  accepted: ['ACCEPTED', 'EN_ROUTE', 'ARRIVED'],
  cancelled: ['CANCELLED', 'EXPIRED'],
};

export interface AdminBookingStateDto {
  /** THE truth. Full operational fidelity. Read this. */
  canonicalState: BookingState;
  /** Presentation grouping for dashboards and filters. Never a substitute. */
  stateGroup: StateGroup;
  /** Human label for the canonical state, in Admin's register. */
  label: string;
  /** @deprecated Lossy. See `stateIsCollapsedInLegacyField`. */
  operationsStatus: LegacyOperationsStatus;
  /** True when `operationsStatus` cannot express `canonicalState`. */
  stateIsCollapsedInLegacyField: boolean;
  terminal: boolean;
  availableActions: string[];
}

const ADMIN_LABELS: Record<BookingState, string> = {
  PENDING_OTP: 'New',
  AWAITING_ASSIGNMENT: 'Awaiting Assignment',
  ASSIGNED: 'Assigned',
  ACCEPTED: 'Accepted',
  EN_ROUTE: 'En Route',
  ARRIVED: 'Arrived',
  IN_PROGRESS: 'In Progress',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  DISPUTED: 'Disputed',
  EXPIRED: 'Expired',
};

export function toAdminProjection(state: BookingState): AdminBookingStateDto {
  const legacy = LEGACY_OPS[state];
  const collapsed = (LEGACY_OPS_COLLAPSES[legacy] ?? []).length > 1;
  return {
    canonicalState: state,
    stateGroup: groupOf(state),
    label: ADMIN_LABELS[state],
    operationsStatus: legacy,
    stateIsCollapsedInLegacyField: collapsed,
    terminal: isTerminal(state),
    availableActions: allowedActions(state, 'admin'),
  };
}

// ─── Customer ─────────────────────────────────────────────────────────────────

export interface CustomerBookingStateDto {
  canonicalState: BookingState;
  /** What the customer is told. Their register, not the operator's. */
  label: string;
  /** One line of context under the label. */
  detail: string;
  terminal: boolean;
  availableActions: string[];
}

/**
 * Customer wording.
 *
 * Deliberately about the PROVIDER's progress rather than the booking's
 * administrative state: "Awaiting Assignment" is an operations concept and
 * means nothing to somebody waiting for a cleaner.
 */
const CUSTOMER_COPY: Record<BookingState, { label: string; detail: string }> = {
  PENDING_OTP: { label: 'Confirm your booking', detail: 'Enter the code we sent you to confirm.' },
  AWAITING_ASSIGNMENT: { label: 'Finding your provider', detail: "We're matching you with an available provider." },
  ASSIGNED: { label: 'Provider found', detail: 'Waiting for them to confirm.' },
  ACCEPTED: { label: 'Confirmed', detail: 'Your provider has confirmed this booking.' },
  EN_ROUTE: { label: 'On the way', detail: 'Your provider is travelling to you.' },
  ARRIVED: { label: 'Arrived', detail: 'Your provider is at your address.' },
  IN_PROGRESS: { label: 'In progress', detail: 'Work has started.' },
  COMPLETED: { label: 'Completed', detail: 'This booking is finished.' },
  CANCELLED: { label: 'Cancelled', detail: 'This booking was cancelled.' },
  DISPUTED: { label: 'Under review', detail: "We're looking into this booking." },
  EXPIRED: { label: 'Expired', detail: 'This booking was not confirmed in time.' },
};

export function toCustomerProjection(state: BookingState): CustomerBookingStateDto {
  return {
    canonicalState: state,
    ...CUSTOMER_COPY[state],
    terminal: isTerminal(state),
    availableActions: allowedActions(state, 'customer'),
  };
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export interface ProviderBookingStateDto {
  canonicalState: BookingState;
  /** Action-oriented: what the provider does next, not what the booking is. */
  label: string;
  /** The single next step, when there is an obvious one. */
  nextAction: string | null;
  terminal: boolean;
  availableActions: string[];
}

const PROVIDER_COPY: Record<BookingState, { label: string; nextAction: string | null }> = {
  PENDING_OTP: { label: 'Not yet confirmed', nextAction: null },
  AWAITING_ASSIGNMENT: { label: 'Unassigned', nextAction: null },
  ASSIGNED: { label: 'Awaiting your response', nextAction: 'accept' },
  ACCEPTED: { label: 'Accepted', nextAction: 'markEnRoute' },
  EN_ROUTE: { label: 'On the way', nextAction: 'markArrived' },
  ARRIVED: { label: 'Arrived', nextAction: 'startJob' },
  IN_PROGRESS: { label: 'In progress', nextAction: 'complete' },
  COMPLETED: { label: 'Completed', nextAction: null },
  CANCELLED: { label: 'Cancelled', nextAction: null },
  DISPUTED: { label: 'Under review', nextAction: null },
  EXPIRED: { label: 'Expired', nextAction: null },
};

export function toProviderProjection(state: BookingState): ProviderBookingStateDto {
  const copy = PROVIDER_COPY[state];
  const actions = allowedActions(state, 'assigned_provider');
  return {
    canonicalState: state,
    label: copy.label,
    // Only offer a next action the machine actually permits — otherwise the app
    // shows a button whose request the backend will refuse.
    nextAction: copy.nextAction && actions.includes(copy.nextAction) ? copy.nextAction : null,
    terminal: isTerminal(state),
    availableActions: actions,
  };
}

// ─── One entry point ──────────────────────────────────────────────────────────

export function project(state: BookingState, actor: Actor) {
  switch (actor) {
    case 'admin':
      return toAdminProjection(state);
    case 'customer':
      return toCustomerProjection(state);
    case 'assigned_provider':
      return toProviderProjection(state);
    case 'system':
      return toAdminProjection(state);
    default: {
      const unreachable: never = actor;
      throw new Error(`No projection for actor ${String(unreachable)}`);
    }
  }
}
