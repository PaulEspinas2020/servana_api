/**
 * §78 — the reconciliation engine, and the claim that it has no unexplained breaks.
 *
 * "Zero unexplained breaks" is only a checkable claim if two things are true:
 * every code the engine can emit is DECLARED, and every declared code names what
 * it detects and what to do about it. Before this the nine checks were anonymous
 * closures with their codes written inline, so nothing could enumerate them, the
 * admin UI could not label them, and §78's four required checks could not be
 * shown to be present.
 *
 * So this suite asserts the catalog and the engine against each other — by
 * reading the engine's SOURCE for the codes it emits, which is the only way to
 * cover checks that are closures rather than exported functions.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' }, tempId: undefined }));

interface Recorded { sql: string; params: unknown[] }
const statements: Recorded[] = [];
const answers: Array<[RegExp, (params: unknown[]) => { rows: any[]; rowCount: number }]> = [];

jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      statements.push({ sql, params });
      for (const [pattern, make] of answers) if (pattern.test(sql)) return make(params);
      return { rows: [], rowCount: 0 };
    }),
  },
  pool: { connect: jest.fn() },
}));

import fs from 'fs';
import path from 'path';
import {
  RECONCILIATION_CHECKS,
  RECONCILIATION_CHECK_CODES,
} from '../src/services/finance/financePolicy';
import {
  LEDGER_INTEGRITY_CHECKS,
  getReconciliationReport,
  getBookingReconciliation,
} from '../src/services/finance/financeReconciliationService';

const ENGINE_SOURCE = fs.readFileSync(
  path.resolve(__dirname, '..', 'src', 'services', 'adminFinanceService.ts'),
  'utf8',
);

beforeEach(() => {
  statements.length = 0;
  answers.length = 0;
});

// ─── The catalog and the engine agree ─────────────────────────────────────────

describe('every code the engine emits is declared in the catalog', () => {
  /**
   * Read from the engine's source because its nine original checks are anonymous
   * closures. An exported list would be nicer and would also be a second place
   * for the truth to live; scanning the code that actually runs is evidence.
   */
  const emitted = [...ENGINE_SOURCE.matchAll(/exceptionCode:\s*'([A-Z_]+)'/g)].map((m) => m[1]);

  it('the engine emits at least the nine original checks', () => {
    expect(new Set(emitted).size).toBeGreaterThanOrEqual(9);
  });

  it.each([...new Set(emitted)])('%s is in the catalog', (code) => {
    expect(RECONCILIATION_CHECK_CODES).toContain(code);
  });

  it('every ledger-integrity check names a catalog entry', () => {
    for (const check of LEDGER_INTEGRITY_CHECKS) {
      expect(RECONCILIATION_CHECK_CODES).toContain(check.code);
    }
  });

  /**
   * The catalog may declare a check the engine does not run yet — but not
   * silently. Every code in the catalog must either be emitted by the original
   * engine or be backed by a runnable ledger-integrity check.
   */
  it('no catalog entry is declared without an implementation behind it', () => {
    const implemented = new Set([...emitted, ...LEDGER_INTEGRITY_CHECKS.map((c) => c.code)]);
    for (const code of RECONCILIATION_CHECK_CODES) {
      expect(implemented.has(code)).toBe(true);
    }
  });

  it('the ledger-integrity checks are wired into the ONE engine, not a second job', () => {
    // Two reconciliation runs writing into one exceptions table with different
    // run-date semantics would itself be a reconciliation problem.
    expect(ENGINE_SOURCE).toContain('LEDGER_INTEGRITY_CHECKS');
  });
});

// ─── The four §78 checks actually run ─────────────────────────────────────────

describe('the four checks §78 requires', () => {
  const REQUIRED = [
    'ORPHANED_PAYMENT_WITHOUT_BOOKING',
    'COMPLETED_BOOKING_WITHOUT_EARNING',
    'PAYOUT_WITHOUT_EARNING',
    'REFUND_EXCEEDS_CAPTURED_AMOUNT',
  ];

  it.each(REQUIRED)('%s is implemented as a runnable check', (code) => {
    expect(LEDGER_INTEGRITY_CHECKS.map((c) => c.code)).toContain(code);
  });

  it.each(REQUIRED)('%s records an exception when it finds a row', async (code) => {
    const check = LEDGER_INTEGRITY_CHECKS.find((c) => c.code === code)!;
    answers.push([
      /SELECT/,
      () => ({
        rows: [{
          id: 1, booking_id: 42, payment_id: 7, worker_uid: 'provider-1',
          amount: 1500, refunded_amount: 2000, refunded_events: 2000,
          worker_share: 1200, final_price: 1500, event_amount: 1100,
          disbursement_id: 3,
        }],
        rowCount: 1,
      }),
    ]);

    const recorded: any[] = [];
    const count = await check.run(async (exc) => { recorded.push(exc); });

    expect(count).toBe(1);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].exceptionCode).toBe(code);
    // The severity comes from the catalog, so the admin UI and the row agree.
    expect(recorded[0].severity).toBe(
      RECONCILIATION_CHECKS.find((c) => c.code === code)!.severity,
    );
    // Every break carries a description an operator can act on.
    expect(String(recorded[0].description).length).toBeGreaterThan(10);
  });

  it.each(REQUIRED)('%s records nothing when the ledger is clean', async (code) => {
    const check = LEDGER_INTEGRITY_CHECKS.find((c) => c.code === code)!;
    const recorded: any[] = [];
    expect(await check.run(async (exc) => { recorded.push(exc); })).toBe(0);
    expect(recorded).toHaveLength(0);
  });
});

// ─── The checks are written not to fire on correct behaviour ──────────────────

describe('checks that would otherwise fire on correct behaviour', () => {
  const sqlOf = (code: string) => {
    const check = LEDGER_INTEGRITY_CHECKS.find((c) => c.code === code)!;
    statements.length = 0;
    return check.run(async () => undefined).then(() => statements[0].sql);
  };

  /**
   * An internal fixer job legitimately has no disbursement. Without the
   * withheld-event clause every one of them would appear here forever — and a
   * check that fires on correct behaviour is one operators learn to ignore,
   * which is worse than not having it.
   */
  it('COMPLETED_BOOKING_WITHOUT_EARNING excuses a recorded withholding', async () => {
    const sql = await sqlOf('COMPLETED_BOOKING_WITHOUT_EARNING');
    expect(sql).toContain('PROVIDER_EARNING_WITHHELD');
    expect(sql).toContain('PROVIDER_EARNING_ACCRUED');
  });

  it('COMPLETED_BOOKING_WITHOUT_EARNING ignores synthetic bookings', async () => {
    // A synthetic booking is refused money movement by design, so it has no
    // earning and is not a break.
    expect(await sqlOf('COMPLETED_BOOKING_WITHOUT_EARNING')).toContain('is_synthetic');
  });

  it('COMPLETED_BOOKING_WITHOUT_EARNING only looks at PAID bookings', async () => {
    // An unpaid completed booking is a payment problem, which checks 1-4 already
    // report. Flagging it here too would double-count one break.
    expect(await sqlOf('COMPLETED_BOOKING_WITHOUT_EARNING')).toContain("p.status = 'PAID'");
  });

  /**
   * The event log necessarily starts empty — this repository cannot reach a
   * database to backfill. Without this guard every payout ever made would be
   * flagged the day the log shipped, burying the one real break in thousands.
   */
  it('PAYOUT_WITHOUT_EARNING ignores bookings that predate the event log', async () => {
    const sql = await sqlOf('PAYOUT_WITHOUT_EARNING');
    expect(sql).toContain('EXISTS');
    expect(sql).toContain('finance_ledger_events');
  });

  it('REFUND_EXCEEDS_CAPTURED_AMOUNT checks the column AND the event sum', async () => {
    const sql = await sqlOf('REFUND_EXCEEDS_CAPTURED_AMOUNT');
    expect(sql).toContain('refunded_amount');
    expect(sql).toContain("event_type = 'PAYMENT_REFUNDED'");
  });

  it('ORPHANED_PAYMENT_WITHOUT_BOOKING only considers money actually held', async () => {
    // A PENDING or FAILED payment attached to nothing is not money Servana holds.
    const sql = await sqlOf('ORPHANED_PAYMENT_WITHOUT_BOOKING');
    expect(sql).toMatch(/IN \('PAID','REFUNDING'\)/);
  });
});

// ─── The read model ───────────────────────────────────────────────────────────

describe('the reconciliation report', () => {
  const withTotals = (over: Record<string, unknown> = {}) => {
    answers.push([
      /FROM servana\.finance_ledger_events\s*$|SUM\(amount\) FILTER/,
      () => ({
        rows: [{
          captured: 10000, refunded: 500, accrued: 8000,
          released: 6000, internal_fixer: 1500, ...over,
        }],
        rowCount: 1,
      }),
    ]);
  };

  it('lists EVERY check, including the ones that found nothing', async () => {
    withTotals();
    const report = await getReconciliationReport();
    expect(report.checks).toHaveLength(RECONCILIATION_CHECKS.length);
    for (const check of report.checks) {
      expect(check.openCount).toBe(0);
      // Derived from the catalog, so the admin UI never hardcodes a description.
      expect(check.detects.length).toBeGreaterThan(0);
      expect(check.remediation.length).toBeGreaterThan(0);
    }
  });

  it('reports balanced when nothing is open', async () => {
    withTotals();
    const report = await getReconciliationReport();
    expect(report.balanced).toBe(true);
    expect(report.totals.openBreaks).toBe(0);
    expect(report.totals.criticalBreaks).toBe(0);
  });

  it('reports NOT balanced, and counts criticals separately, when breaks exist', async () => {
    answers.push([
      /GROUP BY exception_code/,
      () => ({
        rows: [
          { exception_code: 'PAYOUT_WITHOUT_EARNING', severity: 'critical', open_count: 2 },
          { exception_code: 'GCASH_PENDING_REVIEW_OVER_SLA', severity: 'warning', open_count: 5 },
        ],
        rowCount: 2,
      }),
    ]);
    withTotals();
    const report = await getReconciliationReport();
    expect(report.balanced).toBe(false);
    expect(report.totals.openBreaks).toBe(7);
    expect(report.totals.criticalBreaks).toBe(2);
    expect(report.checks.find((c) => c.code === 'PAYOUT_WITHOUT_EARNING')!.openCount).toBe(2);
  });

  /**
   * The number that matters most on the page: what Servana has accrued to
   * providers and not yet released. Derived rather than stored, so it cannot
   * disagree with the events it is derived from.
   */
  it('computes the outstanding provider liability as accrued minus released', async () => {
    withTotals();
    const report = await getReconciliationReport();
    expect(report.totals.accruedProviderEarnings).toBe(8000);
    expect(report.totals.releasedPayouts).toBe(6000);
    expect(report.totals.outstandingProviderLiability).toBe(2000);
  });

  it('reports internal fixer revenue separately from split revenue', async () => {
    withTotals();
    expect((await getReconciliationReport()).totals.internalFixerRevenue).toBe(1500);
  });

  it('defaults to open breaks and caps the page', async () => {
    withTotals();
    await getReconciliationReport({ limit: 100000 });
    const listing = statements.find((s) => s.sql.includes('finance_reconciliation_exceptions e'))!;
    expect(listing.params[0]).toBe('open');
    expect(listing.sql).toContain('LIMIT 200');
  });

  it('orders critical breaks first — the page is read from the top', async () => {
    withTotals();
    await getReconciliationReport();
    const listing = statements.find((s) => s.sql.includes('finance_reconciliation_exceptions e'))!;
    expect(listing.sql).toContain("WHEN 'critical' THEN 0");
  });

  it('attaches the catalog description and remediation to each break', async () => {
    answers.push([
      /SELECT e\.id, e\.exception_code/,
      () => ({
        rows: [{
          id: 1, exception_code: 'PAYOUT_WITHOUT_EARNING', severity: 'critical',
          booking_id: 42, payment_id: null, disbursement_id: 3, amount: '1200.00',
          description: 'Disbursement 3 has no earning', status: 'open',
          run_date: '2026-08-13', created_at: '2026-08-13T09:00:00.000Z',
        }],
        rowCount: 1,
      }),
    ]);
    withTotals();
    const report = await getReconciliationReport();
    expect(report.breaks[0].remediation).toMatch(/Hold the payout/);
    expect(report.breaks[0].amount).toBe(1200);
    expect(report.breaks[0].bookingId).toBe(42);
  });

  it('is READ-ONLY — it never writes an exception row', async () => {
    withTotals();
    await getReconciliationReport();
    for (const s of statements) {
      expect(s.sql).not.toMatch(/INSERT|UPDATE|DELETE/i);
    }
  });
});

// ─── Per-booking investigation ────────────────────────────────────────────────

describe('the per-booking reconciliation view', () => {
  it('returns null for a booking that does not exist', async () => {
    expect(await getBookingReconciliation(999)).toBeNull();
  });

  /**
   * An admin investigating a disputed number and the provider disputing it must
   * be reading ONE computation. That is the point of the single calculator, and
   * this is where it is asserted for the admin surface.
   */
  it('projects the SAME calculator the provider and customer see, plus the trail', async () => {
    answers.push([
      /FROM servana\.bookings b/,
      () => ({
        rows: [{
          booking_id: 42, booking_status: 'COMPLETED', final_price: '1500.00',
          additional_paid: '500.00', payment_id: 7, payment_status: 'PAID',
          worker_share: '1600.00', payout_status: 'PENDING',
          provider_uid: 'provider-1', is_internal_fixer: false,
        }],
        rowCount: 1,
      }),
    ]);
    answers.push([
      /SELECT id, event_type/,
      () => ({
        rows: [{
          id: 1, event_type: 'PAYMENT_CAPTURED', amount: '2000.00',
          counterparty: 'servana', direction: 'credit', provider_uid: null,
          payment_id: 7, disbursement_id: null, reason_code: null,
          occurred_at: '2026-08-13T09:00:00.000Z',
        }],
        rowCount: 1,
      }),
    ]);

    const result = await getBookingReconciliation(42);
    expect(result!.finance.gross).toBe(2000);
    expect(result!.finance.provider.payable).toBe(1600);
    expect(result!.events).toHaveLength(1);
    expect(result!.events[0].type).toBe('PAYMENT_CAPTURED');
  });
});
