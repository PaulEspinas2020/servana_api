import dbQuery from '../db/dbQuery';
import { db } from '../config';
import { providerShareOf, servanaShareOf, SERVANA_COMMISSION_RATE } from './revenueSplit';
import { auditFire } from './adminAuditService';
import { toCamel } from '../helpers/idGenerator';

// ── Constants ─────────────────────────────────────────────────────────────────

const s = db.schema;

// Rates live in revenueSplit.ts.
const GCASH_SLA_HOURS    = 48;
const CASH_SLA_HOURS     = 24;
const PAYMONGO_STALE_HOURS = 24;
const PAYOUT_MAX_RETRIES = 3;

// ── Schema bootstrap ──────────────────────────────────────────────────────────

export async function ensureFinanceSchema(): Promise<void> {

  // ── New columns on payments ────────────────────────────────────────────────
  const paymentCols = [
    `ALTER TABLE ${s}.payments ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ`,
    `ALTER TABLE ${s}.payments ADD COLUMN IF NOT EXISTS reviewed_by TEXT`,
    `ALTER TABLE ${s}.payments ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ`,
    `ALTER TABLE ${s}.payments ADD COLUMN IF NOT EXISTS rejection_reason TEXT`,
    `ALTER TABLE ${s}.payments ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ`,
    // Two live queries have always referenced payments.updated_at, and the
    // column never existed. scheduler.ts filters failed PayMongo payments on
    // it, so the retry job raised 42703 on every run and no failed payment has
    // ever been retried; the finance payments list selects it, so that query
    // failed too. Backfilled from created_at so existing rows get a sane value
    // rather than NULL, which would make every historical payment look eligible
    // for retry the moment the job starts working.
    `ALTER TABLE ${s}.payments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`,
    // Only columns confirmed to exist on payments — paid_at and the
    // submitted_at added two lines above. `created_at` is NOT referenced
    // anywhere else in this codebase, so naming it here would raise the very
    // 42703 this change exists to fix. Falling back to NOW() leaves a
    // backfilled row looking freshly touched, which is the safe direction: the
    // retry job waits 6 hours rather than treating every historical payment as
    // instantly eligible the moment it starts working.
    `UPDATE ${s}.payments SET updated_at = COALESCE(paid_at, submitted_at, NOW())
       WHERE updated_at IS NULL`,
    `ALTER TABLE ${s}.payments ALTER COLUMN updated_at SET DEFAULT NOW()`,
  ];
  for (const sql of paymentCols) await dbQuery.query(sql);

  // Keep updated_at honest without every writer having to remember it. A
  // trigger is the only way that holds — the column drives retry eligibility,
  // and a stale value silently means "retry this payment again".
  await dbQuery.query(`
    CREATE OR REPLACE FUNCTION ${s}.touch_payments_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await dbQuery.query(
    `DROP TRIGGER IF EXISTS trg_payments_updated_at ON ${s}.payments`,
  );
  await dbQuery.query(`
    CREATE TRIGGER trg_payments_updated_at
    BEFORE UPDATE ON ${s}.payments
    FOR EACH ROW EXECUTE FUNCTION ${s}.touch_payments_updated_at()
  `);

  // ── New column on user_credentials ────────────────────────────────────────
  await dbQuery.query(
    `ALTER TABLE ${s}.user_credentials ADD COLUMN IF NOT EXISTS is_internal_fixer BOOLEAN DEFAULT false`
  );

  // ── New columns on disbursements ──────────────────────────────────────────
  const disburse = [
    `ALTER TABLE ${s}.disbursements ADD COLUMN IF NOT EXISTS hold_reason TEXT`,
    `ALTER TABLE ${s}.disbursements ADD COLUMN IF NOT EXISTS hold_until TIMESTAMPTZ`,
    `ALTER TABLE ${s}.disbursements ADD COLUMN IF NOT EXISTS held_by TEXT`,
    `ALTER TABLE ${s}.disbursements ADD COLUMN IF NOT EXISTS retry_count INT DEFAULT 0`,
    `ALTER TABLE ${s}.disbursements ADD COLUMN IF NOT EXISTS last_retry_at TIMESTAMPTZ`,
  ];
  for (const sql of disburse) await dbQuery.query(sql);

  // ── finance_ledger_entries ─────────────────────────────────────────────────
  await dbQuery.query(`
    CREATE TABLE IF NOT EXISTS ${s}.finance_ledger_entries (
      id                  SERIAL PRIMARY KEY,
      booking_id          INT NOT NULL REFERENCES ${s}.bookings(id) ON DELETE CASCADE,
      payment_id          INT REFERENCES ${s}.payments(id) ON DELETE SET NULL,
      provider_uid        TEXT,
      is_internal_fixer   BOOLEAN NOT NULL DEFAULT false,
      gross_amount        NUMERIC(12,2) NOT NULL,
      servana_revenue     NUMERIC(12,2) NOT NULL DEFAULT 0,
      provider_payable    NUMERIC(12,2) NOT NULL DEFAULT 0,
      commission_rate     NUMERIC(5,4),
      recognition_status  TEXT NOT NULL DEFAULT 'recognized',
      source              TEXT NOT NULL,
      created_by          TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const ledgerIdxes: Array<[string, string]> = [
    ['fin_ledger_booking_idx', 'booking_id'],
    ['fin_ledger_payment_idx', 'payment_id'],
    ['fin_ledger_created_idx', 'created_at DESC'],
  ];
  for (const [n, c] of ledgerIdxes) {
    await dbQuery.query(`CREATE INDEX IF NOT EXISTS ${n} ON ${s}.finance_ledger_entries (${c})`);
  }

  // ── finance_refund_reviews ─────────────────────────────────────────────────
  await dbQuery.query(`
    CREATE TABLE IF NOT EXISTS ${s}.finance_refund_reviews (
      id                      SERIAL PRIMARY KEY,
      booking_id              INT NOT NULL REFERENCES ${s}.bookings(id) ON DELETE CASCADE,
      payment_id              INT REFERENCES ${s}.payments(id) ON DELETE SET NULL,
      disbursement_id         INT REFERENCES ${s}.disbursements(id) ON DELETE SET NULL,
      amount                  NUMERIC(12,2) NOT NULL,
      currency                TEXT NOT NULL DEFAULT 'PHP',
      status                  TEXT NOT NULL DEFAULT 'requested',
      reason                  TEXT,
      customer_uid            TEXT,
      customer_name           TEXT,
      requested_by            TEXT,
      reviewed_by             TEXT,
      reviewed_at             TIMESTAMPTZ,
      refund_method           TEXT,
      refund_reference        TEXT,
      processed_at            TIMESTAMPTZ,
      payout_reversal_needed  BOOLEAN NOT NULL DEFAULT false,
      rejection_reason        TEXT,
      notes                   TEXT,
      created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const refundIdxes: Array<[string, string]> = [
    ['fin_refund_booking_idx', 'booking_id'],
    ['fin_refund_status_idx',  'status'],
    ['fin_refund_created_idx', 'created_at DESC'],
  ];
  for (const [n, c] of refundIdxes) {
    await dbQuery.query(`CREATE INDEX IF NOT EXISTS ${n} ON ${s}.finance_refund_reviews (${c})`);
  }

  // ── finance_reconciliation_exceptions ─────────────────────────────────────
  await dbQuery.query(`
    CREATE TABLE IF NOT EXISTS ${s}.finance_reconciliation_exceptions (
      id               SERIAL PRIMARY KEY,
      run_date         DATE NOT NULL DEFAULT CURRENT_DATE,
      exception_code   TEXT NOT NULL,
      severity         TEXT NOT NULL DEFAULT 'warning',
      booking_id       INT REFERENCES ${s}.bookings(id) ON DELETE SET NULL,
      payment_id       INT REFERENCES ${s}.payments(id) ON DELETE SET NULL,
      disbursement_id  INT REFERENCES ${s}.disbursements(id) ON DELETE SET NULL,
      amount           NUMERIC(12,2),
      description      TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'open',
      resolved_by      TEXT,
      resolved_at      TIMESTAMPTZ,
      resolution_reason TEXT,
      ignored_by       TEXT,
      ignored_at       TIMESTAMPTZ,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const excIdxes: Array<[string, string]> = [
    ['fin_exc_code_idx',     'exception_code'],
    ['fin_exc_status_idx',   'status'],
    ['fin_exc_run_idx',      'run_date DESC'],
    ['fin_exc_booking_idx',  'booking_id'],
  ];
  for (const [n, c] of excIdxes) {
    await dbQuery.query(`CREATE INDEX IF NOT EXISTS ${n} ON ${s}.finance_reconciliation_exceptions (${c})`);
  }
}

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
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [pToday, rev, gcash, payouts, refunds, exceptions, totalPaid, released] =
    await Promise.all([
      dbQuery.query(
        `SELECT COALESCE(SUM(amount),0) AS v FROM ${s}.payments WHERE status='PAID' AND paid_at >= $1`,
        [todayStart]
      ),
      dbQuery.query(
        `SELECT COALESCE(SUM(servana_revenue),0) AS v FROM ${s}.finance_ledger_entries
         WHERE created_at >= date_trunc('month', NOW())`
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
        `SELECT COALESCE(SUM(amount),0) AS v FROM ${s}.payments WHERE status='PAID'`
      ),
      dbQuery.query(
        `SELECT COUNT(*) AS v FROM ${s}.disbursements WHERE status='RELEASED'`
      ),
    ]);

  return {
    paymentsToday:      toNum(pToday.rows[0]?.v),
    revenueMtd:         toNum(rev.rows[0]?.v),
    pendingGcashCount:  toNum(gcash.rows[0]?.v),
    pendingPayoutCount: toNum(payouts.rows[0]?.v),
    openRefundCount:    toNum(refunds.rows[0]?.v),
    openExceptionCount: toNum(exceptions.rows[0]?.v),
    totalPaidPayments:  toNum(totalPaid.rows[0]?.v),
    releasedPayoutsCount: toNum(released.rows[0]?.v),
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
  const page  = Math.max(1, filter.page ?? 1);
  const limit = Math.min(100, filter.limit ?? 30);
  const offset = (page - 1) * limit;
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
       p.proof_url, p.provider, p.provider_payment_id, p.checkout_url,
       p.paid_at, p.refunded_at, p.refund_reference, p.updated_at,
       p.reviewed_by, p.reviewed_at, p.rejection_reason, p.rejected_at, p.submitted_at,
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
       p.*, b.booking_reference, b.status AS booking_status,
       le.servana_revenue, le.provider_payable, le.is_internal_fixer
     FROM ${s}.payments p
     LEFT JOIN ${s}.bookings b ON b.id = p.booking_id
     LEFT JOIN finance_ledger_entries le ON le.payment_id = p.id
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
  const page  = Math.max(1, filter.page ?? 1);
  const limit = Math.min(100, filter.limit ?? 30);
  const offset = (page - 1) * limit;
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
  const page  = Math.max(1, filter.page ?? 1);
  const limit = Math.min(100, filter.limit ?? 30);
  const offset = (page - 1) * limit;
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
       d.worker_share, d.status, d.paymongo_payout_id, d.payout_error,
       d.released_at, d.created_at, d.updated_at,
       d.hold_reason, d.hold_until, d.held_by, d.retry_count, d.last_retry_at,
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
     LEFT JOIN ${s}.payments p ON p.booking_id = d.booking_id AND p.status = 'PAID'
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
  const page  = Math.max(1, filter.page ?? 1);
  const limit = Math.min(100, filter.limit ?? 30);
  const offset = (page - 1) * limit;
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
       SET refunded_at=NOW(), refund_reference=$2, updated_at=NOW()
       WHERE id=$1`,
      [rr.payment_id, refundReference]
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
  const page  = Math.max(1, filter.page ?? 1);
  const limit = Math.min(100, filter.limit ?? 30);
  const offset = (page - 1) * limit;
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
