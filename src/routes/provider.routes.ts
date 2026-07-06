import express from "express";
import verifyAuth from "../middleware/verifyAuth";
import * as provider from "../controllers/providerController";

const router = express.Router();

// Provider profile (provider-portal specific — includes worker_code)
router.get("/provider/profile", verifyAuth, provider.getProviderProfile);

// Location / online status
router.get("/provider/location/status", verifyAuth, provider.getLocationStatus);
router.post("/provider/location/go-online", verifyAuth, provider.goOnline);
router.post("/provider/location/go-offline", verifyAuth, provider.goOffline);

// Dashboard
router.get("/provider/dashboard", verifyAuth, provider.getDashboard);

// Earnings
router.get("/provider/earnings", verifyAuth, provider.getEarnings);
router.get("/provider/earnings/summary", verifyAuth, provider.getEarningsSummary);
router.get("/provider/ledger", verifyAuth, provider.getLedger);
router.get("/provider/payouts", verifyAuth, provider.getPayouts);

// Review / onboarding
router.get("/providers/me/review-status", verifyAuth, provider.getReviewStatus);
router.post("/providers/me/submit-for-review", verifyAuth, provider.submitForReview);

// Support tickets
router.get("/provider/support/tickets", verifyAuth, provider.getSupportTickets);
router.post("/provider/support/tickets", verifyAuth, provider.createSupportTicket);

// Notification preferences
router.get("/provider/notification-preferences", verifyAuth, provider.getNotificationPreferences);
router.put("/provider/notification-preferences", verifyAuth, provider.updateNotificationPreferences);

// Notifications inbox (scaffold — data populated by event pipeline)
// unread-count must be registered before /:key to avoid route shadowing
router.get("/provider/notifications/unread-count", verifyAuth, provider.getNotificationsUnreadCount);
router.post("/provider/notifications/mark-all-read", verifyAuth, provider.markAllNotificationsRead);
router.get("/provider/notifications", verifyAuth, provider.getProviderNotifications);
router.patch("/provider/notifications/:key/read", verifyAuth, provider.markNotificationRead);
router.delete("/provider/notifications/:key", verifyAuth, provider.dismissNotification);

// Priority alerts
router.get("/provider/alerts", verifyAuth, provider.getProviderAlerts);
router.delete("/provider/alerts/:key", verifyAuth, provider.dismissAlert);

// ─── Worker self-service routes (JWT-auth, no :uid param) ────────────────────
// Shared naming so mobile app and web portal can call the same endpoints.

// Availability / schedule
router.get("/worker/availability", verifyAuth, provider.getWorkerAvailability);
router.put("/worker/availability", verifyAuth, provider.saveWorkerAvailability);
router.get("/worker/time-off", verifyAuth, provider.getWorkerTimeOff);
router.post("/worker/time-off", verifyAuth, provider.createWorkerTimeOff);
router.delete("/worker/time-off/:id", verifyAuth, provider.deleteWorkerTimeOff);

// Requirements (authenticated worker uploading their own docs)
router.post("/worker/requirements/upload", verifyAuth, provider.uploadWorkerRequirement);
router.get("/worker/requirements", verifyAuth, provider.getWorkerRequirementsOwn);
router.delete("/worker/requirements/:id", verifyAuth, provider.deleteWorkerRequirementOwn);

// Onboarding state
router.get("/worker/onboarding", verifyAuth, provider.getOnboardingState);
router.post("/worker/onboarding/submit", verifyAuth, provider.submitOnboarding);
router.post("/worker/onboarding/step", verifyAuth, provider.saveOnboardingStep);

// Additional work — worker decisions (auth-scoped, ownership-checked)
router.post("/worker/additional-work/:id/decision", verifyAuth, provider.workerAdditionalDecision);
router.post("/worker/additional-work/:id/withdraw", verifyAuth, provider.withdrawAdditionalWork);
router.post("/worker/additional-work/:id/confirm-proceed", verifyAuth, provider.confirmProceedAdditionalWork);

export default router;
