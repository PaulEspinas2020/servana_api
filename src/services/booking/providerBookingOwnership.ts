/**
 * "Is this booking this provider's, and what is their status on it?"
 *
 * ## Why this is a module rather than two helpers in a controller
 *
 * Both functions lived in `providerController`, which was fine while only that
 * controller asked the question. TAB 07 publishes canonical evidence and
 * cancellation-eligibility routes that ask the same one, and a domain module
 * importing from a controller is backwards — the dependency runs the wrong way,
 * and it drags an entire controller's imports into anything that wants to test
 * the domain.
 *
 * So the question moved to where the answer belongs. One definition, imported by
 * the legacy controller and the v1 domain alike, so the two surfaces cannot come
 * to different conclusions about who owns a booking.
 *
 * ## Both scope in SQL, not in a check above it
 *
 * `worker_uid = $2` is in the WHERE clause. A provider asking about somebody
 * else's booking gets no row rather than a row plus a comparison somebody has to
 * remember to make — which is the difference between authorization that holds
 * and authorization that held last time anyone looked.
 *
 * ## `ORDER BY id DESC LIMIT 1` is deliberate
 *
 * A booking can be assigned, declined and reassigned to the same provider, which
 * leaves several `booking_workers` rows. The LATEST is the one that describes the
 * current relationship; an older row would answer with a status the provider has
 * already left behind.
 */

import dbQuery from '../../db/dbQuery';
import { db } from '../../config';

const schema = () => db.schema || '';

/**
 * The provider's status on this booking, or null when it is not theirs.
 *
 * Null is returned for "not yours" AND for "no such booking", and callers turn
 * both into the same 404 on purpose: distinguishing them would let a caller
 * enumerate which booking ids exist and which providers hold them.
 */
export const assertOwnBooking = async (
  bookingId: number,
  uid: string,
): Promise<string | null> => {
  const res = await dbQuery.query(
    `SELECT status FROM ${schema()}.booking_workers
      WHERE booking_id = $1 AND worker_uid = $2
      ORDER BY id DESC LIMIT 1`,
    [bookingId, uid],
  );
  return res.rowCount ? String(res.rows[0].status ?? '') : null;
};

/**
 * What the cancellation policy needs to decide: the provider's status and the
 * booking's schedule, read together in one statement.
 *
 * Read TOGETHER rather than in two queries because the policy compares them —
 * a status from one moment and a schedule from another can produce a verdict
 * that was never true of any single state of the booking.
 */
export const loadCancellationContext = async (
  bookingId: number,
  uid: string,
): Promise<{ worker_status: string; schedule: unknown } | null> => {
  const res = await dbQuery.query(
    `SELECT bw.status AS worker_status, b.schedule
       FROM ${schema()}.booking_workers bw
       JOIN ${schema()}.bookings b ON b.id = bw.booking_id
      WHERE bw.booking_id = $1 AND bw.worker_uid = $2
      ORDER BY bw.id DESC LIMIT 1`,
    [bookingId, uid],
  );
  return res.rowCount ? (res.rows[0] as { worker_status: string; schedule: unknown }) : null;
};
