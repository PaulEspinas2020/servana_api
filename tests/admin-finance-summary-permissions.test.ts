import fs from 'fs';
import path from 'path';

const service = fs.readFileSync(path.join(__dirname, '../src/services/adminFinanceService.ts'), 'utf8');
const controller = fs.readFileSync(path.join(__dirname, '../src/controllers/adminFinanceController.ts'), 'utf8');

describe('Finance summary granular permission projection', () => {
  test.each([
    'payments.view',
    'payments.gcash_review.view',
    'payouts.view',
    'reconciliation.view',
  ])('controller evaluates %s', (permission) => {
    expect(controller).toContain(`can('${permission}')`);
  });

  test('controller returns the projected summary', () => {
    expect(controller).toContain('svc.projectFinanceSummary(data');
  });

  test('submodule counts fail closed', () => {
    expect(service).toContain('pendingGcashCount: access.gcashReview ? data.pendingGcashCount : 0');
    expect(service).toContain('pendingPayoutCount: access.payouts ? data.pendingPayoutCount : 0');
    expect(service).toContain('openRefundCount: access.refunds ? data.openRefundCount : 0');
    expect(service).toContain('openExceptionCount: access.reconciliation ? data.openExceptionCount : 0');
  });
});
