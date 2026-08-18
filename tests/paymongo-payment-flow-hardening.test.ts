import fs from 'fs';
import path from 'path';

const read = (...parts: string[]) =>
  fs.readFileSync(path.join(__dirname, '..', 'src', ...parts), 'utf8');

describe('PayMongo checkout and settlement hardening', () => {
  const service = read('services', 'paymentService.ts');
  const controller = read('controllers', 'paymentController.ts');
  const refund = read('services', 'refund.service.ts');

  test('processor callbacks are server-configured HTTPS URLs', () => {
    expect(service).toContain('PAYMONGO_RETURN_URL');
    expect(service).toContain('base.protocol !== "https:"');
    expect(service).toContain('base.username || base.password');
    expect(service).toContain('getReturnUrl("/payment-success"');
    expect(service).toContain('getReturnUrl("/payment-cancel"');
  });

  test('checkout calls are bounded and processor details are not reflected', () => {
    expect(service).toContain('AbortSignal.timeout(PAYMONGO_TIMEOUT_MS)');
    expect(service).toContain('PAYMONGO_CHECKOUT_FAILED');
    expect(controller).toContain('Number.isSafeInteger(error?.statusCode) ? error.statusCode : 502');
    expect(controller).toContain('Online payment is temporarily unavailable');
    expect(controller).not.toContain('errors?.[0]?.detail');
  });

  test('checkout creation is serialized and processor-idempotent', () => {
    expect(service).toContain('paymongo-checkout:booking:${bookingId}');
    expect(service).toContain('FOR UPDATE OF p');
    expect(service).toContain('"Idempotency-Key": idempotencyKey');
    expect(service).toContain('checkout_attempt = $5');
  });

  test('additional-work checkout reloads canonical amount and serializes by request', () => {
    expect(service).toContain('paymongo-checkout:additional:${requestId}');
    expect(service).toContain('FROM ${dbSchema}.booking_additional_requests');
    expect(service).toContain('String(currentRequest.status).toUpperCase() !== "WAITING_FOR_PAYMENT"');
  });

  test('only a customer or admin can receive a checkout URL', () => {
    expect(controller).toContain('if (role === "provider")');
    expect(controller).toContain('Only the customer or Servana support');
  });

  test('a new session restores the canonical state to pending', () => {
    const create = service.slice(
      service.indexOf('export const createCheckoutSession'),
      service.indexOf('const PAYMONGO_WEBHOOK_SECRET'),
    );
    expect(create).toContain("status = 'PENDING'");
  });

  test('paid settlement and its timeline write share one transaction', () => {
    const paid = service.slice(
      service.indexOf('eventType === "checkout_session.payment.paid"'),
      service.indexOf('eventType === "checkout_session.payment.failed"'),
    );
    expect(paid).toContain('await client.query("BEGIN")');
    expect(paid).toContain('booking_tracking');
    expect(paid).toContain('await client.query("COMMIT")');
    expect(paid).toContain('await client.query("ROLLBACK")');
  });

  test('late failure cannot downgrade paid or refund states', () => {
    const failed = service.slice(
      service.indexOf('eventType === "checkout_session.payment.failed"'),
      service.indexOf('\n};', service.indexOf('eventType === "checkout_session.payment.failed"')),
    );
    expect(failed).toContain("AND status = 'PENDING'");
    expect(failed).toContain("['FAILED', 'PAID', 'REFUNDING', 'REFUNDED']");
  });

  test('unknown refund outcomes stay claimed for reconciliation', () => {
    expect(refund).toContain('const isDefinitelyRejected');
    expect(refund).toContain('outcome: isDefinitelyRejected(err) ? "rejected" : "unknown"');
    expect(refund).toContain('Refund outcome is pending reconciliation');
  });

  test('refunds use stable attempts, processor idempotency, and safe public references', () => {
    expect(refund).toContain('refund_attempt = COALESCE(refund_attempt, 0) + 1');
    expect(refund).toContain('"Idempotency-Key"');
    expect(refund).toContain('SVN-RF-');
    expect(refund).not.toContain('refund_id:   refundData.id');
  });

  test('pending processor refunds remain refunding until webhook confirmation', () => {
    expect(refund).toContain('["pending", "processing"].includes(refund.status)');
    expect(refund).toContain('persistSuccessfulRefund');
    expect(service).toContain('eventType === "refund.succeeded"');
  });
});
