import express from 'express';
import verifyAuth from '../middleware/verifyAuth';
import verifyRoles from '../middleware/verifyRoles';
import * as ctrl from '../controllers/adminFinanceController';

const router = express.Router();
const adminOnly = [verifyAuth, verifyRoles([1])];

// ── Finance summary ───────────────────────────────────────────────────────────
router.get('/admin/finance/summary', ...adminOnly, ctrl.getFinanceSummary);

// ── Payments ──────────────────────────────────────────────────────────────────
router.get( '/admin/finance/payments',                        ...adminOnly, ctrl.listPayments);
router.get( '/admin/finance/payments/gcash-pending',          ...adminOnly, ctrl.listGcashPendingQueue);
router.get( '/admin/finance/payments/:paymentId',             ...adminOnly, ctrl.getPaymentDetail);
router.post('/admin/finance/payments/:paymentId/approve-gcash', ...adminOnly, ctrl.approveGcashPayment);
router.post('/admin/finance/payments/:paymentId/reject-gcash',  ...adminOnly, ctrl.rejectGcashPayment);
router.post('/admin/finance/payments/:paymentId/confirm-cash',  ...adminOnly, ctrl.adminConfirmCash);

// ── Revenue Ledger ────────────────────────────────────────────────────────────
router.get('/admin/finance/ledger',                        ...adminOnly, ctrl.listLedgerEntries);
router.get('/admin/finance/ledger/booking/:bookingId',     ...adminOnly, ctrl.getBookingLedger);

// ── Payouts / Disbursements ───────────────────────────────────────────────────
router.get( '/admin/finance/payouts',                                  ...adminOnly, ctrl.listPayouts);
router.get( '/admin/finance/payouts/:disbursementId',                  ...adminOnly, ctrl.getPayoutDetail);
router.post('/admin/finance/payouts/:disbursementId/hold',             ...adminOnly, ctrl.holdPayout);
router.post('/admin/finance/payouts/:disbursementId/release-hold',     ...adminOnly, ctrl.releasePayoutHold);
router.post('/admin/finance/payouts/:disbursementId/retry',            ...adminOnly, ctrl.retryPayout);

// ── Provider: Internal Fixer ──────────────────────────────────────────────────
router.post('/admin/finance/providers/:uid/internal-fixer', ...adminOnly, ctrl.setInternalFixer);

// ── Refund Reviews ────────────────────────────────────────────────────────────
router.get( '/admin/finance/refunds',                         ...adminOnly, ctrl.listRefundReviews);
router.post('/admin/finance/refunds',                         ...adminOnly, ctrl.openRefundReview);
router.get( '/admin/finance/refunds/:refundId',               ...adminOnly, ctrl.getRefundReview);
router.post('/admin/finance/refunds/:refundId/approve',       ...adminOnly, ctrl.approveRefund);
router.post('/admin/finance/refunds/:refundId/reject',        ...adminOnly, ctrl.rejectRefund);
router.post('/admin/finance/refunds/:refundId/mark-processed', ...adminOnly, ctrl.markRefundProcessed);

// ── Reconciliation ────────────────────────────────────────────────────────────
router.post('/admin/finance/reconciliation/run',                          ...adminOnly, ctrl.runReconciliation);
router.get( '/admin/finance/reconciliation/exceptions',                   ...adminOnly, ctrl.listExceptions);
router.post('/admin/finance/reconciliation/exceptions/:exceptionId/resolve', ...adminOnly, ctrl.resolveException);
router.post('/admin/finance/reconciliation/exceptions/:exceptionId/ignore',  ...adminOnly, ctrl.ignoreException);

export default router;
