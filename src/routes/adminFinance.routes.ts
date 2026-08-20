import express from 'express';
import verifyAuth from '../middleware/verifyAuth';
import verifyRoles from '../middleware/verifyRoles';
import { adminRateLimit } from '../middleware/adminRateLimit';
import { requirePermission } from '../middleware/requirePermission';
import * as ctrl from '../controllers/adminFinanceController';

const router = express.Router();
const adminOnly = [verifyAuth, verifyRoles([1]), adminRateLimit];

// ── Finance summary ───────────────────────────────────────────────────────────
router.get('/admin/finance/summary', ...adminOnly, requirePermission('finance.dashboard.view'), ctrl.getFinanceSummary);

// ── Payments ──────────────────────────────────────────────────────────────────
router.get( '/admin/finance/payments',               ...adminOnly, requirePermission('payments.view'), ctrl.listPayments);
router.get( '/admin/finance/payments/gcash-pending', ...adminOnly, requirePermission('payments.gcash_review.view'), ctrl.listGcashPendingQueue);
router.get( '/admin/finance/payments/:paymentId',    ...adminOnly, requirePermission('payments.details.view'), ctrl.getPaymentDetail);
router.post('/admin/finance/payments/:paymentId/approve-gcash', ...adminOnly, requirePermission('payments.gcash.approve'), ctrl.approveGcashPayment);
router.post('/admin/finance/payments/:paymentId/reject-gcash',  ...adminOnly, requirePermission('payments.gcash.reject'), ctrl.rejectGcashPayment);
router.post('/admin/finance/payments/:paymentId/confirm-cash',  ...adminOnly, requirePermission('payments.cash.mark_paid'), ctrl.adminConfirmCash);

// ── Revenue Ledger ────────────────────────────────────────────────────────────
router.get('/admin/finance/ledger',                    ...adminOnly, requirePermission('revenue_ledger.view'), ctrl.listLedgerEntries);
router.get('/admin/finance/ledger/booking/:bookingId', ...adminOnly, requirePermission('revenue_ledger.view'), ctrl.getBookingLedger);

// ── Payouts / Disbursements ───────────────────────────────────────────────────
router.get( '/admin/finance/payouts',                                  ...adminOnly, requirePermission('payouts.view'), ctrl.listPayouts);
router.get( '/admin/finance/payouts/:disbursementId',                  ...adminOnly, requirePermission('payouts.details.view'), ctrl.getPayoutDetail);
router.post('/admin/finance/payouts/:disbursementId/hold',             ...adminOnly, requirePermission('payouts.hold'), ctrl.holdPayout);
router.post('/admin/finance/payouts/:disbursementId/release-hold',     ...adminOnly, requirePermission('payouts.release_hold'), ctrl.releasePayoutHold);
router.post('/admin/finance/payouts/:disbursementId/retry',            ...adminOnly, requirePermission('payouts.retry_failed'), ctrl.retryPayout);

// ── Provider: Internal Fixer ──────────────────────────────────────────────────
router.post('/admin/finance/providers/:uid/internal-fixer', ...adminOnly, requirePermission('providers.profile.edit'), ctrl.setInternalFixer);

// ── Refund Reviews ────────────────────────────────────────────────────────────
router.get( '/admin/finance/refunds',                          ...adminOnly, requirePermission('payments.view'), ctrl.listRefundReviews);
router.post('/admin/finance/refunds',                          ...adminOnly, requirePermission('refunds.review.open'), ctrl.openRefundReview);
router.get( '/admin/finance/refunds/:refundId',                ...adminOnly, requirePermission('payments.view'), ctrl.getRefundReview);
router.post('/admin/finance/refunds/:refundId/approve',        ...adminOnly, requirePermission('refunds.approve'), ctrl.approveRefund);
router.post('/admin/finance/refunds/:refundId/reject',         ...adminOnly, requirePermission('refunds.reject'), ctrl.rejectRefund);
router.post('/admin/finance/refunds/:refundId/mark-processed', ...adminOnly, requirePermission('refunds.mark_processed'), ctrl.markRefundProcessed);
router.post('/admin/finance/refunds/:refundId/mark-failed',    ...adminOnly, requirePermission('refunds.mark_failed'),    ctrl.markRefundFailed);

// ── Reconciliation ────────────────────────────────────────────────────────────
router.post('/admin/finance/reconciliation/run',                               ...adminOnly, requirePermission('reconciliation.run'), ctrl.runReconciliation);
router.get( '/admin/finance/reconciliation/exceptions',                        ...adminOnly, requirePermission('reconciliation.view'), ctrl.listExceptions);
router.post('/admin/finance/reconciliation/exceptions/:exceptionId/resolve',   ...adminOnly, requirePermission('reconciliation.exception.resolve'), ctrl.resolveException);
router.post('/admin/finance/reconciliation/exceptions/:exceptionId/ignore',    ...adminOnly, requirePermission('reconciliation.exception.ignore'), ctrl.ignoreException);

export default router;
