/**
 * One event, three reactions (§99).
 *
 * ## The release gate this encodes
 *
 * "Admin, customer and provider projections react to the same source event."
 * That is not something you can read off a route table — it is a claim about
 * what happens when one fact occurs, and the only way to know is to make the
 * fact occur and look at all three inboxes.
 *
 * So every case here PUBLISHES a real event through the real outbox, DISPATCHES
 * it through the real projector, and then reads the notifications that landed.
 * Nothing is stubbed at the service level, and the fake database enforces the
 * unique indexes the whole design rests on.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' }, tempId: undefined }));
jest.mock('../src/db/dbQuery', () => {
  const fake = require('./support/eventDbFake');
  return { __esModule: true, default: fake.dbQueryFake, pool: { connect: jest.fn() } };
});
// The realtime and push side-effects of `createNotification`. The RECORD is the
// subject here; the interruption has its own suite.
jest.mock('../src/provider.realtime', () => ({ emitToProvider: jest.fn() }));
jest.mock('../src/services/adminCommunicationService', () => ({
  logCommunicationEvent: jest.fn().mockResolvedValue(undefined),
}));

import * as fake from './support/eventDbFake';
import { publishEvent, __resetOutboxSchema, backlog } from '../src/services/events/eventOutbox';
import { dispatchPending } from '../src/services/events/notificationProjector';
import { __resetEventTelemetry, snapshot } from '../src/services/events/eventTelemetry';
import {
  DOMAIN_EVENT_NAMES,
  projectEvent,
  type DomainEventEnvelope,
} from '../src/services/events/domainEvents';

const CUSTOMER = 'customer-1';
const PROVIDER = 'provider-1';
const ADMIN = 'admin-1';
const BOOKING = 75;

const seed = () => {
  fake.reset();
  __resetOutboxSchema();
  __resetEventTelemetry();
  fake.seedUser(CUSTOMER, 3);
  fake.seedUser(PROVIDER, 2);
  fake.seedUser(ADMIN, 1);
  fake.seedBooking(BOOKING, CUSTOMER);
  fake.seedAssignment(BOOKING, PROVIDER, 'ACCEPTED');
};

beforeEach(seed);

const publishAndDispatch = async (input: Parameters<typeof publishEvent>[0]) => {
  await publishEvent(input);
  return dispatchPending();
};

// ─── One event reaches every seat ─────────────────────────────────────────────

describe('one source event, every seat', () => {
  it('BookingAssigned notifies the provider AND the customer, from one publish', async () => {
    await publishAndDispatch({
      name: 'BookingAssigned',
      refs: { bookingId: BOOKING, providerUid: PROVIDER },
      display: { bookingCode: 'SVN-000075' },
      dedupeKey: 'BookingAssigned:75',
    });

    const toProvider = fake.notificationsFor(PROVIDER);
    const toCustomer = fake.notificationsFor(CUSTOMER);

    expect(toProvider).toHaveLength(1);
    expect(toCustomer).toHaveLength(1);
    // Different words for different seats, one fact behind both.
    expect(toProvider[0].type).toBe('assigned_job');
    expect(toCustomer[0].type).toBe('provider_assigned');
    expect(toProvider[0].notification_key).toBe(`assigned_job_${BOOKING}_${PROVIDER}`);
    expect(toCustomer[0].notification_key).toBe(`provider_assigned_${BOOKING}`);
  });

  it('the provider notification lands in the PROVIDER store, not the customer one', async () => {
    // The failure this catches is silent in both directions: a provider-seat
    // notification written into `customer_notifications` is invisible to the
    // person it was for and invisible to the person who owns that table.
    await publishAndDispatch({
      name: 'BookingAssigned',
      refs: { bookingId: BOOKING, providerUid: PROVIDER },
      display: { bookingCode: 'SVN-000075' },
    });
    expect(fake.store.providerNotifications.map((n) => n.worker_uid)).toEqual([PROVIDER]);
    expect(fake.store.customerNotifications.map((n) => n.user_uid)).toEqual([CUSTOMER]);
  });

  it('JobCompleted tells both parties, with a different deep link each', async () => {
    await publishAndDispatch({
      name: 'JobCompleted',
      refs: { bookingId: BOOKING, providerUid: PROVIDER },
      display: { bookingCode: 'SVN-000075' },
    });

    const provider = fake.notificationsFor(PROVIDER)[0];
    const customer = fake.notificationsFor(CUSTOMER)[0];
    // The provider is sent to earnings; the customer to the booking. Same fact,
    // different thing each of them needs to do about it.
    expect((provider.route as any).page).toBe('earnings');
    expect((customer.route as any).routeKey).toBe('BOOKING_DETAILS');
  });

  it('the ADMIN fan-out is keyed on the event, so a redispatch adds nothing', async () => {
    await publishAndDispatch({
      name: 'BookingCreated',
      refs: { bookingId: BOOKING, customerUid: CUSTOMER },
      display: { bookingCode: 'SVN-000075' },
      dedupeKey: 'BookingCreated:75',
    });
    const first = fake.store.adminNotifications.length;
    expect(first).toBe(1);

    // Re-publishing the same fact is refused by the outbox dedupe, and
    // re-dispatching writes nothing because the admin key is derived from the
    // event id.
    await publishAndDispatch({
      name: 'BookingCreated',
      refs: { bookingId: BOOKING, customerUid: CUSTOMER },
      display: { bookingCode: 'SVN-000075' },
      dedupeKey: 'BookingCreated:75',
    });
    expect(fake.store.adminNotifications).toHaveLength(first);
  });
});

// ─── Recipients come from the source of truth ────────────────────────────────

describe('recipients are resolved from the booking, never from the payload', () => {
  it('ignores a customerUid in the payload that disagrees with the booking', async () => {
    fake.seedUser('someone-else', 3);
    await publishAndDispatch({
      name: 'JobStarted',
      // A stale reference a producer might carry. The booking says otherwise.
      refs: { bookingId: BOOKING, providerUid: PROVIDER, customerUid: 'someone-else' },
      display: { bookingCode: 'SVN-000075' },
    });

    expect(fake.notificationsFor(CUSTOMER)).toHaveLength(1);
    expect(fake.notificationsFor('someone-else')).toHaveLength(0);
  });

  it('does NOT notify a provider whose assignment ended', async () => {
    // A notification pointing at a screen that will refuse them is worse than
    // no notification. `providersOfBooking` uses the same ACTIVE status list
    // that authorizes chat.
    fake.reset();
    __resetOutboxSchema();
    fake.seedUser(CUSTOMER, 3);
    fake.seedUser(PROVIDER, 2);
    fake.seedBooking(BOOKING, CUSTOMER);
    fake.seedAssignment(BOOKING, PROVIDER, 'DECLINED');

    await publishAndDispatch({
      name: 'BookingCancelled',
      refs: { bookingId: BOOKING },
      display: { bookingCode: 'SVN-000075' },
    });

    expect(fake.notificationsFor(PROVIDER)).toHaveLength(0);
    expect(fake.notificationsFor(CUSTOMER)).toHaveLength(1);
  });

  it('does not tell the actor what they just did', async () => {
    await publishAndDispatch({
      name: 'BookingCancelled',
      refs: { bookingId: BOOKING },
      display: { bookingCode: 'SVN-000075' },
      metadata: { actorUid: CUSTOMER },
    });

    expect(fake.notificationsFor(CUSTOMER)).toHaveLength(0);
    expect(fake.notificationsFor(PROVIDER)).toHaveLength(1);
  });
});

// ─── Canonical ids and payload hygiene ───────────────────────────────────────

describe('the publisher refuses a payload that would break the contract', () => {
  it('refuses an undeclared event name', async () => {
    await expect(
      publishEvent({ name: 'BookingVanished' as never, refs: { bookingId: BOOKING } }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_EVENT' });
  });

  it('refuses a missing required canonical id', async () => {
    await expect(
      publishEvent({ name: 'BookingAssigned', refs: { bookingId: BOOKING } }),
    ).rejects.toMatchObject({ code: 'MISSING_REF' });
  });

  it('REFUSES a legacy service-family id rather than silently dropping it', async () => {
    // Catalog V2 is certified with services.id as the canonical specific-service
    // identity. A silently-stripped ref is a producer that thinks it sent
    // something, which is how the family id would creep back in.
    await expect(
      publishEvent({
        name: 'BookingCreated',
        refs: { bookingId: BOOKING, customerUid: CUSTOMER, serviceFamilyId: 4 } as never,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN_REF' });
  });

  it('records the refusal as a signal, not just a throw', async () => {
    await publishEvent({ name: 'Nope' as never, refs: {} }).catch(() => undefined);
    expect(Object.keys(snapshot().counts)).toContain('EVENT_PUBLISH_REJECTED:UNKNOWN_EVENT');
  });

  it('bounds and strips display values before they can reach a lock screen', async () => {
    await publishEvent({
      name: 'BookingCreated',
      refs: { bookingId: BOOKING, customerUid: CUSTOMER },
      display: { bookingCode: 'SVN-000075', huge: 'x'.repeat(500) },
      dedupeKey: 'display-test',
    });
    const row = fake.store.outbox.find((e) => e.dedupe_key === 'display-test')!;
    expect(String((row.display as any).huge)).toHaveLength(120);
  });
});

// ─── Every declared event actually projects ──────────────────────────────────

describe('the registry describes a system that exists', () => {
  /**
   * A registry claiming an event that projects to nothing is the failure mode
   * this whole document-generation approach exists to prevent: nobody notices
   * until a client team builds a screen around it.
   */
  it('every declared event projects at least one notification for a full payload', () => {
    for (const name of DOMAIN_EVENT_NAMES) {
      const event: DomainEventEnvelope = {
        id: 1,
        name,
        version: 1,
        refs: {
          bookingId: 75, serviceId: 15, conversationId: 11, messageId: 4021,
          reviewId: 'rev-1', applicationId: 'app-1', paymentId: 900,
          providerUid: PROVIDER, customerUid: CUSTOMER,
        },
        display: { bookingCode: 'SVN-000075' },
        occurredAt: '2026-08-14T00:00:00.000Z',
      };
      expect(projectEvent(event).length).toBeGreaterThan(0);
    }
  });

  it('DROPS a projection whose template could not be filled', () => {
    // A notification reading "booking {bookingCode}" is worse than none, and its
    // key would be unstable — which would defeat the deduplication the whole
    // design rests on.
    const projections = projectEvent({
      id: 1,
      name: 'BookingAssigned',
      version: 1,
      refs: { bookingId: 75, providerUid: PROVIDER },
      display: {},
      occurredAt: '2026-08-14T00:00:00.000Z',
    });
    expect(projections).toHaveLength(0);
  });

  it('never emits an unsubstituted placeholder in a key or a body', () => {
    for (const name of DOMAIN_EVENT_NAMES) {
      const projections = projectEvent({
        id: 1,
        name,
        version: 1,
        refs: {
          bookingId: 75, serviceId: 15, conversationId: 11, messageId: 4021,
          reviewId: 'rev-1', applicationId: 'app-1', paymentId: 900,
          providerUid: PROVIDER, customerUid: CUSTOMER,
        },
        display: { bookingCode: 'SVN-000075' },
        occurredAt: '2026-08-14T00:00:00.000Z',
      });
      for (const p of projections) {
        expect(p.notificationKey).not.toMatch(/\{\w+\}/);
        expect(p.body).not.toMatch(/\{\w+\}/);
        expect(p.title).not.toMatch(/\{\w+\}/);
      }
    }
  });
});

// ─── The outbox ───────────────────────────────────────────────────────────────

describe('the outbox is durable and drains', () => {
  it('a published event is PENDING until dispatched', async () => {
    await publishEvent({
      name: 'JobStarted',
      refs: { bookingId: BOOKING, providerUid: PROVIDER },
      display: { bookingCode: 'SVN-000075' },
    });
    expect((await backlog()).pending).toBe(1);

    await dispatchPending();
    const after = await backlog();
    expect(after.pending).toBe(0);
    expect(after.failed).toBe(0);
  });

  it('reports what it did, so a backlog is countable', async () => {
    await publishEvent({
      name: 'JobStarted',
      refs: { bookingId: BOOKING, providerUid: PROVIDER },
      display: { bookingCode: 'SVN-000075' },
    });
    const summary = await dispatchPending();
    expect(summary).toMatchObject({ claimed: 1, dispatched: 1, failed: 0 });
    expect(summary.delivered).toBeGreaterThan(0);
  });

  it('counts published and dispatched separately — the two are the backlog', async () => {
    await publishAndDispatch({
      name: 'JobStarted',
      refs: { bookingId: BOOKING, providerUid: PROVIDER },
      display: { bookingCode: 'SVN-000075' },
    });
    const counts = snapshot().counts;
    expect(counts['EVENT_PUBLISHED:JobStarted']).toBe(1);
    expect(counts['EVENT_DISPATCHED']).toBe(1);
  });
});
