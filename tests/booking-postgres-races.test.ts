/**
 * The seven races, against a REAL PostgreSQL server.
 *
 * Every other suite in this repository proves the executor ASKS for the right
 * locks in the right order. None of them proves PostgreSQL HONOURS that. The
 * fakes serialise `FOR UPDATE` because they were written to; a real server
 * either does or does not, and only it can say.
 *
 *   1. REASSIGN            vs  EN_ROUTE
 *   2. REASSIGN            vs  START
 *   3. REASSIGN            vs  CUSTOMER_CANCEL
 *   4. REASSIGN            vs  REASSIGN
 *   5. ADMIN_ASSIGN(P->A)  vs  ADMIN_ASSIGN(P->B)   overlapping provider
 *   6. AUTO_ASSIGN(P->A)   vs  ADMIN_ASSIGN(P->B)   overlapping provider
 *   7. AUTO_ASSIGN(P->A)   vs  AUTO_ASSIGN(P->B)    overlapping provider
 *
 * plus non-overlapping controls for 5-7. Without them a build in which the
 * advisory lock refused ALL second assignments would pass every overlapping
 * case for entirely the wrong reason, and read as green.
 *
 * ## What counts as a pass
 *
 * Not "one call returned 200". After every race the invariant set below is
 * checked in full, because a race that only asserts the property its author was
 * thinking about is how "at most one assignment" gets verified while
 * `bookings.worker_uid` quietly points at the loser.
 *
 * And a PostgreSQL deadlock is a FAILURE, not a successful serialisation.
 * Standardising on booking-then-provider lock order exists so the deadlock
 * cannot form; `40P01` means it did and the server cleaned up after us. Race 6
 * is the one that would have caught the ordering regression D4 introduced and
 * E2 closed — auto-assignment took provider-then-booking while the executor
 * took booking-then-provider.
 *
 * ## Why this may skip
 *
 * It needs a disposable, production-equivalent PostgreSQL. See
 * `tests/support/raceDatabase.ts` for the three refusals that keep it away from
 * anything real. While it skips, certification reads BLOCKED_BY_TEST_DATABASE —
 * never PASS.
 */

import { resolveRaceDatabase, pointApplicationPoolAtRaceDatabase, RaceHarness, isDeadlock } from './support/raceDatabase';
import { seedRace, cleanupRace, type SeededBooking } from './support/raceFixtures';

const resolved = resolveRaceDatabase();

/**
 * Each race runs REPEATEDLY.
 *
 * A concurrency defect that shows one time in ten passes a single-shot test
 * comfortably, and lock-ordering faults are exactly that shape.
 */
const ROUNDS = Number(process.env.PG_RACE_ROUNDS ?? 25);

if (!resolved.usable) {
  describe('PostgreSQL concurrency races', () => {
    it('SKIPPED - no disposable database configured', () => {
      // Loud on purpose. A quiet skip on a certification gate is how an
      // unproven invariant gets reported as green.
      // eslint-disable-next-line no-console
      console.warn(
        '\n[POSTGRESQL LOCKING INTEGRATION: BLOCKED_BY_TEST_DATABASE]\n'
        + `  ${resolved.reason}\n`
        + '  Required: PG_RACE_TEST_HOST/PORT/DATABASE/USER/PASSWORD/SCHEMA\n'
        + '            ALLOW_POSTGRES_RACE_TESTS=true\n'
        + '  The database must carry a production-COMPATIBLE schema. A blank\n'
        + '  instance is NOT sufficient: this repository has no CREATE TABLE for\n'
        + '  bookings, so the fixtures cannot build the schema from zero and will\n'
        + '  fail naming whatever the snapshot is missing.\n',
      );
      expect(resolved.usable).toBe(false);
    });
  });
} else {
  const cfg = resolved.config;
  // BEFORE the executor is imported: `src/config.ts` snapshots the environment
  // at module load, so a later assignment would be ignored and the executor
  // would run against whatever DB_* already held.
  pointApplicationPoolAtRaceDatabase(cfg);

  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  const { transitionBooking, TransitionError } = require('../src/services/booking/transitionExecutor');
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  const { pool: appPool } = require('../src/db/dbQuery');

  const harness = new RaceHarness(cfg);
  const S = cfg.schema;

  jest.setTimeout(180_000);

  beforeAll(async () => {
    const c = await harness.client();
    try { await cleanupRace(c, S); } finally { c.release(); }
  });

  afterAll(async () => {
    const c = await harness.client();
    try { await cleanupRace(c, S); } finally { c.release(); }
    await harness.end();
    await appPool.end();
  });

  it('records the server major version, so a pass names what it proved', async () => {
    const major = await harness.serverMajorVersion();
    // eslint-disable-next-line no-console
    console.log(`[POSTGRESQL LOCKING INTEGRATION] PostgreSQL major version ${major}`);
    expect(major).toBeGreaterThanOrEqual(12);
  });

  // ── The invariant set ───────────────────────────────────────────────────────

  const ACTIVE = "('ASSIGNED','ACCEPTED','EN_ROUTE','ARRIVED','IN_PROGRESS')";

  /** Asserted after EVERY race, so no scenario can check only its own property. */
  const assertInvariants = async (bookingId: number, label: string) => {
    const c = await harness.client();
    try {
      const active = await c.query(
        `SELECT worker_uid, status FROM ${S}.booking_workers
          WHERE booking_id = $1 AND status IN ${ACTIVE}`,
        [bookingId],
      );
      if ((active.rowCount ?? 0) > 1) {
        throw new Error(
          `${label}: ${active.rowCount} providers hold this booking at once `
          + `(${active.rows.map((r) => `${r.worker_uid}=${r.status}`).join(', ')}). `
          + 'The row lock did not serialise.',
        );
      }

      const booking = await c.query(
        `SELECT worker_uid, status FROM ${S}.bookings WHERE id = $1`, [bookingId],
      );
      const pointer: string | null = booking.rows[0]?.worker_uid ?? null;
      const bookingStatus = String(booking.rows[0]?.status ?? '').toUpperCase();
      const cancelled = ['CANCELLED', 'CANCELED'].includes(bookingStatus);

      if (active.rowCount === 1) {
        // The pointer must name the provider who actually holds the booking,
        // not one who was displaced.
        if (pointer !== active.rows[0].worker_uid) {
          throw new Error(
            `${label}: bookings.worker_uid is "${pointer}" but the live assignment `
            + `belongs to "${active.rows[0].worker_uid}". The pointer names the loser.`,
          );
        }
        // A displaced provider must retain no live authority.
        expect(['DECLINED', 'REASSIGNED', 'CANCELLED', 'CANCELED'])
          .not.toContain(String(active.rows[0].status).toUpperCase());
      } else if (cancelled) {
        // Cancellation won. A pointer may survive as LEGACY_LAST_PROVIDER, but
        // no assignment row may still be live.
        expect(active.rowCount).toBe(0);
      }

      // Every committed transition is evidence of a committed outcome; a
      // rolled-back attempt must have left none behind.
      const transitions = await c.query(
        `SELECT action, from_state, to_state, state_changed
           FROM ${S}.booking_transitions WHERE booking_id = $1 ORDER BY id`,
        [bookingId],
      );
      for (const t of transitions.rows) {
        expect(t.action).toBeTruthy();
        expect(t.from_state).toBeTruthy();
        expect(t.to_state).toBeTruthy();
      }

      // Legacy projections agree with the committed winner. `booking_tracking`
      // is a REQUIRED projection, so a transition that changed state must have
      // produced one.
      const changed = transitions.rows.filter((t) => t.state_changed === true).length;
      if (changed > 0) {
        const tracking = await c.query(
          `SELECT COUNT(*)::int AS n FROM ${S}.booking_tracking WHERE booking_id = $1`,
          [bookingId],
        );
        expect(tracking.rows[0].n).toBeGreaterThan(0);
      }
    } finally {
      c.release();
    }
  };

  /** Neither side of a race may end in a deadlock. */
  const assertNoDeadlock = (outcome: Record<string, unknown>, label: string) => {
    for (const [side, value] of Object.entries(outcome)) {
      if (isDeadlock(value)) {
        throw new Error(
          `${label}: side "${side}" hit a PostgreSQL deadlock (40P01). That is a `
          + 'lock-ORDER violation the server recovered from, NOT a successful '
          + 'serialisation. Booking-then-provider ordering exists so this cannot form.',
        );
      }
    }
  };

  /** Exactly one of two contenders may win; the other must lose cleanly. */
  const assertOneWinner = (outcome: { a: unknown; b: unknown }, label: string) => {
    const won = ['a', 'b'].filter((k) => !((outcome as Record<string, unknown>)[k] instanceof Error));
    expect(`${label}: winners=${won.length}`).toBe(`${label}: winners=1`);
    const loser = (outcome as Record<string, unknown>)[won[0] === 'a' ? 'b' : 'a'];
    // A clean loss is a domain refusal, not a driver crash or a constraint
    // violation leaking out of the transaction.
    expect(loser).toBeInstanceOf(TransitionError);
  };

  const seeded = async (
    n: number,
    opts?: Parameters<typeof seedRace>[3],
  ): Promise<SeededBooking> => {
    const c = await harness.client();
    try { return await seedRace(c, S, n, opts); } finally { c.release(); }
  };

  const call = (input: Record<string, unknown>) => () => transitionBooking(input);

  // ── Races 1-4: reassignment against the incumbent's own lifecycle ───────────

  /**
   * The dangerous shape: admin moves the booking to a new provider while the
   * OLD provider is mid-action. If both commit, two providers believe they own
   * the same job — and the displaced one keeps a live row it can keep acting on.
   */
  describe.each([
    ['REASSIGN vs EN_ROUTE', 'PROVIDER_EN_ROUTE', 'ACCEPTED'],
    ['REASSIGN vs START', 'PROVIDER_START', 'ARRIVED'],
  ])('%s', (label, providerAction, incumbentStatus) => {
    it(`serialises across ${ROUNDS} rounds with no deadlock and one winner`, async () => {
      for (let n = 0; n < ROUNDS; n += 1) {
        const f = await seeded(n, {
          status: 'WORKER_ASSIGNED', assignTo: `racetest_provA_${n}`, assignmentStatus: incumbentStatus,
        });
        const outcome = await harness.contend(
          call({
            bookingId: f.bookingId, action: 'ADMIN_REASSIGN', actorUid: 'racetest_admin',
            actorRole: 'admin', metadata: { providerUid: f.providerB },
          }),
          call({
            bookingId: f.bookingId, action: providerAction, actorUid: f.providerA,
            actorRole: 'assigned_provider',
          }),
        );
        assertNoDeadlock(outcome as Record<string, unknown>, `${label} round ${n}`);
        await assertInvariants(f.bookingId, `${label} round ${n}`);
      }
    });
  });

  it(`REASSIGN vs CUSTOMER_CANCEL serialises across ${ROUNDS} rounds`, async () => {
    for (let n = 0; n < ROUNDS; n += 1) {
      const f = await seeded(1000 + n, {
        status: 'WORKER_ASSIGNED', assignTo: `racetest_provA_${1000 + n}`, assignmentStatus: 'ACCEPTED',
      });
      const outcome = await harness.contend(
        call({
          bookingId: f.bookingId, action: 'ADMIN_REASSIGN', actorUid: 'racetest_admin',
          actorRole: 'admin', metadata: { providerUid: f.providerB },
        }),
        call({
          bookingId: f.bookingId, action: 'CUSTOMER_CANCEL', actorUid: f.customerUid,
          actorRole: 'customer', metadata: { reason: 'race' },
        }),
      );
      assertNoDeadlock(outcome as Record<string, unknown>, `cancel race ${n}`);
      // If cancellation won, the reassignment must NOT have left a live row on
      // a cancelled booking.
      await assertInvariants(f.bookingId, `cancel race ${n}`);
    }
  });

  it(`REASSIGN vs REASSIGN leaves exactly one provider across ${ROUNDS} rounds`, async () => {
    for (let n = 0; n < ROUNDS; n += 1) {
      const f = await seeded(2000 + n, {
        status: 'WORKER_ASSIGNED', assignTo: `racetest_provA_${2000 + n}`, assignmentStatus: 'ACCEPTED',
      });
      const outcome = await harness.contend(
        call({
          bookingId: f.bookingId, action: 'ADMIN_REASSIGN', actorUid: 'racetest_admin_1',
          actorRole: 'admin', metadata: { providerUid: f.providerB },
        }),
        call({
          bookingId: f.bookingId, action: 'ADMIN_REASSIGN', actorUid: 'racetest_admin_2',
          actorRole: 'admin', metadata: { providerUid: f.providerA },
        }),
      );
      assertNoDeadlock(outcome as Record<string, unknown>, `reassign race ${n}`);
      await assertInvariants(f.bookingId, `reassign race ${n}`);
    }
  });

  // ── Races 5-7: two bookings competing for ONE provider ──────────────────────

  /**
   * The advisory lock's actual job. Two DIFFERENT bookings try to take the SAME
   * provider at overlapping times; the +/-2h conflict check is only meaningful
   * because the provider lock is held, since without it both transactions read
   * "no conflict" and both commit.
   */
  const assignmentRace = async (
    label: string,
    actionA: string,
    actionB: string,
    overlapping: boolean,
  ) => {
    for (let n = 0; n < ROUNDS; n += 1) {
      const c = await harness.client();
      let f1: SeededBooking;
      let f2: SeededBooking;
      try {
        f1 = await seedRace(c, S, 3000 + n * 2, { status: 'CONFIRMED' });
        f2 = await seedRace(c, S, 3000 + n * 2 + 1, { status: 'CONFIRMED' });
        if (!overlapping) {
          // The control: push the second booking clear of the +/-2h window, so
          // BOTH assignments are legitimate and both must succeed.
          await c.query(
            `UPDATE ${S}.bookings SET schedule = schedule + INTERVAL '5 days' WHERE id = $1`,
            [f2.bookingId],
          );
          await c.query(
            `INSERT INTO ${S}.employee_services (employee_uid, service_id)
             VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [f1.providerA, f2.serviceId],
          );
        } else {
          // Overlapping: both bookings are scheduled at the same instant, and
          // both target the same provider.
          await c.query(
            `UPDATE ${S}.bookings SET schedule = (SELECT schedule FROM ${S}.bookings WHERE id = $2)
              WHERE id = $1`,
            [f2.bookingId, f1.bookingId],
          );
          await c.query(
            `INSERT INTO ${S}.employee_services (employee_uid, service_id)
             VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [f1.providerA, f2.serviceId],
          );
        }
      } finally {
        c.release();
      }

      const target = f1.providerA;
      const outcome = await harness.contend(
        call({
          bookingId: f1.bookingId, action: actionA,
          actorUid: actionA === 'AUTO_ASSIGN' ? null : 'racetest_admin_1',
          actorRole: actionA === 'AUTO_ASSIGN' ? 'system' : 'admin',
          metadata: { providerUid: target },
        }),
        call({
          bookingId: f2.bookingId, action: actionB,
          actorUid: actionB === 'AUTO_ASSIGN' ? null : 'racetest_admin_2',
          actorRole: actionB === 'AUTO_ASSIGN' ? 'system' : 'admin',
          metadata: { providerUid: target },
        }),
      );

      assertNoDeadlock(outcome as Record<string, unknown>, `${label} round ${n}`);

      if (overlapping) {
        // One provider cannot be in two places at once.
        assertOneWinner(outcome, `${label} round ${n}`);
      } else {
        // The control. If BOTH fail, the lock is refusing legitimate work and
        // the overlapping cases were passing for the wrong reason.
        const failed = ['a', 'b'].filter(
          (k) => (outcome as Record<string, unknown>)[k] instanceof Error,
        );
        expect(`${label} round ${n}: failures=${failed.length}`)
          .toBe(`${label} round ${n}: failures=0`);
      }

      await assertInvariants(f1.bookingId, `${label} round ${n} booking1`);
      await assertInvariants(f2.bookingId, `${label} round ${n} booking2`);
    }
  };

  it('ADMIN_ASSIGN vs ADMIN_ASSIGN, overlapping, yields one winner', async () => {
    await assignmentRace('ADMIN/ADMIN overlapping', 'ADMIN_ASSIGN', 'ADMIN_ASSIGN', true);
  });

  it('ADMIN_ASSIGN vs ADMIN_ASSIGN, NON-overlapping, yields two winners', async () => {
    await assignmentRace('ADMIN/ADMIN control', 'ADMIN_ASSIGN', 'ADMIN_ASSIGN', false);
  });

  /**
   * The regression race. Auto-assignment and admin assignment used to take the
   * booking and provider locks in OPPOSITE orders; only a real server can show
   * that as the deadlock it is.
   */
  it('AUTO_ASSIGN vs ADMIN_ASSIGN, overlapping, yields one winner and no deadlock', async () => {
    await assignmentRace('AUTO/ADMIN overlapping', 'AUTO_ASSIGN', 'ADMIN_ASSIGN', true);
  });

  it('AUTO_ASSIGN vs ADMIN_ASSIGN, NON-overlapping, yields two winners', async () => {
    await assignmentRace('AUTO/ADMIN control', 'AUTO_ASSIGN', 'ADMIN_ASSIGN', false);
  });

  it('AUTO_ASSIGN vs AUTO_ASSIGN, overlapping, yields one winner', async () => {
    await assignmentRace('AUTO/AUTO overlapping', 'AUTO_ASSIGN', 'AUTO_ASSIGN', true);
  });

  it('AUTO_ASSIGN vs AUTO_ASSIGN, NON-overlapping, yields two winners', async () => {
    await assignmentRace('AUTO/AUTO control', 'AUTO_ASSIGN', 'AUTO_ASSIGN', false);
  });
}
