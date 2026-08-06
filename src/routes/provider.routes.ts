import workerCodeLimiter from "../middleware/workerCodeLimiter";
import express from "express";
import requireActiveProvider from "../middleware/requireActiveProvider";
import requireProviderRole from "../middleware/requireProviderRole";
import requireCapability from "../middleware/requireCapability";
import verifyAuth from "../middleware/verifyAuth";
import verifyRoles from "../middleware/verifyRoles";
import * as provider from "../controllers/providerController";
import * as locationAccess from "../controllers/providerLocationAccessController";
import * as accountState from "../controllers/providerAccountStateController";

const router = express.Router();

/**
 * `requireProviderRole` guards this whole file except for four routes, and the
 * exceptions are the interesting part — a blanket sweep would have broken two
 * other apps:
 *
 *   - `GET /provider/account-state` — the discovery endpoint. It already
 *     answers a non-provider with `nextStep: ROLE_NOT_PERMITTED`, and both
 *     clients route on that. Replacing the answer with a bare 403 would leave
 *     someone refused with no way to find out why.
 *   - `GET /admin/provider/reconciliation` — role 1, guarded by verifyRoles([1]).
 *   - `GET /booking/:id/provider-location` and `GET /booking/:id/provider` —
 *     the CUSTOMER app calls these to track the provider on a booking it owns.
 *     Guarding them would have broken live tracking for every customer.
 *
 * Anything added below gets the guard unless it belongs on that list.
 */

// Provider profile (provider-portal specific — includes worker_code + service_preference)
// Canonical account state (Command 6 §5). Authenticated only, NOT behind
// requireActiveProvider: a suspended or pending provider needs this endpoint
// precisely because they are restricted, and gating it would leave them unable
// to discover why.
router.get("/provider/account-state", verifyAuth, accountState.getAccountState);
router.get("/provider/profile", verifyAuth, requireProviderRole, provider.getProviderProfile);
router.post("/provider/service-preference", verifyAuth, requireProviderRole, provider.saveServicePreference);

// Location / online status
router.get("/provider/location/status", verifyAuth, requireProviderRole, provider.getLocationStatus);
router.post("/provider/location/go-online", verifyAuth, requireProviderRole, requireActiveProvider, provider.goOnline);
router.post("/provider/location/go-offline", verifyAuth, requireProviderRole, provider.goOffline);

// Dashboard
router.get("/provider/dashboard", verifyAuth, requireProviderRole, provider.getDashboard);

// Earnings
router.get("/provider/earnings", verifyAuth, requireProviderRole, requireCapability("canViewEarnings"), provider.getEarnings);
router.get("/provider/earnings/summary", verifyAuth, requireProviderRole, requireCapability("canViewEarnings"), provider.getEarningsSummary);
router.get("/provider/earnings/:id", verifyAuth, requireProviderRole, requireCapability("canViewEarnings"), provider.getEarningById);
router.get("/provider/ledger", verifyAuth, requireProviderRole, requireCapability("canViewEarnings"), provider.getLedger);
router.get("/provider/payouts", verifyAuth, requireProviderRole, requireCapability("canViewEarnings"), provider.getPayouts);
// Performance metrics for the portal's Performance page (own uid from token).
router.get("/provider/performance", verifyAuth, requireProviderRole, provider.getProviderPerformanceMetrics);

// Review / onboarding
router.get("/providers/me/review-status", verifyAuth, requireProviderRole, provider.getReviewStatus);
router.post("/providers/me/submit-for-review", verifyAuth, requireProviderRole, provider.submitForReview);

// Support tickets
router.get("/provider/support/tickets", verifyAuth, requireProviderRole, provider.getSupportTickets);
router.post("/provider/support/tickets", verifyAuth, requireProviderRole, provider.createSupportTicket);

// Notification preferences
router.get("/provider/notification-preferences", verifyAuth, requireProviderRole, provider.getNotificationPreferences);
router.put("/provider/notification-preferences", verifyAuth, requireProviderRole, provider.updateNotificationPreferences);

// Notifications inbox (scaffold — data populated by event pipeline)
// unread-count must be registered before /:key to avoid route shadowing
router.get("/provider/notifications/unread-count", verifyAuth, requireProviderRole, provider.getNotificationsUnreadCount);
router.post("/provider/notifications/mark-all-read", verifyAuth, requireProviderRole, provider.markAllNotificationsRead);
router.get("/provider/notifications", verifyAuth, requireProviderRole, provider.getProviderNotifications);
router.patch("/provider/notifications/:key/read", verifyAuth, requireProviderRole, provider.markNotificationRead);
router.delete("/provider/notifications/:key", verifyAuth, requireProviderRole, provider.dismissNotification);

// Priority alerts
router.get("/provider/alerts", verifyAuth, requireProviderRole, provider.getProviderAlerts);
router.delete("/provider/alerts/:key", verifyAuth, requireProviderRole, provider.dismissAlert);

// ─── Worker self-service routes (JWT-auth, no :uid param) ────────────────────
// Shared naming so mobile app and web portal can call the same endpoints.

// Availability / schedule
router.get("/worker/availability", verifyAuth, requireProviderRole, provider.getWorkerAvailability);
router.put("/worker/availability", verifyAuth, requireProviderRole, provider.saveWorkerAvailability);
router.get("/worker/time-off", verifyAuth, requireProviderRole, provider.getWorkerTimeOff);
router.post("/worker/time-off", verifyAuth, requireProviderRole, provider.createWorkerTimeOff);
router.delete("/worker/time-off/:id", verifyAuth, requireProviderRole, provider.deleteWorkerTimeOff);

// Requirements (authenticated worker uploading their own docs)
router.post("/worker/requirements/upload", verifyAuth, requireProviderRole, provider.uploadWorkerRequirement);
router.get("/worker/requirements", verifyAuth, requireProviderRole, provider.getWorkerRequirementsOwn);
router.delete("/worker/requirements/:id", verifyAuth, requireProviderRole, provider.deleteWorkerRequirementOwn);

// Onboarding state
router.get("/worker/onboarding", verifyAuth, requireProviderRole, provider.getOnboardingState);
router.post("/worker/onboarding/submit", verifyAuth, requireProviderRole, provider.submitOnboarding);
router.post("/worker/onboarding/step", verifyAuth, requireProviderRole, provider.saveOnboardingStep);

// Additional work — worker decisions (auth-scoped, ownership-checked)
router.post("/worker/additional-work/:id/decision", verifyAuth, requireProviderRole, provider.workerAdditionalDecision);
router.post("/worker/additional-work/:id/withdraw", verifyAuth, requireProviderRole, provider.withdrawAdditionalWork);
router.post("/worker/additional-work/:id/confirm-proceed", verifyAuth, requireProviderRole, provider.confirmProceedAdditionalWork);

// Service area (P0-06)
router.get("/worker/service-area", verifyAuth, requireProviderRole, provider.getWorkerServiceArea);
router.put("/worker/service-area", verifyAuth, requireProviderRole, provider.saveWorkerServiceArea);

// Profile photo (P0-07)
router.post("/worker/profile/photo", verifyAuth, requireProviderRole, provider.uploadWorkerProfilePhoto);
router.delete("/worker/profile/photo", verifyAuth, requireProviderRole, provider.deleteWorkerProfilePhoto);

// Safety incidents (P0-01 / P0-02 / P0-03)
// unread-count pattern: non-param routes registered before param routes
router.get("/provider/safety/emergency-config", verifyAuth, requireProviderRole, provider.getEmergencyConfig);
router.get("/provider/safety/incidents", verifyAuth, requireProviderRole, provider.getSafetyIncidents);
router.post("/provider/safety/incidents", verifyAuth, requireProviderRole, provider.submitSafetyIncident);

// Account security — password + session revocation (P0-04 / P0-05)
router.get("/provider/security", verifyAuth, requireProviderRole, provider.getProviderSecurity);
router.post("/provider/security/password", verifyAuth, requireProviderRole, provider.changeProviderPassword);
// revoke-all must be registered before /:id to avoid route shadowing
router.post("/provider/security/sessions/revoke-all", verifyAuth, requireProviderRole, provider.revokeAllProviderSessions);
router.delete("/provider/security/sessions/:id", verifyAuth, requireProviderRole, provider.revokeProviderSession);

// Payout settings (P1)
router.get("/provider/payout/summary", verifyAuth, requireProviderRole, requireCapability("canViewEarnings"), provider.getProviderPayoutSummary);
router.post("/provider/payout/update-session", verifyAuth, requireProviderRole, provider.requestProviderPayoutUpdate);
router.post("/provider/payout", verifyAuth, requireProviderRole, requireActiveProvider, provider.registerProviderPayout);

// Privacy / account actions (P1)
router.get("/provider/privacy", verifyAuth, requireProviderRole, provider.getProviderPrivacy);
router.post("/provider/privacy/export", verifyAuth, requireProviderRole, provider.requestProviderDataExport);
router.post("/provider/account/deactivate", verifyAuth, requireProviderRole, provider.requestProviderDeactivation);
router.post("/provider/account/delete", verifyAuth, requireProviderRole, provider.requestProviderDeletion);

// Support ticket follow-ons (P1) — unread-count before /:ticketKey to avoid route shadowing
router.get("/provider/support/unread-count", verifyAuth, requireProviderRole, provider.getSupportUnreadCount);
router.get("/provider/support/tickets/:ticketKey", verifyAuth, requireProviderRole, provider.getSupportTicketDetail);
router.post("/provider/support/tickets/:ticketKey/replies", verifyAuth, requireProviderRole, provider.addSupportTicketReply);
router.post("/provider/support/tickets/:ticketKey/close", verifyAuth, requireProviderRole, provider.closeSupportTicket);
router.post("/provider/support/tickets/:ticketKey/reopen", verifyAuth, requireProviderRole, provider.reopenSupportTicket);

// Safety check-in timestamps (P1)
router.post("/provider/safety/check-in", verifyAuth, requireProviderRole, provider.recordSafetyCheckIn);

// ─── Service application lifecycle (provider web portal — separate from employee_services) ──
router.get("/worker/service-applications", verifyAuth, requireProviderRole, provider.getServiceApplications);
router.post("/worker/service-applications", verifyAuth, requireProviderRole, provider.submitServiceApplication);
router.post("/worker/service-applications/:applicationId/resubmit", verifyAuth, requireProviderRole, provider.resubmitServiceApplication);
router.delete("/worker/service-applications/:applicationId", verifyAuth, requireProviderRole, provider.cancelServiceApplication);

// ─── Active service pause / reactivate (employee_services status) ─────────────
router.patch("/worker/services/:serviceId/pause",       verifyAuth, requireProviderRole, provider.pauseWorkerService);
router.patch("/worker/services/:serviceId/reactivate",  verifyAuth, requireProviderRole, provider.reactivateWorkerService);

// FCM token — saved after login so push notifications reach this device
router.post("/provider/fcm-token", verifyAuth, requireProviderRole, provider.saveProviderFcmToken);
router.delete("/provider/fcm-token", verifyAuth, requireProviderRole, provider.deleteProviderFcmToken);

// ─── Job cards (auth-scoped; UID resolved from Firebase token, never from URL) ─
// These are the web-portal equivalents of the mobile /workers/:uid/job-cards routes.
// Mobile routes remain unchanged — this adds auth-required parity endpoints for web.
// Single-card route must be registered before the list route (more specific first).
router.get("/worker/job-cards/:bookingId", verifyAuth, requireProviderRole, provider.getWorkerJobCard);
router.get("/worker/job-cards", verifyAuth, requireProviderRole, provider.getWorkerJobCards);

// C18 §21 — authoritative booking timeline, provider-scoped.
router.get("/provider/bookings/:bookingId/timeline", verifyAuth, requireProviderRole, provider.getBookingTimeline);
// C18 §29 — dispute status + eligibility. Entry point only; opening is later.
router.get("/provider/bookings/:bookingId/dispute-status", verifyAuth, requireProviderRole, provider.getBookingDisputeStatus);

// C19 17-19 - job evidence. Requirements are server-driven; uploads are
// content-validated and metadata-stripped; attached is NOT approved.
router.get("/provider/bookings/:bookingId/evidence", verifyAuth, requireProviderRole, provider.getBookingEvidence);
router.post("/provider/bookings/:bookingId/evidence", verifyAuth, requireProviderRole, requireActiveProvider, provider.uploadBookingEvidence);
router.delete("/provider/bookings/:bookingId/evidence/:evidenceId", verifyAuth, requireProviderRole, requireActiveProvider, provider.deleteBookingEvidence);
// C18 §26 — provider cancellation. 48h notice, record-only, auto-reassign.
router.get("/provider/bookings/:bookingId/cancellation-eligibility", verifyAuth, requireProviderRole, provider.getCancellationEligibility);
router.post("/provider/bookings/:bookingId/cancel", verifyAuth, requireProviderRole, requireActiveProvider, provider.cancelAcceptedBooking);

// ─── Booking lifecycle (auth-scoped; BOLA enforced in service via SQL WHERE worker_uid = token.uid) ──
// Web portal equivalents of the unauthenticated /workers/bookings/:id/* mobile routes.


router.put("/worker/bookings/:bookingId/accept", verifyAuth, requireProviderRole, requireActiveProvider, provider.acceptBooking);
router.put("/worker/bookings/:bookingId/decline", verifyAuth, requireProviderRole, requireActiveProvider, provider.declineBooking);
router.put("/worker/bookings/:bookingId/en-route", verifyAuth, requireProviderRole, requireActiveProvider, provider.markBookingEnRoute);
router.put("/worker/bookings/:bookingId/arrived", verifyAuth, requireProviderRole, requireActiveProvider, provider.markBookingArrived);
router.put("/worker/bookings/:bookingId/start", verifyAuth, requireProviderRole, requireActiveProvider, workerCodeLimiter, provider.startBooking);
router.put("/worker/bookings/:bookingId/complete", verifyAuth, requireProviderRole, requireActiveProvider, provider.completeBooking);

// ─── Location update (auth-scoped; uid from Firebase token, not request body) ─
router.post("/worker/location", verifyAuth, requireProviderRole, requireActiveProvider, provider.updateWorkerLocation);

// ─── Worker services (auth-scoped; uid from Firebase token, not URL param) ────
router.get("/worker/services", verifyAuth, requireProviderRole, provider.getWorkerServices);
router.delete("/worker/services/:serviceId", verifyAuth, requireProviderRole, provider.removeWorkerService);

// ─── Admin diagnostics (role=1 only) ─────────────────────────────────────────
router.get("/admin/provider/reconciliation", verifyAuth, verifyRoles([1]), provider.getProviderReconciliationReport);

// ─── Authenticated booking detail + tracking (LEAK-BE-P0-01 / P0-05 web-portal equivalents) ──
// These are NEW authenticated endpoints for the provider web portal.
// The unauthenticated mobile routes GET /bookings/:id and GET /bookings/:id/tracking
// in booking.routes.ts are protected mobile contracts — left completely unchanged.
router.get("/provider/bookings/:id", verifyAuth, requireProviderRole, provider.getProviderBookingDetail);
router.get("/provider/jobs/:id/tracking", verifyAuth, requireProviderRole, provider.getProviderBookingTracking);

// ─── Additional work list for authenticated worker (ST-P1-01) ────────────────
// Returns all additional requests across the worker's assigned bookings.
// The per-booking endpoint GET /additional/booking/:bookingId (no auth) remains unchanged.
router.get("/provider/additional-requests", verifyAuth, requireProviderRole, provider.getAdditionalRequests);

export default router;

// ── Authenticated successors to the unauthenticated legacy worker routes ──────
// The legacy family in technician.routes.ts takes its subject from the URL and
// has no auth, so anyone can follow any provider's live position or read their
// schedule. These take no subject from the caller: schedule is self-scoped from
// the token, and location is asked for via a booking the caller already owns.
// Legacy routes stay in place so the live apps keep working (§2); see
// docs/WORKER_ROUTE_MIGRATION.md.
router.get("/worker/schedule", verifyAuth, requireProviderRole, locationAccess.getMySchedule);
router.get("/booking/:bookingId/provider-location", verifyAuth, locationAccess.getBookingProviderLocation);
router.get("/booking/:bookingId/provider", verifyAuth, locationAccess.getBookingProvider);
