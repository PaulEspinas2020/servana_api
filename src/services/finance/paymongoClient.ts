/**
 * The PayMongo TRANSPORT — credentials, base URL, timeout. Nothing else.
 *
 * ## Why this exists, and why it is deliberately thin
 *
 * Servana has three distinct money capabilities, and they stay distinct:
 *
 *   payment      services/paymentService.ts       checkout / capture
 *   refund       services/refund.service.ts       reversal
 *   disbursement services/disbursement.service.ts provider payout
 *
 * They are not variations of one operation. A refund is irreversible, a payout
 * moves money to a third party, and a checkout is customer-initiated — different
 * authorization, different idempotency, different failure handling. Merging them
 * behind one "payments" service would put three different risk profiles in one
 * blast radius, so this module does NOT do that.
 *
 * What all three genuinely shared was the transport: the same secret key, the
 * same base URL, the same 15-second timeout — resolved and rebuilt independently
 * in each file. That is the part worth having once.
 *
 * ## The incident this closes
 *
 * `disbursement.service` carried the note: "Keeping a separate PAYMONGO_SK
 * variable made payouts silently run in a different mode." Three copies of the
 * key contract is exactly how that happens again — one of them gets edited.
 * `tests/paymongo-payout-retry-boundary.test.ts` was written to guard it by
 * asserting the literal env expression appeared in the payout file. This makes
 * the guarantee STRUCTURAL instead: there is one resolver, and the test now
 * asserts all three services use it and none reads the environment directly.
 *
 * ## Resolved at CALL time, never at module load
 *
 * `paymentService` previously captured the key in a module-level `const`, while
 * the other two read `process.env` inside the function. That is a real
 * divergence: with dotenv loaded after import, the module-level copy is
 * permanently empty while the call-time copies work. Call time is the safer of
 * the two behaviours — it can only start working where the other would already
 * have failed — so it is the one kept here.
 *
 * ## What this does NOT do
 *
 * It does not throw. Each caller has its own error contract and they are not
 * interchangeable:
 *
 *   paymentService   a typed 503 `PAYMONGO_NOT_CONFIGURED` that reaches a
 *                    customer mid-checkout
 *   disbursement     a plain Error, caught and recorded as a payout failure
 *                    reason on the disbursement row
 *   refund           a plain Error, which must NOT mark a refund rejected
 *
 * Returning `null` lets each keep the error its callers already handle. A shared
 * throw would have quietly changed what a customer sees when checkout is down.
 */

/** PayMongo API root. One definition; it was previously written out three times. */
export const PAYMONGO_BASE_URL = 'https://api.paymongo.com/v1';

/**
 * 15 seconds. Long enough for a real response, short enough that a hung request
 * does not hold a booking transaction open.
 *
 * A timeout here is an AMBIGUOUS outcome, not a failure — PayMongo may have
 * accepted the operation. Every caller treats it that way (see the reconciliation
 * notes in `refund.service` and `disbursement.service`); do not "simplify" any of
 * them into a retry.
 */
export const PAYMONGO_TIMEOUT_MS = 15_000;

/**
 * The secret key, resolved fresh on every call.
 *
 * `PAYMONGO_SK_DEV` is the documented fallback. Do NOT add a third variable —
 * that is the exact change that made payouts run in a different mode from
 * checkout, and it took a production incident to find.
 */
export const paymongoSecretKey = (): string =>
  process.env.PAYMONGO_SECRET_KEY || process.env.PAYMONGO_SK_DEV || '';

/** True when a key is present. For readiness reporting, not for control flow. */
export const isPaymongoConfigured = (): boolean => paymongoSecretKey().length > 0;

/**
 * `Basic <base64>` for the Authorization header, or `null` when unconfigured.
 *
 * Null rather than a throw, so each capability keeps its own error contract —
 * see the module note above.
 */
export const paymongoBasicAuth = (): string | null => {
  const key = paymongoSecretKey();
  if (!key) return null;
  return `Basic ${Buffer.from(`${key}:`).toString('base64')}`;
};
