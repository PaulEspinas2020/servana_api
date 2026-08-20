/**
 * Reconciliation over the canonical ledger.
 *
 * ## Two halves, both of which were missing
 *
 * **The §78 checks.** The existing engine in `adminFinanceService` found nine
 * classes of break, all of them about a payment or a payout in isolation. None
 * of them asked the question the ledger exists to answer: does the record agree
 * with itself? A completed booking with no earning, a payout with no earning
 * behind it, a payment attached to no booking and refunds totalling more than
 * was ever captured are the four §78 names, and each is a way for money to be
 * wrong that no single-table check can see.
 *
 * **The read model.** There was a `POST .../reconciliation/run` and a
 * `GET .../reconciliation/exceptions`, so an admin could trigger a run and page
 * through rows, but nothing answered "is the ledger balanced right now". §76
 * asks for admin reconciliation views over the same ledger with booking, payment
 * and provider references; `getReconciliationReport` is that view, and it
 * projects from the same `computeBookingFinance` the provider and customer
 * endpoints use.
 *
 * ## Why the checks live here and run there
 *
 * `runReconciliation` remains the one engine. These checks are exported as data
 * and appended to its list rather than run by a second scheduler, because two
 * reconciliation runs writing into one exceptions table with different run-date
 * semantics is itself a reconciliation problem.
 */

import dbQuery from '../../db/dbQuery';
import { db } from '../../config';
import {
  RECONCILIATION_CHECKS,
  toCentavos,
  toMinorUnits,
  type ReconciliationCheckSpec,
} from './financePolicy';
import { bookingFinanceSelect, computeBookingFinance, toBookingFinanceRow } from './financeLedger';

const s = db.schema;

export interface ExceptionRecorder {
  (exc: {
    exceptionCode: string;
    severity: 'warning' | 'critical' | 'info';
    bookingId?: number | null;
    paymentId?: number | null;
    disbursementId?: number | null;
    amount?: number | null;
    description: string;
  }): Promise<void>;
}

const specFor = (code: string): ReconciliationCheckSpec => {
  const spec = RECONCILIATION_CHECKS.find((c) => c.code === code);
  if (!spec) throw new Error(`financeReconciliation: ${code} is not in the check catalog`);
  return spec;
};

/**
 * The ledger-integrity checks §78 requires.
 *
 * Each returns the number of exceptions it recorded so the caller can total a
 * run. They are deliberately written as SQL against the source rows rather than
 * against the event log alone: the log necessarily starts empty (this repository
 * cannot reach a database to backfill), so a check that only read events would
 * report a clean ledger on day one no matter what the underlying rows said.
 */
export const LEDGER_INTEGRITY_CHECKS: ReadonlyArray<{
  code: string;
  run: (record: ExceptionRecorder) => Promise<number>;
}> = Object.freeze([
  {
    /**
     * A captured payment that points at no booking, or at one that is gone.
     *
     * `payments.booking_id` has no NOT NULL constraint and bookings are deleted
     * by cascade elsewhere, so this is reachable. A captured payment nobody can
     * attribute is money Servana holds and cannot account for.
     */
    code: 'ORPHANED_PAYMENT_WITHOUT_BOOKING',
    run: async (record) => {
      const spec = specFor('ORPHANED_PAYMENT_WITHOUT_BOOKING');
      const r = await dbQuery.query(
        `SELECT p.id, p.booking_id, p.amount
           FROM ${s}.payments p
           LEFT JOIN ${s}.bookings b ON b.id = p.booking_id
          WHERE p.status IN ('PAID','REFUNDING')
            AND (p.booking_id IS NULL OR b.id IS NULL)`,
      );
      for (const row of r.rows) {
        await record({
          exceptionCode: spec.code,
          severity: spec.severity,
          bookingId: row.booking_id == null ? null : Number(row.booking_id),
          paymentId: Number(row.id),
          amount: toCentavos(row.amount),
          description: `Captured payment ${row.id} references no existing booking`,
        });
      }
      return r.rows.length;
    },
  },
  {
    /**
     * A paid, completed job that produced neither an earning nor a recorded
     * reason for withholding one.
     *
     * The `PROVIDER_EARNING_WITHHELD` clause is what makes this check usable. An
     * internal fixer job legitimately has no disbursement, and without that
     * clause every one of them would appear here forever — a check that fires on
     * correct behaviour is a check operators learn to ignore, which is worse
     * than not having it.
     */
    code: 'COMPLETED_BOOKING_WITHOUT_EARNING',
    run: async (record) => {
      const spec = specFor('COMPLETED_BOOKING_WITHOUT_EARNING');
      const r = await dbQuery.query(
        `SELECT b.id, b.worker_uid, COALESCE(b.final_price, 0) AS final_price
           FROM ${s}.bookings b
           JOIN ${s}.booking_workers bw
             ON bw.booking_id = b.id AND bw.worker_uid = b.worker_uid
            AND bw.status = 'COMPLETED'
           JOIN ${s}.payments p
             ON p.booking_id = b.id AND p.additional_request_id IS NULL AND p.status = 'PAID'
          WHERE b.worker_uid IS NOT NULL
            AND COALESCE(b.is_synthetic, false) = false
            AND NOT EXISTS (
              SELECT 1 FROM ${s}.disbursements d
               WHERE d.booking_id = b.id AND d.worker_uid = b.worker_uid
            )
            AND NOT EXISTS (
              SELECT 1 FROM ${s}.finance_ledger_events e
               WHERE e.booking_id = b.id
                 AND e.event_type IN ('PROVIDER_EARNING_ACCRUED', 'PROVIDER_EARNING_WITHHELD')
            )`,
      );
      for (const row of r.rows) {
        await record({
          exceptionCode: spec.code,
          severity: spec.severity,
          bookingId: Number(row.id),
          amount: toCentavos(row.final_price),
          description:
            `Booking ${row.id} is paid and completed by ${row.worker_uid} but has no earning ` +
            'and no recorded reason for withholding one',
        });
      }
      return r.rows.length;
    },
  },
  {
    /**
     * A disbursement with no accrued earning behind it.
     *
     * Historical rows predate the event log, so this only looks at
     * disbursements created since the log existed — measured by whether ANY
     * event exists for that booking. Otherwise every payout ever made would be
     * flagged the day this shipped, which would bury the one real break in
     * thousands of false ones.
     */
    code: 'PAYOUT_WITHOUT_EARNING',
    run: async (record) => {
      const spec = specFor('PAYOUT_WITHOUT_EARNING');
      const r = await dbQuery.query(
        `SELECT d.id, d.booking_id, d.worker_uid, d.worker_share
           FROM ${s}.disbursements d
          WHERE d.status IN ('PENDING','PROCESSING','RELEASED')
            AND EXISTS (
              SELECT 1 FROM ${s}.finance_ledger_events e WHERE e.booking_id = d.booking_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM ${s}.finance_ledger_events e
               WHERE e.booking_id = d.booking_id
                 AND e.provider_uid = d.worker_uid
                 AND e.event_type = 'PROVIDER_EARNING_ACCRUED'
            )`,
      );
      for (const row of r.rows) {
        await record({
          exceptionCode: spec.code,
          severity: spec.severity,
          bookingId: Number(row.booking_id),
          disbursementId: Number(row.id),
          amount: toCentavos(row.worker_share),
          description:
            `Disbursement ${row.id} exists for booking ${row.booking_id} with no accrued ` +
            'earning event behind it',
        });
      }
      return r.rows.length;
    },
  },
  {
    /**
     * Refunds totalling more than was captured.
     *
     * Checked against BOTH the column and the event log: `refunded_amount` is
     * what the payment row claims, and the sum of `PAYMENT_REFUNDED` events is
     * what actually happened. Either exceeding the captured amount is a break,
     * and the two disagreeing is caught by the amount comparison below.
     */
    code: 'REFUND_EXCEEDS_CAPTURED_AMOUNT',
    run: async (record) => {
      const spec = specFor('REFUND_EXCEEDS_CAPTURED_AMOUNT');
      const r = await dbQuery.query(
        `SELECT p.id, p.booking_id, p.amount,
                COALESCE(p.refunded_amount, 0) AS refunded_amount,
                COALESCE((
                  SELECT SUM(e.amount) FROM ${s}.finance_ledger_events e
                   WHERE e.payment_id = p.id AND e.event_type = 'PAYMENT_REFUNDED'
                ), 0) AS refunded_events
           FROM ${s}.payments p
          WHERE COALESCE(p.refunded_amount, 0) > p.amount
             OR COALESCE((
                  SELECT SUM(e.amount) FROM ${s}.finance_ledger_events e
                   WHERE e.payment_id = p.id AND e.event_type = 'PAYMENT_REFUNDED'
                ), 0) > p.amount`,
      );
      for (const row of r.rows) {
        const captured = toCentavos(row.amount);
        const claimed = toCentavos(row.refunded_amount);
        const recorded = toCentavos(row.refunded_events);
        await record({
          exceptionCode: spec.code,
          severity: spec.severity,
          bookingId: row.booking_id == null ? null : Number(row.booking_id),
          paymentId: Number(row.id),
          amount: Math.max(claimed, recorded) - captured,
          description:
            `Payment ${row.id} captured ${captured} but shows ${claimed} refunded ` +
            `(${recorded} in ledger events)`,
        });
      }
      return r.rows.length;
    },
  },
  {
    /**
     * A recorded event that disagrees with what the calculator derives.
     *
     * The event log is immutable, so a disagreement is never resolved by editing
     * it — this check exists to find WHICH writer produced the disagreement. It
     * compares the accrued earning event against the disbursement row it names,
     * because those are the two independent records of the same number.
     */
    code: 'LEDGER_EVENT_AMOUNT_MISMATCH',
    run: async (record) => {
      const spec = specFor('LEDGER_EVENT_AMOUNT_MISMATCH');
      const r = await dbQuery.query(
        `SELECT e.id, e.booking_id, e.amount AS event_amount,
                d.id AS disbursement_id, d.worker_share
           FROM ${s}.finance_ledger_events e
           JOIN ${s}.disbursements d
             ON d.booking_id = e.booking_id AND d.worker_uid = e.provider_uid
          WHERE e.event_type = 'PROVIDER_EARNING_ACCRUED'
            AND ROUND(e.amount * 100) <> ROUND(d.worker_share * 100)`,
      );
      for (const row of r.rows) {
        await record({
          exceptionCode: spec.code,
          severity: spec.severity,
          bookingId: Number(row.booking_id),
          disbursementId: Number(row.disbursement_id),
          amount: toCentavos(Number(row.event_amount) - Number(row.worker_share)),
          description:
            `Earning event ${row.id} records ${toCentavos(row.event_amount)} but disbursement ` +
            `${row.disbursement_id} holds ${toCentavos(row.worker_share)}`,
        });
      }
      return r.rows.length;
    },
  },
]);

// ─── The read model ───────────────────────────────────────────────────────────

export interface ReconciliationBreak {
  id: number;
  code: string;
  severity: string;
  /** From the catalog, so the admin UI never hardcodes a description. */
  detects: string | null;
  remediation: string | null;
  bookingId: number | null;
  paymentId: number | null;
  disbursementId: number | null;
  amount: number | null;
  description: string;
  status: string;
  runDate: string | null;
  createdAt: string | null;
}

export interface ReconciliationReport {
  generatedAt: string;
  /** Every check the engine can run, whether or not it fired. */
  checks: ReadonlyArray<{
    code: string;
    severity: string;
    detects: string;
    remediation: string;
    requiredBySpec: boolean;
    openCount: number;
  }>;
  totals: {
    openBreaks: number;
    criticalBreaks: number;
    /** Captured, refunded, accrued, released — from the event log. */
    capturedAmount: number;
    refundedAmount: number;
    accruedProviderEarnings: number;
    releasedPayouts: number;
    internalFixerRevenue: number;
    /** Accrued minus released. What Servana still owes providers. */
    outstandingProviderLiability: number;
    /** Minor-unit twins of the six above. Centavos, integer. TAB 04. */
    capturedAmountMinor: number;
    refundedAmountMinor: number;
    accruedProviderEarningsMinor: number;
    releasedPayoutsMinor: number;
    internalFixerRevenueMinor: number;
    outstandingProviderLiabilityMinor: number;
  };
  breaks: ReconciliationBreak[];
  /** True when nothing is open. The gate §"zero unexplained breaks" reads this. */
  balanced: boolean;
}

const CATALOG_BY_CODE = new Map(RECONCILIATION_CHECKS.map((c) => [c.code, c]));

/**
 * The reconciliation view an admin reads.
 *
 * Read-only and computed on demand. It does not RUN the checks — running them
 * writes rows, and a GET that mutates is a GET somebody will eventually put
 * behind a dashboard refresh timer. `POST /admin/finance/reconciliation/run`
 * remains the way to produce a fresh set.
 */
export async function getReconciliationReport(
  filter: { status?: string; severity?: string; limit?: number } = {},
): Promise<ReconciliationReport> {
  const limit = Math.min(200, Math.max(1, Math.trunc(Number(filter.limit) || 100)));
  const status = filter.status ?? 'open';

  const conds: string[] = ['e.status = $1'];
  const params: unknown[] = [status];
  if (filter.severity) {
    params.push(filter.severity);
    conds.push(`e.severity = $${params.length}`);
  }

  const [breakRows, countRows, totalsRow] = await Promise.all([
    dbQuery.query(
      `SELECT e.id, e.exception_code, e.severity, e.booking_id, e.payment_id,
              e.disbursement_id, e.amount, e.description, e.status, e.run_date, e.created_at
         FROM ${s}.finance_reconciliation_exceptions e
        WHERE ${conds.join(' AND ')}
        ORDER BY CASE e.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
                 e.created_at DESC
        LIMIT ${limit}`,
      params,
    ),
    dbQuery.query(
      `SELECT exception_code, severity, COUNT(*) AS open_count
         FROM ${s}.finance_reconciliation_exceptions
        WHERE status = 'open'
        GROUP BY exception_code, severity`,
    ),
    dbQuery.query(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE event_type IN ('PAYMENT_CAPTURED','ADDITIONAL_WORK_CAPTURED')), 0) AS captured,
         COALESCE(SUM(amount) FILTER (WHERE event_type = 'PAYMENT_REFUNDED'), 0) AS refunded,
         COALESCE(SUM(amount) FILTER (WHERE event_type = 'PROVIDER_EARNING_ACCRUED'), 0) AS accrued,
         COALESCE(SUM(amount) FILTER (WHERE event_type = 'PROVIDER_PAYOUT_RELEASED'), 0) AS released,
         COALESCE(SUM(amount) FILTER (WHERE event_type = 'INTERNAL_FIXER_REVENUE_RETAINED'), 0) AS internal_fixer
       FROM ${s}.finance_ledger_events`,
    ),
  ]);

  const openByCode = new Map<string, number>();
  let openBreaks = 0;
  let criticalBreaks = 0;
  for (const row of countRows.rows) {
    const n = Number(row.open_count ?? 0);
    openByCode.set(String(row.exception_code), n);
    openBreaks += n;
    if (String(row.severity) === 'critical') criticalBreaks += n;
  }

  const t = totalsRow.rows[0] ?? {};
  const accrued = toCentavos(t.accrued);
  const released = toCentavos(t.released);

  return {
    generatedAt: new Date().toISOString(),
    checks: RECONCILIATION_CHECKS.map((c) => ({
      code: c.code,
      severity: c.severity,
      detects: c.detects,
      remediation: c.remediation,
      requiredBySpec: c.requiredBySpec,
      openCount: openByCode.get(c.code) ?? 0,
    })),
    totals: {
      openBreaks,
      criticalBreaks,
      capturedAmount: toCentavos(t.captured),
      refundedAmount: toCentavos(t.refunded),
      accruedProviderEarnings: accrued,
      releasedPayouts: released,
      internalFixerRevenue: toCentavos(t.internal_fixer),
      outstandingProviderLiability: toCentavos(accrued - released),

      /**
       * Minor-unit twins (TAB 04). Additive; the majors are unchanged.
       *
       * This is the screen the twins exist FOR. A reconciliation report is
       * where a float number of pesos surfaces its drift — small, real, and
       * extremely expensive to explain — and outstandingProviderLiability is a
       * subtraction of two floats, which is exactly the arithmetic that
       * accumulates it.
       */
      capturedAmountMinor: toMinorUnits(t.captured),
      refundedAmountMinor: toMinorUnits(t.refunded),
      accruedProviderEarningsMinor: toMinorUnits(accrued),
      releasedPayoutsMinor: toMinorUnits(released),
      internalFixerRevenueMinor: toMinorUnits(t.internal_fixer),
      outstandingProviderLiabilityMinor: toMinorUnits(accrued - released),
    },
    breaks: breakRows.rows.map((row: any) => {
      const spec = CATALOG_BY_CODE.get(String(row.exception_code));
      return {
        id: Number(row.id),
        code: String(row.exception_code),
        severity: String(row.severity),
        detects: spec?.detects ?? null,
        remediation: spec?.remediation ?? null,
        bookingId: row.booking_id == null ? null : Number(row.booking_id),
        paymentId: row.payment_id == null ? null : Number(row.payment_id),
        disbursementId: row.disbursement_id == null ? null : Number(row.disbursement_id),
        amount: row.amount == null ? null : toCentavos(row.amount),
        description: String(row.description),
        status: String(row.status),
        runDate: row.run_date ? String(row.run_date) : null,
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
      };
    }),
    balanced: openBreaks === 0,
  };
}

/**
 * The full financial picture of one booking, for an admin investigating a break.
 *
 * Returns the same `computeBookingFinance` projection the provider and customer
 * see, plus the raw event trail. That is the point of a single calculator: an
 * admin looking at a disputed number and the provider disputing it are reading
 * one computation.
 */
export async function getBookingReconciliation(bookingId: number) {
  const [rows, events] = await Promise.all([
    dbQuery.query(`${bookingFinanceSelect(s)} WHERE b.id = $1 LIMIT 1`, [bookingId]),
    dbQuery.query(
      `SELECT id, event_type, amount, counterparty, direction, provider_uid,
              payment_id, disbursement_id, reason_code, occurred_at
         FROM ${s}.finance_ledger_events
        WHERE booking_id = $1
        ORDER BY occurred_at ASC, id ASC`,
      [bookingId],
    ),
  ]);

  const row = rows.rows[0];
  if (!row) return null;

  return {
    finance: computeBookingFinance(toBookingFinanceRow(row)),
    events: events.rows.map((e: any) => ({
      id: Number(e.id),
      type: String(e.event_type),
      amount: toCentavos(e.amount),
      counterparty: String(e.counterparty),
      direction: String(e.direction),
      providerUid: e.provider_uid ?? null,
      paymentId: e.payment_id == null ? null : Number(e.payment_id),
      disbursementId: e.disbursement_id == null ? null : Number(e.disbursement_id),
      reasonCode: e.reason_code ?? null,
      occurredAt: e.occurred_at ? new Date(e.occurred_at).toISOString() : null,
    })),
  };
}
