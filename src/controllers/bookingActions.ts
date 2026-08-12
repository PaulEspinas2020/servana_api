/**
 * What the provider may do with a booking — now an ADAPTER, not a decision.
 *
 * Command 18 §5. The client must not infer actions from status labels; this is
 * the authoritative answer instead. What changed in TAB 05 is where the answer
 * comes from.
 *
 * ## This used to be the fifth derivation of booking state
 *
 * It was a `switch` over the raw `booking_workers.status` string, holding its
 * own private opinion about which actions each stage allows. TAB 04 reduced
 * lifecycle derivations to one and the Admin work removed a third that had hidden
 * in SQL; this was the next one along, pinned to the machine by an agreement
 * test rather than derived from it. An agreement test only proves the two match
 * for the cases somebody enumerated — a state added to the machine fell through
 * to the read-only default here, and the provider silently lost the ability to
 * act on it.
 *
 * The decision now lives in `services/booking/providerActions`, generated from
 * the transition whitelist. This file is the legacy entry point, kept because
 * one caller still has only a worker status to hand.
 *
 * ## Why the signature survives
 *
 * `providerController` returns an action set after an arrival-stage transition,
 * where the worker status is what the transition produced and the booking row
 * has not been re-read. Deriving from that single column is exactly what
 * `deriveCanonicalState` does when the booking status is unknown, so the adapter
 * is honest rather than a shim: it asks the machine the narrower question it
 * can actually answer.
 *
 * The job card does NOT come through here. It has both columns and derives the
 * full canonical state, which is strictly better — see `jobCardView`.
 */

import { deriveCanonicalState } from '../services/booking/canonicalState';
import {
  providerActionsForState,
  type BookingAction,
  type BookingActionCode,
} from '../services/booking/providerActions';

export type { BookingAction, BookingActionCode };

/**
 * The provider's actions, given only a worker-lifecycle status.
 *
 * Delegates. There is no switch here any more, and no second opinion about what
 * a status means.
 */
export function actionsForWorkerStatus(
  rawStatus: string | null | undefined,
): BookingAction[] {
  const state = deriveCanonicalState({
    bookingStatus: null,
    workerStatus: rawStatus ?? null,
    // Deliberately absent. A caller holding only a worker status cannot say
    // whether a provider is on the booking or whether a dispute is open, and
    // guessing either would answer a question it was not asked.
    workerUid: undefined,
    hasEscalation: false,
  });
  return providerActionsForState(state);
}
