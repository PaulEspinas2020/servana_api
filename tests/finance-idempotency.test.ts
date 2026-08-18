/**
 * §72 and §77 — the money operations are idempotent, and the internal-fixer rule
 * is enforced at the WRITER.
 *
 * The writer is the point. `INTERNAL_FIXER_JOB_WITH_PROVIDER_PAYOUT` has existed
 * as a critical reconciliation check since the engine was written, with the
 * description "should be NOT_APPLICABLE" — and `createDisbursement` had no
 * internal-fixer branch, so every completed internal-fixer job created a payout
 * the hourly scheduler then released, and the check flagged it afterwards as a
 * break nobody could close because nothing upstream would stop the next one. A
 * test that only asserted the check fires would have passed the whole time.
 *
 * So this suite drives `createDisbursement` itself and asserts on the statements
 * it issues.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' }, tempId: undefined }));

interface Recorded { sql: string; params: unknown[] }
const statements: Recorded[] = [];
/** Programmed answers, matched on a fragment of the statement. */
const answers: Array<[RegExp, (params: unknown[]) => { rows: any[]; rowCount: number }]> = [];

const respond = (sql: string, params: unknown[]) => {
  for (const [pattern, make] of answers) {
    if (pattern.test(sql)) return make(params);
  }
  return { rows: [], rowCount: 0 };
};

jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      statements.push({ sql, params });
      return respond(sql, params);
    }),
  },
  pool: { connect: jest.fn() },
}));

jest.mock('../src/services/technicianService', () => ({
  getWorkerBankAccount: jest.fn(async () => ({
    bank_code: 'BDO', account_number: '0001', account_name: 'A Provider',
  })),
}));

import { createDisbursement } from '../src/services/disbursement.service';
import {
  recordEarningOutcome,
  recordLedgerEvent,
  recordPaymentCaptured,
  eventKeys,
} from '../src/services/finance/financeLedger';

const sqlFor = (fragment: string | RegExp) =>
  statements.filter((s) =>
    typeof fragment === 'string' ? s.sql.includes(fragment) : fragment.test(s.sql),
  );

/** The booking row `createDisbursement` reads before deciding anything. */
const bookingRow = (over: Record<string, unknown> = {}) => ({
  final_price: 1500,
  worker_uid: 'provider-1',
  is_synthetic: false,
  is_internal_fixer: false,
  additional_paid: 0,
  ...over,
});

beforeEach(() => {
  statements.length = 0;
  answers.length = 0;
  answers.push([/FROM servana\.bookings b/, () => ({ rows: [bookingRow()], rowCount: 1 })]);
  answers.push([
    /INSERT INTO\s+servana\.disbursements/,
    () => ({ rows: [{ id: 9, worker_share: 1200 }], rowCount: 1 }),
  ]);
});

// ─── Internal fixer economics, at the writer ──────────────────────────────────

describe('createDisbursement refuses to create an internal fixer payout', () => {
  beforeEach(() => {
    answers[0] = [
      /FROM servana\.bookings b/,
      () => ({ rows: [bookingRow({ is_internal_fixer: true })], rowCount: 1 }),
    ];
  });

  it('creates no disbursement row at all', async () => {
    const result = await createDisbursement(1);
    expect(result).toBeNull();
    expect(sqlFor(/INSERT INTO\s+servana\.disbursements/)).toHaveLength(0);
  });

  /**
   * A completed internal-fixer job with NO event at all would be
   * indistinguishable from a completed job whose accrual was dropped by a bug,
   * and `COMPLETED_BOOKING_WITHOUT_EARNING` would flag both. Writing an
   * explained zero is what lets reconciliation tell the designed case from the
   * defect.
   */
  it('records an explained zero instead of nothing', async () => {
    await createDisbursement(1);
    const withheld = sqlFor('finance_ledger_events').filter((s) =>
      s.params.includes('PROVIDER_EARNING_WITHHELD'),
    );
    expect(withheld).toHaveLength(1);
    expect(withheld[0].params).toContain('INTERNAL_FIXER_SALARIED');
  });

  it('records the revenue Servana retained, so it is visible rather than absent', async () => {
    await createDisbursement(1);
    const retained = sqlFor('finance_ledger_events').filter((s) =>
      s.params.includes('INTERNAL_FIXER_REVENUE_RETAINED'),
    );
    expect(retained).toHaveLength(1);
    // The WHOLE gross, not a share of it.
    expect(retained[0].params).toContain(1500);
  });

  it('holds the whole gross including paid additional work', async () => {
    answers[0] = [
      /FROM servana\.bookings b/,
      () => ({ rows: [bookingRow({ is_internal_fixer: true, additional_paid: 3500 }), ], rowCount: 1 }),
    ];
    await createDisbursement(1);
    const retained = sqlFor('finance_ledger_events').filter((s) =>
      s.params.includes('INTERNAL_FIXER_REVENUE_RETAINED'),
    );
    expect(retained[0].params).toContain(5000);
  });

  it('never records an accrued earning for them', async () => {
    await createDisbursement(1);
    const accrued = sqlFor('finance_ledger_events').filter((s) =>
      s.params.includes('PROVIDER_EARNING_ACCRUED'),
    );
    expect(accrued).toHaveLength(0);
  });
});

describe('createDisbursement still pays an external provider', () => {
  it('creates the row and records the accrual', async () => {
    const result = await createDisbursement(1);
    expect(result).toEqual({ id: 9, worker_share: 1200 });
    expect(sqlFor(/INSERT INTO\s+servana\.disbursements/)).toHaveLength(1);

    const accrued = sqlFor('finance_ledger_events').filter((s) =>
      s.params.includes('PROVIDER_EARNING_ACCRUED'),
    );
    expect(accrued).toHaveLength(1);
    expect(accrued[0].params).toContain('provider-1');
  });

  it('splits the gross including PAID additional work', async () => {
    answers[0] = [
      /FROM servana\.bookings b/,
      () => ({ rows: [bookingRow({ additional_paid: 3500 })], rowCount: 1 }),
    ];
    await createDisbursement(1);
    const insert = sqlFor(/INSERT INTO\s+servana\.disbursements/)[0];
    // total, servana, worker for a 5,000 gross.
    expect(insert.params).toContain(5000);
    expect(insert.params).toContain(4000);
    expect(insert.params).toContain(1000);
  });

  it('the insert is ON CONFLICT DO NOTHING, so a second completion adds nothing', async () => {
    await createDisbursement(1);
    expect(sqlFor(/INSERT INTO\s+servana\.disbursements/)[0].sql)
      .toContain('ON CONFLICT (booking_id) DO NOTHING');
  });

  /**
   * A second completion returns no row from the conflicting insert, and the
   * earning still exists. Keying the event on the booking and provider rather
   * than on the insert is what keeps the log complete without duplicating it.
   */
  it('records the earning even when the insert conflicted away', async () => {
    answers[1] = [/INSERT INTO\s+servana\.disbursements/, () => ({ rows: [], rowCount: 0 })];
    const result = await createDisbursement(1);
    expect(result).toBeNull();
    expect(
      sqlFor('finance_ledger_events').filter((s) => s.params.includes('PROVIDER_EARNING_ACCRUED')),
    ).toHaveLength(1);
  });

  it('refuses a synthetic booking loudly rather than skipping it quietly', async () => {
    answers[0] = [
      /FROM servana\.bookings b/,
      () => ({ rows: [bookingRow({ is_synthetic: true })], rowCount: 1 }),
    ];
    await expect(createDisbursement(1)).rejects.toThrow(/synthetic/i);
    expect(sqlFor(/INSERT INTO\s+servana\.disbursements/)).toHaveLength(0);
  });

  it('skips a booking with no assigned provider without inventing an earning', async () => {
    answers[0] = [
      /FROM servana\.bookings b/,
      () => ({ rows: [bookingRow({ worker_uid: null })], rowCount: 1 }),
    ];
    expect(await createDisbursement(1)).toBeNull();
    expect(sqlFor('finance_ledger_events')).toHaveLength(0);
  });
});

// ─── Ledger idempotency ───────────────────────────────────────────────────────

describe('the event log is idempotent by construction', () => {
  it('every insert is ON CONFLICT (event_key) DO NOTHING', async () => {
    await recordLedgerEvent({
      eventKey: eventKeys.paymentCaptured(47),
      type: 'PAYMENT_CAPTURED',
      bookingId: 42,
      paymentId: 47,
      amount: 1500,
    });
    const insert = sqlFor('INSERT INTO servana.finance_ledger_events')[0];
    expect(insert.sql).toContain('ON CONFLICT (event_key) DO NOTHING');
  });

  /**
   * `false` is a successful outcome meaning "already recorded" — which is
   * exactly what a retried PayMongo webhook should produce. A writer that threw
   * here would turn a duplicate delivery into a 500 and a retry storm.
   */
  it('a repeat reports "already recorded" rather than failing', async () => {
    answers.push([/INSERT INTO servana\.finance_ledger_events/, () => ({ rows: [], rowCount: 0 })]);
    const created = await recordLedgerEvent({
      eventKey: eventKeys.paymentCaptured(47),
      type: 'PAYMENT_CAPTURED',
      bookingId: 42,
      amount: 1500,
    });
    expect(created).toBe(false);
  });

  it('a first write reports that it created the row', async () => {
    answers.push([
      /INSERT INTO servana\.finance_ledger_events/,
      () => ({ rows: [{ id: 1 }], rowCount: 1 }),
    ]);
    expect(
      await recordLedgerEvent({
        eventKey: eventKeys.paymentCaptured(48),
        type: 'PAYMENT_CAPTURED',
        bookingId: 42,
        amount: 1500,
      }),
    ).toBe(true);
  });

  it('a capture and its additional-work counterpart are different events', async () => {
    await recordPaymentCaptured({ bookingId: 42, paymentId: 47, amount: 1500 });
    await recordPaymentCaptured({
      bookingId: 42, paymentId: 48, amount: 500, additionalRequestId: 5,
    });
    const inserts = sqlFor('INSERT INTO servana.finance_ledger_events');
    expect(inserts[0].params).toContain('PAYMENT_CAPTURED');
    expect(inserts[1].params).toContain('ADDITIONAL_WORK_CAPTURED');
    expect(inserts[0].params[0]).not.toBe(inserts[1].params[0]);
  });

  it('refuses an unknown event type rather than writing an unclassified row', async () => {
    await expect(
      recordLedgerEvent({
        eventKey: 'x', type: 'NOT_A_REAL_EVENT' as never, bookingId: 1, amount: 1,
      }),
    ).rejects.toThrow(/unknown event type/i);
  });

  it('refuses a negative amount on a monetary event', async () => {
    await expect(
      recordLedgerEvent({
        eventKey: 'x', type: 'PAYMENT_CAPTURED', bookingId: 1, amount: -1,
      }),
    ).rejects.toThrow(/negative/i);
  });

  it('writes the counterparty and direction FROM the catalog, not from the caller', async () => {
    await recordLedgerEvent({
      eventKey: eventKeys.payoutReleased(3),
      type: 'PROVIDER_PAYOUT_RELEASED',
      bookingId: 42,
      amount: 1200,
    });
    const insert = sqlFor('INSERT INTO servana.finance_ledger_events')[0];
    expect(insert.params).toContain('provider');
    expect(insert.params).toContain('debit');
  });

  it('an internal fixer outcome writes BOTH halves — the zero and the retained revenue', async () => {
    await recordEarningOutcome({
      bookingId: 42,
      providerUid: 'provider-1',
      economicModel: 'INTERNAL_FIXER',
      payable: 0,
      gross: 1500,
    });
    const types = sqlFor('INSERT INTO servana.finance_ledger_events').map((s) => s.params[1]);
    expect(types).toEqual(['PROVIDER_EARNING_WITHHELD', 'INTERNAL_FIXER_REVENUE_RETAINED']);
  });
});
