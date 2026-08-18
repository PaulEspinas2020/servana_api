import { Router } from "express";
import * as additionalController from "../controllers/additional.controller";
import verifyAuth from "../middleware/verifyAuth";
import verifyRoles from "../middleware/verifyRoles";
import requireProviderRole from "../middleware/requireProviderRole";
import requireActiveProvider from "../middleware/requireActiveProvider";

const router = Router();

// The "mobile calls these without a token" note below was checked and is false:
// neither ServanaClient nor ServanaWorker references /api/additional anywhere in
// lib/. The only real caller is the provider WEB portal
// (Servana.com.ph/src/app/core/api/provider-additional-work-api.service.ts:177,
// :213), an Angular app whose AuthorizeInterceptor attaches a bearer token to
// every request. So nothing shipped depends on these being open (§2).
//
// Left open, the family let an unauthenticated caller read any booking's extra
// charges, raise new charges in any customer's name, and — via
// /additional/:id/payment — make Servana email a live PayMongo checkout link to
// a customer for a charge the caller invented. That is a payment handler with no
// authentication at all, which is the case §12 exists for.
//
// verifyAuth is the floor, not the ceiling. Controllers resolve every request
// id back to its booking and apply booking-scoped access. Provider mutations
// additionally require provider role + active operational account; the legacy
// :userId segment remains compatible but is never treated as identity.
router.get("/additional/booking/:bookingId", verifyAuth, additionalController.getByBooking);

router.post("/additional/request/:userId", verifyAuth, requireProviderRole, requireActiveProvider, additionalController.createRequest);
router.post("/additional/:id/payment", verifyAuth, additionalController.generatePayment);
router.post("/additional/:id/worker-decision", verifyAuth, requireProviderRole, requireActiveProvider, additionalController.workerDecision);
router.post("/additional/:id/withdraw", verifyAuth, requireProviderRole, requireActiveProvider, additionalController.workerWithdraw);
router.post("/additional/:id/confirm-proceed", verifyAuth, requireProviderRole, requireActiveProvider, additionalController.workerConfirmProceed);

// Admin approval — protected (admin portal only; mobile never calls this route)
router.post("/additional/:id/approve", verifyAuth, verifyRoles([1]), additionalController.approveRequest);

export default router;
