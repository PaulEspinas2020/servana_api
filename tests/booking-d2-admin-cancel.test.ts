/**
 * D2 — ADMIN_CANCEL on the canonical executor.
 *
 *   Admin-authorized action                        PASS
 *   does NOT use the customer cancellation stages  PASS
 *   does NOT use the provider 48-hour window       PASS
 *   cancels only from allowed source states        PASS
 *   closes ALL active assignment rows              PASS
 *   exactly one canonical CANCELLED transition     PASS
 *   required legacy timeline projection            PASS
 *   cannot revive a cancelled booking              PASS
 *   admin provenance preserved                     PASS
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' } }));
jest.mock('../src/db/dbQuery', () => require('./support/bookingDbFake').dbMock);
jest.mock('../src/db/mongodbQuery', () => ({ __esModule: true, default: {} }));
jest.mock('../src/chat/chat.service', () => ({
  closeConversationForCancellation: jest.fn(async () => undefined),
  getOrCreateConversation: jest.fn(),
  postSystemMessageOnce: jest.fn(),
  openConversationForConfirmedBooking: jest.fn(),
}));
jest.mock('../src/services/bookingAuditService', () => ({
  logBookingAudit: jest.fn(),
}), { virtual: true });

import fs from 'fs';
import path from 'path';
import { store, reset, flush } from './support/bookingDbFake';
import {
  transitionBooking,
  TransitionError,
  BOOKING_ACTIONS,
} from '../src/services/booking/transitionExecutor';

const ADMIN = 'admin-1';
const BOOKING = 1301;

const codeOf = (rel: string): string =>
  fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

const seed = (o: {
  bookingStatus?: string;
  workerUid?: string | null;
  assignments?: Array<{ worker_uid: string; status: string }>;
} = {}) => {
  store.booking = {
    id: BOOKING,
    status: o.bookingStatus ?? 'WORKER_ASSIGNED',
    user_id: 'customer-1',
    worker_uid: o.workerUid === undefined ? 'provider-a' : o.workerUid,
    schedule: new Date(Date.now() + 2 * 3_600_000).toISOString(), // INSIDE the 48h window
  };
  store.assignments = (o.assignments ?? [{ worker_uid: 'provider-a', status: 'ACCEPTED' }])
    .map((a) => ({ booking_id: BOOKING, ...a }));
};

const adminCancel = (metadata: Record<string, unknown> = { reason: 'customer complaint' }) =>
  transitionBooking({
    action: 'ADMIN_CANCEL', bookingId: BOOKING,
    actorRole: 'admin', actorUid: ADMIN, metadata,
  });

beforeEach(() => {
  reset();
});

describe('ADMIN_CANCEL has its own authority', () => {
  it('carries neither the customer nor the provider cancellation guard', () => {
    const spec = BOOKING_ACTIONS.ADMIN_CANCEL as { guard?: string };
    expect(spec.guard).toBeUndefined();
  });

  it('cancels a booking the CUSTOMER could not — provider already EN_ROUTE', async () => {
    // customerCancellationStage refuses EN_ROUTE outright.
    seed({ bookingStatus: 'EN_ROUTE', assignments: [{ worker_uid: 'provider-a', status: 'EN_ROUTE' }] });
    await adminCancel();
    expect(store.booking?.status).toBe('CANCELLED');
  });

  it('cancels a booking the PROVIDER could not — inside the 48-hour window', async () => {
    // The seed schedules the booking 2 hours out, well inside the notice
    // period that refuses PROVIDER_CANCEL. An admin cancelling a job already
    // under way is the case that policy escalates TO.
    seed({ assignments: [{ worker_uid: 'provider-a', status: 'ACCEPTED' }] });
    await adminCancel();
    expect(store.booking?.status).toBe('CANCELLED');
  });

  it('cancels a job already IN_PROGRESS — admin only', async () => {
    seed({ bookingStatus: 'IN_PROGRESS', assignments: [{ worker_uid: 'provider-a', status: 'IN_PROGRESS' }] });
    await adminCancel();
    expect(store.booking?.status).toBe('CANCELLED');
    expect(store.transitions[0]).toMatchObject({ from_state: 'IN_PROGRESS', to_state: 'CANCELLED' });
  });
});

describe('every active assignment row is closed', () => {
  it('the ordinary case', async () => {
    seed();
    await adminCancel();
    expect(store.assignments[0].status).toBe('CANCELLED');
  });

  /**
   * Partial historical corruption, both directions.
   *
   * These are not hypothetical: the pointer and the rows are written by
   * different code paths, and Phase C already found one that cleared the
   * pointer without closing the rows.
   */
  it('STALE POINTER: worker_uid is NULL but rows are still active', async () => {
    seed({
      workerUid: null,
      assignments: [
        { worker_uid: 'provider-a', status: 'ACCEPTED' },
        { worker_uid: 'provider-b', status: 'ASSIGNED' },
      ],
    });
    await adminCancel();
    expect(store.assignments.map((a) => a.status)).toEqual(['CANCELLED', 'CANCELLED']);
  });

  it('ORPHAN ROW: pointer names A while B also has an open row', async () => {
    seed({
      workerUid: 'provider-a',
      assignments: [
        { worker_uid: 'provider-a', status: 'ACCEPTED' },
        { worker_uid: 'provider-b', status: 'EN_ROUTE' },
      ],
    });
    await adminCancel();
    expect(store.assignments.map((a) => a.status)).toEqual(['CANCELLED', 'CANCELLED']);
  });

  it('CLOSED rows are history and are left alone', async () => {
    // DECLINED, COMPLETED and an earlier CANCELLED are the record of what
    // happened. Rewriting them would erase it.
    seed({
      assignments: [
        { worker_uid: 'provider-a', status: 'DECLINED' },
        { worker_uid: 'provider-b', status: 'ACCEPTED' },
      ],
    });
    await adminCancel();
    expect(store.assignments.map((a) => a.status)).toEqual(['DECLINED', 'CANCELLED']);
  });
});

describe('provenance, and exactly one of everything', () => {
  it('writes ONE canonical transition naming the admin', async () => {
    seed();
    await adminCancel();
    expect(store.transitions).toHaveLength(1);
    expect(store.transitions[0]).toMatchObject({
      action: 'ADMIN_CANCEL', to_state: 'CANCELLED',
    });
  });

  it('the timeline event is the only thing distinguishing WHO cancelled', async () => {
    // Measured: there is no `cancellation_source` column on bookings. This row
    // is the provenance, which is why it is inside the transaction.
    const svc = codeOf('src/services/adminBookingService.ts');
    expect(svc).not.toMatch(/cancellation_source/);

    const executor = codeOf('src/services/booking/transitionExecutor.ts');
    const entry = executor.slice(
      executor.indexOf('ADMIN_CANCEL: {', executor.indexOf('LEGACY_TIMELINE_EVENT')),
      executor.indexOf('};', executor.indexOf('LEGACY_TIMELINE_EVENT')),
    );
    expect(entry).toContain("title: 'Booking cancelled by admin'");
    expect(entry).toContain("actorType: 'admin'");
  });

  it('carries only the metadata keys the action declares', async () => {
    // The bag also holds credentials on other actions. A timeline row is read
    // by support, so the projection copies named keys rather than the bag.
    const executor = codeOf('src/services/booking/transitionExecutor.ts');
    expect(executor).toContain("metadataKeys: ['reasonCode', 'refundAction']");
    expect(executor).toContain('for (const key of entry.metadataKeys ?? [])');
  });

  it('the timeline write is inside the transaction', async () => {
    seed();
    await adminCancel();
    expect(store.inTransaction.join(' | ')).toContain('INSERT INTO servana.booking_timeline_events');
  });
});

describe('a cancelled booking cannot be revived', () => {
  it.each([
    ['ADMIN_CANCEL', () => adminCancel()],
    ['ADMIN_CONFIRM_ASSIGNMENT', () => transitionBooking({
      action: 'ADMIN_CONFIRM_ASSIGNMENT', bookingId: BOOKING, actorRole: 'admin',
      actorUid: ADMIN, metadata: { providerUid: 'provider-a', consentMethod: 'verbal' },
    })],
    ['ADMIN_ASSIGN', () => transitionBooking({
      action: 'ADMIN_ASSIGN', bookingId: BOOKING, actorRole: 'admin',
      actorUid: ADMIN, metadata: { providerUid: 'provider-b' },
    })],
    ['ADMIN_REASSIGN', () => transitionBooking({
      action: 'ADMIN_REASSIGN', bookingId: BOOKING, actorRole: 'admin',
      actorUid: ADMIN, metadata: { providerUid: 'provider-b' },
    })],
  ])('%s is refused after cancellation', async (_name, run) => {
    seed();
    await adminCancel();
    expect(store.booking?.status).toBe('CANCELLED');

    const error = await run().catch((e) => e);
    expect(error).toBeInstanceOf(TransitionError);
    expect(store.booking?.status).toBe('CANCELLED');
    // And nothing was appended.
    expect(store.transitions).toHaveLength(1);
  });

  it('a second ADMIN_CANCEL is TERMINAL_STATE, not a silent no-op', async () => {
    seed();
    await adminCancel();
    const error = await adminCancel().catch((e) => e);
    expect(error.code).toBe('TERMINAL_STATE');
  });
});

describe('a refused cancellation writes nothing', () => {
  it('a completed booking cannot be cancelled', async () => {
    seed({ bookingStatus: 'COMPLETED', assignments: [{ worker_uid: 'provider-a', status: 'COMPLETED' }] });
    const error = await adminCancel().catch((e) => e);

    expect(error).toBeInstanceOf(TransitionError);
    expect(store.booking?.status).toBe('COMPLETED');
    expect(store.assignments[0].status).toBe('COMPLETED');
    expect(store.transitions).toHaveLength(0);
    expect(store.sql).not.toContain('COMMIT');
  });

  it('a failed timeline insert rolls the whole cancellation back', async () => {
    seed();
    store.timelineEventFails = true;

    await expect(adminCancel()).rejects.toThrow();
    expect(store.booking?.status).toBe('WORKER_ASSIGNED');
    expect(store.assignments[0].status).toBe('ACCEPTED');
    expect(store.transitions).toHaveLength(0);
  });
});
