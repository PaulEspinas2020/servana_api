/**
 * B1.3 — PROVIDER_EN_ROUTE on the canonical executor.
 *
 * The gates for this phase, stated as tests rather than as claims:
 *
 *   CANONICAL WORKER STATE           booking_workers.status = EN_ROUTE
 *   LEGACY BOOKING STATUS PROJECTION bookings.status = EN_ROUTE
 *   LEGACY TRACKING PROJECTION       written transactionally
 *   V1 / LEGACY ARRIVAL PARITY       both paths leave identical rows
 *   TRANSITION LEGALITY              from the canonical machine only
 *   bookings.status AUTHORIZES?      no
 *   booking_tracking AS TIMELINE?    no
 *
 * B1.4 extends it to ARRIVED and retires `advanceArrivalStage`.
 *
 * ## Parity is checked, and is not sufficient on its own
 *
 * Comparing the legacy and v1 rows for equality proves the two paths AGREE. It
 * does not prove either is right — two paths producing the same wrong rows
 * pass an equality check perfectly. So the canonical invariants are pinned
 * independently, field by field, and parity is asserted on top:
 *
 *   V1 == LEGACY          the paths cannot diverge
 *   RESULT == EXPECTED    and what they agree on is correct
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' } }));
jest.mock('../src/db/dbQuery', () => require('./support/bookingDbFake').dbMock);
jest.mock('../src/helpers/mailer', () => require('./support/bookingDbFake').sideEffectMocks.mailer);
jest.mock('../src/services/notification.service', () => require('./support/bookingDbFake').sideEffectMocks.notification);
jest.mock('../src/services/adminNotificationService', () => require('./support/bookingDbFake').sideEffectMocks.adminNotification);
jest.mock('../src/provider.realtime', () => require('./support/bookingDbFake').sideEffectMocks.realtime);
jest.mock('../src/chat/chat.service', () => require('./support/bookingDbFake').sideEffectMocks.chat);
jest.mock('../src/chat/chat.repository', () => require('./support/bookingDbFake').sideEffectMocks.chatRepo);
jest.mock('../src/services/user.service', () => require('./support/bookingDbFake').sideEffectMocks.user);
jest.mock('../src/db/mongodbQuery', () => ({ __esModule: true, default: {} }));
jest.mock('../src/services/providerAutoOnlineEngine', () => ({ getAutoBookableProviderUids: jest.fn() }));
jest.mock('../src/services/providerAvailabilityEngine', () => ({ filterUidsAvailableAt: jest.fn() }));
jest.mock('../src/services/pricingService', () => ({ computeTranspoFee: jest.fn() }));
jest.mock('../src/services/disbursement.service', () => ({ createDisbursement: jest.fn() }));

import fs from 'fs';
import path from 'path';
import { store, reset, flush } from './support/bookingDbFake';
import { markEnRoute, markArrived } from '../src/services/technicianService';
import { deriveCanonicalState } from '../src/services/booking/canonicalState';
import { transitionBooking } from '../src/services/booking/transitionExecutor';

const PROVIDER = 'provider-a';
const BOOKING = 801;

const seed = (assignmentStatus = 'ACCEPTED', bookingStatus = 'WORKER_ASSIGNED') => {
  store.booking = {
    id: BOOKING, status: bookingStatus, user_id: 'customer-1',
    worker_uid: PROVIDER, worker_code: '123456',
    schedule: new Date(Date.now() + 240 * 3_600_000).toISOString(),
  };
  store.assignments = [{
    booking_id: BOOKING, worker_uid: PROVIDER, status: assignmentStatus,
    en_route_at: null, arrived_at: null,
  }];
};

beforeEach(() => {
  reset();
});

describe('CANONICAL WORKER STATE', () => {
  it('booking_workers.status becomes EN_ROUTE and is stamped', async () => {
    seed();
    const row = await markEnRoute(BOOKING, PROVIDER);

    expect(store.assignments[0].status).toBe('EN_ROUTE');
    expect(store.assignments[0].en_route_at).toBe('2026-08-12T00:00:00.000Z');
    // The assignment row is still what the caller receives.
    expect(row.status).toBe('EN_ROUTE');
  });

  it('the timestamp column is chosen from the destination, not from a caller', async () => {
    // A caller passing a column name could stamp arrived_at on an en-route
    // transition. The executor derives it.
    seed();
    await markEnRoute(BOOKING, PROVIDER);
    expect(store.assignments[0].arrived_at).toBeNull();
  });
});

describe('LEGACY BOOKING STATUS PROJECTION', () => {
  it('bookings.status mirrors EN_ROUTE', async () => {
    seed();
    await markEnRoute(BOOKING, PROVIDER);
    expect(store.booking?.status).toBe('EN_ROUTE');
  });

  it('the projection is scoped to this provider', async () => {
    const sql = store.sql;
    seed();
    await markEnRoute(BOOKING, PROVIDER);
    expect(sql.some((q) => /UPDATE servana\.bookings SET status = \$2 WHERE id = \$1 AND worker_uid = \$3/.test(q)))
      .toBe(true);
  });

  /**
   * RETIREMENT BLOCKER, still in force.
   *
   * ServanaClient's bookings list and assignment poller read `bookings.status`.
   * The projection stays until a client version reading effectiveStatus /
   * canonicalState is released AND adopted, AND telemetry confirms no
   * installed version still needs it. Two Dart lines is the code change; it is
   * not the retirement condition.
   */
  it('the retirement condition is still recorded in the source', () => {
    const executor = fs.readFileSync(
      path.resolve(__dirname, '../src/services/booking/transitionExecutor.ts'), 'utf8',
    );
    expect(executor).toContain('LEGACY_STATUS_PROJECTION_RETIREMENT_BLOCKER');
    expect(executor).toMatch(/adopted/i);
    expect(executor).toMatch(/telemetry/i);
  });
});

describe('LEGACY TRACKING PROJECTION', () => {
  it('writes the row the three timelines read', async () => {
    seed();
    await markEnRoute(BOOKING, PROVIDER);
    expect(store.tracking).toEqual([
      { booking_id: BOOKING, status: 'EN_ROUTE', note: 'Provider is on the way' },
    ]);
  });

  it('is written transactionally, not best-effort', async () => {
    // Promoted from the legacy try/catch. Documented in TAB04_OPEN_GAPS.md.
    seed();
    store.trackingFails = true;

    await expect(markEnRoute(BOOKING, PROVIDER)).rejects.toThrow();
    expect(store.assignments[0].status).toBe('ACCEPTED');
    expect(store.booking?.status).toBe('WORKER_ASSIGNED');
    expect(store.transitions).toHaveLength(0);
    expect(store.sql).not.toContain('COMMIT');
  });

  it('everything lands in ONE transaction', async () => {
    seed();
    await markEnRoute(BOOKING, PROVIDER);
    const tx = store.inTransaction.join(' | ');
    expect(tx).toContain('SET status = $3, en_route_at = NOW()');
    expect(tx).toContain('UPDATE servana.bookings SET status = $2');
    expect(tx).toContain('INSERT INTO servana.booking_transitions');
    expect(tx).toContain('INSERT INTO servana.booking_tracking');
  });
});

describe('TRANSITION LEGALITY comes only from the canonical machine', () => {
  it('refuses EN_ROUTE from ASSIGNED — the provider has not accepted yet', async () => {
    seed('ASSIGNED');
    await expect(markEnRoute(BOOKING, PROVIDER)).rejects.toThrow(/cannot move to EN_ROUTE/);
    expect(store.assignments[0].status).toBe('ASSIGNED');
    expect(store.booking?.status).toBe('WORKER_ASSIGNED');
  });

  it('refuses a repeat once already EN_ROUTE', async () => {
    seed('EN_ROUTE');
    await expect(markEnRoute(BOOKING, PROVIDER)).rejects.toThrow(/cannot move to EN_ROUTE/);
  });

  it('refuses on a cancelled booking, writing nothing', async () => {
    seed('ACCEPTED', 'CANCELLED');
    await expect(markEnRoute(BOOKING, PROVIDER)).rejects.toThrow();
    expect(store.transitions).toHaveLength(0);
    expect(store.tracking).toHaveLength(0);
    expect(store.booking?.status).toBe('CANCELLED');
  });

  it('preserves the legacy refusal message, so the controller still answers 409', () => {
    // `providerController.arrivalHandler` matches /cannot move to/i. A richer
    // message here would silently turn every out-of-order tap into a 500.
    const controller = fs.readFileSync(
      path.resolve(__dirname, '../src/controllers/providerController.ts'), 'utf8',
    );
    expect(controller).toContain('/cannot move to/i');
    const service = fs.readFileSync(
      path.resolve(__dirname, '../src/services/technicianService.ts'), 'utf8',
    );
    expect(service).toContain('`Job cannot move to ${to}`');
  });
});

describe('bookings.status is NOT used to authorize the transition', () => {
  it('a stale bookings.status does not permit an illegal move', async () => {
    // bookings.status still says EN_ROUTE from an earlier attempt while the
    // assignment row — the canonical one — says ASSIGNED. The machine must
    // read the assignment, not the coarse column.
    seed('ASSIGNED', 'EN_ROUTE');
    await expect(markEnRoute(BOOKING, PROVIDER)).rejects.toThrow(/cannot move to/);
    expect(store.transitions).toHaveLength(0);
  });

  it('a stale bookings.status does not BLOCK a legal move either', async () => {
    // The mirror case. Authorization reads one column; if bookings.status were
    // consulted, a CONFIRMED booking with an ACCEPTED assignment would fail.
    seed('ACCEPTED', 'CONFIRMED');
    await markEnRoute(BOOKING, PROVIDER);
    expect(store.assignments[0].status).toBe('EN_ROUTE');
  });
});

describe('booking_tracking is NOT the canonical timeline', () => {
  it('the canonical event is the booking_transitions row', async () => {
    seed();
    await markEnRoute(BOOKING, PROVIDER);
    expect(store.transitions[0]).toMatchObject({
      action: 'PROVIDER_EN_ROUTE', from_state: 'ACCEPTED', to_state: 'EN_ROUTE',
    });
  });

  it('the tracking row carries no state the transition row lacks', async () => {
    // If tracking ever became the richer record, it would be the event store
    // by accident. It holds a status and a human note; the transition row
    // holds actor, correlation, from-state and to-state.
    seed();
    await markEnRoute(BOOKING, PROVIDER);
    expect(Object.keys(store.tracking[0]).sort()).toEqual(['booking_id', 'note', 'status']);
  });
});

/**
 * V1 / LEGACY ARRIVAL PARITY.
 *
 * The gate that made this migration worth doing. Before it, the legacy service
 * cascaded `bookings.status` and the `/api/v1` endpoint did not, so the same
 * booking read differently depending on which path the provider's app used.
 * Both now go through one executor, so parity is structural — but asserting it
 * is what keeps it structural.
 */
/**
 * The canonical expectation, stated field by field for each stage.
 *
 * This is the half parity cannot supply. Every one of these would still hold
 * if the v1 path did not exist.
 */
describe('RESULT == CANONICAL EXPECTATION', () => {
  it('PROVIDER_EN_ROUTE leaves exactly the expected rows', async () => {
    seed('ACCEPTED');
    store.assignments[0].accepted_at = '2026-08-11T00:00:00.000Z';
    await markEnRoute(BOOKING, PROVIDER);

    const assignment = store.assignments[0];
    expect(assignment.status).toBe('EN_ROUTE');
    expect(assignment.en_route_at).toBe('2026-08-12T00:00:00.000Z');
    expect(assignment.arrived_at).toBeNull();
    // The earlier stage's timestamp is history and must survive.
    expect(assignment.accepted_at).toBe('2026-08-11T00:00:00.000Z');

    // Legacy projection ONLY. bookings.status is not canonical here.
    expect(store.booking?.status).toBe('EN_ROUTE');
    expect(deriveCanonicalState({
      bookingStatus: store.booking?.status,
      workerStatus: assignment.status,
      workerUid: store.booking?.worker_uid,
    })).toBe('EN_ROUTE');

    // Exactly one of each, not "at least one".
    expect(store.transitions).toHaveLength(1);
    expect(store.tracking).toHaveLength(1);
  });

  it('PROVIDER_ARRIVED leaves exactly the expected rows', async () => {
    seed('EN_ROUTE');
    store.assignments[0].accepted_at = '2026-08-11T00:00:00.000Z';
    store.assignments[0].en_route_at = '2026-08-11T12:00:00.000Z';
    await markArrived(BOOKING, PROVIDER);

    const assignment = store.assignments[0];
    expect(assignment.status).toBe('ARRIVED');
    expect(assignment.arrived_at).toBe('2026-08-12T00:00:00.000Z');
    // Both earlier stamps preserved - the journey is a history, not a cursor.
    expect(assignment.accepted_at).toBe('2026-08-11T00:00:00.000Z');
    expect(assignment.en_route_at).toBe('2026-08-11T12:00:00.000Z');

    expect(store.booking?.status).toBe('ARRIVED');
    expect(deriveCanonicalState({
      bookingStatus: store.booking?.status,
      workerStatus: assignment.status,
      workerUid: store.booking?.worker_uid,
    })).toBe('ARRIVED');

    expect(store.transitions).toHaveLength(1);
    expect(store.transitions[0]).toMatchObject({
      action: 'PROVIDER_ARRIVED', from_state: 'EN_ROUTE', to_state: 'ARRIVED',
    });
    expect(store.tracking).toEqual([
      { booking_id: BOOKING, status: 'ARRIVED', note: 'Provider has arrived' },
    ]);
  });

  it('the full journey accumulates one transition per stage', async () => {
    seed('ACCEPTED');
    await markEnRoute(BOOKING, PROVIDER);
    await markArrived(BOOKING, PROVIDER);

    expect(store.transitions.map((t) => t.to_state)).toEqual(['EN_ROUTE', 'ARRIVED']);
    expect(store.tracking.map((t) => t.status)).toEqual(['EN_ROUTE', 'ARRIVED']);
    expect(store.assignments[0].en_route_at).toBeTruthy();
    expect(store.assignments[0].arrived_at).toBeTruthy();
  });
});

describe('ARRIVED legality and stale-projection guards', () => {
  it('refuses ARRIVED from ACCEPTED - the provider never set out', async () => {
    seed('ACCEPTED');
    await expect(markArrived(BOOKING, PROVIDER)).rejects.toThrow(/cannot move to ARRIVED/);
    expect(store.assignments[0].status).toBe('ACCEPTED');
  });

  it('refuses a repeat once already ARRIVED', async () => {
    seed('ARRIVED');
    await expect(markArrived(BOOKING, PROVIDER)).rejects.toThrow(/cannot move to ARRIVED/);
  });

  it('a stale bookings.status = ARRIVED does not authorize the move', async () => {
    seed('ACCEPTED', 'ARRIVED');
    await expect(markArrived(BOOKING, PROVIDER)).rejects.toThrow(/cannot move to/);
    expect(store.transitions).toHaveLength(0);
  });

  it('a stale bookings.status = CONFIRMED does not block the move', async () => {
    seed('EN_ROUTE', 'CONFIRMED');
    await markArrived(BOOKING, PROVIDER);
    expect(store.assignments[0].status).toBe('ARRIVED');
  });

  it('a failed tracking insert rolls ARRIVED back too', async () => {
    seed('EN_ROUTE');
    store.trackingFails = true;
    await expect(markArrived(BOOKING, PROVIDER)).rejects.toThrow();
    expect(store.assignments[0].status).toBe('EN_ROUTE');
    expect(store.booking?.status).toBe('WORKER_ASSIGNED');
    expect(store.sql).not.toContain('COMMIT');
  });
});

describe('advanceArrivalStage is gone', () => {
  const service = fs.readFileSync(
    path.resolve(__dirname, '../src/services/technicianService.ts'), 'utf8',
  );

  it('the helper no longer exists', () => {
    expect(service).not.toMatch(/const advanceArrivalStage\s*=/);
  });

  it('neither arrival stage writes status directly any more', () => {
    const code = service
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    const enRoute = code.slice(
      code.indexOf('export const markEnRoute'),
      code.indexOf('const runArrivalTransition'),
    );
    expect(enRoute).not.toMatch(/UPDATE \$\{dbSchema\}\.booking_workers/);
    expect(enRoute).toContain("'PROVIDER_EN_ROUTE'");
  });
});

describe('V1 / LEGACY ARRIVAL PARITY', () => {
  const snapshotOf = () => ({
    assignment: { ...store.assignments[0] },
    bookingStatus: store.booking?.status,
    tracking: store.tracking.map((t) => ({ ...t })),
    transitions: store.transitions.map((t) => ({ ...t })),
  });

  const bothPaths = async (
    from: string,
    legacy: (b: number, w: string) => Promise<unknown>,
    action: 'PROVIDER_EN_ROUTE' | 'PROVIDER_ARRIVED',
  ) => {
    seed(from);
    await legacy(BOOKING, PROVIDER);
    const viaLegacy = snapshotOf();

    reset();
    seed(from);
    await transitionBooking({
      action, bookingId: BOOKING, actorRole: 'assigned_provider', actorUid: PROVIDER,
    });
    return { viaLegacy, viaV1: snapshotOf() };
  };

  it('V1_EN_ROUTE_BOOKING_STATUS_PARITY: both paths leave identical rows', async () => {
    const { viaLegacy, viaV1 } = await bothPaths('ACCEPTED', markEnRoute, 'PROVIDER_EN_ROUTE');
    expect(viaV1).toEqual(viaLegacy);
    // Anchored to the canonical expectation, so agreement on a wrong value
    // cannot pass.
    expect(viaV1.bookingStatus).toBe('EN_ROUTE');
    expect(viaV1.assignment.status).toBe('EN_ROUTE');
  });

  it('V1_ARRIVED_BOOKING_STATUS_PARITY: both paths leave identical rows', async () => {
    const { viaLegacy, viaV1 } = await bothPaths('EN_ROUTE', markArrived, 'PROVIDER_ARRIVED');
    expect(viaV1).toEqual(viaLegacy);
    expect(viaV1.bookingStatus).toBe('ARRIVED');
    expect(viaV1.assignment.status).toBe('ARRIVED');
  });

  it('the parity check can actually fail (positive fixture)', () => {
    // Equality between two snapshots is only meaningful if a difference would
    // be detected. A shallow compare over nested objects would not.
    const a = { assignment: { status: 'ARRIVED' }, tracking: [{ status: 'ARRIVED' }] };
    const b = { assignment: { status: 'EN_ROUTE' }, tracking: [{ status: 'ARRIVED' }] };
    expect(a).not.toEqual(b);
  });
});
