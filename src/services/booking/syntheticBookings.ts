/**
 * The synthetic-booking exclusion policy, declared in ONE place.
 *
 * A release smoke has to run the real lifecycle against the real database, or
 * it proves nothing about the code that actually ships. The cost is a booking
 * in production that was never real demand. `bookings.is_synthetic` marks it,
 * and this module is the single definition of what that marking MEANS.
 *
 * ## The principle
 *
 *   The synthetic marker changes accounting, reporting and external-risk
 *   treatment. It changes NOTHING about lifecycle semantics.
 *
 * A synthetic booking runs the same canonical executor, takes the same locks,
 * writes the same `booking_workers` rows, the same `booking_transitions` and
 * the same legacy projections, and derives the same `canonicalState`. There is
 * no "test transition" path, because a test path would exercise code that never
 * runs in anger.
 *
 * ## Why the surfaces are a declared inventory
 *
 * Scattering `AND is_synthetic = false` through the codebase would mean the
 * policy lives in thirty places and is enforced in none. Worse, a NEW reporting
 * query would silently include synthetic rows — the failure is invisible,
 * because a KPI that is slightly wrong looks exactly like a KPI that is right.
 *
 * So every query over bookings is classified, once, below. Adding a query
 * without classifying it fails `tests/booking-synthetic-marker.test.ts`, which
 * forces somebody to decide which kind it is rather than defaulting to the
 * wrong one.
 *
 * ## The line between REPORTING and OPERATIONAL
 *
 * REPORTING answers "how is the business doing" — it must exclude synthetic
 * rows, or a release test moves a number somebody makes decisions on.
 *
 * OPERATIONAL answers "what is on the board right now" — it must INCLUDE them,
 * because an admin has to be able to find the smoke booking, watch it move and
 * audit it afterwards. Hiding it from the board would make the smoke
 * unobservable, which defeats the point of running one.
 */

/**
 * The predicate. `= false` rather than `NOT is_synthetic` because the column is
 * `NOT NULL DEFAULT false`, so there is no third state to reason about, and the
 * explicit form reads the same way in a query as it does here.
 */
export const excludeSyntheticSql = (bookingAlias: string): string =>
  `${bookingAlias}.is_synthetic = false`;

/** Ready to append to an existing WHERE. */
export const andExcludeSynthetic = (bookingAlias: string): string =>
  ` AND ${excludeSyntheticSql(bookingAlias)}`;

/**
 * Business reporting. These MUST exclude synthetic bookings.
 *
 * Keyed `file#function`, valued with what the number is used for — because
 * "why is this excluded" is the question a future reader will have, and
 * "because it is in the list" is not an answer.
 */
export const REPORTING_SURFACES: Record<string, string> = {
  'adminDashboardService#bookingAggregations':
    'Executive KPIs — total bookings, completion rate, cancellation rate. The '
    + 'headline numbers, and the ones a synthetic completion would distort most.',
  'adminFinanceService#revenue':
    'Revenue and GMV. A smoke booking carrying a price would report as money '
    + 'the business never took.',
  'providerPerformanceService#providerStats':
    'Provider acceptance, decline, completion and on-time rates. A smoke '
    + 'accept or decline would move a real provider\'s record.',
  'providerSupplyHealthService#demand':
    'Unassigned-demand analytics, used to decide where supply is short. A '
    + 'synthetic booking is not demand and must not pull supply toward itself.',
};

/**
 * Operational surfaces. These deliberately INCLUDE synthetic bookings.
 *
 * Each entry states why hiding the row would be worse than showing it.
 */
export const OPERATIONAL_SURFACES: Record<string, string> = {
  'adminBookingService#getAdminBookings':
    'The board. An admin must be able to SEE the smoke booking and watch it '
    + 'move; a smoke you cannot observe is not a smoke.',
  'adminBookingService#getAdminBookingDetail':
    'Detail view — the audit trail for exactly what the release exercised.',
  'adminBookingService#getAdminBookingMetrics':
    'Tab counts. These index the board rather than report the business, and '
    + 'they must sum to the list total: excluding here while including in the '
    + 'list would make the tabs disagree with the rows underneath them.',
};

/**
 * Money movement is refused for a synthetic booking.
 *
 * Deliberately narrow — ONE check, at the one place money actually leaves the
 * platform (`createDisbursement`, which calls PayMongo). Not a general "test
 * mode": a broad financial bypass is a much larger risk than the one it
 * prevents, and it would also stop the smoke exercising the completion path
 * properly.
 *
 * The refusal is loud rather than silent. A synthetic disbursement that was
 * quietly skipped and a real one that failed look identical in a log, and only
 * one of those is fine.
 */
export class SyntheticFinancialRefusal extends Error {
  readonly code = 'SYNTHETIC_BOOKING_NO_MONEY_MOVEMENT';

  constructor(bookingId: number) {
    super(
      `Refusing real money movement for synthetic booking ${bookingId}. `
      + 'The booking is marked is_synthetic; disbursement would send real funds '
      + 'for a release test.',
    );
    this.name = 'SyntheticFinancialRefusal';
  }
}
