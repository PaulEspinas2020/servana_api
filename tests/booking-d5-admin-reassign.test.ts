/**
 * D5 — ADMIN_REASSIGN on the canonical executor.
 *
 *   SAME PROVIDER                       IDEMPOTENT_NO_OP
 *   SAME PROVIDER ON CANCELLED          preserved success / zero writes
 *   SAME PROVIDER ON COMPLETED          preserved success / zero writes
 *   REAL REASSIGN SOURCE STATES         ASSIGNED / ACCEPTED / EN_ROUTE / ARRIVED
 *   IN_PROGRESS                         refused, legacy message preserved
 *   ROLE 4 TARGET                       accepted
 *   LOCK ORDER                          booking → incoming provider
 *   OUTGOING ASSIGNMENT                 closed, never overwritten
 *   OUTGOING LEGACY STATUS              DECLINED
 *   CANONICAL EVIDENCE                  ADMIN_REASSIGN
 *   DECLINED + EVIDENCE                 same transaction
 *   ACTIVE ASSIGNMENTS AFTER COMMIT     exactly 1
 *   CANONICAL STATE                     ASSIGNED
 *   OLD PROVIDER AFTER COMMIT           refused
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' } }));
jest.mock('../src/db/dbQuery', () => require('./support/bookingDbFake').dbMock);
jest.mock('../src/db/mongodbQuery', () => ({ __esModule: true, default: {} }));

import fs from 'fs';
import path from 'path';
import { store, reset } from './support/bookingDbFake';
import {
  transitionBooking,
  TransitionError,
  BOOKING_ACTIONS,
  __resetTransitionSchema,
} from '../src/services/booking/transitionExecutor';
import { deriveCanonicalState } from '../src/services/booking/canonicalState';

const ADMIN = 'admin-1';
const OLD_PROVIDER = 'provider-a';
const NEW_PROVIDER = 'provider-b';
const BOOKING = 1501;

const codeOf = (rel: string): string =>
  fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

const seed = (o: { bookingStatus?: string; assignmentStatus?: string } = {}) => {
  store.booking = {
    id: BOOKING,
    status: o.bookingStatus ?? 'WORKER_ASSIGNED',
    user_id: 'customer-1',
    worker_uid: OLD_PROVIDER,
    worker_code: '123456',
    schedule: new Date(Date.now() + 240 * 3_600_000).toISOString(),
  };
  store.assignments = [{
    booking_id: BOOKING, worker_uid: OLD_PROVIDER,
    status: o.assignmentStatus ?? 'ACCEPTED',
  }];
};

const reassign = (to = NEW_PROVIDER) =>
  transitionBooking({
    action: 'ADMIN_REASSIGN', bookingId: BOOKING,
    actorRole: 'admin', actorUid: ADMIN,
    metadata: {
      providerUid: to, fromProviderUid: OLD_PROVIDER, toProviderUid: to,
      providerName: 'Pro Vider', reason: 'customer request',
    },
  });

const activeRows = () => store.assignments.filter(
  (a) => ['ASSIGNED', 'ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'IN_PROGRESS'].includes(String(a.status)),
);

beforeEach(() => {
  reset();
  __resetTransitionSchema();
});

describe('SAME PROVIDER is an idempotent no-op', () => {
  it('is declared on the action, not inferred from from === to', () => {
    expect((BOOKING_ACTIONS.ADMIN_REASSIGN as { sameTarget?: string }).sameTarget)
      .toBe('IDEMPOTENT_NO_OP');
  });

  it('succeeds and writes absolutely nothing', async () => {
    seed();
    const result = await reassign(OLD_PROVIDER);

    expect(result.noOp).toBe(true);
    expect(result.stateChanged).toBe(false);

    expect(store.assignments).toHaveLength(1);
    expect(store.assignments[0].status).toBe('ACCEPTED');
    expect(store.booking).toMatchObject({
      worker_uid: OLD_PROVIDER, status: 'WORKER_ASSIGNED', worker_code: '123456',
    });
    expect(store.transitions).toHaveLength(0);
    expect(store.tracking).toHaveLength(0);
    expect(store.timelineEvents).toHaveLength(0);
  });

  it('takes no advisory lock and issues no write of any kind', async () => {
    seed();
    await reassign(OLD_PROVIDER);
    expect(store.sql.some((q) => /pg_advisory_xact_lock/.test(q))).toBe(false);
    expect(store.sql.filter((q) => /^UPDATE|^INSERT/i.test(q))).toEqual([]);
  });

  /**
   * The no-op is checked BEFORE the terminal guard, exactly as legacy did.
   * Odd-looking, and harmless: nothing is written on this path at all.
   */
  it.each(['CANCELLED', 'COMPLETED'])(
    'still succeeds on a %s booking — measured precedence, preserved',
    async (bookingStatus) => {
      seed({ bookingStatus, assignmentStatus: bookingStatus });
      const result = await reassign(OLD_PROVIDER);

      expect(result.noOp).toBe(true);
      expect(store.booking?.status).toBe(bookingStatus);
      expect(store.transitions).toHaveLength(0);
    },
  );

  it('a DIFFERENT provider on a terminal booking is still refused', () => {
    // The no-op precedence must not become a general terminal-state bypass.
    seed({ bookingStatus: 'CANCELLED', assignmentStatus: 'CANCELLED' });
    return reassign(NEW_PROVIDER).then(
      () => { throw new Error('a cancelled booking was reassigned'); },
      (error) => {
        expect(error).toBeInstanceOf(TransitionError);
        expect(store.transitions).toHaveLength(0);
      },
    );
  });
});

describe('a real reassignment', () => {
  it.each(['ASSIGNED', 'ACCEPTED', 'EN_ROUTE', 'ARRIVED'])(
    'moves a booking whose provider is %s',
    async (assignmentStatus) => {
      seed({ assignmentStatus });
      const result = await reassign();

      expect(result.toState).toBe('ASSIGNED');
      expect(result.noOp).toBe(false);
      expect(result.stateChanged).toBe(true);
    },
  );

  it('closes the outgoing row as DECLINED without overwriting it', async () => {
    seed({ assignmentStatus: 'EN_ROUTE' });
    await reassign();

    const outgoing = store.assignments.find((a) => a.worker_uid === OLD_PROVIDER);
    expect(outgoing).toBeDefined();
    expect(outgoing!.status).toBe('DECLINED');
  });

  it('leaves EXACTLY ONE active assignment, and it is the new provider', async () => {
    seed({ assignmentStatus: 'EN_ROUTE' });
    await reassign();

    expect(activeRows()).toHaveLength(1);
    expect(activeRows()[0].worker_uid).toBe(NEW_PROVIDER);
    expect(store.booking?.worker_uid).toBe(NEW_PROVIDER);
  });

  it('resets the canonical state to ASSIGNED, discarding the old progression', async () => {
    // The new provider is not on the way. Carrying EN_ROUTE across would tell
    // the customer somebody is arriving who has not left.
    seed({ assignmentStatus: 'EN_ROUTE' });
    await reassign();

    expect(deriveCanonicalState({
      bookingStatus: store.booking?.status,
      workerStatus: activeRows()[0].status,
      workerUid: store.booking?.worker_uid,
    })).toBe('ASSIGNED');
  });

  it('records ADMIN_REASSIGN as the canonical evidence', async () => {
    seed();
    await reassign();
    expect(store.transitions).toHaveLength(1);
    expect(store.transitions[0]).toMatchObject({
      action: 'ADMIN_REASSIGN', to_state: 'ASSIGNED', state_changed: true,
    });
  });

  it('records the override: actor, reason, outgoing and incoming provider', async () => {
    /**
     * The four facts that make a manual override reviewable months later.
     * Asserted on the ROW rather than on the call, because the caller's
     * arguments prove only what was intended, not what was kept.
     */
    seed();
    await reassign();

    expect(store.timelineEvents[0]).toMatchObject({
      event_type: 'provider_reassigned',
      actor_type: 'admin',
      actor_uid: ADMIN,
      description: 'customer request',
    });
    // Stored as JSON text, so it is parsed rather than matched as a string —
    // a substring check would pass on a metadata bag that had the two uids the
    // wrong way round.
    const metadata = JSON.parse(String(store.timelineEvents[0].metadata));
    expect(metadata).toMatchObject({
      fromProviderUid: OLD_PROVIDER,
      toProviderUid: NEW_PROVIDER,
    });
  });

  it('REFUSES the override outright when no reason is given', async () => {
    /**
     * Enforced by the action declaration, not by the admin service.
     *
     * `adminBookingService.adminReassignProvider` throws on a blank reason and
     * always has. That protected one path: any other caller reaching the
     * executor directly — an internal script, a future controller, a job — could
     * move a job between providers and leave a timeline entry with an empty
     * description. `requiresReason` closes it structurally.
     */
    expect((BOOKING_ACTIONS.ADMIN_REASSIGN as { requiresReason?: boolean }).requiresReason)
      .toBe(true);

    seed();
    const error = await transitionBooking({
      action: 'ADMIN_REASSIGN', bookingId: BOOKING,
      actorRole: 'admin', actorUid: ADMIN,
      metadata: { providerUid: NEW_PROVIDER, providerName: 'Pro Vider' },
    }).catch((e) => e);

    expect(error).toBeInstanceOf(TransitionError);
    expect(error.code).toBe('GUARD_FAILED');
    expect(error.detail).toMatchObject({ missing: 'reason' });
  });

  it('refuses whitespace as a reason, and writes nothing when it does', async () => {
    // A space satisfies "a reason was supplied" and answers nothing.
    seed();
    const error = await transitionBooking({
      action: 'ADMIN_REASSIGN', bookingId: BOOKING,
      actorRole: 'admin', actorUid: ADMIN,
      metadata: { providerUid: NEW_PROVIDER, reason: '   ' },
    }).catch((e) => e);

    expect(error).toBeInstanceOf(TransitionError);
    // Refused BEFORE any write: the outgoing provider still holds the job.
    expect(store.booking).toMatchObject({ worker_uid: OLD_PROVIDER });
    expect(store.transitions).toHaveLength(0);
    expect(store.timelineEvents).toHaveLength(0);
    expect(activeRows()).toHaveLength(1);
  });

  it('writes both legacy projections, with the interpolated title', async () => {
    seed();
    await reassign();
    expect(store.tracking).toEqual([
      { booking_id: BOOKING, status: 'WORKER_ASSIGNED', note: 'Provider reassigned by admin' },
    ]);
    expect(store.timelineEvents[0]).toMatchObject({
      event_type: 'provider_reassigned',
      title: 'Provider reassigned to Pro Vider',
      actor_type: 'admin',
    });
  });

  it('the OLD provider can no longer act on the booking', async () => {
    seed({ assignmentStatus: 'EN_ROUTE' });
    await reassign();

    const error = await transitionBooking({
      action: 'PROVIDER_ARRIVED', bookingId: BOOKING,
      actorRole: 'assigned_provider', actorUid: OLD_PROVIDER,
    }).catch((e) => e);

    expect(error).toBeInstanceOf(TransitionError);
    expect(error.code).toBe('NOT_AUTHORIZED');
  });

  it('IN_PROGRESS is refused — work already started', async () => {
    seed({ assignmentStatus: 'IN_PROGRESS' });
    const error = await reassign().catch((e) => e);
    expect(error).toBeInstanceOf(TransitionError);
    expect(store.transitions).toHaveLength(0);
  });

  it('the IN_PROGRESS refusal is the MACHINE, not a second source-state check', () => {
    // `from` omits IN_PROGRESS. The legacy sentence is produced by translating
    // the machine's refusal at the service boundary, not by reimplementing the
    // check there.
    expect((BOOKING_ACTIONS.ADMIN_REASSIGN as { from?: readonly string[] }).from)
      .toEqual(['ASSIGNED', 'ACCEPTED', 'EN_ROUTE', 'ARRIVED']);

    const svc = codeOf('src/services/adminBookingService.ts');
    const fn = svc.slice(
      svc.indexOf('export const adminReassignProvider'),
      svc.indexOf('export const adminRescheduleBooking'),
    );
    expect(fn).not.toMatch(/currentWorkerStatus/);
    expect(fn).not.toMatch(/\['IN_PROGRESS','COMPLETED'\]/);
    expect(fn).toContain('Booking cannot be reassigned while provider status is IN_PROGRESS');
  });
});

describe('ROLE 4 targets are accepted', () => {
  it('the incoming-provider lookup uses the canonical role predicate', () => {
    const executor = codeOf('src/services/booking/transitionExecutor.ts');
    expect(executor).toContain("providerRoleSqlPredicate('role')");
    expect(executor).not.toMatch(/role::int\s*=\s*2/);

    // And the legacy literal is gone from the service entirely.
    const svc = codeOf('src/services/adminBookingService.ts');
    expect(svc).not.toMatch(/role::int\s*=\s*2/);
  });
});

/**
 * DECLINED and the canonical evidence must be atomic.
 *
 * DECLINED serves two live consumers — the matching exclusion and the
 * provider's acceptance rate. If it could land without the ADMIN_REASSIGN row,
 * a provider would be excluded from a booking with no recorded explanation of
 * why; the inverse would record a reassignment that the matching engine never
 * saw.
 */
describe('DECLINED and the canonical evidence are one transaction', () => {
  it('both are written inside the same transaction', async () => {
    seed();
    await reassign();
    const tx = store.inTransaction.join(' | ');
    expect(tx).toContain("UPDATE servana.booking_workers SET status = 'DECLINED'");
    expect(tx).toContain('INSERT INTO servana.booking_transitions');
  });

  it('a failed legacy projection leaves the outgoing row UNTOUCHED', async () => {
    // The inverse failure: matching exclusion must not change without the
    // canonical explanation surviving with it.
    seed({ assignmentStatus: 'ACCEPTED' });
    store.trackingFails = true;

    await expect(reassign()).rejects.toThrow();

    expect(store.assignments.find((a) => a.worker_uid === OLD_PROVIDER)!.status)
      .toBe('ACCEPTED');
    expect(store.assignments.find((a) => a.worker_uid === NEW_PROVIDER)).toBeUndefined();
    expect(store.booking?.worker_uid).toBe(OLD_PROVIDER);
    expect(store.transitions).toHaveLength(0);
    expect(store.sql).not.toContain('COMMIT');
  });

  it('a failed timeline event rolls the whole reassignment back too', async () => {
    seed({ assignmentStatus: 'ACCEPTED' });
    store.timelineEventFails = true;

    await expect(reassign()).rejects.toThrow();
    expect(activeRows()).toHaveLength(1);
    expect(activeRows()[0].worker_uid).toBe(OLD_PROVIDER);
    expect(store.transitions).toHaveLength(0);
  });
});

describe('lock order and scope', () => {
  it('the advisory lock is taken on the INCOMING provider only', async () => {
    seed();
    await reassign();
    const locks = store.sql.filter((q) => /pg_advisory_xact_lock/.test(q));
    expect(locks).toHaveLength(1);
  });

  it('the booking row is locked before the advisory lock', async () => {
    seed();
    await reassign();
    const bookingLock = store.sql.findIndex((q) => /FOR UPDATE/.test(q));
    const advisory = store.sql.findIndex((q) => /pg_advisory_xact_lock/.test(q));
    expect(bookingLock).toBeGreaterThan(-1);
    expect(advisory).toBeGreaterThan(bookingLock);
  });

  it('the outgoing provider gets NO advisory lock', () => {
    // The booking row lock serialises the outgoing side. A second
    // provider-scoped lock would be a second ordering to get wrong, for an
    // invariant that does not span bookings.
    const executor = codeOf('src/services/booking/transitionExecutor.ts');
    expect(executor).not.toMatch(/servana-provider-assignment:\$\{(?:from|outgoing)/);
    expect(executor).toContain('`servana-provider-assignment:${target}`');
  });
});
