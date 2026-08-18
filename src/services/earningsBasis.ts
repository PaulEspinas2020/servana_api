/**
 * The gross a provider's share is actually computed from.
 *
 * A booking's `final_price` is NOT the whole of what the provider earned.
 * On-site additional work is charged through its own PayMongo checkout and
 * never writes back to `bookings.final_price`, so any reader that treats
 * `final_price` as the gross silently drops that revenue.
 *
 * `createDisbursement` already knew this — it sums paid additional work before
 * splitting, which is why the amount a provider is PAID is correct. The readers
 * did not, so the earnings screens showed a basis that disagreed with the
 * payout: a booking of ₱1,500 with ₱3,500 of approved extra work displayed
 * ₱1,500 as the booking amount beside a ₱4,000 provider share, while the copy
 * beside it said the share was "80% of the booking amount". Production carries
 * exactly that shape already (bookings 58 and 62).
 *
 * This fragment is the one definition of the additional-work component, shared
 * by the writer and every reader so they cannot drift apart again (§10). It was
 * previously inline in `createDisbursement` only.
 *
 * `status = 'PAID'` on the payment row is deliberate and load-bearing: an
 * additional-work request can sit at ACCEPTED, IN_PROGRESS or PROCEEDING
 * without the customer having paid, and paying a provider a share of money
 * Servana never collected turns a shortfall into a loss. Summed from `payments`
 * rather than `booking_additional_requests.total_amount` for the same reason.
 */
/*
 * `schema` is typed as possibly undefined because `db.schema` is — every call
 * site in this codebase already interpolates it directly, so widening here
 * matches the existing risk profile rather than adding a new one.
 */
export const paidAdditionalWorkSql = (schema: string | undefined, bookingAlias = 'b'): string => `
      COALESCE((
        SELECT SUM(p_add.amount)
          FROM ${schema}.payments p_add
         WHERE p_add.booking_id = ${bookingAlias}.id
           AND p_add.additional_request_id IS NOT NULL
           AND p_add.status = 'PAID'
      ), 0)`;

/**
 * Gross for a provider's share: the booking price plus paid additional work.
 *
 * Rounded to centavos because both components are NUMERIC and the split
 * downstream rounds once, at the boundary (see `revenueSplit.ts`).
 */
export const earningsGross = (finalPrice: unknown, additionalPaid: unknown): number => {
  const base = Number(finalPrice ?? 0);
  const extra = Number(additionalPaid ?? 0);
  const total = (Number.isFinite(base) ? base : 0) + (Number.isFinite(extra) ? extra : 0);
  return Math.round(total * 100) / 100;
};
