/**
 * The finance contract, and the gate that Provider Web and Provider Mobile
 * "match exactly".
 *
 * That gate is not a promise about two client codebases — the backend cannot
 * make one. It is a claim that the two paths those clients call return the same
 * numbers, and the only way to make it checkable is to DRIVE both paths over one
 * set of rows and compare the answers. That is what the second half of this file
 * does: the legacy `/api/provider/earnings/*` controller and the canonical
 * `/api/v1/provider/earnings/*` handler are invoked against the same fake
 * database, and their payloads are asserted equal.
 *
 * Before this they were separate SQL with separate fallbacks, and they
 * disagreed. Any future edit that reintroduces a second query fails here rather
 * than in a provider's bank account.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' }, tempId: undefined }));

/**
 * `providerController` is a large module that reaches Mongo, Firebase storage
 * and the mailer at import time. Those are stubbed so the file can be IMPORTED —
 * the earnings handlers under test touch none of them, and the alternative
 * (asserting on the source text instead of the behaviour) would prove much less.
 */
jest.mock('../src/db/mongodbQuery', () => ({ __esModule: true, default: Promise.resolve({ collection: () => ({}) }) }));
jest.mock('../src/helpers/firebaseStorageUploader', () => ({ uploadFileToStorage: jest.fn() }));
jest.mock('../src/helpers/mailer', () => ({ send: jest.fn() }));
jest.mock('../src/services/firebaseFunctions.service', () => ({
  updateFirebasePassword: jest.fn(), revokeTokenInFirebase: jest.fn(), getFirebaseUserByUid: jest.fn(),
}));

const rows: any[] = [];
jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: {
    query: jest.fn(async (sql: string) => {
      if (/FROM servana\.bookings b/.test(sql)) return { rows, rowCount: rows.length };
      if (/FROM servana\.disbursements d/.test(sql)) {
        return {
          rows: rows
            .filter((r) => r.disbursement_id != null)
            .map((r) => ({
              id: r.disbursement_id, booking_id: r.booking_id, worker_share: r.worker_share,
              status: r.payout_status, created_at: '2026-08-01T09:00:00.000Z',
              released_at: r.released_at ?? null, completed_at: r.assignment_completed_at,
              release_after: '2026-08-04T09:00:00.000Z',
            })),
          rowCount: rows.filter((r) => r.disbursement_id != null).length,
        };
      }
      return { rows: [], rowCount: 0 };
    }),
  },
  pool: { connect: jest.fn() },
}));

import {
  V1_CONTRACT,
  IMPLEMENTED,
  contractById,
  fullPath,
} from '../src/api/v1/contract';
import { V1_ERROR_CODES } from '../src/api/v1/errors';
import { SCHEMAS } from '../src/api/v1/openapi';
import { FINANCE_CAPABILITIES } from '../src/services/finance/financePolicy';
import { loadManifests } from '../scripts/reconcile-client-manifests';

const FINANCE = V1_CONTRACT.filter((e) => e.domain === 'finance');

// ─── The contract ─────────────────────────────────────────────────────────────

describe('the finance domain contract', () => {
  it('mounts the seven endpoints the command names as the target architecture', () => {
    expect(FINANCE.map((e) => `${e.method.toUpperCase()} ${fullPath(e)}`).sort()).toEqual([
      'GET /api/v1/admin/finance/reconciliation',
      'GET /api/v1/bookings/:bookingId/payment',
      'GET /api/v1/provider/earnings/payouts',
      'GET /api/v1/provider/earnings/summary',
      'GET /api/v1/provider/earnings/transactions',
      'POST /api/v1/bookings/:bookingId/payment-intents',
      'POST /api/v1/bookings/:bookingId/refunds',
    ]);
  });

  it('every finance entry is implemented, not planned', () => {
    for (const entry of FINANCE) expect(entry.status).toBe('implemented');
  });

  /**
   * The field that makes "one canonical domain service behind all clients"
   * checkable: if a legacy route and its v1 successor named different services
   * they would be two business truths wearing one name.
   */
  it('every finance entry delegates to a services/finance module', () => {
    for (const entry of FINANCE) {
      expect(entry.domainService).toMatch(/^services\/finance\//);
    }
  });

  it('every declared error code exists', () => {
    for (const entry of FINANCE) {
      for (const code of entry.errors) expect(V1_ERROR_CODES).toContain(code);
    }
  });

  it('every response and request schema resolves to a written DTO', () => {
    for (const entry of FINANCE) {
      expect(SCHEMAS[entry.responseSchema]).toBeDefined();
      if (entry.requestSchema) expect(SCHEMAS[entry.requestSchema]).toBeDefined();
    }
  });

  /**
   * Every mutation must name what bounds a replay. "This one is not idempotent"
   * cannot be the end of the sentence for an operation that moves money.
   */
  it('every non-idempotent finance mutation names its replay guard', () => {
    for (const entry of FINANCE.filter((e) => !e.idempotent)) {
      expect(entry.replayGuard).toBeTruthy();
      expect(String(entry.replayGuard).length).toBeGreaterThan(60);
    }
  });

  it('the two money mutations are the only non-idempotent entries', () => {
    expect(FINANCE.filter((e) => !e.idempotent).map((e) => e.id).sort()).toEqual([
      'bookings.payments.intent',
      'bookings.refunds.create',
    ]);
  });

  it('provider earnings endpoints are provider-gated, not merely authenticated', () => {
    for (const id of [
      'provider.earnings.summary',
      'provider.earnings.transactions',
      'provider.earnings.payouts',
    ]) {
      expect(contractById(id)!.auth).toBe('provider');
    }
  });

  it('reconciliation is admin-gated', () => {
    expect(contractById('admin.finance.reconciliation')!.auth).toBe('admin');
  });

  /**
   * Booking-scoped money endpoints are `authenticated` rather than role-split on
   * purpose: the seat is derived from the caller's relationship to the booking,
   * so one path serves the customer, the provider and the admin without any of
   * them being able to claim another's rights.
   */
  it('booking money endpoints are booking-scoped rather than role-split', () => {
    for (const id of ['bookings.payments.intent', 'bookings.payments.get', 'bookings.refunds.create']) {
      const entry = contractById(id)!;
      expect(entry.auth).toBe('authenticated');
      expect(entry.errors).toContain('BOOKING_ACCESS_DENIED');
    }
  });

  it('every legacy mapping explains why it is not simply deleted', () => {
    for (const entry of FINANCE) {
      for (const legacy of entry.legacy) {
        expect(legacy.note.length).toBeGreaterThan(40);
        if (legacy.disposition !== 'RETIRE') expect(legacy.note).toBeTruthy();
      }
    }
  });

  it('names a caller state for all five surfaces on every entry', () => {
    for (const entry of FINANCE) {
      for (const surface of ['customerMobile', 'customerWeb', 'providerMobile', 'providerWeb', 'admin']) {
        expect(entry.callers[surface as keyof typeof entry.callers]).toBeDefined();
      }
    }
  });

  /**
   * A finance caller is recorded as migrated only where a manifest proves it.
   *
   * This asserted `not.toBe('migrated')` outright, on the stated premise that
   * "the platform repositories are out of scope until the backend Master Command
   * completes". The intent was exactly right: a certification must not claim a
   * migration that did not happen — and money capabilities are the last place to
   * be optimistic.
   *
   * TAB 04 ended the premise rather than the intent. The Provider Web repository
   * is in scope, publishes a manifest generated from its own source with a
   * file:line per call site, and provably calls the three earnings endpoints. So
   * the guard now asks the question that still has teeth: is there evidence?
   *
   * A client with no manifest still cannot be marked migrated here, whatever it
   * may already have shipped, because nothing in this repository has verified it.
   */
  it('records a finance migration only for a client that published a manifest', () => {
    const proven = new Set(loadManifests().map((m) => m.client));
    for (const entry of FINANCE) {
      for (const [client, state] of Object.entries(entry.callers)) {
        if (state === 'migrated') expect(proven.has(client)).toBe(true);
      }
    }
  });
});

// ─── The capability matrix points at real endpoints ───────────────────────────

describe('the capability matrix and the contract agree', () => {
  it('every capability names contract ids that exist and are implemented', () => {
    for (const capability of FINANCE_CAPABILITIES) {
      for (const id of capability.contractIds) {
        const entry = contractById(id);
        expect(entry).toBeDefined();
        expect(IMPLEMENTED.map((e) => e.id)).toContain(id);
      }
    }
  });

  it('every finance contract entry is claimed by exactly one capability', () => {
    const claimed = FINANCE_CAPABILITIES.flatMap((c) => c.contractIds);
    expect([...claimed].sort()).toEqual(FINANCE.map((e) => e.id).sort());
    expect(new Set(claimed).size).toBe(claimed.length);
  });

  it('a capability\'s declared module matches its endpoints\' domainService', () => {
    for (const capability of FINANCE_CAPABILITIES) {
      for (const id of capability.contractIds) {
        expect(contractById(id)!.domainService.startsWith(capability.domainModule)).toBe(true);
      }
    }
  });
});

// ─── The gate: both provider paths return the same numbers ────────────────────

describe('Provider Web and Provider Mobile read the same figures', () => {
  const uid = 'provider-1';

  const booking = (over: Record<string, unknown> = {}) => ({
    booking_id: 42,
    booking_status: 'COMPLETED',
    schedule: '2026-08-01T09:00:00.000Z',
    service_name: 'Aircon Cleaning',
    final_price: '1500.00',
    additional_paid: '500.00',
    payment_id: 7,
    payment_status: 'PAID',
    payment_method: 'PAYMONGO',
    paid_at: '2026-08-01T10:00:00.000Z',
    refunded_amount: '0.00',
    provider_uid: uid,
    is_internal_fixer: false,
    assignment_completed_at: '2026-08-01T12:00:00.000Z',
    disbursement_id: 3,
    worker_share: '1600.00',
    servana_share: '400.00',
    payout_status: 'PENDING',
    ...over,
  });

  /** Drives a legacy controller handler and returns what it sent. */
  const callLegacy = async (
    handler: (req: any, res: any) => Promise<unknown>,
    query: Record<string, unknown> = {},
  ) => {
    let payload: any;
    let status = 0;
    const res = {
      status(code: number) { status = code; return this; },
      json(body: any) { payload = body; return this; },
    };
    await handler({ user: { uid }, query, params: {} }, res);
    return { status, body: payload };
  };

  /** Drives a v1 handler and returns what it sent. */
  const callV1 = async (id: string, query: Record<string, unknown> = {}) => {
    const { handlers } = await import('../src/api/v1/domains/finance');
    let payload: any;
    let status = 0;
    const res = {
      status(code: number) { status = code; return this; },
      json(body: any) { payload = body; return this; },
      // The v1 envelope stamps X-Request-Id on every response, success or not.
      set() { return this; },
      setHeader() { return this; },
      headersSent: false,
    };
    await handlers[id]({ user: { uid }, query, params: {}, headers: {} } as any, res as any);
    return { status, body: payload };
  };

  beforeEach(() => {
    rows.length = 0;
    rows.push(booking());
  });

  it('the earnings summary is identical on both paths', async () => {
    const provider = await import('../src/controllers/providerController');
    const legacy = await callLegacy(provider.getEarningsSummary);
    const canonical = await callV1('provider.earnings.summary');

    expect(legacy.status).toBe(200);
    expect(legacy.body.data).toEqual(canonical.body.data);
    // And the figure itself is the RECORDED share, not a recomputation.
    expect(legacy.body.data.totalPending).toBe(1600);
  });

  it('the earnings transactions are identical on both paths', async () => {
    const provider = await import('../src/controllers/providerController');
    const legacy = await callLegacy(provider.getEarnings);
    const canonical = await callV1('provider.earnings.transactions');

    expect(legacy.body.data).toEqual(canonical.body.data);
    expect(legacy.body.data[0].bookingAmount).toBe(2000);
    expect(legacy.body.data[0].providerShareAmount).toBe(1600);
  });

  it('the payouts are the same payouts, in the two shapes the clients parse', async () => {
    const provider = await import('../src/controllers/providerController');
    const legacy = await callLegacy(provider.getPayouts);
    const canonical = await callV1('provider.earnings.payouts');

    expect(legacy.body.data).toHaveLength(1);
    expect(canonical.body.data).toHaveLength(1);
    // The legacy DTO carries extra always-null fields both clients read; the
    // MONEY and the state must be the same.
    expect(legacy.body.data[0].amountMinor).toBe(canonical.body.data[0].amountMinor);
    expect(legacy.body.data[0].status).toBe(canonical.body.data[0].status);
    expect(legacy.body.data[0].expectedArrivalAt).toBe(canonical.body.data[0].expectedArrivalAt);
  });

  /**
   * The C20 F-01 defect, in the one place it can no longer be reintroduced: the
   * ledger endpoint used to report every completed booking as `settled`,
   * including payouts that had FAILED.
   */
  it('the ledger no longer reports a failed payout as settled', async () => {
    rows.length = 0;
    rows.push(booking({ payout_status: 'FAILED' }));
    const provider = await import('../src/controllers/providerController');
    const legacy = await callLegacy(provider.getLedger);
    expect(legacy.body.data[0].status).toBe('failed');
    expect(legacy.body.data[0].settledAt).toBeNull();
  });

  it('the ledger reports a released payout as settled, dated when it was released', async () => {
    rows.length = 0;
    rows.push(booking({ payout_status: 'RELEASED', released_at: '2026-08-05T09:00:00.000Z' }));
    const provider = await import('../src/controllers/providerController');
    const legacy = await callLegacy(provider.getLedger);
    expect(legacy.body.data[0].status).toBe('settled');
    expect(legacy.body.data[0].settledAt).toBe('2026-08-05T09:00:00.000Z');
  });

  it('an internal fixer sees zero on BOTH paths, with a reason', async () => {
    rows.length = 0;
    rows.push(booking({ is_internal_fixer: true }));
    const provider = await import('../src/controllers/providerController');
    const legacy = await callLegacy(provider.getEarningsSummary);
    const canonical = await callV1('provider.earnings.summary');

    expect(legacy.body.data).toEqual(canonical.body.data);
    expect(legacy.body.data.totalEarned).toBe(0);
    expect(legacy.body.data.economicModel).toBe('INTERNAL_FIXER');
    expect(legacy.body.data.withheldReason).toMatch(/salaried/i);
  });

  it('both paths refuse a half-specified date range the same way', async () => {
    const provider = await import('../src/controllers/providerController');
    const legacy = await callLegacy(provider.getEarnings, { startDate: '2026-01-01' });
    expect(legacy.status).toBe(400);

    const canonical = await callV1('provider.earnings.transactions', { startDate: '2026-01-01' });
    expect(canonical.status).toBe(400);
    expect(canonical.body.error.code).toBe('EARNINGS_RANGE_INVALID');
  });

  it('the legacy summary keeps every field its clients already read', async () => {
    const provider = await import('../src/controllers/providerController');
    const { body } = await callLegacy(provider.getEarningsSummary);
    for (const key of [
      'totalEarned', 'totalPaid', 'totalPending', 'totalRefunded', 'periodLabel',
      'currency', 'jobsCount', 'totalFailed', 'pendingRecordedAmount',
      'pendingEstimatedAmount', 'pendingIsEstimate', 'estimatedJobsCount',
    ]) {
      expect(body.data[key]).toBeDefined();
    }
  });

  it('the legacy transaction keeps every field its clients already read', async () => {
    const provider = await import('../src/controllers/providerController');
    const { body } = await callLegacy(provider.getEarnings);
    for (const key of [
      'id', 'bookingId', 'bookingCode', 'serviceName', 'completedAt', 'scheduledAt',
      'bookingAmount', 'providerShareAmount', 'providerSharePercent', 'clientPaymentStatus',
      'bookingStatus', 'providerPayoutStatus', 'payoutStatusCanonical', 'disbursedAt',
      'expectedArrivalAt', 'paymentMethod', 'currency',
    ]) {
      expect(body.data[0][key]).toBeDefined();
    }
  });
});
