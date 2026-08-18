import dbQuery from '../db/dbQuery';
import { db } from '../config';
import { providerShareOf, servanaShareOf, SERVANA_COMMISSION_RATE } from './revenueSplit';
import { auditFire } from './adminAuditService';
import { toCamel } from '../helpers/idGenerator';
import {
  ensureFinanceLedgerSchema,
  eventKeys,
  recordLedgerEventBestEffort,
} from './finance/financeLedger';
import { LEDGER_INTEGRITY_CHECKS } from './finance/financeReconciliationService';
import {
  processPendingDisbursements,
  type DuePayoutRunSummary,
} from './disbursement.service';

// ── Constants ─────────────────────────────────────────────────────────────────

const s = db.schema;

// Rates live in revenueSplit.ts.
const GCASH_SLA_HOURS    = 48;
const CASH_SLA_HOURS     = 24;
const PAYMONGO_STALE_HOURS = 24;
const PAYOUT_MAX_RETRIES = 3;

function normalizePagination(pageValue?: number, limitValue?: number): { page: number; limit: number; offset: number } {
  const rawPage = Number(pageValue);
  const rawLimit = Number(limitValue);
  const page = Number.isFinite(rawPage) ? Math.max(1, Math.trunc(rawPage)) : 1;
  const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, Math.trunc(rawLimit))) : 30;
  return { page, limit, offset: (page - 1) * limit };
}

// -- Schema (TAB 02) ----------------------------------------------------------
//
// `ensureFinanceSchema` was a REQUIRED startup dependency and the largest
// bootstrap in the repository. It created, at runtime:
//
//   8 columns on `payments`, 1 on `user_credentials` (is_internal_fixer)
//   `finance_ledger_entries`, `finance_refund_reviews`,
//   `finance_reconciliation_exceptions` + 8 indexes
//   the `touch_payments_updated_at()` FUNCTION and its
//   `trg_payments_updated_at` TRIGGER
//
// Every one of those is in `scripts/baseline/000-baseline.sql` — including the
// function and the trigger, which is the only trigger in the dump, and
// `payments.updated_at` with its `DEFAULT now()`. Verified individually before
// this was removed, because a trigger whose function is missing fails at the
// first UPDATE rather than at creation.
//
// Three of its index loops used an INTERPOLATED index name, so
// `ddl:inventory` could not see them at all — its regex identifies an index by
// its name. `npm run schema:authority` reports that blind spot now.
//
// -- Why payments.updated_at is worth remembering ----------------------------
//
// The column did not exist while two live queries referenced it.
// `scheduler.ts` filters failed PayMongo payments on it, so the retry job
// raised 42703 on EVERY run and no failed payment was ever retried; the finance
// payments list selected it and failed too.
//
// This bootstrap also carried a one-time DML backfill:
//
//   UPDATE payments SET updated_at = COALESCE(paid_at, submitted_at, NOW())
//     WHERE updated_at IS NULL
//
// The COALESCE ORDER was the point, not incidental: seeding from paid_at means
// the retry job waits its 6 hours from a real event, rather than treating every
// historical payment as instantly eligible the moment it starts working.
//
// That backfill is gone with the rest, and deliberately not re-homed into a
// migration: it is already applied in production (the baseline shows the column
// populated and defaulted), its predicate makes it a no-op there now, and a
// fresh database has no payment rows to backfill. If a NULL `updated_at` ever
// reappears, that is a writer inserting one explicitly — the column is nullable
// — and it should be fixed at that writer, not by a boot-time sweep over the
// payments table.

// ── Helpers ───────────────────────────────────────────────────────────────────

function toNum(v: unknown): number { return Number(v ?? 0); }
function toStr(v: unknown): string { return v != null ? String(v) : ''; }
function toNullStr(v: unknown): string | null { return v != null ? String(v) : null; }

/**
 * The ledger's view of a booking's revenue. Identical to the payout path's, by
 * construction — both go through splitRevenue.
 *
 * This used to take an `isInternalFixer` flag and return 100% Servana / 0%
 * provider for it. That was wrong in two separate ways. It contradicted the
 * platform rule, which is that ALL revenue splits 80/20 with no exceptions; and
 * it disagreed with the money that actually moved, because createDisbursement
 * has no internal-fixer branch and paid those providers the normal 80% while
 * this recorded them as owed nothing. One booking, two engines, two answers —
 * and the ledger was the one that was wrong.
 *
 * `is_internal_fixer` is still recorded on the ledger entry. It remains a
 * meaningful categorisation for reporting; it is simply not a pricing input.
 */
function computeRevenueSplit(
  grossAmount: number
): { servanaRevenue: number; providerPayable: number; commissionRate: number } {
  return {
    servanaRevenue:  servanaShareOf(grossAmount),
    providerPayable: providerShareOf(grossAmount),
    commissionRate:  SERVANA_COMMISSION_RATE,
  };
}

// ── Finance Summary ───────────────────────────────────────────────────────────

export async function getFinanceSummary(): Promise<{
  paymentsToday: number;
  revenueMtd: number;
  pendingGcashCount: number;
  pendingPayoutCount: number;
  openRefundCount: number;
  openExceptionCount: number;
  totalPaidPayments: number;
  releasedPayoutsCount: number;
}> {
  const [pToday, rev, gcash, payouts, refunds, exceptions, totalPaid, released] =
    await Promise.all([
      dbQuery.query(
        // Revenue: joined to bookings ONLY to exclude synthetic ones. A smoke
        // booking carrying a price would report as money never taken.
        `SELECT COALESCE(SUM(p.amount - COALESCE(p.refunded_amount,0)),0) AS v
         FROM ${s}.payments p
         LEFT JOIN ${s}.bookings b ON b.id = p.booking_id
         WHERE UPPER(p.status)='PAID'
           AND (p.paid_at AT TIME ZONE 'Asia/Manila') >= DATE_TRUNC('day', NOW() AT TIME ZONE 'Asia/Manila')
           AND COALESCE(b.is_synthetic, false) = false`
      ),
      dbQuery.query(
        `SELECT COALESCE(SUM(p.amount - COALESCE(p.refunded_amount,0)),0) AS v
         FROM ${s}.payments p
         LEFT JOIN ${s}.bookings b ON b.id = p.booking_id
         WHERE UPPER(p.status)='PAID'
           AND (p.paid_at AT TIME ZONE 'Asia/Manila') >= DATE_TRUNC('month', NOW() AT TIME ZONE 'Asia/Manila')
           AND COALESCE(b.is_synthetic, false) = false`
      ),
      dbQuery.query(
        `SELECT COUNT(*) AS v FROM ${s}.payments WHERE method='GCASH' AND status='PENDING'`
      ),
      dbQuery.query(
        `SELECT COUNT(*) AS v FROM ${s}.disbursements WHERE status='PENDING'`
      ),
      dbQuery.query(
        `SELECT COUNT(*) AS v FROM ${s}.finance_refund_reviews WHERE status IN ('requested','approved')`
      ),
      dbQuery.query(
        `SELECT COUNT(*) AS v FROM ${s}.finance_reconciliation_exceptions WHERE status='open'`
      ),
      dbQuery.query(
        `SELECT COALESCE(SUM(p.amount - COALESCE(p.refunded_amount,0)),0) AS v
         FROM ${s}.payments p
         LEFT JOIN ${s}.bookings b ON b.id = p.booking_id
         WHERE UPPER(p.status)='PAID'
           AND COALESCE(b.is_synthetic, false) = false`
      ),
      dbQuery.query(
        `SELECT COUNT(*) AS v FROM ${s}.disbursements WHERE status='RELEASED'`
      ),
    ]);

  return {
    paymentsToday:      toNum(pToday.rows[0]?.v),
    revenueMtd:         servanaShareOf(toNum(rev.rows[0]?.v)),
    pendingGcashCount:  toNum(gcash.rows[0]?.v),
    pendingPayoutCount: toNum(payouts.rows[0]?.v),
    openRefundCount:    toNum(refunds.rows[0]?.v),
    openExceptionCount: toNum(exceptions.rows[0]?.v),
    totalPaidPayments:  toNum(totalPaid.rows[0]?.v),
    releasedPayoutsCount: toNum(released.rows[0]?.v),
  };
}

export type FinanceSummary = Awaited<ReturnType<typeof getFinanceSummary>>;

export interface FinanceSummaryAccess {
  payments: boolean;
  gcashReview: boolean;
  payouts: boolean;
  refunds: boolean;
  reconciliation: boolean;
}

/** Remove submodule counts the current admin is not allowed to inspect. */
export function projectFinanceSummary(
  data: FinanceSummary,
  access: FinanceSummaryAccess,
): FinanceSummary {
  return {
    paymentsToday: access.payments ? data.paymentsToday : 0,
    revenueMtd: data.revenueMtd,
    pendingGcashCount: access.gcashReview ? data.pendingGcashCount : 0,
    pendingPayoutCount: access.payouts ? data.pendingPayoutCount : 0,
    openRefundCount: access.refunds ? data.openRefundCount : 0,
    openExceptionCount: access.reconciliation ? data.openExceptionCount : 0,
    totalPaidPayments: access.payments ? data.totalPaidPayments : 0,
    releasedPayoutsCount: access.payouts ? data.releasedPayoutsCount : 0,
  };
}

// ── Payments ──────────────────────────────────────────────────────────────────

export interface PaymentFilter {
  method?:   string;
  status?:   string;
  fromDate?: string;
  toDate?:   string;
  search?:   string;
  page?:     number;
  limit?:    number;
}

function buildPaymentWhere(f: PaymentFilter): { where: string; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];
  const push = (cond: string, v: unknown) => {
    params.push(v);
    conds.push(cond.replace('?', `$${params.length}`));
  };

  if (f.method)   push('p.method = ?', f.method);
  if (f.status)   push('p.status = ?', f.status);
  if (f.fromDate) push('p.updated_at >= ?', f.fromDate);
  if (f.toDate)   push("p.updated_at < ?::date + INTERVAL '1 day'", f.toDate);
  if (f.search) {
    params.push(`%${f.search}%`);
    const n = params.length;
    conds.push(`(p.reference_no ILIKE $${n} OR b.booking_reference ILIKE $${n})`);
  }

  return {
    where: conds.length ? `WHERE ${conds.join(' AND ')}` : '',
    params,
  };
}

export async function listPayments(filter: PaymentFilter = {}): Promise<{
  rows: unknown[];
  total: number;
  page: number;
  limit: number;
}> {
  const { page, limit, offset } = normalizePagination(filter.page, filter.limit);
  const { where, params } = buildPaymentWhere(filter);

  const countR = await dbQuery.query(
    `SELECT COUNT(*) AS v FROM ${s}.payments p LEFT JOIN ${s}.bookings b ON b.id = p.booking_id ${where}`,
    params
  );
  const total = toNum(countR.rows[0]?.v);

  const dParams = [...params, limit, offset];
  const dataR = await dbQuery.query(
    `SELECT
       p.id, p.booking_id, p.method, p.amount, p.status, p.reference_no,
       p.provider,
       p.paid_at, p.refunded_at, p.updated_at, p.submitted_at,
       b.booking_reference
     FROM ${s}.payments p
     LEFT JOIN ${s}.bookings b ON b.id = p.booking_id
     ${where}
     ORDER BY p.updated_at DESC
     LIMIT $${dParams.length - 1} OFFSET $${dParams.length}`,
    dParams
  );

  return { rows: dataR.rows.map(toCamel), total, page, limit };
}

export async function getPaymentDetail(paymentId: number): Promise<unknown> {
  const r = await dbQuery.query(
    `SELECT
       p.id, p.booking_id, p.additional_request_id, p.method, p.amount, p.status,
       p.reference_no, p.proof_url, p.provider,
       p.paid_at, p.refunded_at, p.refunded_amount, p.refund_reference,
       p.updated_at, p.submitted_at, p.reviewed_by, p.reviewed_at,
       p.rejection_reason, p.rejected_at,
       b.booking_reference, b.status AS booking_status,
       le.servana_revenue, le.provider_payable, le.is_internal_fixer
     FROM ${s}.payments p
     LEFT JOIN ${s}.bookings b ON b.id = p.booking_id
     LEFT JOIN ${s}.finance_ledger_entries le ON le.payment_id = p.id
     WHERE p.id = $1
     LIMIT 1`,
    [paymentId]
  );
  return r.rows[0] ? toCamel(r.rows[0]) : null;
}

export async function listGcashPendingQueue(): Promise<unknown[]> {
  const r = await dbQuery.query(
    `SELECT
       p.id, p.booking_id, p.amount, p.status, p.reference_no, p.proof_url,
       p.submitted_at, p.updated_at,
       b.booking_reference,
       EXTRACT(EPOCH FROM (NOW() - COALESCE(p.submitted_at, p.updated_at)))/3600 AS hours_pending
     FROM ${s}.payments p
     LEFT JOIN ${s}.bookings b ON b.id = p.booking_id
     WHERE p.method = 'GCASH' AND p.status = 'PENDING'
     ORDER BY p.updated_at ASC`
  );
  return r.rows.map(toCamel);
}

// ── GCash Approval / Rejection ────────────────────────────────────────────────

export async function approveGcashPayment(
  paymentId: number,
  adminUid: string,
  adminName: string | null,
  requestId: string | null,
  ipAddress: string | null
): Promise<{ bookingId: number; amount: number }> {
  const existing = await dbQuery.query(
    `SELECT id, booking_id, amount, status, method FROM ${s}.payments WHERE id = $1 LIMIT 1`,
    [paymentId]
  );
  const pay = existing.rows[0];
  if (!pay) throw Object.assign(new Error('Payment not found'), { code: 'NOT_FOUND' });
  if (pay.method !== 'GCASH')
    throw Object.assign(new Error('Payment is not a GCash payment'), { code: 'BUSINESS_RULE' });
  if (pay.status !== 'PENDING')
    throw Object.assign(
      new Error(`Cannot approve a payment in status: ${pay.status}`),
      { code: 'BUSINESS_RULE' }
    );

  const res = await dbQuery.query(
    `UPDATE ${s}.payments
     SET status='PAID', paid_at=NOW(), reviewed_by=$2, reviewed_at=NOW(), updated_at=NOW()
     WHERE id=$1 AND status='PENDING'
     RETURNING id, booking_id, amount`,
    [paymentId, adminUid]
  );
  if (!res.rows.length) {
    throw Object.assign(new Error('Payment was already actioned by another admin'), { code: 'CONFLICT' });
  }
  const updated = res.rows[0];

  await createLedgerEntry({
    bookingId: Number(updated.booking_id),
    paymentId,
    grossAmount: toNum(updated.amount),
    source: 'gcash_admin_approval',
    createdBy: adminUid,
  });

  // Also to the canonical event log. `finance_ledger_entries` remains the admin
  // portal's revenue-recognition view; `finance_ledger_events` is the one record
  // every surface reconciles against, and an admin approval must appear in it
  // beside the online captures rather than only in the admin's own table.
  await recordLedgerEventBestEffort({
    eventKey: eventKeys.paymentCaptured(paymentId),
    type: 'PAYMENT_CAPTURED',
    bookingId: Number(updated.booking_id),
    paymentId,
    amount: toNum(updated.amount),
    reasonCode: 'GCASH_ADMIN_APPROVAL',
    detail: { approvedBy: adminUid },
  });

  auditFire({
    action: 'finance_payment_gcash_approved',
    actionCategory: 'payment',
    outcome: 'success',
    actorUid: adminUid,
    actorDisplayName: adminName,
    entityType: 'payment',
    entityId: String(paymentId),
    entityDisplayName: `Booking #${updated.booking_id}`,
    after: { status: 'PAID', reviewedBy: adminUid },
    requestId,
    ipAddress,
    source: 'admin_portal',
    metadata: { bookingId: updated.booking_id, amount: updated.amount },
  });

  return { bookingId: Number(updated.booking_id), amount: toNum(updated.amount) };
}

export async function rejectGcashPayment(
  paymentId: number,
  rejectionReason: string,
  adminUid: string,
  adminName: string | null,
  requestId: string | null,
  ipAddress: string | null
): Promise<{ bookingId: number }> {
  const existing = await dbQuery.query(
    `SELECT id, booking_id, status, method FROM ${s}.payments WHERE id = $1 LIMIT 1`,
    [paymentId]
  );
  const pay = existing.rows[0];
  if (!pay) throw Object.assign(new Error('Payment not found'), { code: 'NOT_FOUND' });
  if (pay.method !== 'GCASH')
    throw Object.assign(new Error('Payment is not a GCash payment'), { code: 'BUSINESS_RULE' });
  if (pay.status !== 'PENDING')
    throw Object.assign(
      new Error(`Cannot reject a payment in status: ${pay.status}`),
      { code: 'BUSINESS_RULE' }
    );

  const res = await dbQuery.query(
    `UPDATE ${s}.payments
     SET status='REJECTED', rejected_at=NOW(), rejection_reason=$2,
         reviewed_by=$3, reviewed_at=NOW(), updated_at=NOW()
     WHERE id=$1 AND status='PENDING'
     RETURNING id, booking_id`,
    [paymentId, rejectionReason, adminUid]
  );
  if (!res.rows.length) {
    throw Object.assign(new Error('Payment was already actioned by another admin'), { code: 'CONFLICT' });
  }
  const updated = res.rows[0];

  auditFire({
    action: 'finance_payment_gcash_rejected',
    actionCategory: 'payment',
    outcome: 'success',
    actorUid: adminUid,
    actorDisplayName: adminName,
    entityType: 'payment',
    entityId: String(paymentId),
    after: { status: 'REJECTED', rejectionReason, reviewedBy: adminUid },
    reason: rejectionReason,
    requestId,
    ipAddress,
    source: 'admin_portal',
    metadata: { bookingId: updated.booking_id },
  });

  return { bookingId: Number(updated.booking_id) };
}

// ── Cash Payment Confirmation ─────────────────────────────────────────────────

export async function adminConfirmCash(
  paymentId: number,
  adminUid: string,
  adminName: string | null,
  requestId: string | null,
  ipAddress: string | null
): Promise<{ bookingId: number; amount: number }> {
  const existing = await dbQuery.query(
    `SELECT id, booking_id, amount, status, method FROM ${s}.payments WHERE id = $1 LIMIT 1`,
    [paymentId]
  );
  const pay = existing.rows[0];
  if (!pay) throw Object.assign(new Error('Payment not found'), { code: 'NOT_FOUND' });
  if (pay.method !== 'CASH')
    throw Object.assign(new Error('Payment is not a cash payment'), { code: 'BUSINESS_RULE' });
  if (pay.status === 'PAID')
    throw Object.assign(new Error('Cash payment already confirmed'), { code: 'BUSINESS_RULE' });

  const res = await dbQuery.query(
    `UPDATE ${s}.payments
     SET status='PAID', paid_at=NOW(), reviewed_by=$2, reviewed_at=NOW(), updated_at=NOW()
     WHERE id=$1 AND status != 'PAID'
     RETURNING id, booking_id, amount`,
    [paymentId, adminUid]
  );
  if (!res.rows.length) {
    throw Object.assign(new Error('Payment was already confirmed'), { code: 'CONFLICT' });
  }
  const updated = res.rows[0];

  await createLedgerEntry({
    bookingId: Number(updated.booking_id),
    paymentId,
    grossAmount: toNum(updated.amount),
    source: 'cash_admin_confirmation',
    createdBy: adminUid,
  });

  await recordLedgerEventBestEffort({
    eventKey: eventKeys.paymentCaptured(paymentId),
    type: 'PAYMENT_CAPTURED',
    bookingId: Number(updated.booking_id),
    paymentId,
    amount: toNum(updated.amount),
    reasonCode: 'CASH_ADMIN_CONFIRMATION',
    detail: { confirmedBy: adminUid },
  });

  auditFire({
    action: 'finance_payment_cash_confirmed',
    actionCategory: 'payment',
    outcome: 'success',
    actorUid: adminUid,
    actorDisplayName: adminName,
    entityType: 'payment',
    entityId: String(paymentId),
    entityDisplayName: `Booking #${updated.booking_id}`,
    after: { status: 'PAID', reviewedBy: adminUid },
    requestId,
    ipAddress,
    source: 'admin_portal',
    metadata: { bookingId: updated.booking_id, amount: updated.amount },
  });

  return { bookingId: Number(updated.booking_id), amount: toNum(updated.amount) };
}

// ── Revenue Ledger ────────────────────────────────────────────────────────────

interface LedgerEntryOpts {
  bookingId: number;
  paymentId?: number | null;
  grossAmount: number;
  source: string;
  createdBy?: string | null;
}

export async function createLedgerEntry(opts: LedgerEntryOpts): Promise<number> {
  // Look up provider uid + is_internal_fixer for this booking
  const bRes = await dbQuery.query(
    `SELECT b.worker_uid, COALESCE(uc.is_internal_fixer, false) AS is_internal_fixer
     FROM ${s}.bookings b
     LEFT JOIN ${s}.user_credentials uc ON uc.uid = b.worker_uid
     WHERE b.id = $1 LIMIT 1`,
    [opts.bookingId]
  );
  const bRow = bRes.rows[0];
  const providerUid    = toNullStr(bRow?.worker_uid);
  const isInternalFixer = bRow?.is_internal_fixer === true;

  // isInternalFixer is still written to the ledger row below — it is a
  // reporting attribute, not a pricing input.
  const { servanaRevenue, providerPayable, commissionRate } =
    computeRevenueSplit(opts.grossAmount);

  const ins = await dbQuery.query(
    `INSERT INTO ${s}.finance_ledger_entries
       (booking_id, payment_id, provider_uid, is_internal_fixer,
        gross_amount, servana_revenue, provider_payable, commission_rate,
        recognition_status, source, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'recognized',$9,$10)
     RETURNING id`,
    [
      opts.bookingId,
      opts.paymentId ?? null,
      providerUid,
      isInternalFixer,
      opts.grossAmount,
      servanaRevenue,
      providerPayable,
      commissionRate,
      opts.source,
      opts.createdBy ?? 'system',
    ]
  );
  return Number(ins.rows[0].id);
}

export async function listLedgerEntries(filter: {
  bookingId?: number;
  fromDate?: string;
  toDate?: string;
  page?: number;
  limit?: number;
} = {}): Promise<{ rows: unknown[]; total: number; page: number; limit: number }> {
  const { page, limit, offset } = normalizePagination(filter.page, filter.limit);
  const conds: string[] = [];
  const params: unknown[] = [];
  const push = (c: string, v: unknown) => { params.push(v); conds.push(c.replace('?', `$${params.length}`)); };

  if (filter.bookingId) push('booking_id = ?', filter.bookingId);
  if (filter.fromDate)  push('created_at >= ?', filter.fromDate);
  if (filter.toDate)    push("created_at < ?::date + INTERVAL '1 day'", filter.toDate);

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const countR = await dbQuery.query(`SELECT COUNT(*) AS v FROM ${s}.finance_ledger_entries ${where}`, params);
  const total  = toNum(countR.rows[0]?.v);

  const dp = [...params, limit, offset];
  const dataR = await dbQuery.query(
    `SELECT le.*, b.booking_reference
     FROM ${s}.finance_ledger_entries le
     LEFT JOIN ${s}.bookings b ON b.id = le.booking_id
     ${where}
     ORDER BY le.created_at DESC
     LIMIT $${dp.length - 1} OFFSET $${dp.length}`,
    dp
  );

  return { rows: dataR.rows.map(toCamel), total, page, limit };
}

export async function getBookingLedger(bookingId: number): Promise<unknown[]> {
  const r = await dbQuery.query(
    `SELECT le.*, p.method AS payment_method, p.status AS payment_status
     FROM ${s}.finance_ledger_entries le
     LEFT JOIN ${s}.payments p ON p.id = le.payment_id
     WHERE le.booking_id = $1
     ORDER BY le.created_at DESC`,
    [bookingId]
  );
  return r.rows.map(toCamel);
}

// ── Payouts / Disbursements ───────────────────────────────────────────────────

export interface PayoutFilter {
  status?:   string;
  fromDate?: string;
  toDate?:   string;
  workerUid?: string;
  page?:     number;
  limit?:    number;
}

export async function listPayouts(filter: PayoutFilter = {}): Promise<{
  rows: unknown[];
  total: number;
  page: number;
  limit: number;
}> {
  const { page, limit, offset } = normalizePagination(filter.page, filter.limit);
  const conds: string[] = [];
  const params: unknown[] = [];
  const push = (c: string, v: unknown) => { params.push(v); conds.push(c.replace('?', `$${params.length}`)); };

  if (filter.status)    push('d.status = ?', filter.status);
  if (filter.workerUid) push('d.worker_uid = ?', filter.workerUid);
  if (filter.fromDate)  push('d.created_at >= ?', filter.fromDate);
  if (filter.toDate)    push("d.created_at < ?::date + INTERVAL '1 day'", filter.toDate);

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const countR = await dbQuery.query(
    `SELECT COUNT(*) AS v FROM ${s}.disbursements d ${where}`, params
  );
  const total = toNum(countR.rows[0]?.v);

  const dp = [...params, limit, offset];
  const dataR = await dbQuery.query(
    `SELECT
       d.id, d.booking_id, d.worker_uid, d.total_amount, d.servana_share,
       d.worker_share, d.status, d.paymongo_payout_id,
       d.released_at, d.created_at, d.updated_at,
       d.hold_reason, d.hold_until, d.retry_count, d.last_retry_at,
       b.booking_reference,
       COALESCE(uc.is_internal_fixer, false) AS is_internal_fixer
     FROM ${s}.disbursements d
     LEFT JOIN ${s}.bookings b ON b.id = d.booking_id
     LEFT JOIN ${s}.user_credentials uc ON uc.uid = d.worker_uid
     ${where}
     ORDER BY d.created_at DESC
     LIMIT $${dp.length - 1} OFFSET $${dp.length}`,
    dp
  );

  return { rows: dataR.rows.map(toCamel), total, page, limit };
}

export async function getPayoutDetail(disbursementId: number): Promise<unknown> {
  const r = await dbQuery.query(
    `SELECT d.*, b.booking_reference, b.status AS booking_status,
            COALESCE(uc.is_internal_fixer, false) AS is_internal_fixer,
            p.status AS payment_status, p.amount AS payment_amount
     FROM ${s}.disbursements d
     LEFT JOIN ${s}.bookings b ON b.id = d.booking_id
     LEFT JOIN ${s}.user_credentials uc ON uc.uid = d.worker_uid
     LEFT JOIN LATERAL (
       SELECT status, amount
       FROM ${s}.payments
       WHERE booking_id = d.booking_id
         AND additional_request_id IS NULL
       ORDER BY id DESC LIMIT 1
     ) p ON true
     WHERE d.id = $1 LIMIT 1`,
    [disbursementId]
  );
  return r.rows[0] ? toCamel(r.rows[0]) : null;
}

export async function holdPayout(
  disbursementId: number,
  holdReason: string,
  holdUntil: string | null,
  adminUid: string,
  adminName: string | null,
  requestId: string | null
): Promise<void> {
  const res = await dbQuery.query(
    `UPDATE ${s}.disbursements
     SET hold_reason=$2, hold_until=$3, held_by=$4, updated_at=NOW()
     WHERE id=$1 AND status='PENDING'
     RETURNING id, booking_id`,
    [disbursementId, holdReason, holdUntil ?? null, adminUid]
  );
  if (!res.rows.length) {
    throw Object.assign(
      new Error('Disbursement not found or not in PENDING status'),
      { code: 'BUSINESS_RULE' }
    );
  }

  auditFire({
    action: 'finance_payout_held',
    actionCategory: 'payment',
    outcome: 'success',
    actorUid: adminUid,
    actorDisplayName: adminName,
    entityType: 'disbursement',
    entityId: String(disbursementId),
    reason: holdReason,
    requestId,
    source: 'admin_portal',
    metadata: { holdUntil, bookingId: res.rows[0].booking_id },
  });
}

export async function releasePayoutHold(
  disbursementId: number,
  adminUid: string,
  adminName: string | null,
  requestId: string | null
): Promise<void> {
  const res = await dbQuery.query(
    `UPDATE ${s}.disbursements
     SET hold_reason=NULL, hold_until=NULL, held_by=NULL, updated_at=NOW()
     WHERE id=$1 AND hold_reason IS NOT NULL
     RETURNING id, booking_id`,
    [disbursementId]
  );
  if (!res.rows.length) {
    throw Object.assign(new Error('Disbursement not found or has no active hold'), { code: 'BUSINESS_RULE' });
  }

  auditFire({
    action: 'finance_payout_hold_released',
    actionCategory: 'payment',
    outcome: 'success',
    actorUid: adminUid,
    actorDisplayName: adminName,
    entityType: 'disbursement',
    entityId: String(disbursementId),
    requestId,
    source: 'admin_portal',
    metadata: { bookingId: res.rows[0].booking_id },
  });
}

/**
 * The due-payout batch, run by an admin on demand — with a name and a record.
 *
 * ## Why this exists (TAB 01, F-01)
 *
 * `POST /api/admin/disbursements/trigger` called
 * `disbursementService.processPendingDisbursements()` behind
 * `verifyAuth + verifyRoles([1])` and nothing else. It releases every payout
 * that is due. No named permission was consulted and no audit record was
 * written, so the single most consequential money action on the platform was
 * also the only one that left nothing behind naming who did it.
 *
 * The sharpest part is that the control had already been designed. The
 * permission catalogue has carried
 *
 *   payouts.trigger_due_run — "Trigger Due Payout Run",
 *   action_type 'system', risk_level 'critical', is_dangerous: true
 *
 * since it was written. No route ever asked for it. Somebody identified this
 * capability as dangerous, named it, flagged it, and the route that performs it
 * never consulted the flag — which is why F-01 is a bypass rather than an
 * absence, and why the fix is to connect an existing control rather than to
 * invent one.
 *
 * ## Why it lives here and not in disbursement.service.ts
 *
 * `adminFinanceService` is the canonical ADMIN money surface: permissioned,
 * audited, and the one the portal calls. `disbursement.service` owns the
 * mechanics and is shared with the hourly cron, which has no admin actor to
 * name. Putting the audit here keeps one actor-bearing entry point without
 * making the scheduler pretend to be a person.
 */
export async function runDuePayoutBatch(
  adminUid: string,
  adminName: string | null,
  requestId: string | null
): Promise<DuePayoutRunSummary> {
  let summary: DuePayoutRunSummary;

  try {
    summary = await processPendingDisbursements();
  } catch (err) {
    /**
     * A failed run is audited too.
     *
     * An audit trail that records only the runs that worked answers "who moved
     * money" and cannot answer "who tried". For a batch that walks every due
     * payout, a half-completed run is exactly the event an investigation needs
     * to find, so the attempt is recorded before the error is re-raised.
     */
    auditFire({
      action: 'finance_payout_due_run_triggered',
      actionCategory: 'payment',
      outcome: 'failed',
      actorUid: adminUid,
      actorType: 'admin',
      actorDisplayName: adminName,
      entityType: 'disbursement',
      entityId: 'due-run',
      requestId,
      source: 'admin_portal',
      metadata: { error: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }

  auditFire({
    action: 'finance_payout_due_run_triggered',
    actionCategory: 'payment',
    outcome: 'success',
    actorUid: adminUid,
    actorType: 'admin',
    actorDisplayName: adminName,
    entityType: 'disbursement',
    entityId: 'due-run',
    requestId,
    source: 'admin_portal',
    metadata: {
      selected: summary.selected,
      attempted: summary.attempted,
      threw: summary.threw,
    },
  });

  return summary;
}

export async function retryPayout(
  disbursementId: number,
  adminUid: string,
  adminName: string | null,
  requestId: string | null
): Promise<void> {
  const cur = await dbQuery.query(
    `SELECT id, booking_id, status, retry_count, is_internal_fixer_job FROM ${s}.disbursements WHERE id=$1 LIMIT 1`,
    [disbursementId]
  );
  const d = cur.rows[0];
  if (!d) throw Object.assign(new Error('Disbursement not found'), { code: 'NOT_FOUND' });
  if (d.status !== 'FAILED') {
    throw Object.assign(new Error('Only FAILED disbursements can be retried'), { code: 'BUSINESS_RULE' });
  }
  if (toNum(d.retry_count) >= PAYOUT_MAX_RETRIES) {
    throw Object.assign(
      new Error(`Max retry limit (${PAYOUT_MAX_RETRIES}) reached`),
      { code: 'BUSINESS_RULE' }
    );
  }

  await dbQuery.query(
    `UPDATE ${s}.disbursements
     SET status='PENDING', payout_error=NULL,
         retry_count=COALESCE(retry_count,0)+1, last_retry_at=NOW(), updated_at=NOW()
     WHERE id=$1`,
    [disbursementId]
  );

  auditFire({
    action: 'finance_payout_retry_triggered',
    actionCategory: 'payment',
    outcome: 'success',
    actorUid: adminUid,
    actorDisplayName: adminName,
    entityType: 'disbursement',
    entityId: String(disbursementId),
    requestId,
    source: 'admin_portal',
    metadata: { bookingId: d.booking_id, previousRetryCount: d.retry_count },
  });
}

// ── Provider: Internal Fixer Flag ─────────────────────────────────────────────

export async function setInternalFixer(
  providerUid: string,
  isInternalFixer: boolean,
  adminUid: string,
  adminName: string | null,
  requestId: string | null
): Promise<void> {
  const res = await dbQuery.query(
    `UPDATE ${s}.user_credentials SET is_internal_fixer=$2 WHERE uid=$1 RETURNING uid`,
    [providerUid, isInternalFixer]
  );
  if (!res.rows.length) {
    throw Object.assign(new Error('Provider not found'), { code: 'NOT_FOUND' });
  }

  auditFire({
    action: 'finance_internal_fixer_tagged',
    actionCategory: 'payment',
    outcome: 'success',
    actorUid: adminUid,
    actorDisplayName: adminName,
    entityType: 'provider',
    entityId: providerUid,
    after: { isInternalFixer },
    requestId,
    source: 'admin_portal',
  });
}

// ── Refund Reviews ────────────────────────────────────────────────────────────

export interface OpenRefundBody {
  bookingId: number;
  paymentId?: number | null;
  amount: number;
  reason: string;
  customerUid?: string | null;
  customerName?: string | null;
  refundMethod?: string | null;
  notes?: string | null;
}

export async function openRefundReview(
  body: OpenRefundBody,
  adminUid: string,
  adminName: string | null,
  requestId: string | null
): Promise<number> {
  const payment = await dbQuery.query(
    `SELECT id, booking_id, amount, status, COALESCE(refunded_amount,0) AS refunded_amount
     FROM ${s}.payments
     WHERE id=$1 AND booking_id=$2
     LIMIT 1`,
    [body.paymentId, body.bookingId]
  );
  const pay = payment.rows[0];
  if (!body.paymentId || !pay) {
    throw Object.assign(new Error('A payment belonging to this booking is required'), { code: 'BUSINESS_RULE' });
  }
  if (String(pay.status).toUpperCase() !== 'PAID') {
    throw Object.assign(new Error('Only a paid payment can be refunded'), { code: 'BUSINESS_RULE' });
  }
  const remaining = toNum(pay.amount) - toNum(pay.refunded_amount);
  if (body.amount > remaining) {
    throw Object.assign(new Error('Refund amount exceeds the remaining paid amount'), { code: 'BUSINESS_RULE' });
  }

  // Check if there's an existing open refund for this booking
  const dup = await dbQuery.query(
    `SELECT id FROM ${s}.finance_refund_reviews WHERE booking_id=$1 AND status IN ('requested','approved') LIMIT 1`,
    [body.bookingId]
  );
  if (dup.rows.length) {
    throw Object.assign(
      new Error('An open refund review already exists for this booking'),
      { code: 'CONFLICT' }
    );
  }

  // Check if the paid payment has an associated disbursement that is RELEASED
  const disbRes = await dbQuery.query(
    `SELECT id FROM ${s}.disbursements WHERE booking_id=$1 AND status='RELEASED' LIMIT 1`,
    [body.bookingId]
  );
  const payoutReversalNeeded = disbRes.rows.length > 0;

  const ins = await dbQuery.query(
    `INSERT INTO ${s}.finance_refund_reviews
       (booking_id, payment_id, amount, reason, customer_uid, customer_name,
        requested_by, refund_method, payout_reversal_needed, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id`,
    [
      body.bookingId,
      body.paymentId ?? null,
      body.amount,
      body.reason,
      body.customerUid ?? null,
      body.customerName ?? null,
      adminUid,
      body.refundMethod ?? null,
      payoutReversalNeeded,
      body.notes ?? null,
    ]
  );
  const refundId = Number(ins.rows[0].id);

  auditFire({
    action: 'finance_refund_opened',
    actionCategory: 'payment',
    outcome: 'success',
    actorUid: adminUid,
    actorDisplayName: adminName,
    entityType: 'refund_review',
    entityId: String(refundId),
    requestId,
    source: 'admin_portal',
    metadata: { bookingId: body.bookingId, amount: body.amount, payoutReversalNeeded },
  });

  return refundId;
}

export async function listRefundReviews(filter: {
  status?: string;
  page?:   number;
  limit?:  number;
} = {}): Promise<{ rows: unknown[]; total: number; page: number; limit: number }> {
  const { page, limit, offset } = normalizePagination(filter.page, filter.limit);
  const conds: string[] = [];
  const params: unknown[] = [];

  if (filter.status) { params.push(filter.status); conds.push(`rr.status = $${params.length}`); }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const countR = await dbQuery.query(
    `SELECT COUNT(*) AS v FROM ${s}.finance_refund_reviews rr ${where}`, params
  );
  const total = toNum(countR.rows[0]?.v);

  const dp = [...params, limit, offset];
  const dataR = await dbQuery.query(
    `SELECT rr.*, b.booking_reference, p.method AS payment_method
     FROM ${s}.finance_refund_reviews rr
     LEFT JOIN ${s}.bookings b ON b.id = rr.booking_id
     LEFT JOIN ${s}.payments p ON p.id = rr.payment_id
     ${where}
     ORDER BY rr.created_at DESC
     LIMIT $${dp.length - 1} OFFSET $${dp.length}`,
    dp
  );

  return { rows: dataR.rows.map(toCamel), total, page, limit };
}

export async function getRefundReview(refundId: number): Promise<unknown> {
  const r = await dbQuery.query(
    `SELECT rr.*, b.booking_reference, b.status AS booking_status,
            p.method AS payment_method, p.amount AS payment_amount, p.status AS payment_status,
            d.status AS disbursement_status, d.paymongo_payout_id
     FROM ${s}.finance_refund_reviews rr
     LEFT JOIN ${s}.bookings b ON b.id = rr.booking_id
     LEFT JOIN ${s}.payments p ON p.id = rr.payment_id
     LEFT JOIN ${s}.disbursements d ON d.id = rr.disbursement_id
     WHERE rr.id = $1 LIMIT 1`,
    [refundId]
  );
  return r.rows[0] ? toCamel(r.rows[0]) : null;
}

export async function approveRefund(
  refundId: number,
  adminUid: string,
  adminName: string | null,
  requestId: string | null
): Promise<void> {
  const res = await dbQuery.query(
    `UPDATE ${s}.finance_refund_reviews
     SET status='approved', reviewed_by=$2, reviewed_at=NOW(), updated_at=NOW()
     WHERE id=$1 AND status='requested'
     RETURNING id, booking_id, amount, payout_reversal_needed`,
    [refundId, adminUid]
  );
  if (!res.rows.length) {
    throw Object.assign(new Error('Refund review not found or not in requested status'), { code: 'BUSINESS_RULE' });
  }
  const rr = res.rows[0];

  auditFire({
    action: 'finance_refund_approved',
    actionCategory: 'payment',
    outcome: 'success',
    actorUid: adminUid,
    actorDisplayName: adminName,
    entityType: 'refund_review',
    entityId: String(refundId),
    requestId,
    source: 'admin_portal',
    metadata: { bookingId: rr.booking_id, amount: rr.amount, payoutReversalNeeded: rr.payout_reversal_needed },
  });
}

export async function rejectRefund(
  refundId: number,
  rejectionReason: string,
  adminUid: string,
  adminName: string | null,
  requestId: string | null
): Promise<void> {
  const res = await dbQuery.query(
    `UPDATE ${s}.finance_refund_reviews
     SET status='rejected', reviewed_by=$2, reviewed_at=NOW(),
         rejection_reason=$3, updated_at=NOW()
     WHERE id=$1 AND status IN ('requested','approved')
     RETURNING id, booking_id`,
    [refundId, adminUid, rejectionReason]
  );
  if (!res.rows.length) {
    throw Object.assign(new Error('Refund review not found or already processed'), { code: 'BUSINESS_RULE' });
  }

  auditFire({
    action: 'finance_refund_rejected',
    actionCategory: 'payment',
    outcome: 'success',
    actorUid: adminUid,
    actorDisplayName: adminName,
    entityType: 'refund_review',
    entityId: String(refundId),
    reason: rejectionReason,
    requestId,
    source: 'admin_portal',
    metadata: { bookingId: res.rows[0].booking_id },
  });
}

export async function markRefundProcessed(
  refundId: number,
  refundReference: string,
  adminUid: string,
  adminName: string | null,
  requestId: string | null
): Promise<void> {
  const res = await dbQuery.query(
    `UPDATE ${s}.finance_refund_reviews
     SET status='processed', refund_reference=$2, processed_at=NOW(), updated_at=NOW()
     WHERE id=$1 AND status='approved'
     RETURNING id, booking_id, payment_id, amount`,
    [refundId, refundReference]
  );
  if (!res.rows.length) {
    throw Object.assign(
      new Error('Refund review not found or not in approved status'),
      { code: 'BUSINESS_RULE' }
    );
  }
  const rr = res.rows[0];

  // Update the payment record to reflect the refund
  if (rr.payment_id) {
    await dbQuery.query(
      `UPDATE ${s}.payments
       SET refunded_amount=COALESCE(refunded_amount,0)+$3,
           status=CASE WHEN COALESCE(refunded_amount,0)+$3 >= amount THEN 'REFUNDED' ELSE status END,
           refunded_at=NOW(), refund_reference=$2, updated_at=NOW()
       WHERE id=$1`,
      [rr.payment_id, refundReference, rr.amount]
    );
  }

  auditFire({
    action: 'finance_refund_processed',
    actionCategory: 'payment',
    outcome: 'success',
    actorUid: adminUid,
    actorDisplayName: adminName,
    entityType: 'refund_review',
    entityId: String(refundId),
    requestId,
    source: 'admin_portal',
    metadata: { bookingId: rr.booking_id, amount: rr.amount, refundReference },
  });
}

// ── Reconciliation Engine ─────────────────────────────────────────────────────

interface ExceptionInput {
  exceptionCode: string;
  severity: 'warning' | 'critical' | 'info';
  bookingId?: number | null;
  paymentId?: number | null;
  disbursementId?: number | null;
  amount?: number | null;
  description: string;
}

async function insertException(exc: ExceptionInput): Promise<void> {
  await dbQuery.query(
    `INSERT INTO ${s}.finance_reconciliation_exceptions
       (exception_code, severity, booking_id, payment_id, disbursement_id, amount, description)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      exc.exceptionCode,
      exc.severity,
      exc.bookingId ?? null,
      exc.paymentId ?? null,
      exc.disbursementId ?? null,
      exc.amount ?? null,
      exc.description,
    ]
  );
}

export async function runReconciliation(
  adminUid: string,
  adminName: string | null,
  requestId: string | null
): Promise<{ inserted: number; runDate: string }> {
  const runDate = new Date().toISOString().slice(0, 10);
  let inserted = 0;

  // Close open exceptions from previous run if same date (idempotent re-run)
  await dbQuery.query(
    `DELETE FROM ${s}.finance_reconciliation_exceptions WHERE run_date = $1 AND status = 'open'`,
    [runDate]
  );

  const checks: Array<() => Promise<void>> = [
    // 1. GCASH pending over SLA
    async () => {
      const r = await dbQuery.query(
        `SELECT p.id, p.booking_id, p.amount,
                EXTRACT(EPOCH FROM (NOW() - COALESCE(p.submitted_at, p.updated_at)))/3600 AS hrs
         FROM ${s}.payments p
         WHERE p.method='GCASH' AND p.status='PENDING'
           AND COALESCE(p.submitted_at, p.updated_at) < NOW() - INTERVAL '${GCASH_SLA_HOURS} hours'`
      );
      for (const row of r.rows) {
        await insertException({
          exceptionCode: 'GCASH_PENDING_REVIEW_OVER_SLA',
          severity: 'warning',
          bookingId: Number(row.booking_id),
          paymentId: Number(row.id),
          amount: toNum(row.amount),
          description: `GCash payment pending review for ${Math.round(toNum(row.hrs))}h (SLA: ${GCASH_SLA_HOURS}h)`,
        });
        inserted++;
      }
    },

    // 2. CASH payment unconfirmed over SLA
    async () => {
      const r = await dbQuery.query(
        `SELECT p.id, p.booking_id, p.amount
         FROM ${s}.payments p
         WHERE p.method='CASH' AND p.status != 'PAID'
           AND p.updated_at < NOW() - INTERVAL '${CASH_SLA_HOURS} hours'`
      );
      for (const row of r.rows) {
        await insertException({
          exceptionCode: 'CASH_PAYMENT_UNCONFIRMED_OVER_SLA',
          severity: 'warning',
          bookingId: Number(row.booking_id),
          paymentId: Number(row.id),
          amount: toNum(row.amount),
          description: `Cash payment unconfirmed beyond ${CASH_SLA_HOURS}h SLA`,
        });
        inserted++;
      }
    },

    // 3. PayMongo FAILED payments
    async () => {
      const r = await dbQuery.query(
        `SELECT p.id, p.booking_id, p.amount FROM ${s}.payments p
         WHERE p.provider='PAYMONGO' AND p.status='FAILED'
           AND NOT EXISTS (
             SELECT 1 FROM ${s}.finance_reconciliation_exceptions e
             WHERE e.payment_id = p.id AND e.exception_code='PAYMONGO_FAILED_PAYMENT'
               AND e.status NOT IN ('open')
           )`
      );
      for (const row of r.rows) {
        await insertException({
          exceptionCode: 'PAYMONGO_FAILED_PAYMENT',
          severity: 'critical',
          bookingId: Number(row.booking_id),
          paymentId: Number(row.id),
          amount: toNum(row.amount),
          description: 'PayMongo payment failed and requires admin review',
        });
        inserted++;
      }
    },

    // 4. PayMongo checkout without final status (stale)
    async () => {
      const r = await dbQuery.query(
        `SELECT p.id, p.booking_id, p.amount FROM ${s}.payments p
         WHERE p.provider='PAYMONGO' AND p.checkout_url IS NOT NULL
           AND p.status NOT IN ('PAID','FAILED','CANCELLED','REJECTED')
           AND p.updated_at < NOW() - INTERVAL '${PAYMONGO_STALE_HOURS} hours'`
      );
      for (const row of r.rows) {
        await insertException({
          exceptionCode: 'PAYMONGO_CHECKOUT_WITHOUT_FINAL_STATUS',
          severity: 'warning',
          bookingId: Number(row.booking_id),
          paymentId: Number(row.id),
          amount: toNum(row.amount),
          description: `PayMongo checkout has no final status after ${PAYMONGO_STALE_HOURS}h`,
        });
        inserted++;
      }
    },

    // 5. Released payout without a PAID payment
    async () => {
      const r = await dbQuery.query(
        `SELECT d.id, d.booking_id, d.worker_share FROM ${s}.disbursements d
         WHERE d.status='RELEASED'
           AND NOT EXISTS (
             SELECT 1 FROM ${s}.payments p WHERE p.booking_id=d.booking_id AND p.status='PAID'
           )`
      );
      for (const row of r.rows) {
        await insertException({
          exceptionCode: 'RELEASED_PAYOUT_WITHOUT_PAID_PAYMENT',
          severity: 'critical',
          bookingId: Number(row.booking_id),
          disbursementId: Number(row.id),
          amount: toNum(row.worker_share),
          description: 'Payout released but no PAID payment found for this booking',
        });
        inserted++;
      }
    },

    // 6. Duplicate payouts per booking
    async () => {
      const r = await dbQuery.query(
        `SELECT booking_id, COUNT(*) AS cnt, SUM(worker_share) AS total
         FROM ${s}.disbursements
         WHERE status IN ('PENDING','RELEASED')
         GROUP BY booking_id
         HAVING COUNT(*) > 1`
      );
      for (const row of r.rows) {
        await insertException({
          exceptionCode: 'DUPLICATE_PAYOUT_FOR_BOOKING',
          severity: 'critical',
          bookingId: Number(row.booking_id),
          amount: toNum(row.total),
          description: `${row.cnt} disbursements found for same booking`,
        });
        inserted++;
      }
    },

    // 7. Internal fixer with provider payout
    async () => {
      const r = await dbQuery.query(
        `SELECT d.id, d.booking_id, d.worker_uid, d.worker_share
         FROM ${s}.disbursements d
         JOIN ${s}.user_credentials uc ON uc.uid = d.worker_uid
         WHERE uc.is_internal_fixer = true
           AND d.status IN ('PENDING','RELEASED')`
      );
      for (const row of r.rows) {
        await insertException({
          exceptionCode: 'INTERNAL_FIXER_JOB_WITH_PROVIDER_PAYOUT',
          severity: 'critical',
          bookingId: Number(row.booking_id),
          disbursementId: Number(row.id),
          amount: toNum(row.worker_share),
          description: `Internal fixer ${row.worker_uid} has a provider payout — should be NOT_APPLICABLE`,
        });
        inserted++;
      }
    },

    // 8. Failed payout with max retries exceeded
    async () => {
      const r = await dbQuery.query(
        `SELECT id, booking_id, worker_share, payout_error
         FROM ${s}.disbursements
         WHERE status='FAILED' AND COALESCE(retry_count,0) >= $1`,
        [PAYOUT_MAX_RETRIES]
      );
      for (const row of r.rows) {
        await insertException({
          exceptionCode: 'PAYOUT_FAILED_PROVIDER_ERROR',
          severity: 'critical',
          bookingId: Number(row.booking_id),
          disbursementId: Number(row.id),
          amount: toNum(row.worker_share),
          description: `Payout failed after ${PAYOUT_MAX_RETRIES} retries. Error: ${toStr(row.payout_error).slice(0, 120)}`,
        });
        inserted++;
      }
    },

    // 9. Refund approved with already-released payout
    async () => {
      const r = await dbQuery.query(
        `SELECT rr.id, rr.booking_id, rr.amount
         FROM ${s}.finance_refund_reviews rr
         JOIN ${s}.disbursements d ON d.booking_id = rr.booking_id
         WHERE rr.status = 'approved' AND d.status = 'RELEASED'`
      );
      for (const row of r.rows) {
        await insertException({
          exceptionCode: 'REFUND_APPROVED_WITH_RELEASED_PAYOUT',
          severity: 'critical',
          bookingId: Number(row.booking_id),
          amount: toNum(row.amount),
          description: 'Refund approved but provider payout was already released — manual reversal needed',
        });
        inserted++;
      }
    },
    // 10-14. The ledger-integrity checks §78 requires.
    //
    // Appended to THIS engine rather than run by a second job: two reconciliation
    // runs writing into one exceptions table with different run-date semantics is
    // itself a reconciliation problem. They are declared in
    // `finance/financeReconciliationService` beside the catalog they belong to.
    ...LEDGER_INTEGRITY_CHECKS.map((check) => async () => {
      inserted += await check.run(insertException);
    }),
  ];

  for (const check of checks) {
    try { await check(); } catch (e) { console.error('[reconciliation-check]', e); }
  }

  auditFire({
    action: 'finance_reconciliation_run',
    actionCategory: 'payment',
    outcome: 'success',
    actorUid: adminUid,
    actorDisplayName: adminName,
    entityType: 'reconciliation_exception',
    entityId: runDate,
    requestId,
    source: 'admin_portal',
    metadata: { runDate, exceptionsInserted: inserted },
  });

  return { inserted, runDate };
}

export async function listExceptions(filter: {
  status?: string;
  exceptionCode?: string;
  severity?: string;
  fromDate?: string;
  toDate?: string;
  page?:   number;
  limit?:  number;
} = {}): Promise<{ rows: unknown[]; total: number; page: number; limit: number }> {
  const { page, limit, offset } = normalizePagination(filter.page, filter.limit);
  const conds: string[] = [];
  const params: unknown[] = [];
  const push = (c: string, v: unknown) => { params.push(v); conds.push(c.replace('?', `$${params.length}`)); };

  if (filter.status)        push('e.status = ?', filter.status);
  if (filter.exceptionCode) push('e.exception_code = ?', filter.exceptionCode);
  if (filter.severity)      push('e.severity = ?', filter.severity);
  if (filter.fromDate)      push('e.run_date >= ?::date', filter.fromDate);
  if (filter.toDate)        push('e.run_date <= ?::date', filter.toDate);

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const countR = await dbQuery.query(
    `SELECT COUNT(*) AS v FROM ${s}.finance_reconciliation_exceptions e ${where}`, params
  );
  const total = toNum(countR.rows[0]?.v);

  const dp = [...params, limit, offset];
  const dataR = await dbQuery.query(
    `SELECT e.*, b.booking_reference
     FROM ${s}.finance_reconciliation_exceptions e
     LEFT JOIN ${s}.bookings b ON b.id = e.booking_id
     ${where}
     ORDER BY e.severity DESC, e.created_at DESC
     LIMIT $${dp.length - 1} OFFSET $${dp.length}`,
    dp
  );

  return { rows: dataR.rows.map(toCamel), total, page, limit };
}

export async function resolveException(
  exceptionId: number,
  resolutionReason: string,
  adminUid: string,
  adminName: string | null,
  requestId: string | null
): Promise<void> {
  const res = await dbQuery.query(
    `UPDATE ${s}.finance_reconciliation_exceptions
     SET status='resolved', resolved_by=$2, resolved_at=NOW(),
         resolution_reason=$3, updated_at=NOW()
     WHERE id=$1 AND status IN ('open','acknowledged')
     RETURNING id`,
    [exceptionId, adminUid, resolutionReason]
  );
  if (!res.rows.length) {
    throw Object.assign(new Error('Exception not found or already closed'), { code: 'BUSINESS_RULE' });
  }

  auditFire({
    action: 'finance_exception_resolved',
    actionCategory: 'payment',
    outcome: 'success',
    actorUid: adminUid,
    actorDisplayName: adminName,
    entityType: 'reconciliation_exception',
    entityId: String(exceptionId),
    reason: resolutionReason,
    requestId,
    source: 'admin_portal',
  });
}

export async function ignoreException(
  exceptionId: number,
  reason: string,
  adminUid: string,
  adminName: string | null,
  requestId: string | null
): Promise<void> {
  const res = await dbQuery.query(
    `UPDATE ${s}.finance_reconciliation_exceptions
     SET status='ignored', ignored_by=$2, ignored_at=NOW(),
         resolution_reason=$3, updated_at=NOW()
     WHERE id=$1 AND status IN ('open','acknowledged')
     RETURNING id`,
    [exceptionId, adminUid, reason]
  );
  if (!res.rows.length) {
    throw Object.assign(new Error('Exception not found or already closed'), { code: 'BUSINESS_RULE' });
  }

  auditFire({
    action: 'finance_exception_ignored',
    actionCategory: 'payment',
    outcome: 'success',
    actorUid: adminUid,
    actorDisplayName: adminName,
    entityType: 'reconciliation_exception',
    entityId: String(exceptionId),
    reason,
    requestId,
    source: 'admin_portal',
  });
}
