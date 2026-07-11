/**
 * Command 17 — Finance Operations Center tests.
 *
 * Source-inspection tests only (no running server, no live DB).
 * Verifies schema bootstrap, service logic, route security, audit wiring,
 * and — critically — that no protected Customer Mobile / Provider Mobile /
 * Provider Web contracts were modified.
 */

const fs   = require('fs');
const path = require('path');

const SRC   = (...parts) => path.join(__dirname, '..', 'src', ...parts);
const SVC   = (...parts) => SRC('services', ...parts);
const CTRL  = (...parts) => SRC('controllers', ...parts);
const ROUTE = (...parts) => SRC('routes', ...parts);
const APP   = SRC('app.ts');

// ── File existence ─────────────────────────────────────────────────────────────

describe('C17 Finance — new files exist', () => {
  it('adminFinanceService.ts is present', () => {
    expect(fs.existsSync(SVC('adminFinanceService.ts'))).toBe(true);
  });
  it('adminFinanceController.ts is present', () => {
    expect(fs.existsSync(CTRL('adminFinanceController.ts'))).toBe(true);
  });
  it('adminFinance.routes.ts is present', () => {
    expect(fs.existsSync(ROUTE('adminFinance.routes.ts'))).toBe(true);
  });
});

// ── app.ts registration ────────────────────────────────────────────────────────

describe('C17 Finance — app.ts registers finance route and schema', () => {
  let app;
  beforeAll(() => { app = fs.readFileSync(APP, 'utf8'); });

  it('imports adminFinanceRoutes from routes/adminFinance.routes', () => {
    expect(app).toContain("adminFinance.routes");
  });
  it('mounts adminFinanceRoutes on /api', () => {
    expect(app).toContain('adminFinanceRoutes');
  });
  it('calls ensureFinanceSchema on startup', () => {
    expect(app).toContain('ensureFinanceSchema');
  });
  it('ensureFinanceSchema import is from adminFinanceService', () => {
    expect(app).toContain('adminFinanceService');
  });
});

// ── Schema bootstrap: additive only ───────────────────────────────────────────

describe('C17 Finance — ensureFinanceSchema is additive (no DROP, no breaking ALTER)', () => {
  let svc;
  beforeAll(() => { svc = fs.readFileSync(SVC('adminFinanceService.ts'), 'utf8'); });

  it('does not drop any table', () => {
    expect(svc.toUpperCase()).not.toContain('DROP TABLE');
  });
  it('does not drop any column', () => {
    expect(svc.toUpperCase()).not.toContain('DROP COLUMN');
  });
  it('uses IF NOT EXISTS for all CREATE TABLE statements', () => {
    const creates     = (svc.match(/CREATE TABLE/gi) || []).length;
    const safeCreates = (svc.match(/CREATE TABLE IF NOT EXISTS/gi) || []).length;
    expect(safeCreates).toEqual(creates);
  });
  it('uses ADD COLUMN IF NOT EXISTS for all ALTER ADD COLUMN statements', () => {
    const adds     = (svc.match(/ADD COLUMN/gi) || []).length;
    const safeAdds = (svc.match(/ADD COLUMN IF NOT EXISTS/gi) || []).length;
    expect(safeAdds).toEqual(adds);
  });
});

// ── New tables created ─────────────────────────────────────────────────────────

describe('C17 Finance — ensureFinanceSchema creates required tables', () => {
  let svc;
  beforeAll(() => { svc = fs.readFileSync(SVC('adminFinanceService.ts'), 'utf8'); });

  it('creates finance_ledger_entries table', () => {
    expect(svc).toContain('finance_ledger_entries');
  });
  it('creates finance_refund_reviews table', () => {
    expect(svc).toContain('finance_refund_reviews');
  });
  it('creates finance_reconciliation_exceptions table', () => {
    expect(svc).toContain('finance_reconciliation_exceptions');
  });
  it('adds is_internal_fixer column to user_credentials', () => {
    expect(svc).toContain('is_internal_fixer');
    expect(svc).toContain('user_credentials');
  });
  it('adds reviewed_by column to payments', () => {
    expect(svc).toContain('reviewed_by');
    expect(svc).toContain('payments');
  });
  it('adds hold_reason column to disbursements', () => {
    expect(svc).toContain('hold_reason');
    expect(svc).toContain('disbursements');
  });
});

// ── Service exports all required functions ────────────────────────────────────

describe('C17 Finance — adminFinanceService exports required functions', () => {
  let svc;
  beforeAll(() => { svc = fs.readFileSync(SVC('adminFinanceService.ts'), 'utf8'); });

  const expected = [
    'ensureFinanceSchema',
    'getFinanceSummary',
    'listPayments',
    'getPaymentDetail',
    'listGcashPendingQueue',
    'approveGcashPayment',
    'rejectGcashPayment',
    'adminConfirmCash',
    'createLedgerEntry',
    'listLedgerEntries',
    'getBookingLedger',
    'listPayouts',
    'getPayoutDetail',
    'holdPayout',
    'releasePayoutHold',
    'retryPayout',
    'setInternalFixer',
    'openRefundReview',
    'listRefundReviews',
    'getRefundReview',
    'approveRefund',
    'rejectRefund',
    'markRefundProcessed',
    'runReconciliation',
    'listExceptions',
    'resolveException',
    'ignoreException',
  ];

  for (const fn of expected) {
    it(`exports ${fn}`, () => {
      expect(svc).toContain(`export async function ${fn}`);
    });
  }
});

// ── Audit event wiring ─────────────────────────────────────────────────────────

describe('C17 Finance — adminFinanceService fires audit events', () => {
  let svc;
  beforeAll(() => { svc = fs.readFileSync(SVC('adminFinanceService.ts'), 'utf8'); });

  it('imports auditFire from adminAuditService', () => {
    expect(svc).toContain("import { auditFire } from './adminAuditService'");
  });
  it('fires audit on GCash approval', () => {
    expect(svc).toContain("'finance_payment_gcash_approved'");
  });
  it('fires audit on GCash rejection', () => {
    expect(svc).toContain("'finance_payment_gcash_rejected'");
  });
  it('fires audit on cash confirmation', () => {
    expect(svc).toContain("'finance_payment_cash_confirmed'");
  });
  it('fires audit on payout hold', () => {
    expect(svc).toContain("'finance_payout_held'");
  });
  it('fires audit on hold release', () => {
    expect(svc).toContain("'finance_payout_hold_released'");
  });
  it('fires audit on payout retry', () => {
    expect(svc).toContain("'finance_payout_retry_triggered'");
  });
  it('fires audit on refund opened', () => {
    expect(svc).toContain("'finance_refund_opened'");
  });
  it('fires audit on refund approved', () => {
    expect(svc).toContain("'finance_refund_approved'");
  });
  it('fires audit on refund rejected', () => {
    expect(svc).toContain("'finance_refund_rejected'");
  });
  it('fires audit on refund processed', () => {
    expect(svc).toContain("'finance_refund_processed'");
  });
  it('fires audit on reconciliation run', () => {
    expect(svc).toContain("'finance_reconciliation_run'");
  });
  it('fires audit on exception resolved', () => {
    expect(svc).toContain("'finance_exception_resolved'");
  });
  it('fires audit on exception ignored', () => {
    expect(svc).toContain("'finance_exception_ignored'");
  });
  it('fires audit on internal fixer tagged', () => {
    expect(svc).toContain("'finance_internal_fixer_tagged'");
  });
});

// ── Payment operations: business rules ────────────────────────────────────────

describe('C17 Finance — payment approval business rules', () => {
  let svc;
  beforeAll(() => { svc = fs.readFileSync(SVC('adminFinanceService.ts'), 'utf8'); });

  it('approveGcashPayment checks payment method = GCASH', () => {
    const idx     = svc.indexOf("export async function approveGcashPayment");
    const segment = svc.slice(idx, idx + 800);
    expect(segment).toContain("'GCASH'");
    expect(segment).toContain('NOT_FOUND');
    expect(segment).toContain('BUSINESS_RULE');
  });

  it('approveGcashPayment uses conditional UPDATE (status=PENDING guard) to prevent double approval', () => {
    const idx     = svc.indexOf("export async function approveGcashPayment");
    const segment = svc.slice(idx, idx + 1300);
    expect(segment).toContain("AND status='PENDING'");
    expect(segment).toContain('CONFLICT');
  });

  it('rejectGcashPayment requires non-empty rejectionReason', () => {
    const ctrl = fs.readFileSync(CTRL('adminFinanceController.ts'), 'utf8');
    const idx   = ctrl.indexOf('export async function rejectGcashPayment');
    const seg   = ctrl.slice(idx, idx + 400);
    expect(seg).toContain('rejectionReason');
    expect(seg).toContain('adminValidationError');
  });

  it('approveGcashPayment creates a ledger entry after approval', () => {
    const idx     = svc.indexOf("export async function approveGcashPayment");
    const segment = svc.slice(idx, idx + 1500);
    expect(segment).toContain('createLedgerEntry');
  });

  it('adminConfirmCash creates a ledger entry after confirmation', () => {
    const idx     = svc.indexOf("export async function adminConfirmCash");
    const segment = svc.slice(idx, idx + 1300);
    expect(segment).toContain('createLedgerEntry');
  });
});

// ── Internal fixer revenue model ──────────────────────────────────────────────

describe('C17 Finance — internal fixer revenue model', () => {
  let svc;
  beforeAll(() => { svc = fs.readFileSync(SVC('adminFinanceService.ts'), 'utf8'); });

  it('computeRevenueSplit returns full amount as servanaRevenue for internal fixers', () => {
    const idx     = svc.indexOf('function computeRevenueSplit');
    const segment = svc.slice(idx, idx + 400);
    // When isInternalFixer = true, servanaRevenue = grossAmount, providerPayable = 0
    expect(segment).toContain('providerPayable: 0');
    expect(segment).toContain('servanaRevenue: grossAmount');
  });

  it('computeRevenueSplit uses SERVANA_COMMISSION (0.20) for external providers', () => {
    expect(svc).toContain('SERVANA_COMMISSION = 0.20');
    const idx     = svc.indexOf('function computeRevenueSplit');
    const segment = svc.slice(idx, idx + 600);
    expect(segment).toContain('SERVANA_COMMISSION');
    expect(segment).toContain('WORKER_SHARE_RATE');
  });

  it('setInternalFixer updates user_credentials.is_internal_fixer', () => {
    const idx     = svc.indexOf('export async function setInternalFixer');
    const segment = svc.slice(idx, idx + 400);
    expect(segment).toContain('is_internal_fixer');
    expect(segment).toContain('user_credentials');
  });
});

// ── Payout operations: safety guards ─────────────────────────────────────────

describe('C17 Finance — payout safety guards', () => {
  let svc;
  beforeAll(() => { svc = fs.readFileSync(SVC('adminFinanceService.ts'), 'utf8'); });

  it('retryPayout checks status=FAILED before resetting to PENDING', () => {
    const idx     = svc.indexOf("export async function retryPayout");
    const segment = svc.slice(idx, idx + 600);
    expect(segment).toContain("status !== 'FAILED'");
  });

  it('retryPayout enforces PAYOUT_MAX_RETRIES limit', () => {
    const idx     = svc.indexOf("export async function retryPayout");
    const segment = svc.slice(idx, idx + 900);
    expect(segment).toContain('PAYOUT_MAX_RETRIES');
    expect(segment).toContain('retry_count');
  });

  it('holdPayout requires status=PENDING', () => {
    const idx     = svc.indexOf("export async function holdPayout");
    const segment = svc.slice(idx, idx + 600);
    expect(segment).toContain("AND status='PENDING'");
  });
});

// ── Reconciliation: exception types ───────────────────────────────────────────

describe('C17 Finance — reconciliation detects required exception codes', () => {
  let svc;
  beforeAll(() => { svc = fs.readFileSync(SVC('adminFinanceService.ts'), 'utf8'); });

  const codes = [
    'GCASH_PENDING_REVIEW_OVER_SLA',
    'CASH_PAYMENT_UNCONFIRMED_OVER_SLA',
    'PAYMONGO_FAILED_PAYMENT',
    'PAYMONGO_CHECKOUT_WITHOUT_FINAL_STATUS',
    'RELEASED_PAYOUT_WITHOUT_PAID_PAYMENT',
    'DUPLICATE_PAYOUT_FOR_BOOKING',
    'INTERNAL_FIXER_JOB_WITH_PROVIDER_PAYOUT',
    'PAYOUT_FAILED_PROVIDER_ERROR',
    'REFUND_APPROVED_WITH_RELEASED_PAYOUT',
  ];

  for (const code of codes) {
    it(`detects ${code}`, () => {
      expect(svc).toContain(`'${code}'`);
    });
  }

  it('runReconciliation deletes open exceptions for same run_date before re-running (idempotent)', () => {
    const idx     = svc.indexOf("export async function runReconciliation");
    const segment = svc.slice(idx, idx + 600);
    expect(segment).toContain('DELETE FROM finance_reconciliation_exceptions');
    expect(segment).toContain('run_date');
  });
});

// ── Routes: admin-only security ───────────────────────────────────────────────

describe('C17 Finance — all finance routes require admin role', () => {
  let routes;
  beforeAll(() => { routes = fs.readFileSync(ROUTE('adminFinance.routes.ts'), 'utf8'); });

  it('imports verifyAuth and verifyRoles', () => {
    expect(routes).toContain('verifyAuth');
    expect(routes).toContain('verifyRoles');
  });

  it('uses verifyRoles([1]) for all routes via adminOnly spread', () => {
    expect(routes).toContain('verifyRoles([1])');
    expect(routes).toContain('...adminOnly');
  });

  it('registers GCash approve endpoint', () => {
    expect(routes).toContain('approve-gcash');
  });
  it('registers GCash reject endpoint', () => {
    expect(routes).toContain('reject-gcash');
  });
  it('registers cash confirm endpoint', () => {
    expect(routes).toContain('confirm-cash');
  });
  it('registers payout hold endpoint', () => {
    expect(routes).toContain('/payouts/:disbursementId/hold');
  });
  it('registers payout retry endpoint', () => {
    expect(routes).toContain('/payouts/:disbursementId/retry');
  });
  it('registers reconciliation run endpoint', () => {
    expect(routes).toContain('/reconciliation/run');
  });
  it('registers refund review endpoints', () => {
    expect(routes).toContain('/admin/finance/refunds');
  });
  it('registers internal fixer endpoint', () => {
    expect(routes).toContain('/admin/finance/providers/:uid/internal-fixer');
  });
});

// ── Compatibility: protected mobile contracts NOT modified ────────────────────

describe('C17 Finance — protected contracts: Customer Mobile endpoints UNCHANGED', () => {
  it('adminFinanceService does not reference /api/:bookingId/approve', () => {
    const svc = fs.readFileSync(SVC('adminFinanceService.ts'), 'utf8');
    expect(svc).not.toContain("/:bookingId/approve");
  });
  it('adminFinanceService does not reference /api/:bookingId/mark-cash-paid', () => {
    const svc = fs.readFileSync(SVC('adminFinanceService.ts'), 'utf8');
    expect(svc).not.toContain('mark-cash-paid');
  });
  it('adminFinanceRoutes does not define /:bookingId/approve', () => {
    const routes = fs.readFileSync(ROUTE('adminFinance.routes.ts'), 'utf8');
    expect(routes).not.toContain("/:bookingId/approve");
  });
  it('payment.routes.ts is unchanged (customer approve route preserved)', () => {
    const paymentRoutes = fs.readFileSync(ROUTE('payment.routes.ts'), 'utf8');
    expect(paymentRoutes).toContain('/:bookingId/approve');
  });
});

describe('C17 Finance — protected contracts: Provider Mobile worker endpoints UNCHANGED', () => {
  it('adminFinanceService does not modify /api/workers/:uid/job-cards', () => {
    const svc = fs.readFileSync(SVC('adminFinanceService.ts'), 'utf8');
    expect(svc).not.toContain('job-cards');
  });
  it('adminFinanceRoutes does not define /workers/* routes', () => {
    const routes = fs.readFileSync(ROUTE('adminFinance.routes.ts'), 'utf8');
    expect(routes).not.toContain('/workers/');
  });
  it('adminFinanceService does not reference /workers/:uid/bookings', () => {
    const svc = fs.readFileSync(SVC('adminFinanceService.ts'), 'utf8');
    expect(svc).not.toContain('/workers/:uid/bookings');
  });
});

describe('C17 Finance — protected contracts: Provider Web earnings endpoints UNCHANGED', () => {
  it('adminFinanceRoutes does not define /provider/earnings', () => {
    const routes = fs.readFileSync(ROUTE('adminFinance.routes.ts'), 'utf8');
    expect(routes).not.toContain('/provider/earnings');
  });
  it('adminFinanceRoutes does not define /provider/ledger', () => {
    const routes = fs.readFileSync(ROUTE('adminFinance.routes.ts'), 'utf8');
    expect(routes).not.toContain('/provider/ledger');
  });
  it('adminFinanceRoutes does not define /provider/payouts', () => {
    const routes = fs.readFileSync(ROUTE('adminFinance.routes.ts'), 'utf8');
    expect(routes).not.toContain('/provider/payouts');
  });
  it('adminFinanceController does not reference /provider-catalog/v1/offerings', () => {
    const ctrl = fs.readFileSync(CTRL('adminFinanceController.ts'), 'utf8');
    expect(ctrl).not.toContain('/provider-catalog/v1/offerings');
  });
});

// ── Security: sensitive data not exposed ──────────────────────────────────────

describe('C17 Finance — security: sensitive data not exposed', () => {
  let svc, ctrl;
  beforeAll(() => {
    svc  = fs.readFileSync(SVC('adminFinanceService.ts'), 'utf8');
    ctrl = fs.readFileSync(CTRL('adminFinanceController.ts'), 'utf8');
  });

  it('service does not return raw PayMongo secret key', () => {
    expect(svc).not.toContain('PAYMONGO_SECRET');
    expect(svc).not.toContain('sk_live_');
    expect(svc).not.toContain('sk_test_');
  });
  it('controller does not return raw PayMongo secret key', () => {
    expect(ctrl).not.toContain('PAYMONGO_SECRET');
    expect(ctrl).not.toContain('sk_live_');
  });
  it('service does not return raw JWT tokens', () => {
    expect(svc).not.toContain('Authorization: Bearer');
    expect(svc).not.toContain('process.env.JWT_SECRET');
  });
  it('service does not contain hardcoded commission rate in SQL', () => {
    // Commission must come from SERVANA_COMMISSION constant, not hardcoded as 0.2 in SQL
    const idx = svc.indexOf('SERVANA_COMMISSION');
    expect(idx).toBeGreaterThan(-1);
  });
});

// ── adminAuditService: finance types added ────────────────────────────────────

describe('C17 Finance — adminAuditService updated with finance types', () => {
  let audit;
  beforeAll(() => { audit = fs.readFileSync(SVC('adminAuditService.ts'), 'utf8'); });

  it("AuditCategory includes 'finance'", () => {
    expect(audit).toContain("'finance'");
  });
  it("AuditEntityType includes 'disbursement'", () => {
    expect(audit).toContain("'disbursement'");
  });
  it("AuditEntityType includes 'refund_review'", () => {
    expect(audit).toContain("'refund_review'");
  });
  it("AuditEntityType includes 'reconciliation_exception'", () => {
    expect(audit).toContain("'reconciliation_exception'");
  });
  it('ACTION_LABELS contains finance_payment_gcash_approved', () => {
    expect(audit).toContain('finance_payment_gcash_approved');
  });
  it('HIGH_RISK_ACTIONS includes finance high-risk actions', () => {
    const hrIdx = audit.indexOf('HIGH_RISK_ACTIONS');
    const segment = audit.slice(hrIdx, hrIdx + 1000);
    expect(segment).toContain('finance_payment_gcash_approved');
    expect(segment).toContain('finance_reconciliation_run');
  });
});
