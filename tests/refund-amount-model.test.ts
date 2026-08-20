/**
 * The refund amount model, answered — and the two ceilings that disagree.
 *
 * TAB 10 of the Admin API Master Command asks one question and offers two
 * answers:
 *
 * > 1. **Intended.** Refunds are always full, or the amount is derived
 * >    server-side from the booking.
 * > 2. **Not yet built.** Partial refunds are coming, and the endpoint will grow
 * >    an amount.
 *
 * **Neither.** Partial refunds are built, an operator-entered amount IS
 * accepted, and a server-side ceiling already refuses anything above it.
 *
 * ## Why the book concluded otherwise
 *
 * It enumerated the review TRANSITIONS and found no amount on any of them:
 *
 *     approveRefund        (refundId)
 *     rejectRefund         (refundId, rejectionReason)
 *     markRefundProcessed  (refundId, refundReference)
 *     holdPayout           (disbursementId, holdReason, holdUntil?)
 *
 * That is correct and it is the right design: the amount is fixed once, when
 * the review is OPENED, and the transitions act on the recorded review rather
 * than re-deciding it. The endpoint the book did not reach is
 * `adminFinanceService.openRefundReview`, whose body carries `amount: number`
 * and which refuses `amount > remaining` with a BUSINESS_RULE error.
 *
 * So the portal's rule — *"money is displayed, never computed"* — holds for the
 * transitions, and there is exactly one place an operator names a figure.
 *
 * ## The finding: the ceiling shown and the ceiling enforced are two numbers
 *
 * The book asks the backend to *"send `refundable` … alongside so the UI can
 * bound the input and the server can refuse anything above it."* Doing that
 * today would bound the input with the WRONG number.
 *
 *     BookingPayment.refund.refundable      gross - refundedAmount
 *       gross = final_price + PAID ADDITIONAL WORK        (booking-level)
 *
 *     openRefundReview's guard              payments.amount - refunded_amount
 *       for the ONE payment row named by paymentId        (payment-level)
 *
 * Paid additional work is charged through its OWN payment row —
 * `earningsBasis.paidAdditionalWorkSql` sums `payments` where
 * `additional_request_id IS NOT NULL`. So on any booking with paid additional
 * work the booking-level ceiling is strictly larger than the payment-level one.
 *
 * An operator bounded by `refundable` would enter the number the system showed
 * them and be refused by the same system, with a message that explains nothing
 * because the figure came from the system itself.
 *
 * These tests compute both from one fixture and show them diverging. Nothing is
 * changed about refund behaviour here: this is a money path, and the divergence
 * is documented and proven rather than silently re-decided.
 */

import { toCentavos } from '../src/services/finance/financePolicy';

/** The ledger's rule, from financeLedger.computeBookingFinance. */
const bookingRefundable = (input: {
  finalPrice: number;
  additionalPaid: number;
  refundedAmount: number;
  captured: boolean;
}): number => {
  const basePrice = toCentavos(input.finalPrice);
  const additionalWork = toCentavos(input.additionalPaid);
  const gross = toCentavos(basePrice + additionalWork);
  return input.captured ? Math.max(0, toCentavos(gross - toCentavos(input.refundedAmount))) : 0;
};

/** The guard's rule, from adminFinanceService.openRefundReview. */
const paymentRemaining = (payment: { amount: number; refundedAmount: number }): number =>
  Number(payment.amount) - Number(payment.refundedAmount);

describe('partial refunds are built, and bounded', () => {
  it('accepts an operator-entered amount at all — the book says none does', () => {
    // The interface itself is the evidence. `amount: number` is required, not
    // optional, so this endpoint cannot be called without naming a figure.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path');
    const src: string = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'services', 'adminFinanceService.ts'),
      'utf8',
    );
    expect(src).toMatch(/export interface OpenRefundBody \{[\s\S]*?\n\s*amount: number;/);
  });

  it('refuses an amount above the remaining paid amount, server-side', () => {
    // The ceiling the book asks for already exists — it is simply enforced
    // rather than disclosed.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path');
    const src: string = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'services', 'adminFinanceService.ts'),
      'utf8',
    );
    expect(src).toMatch(/const remaining = toNum\(pay\.amount\) - toNum\(pay\.refunded_amount\)/);
    expect(src).toMatch(/body\.amount > remaining/);
    expect(src).toMatch(/Refund amount exceeds the remaining paid amount/);
  });

  it('refuses a refund against a payment that was never captured', () => {
    // A ceiling is not the only guard, and the others matter as much: only a
    // PAID payment can be refunded at all.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path');
    const src: string = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'services', 'adminFinanceService.ts'),
      'utf8',
    );
    expect(src).toMatch(/Only a paid payment can be refunded/);
    expect(src).toMatch(/An open refund review already exists for this booking/);
  });
});

describe('the two ceilings agree when there is no additional work', () => {
  it('matches on a plain booking', () => {
    const finalPrice = 1500;
    expect(
      bookingRefundable({ finalPrice, additionalPaid: 0, refundedAmount: 0, captured: true }),
    ).toBe(paymentRemaining({ amount: finalPrice, refundedAmount: 0 }));
  });

  it('matches after a partial refund', () => {
    expect(
      bookingRefundable({ finalPrice: 1500, additionalPaid: 0, refundedAmount: 500, captured: true }),
    ).toBe(paymentRemaining({ amount: 1500, refundedAmount: 500 }));
  });
});

describe('the two ceilings DIVERGE the moment additional work is paid', () => {
  /**
   * This is the finding, and it is why `refundable` must not be handed to a UI
   * as the maximum for `openRefundReview` without saying which ceiling it is.
   */
  const finalPrice = 1500;
  const additionalPaid = 400;

  it('shows a booking-level ceiling that includes the additional work', () => {
    expect(
      bookingRefundable({ finalPrice, additionalPaid, refundedAmount: 0, captured: true }),
    ).toBe(1900);
  });

  it('enforces a payment-level ceiling that does NOT', () => {
    // Paid additional work is charged through its OWN payments row —
    // paidAdditionalWorkSql sums payments WHERE additional_request_id IS NOT
    // NULL — so the base payment row still holds only the base amount.
    expect(paymentRemaining({ amount: finalPrice, refundedAmount: 0 })).toBe(1500);
  });

  it('leaves a 400 gap an operator would walk straight into', () => {
    const shown = bookingRefundable({ finalPrice, additionalPaid, refundedAmount: 0, captured: true });
    const enforced = paymentRemaining({ amount: finalPrice, refundedAmount: 0 });

    expect(shown).toBeGreaterThan(enforced);
    expect(shown - enforced).toBe(additionalPaid);

    // The exact failure: bounded by the disclosed ceiling, the operator enters
    // it, and the server refuses — using a figure the system itself supplied.
    expect(shown > enforced).toBe(true);
  });

  it('holds for any non-zero additional work, not just this fixture', () => {
    // One example could be arithmetic luck. The gap is exactly the additional
    // work, for every value of it.
    for (const extra of [0.01, 1, 99.99, 5000]) {
      const shown = bookingRefundable({
        finalPrice: 1500, additionalPaid: extra, refundedAmount: 0, captured: true,
      });
      const enforced = paymentRemaining({ amount: 1500, refundedAmount: 0 });
      expect(Math.round((shown - enforced) * 100) / 100).toBe(extra);
    }
  });
});

describe('the contract says which ceiling refundable is', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { buildOpenApiDocument } = require('../src/api/v1/openapi');
  const schemas = (buildOpenApiDocument() as any).components.schemas;
  const refundable = schemas.BookingPayment.properties.refund.properties.refundable;

  it('states that it is BOOKING-level, not the ceiling for one refund', () => {
    // Without this sentence a client does exactly what the book proposes —
    // bounds the input with it — and is wrong on every booking that had
    // additional work.
    expect(refundable.description).toMatch(/BOOKING/);
    expect(refundable.description).toMatch(/additional work/i);
  });

  it('names the guard a client is actually bounded by', () => {
    expect(refundable.description).toMatch(/openRefundReview/);
  });
});

describe('RefundTransitionResult.status is a single value, and that is deliberate', () => {
  it('declares only the terminal this endpoint can reach', () => {
    /**
     * The book asks whether `status: ['failed']` is intended. It is: the
     * endpoint is `POST /admin/refunds/{refundId}/mark-failed`, and the only
     * terminal it can reach is `failed`. A wider enum would describe states
     * this operation cannot produce.
     *
     * The portal's own refund vocabulary is wider because it describes the
     * REVIEW's lifecycle; this describes ONE transition's outcome. They are not
     * the same concept and should not share an enum.
     */
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { buildOpenApiDocument } = require('../src/api/v1/openapi');
    const s = (buildOpenApiDocument() as any).components.schemas.RefundTransitionResult;
    expect(s.properties.status.enum).toEqual(['failed']);
    expect(s.required).toEqual(expect.arrayContaining(['refundId', 'status']));
  });
});
