/**
 * The one domain service behind every provider earnings surface.
 *
 * ## What it replaces
 *
 * Provider Web and Provider Mobile each had their own idea of what a provider
 * had earned, and so did the backend — three times over. `/provider/earnings`,
 * `/provider/earnings/summary` and `/provider/ledger` read the same four tables
 * and answered differently: the ledger hardcoded every completed booking as
 * `settled`, the summary counted PROCESSING payouts in neither "paid" nor
 * "pending", and the list fell back to `final_price × rate` while the summary
 * fell back to something else. Each was fixed on its own, which is why the same
 * class of defect kept reappearing in the endpoint nobody had looked at yet.
 *
 * Every function here derives from `computeBookingFinance` — the single
 * calculator — over the single shared SELECT. Provider Web and Provider Mobile
 * calling the same path and receiving the same numbers is then a property of the
 * code rather than an agreement between two implementations.
 *
 * ## The subject is always the token
 *
 * No function here takes a provider uid from a path, a query or a body. The uid
 * is passed in by the caller, and every caller obtains it from the verified
 * token. That is what makes `tests/finance-leakage.test.ts` able to state, as a
 * property of the SQL, that a provider cannot read another provider's money:
 * every query filters on the same bound parameter.
 *
 * ## Internal fixers
 *
 * They see zero, with a sentence explaining why, and never an estimate. A
 * salaried employee shown a pending "provider share" that will never arrive is
 * worse than one shown nothing — see `financePolicy.PROVIDER_ECONOMIC_MODELS`.
 */

import dbQuery from '../../db/dbQuery';
import { db } from '../../config';
import {
  bookingFinanceSelect,
  computeBookingFinance,
  toBookingFinanceRow,
  type BookingFinance,
} from './financeLedger';
import {
  CURRENCY,
  PROVIDER_ECONOMIC_MODELS,
  PROVIDER_PAYOUT_WINDOW_HOURS,
  economicModelFor,
  toCentavos,
  toMinorUnits,
  type ProviderEconomicModel,
} from './financePolicy';
import {
  PROVIDER_SHARE_PERCENT,
} from '../revenueSplit';
import {
  canonicalPayoutStatus,
  earningsPayoutDialect,
  payoutsPayoutDialect,
  type PayoutStatus,
} from '../payoutStatus';

const s = db.schema;

const bookingCode = (id: number | string) => `SVN-${String(id).padStart(6, '0')}`;
const payoutReference = (id: number | string) => `SVP-${String(id).padStart(6, '0')}`;

export interface EarningsRange {
  startDate?: string;
  endDate?: string;
}

export class EarningsRangeError extends Error {
  readonly code = 'EARNINGS_RANGE_INVALID';
}

/**
 * Validates the optional window once, for every reader.
 *
 * Returns the SQL fragment and its parameters rather than letting each endpoint
 * build its own — two endpoints filtering the same range differently is how a
 * summary and the list beneath it come to disagree about which jobs are in it.
 */
const rangeFilter = (uid: string, range: EarningsRange): { sql: string; params: unknown[] } => {
  const params: unknown[] = [uid];
  if (!range.startDate && !range.endDate) return { sql: '', params };
  if (!range.startDate || !range.endDate) {
    throw new EarningsRangeError('startDate and endDate must be supplied together.');
  }
  if (Number.isNaN(Date.parse(range.startDate)) || Number.isNaN(Date.parse(range.endDate))) {
    throw new EarningsRangeError('startDate and endDate must be valid dates.');
  }
  params.push(range.startDate, range.endDate);
  return { sql: 'AND b.schedule >= $2 AND b.schedule <= $3', params };
};

/**
 * Which economic model a provider is on.
 *
 * Read once per request from `user_credentials`, the same column the ledger and
 * the reconciliation engine consult. A provider with no row is treated as
 * EXTERNAL_PROVIDER, which is the model that pays — deny-by-default is the wrong
 * instinct here, since the failure mode of guessing INTERNAL_FIXER is silently
 * withholding somebody's wages.
 */
export async function providerEconomicModel(uid: string): Promise<ProviderEconomicModel> {
  const result = await dbQuery.query(
    `SELECT COALESCE(is_internal_fixer, false) AS is_internal_fixer
       FROM ${s}.user_credentials WHERE uid = $1 LIMIT 1`,
    [uid],
  );
  return economicModelFor({ isInternalFixer: result.rows[0]?.is_internal_fixer === true });
}

// ─── Transactions ─────────────────────────────────────────────────────────────

export interface EarningTransaction {
  id: string;
  bookingId: string;
  bookingCode: string;
  serviceName: string;
  completedAt: string | null;
  scheduledAt: string | null;
  /** Everything the customer was charged, including paid additional work. */
  bookingAmount: number;
  bookingAmountMinor: number;
  providerShareAmount: number;
  providerShareAmountMinor: number;
  providerSharePercent: number;
  /** True while no disbursement row exists yet, so the share is derived. */
  isEstimate: boolean;
  economicModel: ProviderEconomicModel;
  withheldReason: string | null;
  clientPaymentStatus: string;
  bookingStatus: string;
  payoutStatus: PayoutStatus;
  /** The legacy dialect, kept so migrating clients can branch on either. */
  providerPayoutStatus: string;
  /** Typed rather than `string` so a consumer switching on it is exhaustive. */
  payoutStatusCanonical: PayoutStatus;
  payoutBlockedBy: string | null;
  payoutBlockedReason: string | null;
  disbursedAt: string | null;
  expectedArrivalAt: string | null;
  paymentMethod: string | null;
  currency: string;
}

const toTransaction = (row: any, finance: BookingFinance): EarningTransaction => ({
  id: String(row.booking_id),
  bookingId: String(row.booking_id),
  bookingCode: bookingCode(row.booking_id),
  serviceName: row.service_name || '',
  // `bw.completed_at` is when the provider actually finished. Falls back to the
  // schedule only where the assignment row carries no completion time, so a
  // historical row written before the column was populated degrades to its old
  // value rather than to null.
  completedAt: row.assignment_completed_at ?? row.schedule ?? null,
  scheduledAt: row.schedule ?? null,
  bookingAmount: finance.gross,
  bookingAmountMinor: toMinorUnits(finance.gross),
  providerShareAmount: finance.provider.payable,
  providerShareAmountMinor: toMinorUnits(finance.provider.payable),
  providerSharePercent: PROVIDER_ECONOMIC_MODELS[finance.provider.economicModel].earnsJobShare
    ? PROVIDER_SHARE_PERCENT
    : 0,
  isEstimate: finance.provider.isEstimate,
  economicModel: finance.provider.economicModel,
  withheldReason: finance.provider.withheldReason,
  clientPaymentStatus: finance.payment.state.toLowerCase(),
  bookingStatus: String(row.booking_status ?? 'completed').toLowerCase(),
  payoutStatus: finance.payout.status,
  providerPayoutStatus: earningsPayoutDialect(row.payout_status),
  payoutStatusCanonical: canonicalPayoutStatus(row.payout_status),
  payoutBlockedBy: finance.payout.blockedBy,
  payoutBlockedReason: finance.payout.blockedReason,
  disbursedAt: finance.payout.releasedAt,
  expectedArrivalAt: finance.payout.eligibleAt,
  paymentMethod: finance.payment.method,
  currency: CURRENCY,
});

/**
 * One row per completed job, with its money.
 *
 * COMPLETED only, deliberately: an earning that has not been earned is not a
 * transaction, and listing in-flight jobs beside settled ones is how a provider
 * comes to read a forecast as a balance.
 */
export async function listEarningsTransactions(
  uid: string,
  range: EarningsRange = {},
  options: { now?: Date } = {},
): Promise<EarningTransaction[]> {
  const { sql, params } = rangeFilter(uid, range);
  // `$1` is the provider uid, and it scopes BOTH the booking filter and the
  // assignment/disbursement joins inside the shared SELECT. A provider therefore
  // cannot see another provider's row even if a booking were somehow shared.
  const rows = await dbQuery.query(
    `${bookingFinanceSelect(s, '$1')}
      WHERE b.worker_uid = $1 AND b.status = 'COMPLETED' ${sql}
      ORDER BY b.schedule DESC`,
    params,
  );

  return rows.rows.map((row: any) =>
    toTransaction(row, computeBookingFinance(toBookingFinanceRow(row), { now: options.now })),
  );
}

/** One transaction, scoped to the caller. Returns null when it is not theirs. */
export async function getEarningTransaction(
  uid: string,
  bookingId: number,
  options: { now?: Date } = {},
): Promise<EarningTransaction | null> {
  const rows = await dbQuery.query(
    `${bookingFinanceSelect(s, '$1')}
      WHERE b.worker_uid = $1 AND b.id = $2
      LIMIT 1`,
    [uid, bookingId],
  );
  const row = rows.rows[0];
  if (!row) return null;
  return toTransaction(row, computeBookingFinance(toBookingFinanceRow(row), { now: options.now }));
}

// ─── Summary ──────────────────────────────────────────────────────────────────

export interface EarningsSummary {
  economicModel: ProviderEconomicModel;
  /** Present for INTERNAL_FIXER. Null for anyone who earns a job share. */
  withheldReason: string | null;
  totalEarned: number;
  totalPaid: number;
  totalPending: number;
  totalFailed: number;
  totalRefunded: number;
  /** Minor-unit twins of the five above. Centavos, integer. TAB 04. */
  totalEarnedMinor: number;
  totalPaidMinor: number;
  totalPendingMinor: number;
  totalFailedMinor: number;
  totalRefundedMinor: number;
  pendingRecordedAmountMinor: number;
  pendingEstimatedAmountMinor: number;
  /** The portion of totalPending backed by a disbursement row. */
  pendingRecordedAmount: number;
  /** The portion still derived because no disbursement row exists yet. */
  pendingEstimatedAmount: number;
  pendingIsEstimate: boolean;
  estimatedJobsCount: number;
  jobsCount: number;
  periodLabel: string;
  currency: string;
  payoutWindowHours: number;
}

/**
 * The provider's money, totalled.
 *
 * Summed from the SAME per-booking calculator the transaction list uses rather
 * than from a parallel aggregate query. That is the whole point: a summary
 * computed by its own SQL is a second implementation, and the previous one drifted
 * from the list in three separate ways before anybody noticed.
 *
 * The cost is that this materialises the provider's completed bookings rather
 * than aggregating in the database. Accepted deliberately — the set is one
 * provider's completed jobs, and an aggregate that can disagree with the rows
 * beneath it is not worth the query plan.
 */
export async function getEarningsSummary(
  uid: string,
  range: EarningsRange = {},
  options: { now?: Date } = {},
): Promise<EarningsSummary> {
  const transactions = await listEarningsTransactions(uid, range, options);
  const model = transactions[0]?.economicModel ?? (await providerEconomicModel(uid));

  let totalPaid = 0;
  let pendingRecorded = 0;
  let pendingEstimated = 0;
  let totalFailed = 0;
  let totalRefunded = 0;
  let estimatedJobs = 0;

  for (const t of transactions) {
    const amount = t.providerShareAmount;
    if (t.isEstimate) estimatedJobs += 1;

    // A refunded booking's share is reported as refunded rather than owed. The
    // provider is not owed a share of money the customer got back.
    if (t.clientPaymentStatus === 'refunded') {
      totalRefunded += amount;
      continue;
    }

    switch (t.payoutStatusCanonical) {
      case 'paid':
        totalPaid += amount;
        break;
      case 'failed':
        // Split out of pending because a failed payout needs intervention
        // rather than patience, and folding it into "pending" tells the
        // provider it is on its way.
        totalFailed += amount;
        break;
      default:
        if (t.isEstimate) pendingEstimated += amount;
        else pendingRecorded += amount;
    }
  }

  const money = (v: number) => toCentavos(v);
  const totalPending = money(pendingRecorded + pendingEstimated);

  return {
    economicModel: model,
    withheldReason: PROVIDER_ECONOMIC_MODELS[model].earnsJobShare
      ? null
      : PROVIDER_ECONOMIC_MODELS[model].earningsDisclosure,
    // Rounded after summing, not before: rounding each part and adding lets the
    // displayed total drift from its own parts by a centavo.
    totalEarned: money(totalPaid + pendingRecorded + pendingEstimated + totalFailed),
    totalPaid: money(totalPaid),
    totalPending,
    totalFailed: money(totalFailed),
    totalRefunded: money(totalRefunded),
    pendingRecordedAmount: money(pendingRecorded),
    pendingEstimatedAmount: money(pendingEstimated),

    /**
     * Minor-unit twins (TAB 04).
     *
     * Purely additive: every field above keeps its name, type and value, so a
     * client reading the float path is unaffected. What changes is that one
     * that wants to COMPUTE no longer has to do it in floats — an integer
     * number of centavos cannot drift, and a float number of pesos accumulates
     * error at the fourth decimal place and surfaces months later in a
     * reconciliation report.
     *
     * Derived from the SAME expressions as their majors, not re-summed. A twin
     * computed independently is a second and subtly different source for one
     * number, which is worse than not having one.
     */
    totalEarnedMinor: toMinorUnits(totalPaid + pendingRecorded + pendingEstimated + totalFailed),
    totalPaidMinor: toMinorUnits(totalPaid),
    totalPendingMinor: toMinorUnits(totalPending),
    totalFailedMinor: toMinorUnits(totalFailed),
    totalRefundedMinor: toMinorUnits(totalRefunded),
    pendingRecordedAmountMinor: toMinorUnits(pendingRecorded),
    pendingEstimatedAmountMinor: toMinorUnits(pendingEstimated),
    pendingIsEstimate: estimatedJobs > 0,
    estimatedJobsCount: estimatedJobs,
    jobsCount: transactions.length,
    periodLabel: range.startDate ? 'Custom range' : 'All time',
    currency: CURRENCY,
    payoutWindowHours: PROVIDER_PAYOUT_WINDOW_HOURS,
  };
}

// ─── Payouts ──────────────────────────────────────────────────────────────────

export interface ProviderPayout {
  id: string;
  bookingId: string;
  bookingCode: string;
  amount: number;
  amountMinor: number;
  currency: string;
  status: string;
  payoutStatusCanonical: PayoutStatus;
  initiatedAt: string | null;
  expectedArrivalAt: string | null;
  completedAt: string | null;
  /** A Servana handle support can discuss. Never the processor's id. */
  reference: string;
  payoutWindowHours: number;
}

/**
 * The provider's own payouts.
 *
 * Processor identifiers, `servana_share`, `payout_error` and the admin hold
 * fields are all excluded by the projection, not merely omitted from a `SELECT *`
 * — `listDisbursements` in `disbursement.service` returns the whole row and this
 * used to map it by hand, which is one forgotten field away from disclosing
 * Servana's margin to the provider whose share it was taken from.
 */
export async function listProviderPayouts(
  uid: string,
  options: { now?: Date } = {},
): Promise<ProviderPayout[]> {
  const result = await dbQuery.query(
    `SELECT d.id, d.booking_id, d.worker_share, d.status, d.created_at, d.released_at,
            bw.completed_at,
            bw.completed_at + INTERVAL '${PROVIDER_PAYOUT_WINDOW_HOURS} hours' AS release_after
       FROM ${s}.disbursements d
       LEFT JOIN ${s}.booking_workers bw
              ON bw.booking_id = d.booking_id
             AND bw.worker_uid = d.worker_uid
             AND bw.status = 'COMPLETED'
      WHERE d.worker_uid = $1
      ORDER BY d.created_at DESC`,
    [uid],
  );

  return result.rows.map((r: any) => ({
    id: String(r.id),
    bookingId: String(r.booking_id),
    bookingCode: bookingCode(r.booking_id),
    amount: toCentavos(r.worker_share),
    amountMinor: toMinorUnits(r.worker_share),
    currency: CURRENCY,
    status: payoutsPayoutDialect(r.status),
    payoutStatusCanonical: canonicalPayoutStatus(r.status),
    initiatedAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    expectedArrivalAt: r.release_after ? new Date(r.release_after).toISOString() : null,
    completedAt: r.released_at ? new Date(r.released_at).toISOString() : null,
    reference: payoutReference(r.id),
    payoutWindowHours: PROVIDER_PAYOUT_WINDOW_HOURS,
  }));
}
