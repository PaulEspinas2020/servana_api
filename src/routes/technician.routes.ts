import { Router } from "express";
import * as technicianController from "../controllers/technicianController";
import verifyAuth from "../middleware/verifyAuth";
import verifyRoles from "../middleware/verifyRoles";
import verifyOwnership from "../middleware/verifyOwnership";
import { legacyRouteTelemetry } from "../middleware/legacyRouteTelemetry";

const router = Router();

// Measure the unauthenticated legacy family before retiring it. Step 4 of
// docs/WORKER_ROUTE_MIGRATION.md is gated on this traffic reaching zero, and
// nobody can judge that without numbers. Also surfaces enumeration: a caller
// claiming many distinct workerUids is doing what no real worker app does.
// Non-blocking, logs no PII.
router.use("/workers", legacyRouteTelemetry);

// The blanket "public mobile routes" note that used to head this block was both
// inaccurate and load-bearing: it was read as a constraint, and left three
// routes open through an audit that read them.
// Both released apps DO send a bearer token on every request — ServanaClient at
// servana_api_client.dart:37-47, ServanaWorker via the global _AuthInterceptor
// at servana_api_config.dart:74-79 — so authenticating a legacy route is safe
// wherever its callers already hold a session (§2).
//
// role/:role took the role from the URL and ran
//   SELECT uid, email, first_name, last_name, phone_number FROM user_credentials
//   WHERE role = $1
// (technicianService.ts:16-28). Role 3 is customer, so `GET /api/workers/role/3`
// returned EVERY customer's email and phone to anyone who could reach the API.
// It sat 30 lines above the /workers/:uid projection added in 65b4337, which
// carefully withholds exactly this data — the projection was bypassable by
// asking a different question in the same router.
//
// Admin-only rather than projected: both client methods that call it
// (servana_api_client.dart:338, ServanaWorker servana_api.dart:310) have zero
// call sites, so no shipped screen depends on it and no release is needed.
// /workers/all has no caller in any of the four clients.
const adminOnly = [verifyAuth, verifyRoles([0, 1])];
router.get("/workers/role/:role", ...adminOnly, technicianController.listByRole);
router.get("/workers/all", ...adminOnly, technicianController.list);
router.get("/workers/available", technicianController.getAvailableWorkers);
// EXCEPTION to the blanket note that used to head the block above.
//
// This returned the provider's email, birthdate, home addresses, compliance
// documents, full booking history — which names every customer they have ever
// served — plus their disbursement ledger and earnings summary, to anyone
// holding a provider uid. The same financial data is gated with
// verifyAuth + verifyOwnership 30 lines below, where it is labelled "financial
// data"; this endpoint predates that and was never revisited.
//
// Safe to authenticate because both callers already send a bearer token:
// ServanaClient via servana_api_client.dart:37-47, ServanaWorker via its Dio
// interceptor. The controller then projects by the caller's relationship, so a
// customer still gets the name and phone the booking screen needs (§2 — no
// protected release).
router.get("/workers/:uid", verifyAuth, technicianController.getByUid);
router.post("/workers/location", technicianController.updateLocation);
router.get("/workers/location/:uid", technicianController.getLocation);
router.get("/workers/:workerId/schedule", technicianController.workerSchedule);

// getJobCards (technicianController.ts:214-243) takes workerId from the URL and
// returns, per job, the customer's name, phone number and full street address
// including delivery instructions. Unauthenticated, that is a customer address
// book keyed by a guessable worker id.
//
// verifyOwnership already reads req.params.workerId and is what the financial
// routes below this line use; the caller must now BE the worker. ServanaWorker
// is the only mobile caller (job_cards_store.dart) and its interceptor attaches
// a token to every request, so this needs no coordinated release. The provider
// web portal already moved to the authenticated successor GET /worker/job-cards
// (provider-jobs-api.service.ts:140-149).
router.get(
  "/workers/:workerId/job-cards",
  verifyAuth,
  verifyOwnership,
  technicianController.getJobCards,
);
// Booking lifecycle. These carried no auth at all and took the acting worker
// from `?workerUid=`, so anyone reaching the API could accept, start, complete
// or decline any booking as any worker — and completion is what makes a job
// payable. The controllers now derive identity from the token (actingWorkerUid);
// verifyAuth is what guarantees there is one.
router.put("/workers/bookings/:bookingId/decline", verifyAuth, technicianController.declineJob);
router.put("/workers/bookings/:bookingId/accept", verifyAuth, technicianController.acceptJob);
router.put("/workers/bookings/:bookingId/start", verifyAuth, technicianController.startJob);
router.put("/workers/bookings/:bookingId/complete", verifyAuth, technicianController.completeJob);

// Admin-only routes — require authenticated admin (role 1)
router.put("/admin/bookings/:bookingId/assign", verifyAuth, verifyRoles([1]), technicianController.assignWorker);
router.patch("/admin/workers/:uid/archive", verifyAuth, verifyRoles([1]), technicianController.setArchiveStatus);

// Employee ↔ Services — admin surface only.
//
// Verified live against production BEFORE this change:
//   GET /api/services/1/workers  ->  200, 8 rows carrying
//   email, phone_number, uid, first_name — with no token.
//
// That is the same provider contact data a062ef9 put behind admin-only on
// /workers/role/:role a few hours earlier. It survived because this block is
// filed under "Employee <-> Services" rather than with the /workers/* family,
// so a sweep of that family did not reach it. Grouping by feature hid a route
// that belongs to the same authorization class — worth remembering the next
// time a route audit is scoped by prefix.
//
// The two mutations were worse than the read: POST and DELETE here assign and
// remove a provider's services, unauthenticated. Anyone could have emptied
// every provider's service list, which silently removes them from customer
// search results.
//
// All four are called ONLY by the admin portal
// (shared/services/services.service.ts:46, shared/services/user.service.ts:83,:96,
// core/adapters/admin-legacy-provider.adapter.ts:66,:78,
// core/api/admin-provider360-api.service.ts:83,:220), which attaches a bearer
// token via AuthorizeInterceptor. No mobile caller exists, so no release is
// gated on this (§2).
router.post("/workers/:uid/services", ...adminOnly, technicianController.assignEmployeeServices);
router.delete("/workers/:uid/services/:serviceId", ...adminOnly, technicianController.removeEmployeeService);
router.get("/workers/:uid/services", ...adminOnly, technicianController.getEmployeeServices);
router.get("/services/:serviceId/workers", ...adminOnly, technicianController.getWorkersByService);

// Worker Requirements
router.post("/workers/:uid/requirements", technicianController.uploadRequirements);
router.get("/workers/:uid/requirements", technicianController.getRequirements);
router.delete("/workers/:uid/requirements/:id", technicianController.deleteRequirement);

// Worker Bank Account — financial data; requires auth + ownership (not used by mobile app)
router.put("/workers/:uid/bank-account", verifyAuth, verifyOwnership, technicianController.upsertBankAccount);
router.get("/workers/:uid/bank-account", verifyAuth, verifyOwnership, technicianController.getBankAccount);
router.delete("/workers/:uid/bank-account", verifyAuth, verifyOwnership, technicianController.deleteBankAccount);

// Worker History & Earnings — financial data; requires auth + ownership (not used by mobile app)
router.get("/workers/:uid/booking-history", verifyAuth, verifyOwnership, technicianController.getBookingHistory);
router.get("/workers/:uid/disbursement-history", verifyAuth, verifyOwnership, technicianController.getDisbursementHistory);
router.get("/workers/:uid/earnings-history", verifyAuth, verifyOwnership, technicianController.getEarningsHistory);

// Online Status
router.get("/workers/:uid/online-status", technicianController.getOnlineStatus);
router.post("/workers/:uid/go-online", technicianController.goOnline);
router.post("/workers/:uid/go-offline", technicianController.goOffline);

// Availability & Time Off
router.get("/workers/:uid/availability", technicianController.getAvailability);
router.put("/workers/:uid/availability", technicianController.saveAvailability);
router.get("/workers/:uid/time-off", technicianController.getTimeOff);
router.post("/workers/:uid/time-off", technicianController.createTimeOff);
router.delete("/workers/:uid/time-off/:id", technicianController.deleteTimeOff);

// Service Area
router.get("/workers/:uid/service-area", technicianController.getServiceArea);
router.put("/workers/:uid/service-area", technicianController.saveServiceArea);

// Profile Photo
router.post("/workers/:uid/profile/photo", technicianController.uploadProfilePhoto);

// Dashboard
router.get("/workers/:uid/dashboard", technicianController.getDashboard);

// Onboarding
router.get("/workers/:uid/onboarding", technicianController.getOnboarding);
router.post("/workers/:uid/onboarding/step", technicianController.saveOnboardingStep);
router.post("/workers/:uid/onboarding/submit", technicianController.submitOnboarding);

// Review
router.get("/workers/:uid/review-status", technicianController.getReviewStatus);
router.post("/workers/:uid/submit-for-review", technicianController.submitForReview);

// Notification Preferences — personal data; requires auth + ownership (not used by mobile app)
router.get("/workers/:uid/notification-preferences", verifyAuth, verifyOwnership, technicianController.getNotificationPreferences);
router.put("/workers/:uid/notification-preferences", verifyAuth, verifyOwnership, technicianController.saveNotificationPreferences);

export default router;
