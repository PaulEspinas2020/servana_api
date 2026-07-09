import express from "express";
import verifyAuth from "../middleware/verifyAuth";
import verifyRoles from "../middleware/verifyRoles";
import * as provider from "../controllers/providerController";

const router = express.Router();

// Provider profile (provider-portal specific — includes worker_code + service_preference)
router.get("/provider/profile", verifyAuth, provider.getProviderProfile);
router.post("/provider/service-preference", verifyAuth, provider.saveServicePreference);

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

// Service area (P0-06)
router.get("/worker/service-area", verifyAuth, provider.getWorkerServiceArea);
router.put("/worker/service-area", verifyAuth, provider.saveWorkerServiceArea);

// Profile photo (P0-07)
router.post("/worker/profile/photo", verifyAuth, provider.uploadWorkerProfilePhoto);

// Safety incidents (P0-01 / P0-02 / P0-03)
// unread-count pattern: non-param routes registered before param routes
router.get("/provider/safety/emergency-config", verifyAuth, provider.getEmergencyConfig);
router.get("/provider/safety/incidents", verifyAuth, provider.getSafetyIncidents);
router.post("/provider/safety/incidents", verifyAuth, provider.submitSafetyIncident);

// Account security — password + session revocation (P0-04 / P0-05)
router.get("/provider/security", verifyAuth, provider.getProviderSecurity);
router.post("/provider/security/password", verifyAuth, provider.changeProviderPassword);
// revoke-all must be registered before /:id to avoid route shadowing
router.post("/provider/security/sessions/revoke-all", verifyAuth, provider.revokeAllProviderSessions);
router.delete("/provider/security/sessions/:id", verifyAuth, provider.revokeProviderSession);

// Payout settings (P1)
router.get("/provider/payout/summary", verifyAuth, provider.getProviderPayoutSummary);
router.post("/provider/payout/update-session", verifyAuth, provider.requestProviderPayoutUpdate);
router.post("/provider/payout", verifyAuth, provider.registerProviderPayout);

// Privacy / account actions (P1)
router.get("/provider/privacy", verifyAuth, provider.getProviderPrivacy);
router.post("/provider/privacy/export", verifyAuth, provider.requestProviderDataExport);
router.post("/provider/account/deactivate", verifyAuth, provider.requestProviderDeactivation);
router.post("/provider/account/delete", verifyAuth, provider.requestProviderDeletion);

// Support ticket follow-ons (P1) — unread-count before /:ticketKey to avoid route shadowing
router.get("/provider/support/unread-count", verifyAuth, provider.getSupportUnreadCount);
router.get("/provider/support/tickets/:ticketKey", verifyAuth, provider.getSupportTicketDetail);
router.post("/provider/support/tickets/:ticketKey/replies", verifyAuth, provider.addSupportTicketReply);
router.post("/provider/support/tickets/:ticketKey/close", verifyAuth, provider.closeSupportTicket);
router.post("/provider/support/tickets/:ticketKey/reopen", verifyAuth, provider.reopenSupportTicket);

// Safety check-in timestamps (P1)
router.post("/provider/safety/check-in", verifyAuth, provider.recordSafetyCheckIn);

// ─── Service application lifecycle (provider web portal — separate from employee_services) ──
router.get("/worker/service-applications", verifyAuth, provider.getServiceApplications);
router.post("/worker/service-applications", verifyAuth, provider.submitServiceApplication);
router.delete("/worker/service-applications/:applicationId", verifyAuth, provider.cancelServiceApplication);

// FCM token — saved after login so push notifications reach this device
router.post("/provider/fcm-token", verifyAuth, provider.saveProviderFcmToken);

// ─── Admin diagnostics (role=1 only) ─────────────────────────────────────────
router.get("/admin/provider/reconciliation", verifyAuth, verifyRoles([1]), provider.getProviderReconciliationReport);

export default router;
