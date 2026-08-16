/**
 * No duplicate notification for one idempotent event, and the unread count
 * reconciles.
 *
 * ## Why this is the load-bearing suite of the tab
 *
 * The migration strategy is: publish the event BESIDE the legacy producer that
 * already writes the notification, with the projection reusing that producer's
 * EXACT key, and let the owner-scoped unique index collapse the pair into one
 * row. That is the whole reason the event layer could become the producer
 * without a flag day — and it is only true if the keys really match and the
 * index really refuses the second write.
 *
 * So this suite runs BOTH producers, in both orders, and counts rows.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' }, tempId: undefined }));
jest.mock('../src/db/dbQuery', () => {
  const fake = require('./support/eventDbFake');
  return { __esModule: true, default: fake.dbQueryFake, pool: { connect: jest.fn() } };
});
jest.mock('../src/provider.realtime', () => ({ emitToProvider: jest.fn() }));
jest.mock('../src/services/adminCommunicationService', () => ({
  logCommunicationEvent: jest.fn().mockResolvedValue(undefined),
}));

import * as fake from './support/eventDbFake';
import { publishEvent, __resetOutboxSchema } from '../src/services/events/eventOutbox';
import { dispatchPending } from '../src/services/events/notificationProjector';
import { __resetEventTelemetry, snapshot } from '../src/services/events/eventTelemetry';
import * as inbox from '../src/services/events/notificationInbox';
import {
  createCustomerNotification,
  createNotification,
} from '../src/services/notification.service';

const CUSTOMER = 'customer-1';
const PROVIDER = 'provider-1';
const BOOKING = 75;

const seed = () => {
  fake.reset();
  __resetOutboxSchema();
  __resetEventTelemetry();
  fake.seedUser(CUSTOMER, 3);
  fake.seedUser(PROVIDER, 2);
  fake.seedBooking(BOOKING, CUSTOMER);
  fake.seedAssignment(BOOKING, PROVIDER, 'ACCEPTED');
};

beforeEach(seed);

const publishAssigned = async () => {
  await publishEvent({
    name: 'BookingAssigned',
    refs: { bookingId: BOOKING, providerUid: PROVIDER },
    display: { bookingCode: 'SVN-000075' },
    dedupeKey: `BookingAssigned:${BOOKING}`,
  });
  return dispatchPending();
};

/** Exactly what `technicianService` writes today, key included. */
const legacyProviderAssignNotification = () =>
  createNotification(PROVIDER, {
    notificationKey: `assigned_job_${BOOKING}_${PROVIDER}`,
    type: 'assigned_job',
    severity: 'high',
    title: 'New Job Assigned',
    safeBody: `You have a new job for booking SVN-000075.`,
    safeContextLabel: 'SVN-000075',
    route: { page: 'jobs', bookingId: String(BOOKING) },
    canOpenDetail: true,
  });

/** Exactly what `technicianService` writes for the customer today. */
const legacyCustomerAssignNotification = () =>
  createCustomerNotification(CUSTOMER, {
    notificationKey: `provider_assigned_${BOOKING}`,
    type: 'provider_assigned',
    severity: 'info',
    title: 'Provider assigned',
    safeBody: 'A provider has been assigned.',
    route: { routeKey: 'BOOKING_DETAILS', resourceId: String(BOOKING) },
    canOpenDetail: true,
  });

// ─── The migration guarantee ──────────────────────────────────────────────────

describe('the legacy producer and the projector collapse onto one notification', () => {
  it('legacy first, then the event: ONE row', async () => {
    await legacyProviderAssignNotification();
    await legacyCustomerAssignNotification();
    await publishAssigned();

    expect(fake.notificationsFor(PROVIDER)).toHaveLength(1);
    expect(fake.notificationsFor(CUSTOMER)).toHaveLength(1);
  });

  it('the event first, then legacy: ONE row', async () => {
    await publishAssigned();
    await legacyProviderAssignNotification();
    await legacyCustomerAssignNotification();

    expect(fake.notificationsFor(PROVIDER)).toHaveLength(1);
    expect(fake.notificationsFor(CUSTOMER)).toHaveLength(1);
  });

  it('the suppression is COUNTED, so the migration is measurable', async () => {
    await legacyProviderAssignNotification();
    await legacyCustomerAssignNotification();
    await publishAssigned();

    const counts = snapshot().counts;
    // Two projections found their key already taken. Once the legacy producers
    // are retired this rate should fall to zero, and a non-zero rate then means
    // genuine redelivery — which is why it is a counter and not a log line.
    expect(counts['NOTIFICATION_DEDUPED:assigned_job']).toBe(1);
    expect(counts['NOTIFICATION_DEDUPED:provider_assigned']).toBe(1);
  });

  it('the keys really are identical — asserted against the projection, not by hand', async () => {
    await publishAssigned();
    const projected = fake.notificationsFor(PROVIDER)[0].notification_key;
    // The literal the legacy producer uses. If either side is edited without
    // the other, this fails rather than silently producing two notifications.
    expect(projected).toBe(`assigned_job_${BOOKING}_${PROVIDER}`);
  });
});

// ─── Event-level idempotency ──────────────────────────────────────────────────

describe('one fact, one event, one notification', () => {
  it('a re-published event with the same dedupe key does not add a second event', async () => {
    await publishAssigned();
    await publishAssigned();
    expect(fake.store.outbox.filter((e) => e.event_name === 'BookingAssigned')).toHaveLength(1);
  });

  it('a re-DISPATCHED event writes no second notification', async () => {
    await publishAssigned();
    // Force the row back to pending, as an operator retrying a FAILED row would.
    fake.store.outbox.forEach((e) => { e.status = 'PENDING'; });
    await dispatchPending();

    expect(fake.notificationsFor(PROVIDER)).toHaveLength(1);
    expect(fake.notificationsFor(CUSTOMER)).toHaveLength(1);
  });

  it('two DIFFERENT facts of the same kind both get through', async () => {
    // Keying on the event name alone would silently drop the second
    // cancellation of a rebooked job.
    fake.seedBooking(76, CUSTOMER);
    fake.seedAssignment(76, PROVIDER, 'ACCEPTED');

    await publishAssigned();
    await publishEvent({
      name: 'BookingAssigned',
      refs: { bookingId: 76, providerUid: PROVIDER },
      display: { bookingCode: 'SVN-000076' },
      dedupeKey: 'BookingAssigned:76',
    });
    await dispatchPending();

    expect(fake.notificationsFor(PROVIDER)).toHaveLength(2);
  });
});

// ─── Unread reconciliation ────────────────────────────────────────────────────

describe('unread reconciles across the inbox', () => {
  const providerActor = { uid: PROVIDER, role: 2 };
  const customerActor = { uid: CUSTOMER, role: 3 };

  it('the count matches the number of unread rows the list returns', async () => {
    await publishAssigned();
    await publishEvent({
      name: 'JobStarted',
      refs: { bookingId: BOOKING, providerUid: PROVIDER },
      display: { bookingCode: 'SVN-000075' },
    });
    await dispatchPending();

    for (const actor of [providerActor, customerActor]) {
      const list = await inbox.listNotifications(actor);
      const count = await inbox.countUnread(actor);
      expect(count).toBe(list.filter((n) => !n.isRead).length);
    }
  });

  it('marking one read returns the count AFTER the mutation', async () => {
    await publishAssigned();
    await publishEvent({
      name: 'JobStarted',
      refs: { bookingId: BOOKING, providerUid: PROVIDER },
      display: { bookingCode: 'SVN-000075' },
    });
    await dispatchPending();

    const before = await inbox.countUnread(customerActor);
    expect(before).toBe(2);

    const list = await inbox.listNotifications(customerActor);
    const result = await inbox.markRead(customerActor, list[0].notificationKey);

    expect(result.changed).toBe(true);
    // The whole point: a client never has to re-fetch to learn its badge, or
    // decrement a number it guessed.
    expect(result.unreadCount).toBe(1);
    expect(await inbox.countUnread(customerActor)).toBe(1);
  });

  it('marking all read reconciles to zero, recounted rather than assumed', async () => {
    await publishAssigned();
    await dispatchPending();

    const result = await inbox.markAllRead(providerActor);
    expect(result.unreadCount).toBe(0);
    expect(await inbox.countUnread(providerActor)).toBe(0);
  });

  it('marking read twice is a no-op, not an error', async () => {
    await publishAssigned();
    const list = await inbox.listNotifications(providerActor);
    const key = list[0].notificationKey;

    const first = await inbox.markRead(providerActor, key);
    const second = await inbox.markRead(providerActor, key);

    expect(first.found).toBe(true);
    expect(second.found).toBe(true);
    expect(second.allowed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.unreadCount).toBe(0);
  });

  it('one account cannot mark another account\'s notification read', async () => {
    await publishAssigned();
    const providerList = await inbox.listNotifications(providerActor);
    const providerKey = providerList[0].notificationKey;

    // The same key string, presented by the customer. Every statement is
    // predicated on the owner uid from the token, so it resolves to nothing.
    const result = await inbox.markRead(customerActor, providerKey);
    expect(result.found).toBe(false);
    expect(fake.notificationsFor(PROVIDER)[0].status).toBe('unread');
  });
});

// ─── The inbox defect this tab closed ─────────────────────────────────────────

describe('the canonical inbox serves every seat', () => {
  it('a PROVIDER gets their notifications — the defect was an empty list', async () => {
    await publishAssigned();

    // Before TAB 09 the canonical endpoint read `customer_notifications` only,
    // so this returned [] while the rows sat in `provider_notifications`.
    const list = await inbox.listNotifications({ uid: PROVIDER, role: 2 });
    expect(list).toHaveLength(1);
    expect(list[0].type).toBe('assigned_job');
  });

  it('role 4 is a provider too', async () => {
    // `role = 2` has been written as the provider check more than once and is
    // wrong; 4 is a provider role as well. Driven through an event that resolves
    // providers FROM THE BOOKING, so the assignment is what selects them rather
    // than a uid named in the payload.
    fake.seedUser('provider-4', 4);
    fake.seedAssignment(BOOKING, 'provider-4', 'ACCEPTED');

    await publishEvent({
      name: 'BookingCancelled',
      refs: { bookingId: BOOKING },
      display: { bookingCode: 'SVN-000075' },
    });
    await dispatchPending();

    expect(inbox.storeForRole(4)).toBe('provider');
    const list = await inbox.listNotifications({ uid: 'provider-4', role: 4 });
    expect(list.length).toBeGreaterThan(0);
  });

  it('resolves the store from the role, and an unknown role is a customer', () => {
    expect(inbox.storeForRole(1)).toBe('admin');
    expect(inbox.storeForRole(0)).toBe('admin');
    expect(inbox.storeForRole(2)).toBe('provider');
    expect(inbox.storeForRole(3)).toBe('customer');
    // Least privilege: an unknown account is not staff and is not a provider.
    expect(inbox.storeForRole(undefined)).toBe('customer');
    expect(inbox.storeForRole('nonsense')).toBe('customer');
  });

  it('publishes the canonical deep-link target alongside the legacy route', async () => {
    await publishAssigned();
    const [providerRow] = await inbox.listNotifications({ uid: PROVIDER, role: 2 });
    const [customerRow] = await inbox.listNotifications({ uid: CUSTOMER, role: 3 });

    expect(providerRow.target).toBe('JOB_DETAIL');
    expect(customerRow.target).toBe('BOOKING_DETAIL');
    // ...and the vocabularies the shipped clients already parse are untouched.
    expect((providerRow.route as any).page).toBe('jobs');
    expect((customerRow.route as any).routeKey).toBe('BOOKING_DETAILS');
  });
});
