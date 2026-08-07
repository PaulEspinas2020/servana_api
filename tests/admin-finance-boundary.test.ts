import fs from 'fs';
import path from 'path';

const service = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'adminFinanceService.ts'), 'utf8');
const controller = fs.readFileSync(path.join(__dirname, '..', 'src', 'controllers', 'adminFinanceController.ts'), 'utf8');

describe('admin finance boundary hardening', () => {
  it('normalizes all five paged finance queries through one finite clamp', () => {
    expect(service).toMatch(/Number\.isFinite\(rawPage\)/);
    expect(service).toMatch(/Math\.min\(100, Math\.max\(1, Math\.trunc\(rawLimit\)\)\)/);
    expect((service.match(/normalizePagination\(filter\.page, filter\.limit\)/g) ?? [])).toHaveLength(5);
  });

  it('does not expose proof URLs through the broad payments list', () => {
    const listBlock = service.slice(service.indexOf('export async function listPayments'), service.indexOf('export async function getPaymentDetail'));
    expect(listBlock).not.toMatch(/p\.proof_url/);
    expect(service).toMatch(/listGcashPendingQueue[\s\S]*p\.proof_url/);
  });

  it('requires safe positive integer IDs at controller boundaries', () => {
    expect(controller).toMatch(/Number\.isSafeInteger\(value\) && value > 0/);
    expect(controller).not.toMatch(/if \(!(?:paymentId|bookingId|disbursementId|refundId|exceptionId)\)/);
  });

  it('rejects non-positive or non-finite refund amounts', () => {
    expect(controller).toMatch(/!Number\.isFinite\(parsedAmount\) \|\| parsedAmount <= 0/);
  });
});
