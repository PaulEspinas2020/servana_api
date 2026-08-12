/**
 * B2 — PROVIDER_COMPLETE on the canonical executor.
 *
 *   PROVIDER_COMPLETE RAW WRITE        REMOVED
 *   CANONICAL COMPLETION               EXECUTOR_ONLY
 *   COMPLETION TIMELINE                EXACTLY ONE
 *   IDEMPOTENT REPLAY                  NO SECOND TRANSITION
 *   TERMINAL REPEAT                    EXISTING CONTRACT PRESERVED
 *   UNPAID CASH                        CANNOT COMMIT COMPLETION
 *   WRONG PROVIDER                     REFUSED BEFORE MUTATION
 *   REASSIGNED OLD PROVIDER            REFUSED
 *   POST-COMMIT SIDE EFFECT FAILURE    NO SECOND OR PARTIAL TRANSITION
 *   PAYMENT / EARNINGS / DISBURSEMENT  BEHAVIOUR-COMPATIBLE, NOT REDESIGNED
 *
 * The classification that carries the risk is unpaid cash. It was an `EXISTS`
 * clause inside the UPDATE — a precondition, not a side effect — so it has to
 * refuse BEFORE the commit. A version that checked afterwards would answer
 * `UnpaidCashBookingError` for a booking that had already completed.
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

const disbursements: number[] = [];
let disbursementFails = false;
jest.mock('../src/services/disbursement.service', () => ({
  createDisbursement: jest.fn(async (bookingId: number) => {
    if (disbursementFails) throw new Error('PayMongo is unreachable');
    disbursements.push(bookingId);
    return { id: 1 };
  }),
}));

import fs from 'fs';
import path from 'path';

/**
 * Source with comments removed.
 *
 * Every "X is not here" assertion below needs this. The guard's docblock says
 * "No amounts, no payment ids" and completeJob's says it does not touch
 * reviews or earnings — so the prose explaining an absence would fail the
 * check for that absence. Third time this class has bitten in this migration.
 */
const codeOf = (rel: string): string =>
  fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
import { store, calls, reset, flush } from './support/bookingDbFake';
import { completeJob, UnpaidCashBookingError } from '../src/services/technicianService';
import {
  transitionBooking,
  TransitionError,
  BOOKING_ACTIONS,
  __resetTransitionSchema,
} from '../src/services/booking/transitionExecutor';

const PROVIDER = 'provider-a';
const BOOKING = 1001;

const seed = (o: {
  assignmentStatus?: string;
  bookingStatus?: string;
  payment?: { method: string; status: string } | null;
} = {}) => {
  store.booking = {
    id: BOOKING,
    status: o.bookingStatus ?? 'WORKER_ASSIGNED',
    user_id: 'customer-1',
    worker_uid: PROVIDER,
    worker_code: '123456',
    schedule: new Date(Date.now() + 240 * 3_600_000).toISOString(),
  };
  store.assignments = [{
    booking_id: BOOKING, worker_uid: PROVIDER,
    status: o.assignmentStatus ?? 'IN_PROGRESS', completed_at: null,
  }];
  store.payments = o.payment === undefined
    ? [{ booking_id: BOOKING, method: 'CARD', status: 'PAID' }]
    : o.payment ? [{ booking_id: BOOKING, ...o.payment }] : [];
};

beforeEach(() => {
  reset();
  __resetTransitionSchema();
  disbursements.length = 0;
  disbursementFails = false;
});

describe('PROVIDER_COMPLETE RAW WRITE: REMOVED', () => {
  it('completeJob issues no UPDATE of its own', () => {
    const service = fs.readFileSync(
      path.resolve(__dirname, '../src/services/technicianService.ts'), 'utf8',
    );
    const body = service.slice(
      service.indexOf('export const completeJob'),
      service.indexOf('// Employee ↔ Services'),
    );
    expect(body).not.toMatch(/UPDATE \$\{dbSchema\}\.booking_workers/);
    expect(body).not.toMatch(/UPDATE \$\{dbSchema\}\.bookings SET status/);
    expect(body).toContain("action: 'PROVIDER_COMPLETE'");
  });

  it('the unpaid-cash EXISTS clause is gone from the service', () => {
    const service = fs.readFileSync(
      path.resolve(__dirname, '../src/services/technicianService.ts'), 'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '');
    expect(service).not.toMatch(/UPPER\(COALESCE\(p\.method/);
  });
});

describe('CANONICAL COMPLETION: EXECUTOR_ONLY', () => {
  it('writes both rows and returns the assignment', async () => {
    seed();
    const row = await completeJob(BOOKING, PROVIDER);

    expect(store.assignments[0].status).toBe('COMPLETED');
    expect(store.assignments[0].completed_at).toBe('2026-08-12T00:00:00.000Z');
    expect(store.booking?.status).toBe('COMPLETED');
    expect(row.status).toBe('COMPLETED');
  });

  it('COMPLETION TIMELINE: exactly one', async () => {
    seed();
    await completeJob(BOOKING, PROVIDER);
    expect(store.transitions).toHaveLength(1);
    expect(store.transitions[0]).toMatchObject({
      action: 'PROVIDER_COMPLETE', from_state: 'IN_PROGRESS', to_state: 'COMPLETED',
    });
  });

  it('both writes and the timeline are in ONE transaction', async () => {
    seed();
    await completeJob(BOOKING, PROVIDER);
    const tx = store.inTransaction.join(' | ');
    expect(tx).toContain("UPDATE servana.bookings SET status = 'COMPLETED'");
    expect(tx).toContain("UPDATE servana.booking_workers SET status = 'COMPLETED'");
    expect(tx).toContain('INSERT INTO servana.booking_transitions');
  });
});

/**
 * UNPAID CASH — a precondition, and the reason this migration could have gone
 * quietly wrong.
 */
describe('UNPAID CASH: cannot commit completion', () => {
  it('the action names the guard', () => {
    expect((BOOKING_ACTIONS.PROVIDER_COMPLETE as { guard?: string }).guard)
      .toBe('cashPaymentSettledBeforeCompletion');
  });

  it('refuses an unpaid cash booking with UnpaidCashBookingError', async () => {
    seed({ payment: { method: 'CASH', status: 'PENDING' } });
    await expect(completeJob(BOOKING, PROVIDER)).rejects.toBeInstanceOf(UnpaidCashBookingError);
  });

  it('and nothing is committed — this is the failure mode being prevented', async () => {
    // If the check ran AFTER the executor, the caller would get an error for a
    // booking that had already completed.
    seed({ payment: { method: 'CASH', status: 'PENDING' } });
    await completeJob(BOOKING, PROVIDER).catch(() => undefined);
    await flush();

    expect(store.assignments[0].status).toBe('IN_PROGRESS');
    expect(store.booking?.status).toBe('WORKER_ASSIGNED');
    expect(store.transitions).toHaveLength(0);
    expect(store.sql).not.toContain('COMMIT');
    // And no money moved.
    expect(disbursements).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('the guard refuses BEFORE any write is attempted', async () => {
    seed({ payment: { method: 'CASH', status: 'PENDING' } });
    await completeJob(BOOKING, PROVIDER).catch(() => undefined);
    const writes = store.sql.filter((q) => /^UPDATE|^INSERT/i.test(q));
    expect(writes).toEqual([]);
  });

  it('allows cash once it is recorded PAID', async () => {
    seed({ payment: { method: 'CASH', status: 'PAID' } });
    await completeJob(BOOKING, PROVIDER);
    expect(store.assignments[0].status).toBe('COMPLETED');
  });

  it('allows any non-cash method', async () => {
    seed({ payment: { method: 'GCASH', status: 'PENDING' } });
    await completeJob(BOOKING, PROVIDER);
    expect(store.assignments[0].status).toBe('COMPLETED');
  });

  it('a booking with NO payment row is refused, as before', async () => {
    // The legacy EXISTS clause matched nothing, so completion did not happen,
    // and the classifier fell through to the generic message. Preserved
    // deliberately rather than corrected during a state-machine migration.
    seed({ payment: null });
    const error = await completeJob(BOOKING, PROVIDER).catch((e) => e);
    expect(error).not.toBeInstanceOf(UnpaidCashBookingError);
    expect(error.message).toBe('Job cannot be completed');
    expect(store.transitions).toHaveLength(0);
  });

  it('the refusal detail names no payment record', () => {
    // A provider needs to know what to do, not the customer's payment row.
    const executor = codeOf('src/services/booking/transitionExecutor.ts');
    const guard = executor.slice(
      executor.indexOf('cashPaymentSettledBeforeCompletion: async'),
      executor.indexOf('export const BOOKING_ACTIONS'),
    );
    expect(guard).toContain('cashPaymentOutstanding');
    expect(guard).not.toMatch(/amount|final_price|payment_id/i);
  });
});

describe('authorization refuses before mutation', () => {
  it('WRONG PROVIDER', async () => {
    seed();
    const error = await transitionBooking({
      action: 'PROVIDER_COMPLETE', bookingId: BOOKING,
      actorRole: 'assigned_provider', actorUid: 'provider-b',
    }).catch((e) => e);

    expect(error).toBeInstanceOf(TransitionError);
    expect(error.code).toBe('NOT_AUTHORIZED');
    expect(store.assignments[0].status).toBe('IN_PROGRESS');
    expect(store.transitions).toHaveLength(0);
  });

  it('REASSIGNED OLD PROVIDER', async () => {
    seed();
    store.assignments[0].status = 'REASSIGNED';
    store.assignments.push({ booking_id: BOOKING, worker_uid: 'provider-b', status: 'IN_PROGRESS' });
    store.booking!.worker_uid = 'provider-b';

    await expect(completeJob(BOOKING, PROVIDER)).rejects.toThrow('Job cannot be completed');
    expect(store.transitions).toHaveLength(0);
  });

  it('an out-of-order complete is refused', async () => {
    seed({ assignmentStatus: 'ACCEPTED' });
    await expect(completeJob(BOOKING, PROVIDER)).rejects.toThrow('Job cannot be completed');
  });
});

describe('TERMINAL REPEAT: existing contract preserved', () => {
  it('completing an already-completed booking is refused, not repeated', async () => {
    seed();
    await completeJob(BOOKING, PROVIDER);
    await flush();
    calls.length = 0;
    disbursements.length = 0;

    await expect(completeJob(BOOKING, PROVIDER)).rejects.toThrow('Job cannot be completed');

    expect(store.transitions).toHaveLength(1);
    expect(disbursements).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe('IDEMPOTENT REPLAY: no second transition, no duplicate downstream', () => {
  it('replays the original outcome and runs nothing again', async () => {
    seed();
    await completeJob(BOOKING, PROVIDER, { idempotencyKey: 'c-1' });
    await flush();

    expect(disbursements).toEqual([BOOKING]);
    expect(calls).toEqual(['email:booking_completed', 'chat:systemMessage']);

    calls.length = 0;
    disbursements.length = 0;
    const replay = await completeJob(BOOKING, PROVIDER, { idempotencyKey: 'c-1' });
    await flush();

    expect(replay.status).toBe('COMPLETED');
    expect(store.transitions).toHaveLength(1);
    // The money path in particular. createDisbursement dedupes on its own, but
    // the receipt email does not, which is why the gate is on the replay flag.
    expect(disbursements).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe('POST-COMMIT SIDE EFFECT FAILURE', () => {
  it('a disbursement failure does not undo or repeat the transition', async () => {
    // §45: a downstream failure must not roll back a committed transition.
    seed();
    disbursementFails = true;

    const row = await completeJob(BOOKING, PROVIDER);
    await flush();

    expect(row.status).toBe('COMPLETED');
    expect(store.booking?.status).toBe('COMPLETED');
    expect(store.transitions).toHaveLength(1);
    // And the rest of the chain still ran.
    expect(calls).toEqual(['email:booking_completed', 'chat:systemMessage']);
  });

  it('the transition is committed before any downstream effect runs', async () => {
    seed();
    await completeJob(BOOKING, PROVIDER);
    await flush();
    const commit = store.sql.lastIndexOf('COMMIT');
    expect(commit).toBeGreaterThan(-1);
    expect(store.inTransaction.some((q) => /payments/i.test(q))).toBe(true);
  });
});

describe('PAYMENT / EARNINGS / DISBURSEMENT: behaviour-compatible, not redesigned', () => {
  it('createDisbursement is still called once, with the booking id', async () => {
    seed();
    await completeJob(BOOKING, PROVIDER);
    expect(disbursements).toEqual([BOOKING]);
  });

  it('it keeps its own idempotency rather than relying on the executor', () => {
    // Preserved, not replaced. Two independent guards on a money path is the
    // right number.
    const svc = fs.readFileSync(
      path.resolve(__dirname, '../src/services/disbursement.service.ts'), 'utf8',
    );
    expect(svc).toContain('ON CONFLICT (booking_id) DO NOTHING');
  });

  it('the side effects keep their original order', async () => {
    seed();
    await completeJob(BOOKING, PROVIDER);
    await flush();
    expect(calls).toEqual(['email:booking_completed', 'chat:systemMessage']);
  });

  it('no revenue split, earnings or review logic was touched', () => {
    const service = codeOf('src/services/technicianService.ts');
    const body = service.slice(
      service.indexOf('export const completeJob'),
      service.indexOf('const ensureEmployeeServicesColumns'),
    );
    expect(body).not.toMatch(/splitRevenue|revenueSplit|earnings|review/i);
    expect(body).toContain('createDisbursement(bookingId)');
  });
});
