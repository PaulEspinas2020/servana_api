/**
 * The canonical finance endpoints: payments, refunds, earnings, payouts,
 * reconciliation.
 *
 * ## The same rule the booking experiences follow
 *
 * The booking-scoped handlers resolve the ACTOR from the booking relationship,
 * not from the token's role claim:
 *
 *     const actor = await actorFor(bookingId, uidFromToken)
 *
 * `assertBookingAccess` answers "customer, provider, or admin" for a uid and a
 * booking, and it is the same function every other booking route uses. Taking
 * the actor from it means a customer cannot claim to be an admin to issue
 * themselves a refund, and a provider reassigned away from a job is no longer
 * that booking's provider.
 *
 * The provider-scoped handlers take no subject at all. The uid comes from the
 * verified token and is passed straight to the domain service, which filters
 * every query on it. There is no path, query or body parameter that can name
 * another provider — which is what makes the leakage test a statement about the
 * code rather than about the current set of routes.
 *
 * ## Errors are translated, never re-decided
 *
 * The domain services raise their own refusal enums. The map below is pure
 * renaming into the v1 vocabulary; no handler re-evaluates a policy to pick a
 * code, because a transport layer that can disagree with its domain service is a
 * second implementation of the rule.
 */

import { Request, Response } from 'express';
import {
  assertBookingAccess,
  BookingAccessError,
  type BookingActorRole,
} from '../../../services/bookingAccessService';
import {
  BookingPaymentError,
  getBookingPayment,
  refundBookingPayment,
  startPaymentIntent,
  type FinanceActor,
  type PaymentRefusalCode,
} from '../../../services/finance/bookingPaymentService';
import {
  EarningsRangeError,
  getEarningsSummary,
  listEarningsTransactions,
  listProviderPayouts,
} from '../../../services/finance/providerEarningsService';
import { getReconciliationReport } from '../../../services/finance/financeReconciliationService';
import { resolvePaymentReturnOrigin } from '../../../services/paymentReturnOrigin';
import { ok, created, sendCaught } from '../envelope';
import { ApiError, type V1ErrorCode } from '../errors';
import { V1Handlers } from '../types';

// ─── Shared request plumbing ──────────────────────────────────────────────────

const readBookingId = (req: Request): number => {
  const id = Number(req.params.bookingId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw ApiError.validation('bookingId must be a positive integer.');
  }
  return id;
};

const uidOf = (req: Request): string => {
  const uid = (req as any).user?.uid as string | undefined;
  if (!uid) throw new ApiError('UNAUTHENTICATED', 'Authentication is required.');
  return uid;
};

const bodyOf = (req: Request): Record<string, unknown> =>
  (req.body ?? {}) as Record<string, unknown>;

/** `bookingAccessService`'s vocabulary is one word away from the finance policy's. */
const AS_FINANCE_ACTOR: Record<BookingActorRole, FinanceActor> = {
  customer: 'customer',
  provider: 'assigned_provider',
  admin: 'admin',
};

/**
 * Who is calling, decided by their relationship to THIS booking.
 *
 * Throws 403/404 for a caller with no relationship, so authorization and actor
 * resolution are the same step and a handler cannot do one without the other.
 */
const actorFor = async (bookingId: number, uid: string): Promise<FinanceActor> =>
  AS_FINANCE_ACTOR[await assertBookingAccess(bookingId, uid)];

/** The optional date window, read identically by the two endpoints that accept one. */
const readRange = (req: Request) => ({
  startDate: typeof req.query.startDate === 'string' ? req.query.startDate : undefined,
  endDate: typeof req.query.endDate === 'string' ? req.query.endDate : undefined,
});

// ─── Error translation ────────────────────────────────────────────────────────

const PAYMENT_CODE: Record<PaymentRefusalCode, V1ErrorCode> = {
  BOOKING_NOT_FOUND: 'BOOKING_NOT_FOUND',
  PAYMENT_NOT_FOUND: 'PAYMENT_NOT_FOUND',
  PAYMENT_ACTOR_NOT_PERMITTED: 'PAYMENT_ACTOR_NOT_PERMITTED',
  PAYMENT_STATE_CONFLICT: 'PAYMENT_STATE_CONFLICT',
  PAYMENT_PROCESSOR_UNAVAILABLE: 'PAYMENT_PROCESSOR_UNAVAILABLE',
  REFUND_TRIGGER_INVALID: 'REFUND_TRIGGER_INVALID',
  // The refund policy's refusals, renamed into the client vocabulary.
  PAYMENT_NOT_CAPTURED: 'REFUND_PAYMENT_NOT_CAPTURED',
  REFUND_ALREADY_SETTLED: 'REFUND_ALREADY_SETTLED',
  REFUND_IN_PROGRESS: 'REFUND_IN_PROGRESS',
  REFUND_EXCEEDS_CAPTURED: 'REFUND_EXCEEDS_CAPTURED',
  AMOUNT_NOT_POSITIVE: 'VALIDATION_FAILED',
  PROVIDER_NOT_PERMITTED: 'PAYMENT_ACTOR_NOT_PERMITTED',
  OUTCOME_NOT_REFUNDABLE: 'REFUND_OUTCOME_NOT_REFUNDABLE',
};

const asApiError = (error: unknown): unknown => {
  if (error instanceof BookingPaymentError) {
    return new ApiError(PAYMENT_CODE[error.code] ?? 'CONFLICT', error.message, error.detail);
  }
  if (error instanceof EarningsRangeError) {
    return new ApiError('EARNINGS_RANGE_INVALID', error.message);
  }
  if (error instanceof BookingAccessError) {
    return new ApiError(
      error.code === 'BOOKING_NOT_FOUND' ? 'BOOKING_NOT_FOUND' : 'BOOKING_ACCESS_DENIED',
      error.message,
    );
  }
  return error;
};

// ─── Handlers ─────────────────────────────────────────────────────────────────

export const handlers: V1Handlers = {
  /**
   * Start or resume the customer's checkout.
   *
   * A repeat returns the SAME checkout URL rather than a second payable session
   * — the reuse decision belongs to `createCheckoutSession`, which holds the
   * advisory lock, and is deliberately not reimplemented here. A second creator
   * of checkout sessions is a second way to charge a customer twice.
   */
  'bookings.payments.intent': async (req: Request, res: Response) => {
    try {
      const bookingId = readBookingId(req);
      const actor = await actorFor(bookingId, uidOf(req));

      // The origin is resolved from a server-side allowlist against the request,
      // never taken from the body. A caller-supplied return target would let a
      // payer be returned to an application that is not the one they paid from.
      const returnOrigin = resolvePaymentReturnOrigin(req);

      const intent = await startPaymentIntent(bookingId, actor, { returnOrigin });
      return created(res, req, intent);
    } catch (error) {
      return sendCaught(res, req, 'bookings.payments.intent', asApiError(error));
    }
  },

  /**
   * The booking's payment, projected for the caller's seat.
   *
   * All three seats read one `computeBookingFinance` result. A provider and a
   * customer looking at the same booking cannot be shown different totals,
   * because there is only one total.
   */
  'bookings.payments.get': async (req: Request, res: Response) => {
    try {
      const bookingId = readBookingId(req);
      const actor = await actorFor(bookingId, uidOf(req));
      return ok(res, req, await getBookingPayment(bookingId, actor));
    } catch (error) {
      return sendCaught(res, req, 'bookings.payments.get', asApiError(error));
    }
  },

  /**
   * Request a refund, or issue one.
   *
   * The actor decides which of the two happens and the eligibility rule is the
   * same for both, so a customer is never left waiting on a review that an admin
   * was always going to refuse.
   */
  'bookings.refunds.create': async (req: Request, res: Response) => {
    try {
      const bookingId = readBookingId(req);
      const uid = uidOf(req);
      const actor = await actorFor(bookingId, uid);
      const body = bodyOf(req);

      const result = await refundBookingPayment({
        bookingId,
        actor,
        actorUid: uid,
        trigger: body.trigger,
        amount: body.amount,
        reason: typeof body.reason === 'string' ? body.reason : null,
      });

      return created(res, req, result);
    } catch (error) {
      return sendCaught(res, req, 'bookings.refunds.create', asApiError(error));
    }
  },

  /** The caller's own earnings totals. The subject is the token, never a parameter. */
  'provider.earnings.summary': async (req: Request, res: Response) => {
    try {
      return ok(res, req, await getEarningsSummary(uidOf(req), readRange(req)));
    } catch (error) {
      return sendCaught(res, req, 'provider.earnings.summary', asApiError(error));
    }
  },

  /** The caller's own completed jobs and what each one earned. */
  'provider.earnings.transactions': async (req: Request, res: Response) => {
    try {
      return ok(res, req, await listEarningsTransactions(uidOf(req), readRange(req)));
    } catch (error) {
      return sendCaught(res, req, 'provider.earnings.transactions', asApiError(error));
    }
  },

  /** The caller's own payouts. Processor identifiers are excluded by projection. */
  'provider.earnings.payouts': async (req: Request, res: Response) => {
    try {
      return ok(res, req, await listProviderPayouts(uidOf(req)));
    } catch (error) {
      return sendCaught(res, req, 'provider.earnings.payouts', asApiError(error));
    }
  },

  /**
   * The reconciliation report. Read-only.
   *
   * It does not run the checks — a GET that writes rows is one somebody
   * eventually puts behind a dashboard refresh timer, and each run would then
   * delete and rewrite the open exceptions of the current run date.
   */
  'admin.finance.reconciliation': async (req: Request, res: Response) => {
    try {
      return ok(
        res,
        req,
        await getReconciliationReport({
          status: typeof req.query.status === 'string' ? req.query.status : undefined,
          severity: typeof req.query.severity === 'string' ? req.query.severity : undefined,
          limit: req.query.limit == null ? undefined : Number(req.query.limit),
        }),
      );
    } catch (error) {
      return sendCaught(res, req, 'admin.finance.reconciliation', asApiError(error));
    }
  },
};
