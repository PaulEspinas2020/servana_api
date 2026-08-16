/**
 * Booking lifecycle actions → canonical domain events.
 *
 * ## Why this is a table and not a switch inside the executor
 *
 * `transitionExecutor` is the single writer of booking lifecycle state and has
 * one job. Teaching it what a notification is would put product vocabulary
 * inside a state machine, and the next person adding an action would have to
 * know about both. It publishes a fact; this table says which fact.
 *
 * The mapping is deliberately PARTIAL. Most actions produce no event: an
 * EN_ROUTE or ARRIVED transition is already carried by the tracking surface a
 * customer is watching, and a notification for every state change is how an app
 * teaches people to turn notifications off. Only the moments somebody who is not
 * looking at the screen needs to be told about are here.
 *
 * ## `ADMIN_REASSIGN` is BookingAssigned
 *
 * The new provider is being assigned; from their seat nothing distinguishes it
 * from a first assignment. The outgoing provider's removal is a different fact
 * with a different audience, and `adminBookingService` already notifies them
 * with `assignment_removed_{bookingId}_{providerUid}` — kept, not duplicated
 * here.
 */

import type { PoolClient } from 'pg';
import { publishEvent } from './eventOutbox';
import type { DomainEventName, EntityRef } from './domainEvents';

/**
 * The action → event map. An action that is absent publishes nothing, and that
 * is a decision rather than an omission — see the note above.
 */
export const ACTION_EVENTS: Readonly<Record<string, DomainEventName>> = Object.freeze({
  ADMIN_ASSIGN: 'BookingAssigned',
  AUTO_ASSIGN: 'BookingAssigned',
  ADMIN_REASSIGN: 'BookingAssigned',
  PROVIDER_ACCEPT: 'ProviderAccepted',
  PROVIDER_START: 'JobStarted',
  PROVIDER_COMPLETE: 'JobCompleted',
  ADMIN_APPROVE_COMPLETION: 'JobCompleted',
  CUSTOMER_CANCEL: 'BookingCancelled',
  PROVIDER_CANCEL: 'BookingCancelled',
  ADMIN_CANCEL: 'BookingCancelled',
});

/**
 * Actions that deliberately publish nothing, and why.
 *
 * ## Why silence has to be declared rather than implied
 *
 * The partial mapping above is a good decision badly recorded. "Most actions
 * produce no event" is prose: it names none of them, so the silent set was
 * whatever `BOOKING_ACTIONS` minus `ACTION_EVENTS` happened to be on any given
 * day. Nothing asserted the two sets partitioned the canonical actions, which
 * means a new action joins the silent set by default — the notification decision
 * gets made by forgetting rather than by choosing — and deleting a mapping entry
 * fails nothing.
 *
 * With both halves declared, `tests/notification-event-contract.test.ts` asserts
 * they are disjoint and together cover `BOOKING_ACTIONS` exactly. Adding an
 * action then fails the build until somebody writes down which half it is in.
 * That is the whole point: the build asks the question, rather than answering it
 * silently.
 */
export const SILENT_ACTIONS: Readonly<Record<string, string>> = Object.freeze({
  CUSTOMER_CONFIRM_OTP:
    'The customer is holding the phone that just produced the code. Telling them ' +
    'they did the thing they are currently doing is noise.',
  PROVIDER_DECLINE:
    'Returns the booking to AWAITING_ASSIGNMENT, and the customer-visible fact is ' +
    'the NEXT assignment, not this refusal. Surfacing a decline would also expose ' +
    'one provider\'s choice to the customer, which is a matching detail rather ' +
    'than a booking fact.',
  PROVIDER_EN_ROUTE:
    'Carried by the tracking surface the customer is already watching. A push for ' +
    'every movement is how an app teaches people to mute it.',
  PROVIDER_ARRIVED:
    'Same as EN_ROUTE — and by definition somebody is at the door.',
  ADMIN_CONFIRM_ASSIGNMENT:
    'An internal bookkeeping confirmation of an assignment already announced by ' +
    'BookingAssigned. Publishing again would duplicate one fact.',
  SYSTEM_EXPIRE:
    'Not a party acting. Expiry notification is owned by the scheduler that ' +
    'decides a booking is stale, which has the context to say why.',
});

export const eventForAction = (action: string): DomainEventName | null =>
  ACTION_EVENTS[action] ?? null;

export interface BookingEventInput {
  action: string;
  bookingId: number;
  /** The provider on the booking at the moment of the transition, if any. */
  providerUid: string | null;
  actorUid: string | null;
  actorRole: string;
  /** Correlates the event with the transition row that produced it. */
  correlationId: string;
  client?: PoolClient | null;
}

/**
 * Publish the event for a transition, INSIDE the transition's transaction.
 *
 * That is the whole point of the outbox: if the transition rolls back, the
 * event was never written, so nobody is told about a job that does not exist.
 * If it commits, the event is durable and will be projected — now by the
 * dispatcher, or on the next sweep if this process dies first.
 *
 * ## The dedupe key
 *
 * `{action}:{bookingId}:{correlationId}` — the correlation id is minted per
 * transition, so a retried transition (which the executor answers from its
 * idempotency table without reaching here) cannot produce a second event, and
 * two genuinely separate transitions of the same action on the same booking
 * still can. Keying on action+booking alone would silently drop the second
 * cancellation of a rebooked job.
 */
export const publishBookingEvent = async (input: BookingEventInput): Promise<void> => {
  const name = eventForAction(input.action);
  if (!name) return;

  const refs: Partial<Record<EntityRef, string | number>> = { bookingId: input.bookingId };
  if (input.providerUid) refs.providerUid = input.providerUid;

  await publishEvent({
    name,
    refs,
    display: { bookingCode: `SVN-${String(input.bookingId).padStart(6, '0')}` },
    metadata: {
      action: input.action,
      actorRole: input.actorRole,
      // Who acted, so the projector can avoid telling somebody what they just
      // did themselves. Diagnostic everywhere else; load-bearing there.
      actorUid: input.actorUid,
      correlationId: input.correlationId,
    },
    dedupeKey: `${input.action}:${input.bookingId}:${input.correlationId}`,
    client: input.client ?? null,
  });
};
