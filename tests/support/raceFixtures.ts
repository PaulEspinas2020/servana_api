/**
 * Disposable rows for the real-PostgreSQL concurrency suite.
 *
 * Only the columns the executor actually reads are populated. Everything else
 * is left to the schema's own defaults, which is deliberate: naming columns the
 * executor does not touch would make the fixture drift out of step with
 * production without anything noticing, and a fixture that has to be maintained
 * separately from the code it exercises stops being evidence.
 *
 * If the target database's schema requires a column this does not supply, the
 * INSERT fails loudly with PostgreSQL's own message. That is the correct
 * outcome — it names exactly what a production-compatible snapshot is missing —
 * and it is why nothing here tries to CREATE the schema. This repository does
 * not contain `CREATE TABLE bookings`; the table is created outside it. A
 * hand-written approximation would run, and would certify nothing.
 */

import type { PoolClient } from 'pg';

/** Everything this suite creates carries the marker, so cleanup is total. */
export const RACE_TAG = 'racetest';

export interface SeededBooking {
  bookingId: number;
  customerUid: string;
  serviceId: number;
  serviceOptionId: number;
  /** Providers A and B, both qualified, both assignable. */
  providerA: string;
  providerB: string;
}

const uid = (label: string, n: number) => `${RACE_TAG}_${label}_${n}`;

/** Provider roles come from the canonical set, not a literal — role 4 is one too. */
import { PROVIDER_ROLES } from '../../src/constants/providerRoles';

const providerRole = (): number => Number([...PROVIDER_ROLES][0]);

async function seedProvider(c: PoolClient, schema: string, providerUid: string, serviceId: number) {
  await c.query(
    `INSERT INTO ${schema}.user_credentials (uid, first_name, last_name, role, is_archive)
     VALUES ($1, $2, 'Racetest', $3, false)
     ON CONFLICT (uid) DO UPDATE SET is_archive = false, role = EXCLUDED.role`,
    [providerUid, providerUid, providerRole()],
  );
  await c.query(
    `INSERT INTO ${schema}.employee_services (employee_uid, service_id)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [providerUid, serviceId],
  );
}

/**
 * One booking, one customer, two qualified providers.
 *
 * `n` makes every round's rows distinct: reusing one booking id across rounds
 * would let a leaked lock or an uncleaned row from round 3 decide round 4, and
 * the suite would be measuring its own residue.
 */
export async function seedRace(
  c: PoolClient,
  schema: string,
  n: number,
  opts: { status?: string; assignTo?: string | null; assignmentStatus?: string } = {},
): Promise<SeededBooking> {
  const customerUid = uid('cust', n);
  const providerA = uid('provA', n);
  const providerB = uid('provB', n);

  await c.query(
    `INSERT INTO ${schema}.user_credentials (uid, first_name, last_name, role, is_archive)
     VALUES ($1, 'Racetest', 'Customer', 1, false)
     ON CONFLICT (uid) DO NOTHING`,
    [customerUid],
  );

  // A service and an option for it. The executor resolves a booking's service
  // through `service_options`, so the join must be real.
  const service = await c.query(
    `INSERT INTO ${schema}.services (name) VALUES ($1) RETURNING id`,
    [`${RACE_TAG} service ${n}`],
  );
  const serviceId = Number(service.rows[0].id);

  const option = await c.query(
    `INSERT INTO ${schema}.service_options (service_id, name) VALUES ($1, $2) RETURNING id`,
    [serviceId, `${RACE_TAG} option ${n}`],
  );
  const serviceOptionId = Number(option.rows[0].id);

  await seedProvider(c, schema, providerA, serviceId);
  await seedProvider(c, schema, providerB, serviceId);

  // Scheduled far enough out that the provider-cancellation window and the
  // +/-2h conflict check both behave as they would for a normal future job.
  const booking = await c.query(
    `INSERT INTO ${schema}.bookings (user_id, status, worker_uid, schedule, service_option_id)
     VALUES ($1, $2, $3, NOW() + INTERVAL '30 days', $4)
     RETURNING id`,
    [customerUid, opts.status ?? 'CONFIRMED', opts.assignTo ?? null, serviceOptionId],
  );
  const bookingId = Number(booking.rows[0].id);

  if (opts.assignTo) {
    await c.query(
      `INSERT INTO ${schema}.booking_workers (booking_id, worker_uid, status, assigned_at)
       VALUES ($1, $2, $3, NOW())`,
      [bookingId, opts.assignTo, opts.assignmentStatus ?? 'ACCEPTED'],
    );
  }

  return { bookingId, customerUid, serviceId, serviceOptionId, providerA, providerB };
}

/**
 * Removes every row the suite created.
 *
 * Ordered child-first so foreign keys, if the snapshot has them, do not refuse
 * the delete. It is written to be safe to run twice.
 */
export async function cleanupRace(c: PoolClient, schema: string): Promise<void> {
  const like = `${RACE_TAG}%`;
  const bookings = `SELECT id FROM ${schema}.bookings WHERE user_id LIKE '${like}'`;

  for (const table of ['booking_transitions', 'booking_timeline_events', 'booking_tracking', 'booking_workers']) {
    await c.query(`DELETE FROM ${schema}.${table} WHERE booking_id IN (${bookings})`).catch(() => {});
  }
  await c.query(`DELETE FROM ${schema}.bookings WHERE user_id LIKE $1`, [like]).catch(() => {});
  await c.query(`DELETE FROM ${schema}.employee_services WHERE employee_uid LIKE $1`, [like]).catch(() => {});
  await c.query(`DELETE FROM ${schema}.service_options WHERE name LIKE $1`, [like]).catch(() => {});
  await c.query(`DELETE FROM ${schema}.services WHERE name LIKE $1`, [like]).catch(() => {});
  await c.query(`DELETE FROM ${schema}.user_credentials WHERE uid LIKE $1`, [like]).catch(() => {});
}
