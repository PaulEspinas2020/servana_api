import fs from 'fs';
import path from 'path';

const service = fs.readFileSync(
  path.join(__dirname, '../src/services/adminFinanceService.ts'),
  'utf8',
);

describe('Admin Finance alignment and leakage boundaries', () => {
  test('summary uses the paid payment ledger and Manila business boundaries', () => {
    expect(service).toContain("paid_at AT TIME ZONE 'Asia/Manila'");
    expect(service).toContain("DATE_TRUNC('month', NOW() AT TIME ZONE 'Asia/Manila')");
    expect(service).toContain('revenueMtd:         servanaShareOf(toNum(rev.rows[0]?.v))');
  });

  test('refunds are bounded by the selected paid payment and remaining amount', () => {
    expect(service).toContain('WHERE id=$1 AND booking_id=$2');
    expect(service).toContain("Only a paid payment can be refunded");
    expect(service).toContain('Refund amount exceeds the remaining paid amount');
  });

  test('processed refunds update cumulative refunded value and settlement state', () => {
    expect(service).toContain('refunded_amount=COALESCE(refunded_amount,0)+$3');
    expect(service).toContain("THEN 'REFUNDED' ELSE status END");
  });

  test('payment list omits live checkout and review-only fields', () => {
    const start = service.indexOf('export async function listPayments');
    const end = service.indexOf('export async function getPaymentDetail');
    const segment = service.slice(start, end);
    expect(segment).not.toContain('p.checkout_url');
    expect(segment).not.toContain('p.provider_payment_id');
    expect(segment).not.toContain('p.rejection_reason');
    expect(segment).not.toContain('p.reviewed_by');
  });

  test('payment detail does not return raw processor payloads', () => {
    const start = service.indexOf('export async function getPaymentDetail');
    const end = service.indexOf('export async function listGcashPendingQueue');
    const segment = service.slice(start, end);
    expect(segment).not.toContain('p.*');
    expect(segment).not.toContain('raw_response');
    expect(segment).not.toContain('provider_payment_id');
  });

  test('payout detail attaches only the canonical booking payment', () => {
    expect(service).toContain('AND additional_request_id IS NULL');
    expect(service).toContain('LEFT JOIN LATERAL');
  });

  test('payout list omits internal error and actor fields', () => {
    const start = service.indexOf('export async function listPayouts');
    const end = service.indexOf('export async function getPayoutDetail');
    const segment = service.slice(start, end);
    expect(segment).not.toContain('d.payout_error');
    expect(segment).not.toContain('d.held_by');
  });
});
