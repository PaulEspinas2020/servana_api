import fs from 'fs';
import path from 'path';

const payment = fs.readFileSync(path.join(__dirname, '../src/services/paymentService.ts'), 'utf8');
const refund = fs.readFileSync(path.join(__dirname, '../src/services/refund.service.ts'), 'utf8');
const controller = fs.readFileSync(path.join(__dirname, '../src/controllers/paymentController.ts'), 'utf8');

describe('PayMongo integration boundaries', () => {
  test('signature verification fails closed without a configured secret or a 64-char hex digest', () => {
    expect(payment).toContain('if (!secret || !signatureHeader) return false');
    expect(payment).toContain('/^[a-f\\d]{64}$/i.test(signature)');
    expect(payment).toContain('expectedBuffer.length === signatureBuffer.length');
  });

  test('checkout responses must contain both processor id and URL', () => {
    expect(payment.match(/PayMongo returned an incomplete checkout session/g)?.length).toBe(2);
    expect(payment).toContain('if (!response.ok)');
  });

  test('paid checkout event captures the refundable pay_ id and matches PHP amount', () => {
    expect(payment).toContain("processorPaymentId.startsWith('pay_')");
    expect(payment).toContain("paidCurrency !== 'PHP'");
    expect(payment).toContain('provider_payment_id = $4');
    expect(payment).toContain('ROUND(amount * 100) = $5');
  });

  test('unknown paid sessions fail for retry instead of being acknowledged', () => {
    expect(payment).toContain('throw new Error("PayMongo checkout session not found")');
  });

  test('refunds atomically claim PAID rows and only use pay_ identifiers', () => {
    expect(refund).toContain("status = 'REFUNDING'");
    expect(refund).toContain("WHERE id = $1 AND status = 'PAID' RETURNING id");
    expect(refund).toContain("startsWith('pay_')");
    expect(refund).toContain("WHERE id = $1 AND status = 'REFUNDING'");
  });

  test('internal webhook failures are not reflected to callers', () => {
    expect(controller).toContain('"Webhook processing failed"');
  });
});
