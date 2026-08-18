/**
 * The booking-scoped money operations: start a payment, read a payment, refund.
 *
 * ## One endpoint per capability, one projection per actor
 *
 * All three operations are booking-scoped, and the caller's relationship to the
 * booking — not their token's role claim — decides what they may do and what
 * they may see. That is the same rule `domains/bookingExperiences.ts` applies,
 * and it is what allows Customer Mobile, Customer Web and Admin Web to share one
 * path without any of them learning a different set of numbers.
 *
 * The FIELDS differ by actor and the CALCULATION never does. A provider reading
 * a booking's payment sees their share and not the processor reference; a
 * customer sees what they paid and not the provider's share; an admin sees
 * everything. All three are `projectFor(actor, finance)` over one
 * `computeBookingFinance` result, so there is no arrangement of clients in which
 * two of them can be told different totals for one booking.
 *
 * ## Refunds: one eligibility rule, two outcomes
 *
 * A customer REQUESTS a refund and an admin ISSUES one. Those are genuinely
 * different acts — the first opens a `finance_refund_reviews` row, the second
 * calls the processor — but they are not different rules, and both run
 * `evaluateRefundEligibility` before anything happens. A request that would be
 * refused on issue is refused on request, with the same code, so a customer is
 * never left waiting on a review that was never going to succeed.
 *
 * The provider is refused outright. They are not a party to the customer's
 * charge, and a provider able to refund a booking they worked could erase the
 * evidence of a job they were paid for.
 */

import dbQuery from '../../db/dbQuery';
import { db } from '../../config';
import {
  computeBookingFinance,
  deriveBookingFinance,
  recordPaymentRefunded,
  recordLedgerEventBestEffort,
  type BookingFinance,
} from './financeLedger';
import {
  CURRENCY,
  PROVIDER_PAYOUT_WINDOW_HOURS,
  evaluateRefundEligibility,
  parseRefundTrigger,
  toMinorUnits,
  type RefundRefusal,
  type RefundTrigger,
} from './financePolicy';
import { createCheckoutSession } from '../paymentService';

const s = db.schema;

/** The three seats, in the vocabulary `bookingAccessService` answers in. */
export type FinanceActor = 'customer' | 'assigned_provider' | 'admin';

export type PaymentRefusalCode =
  | 'BOOKING_NOT_FOUND'
  | 'PAYMENT_NOT_FOUND'
  | 'PAYMENT_ACTOR_NOT_PERMITTED'
  | RefundRefusal
  | 'REFUND_TRIGGER_INVALID'
  | 'PAYMENT_PROCESSOR_UNAVAILABLE'
  | 'PAYMENT_STATE_CONFLICT';

export class BookingPaymentError extends Error {
  constructor(
    readonly code: PaymentRefusalCode,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BookingPaymentError';
  }
}

// ─── Projection ───────────────────────────────────────────────────────────────

/**
 * What each actor is shown.
 *
 * Written as explicit per-actor DTOs, not as a shared object with fields deleted
 * afterwards. The command forbids global field-rewriting middleware on canonical
 * routes for exactly this reason: a subtractive projection discloses every field
 * somebody forgets to remove, and an additive one discloses only what it names.
 */
export const projectFor = (actor: FinanceActor, finance: BookingFinance) => {
  const shared = {
    bookingId: finance.bookingId,
    currency: CURRENCY,
    state: finance.payment.state,
    captured: finance.payment.captured,
    paidAt: finance.payment.paidAt,
    method: finance.payment.method,
  };

  if (actor === 'assigned_provider') {
    return {
      ...shared,
      // The provider is told the gross because their share is a percentage of
      // it and a share whose basis is hidden cannot be checked. They are NOT
      // told the customer's refund position or the processor reference.
      breakdown: {
        gross: finance.gross,
        grossMinor: toMinorUnits(finance.gross),
        basePrice: finance.basePrice,
        additionalWork: finance.additionalWork,
      },
      earning: {
        economicModel: finance.provider.economicModel,
        payable: finance.provider.payable,
        payableMinor: toMinorUnits(finance.provider.payable),
        isEstimate: finance.provider.isEstimate,
        withheldReason: finance.provider.withheldReason,
      },
      payout: {
        status: finance.payout.status,
        releasedAt: finance.payout.releasedAt,
        eligibleAt: finance.payout.eligibleAt,
        blockedBy: finance.payout.blockedBy,
        blockedReason: finance.payout.blockedReason,
        windowHours: PROVIDER_PAYOUT_WINDOW_HOURS,
      },
    };
  }

  if (actor === 'customer') {
    return {
      ...shared,
      breakdown: {
        gross: finance.gross,
        grossMinor: toMinorUnits(finance.gross),
        basePrice: finance.basePrice,
        additionalWork: finance.additionalWork,
      },
      refund: {
        refundedAmount: finance.payment.refundedAmount,
        refundedAt: finance.payment.refundedAt,
        refundable: finance.payment.refundable,
        refundableMinor: toMinorUnits(finance.payment.refundable),
      },
    };
  }

  // Admin. Everything, including what Servana keeps and what blocks the payout.
  return {
    ...shared,
    paymentId: finance.payment.paymentId,
    breakdown: {
      gross: finance.gross,
      grossMinor: toMinorUnits(finance.gross),
      basePrice: finance.basePrice,
      additionalWork: finance.additionalWork,
    },
    refund: {
      refundedAmount: finance.payment.refundedAmount,
      refundedAt: finance.payment.refundedAt,
      refundable: finance.payment.refundable,
      refundableMinor: toMinorUnits(finance.payment.refundable),
    },
    provider: {
      uid: finance.provider.uid,
      economicModel: finance.provider.economicModel,
      payable: finance.provider.payable,
      isEstimate: finance.provider.isEstimate,
      withheldReason: finance.provider.withheldReason,
    },
    servana: finance.servana,
    payout: {
      disbursementId: finance.payout.disbursementId,
      status: finance.payout.status,
      releasedAt: finance.payout.releasedAt,
      eligible: finance.payout.eligible,
      eligibleAt: finance.payout.eligibleAt,
      blockedBy: finance.payout.blockedBy,
      blockedReason: finance.payout.blockedReason,
      windowHours: PROVIDER_PAYOUT_WINDOW_HOURS,
    },
  };
};

// ─── Read ─────────────────────────────────────────────────────────────────────

export async function getBookingPayment(
  bookingId: number,
  actor: FinanceActor,
  options: { now?: Date } = {},
): Promise<ReturnType<typeof projectFor>> {
  const derived = await deriveBookingFinance(bookingId, options);
  if (!derived) throw new BookingPaymentError('BOOKING_NOT_FOUND', 'Booking not found.');
  return projectFor(actor, derived.finance);
}

// ─── Payment intent ───────────────────────────────────────────────────────────

/**
 * Starts or resumes the customer's checkout.
 *
 * Idempotency is the processor's and this module's together.
 * `createCheckoutSession` already takes an advisory lock on the booking, reuses
 * a live session for the same return origin rather than minting a second, and
 * sends PayMongo an `Idempotency-Key` derived from the payment row and its
 * attempt counter. This function adds the authorization and refuses the actors
 * who have no business starting a charge — it deliberately does NOT reimplement
 * the session logic, because a second creator of checkout sessions is a second
 * way to charge a customer twice.
 */
export async function startPaymentIntent(
  bookingId: number,
  actor: FinanceActor,
  options: { returnOrigin?: string } = {},
): Promise<{ bookingId: number; checkoutUrl: string; reused: boolean }> {
  if (actor === 'assigned_provider') {
    throw new BookingPaymentError(
      'PAYMENT_ACTOR_NOT_PERMITTED',
      'A provider cannot start a payment for the customer.',
    );
  }

  try {
    const session = await createCheckoutSession(bookingId, { returnOrigin: options.returnOrigin });
    return {
      bookingId,
      checkoutUrl: String(session.checkout_url),
      reused: session.reused === true,
    };
  } catch (error) {
    const tagged = error as { code?: string; statusCode?: number; message?: string };
    // Translated by CODE, never by message. `paymentService` raises a closed set
    // of tagged errors; anything else is genuinely unexpected and rethrown.
    if (tagged?.code === 'PAYMENT_NOT_FOUND') {
      throw new BookingPaymentError('BOOKING_NOT_FOUND', 'Booking not found.');
    }
    if (
      tagged?.code === 'PAYMENT_ALREADY_PAID' ||
      tagged?.code === 'PAYMENT_REFUND_ACTIVE' ||
      tagged?.code === 'PAYMENT_STATE_CONFLICT' ||
      tagged?.code === 'BOOKING_INACTIVE' ||
      tagged?.code === 'PAYMONGO_METHOD_MISMATCH'
    ) {
      throw new BookingPaymentError('PAYMENT_STATE_CONFLICT', String(tagged.message ?? 'Payment cannot be started.'));
    }
    if (typeof tagged?.code === 'string' && tagged.code.startsWith('PAYMONGO_')) {
      throw new BookingPaymentError(
        'PAYMENT_PROCESSOR_UNAVAILABLE',
        'Online payment is temporarily unavailable.',
      );
    }
    throw error;
  }
}

// ─── Refunds ──────────────────────────────────────────────────────────────────

export interface RefundOutcome {
  bookingId: number;
  /** `requested` opened a review; `issued` moved money. */
  outcome: 'requested' | 'issued' | 'pending_processor';
  trigger: RefundTrigger;
  amount: number;
  amountMinor: number;
  currency: string;
  /** A Servana handle. Never the processor's refund id. */
  reference: string | null;
  refundReviewId: number | null;
  reversesProviderEarning: boolean;
}

const refundReference = (bookingId: number) => `SVN-RF-B${String(bookingId).padStart(6, '0')}`;

/**
 * Opens or issues a refund, according to who is asking.
 *
 * The eligibility evaluation happens FIRST and identically for both, against the
 * canonical calculator's view of what was captured and what has already been
 * returned. `maxRefundable` is captured minus already-refunded, so a second full
 * refund computes a ceiling of zero and is refused by arithmetic rather than by
 * anyone remembering to check — which is what §77 means by preventing double
 * refunds.
 */
export async function refundBookingPayment(input: {
  bookingId: number;
  actor: FinanceActor;
  actorUid: string;
  trigger: unknown;
  amount?: unknown;
  reason?: string | null;
}): Promise<RefundOutcome> {
  const trigger = parseRefundTrigger(input.trigger);
  if (!trigger) {
    throw new BookingPaymentError(
      'REFUND_TRIGGER_INVALID',
      'A recognised refund reason is required.',
    );
  }

  const derived = await deriveBookingFinance(input.bookingId);
  if (!derived) throw new BookingPaymentError('BOOKING_NOT_FOUND', 'Booking not found.');
  const { finance, customerUid } = derived;

  if (finance.payment.paymentId == null) {
    throw new BookingPaymentError('PAYMENT_NOT_FOUND', 'No payment exists for this booking.');
  }

  const eligibility = evaluateRefundEligibility({
    paymentState: finance.payment.state,
    capturedAmount: finance.gross,
    alreadyRefunded: finance.payment.refundedAmount,
    requestedAmount: input.amount,
    trigger,
    actor: input.actor,
  });

  if (!eligibility.eligible) {
    throw new BookingPaymentError(eligibility.refusal!, eligibility.message!, {
      maxRefundable: eligibility.maxRefundable,
    });
  }

  const base = {
    bookingId: input.bookingId,
    trigger,
    amount: eligibility.amount,
    amountMinor: toMinorUnits(eligibility.amount),
    currency: CURRENCY,
    reversesProviderEarning: eligibility.reversesProviderEarning,
  };

  /**
   * EVERY caller of this function opens a review. Nothing here moves money.
   *
   * ## What this replaced, and why it had to go (TAB 08, F-11)
   *
   * This branch used to read `if (input.actor === 'customer')`, and an `admin`
   * actor fell through to `refundService.forceRefund()` — a live PayMongo
   * refund, issued inside the request.
   *
   * The only caller of this function is the v1 endpoint
   * `POST /api/v1/bookings/:bookingId/refunds`, whose contract entry declares
   * `auth: 'authenticated'` and NO permission. The actor is derived from
   * `assertBookingAccess`, which answers `admin` for any role-1 user on ANY
   * booking. So the complete path to moving money was:
   *
   *     any role-1 admin  →  one POST  →  money gone
   *
   * while the legacy admin surface demands four steps behind four named
   * permissions — `refunds.review.open` (high), `refunds.approve` (CRITICAL),
   * `refunds.reject`, `refunds.mark_processed` — with a `requires` chain
   * expressing a modelled separation of duties.
   *
   * An admin deliberately denied `refunds.approve` could therefore issue a
   * refund by calling the customer's endpoint. That is the same defect as F-01
   * on the payout surface — a second, quieter path to a capability whose guard
   * lives somewhere else — and it is live, because v1 is deployed and all 98
   * probeable routes answer.
   *
   * ## Why the fix is not `requirePermission` on the v1 route
   *
   * Because the gap is not a missing guard, it is a missing WORKFLOW. A single
   * permissioned refund call still collapses request, review, approval and
   * processing into one actor and one moment, which is precisely the control
   * the legacy design encodes. Adding a permission would have closed the
   * privilege hole and quietly blessed the collapse.
   *
   * So the money path is REMOVED from here instead. An admin who calls this
   * opens a review like anybody else, and the refund is completed through the
   * reviewed, permissioned admin surface. That is strictly safer than a
   * permission check and it is the direction the lifecycle has to go anyway.
   *
   * ## What this costs, stated plainly
   *
   * A v1 client cannot complete a refund in one call any more. Measured before
   * changing it: this function has exactly ONE caller, the v1 handler; the
   * admin portal issues refunds through `/api/admin/finance/refunds/*`; and the
   * two mobile clients call this endpoint as customers, which is unchanged. So
   * the capability removed is one with no known caller — but that is an
   * argument from measurement, not from certainty, and the four client
   * repositories are not on this machine (§4). Recorded as manual task 08.1.
   */
  if (input.actor === 'customer' || input.actor === 'admin') {
    const review = await openRefundReview({
      bookingId: input.bookingId,
      paymentId: finance.payment.paymentId,
      amount: eligibility.amount,
      trigger,
      reason: input.reason ?? null,
      customerUid,
      requestedBy: input.actorUid,
      payoutAlreadyReleased: finance.payout.status === 'paid',
    });
    return {
      ...base,
      outcome: 'requested',
      reference: refundReference(input.bookingId),
      refundReviewId: review,
    };
  }

  /**
   * Unreachable, and kept as a refusal rather than deleted.
   *
   * `evaluateRefundEligibility` already restricts which actors may initiate
   * which trigger, so a provider never reaches here — but "already restricted
   * somewhere else" is how the branch above came to move money without a
   * permission in the first place. A refusal that names itself is cheaper than
   * a comment claiming this cannot happen.
   */
  throw new BookingPaymentError(
    'PAYMENT_ACTOR_NOT_PERMITTED',
    'Refunds are completed through admin review, not issued directly.',
  );
}

/**
 * Records a customer's refund request for admin review.
 *
 * Writes into the table the admin finance portal already reads
 * (`finance_refund_reviews`), rather than a new customer-side queue. A second
 * queue would mean a refund a customer believes is open that no admin screen
 * lists.
 */
async function openRefundReview(input: {
  bookingId: number;
  paymentId: number;
  amount: number;
  trigger: RefundTrigger;
  reason: string | null;
  customerUid: string | null;
  requestedBy: string;
  payoutAlreadyReleased: boolean;
}): Promise<number | null> {
  // One open request per booking. A customer pressing the button twice, or two
  // devices doing it at once, must produce one review — the same reasoning the
  // dispute path uses, and the reason `status IN ('requested','under_review')`
  // is checked rather than merely counted.
  const existing = await dbQuery.query(
    `SELECT id FROM ${s}.finance_refund_reviews
      WHERE booking_id = $1 AND status IN ('requested','under_review')
      LIMIT 1`,
    [input.bookingId],
  );
  if (existing.rows[0]) return Number(existing.rows[0].id);

  const inserted = await dbQuery.query(
    `INSERT INTO ${s}.finance_refund_reviews
       (booking_id, payment_id, amount, currency, status, reason,
        customer_uid, requested_by, payout_reversal_needed, notes)
     VALUES ($1,$2,$3,$4,'requested',$5,$6,$7,$8,$9)
     RETURNING id`,
    [
      input.bookingId,
      input.paymentId,
      input.amount,
      CURRENCY,
      input.trigger,
      input.customerUid,
      input.requestedBy,
      input.payoutAlreadyReleased,
      input.reason,
    ],
  );
  return Number(inserted.rows[0]?.id ?? 0) || null;
}

/** Re-exported so a caller needs one import for the operation and its vocabulary. */
export { recordPaymentRefunded, computeBookingFinance };
