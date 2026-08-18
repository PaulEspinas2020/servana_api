/**
 * Event → notifications. The only thing that makes this conversion.
 *
 * ## What "event-driven, not controller-specific duplicates" means here
 *
 * Thirty-two call sites used to decide, each for themselves, what a fact meant
 * for a person: the title, the body, the severity, the route, and whether the
 * OTHER party was told at all. Nothing connected the notification a provider
 * received about an assignment to the one the customer received about the SAME
 * assignment, so they could disagree, and one could be added without the other.
 *
 * Now the fact is published once and this projects it for every seat, from one
 * declaration. "Admin, customer and provider react to the same source event" is
 * a property of there being one projection function, and
 * `tests/notification-event-contract.test.ts` asserts it by driving one event
 * and comparing the three outputs.
 *
 * ## Why the legacy producers are still running
 *
 * Every projection reuses the EXACT notification key its legacy producer used.
 * The owner-scoped unique index on `(owner_uid, notification_key)` collapses the
 * pair into one row, whichever wins the race. So the event layer became the
 * producer without a flag day, and the legacy call can be deleted per-site,
 * later, once telemetry shows the projector is reaching everyone.
 *
 * That is the expand-migrate-contract pattern the command mandates, and the
 * dedup is asserted in `tests/notification-dedup.test.ts` rather than assumed.
 *
 * ## Recipients are resolved from the SOURCE OF TRUTH, never from the payload
 *
 * A projection that trusted `event.refs.customerUid` for who to tell would let
 * a producer with a stale reference notify the wrong person. The customer is
 * read from `bookings.user_id` and the provider from the active assignment, at
 * projection time, by the same queries the authorization layer uses.
 */

import dbQuery from '../../db/dbQuery';
import { db } from '../../config';
import {
  createCustomerNotification,
  createNotification,
} from '../notification.service';
import { notifyAdminsSafely } from '../adminNotificationService';
import { isProviderRole } from '../../constants/providerRoles';
import { ACTIVE_WORKER_STATUSES } from '../../chat/chat.repository';
import {
  DOMAIN_EVENTS,
  projectEvent,
  type DomainEventEnvelope,
  type NotificationProjection,
  type RecipientSeat,
} from './domainEvents';
import { claimPending, markDispatched, markFailed } from './eventOutbox';
import { recordEventSignal } from './eventTelemetry';

const s = db.schema;

// ─── Recipient resolution ─────────────────────────────────────────────────────

/**
 * The customer on a booking. `bookings.user_id`, the same column
 * `chat.repository.getBookingClientUid` reads.
 */
const customerOfBooking = async (bookingId: unknown): Promise<string | null> => {
  const id = Number(bookingId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const { rows } = await dbQuery.query(
    `SELECT user_id FROM ${s}.bookings WHERE id = $1`,
    [id],
  );
  return rows[0]?.user_id ? String(rows[0].user_id) : null;
};

/**
 * Providers whose assignment is ACTIVE on a booking.
 *
 * Same status list `chat.repository.ACTIVE_WORKER_STATUSES` authorizes chat
 * from, so a provider who was reassigned away cannot be notified about a
 * booking they can no longer open — which would be a notification pointing at a
 * screen that will refuse them.
 */
const providersOfBooking = async (bookingId: unknown): Promise<string[]> => {
  const id = Number(bookingId);
  if (!Number.isSafeInteger(id) || id <= 0) return [];
  const { rows } = await dbQuery.query(
    `SELECT worker_uid FROM ${s}.booking_workers
      WHERE booking_id = $1
        AND status = ANY($2::text[])`,
    // IMPORTED, not restated. The list already exists in one place with the
    // history of why EN_ROUTE and ARRIVED belong in it, and a second copy here
    // would be a third derivation of the worker lifecycle — which
    // `tests/booking-single-derivation.test.ts` exists to prevent, and which it
    // caught on the first full run of this tab.
    [id, ACTIVE_WORKER_STATUSES as unknown as string[]],
  );
  const uids = rows.map((r: any) => String(r.worker_uid ?? '')).filter(Boolean) as string[];
  return [...new Set(uids)];
};

/**
 * Who receives this projection.
 *
 * The event's own refs are used only where they name the SUBJECT of the fact —
 * `providerUid` on an assignment IS the provider being assigned, and reading
 * the table instead would race the transaction that just wrote it. Everything
 * else is resolved from the source of truth.
 */
export const resolveRecipients = async (
  event: DomainEventEnvelope,
  seat: RecipientSeat,
): Promise<string[]> => {
  if (seat === 'admin') return [];

  const refs = event.refs;

  if (seat === 'provider') {
    if (refs.providerUid) return [String(refs.providerUid)];
    if (refs.bookingId) return providersOfBooking(refs.bookingId);
    return [];
  }

  // customer
  if (refs.bookingId) {
    const owner = await customerOfBooking(refs.bookingId);
    if (owner) return [owner];
  }
  return refs.customerUid ? [String(refs.customerUid)] : [];
};

/**
 * The sender is excluded from their own event.
 *
 * A person who sent a message, cancelled their own booking or left a review does
 * not need to be told they did it. `metadata.actorUid` carries who acted; it is
 * diagnostic everywhere else and load-bearing exactly here.
 */
const actorOf = (event: DomainEventEnvelope): string | null => {
  const actor = event.metadata?.actorUid;
  return typeof actor === 'string' && actor ? actor : null;
};

// ─── Writing ──────────────────────────────────────────────────────────────────

/**
 * A seat tells us which STORE to write, and the account's role tells us whether
 * that seat is right for them.
 *
 * Checked rather than assumed: a projection that wrote a provider-seat
 * notification into `customer_notifications` would be invisible to the person
 * it was for, and the failure would be silent in both directions.
 */
const roleOf = async (uid: string): Promise<number | null> => {
  const { rows } = await dbQuery.query(
    `SELECT role::int AS role FROM ${s}.user_credentials WHERE uid = $1`,
    [uid],
  );
  return rows.length ? Number(rows[0].role) : null;
};

export interface DeliveryOutcome {
  seat: RecipientSeat;
  uid: string;
  notificationKey: string;
  /** False when the key already existed — the deduplication working. */
  created: boolean;
}

const writeOne = async (
  projection: NotificationProjection,
  uid: string,
): Promise<DeliveryOutcome> => {
  const payload = {
    notificationKey: projection.notificationKey,
    type: projection.type,
    severity: projection.severity,
    title: projection.title,
    safeBody: projection.body,
    safeContextLabel: projection.contextLabel,
    route: projection.route,
    canOpenDetail: projection.canOpenDetail,
  };

  const role = await roleOf(uid);
  const written =
    projection.seat === 'provider' || isProviderRole(role)
      ? await createNotification(uid, payload)
      : await createCustomerNotification(uid, payload);

  // `createNotification` returns null when the owner-scoped unique index
  // refused the insert — which is the legacy producer having already written
  // this exact notification, or a redelivery of the same event.
  if (written === null) recordEventSignal('NOTIFICATION_DEDUPED', projection.type);

  return {
    seat: projection.seat,
    uid,
    notificationKey: projection.notificationKey,
    created: written !== null,
  };
};

/**
 * Project one event into every notification it owes.
 *
 * Never throws for a single recipient's failure: one unreachable account must
 * not stop the other seats being told, and it must not leave the outbox row
 * pending forever. Failures are counted and the row still completes — the
 * notification key means a later replay is safe if an operator wants one.
 */
export const projectAndDeliver = async (
  event: DomainEventEnvelope,
): Promise<DeliveryOutcome[]> => {
  const projections = projectEvent(event);
  if (!projections.length) return [];

  const actor = actorOf(event);
  const outcomes: DeliveryOutcome[] = [];
  const seen = new Set<string>();

  for (const projection of projections) {
    let recipients: string[] = [];
    try {
      recipients = await resolveRecipients(event, projection.seat);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`[events] recipient resolution failed for ${event.name}:`, (error as Error)?.message);
      continue;
    }

    for (const uid of recipients) {
      if (!uid || uid === actor) continue;
      // One account can occupy two seats on one booking in test and fixture
      // data. Writing twice would be two rows with two different keys, which is
      // precisely the duplicate this design exists to prevent.
      const dedupe = `${uid}:${projection.notificationKey}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);

      try {
        outcomes.push(await writeOne(projection, uid));
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(`[events] delivery failed ${event.name} -> ${projection.seat}:`, (error as Error)?.message);
      }
    }
  }

  /**
   * Admin fan-out is a separate path on purpose.
   *
   * `notifyAllAdmins` writes one row per active admin from a single INSERT …
   * SELECT, keyed on `(admin_uid, notification_key)`. Routing it through the
   * per-recipient loop would mean resolving the admin list here and duplicating
   * a fan-out that is already idempotent.
   */
  const spec = DOMAIN_EVENTS[event.name];
  if (spec?.recipients.some((r) => r.seat === 'admin')) {
    notifyAdminsSafely({
      type: `event_${event.name}`.toLowerCase().slice(0, 80),
      severity: 'info',
      title: event.name,
      body: `Domain event ${event.name} for ${event.display.bookingCode ?? 'a booking'}.`,
      bookingId: event.refs.bookingId ? Number(event.refs.bookingId) : null,
      conversationId: event.refs.conversationId ? Number(event.refs.conversationId) : null,
      notificationKey: `evt:${event.id ?? 0}:${event.name}`.slice(0, 160),
    });
  }

  return outcomes;
};

// ─── The dispatcher ───────────────────────────────────────────────────────────

export interface DispatchSummary {
  claimed: number;
  dispatched: number;
  failed: number;
  delivered: number;
  deduped: number;
}

/**
 * Drain the outbox.
 *
 * Called after a publish (so the common case is immediate), from the scheduler
 * (so a crash between commit and dispatch heals), and by tests. All three are
 * the same function because a dispatcher with a "fast path" and a "recovery
 * path" is two implementations of the same delivery rule.
 */
export const dispatchPending = async (limit = 50): Promise<DispatchSummary> => {
  const events = await claimPending(limit);
  const summary: DispatchSummary = {
    claimed: events.length,
    dispatched: 0,
    failed: 0,
    delivered: 0,
    deduped: 0,
  };

  for (const event of events) {
    try {
      const outcomes = await projectAndDeliver(event);
      summary.delivered += outcomes.filter((o) => o.created).length;
      summary.deduped += outcomes.filter((o) => !o.created).length;
      if (event.id !== null) await markDispatched(event.id);
      summary.dispatched += 1;
    } catch (error) {
      summary.failed += 1;
      if (event.id !== null) {
        // `attempts` was already incremented by the claim, so the ceiling is
        // counted from the claim rather than from a second read that could
        // race another dispatcher.
        await markFailed(event.id, error, Number((event as { attempts?: number }).attempts ?? 1));
      }
    }
  }

  return summary;
};

/**
 * Publish-then-dispatch, as one call, never awaited by the producer.
 *
 * §45: a committed fact must not be undone because its announcement failed. The
 * outbox row is already durable at this point, so the worst case of a failure
 * here is that the notification is sent by the next sweep instead of now.
 */
export const dispatchSoon = (limit = 50): void => {
  void dispatchPending(limit).catch((error) => {
    // eslint-disable-next-line no-console
    console.error('[events] dispatch failed:', (error as Error)?.message);
  });
};
