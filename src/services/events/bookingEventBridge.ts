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
