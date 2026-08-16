/**
 * §79 — financial data cannot leak across seats.
 *
 * Two claims, and they are proved differently on purpose.
 *
 * **A provider can only read their own money.** Proved as a property of the SQL:
 * every earnings query is captured and asserted to bind the caller's uid, and to
 * take that uid from the bound parameter rather than from anything a caller
 * could name. This is stronger than driving the endpoints with two fixtures,
 * because it holds for rows that do not exist yet.
 *
 * **A customer can only read their own booking's payment, and each seat sees
 * only its own fields.** Proved against the projection: the same
 * `computeBookingFinance` result is projected for all three actors and the
 * disclosed key sets are asserted to be disjoint where they must be.
 *
 * The projection test matters because the DTOs are ADDITIVE — each actor's shape
 * is built by naming fields rather than by deleting them from a shared object. A
 * subtractive projection discloses everything somebody forgets to remove, and
 * this suite is what would catch the drift back to one.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' }, tempId: undefined }));

const queries: Array<{ sql: string; params: unknown[] }> = [];
jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      return { rows: [], rowCount: 0 };
    }),
  },
  pool: { connect: jest.fn() },
}));

import {
  getEarningsSummary,
  getEarningTransaction,
  listEarningsTransactions,
  listProviderPayouts,
  providerEconomicModel,
} from '../src/services/finance/providerEarningsService';
import { projectFor } from '../src/services/finance/bookingPaymentService';
import { computeBookingFinance } from '../src/services/finance/financeLedger';

const OWNER = 'provider-owner';
const OTHER = 'provider-other';

beforeEach(() => {
  queries.length = 0;
});

// ─── Provider isolation ───────────────────────────────────────────────────────

describe('a provider reads only their own financial data', () => {
  /**
   * Every earnings read must filter on the caller. Asserted for each entry point
   * rather than for one representative, because the leak that matters is the
   * endpoint somebody adds later and forgets to scope.
   */
  const READS: Array<[string, () => Promise<unknown>]> = [
    ['listEarningsTransactions', () => listEarningsTransactions(OWNER)],
    ['getEarningsSummary', () => getEarningsSummary(OWNER)],
    ['getEarningTransaction', () => getEarningTransaction(OWNER, 42)],
    ['listProviderPayouts', () => listProviderPayouts(OWNER)],
    ['providerEconomicModel', () => providerEconomicModel(OWNER)],
  ];

  it.each(READS)('%s binds the caller uid as a parameter', async (_name, run) => {
    await run();
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) {
      expect(q.params[0]).toBe(OWNER);
    }
  });

  it.each(READS)('%s never interpolates a uid into the SQL text', async (_name, run) => {
    await run();
    for (const q of queries) {
      // A uid inside the statement rather than in the parameter list is both an
      // injection surface and a sign the subject came from somewhere other than
      // the token.
      expect(q.sql).not.toContain(OWNER);
      expect(q.sql).not.toContain(OTHER);
    }
  });

  it('scopes the earnings list on the provider column, not merely on a join', () => {
    return listEarningsTransactions(OWNER).then(() => {
      const sql = queries[0].sql;
      expect(sql).toContain('b.worker_uid = $1');
      // And the assignment and payout joins carry the same parameter, so a row
      // belonging to another provider on the same booking cannot be picked up.
      expect(sql).toContain('bw.worker_uid = $1');
      expect(sql).toContain('d.worker_uid = $1');
    });
  });

  it('scopes a single earning lookup on the provider AND the booking', async () => {
    await getEarningTransaction(OWNER, 42);
    expect(queries[0].sql).toContain('b.worker_uid = $1');
    expect(queries[0].params).toEqual([OWNER, 42]);
  });

  it('scopes payouts on the disbursement owner', async () => {
    await listProviderPayouts(OWNER);
    expect(queries[0].sql).toContain('d.worker_uid = $1');
    expect(queries[0].params).toEqual([OWNER]);
  });

  /**
   * The summary is derived from the transaction list rather than from its own
   * aggregate query. That is a correctness property (the two cannot drift) and
   * incidentally a security one: there is no second query to forget to scope.
   */
  it('the summary inherits the list\'s scoping because it reuses the list', async () => {
    await getEarningsSummary(OWNER);
    for (const q of queries) expect(q.params[0]).toBe(OWNER);
  });

  it('a date range never displaces the uid from the first parameter', async () => {
    await listEarningsTransactions(OWNER, {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    });
    expect(queries[0].params[0]).toBe(OWNER);
    expect(queries[0].params).toHaveLength(3);
  });
});

// ─── Per-seat field disclosure ────────────────────────────────────────────────

describe('each seat sees only its own fields', () => {
  const finance = computeBookingFinance(
    {
      bookingId: 42,
      finalPrice: 1500,
      additionalPaid: 500,
      paymentId: 7,
      paymentStatus: 'PAID',
      paymentMethod: 'PAYMONGO',
      refundedAmount: 250,
      providerUid: 'provider-1',
      isInternalFixer: false,
      assignmentCompletedAt: '2026-08-01T09:00:00.000Z',
      disbursementId: 3,
      workerShare: 1600,
      servanaShare: 400,
      payoutStatus: 'PENDING',
      holdReason: 'Under review',
    },
    { now: new Date('2026-08-13T12:00:00.000Z') },
  );

  const customer = projectFor('customer', finance) as Record<string, unknown>;
  const provider = projectFor('assigned_provider', finance) as Record<string, unknown>;
  const admin = projectFor('admin', finance) as Record<string, unknown>;

  /**
   * Servana's margin, taken from the provider's own job. Disclosing it to the
   * provider is a commercial leak; disclosing it to the customer invites a
   * conversation about the platform fee on every booking screen.
   */
  it('only the admin learns what Servana retained', () => {
    expect(admin.servana).toBeDefined();
    expect(provider.servana).toBeUndefined();
    expect(customer.servana).toBeUndefined();
  });

  it('the provider is never told the customer\'s refund position', () => {
    expect(provider.refund).toBeUndefined();
    expect(customer.refund).toBeDefined();
    expect(admin.refund).toBeDefined();
  });

  it('the customer is never told the provider\'s share', () => {
    expect(customer.earning).toBeUndefined();
    expect(customer.provider).toBeUndefined();
    expect(provider.earning).toBeDefined();
  });

  it('the internal payment row id is admin-only', () => {
    expect(admin.paymentId).toBe(7);
    expect(customer.paymentId).toBeUndefined();
    expect(provider.paymentId).toBeUndefined();
  });

  /**
   * The provider IS told the gross, deliberately: their share is a percentage of
   * it, and a share whose basis is hidden cannot be checked by the person being
   * paid it.
   */
  it('the provider is told the gross their share is a percentage of', () => {
    expect((provider.breakdown as Record<string, unknown>).gross).toBe(2000);
    expect((provider.earning as Record<string, unknown>).payable).toBe(1600);
  });

  it('no seat receives a processor reference', () => {
    for (const projection of [customer, provider, admin]) {
      const serialized = JSON.stringify(projection);
      expect(serialized).not.toMatch(/processorReference/);
      expect(serialized).not.toMatch(/\bpay_/);
      expect(serialized).not.toMatch(/\bcs_/);
    }
  });

  /**
   * The hold REASON is an internal note — it can name a dispute, an
   * investigation or another party. The provider is told their payout is held
   * and the standard sentence for that; they are not shown the admin's text.
   */
  it('the admin hold note never reaches the provider verbatim', () => {
    expect(JSON.stringify(provider)).not.toContain('Under review');
    expect((provider.payout as Record<string, unknown>).blockedBy).toBe('ADMIN_HOLD');
  });

  it('every seat computes the same gross — one calculator, three views', () => {
    const gross = (p: Record<string, unknown>) =>
      (p.breakdown as Record<string, unknown>).gross;
    expect(gross(customer)).toBe(gross(provider));
    expect(gross(provider)).toBe(gross(admin));
  });

  it('an internal fixer is shown zero and a reason, on every seat that sees earnings', () => {
    const fixerFinance = computeBookingFinance(
      { ...({ bookingId: 42, finalPrice: 1500, isInternalFixer: true, workerShare: 1200 } as any) },
      { now: new Date('2026-08-13T12:00:00.000Z') },
    );
    const fixerProvider = projectFor('assigned_provider', fixerFinance) as Record<string, unknown>;
    const fixerAdmin = projectFor('admin', fixerFinance) as Record<string, unknown>;
    expect((fixerProvider.earning as Record<string, unknown>).payable).toBe(0);
    expect((fixerProvider.earning as Record<string, unknown>).withheldReason).toMatch(/salaried/i);
    expect((fixerAdmin.provider as Record<string, unknown>).payable).toBe(0);
  });
});
