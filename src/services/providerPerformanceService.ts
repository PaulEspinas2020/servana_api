/**
 * Provider performance metrics for the provider portal's Performance page.
 *
 * The page previously rendered "—" for acceptance and on-time rate with a
 * TODO_BACKEND_STITCH comment, and derived its completed/cancelled counts by
 * filtering whatever jobs the client happened to have loaded — so they were a
 * count of the current page, not of the provider's history.
 *
 * Every rate here is returned as numerator + denominator alongside the ratio,
 * and the ratio is null when the denominator is zero. A provider who has
 * responded to one assignment should not be shown "100% acceptance"; the UI
 * needs the sample size to decide what is honest to display, and an unknown
 * value must never render as a confident one (§3).
 */

import dbQuery from "../db/dbQuery";
import { db } from "../config";

const s = db.schema;

/**
 * Minutes after the scheduled start within which a job still counts as on time.
 * Traffic in Metro Manila makes a zero-tolerance definition meaningless.
 */
export const ON_TIME_GRACE_MINUTES = 15;

/**
 * Both spellings are live in this codebase — technicianService writes
 * 'CANCELED' while providerAvailabilityEngine matches 'CANCELLED'. Counting
 * only one silently under-reports, so match both.
 */
const CANCELLED_STATUSES = ["CANCELLED", "CANCELED"];

export interface RateMetric {
  /** Events in the numerator. */
  count: number;
  /** Events considered — the denominator. Zero means "no data yet". */
  total: number;
  /** count/total rounded to 3dp, or null when total is 0. Never fabricated. */
  rate: number | null;
}

export interface ProviderPerformance {
  acceptance: RateMetric & { declined: number; pending: number };
  onTime: RateMetric & { graceMinutes: number };
  jobs: { completed: number; cancelled: number; assigned: number };
  rating: { average: number | null; reviewCount: number };
}

const ratio = (count: number, total: number): number | null =>
  total > 0 ? Math.round((count / total) * 1000) / 1000 : null;

export const getProviderPerformance = async (
  workerUid: string
): Promise<ProviderPerformance> => {
  const [assignmentRes, cancelledRes, ratingRes] = await Promise.all([
    // A booking that was accepted and then finished reads as COMPLETED, so the
    // acceptance numerator has to include COMPLETED or every finished job would
    // count against the provider. ASSIGNED is still undecided and is therefore
    // excluded from the denominator rather than counted as a refusal.
    dbQuery.query(
      `SELECT
         COUNT(*) FILTER (WHERE bw.status IN ('ACCEPTED','COMPLETED'))        AS accepted,
         COUNT(*) FILTER (WHERE bw.status = 'DECLINED')                       AS declined,
         COUNT(*) FILTER (WHERE bw.status = 'ASSIGNED')                       AS pending,
         COUNT(*) FILTER (WHERE bw.status = 'COMPLETED')                      AS completed,
         COUNT(*) FILTER (WHERE bw.started_at IS NOT NULL)                    AS measured,
         COUNT(*) FILTER (
           WHERE bw.started_at IS NOT NULL
             AND b.schedule IS NOT NULL
             AND bw.started_at <= b.schedule + ($2 * INTERVAL '1 minute')
         )                                                                    AS on_time
       FROM ${s}.booking_workers bw
       JOIN ${s}.bookings b ON b.id = bw.booking_id
       WHERE bw.worker_uid = $1`,
      [workerUid, ON_TIME_GRACE_MINUTES]
    ),
    dbQuery.query(
      `SELECT COUNT(*) AS cancelled
         FROM ${s}.bookings
        WHERE worker_uid = $1 AND status = ANY($2::text[])`,
      [workerUid, CANCELLED_STATUSES]
    ),
    // Aggregate table may hold no row for a provider with no reviews yet —
    // that is a null average, not a zero one. Zero would render as a 0-star
    // rating the provider never earned.
    dbQuery.query(
      `SELECT average_rating, review_count
         FROM ${s}.provider_rating_aggregates
        WHERE provider_uid = $1`,
      [workerUid]
    ),
  ]);

  const a = assignmentRes.rows[0] ?? {};
  const num = (v: any) => Number(v ?? 0);

  const accepted = num(a.accepted);
  const declined = num(a.declined);
  const decided = accepted + declined;
  const onTime = num(a.on_time);
  const measured = num(a.measured);

  const ratingRow = ratingRes.rows[0];

  return {
    acceptance: {
      count: accepted,
      total: decided,
      rate: ratio(accepted, decided),
      declined,
      pending: num(a.pending),
    },
    onTime: {
      count: onTime,
      total: measured,
      rate: ratio(onTime, measured),
      graceMinutes: ON_TIME_GRACE_MINUTES,
    },
    jobs: {
      completed: num(a.completed),
      cancelled: num(cancelledRes.rows[0]?.cancelled),
      assigned: num(a.pending),
    },
    rating: {
      average: ratingRow?.average_rating != null ? Number(ratingRow.average_rating) : null,
      reviewCount: num(ratingRow?.review_count),
    },
  };
};
