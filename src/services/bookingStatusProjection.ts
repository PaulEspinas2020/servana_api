/**
 * Customer/Provider effective status — now a PROJECTION, not a second opinion.
 *
 * ## What this used to be
 *
 * Nineteen lines that collapsed `bookings.status` and `booking_workers.status`
 * into one value. It was correct as far as it went. The problem was that
 * `adminBookingService.mapOperationsStatus` did the same job with a different
 * vocabulary and different rules, so a provider tapping *en route* produced
 * EN_ROUTE here and `accepted` there. Three surfaces, three truths.
 *
 * ## What it is now
 *
 * A thin adapter over `services/booking/canonicalState.deriveCanonicalState`.
 * The canonical machine decides; this function only translates that decision
 * back into the vocabulary its existing callers already parse.
 *
 * The output is unchanged, deliberately and byte-for-byte. ServanaClient and
 * ServanaWorker read these values today, and the point of the exercise is one
 * source of truth — not a wire change nobody asked for. New readers should call
 * the canonical machine and its projections directly.
 */

import {
  deriveCanonicalState,
  type BookingState,
} from './booking/canonicalState';

/**
 * Canonical state → the legacy effective-status vocabulary.
 *
 * Several canonical states have no legacy name of their own: the old function
 * simply returned the raw `bookings.status` for them. `WORKER_ASSIGNED` is the
 * example that matters — canonical ASSIGNED, but the wire value clients expect
 * is the raw status. So the raw value is passed through for exactly the states
 * where the old code passed it through.
 *
 * CANCELLED deliberately returns the RAW spelling rather than the canonical
 * one. `CANCELED` and `CANCELLED` both exist in production, both reach these
 * clients today, and normalising here would be a wire change on a value they
 * may branch on. This is the compatibility boundary the vocabulary module
 * describes: canonical inside, raw at the edge.
 */
const toLegacyEffective = (state: BookingState, rawBookingStatus: string): string => {
  switch (state) {
    case 'COMPLETED':
      return 'COMPLETED';
    case 'IN_PROGRESS':
      return 'IN_PROGRESS';
    case 'ARRIVED':
      return 'ARRIVED';
    case 'EN_ROUTE':
      return 'EN_ROUTE';
    case 'ACCEPTED':
      return 'ACCEPTED';
    // ASSIGNED, AWAITING_ASSIGNMENT, PENDING_OTP, CANCELLED, EXPIRED, DISPUTED:
    // the old function returned the booking's own status, and so does this.
    default:
      return rawBookingStatus;
  }
};

/**
 * Cross-platform customer/provider projection.
 *
 * `bookings` owns terminal and cancellation state; `booking_workers` owns the
 * provider lifecycle after acceptance. That ordering now lives in
 * `deriveCanonicalState` and is applied identically for Admin.
 */
export const deriveEffectiveBookingStatus = (
  bookingStatus: unknown,
  workerStatus: unknown,
): string => {
  const raw = String(bookingStatus ?? '').toUpperCase();
  const canonical = deriveCanonicalState({ bookingStatus, workerStatus });
  return toLegacyEffective(canonical, raw);
};

/** Test seam — lets the projection be checked independently of the derivation. */
export const __test__ = { toLegacyEffective };
