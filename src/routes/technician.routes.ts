import { Router } from "express";
import * as technicianController from "../controllers/technicianController";
import verifyAuth from "../middleware/verifyAuth";
import verifyRoles from "../middleware/verifyRoles";
import { adminRateLimit } from '../middleware/adminRateLimit';
import verifyOwnership from "../middleware/verifyOwnership";
import { legacyRouteTelemetry } from "../middleware/legacyRouteTelemetry";
import requireProviderRole from "../middleware/requireProviderRole";
import requireActiveProvider from "../middleware/requireActiveProvider";
import workerCodeLimiter from "../middleware/workerCodeLimiter";

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// The unauthenticated legacy block was DELETED here (Command 4).
//
// 24 routes carried no authentication and took their subject from the URL, so
// anyone could follow a provider's live position, read or delete their
// compliance documents, rewrite their availability and service area, toggle
// them online or offline, and drive their onboarding — by knowing a uid.
//
// Every one had an authenticated successor in provider.routes.ts, and every
// client was migrated off first:
//   ServanaWorker b94f7a1 · ServanaClient f23ae5e/aaac06b
//   provider portal — 42 API paths, none of them /api/workers/*
//   admin portal and customer web — no references at all
//
// The migration plan gated this on observed traffic reaching zero, which is the
// right gate for a live platform. This one is not live: no build is in the
// field and no bookings exist, so there is no old-version tail to wait out.
//
// WHAT REMAINS IN THIS FILE IS NOT A LEAK. All 21 surviving routes carry
// verifyAuth; those taking a :uid also carry verifyOwnership, and the admin
// ones carry verifyRoles via the `adminOnly` spread.
//
// A first pass at this deletion removed 30 routes rather than 24, because the
// detector searched each line for the literal string "verifyAuth" and the
// admin routes are guarded by `...adminOnly` — a spread of
// [verifyAuth, verifyRoles([0,1])]. Six secured admin routes were deleted and
// restored. Any future sweep over this file must resolve middleware aliases.
//
// See docs/WORKER_ROUTE_MIGRATION.md.
// ─────────────────────────────────────────────────────────────────────────────


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
const adminOnly = [verifyAuth, verifyRoles([0, 1]), adminRateLimit];
router.get("/workers/role/:role", ...adminOnly, technicianController.listByRole);
router.get("/workers/all", ...adminOnly, technicianController.list);
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
// C18-01. These carried `verifyAuth` alone while their `/worker/...` (singular)
// successors carry `requireProviderRole + requireActiveProvider`. Any
// authenticated account — a customer, an unknown role — reached a provider
// booking mutation and was stopped only by the controller's row-level scoping.
//
// Nothing calls these: ServanaWorker and the provider portal both use the
// singular family. The portal's capabilities config lists them, but that file
// is imported nowhere and still claims `authRequired: false`, so it is stale
// reference material rather than a caller.
//
// Brought level with the successors rather than deleted — deleting a mounted
// route on the strength of a grep is how this repo previously removed six
// secured endpoints.
//
// The guards are written out literally on every line rather than spread from a
// shared const: `unauthenticated-pii-routes.test.ts` reads this file as TEXT
// and greps each route for its guard names, so an array spread would hide the
// guarantee from the very test that exists to enforce it.
router.put("/workers/bookings/:bookingId/decline", verifyAuth, requireProviderRole, requireActiveProvider, technicianController.declineJob);
router.put("/workers/bookings/:bookingId/accept", verifyAuth, requireProviderRole, requireActiveProvider, technicianController.acceptJob);
// Shares ONE limiter instance with the singular route — separate instances
// would mean separate counters, i.e. two budgets for one secret (LJ-02).
router.put("/workers/bookings/:bookingId/start", verifyAuth, requireProviderRole, requireActiveProvider, workerCodeLimiter, technicianController.startJob);
router.put("/workers/bookings/:bookingId/complete", verifyAuth, requireProviderRole, requireActiveProvider, technicianController.completeJob);

// Admin-only routes — require authenticated admin (role 1)
//
// PUT /admin/bookings/:bookingId/assign was removed here. It duplicated
// POST /admin/bookings/:id/assign (adminBooking.routes.ts) but carried no
// requirePermission, took the provider from a query string with no
// requireProviderTarget, and wrote no audit event. Verified before removal: no
// source in any of the five consumer repos calls it, and nginx logs covering
// 2026-07-28 to 2026-08-11 record zero requests to it while containing other
// /api/admin/bookings traffic. Use the canonical POST route.
router.patch("/admin/workers/:uid/archive", verifyAuth, verifyRoles([1]), adminRateLimit, technicianController.setArchiveStatus);

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

// Worker Bank Account — financial data; requires auth + ownership (not used by mobile app)
router.put("/workers/:uid/bank-account", verifyAuth, verifyOwnership, technicianController.upsertBankAccount);
router.get("/workers/:uid/bank-account", verifyAuth, verifyOwnership, technicianController.getBankAccount);
router.delete("/workers/:uid/bank-account", verifyAuth, verifyOwnership, technicianController.deleteBankAccount);

// Worker History & Earnings — financial data; requires auth + ownership (not used by mobile app)
router.get("/workers/:uid/booking-history", verifyAuth, verifyOwnership, technicianController.getBookingHistory);
router.get("/workers/:uid/disbursement-history", verifyAuth, verifyOwnership, technicianController.getDisbursementHistory);
router.get("/workers/:uid/earnings-history", verifyAuth, verifyOwnership, technicianController.getEarningsHistory);

// Online Status

// Availability & Time Off

// Service Area

// Profile Photo

// Dashboard

// Onboarding

// Review

// Notification Preferences — personal data; requires auth + ownership (not used by mobile app)
router.get("/workers/:uid/notification-preferences", verifyAuth, verifyOwnership, technicianController.getNotificationPreferences);
router.put("/workers/:uid/notification-preferences", verifyAuth, verifyOwnership, technicianController.saveNotificationPreferences);

export default router;
