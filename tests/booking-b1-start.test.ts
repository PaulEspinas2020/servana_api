/**
 * B1.5 — PROVIDER_START on the canonical executor.
 *
 * The gates for this phase:
 *
 *   START RAW WRITE                REMOVED
 *   WORKER CODE CHECK              ATOMIC IN EXECUTOR
 *   LIFECYCLE STATE LIST IN SQL    ABSENT
 *   WRONG CODE                     BOOKING_WORKER_CODE_INVALID
 *   STALE STATE                    BOOKING_STATE_CONFLICT
 *   INVALID SOURCE STATE           BOOKING_TRANSITION_INVALID
 *   TERMINAL                       BOOKING_TERMINAL
 *   WRONG PROVIDER                 BOOKING_ACCESS_DENIED
 *   REASSIGNED PROVIDER, OLD CODE  REFUSED
 *   FAILED EXECUTOR                NO EMAIL / NO CHAT
 *   IDEMPOTENT REPLAY              NO DUPLICATE EMAIL / CHAT
 *   CANONICAL TIMELINE             EXACTLY ONE START TRANSITION
 *
 * The v1 error codes are asserted at the executor's own vocabulary and at the
 * v1 mapping, because the two legacy controllers flatten every one of them to
 * 500 — deliberately unchanged here, since their clients cannot tell the
 * causes apart today and this migration is not where that changes.
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
import { store, calls, reset, flush } from './support/bookingDbFake';
import { startJob } from '../src/services/technicianService';
import {
  transitionBooking,
  TransitionError,
  __resetTransitionSchema,
} from '../src/services/booking/transitionExecutor';

const PROVIDER = 'provider-a';
const BOOKING = 901;
const CODE = '482913';

const seed = (o: { assignmentStatus?: string; bookingStatus?: string; workerUid?: string | null; code?: string | null } = {}) => {
  store.booking = {
    id: BOOKING,
    status: o.bookingStatus ?? 'WORKER_ASSIGNED',
    user_id: 'customer-1',
    worker_uid: o.workerUid === undefined ? PROVIDER : o.workerUid,
    worker_code: o.code === undefined ? CODE : o.code,
    schedule: new Date(Date.now() + 240 * 3_600_000).toISOString(),
  };
  store.assignments = [{
    booking_id: BOOKING, worker_uid: PROVIDER,
    status: o.assignmentStatus ?? 'ACCEPTED', started_at: null,
  }];
};

/** The executor's own answer, unflattened. */
const executorStart = (code: string, actorUid = PROVIDER) =>
  transitionBooking({
    action: 'PROVIDER_START', bookingId: BOOKING,
    actorRole: 'assigned_provider', actorUid,
    metadata: { workerCode: code },
  }).catch((e) => e);

beforeEach(() => {
  reset();
  __resetTransitionSchema();
});

describe('START RAW WRITE: REMOVED', () => {
  it('startJob no longer issues its own UPDATE', () => {
    const service = fs.readFileSync(
      path.resolve(__dirname, '../src/services/technicianService.ts'), 'utf8',
    );
    const body = service.slice(
      service.indexOf('export const startJob'),
      service.indexOf('export class UnpaidCashBookingError'),
    );
    expect(body).not.toMatch(/UPDATE \$\{dbSchema\}\.booking_workers/);
    expect(body).toContain("action: 'PROVIDER_START'");
  });

  it('starts the job through the executor', async () => {
    seed();
    const row = await startJob(BOOKING, PROVIDER, CODE);

    expect(store.assignments[0].status).toBe('IN_PROGRESS');
    expect(store.assignments[0].started_at).toBe('2026-08-12T00:00:00.000Z');
    expect(row.status).toBe('IN_PROGRESS');
  });
});

describe('WORKER CODE CHECK: ATOMIC IN EXECUTOR', () => {
  const executor = fs.readFileSync(
    path.resolve(__dirname, '../src/services/booking/transitionExecutor.ts'), 'utf8',
  );
  const stmt = executor.slice(
    executor.indexOf('UPDATE ${s}.booking_workers bw'),
    executor.indexOf('RETURNING bw.booking_id'),
  );

  it('the credential is checked in the SAME statement as the write', () => {
    // A check-then-write leaves a window on the one gate protecting a
    // chargeable job.
    expect(stmt).toContain("SET status = 'IN_PROGRESS'");
    expect(stmt).toContain('b.worker_code = $3');
  });

  it('LIFECYCLE STATE LIST IN SQL: ABSENT', () => {
    // The legacy statement carried bw.status IN ('ACCEPTED','EN_ROUTE',
    // 'ARRIVED') — a second copy of the transition table, maintained
    // separately from the real one. The machine already decided legality
    // under the row lock before this line runs.
    expect(stmt).not.toMatch(/status\s+IN\s*\(/i);
    expect(stmt).not.toContain('EN_ROUTE');
    expect(stmt).not.toContain('ARRIVED');
  });

  it('the state list is gone from technicianService too', () => {
    const service = fs.readFileSync(
      path.resolve(__dirname, '../src/services/technicianService.ts'), 'utf8',
    );
    expect(service).not.toMatch(/bw\.status IN \('ACCEPTED', 'EN_ROUTE', 'ARRIVED'\)/);
  });

  it('all three source states can still start — the point of the old list', async () => {
    // Dropping the SQL list must not narrow what is possible. A provider who
    // tapped "on my way" must still be able to start.
    for (const from of ['ACCEPTED', 'EN_ROUTE', 'ARRIVED']) {
      reset();
      __resetTransitionSchema();
      seed({ assignmentStatus: from });
      await startJob(BOOKING, PROVIDER, CODE);
      expect(store.assignments[0].status).toBe('IN_PROGRESS');
    }
  });
});

describe('the refusal vocabulary, at the executor', () => {
  it('WRONG CODE → WORKER_CODE_INVALID', async () => {
    seed();
    const error = await executorStart('000000');
    expect(error).toBeInstanceOf(TransitionError);
    expect(error.code).toBe('WORKER_CODE_INVALID');
    expect(store.assignments[0].status).toBe('ACCEPTED');
  });

  it('STALE STATE → BOOKING_STATE_CONFLICT', async () => {
    seed({ assignmentStatus: 'EN_ROUTE' });
    const error = await transitionBooking({
      action: 'PROVIDER_START', bookingId: BOOKING,
      actorRole: 'assigned_provider', actorUid: PROVIDER,
      expectedState: 'ACCEPTED',
      metadata: { workerCode: CODE },
    }).catch((e) => e);

    expect(error.code).toBe('BOOKING_STATE_CONFLICT');
    expect(error.detail.currentState).toBe('EN_ROUTE');
  });

  it('INVALID SOURCE STATE → INVALID_TRANSITION', async () => {
    // ASSIGNED: the provider has not accepted yet.
    seed({ assignmentStatus: 'ASSIGNED' });
    const error = await executorStart(CODE);
    expect(error.code).toBe('INVALID_TRANSITION');
  });

  it('TERMINAL → TERMINAL_STATE', async () => {
    seed({ assignmentStatus: 'ACCEPTED', bookingStatus: 'CANCELLED' });
    const error = await executorStart(CODE);
    expect(error.code).toBe('TERMINAL_STATE');
  });

  it('WRONG PROVIDER → NOT_AUTHORIZED, and the code does not help them', async () => {
    seed();
    const error = await executorStart(CODE, 'provider-b');
    expect(error.code).toBe('NOT_AUTHORIZED');
    expect(store.assignments[0].status).toBe('ACCEPTED');
  });

  it('REASSIGNED PROVIDER holding the OLD code: REFUSED', async () => {
    // Reassignment does not clear worker_code, so the departed provider still
    // knows a valid code. Authorization is what stops them, not the credential
    // — which is exactly why the credential check is not the only gate.
    seed();
    store.assignments.push({ booking_id: BOOKING, worker_uid: 'provider-b', status: 'ASSIGNED' });
    store.assignments[0].status = 'REASSIGNED';
    store.booking!.worker_uid = 'provider-b';

    const error = await executorStart(CODE, PROVIDER);
    expect(error).toBeInstanceOf(TransitionError);
    expect(error.code).toBe('NOT_AUTHORIZED');
    expect(store.assignments.find((a) => a.worker_uid === 'provider-b')!.status).toBe('ASSIGNED');
  });

  it('the v1 layer maps each to a distinct client code', () => {
    // The mapping is what makes the executor's vocabulary reach a client.
    const v1 = fs.readFileSync(
      path.resolve(__dirname, '../src/api/v1/domains/bookingActions.ts'), 'utf8',
    );
    expect(v1).toContain("WORKER_CODE_INVALID: 'BOOKING_WORKER_CODE_INVALID'");
    expect(v1).toContain("BOOKING_STATE_CONFLICT: 'BOOKING_STATE_CONFLICT'");
    expect(v1).toContain("INVALID_TRANSITION: 'BOOKING_TRANSITION_INVALID'");
    expect(v1).toContain("TERMINAL_STATE: 'BOOKING_TERMINAL'");
    expect(v1).toContain("NOT_AUTHORIZED: 'BOOKING_ACCESS_DENIED'");
  });
});

describe('the legacy contract is preserved exactly', () => {
  it('a missing code is refused before the executor is touched', async () => {
    seed();
    await expect(startJob(BOOKING, PROVIDER, undefined))
      .rejects.toThrow('worker_code is required to start job');
    expect(store.sql).toEqual([]);
  });

  it('every executor refusal reads as the legacy message', async () => {
    // Both legacy controllers answer 500 for any error here; their clients
    // cannot distinguish the causes today, and changing that is the
    // endpoint's own migration, not this one.
    for (const seedWith of [
      { assignmentStatus: 'ASSIGNED' },
      { bookingStatus: 'CANCELLED' },
    ]) {
      reset();
      __resetTransitionSchema();
      seed(seedWith);
      await expect(startJob(BOOKING, PROVIDER, CODE)).rejects.toThrow('Job cannot be started');
    }

    reset();
    __resetTransitionSchema();
    seed();
    await expect(startJob(BOOKING, PROVIDER, '000000')).rejects.toThrow('Job cannot be started');
  });
});

describe('FAILED EXECUTOR: no side effects', () => {
  it('a wrong code sends no email and posts no chat message', async () => {
    seed();
    await startJob(BOOKING, PROVIDER, '000000').catch(() => undefined);
    await flush();

    expect(calls).toEqual([]);
    expect(store.transitions).toHaveLength(0);
  });

  it('a refused start leaves the assignment untouched', async () => {
    seed({ assignmentStatus: 'ASSIGNED' });
    await startJob(BOOKING, PROVIDER, CODE).catch(() => undefined);
    expect(store.assignments[0].status).toBe('ASSIGNED');
    expect(store.assignments[0].started_at).toBeNull();
  });
});

describe('side effects on success, once', () => {
  it('emails the customer and posts the system message, in order', async () => {
    seed();
    await startJob(BOOKING, PROVIDER, CODE);
    await flush();
    expect(calls).toEqual(['email:booking_started', 'chat:systemMessage']);
  });

  it('IDEMPOTENT REPLAY: no duplicate email or chat message', async () => {
    seed();
    await startJob(BOOKING, PROVIDER, CODE, { idempotencyKey: 's-1' });
    await flush();
    expect(calls).toEqual(['email:booking_started', 'chat:systemMessage']);

    calls.length = 0;
    const replay = await startJob(BOOKING, PROVIDER, CODE, { idempotencyKey: 's-1' });
    await flush();

    expect(calls).toEqual([]);
    expect(replay.status).toBe('IN_PROGRESS');
  });
});

describe('CANONICAL TIMELINE: exactly one START transition', () => {
  it('one row, naming the action and both states', async () => {
    seed();
    await startJob(BOOKING, PROVIDER, CODE);

    expect(store.transitions).toHaveLength(1);
    expect(store.transitions[0]).toMatchObject({
      action: 'PROVIDER_START', from_state: 'ACCEPTED', to_state: 'IN_PROGRESS',
    });
  });

  it('a replay does not add a second', async () => {
    seed();
    await startJob(BOOKING, PROVIDER, CODE, { idempotencyKey: 's-2' });
    await startJob(BOOKING, PROVIDER, CODE, { idempotencyKey: 's-2' });
    expect(store.transitions).toHaveLength(1);
  });

  it('the worker code never reaches the timeline', async () => {
    // §58. The code is a secret the customer reads out; it authorises the
    // transition and is never evidence of it.
    seed();
    await startJob(BOOKING, PROVIDER, CODE);
    expect(JSON.stringify(store.transitions)).not.toContain(CODE);
    const inserts = store.sql.filter((q) => /INSERT INTO servana\.booking_transitions/.test(q));
    expect(inserts).toHaveLength(1);
  });

  it('START writes no booking_tracking row — legacy never did', async () => {
    // Adding one would be new behaviour, not preserved behaviour.
    seed();
    await startJob(BOOKING, PROVIDER, CODE);
    expect(store.tracking).toEqual([]);
  });
});
