import { Request, Response } from 'express';
import {
  adminServerError,
  adminNotFound,
  adminBadRequest,
  adminConflict,
  adminValidationError,
} from '../helpers/adminError';
import * as svc from '../services/adminFinanceService';
import { hasPermission, isSuperAdmin } from '../services/adminPermissionService';

// ── Helpers ───────────────────────────────────────────────────────────────────

function actorFrom(req: Request): { uid: string; name: string | null } {
  const user = (req as any).user;
  return {
    uid:  user?.uid ?? 'unknown',
    name: user?.name ?? user?.email ?? null,
  };
}

function rid(req: Request): string | null {
  return (req as any).id ?? req.headers['x-request-id'] as string ?? null;
}

function ip(req: Request): string | null {
  const forwarded = req.headers['x-forwarded-for'];
  const fwdStr = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return fwdStr?.split(',')[0]?.trim() ?? req.socket?.remoteAddress ?? null;
}

function isPositiveId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function handleSvcError(res: Response, err: unknown): Response {
  const e = err as any;
  if (e?.code === 'NOT_FOUND')      return adminNotFound(res, e.message);
  if (e?.code === 'CONFLICT')       return adminConflict(res, e.message);
  if (e?.code === 'BUSINESS_RULE')  return adminBadRequest(res, e.message);
  return adminServerError(res, err);
}

// ── Finance Summary ───────────────────────────────────────────────────────────

export async function getFinanceSummary(req: Request, res: Response): Promise<void> {
  try {
    const data = await svc.getFinanceSummary();
    const uid = (req as any).user?.uid ?? '';
    const superAdmin = await isSuperAdmin(uid);
    const can = async (key: string) => superAdmin || await hasPermission(uid, key);
    const projected = svc.projectFinanceSummary(data, {
      payments: await can('payments.view'),
      gcashReview: await can('payments.gcash_review.view'),
      payouts: await can('payouts.view'),
      refunds: await can('payments.view'),
      reconciliation: await can('reconciliation.view'),
    });
    res.json({ status: 'success', data: projected });
  } catch (err) {
    handleSvcError(res, err);
  }
}

// ── Payments ──────────────────────────────────────────────────────────────────

export async function listPayments(req: Request, res: Response): Promise<void> {
  try {
    const { method, status, fromDate, toDate, search, page, limit } = req.query as Record<string, string>;
    const data = await svc.listPayments({
      method, status, fromDate, toDate, search,
      page:  page  ? Number(page)  : undefined,
      limit: limit ? Number(limit) : undefined,
    });
    res.json({ status: 'success', data });
  } catch (err) {
    handleSvcError(res, err);
  }
}

export async function getPaymentDetail(req: Request, res: Response): Promise<void> {
  try {
    const paymentId = Number(req.params.paymentId);
    if (!isPositiveId(paymentId)) { adminBadRequest(res, 'Invalid payment ID'); return; }
    const data = await svc.getPaymentDetail(paymentId);
    if (!data) { adminNotFound(res, 'Payment'); return; }
    res.json({ status: 'success', data });
  } catch (err) {
    handleSvcError(res, err);
  }
}

export async function listGcashPendingQueue(req: Request, res: Response): Promise<void> {
  try {
    const data = await svc.listGcashPendingQueue();
    res.json({ status: 'success', data });
  } catch (err) {
    handleSvcError(res, err);
  }
}

export async function approveGcashPayment(req: Request, res: Response): Promise<void> {
  try {
    const paymentId = Number(req.params.paymentId);
    if (!isPositiveId(paymentId)) { adminBadRequest(res, 'Invalid payment ID'); return; }
    const { uid, name } = actorFrom(req);
    const data = await svc.approveGcashPayment(paymentId, uid, name, rid(req), ip(req));
    res.json({ status: 'success', data });
  } catch (err) {
    handleSvcError(res, err);
  }
}

export async function rejectGcashPayment(req: Request, res: Response): Promise<void> {
  try {
    const paymentId = Number(req.params.paymentId);
    if (!isPositiveId(paymentId)) { adminBadRequest(res, 'Invalid payment ID'); return; }
    const { rejectionReason } = req.body;
    if (!rejectionReason?.trim()) {
      adminValidationError(res, 'rejectionReason is required');
      return;
    }
    const { uid, name } = actorFrom(req);
    const data = await svc.rejectGcashPayment(paymentId, rejectionReason.trim(), uid, name, rid(req), ip(req));
    res.json({ status: 'success', data });
  } catch (err) {
    handleSvcError(res, err);
  }
}

export async function adminConfirmCash(req: Request, res: Response): Promise<void> {
  try {
    const paymentId = Number(req.params.paymentId);
    if (!isPositiveId(paymentId)) { adminBadRequest(res, 'Invalid payment ID'); return; }
    const { uid, name } = actorFrom(req);
    const data = await svc.adminConfirmCash(paymentId, uid, name, rid(req), ip(req));
    res.json({ status: 'success', data });
  } catch (err) {
    handleSvcError(res, err);
  }
}

// ── Ledger ────────────────────────────────────────────────────────────────────

export async function listLedgerEntries(req: Request, res: Response): Promise<void> {
  try {
    const { bookingId, fromDate, toDate, page, limit } = req.query as Record<string, string>;
    const data = await svc.listLedgerEntries({
      bookingId: bookingId ? Number(bookingId) : undefined,
      fromDate, toDate,
      page:  page  ? Number(page)  : undefined,
      limit: limit ? Number(limit) : undefined,
    });
    res.json({ status: 'success', data });
  } catch (err) {
    handleSvcError(res, err);
  }
}

export async function getBookingLedger(req: Request, res: Response): Promise<void> {
  try {
    const bookingId = Number(req.params.bookingId);
    if (!isPositiveId(bookingId)) { adminBadRequest(res, 'Invalid booking ID'); return; }
    const data = await svc.getBookingLedger(bookingId);
    res.json({ status: 'success', data });
  } catch (err) {
    handleSvcError(res, err);
  }
}

// ── Payouts ───────────────────────────────────────────────────────────────────

export async function listPayouts(req: Request, res: Response): Promise<void> {
  try {
    const { status, fromDate, toDate, workerUid, page, limit } = req.query as Record<string, string>;
    const data = await svc.listPayouts({
      status, fromDate, toDate, workerUid,
      page:  page  ? Number(page)  : undefined,
      limit: limit ? Number(limit) : undefined,
    });
    res.json({ status: 'success', data });
  } catch (err) {
    handleSvcError(res, err);
  }
}

export async function getPayoutDetail(req: Request, res: Response): Promise<void> {
  try {
    const disbursementId = Number(req.params.disbursementId);
    if (!isPositiveId(disbursementId)) { adminBadRequest(res, 'Invalid disbursement ID'); return; }
    const data = await svc.getPayoutDetail(disbursementId);
    if (!data) { adminNotFound(res, 'Disbursement'); return; }
    res.json({ status: 'success', data });
  } catch (err) {
    handleSvcError(res, err);
  }
}

export async function holdPayout(req: Request, res: Response): Promise<void> {
  try {
    const disbursementId = Number(req.params.disbursementId);
    if (!isPositiveId(disbursementId)) { adminBadRequest(res, 'Invalid disbursement ID'); return; }
    const { holdReason, holdUntil } = req.body;
    if (!holdReason?.trim()) { adminValidationError(res, 'holdReason is required'); return; }
    const { uid, name } = actorFrom(req);
    await svc.holdPayout(disbursementId, holdReason.trim(), holdUntil ?? null, uid, name, rid(req));
    res.json({ status: 'success', data: { disbursementId } });
  } catch (err) {
    handleSvcError(res, err);
  }
}

export async function releasePayoutHold(req: Request, res: Response): Promise<void> {
  try {
    const disbursementId = Number(req.params.disbursementId);
    if (!isPositiveId(disbursementId)) { adminBadRequest(res, 'Invalid disbursement ID'); return; }
    const { uid, name } = actorFrom(req);
    await svc.releasePayoutHold(disbursementId, uid, name, rid(req));
    res.json({ status: 'success', data: { disbursementId } });
  } catch (err) {
    handleSvcError(res, err);
  }
}

export async function retryPayout(req: Request, res: Response): Promise<void> {
  try {
    const disbursementId = Number(req.params.disbursementId);
    if (!isPositiveId(disbursementId)) { adminBadRequest(res, 'Invalid disbursement ID'); return; }
    const { uid, name } = actorFrom(req);
    await svc.retryPayout(disbursementId, uid, name, rid(req));
    res.json({ status: 'success', data: { disbursementId, message: 'Payout queued for retry' } });
  } catch (err) {
    handleSvcError(res, err);
  }
}

// ── Provider Internal Fixer ───────────────────────────────────────────────────

export async function setInternalFixer(req: Request, res: Response): Promise<void> {
  try {
    const providerUid = String(req.params['uid'] ?? '');
    if (!providerUid) { adminBadRequest(res, 'Invalid provider UID'); return; }
    const { isInternalFixer } = req.body;
    if (typeof isInternalFixer !== 'boolean') {
      adminValidationError(res, 'isInternalFixer (boolean) is required');
      return;
    }
    const { uid, name } = actorFrom(req);
    await svc.setInternalFixer(providerUid, isInternalFixer, uid, name, rid(req));
    res.json({ status: 'success', data: { providerUid, isInternalFixer } });
  } catch (err) {
    handleSvcError(res, err);
  }
}

// ── Refund Reviews ────────────────────────────────────────────────────────────

export async function listRefundReviews(req: Request, res: Response): Promise<void> {
  try {
    const { status, page, limit } = req.query as Record<string, string>;
    const data = await svc.listRefundReviews({
      status,
      page:  page  ? Number(page)  : undefined,
      limit: limit ? Number(limit) : undefined,
    });
    res.json({ status: 'success', data });
  } catch (err) {
    handleSvcError(res, err);
  }
}

export async function getRefundReview(req: Request, res: Response): Promise<void> {
  try {
    const refundId = Number(req.params.refundId);
    if (!isPositiveId(refundId)) { adminBadRequest(res, 'Invalid refund ID'); return; }
    const data = await svc.getRefundReview(refundId);
    if (!data) { adminNotFound(res, 'Refund review'); return; }
    res.json({ status: 'success', data });
  } catch (err) {
    handleSvcError(res, err);
  }
}

export async function openRefundReview(req: Request, res: Response): Promise<void> {
  try {
    const { bookingId, paymentId, amount, reason, customerUid, customerName, refundMethod, notes } = req.body;
    const parsedBookingId = Number(bookingId);
    const parsedPaymentId = paymentId == null ? null : Number(paymentId);
    const parsedAmount = Number(amount);
    if (!isPositiveId(parsedBookingId) || (parsedPaymentId != null && !isPositiveId(parsedPaymentId)) || !Number.isFinite(parsedAmount) || parsedAmount <= 0 || !reason?.trim()) {
      adminValidationError(res, 'bookingId, amount, and reason are required');
      return;
    }
    const { uid, name } = actorFrom(req);
    const refundId = await svc.openRefundReview(
      { bookingId: parsedBookingId, paymentId: parsedPaymentId,
        amount: parsedAmount, reason: reason.trim(), customerUid, customerName, refundMethod, notes },
      uid, name, rid(req)
    );
    res.status(201).json({ status: 'success', data: { refundId } });
  } catch (err) {
    handleSvcError(res, err);
  }
}

export async function approveRefund(req: Request, res: Response): Promise<void> {
  try {
    const refundId = Number(req.params.refundId);
    if (!isPositiveId(refundId)) { adminBadRequest(res, 'Invalid refund ID'); return; }
    const { uid, name } = actorFrom(req);
    await svc.approveRefund(refundId, uid, name, rid(req));
    res.json({ status: 'success', data: { refundId } });
  } catch (err) {
    handleSvcError(res, err);
  }
}

export async function rejectRefund(req: Request, res: Response): Promise<void> {
  try {
    const refundId = Number(req.params.refundId);
    if (!isPositiveId(refundId)) { adminBadRequest(res, 'Invalid refund ID'); return; }
    const { rejectionReason } = req.body;
    if (!rejectionReason?.trim()) { adminValidationError(res, 'rejectionReason is required'); return; }
    const { uid, name } = actorFrom(req);
    await svc.rejectRefund(refundId, rejectionReason.trim(), uid, name, rid(req));
    res.json({ status: 'success', data: { refundId } });
  } catch (err) {
    handleSvcError(res, err);
  }
}

export async function markRefundProcessed(req: Request, res: Response): Promise<void> {
  try {
    const refundId = Number(req.params.refundId);
    if (!isPositiveId(refundId)) { adminBadRequest(res, 'Invalid refund ID'); return; }
    const { refundReference } = req.body;
    if (!refundReference?.trim()) { adminValidationError(res, 'refundReference is required'); return; }
    const { uid, name } = actorFrom(req);
    await svc.markRefundProcessed(refundId, refundReference.trim(), uid, name, rid(req));
    res.json({ status: 'success', data: { refundId } });
  } catch (err) {
    handleSvcError(res, err);
  }
}

// ── Reconciliation ────────────────────────────────────────────────────────────

export async function runReconciliation(req: Request, res: Response): Promise<void> {
  try {
    const { uid, name } = actorFrom(req);
    const data = await svc.runReconciliation(uid, name, rid(req));
    res.json({ status: 'success', data });
  } catch (err) {
    handleSvcError(res, err);
  }
}

export async function listExceptions(req: Request, res: Response): Promise<void> {
  try {
    const { status, exceptionCode, severity, fromDate, toDate, page, limit } =
      req.query as Record<string, string>;
    const data = await svc.listExceptions({
      status, exceptionCode, severity, fromDate, toDate,
      page:  page  ? Number(page)  : undefined,
      limit: limit ? Number(limit) : undefined,
    });
    res.json({ status: 'success', data });
  } catch (err) {
    handleSvcError(res, err);
  }
}

export async function resolveException(req: Request, res: Response): Promise<void> {
  try {
    const exceptionId = Number(req.params.exceptionId);
    if (!isPositiveId(exceptionId)) { adminBadRequest(res, 'Invalid exception ID'); return; }
    const { resolutionReason } = req.body;
    if (!resolutionReason?.trim()) { adminValidationError(res, 'resolutionReason is required'); return; }
    const { uid, name } = actorFrom(req);
    await svc.resolveException(exceptionId, resolutionReason.trim(), uid, name, rid(req));
    res.json({ status: 'success', data: { exceptionId } });
  } catch (err) {
    handleSvcError(res, err);
  }
}

export async function ignoreException(req: Request, res: Response): Promise<void> {
  try {
    const exceptionId = Number(req.params.exceptionId);
    if (!isPositiveId(exceptionId)) { adminBadRequest(res, 'Invalid exception ID'); return; }
    const { reason } = req.body;
    if (!reason?.trim()) { adminValidationError(res, 'reason is required'); return; }
    const { uid, name } = actorFrom(req);
    await svc.ignoreException(exceptionId, reason.trim(), uid, name, rid(req));
    res.json({ status: 'success', data: { exceptionId } });
  } catch (err) {
    handleSvcError(res, err);
  }
}
