import { Router } from "express";
import * as technicianController from "../controllers/technicianController";
import verifyAuth from "../middleware/verifyAuth";
import verifyRoles from "../middleware/verifyRoles";

const router = Router();

// Public mobile routes — do NOT add auth (mobile app sends workerUid/workerCode as query params, not JWT)
router.get("/workers/role/:role", technicianController.listByRole);
router.get("/workers/all", technicianController.list);
router.get("/workers/available", technicianController.getAvailableWorkers);
router.get("/workers/:uid", technicianController.getByUid);
router.post("/workers/location", technicianController.updateLocation);
router.get("/workers/location/:uid", technicianController.getLocation);
router.get("/workers/:workerId/schedule", technicianController.workerSchedule);
router.get("/workers/:workerId/job-cards", technicianController.getJobCards);
router.put("/workers/bookings/:bookingId/decline", technicianController.declineJob);
router.put("/workers/bookings/:bookingId/accept", technicianController.acceptJob);
router.put("/workers/bookings/:bookingId/start", technicianController.startJob);
router.put("/workers/bookings/:bookingId/complete", technicianController.completeJob);

// Admin-only routes — require authenticated admin (role 1)
router.put("/admin/bookings/:bookingId/assign", verifyAuth, verifyRoles([1]), technicianController.assignWorker);
router.patch("/admin/workers/:uid/archive", verifyAuth, verifyRoles([1]), technicianController.setArchiveStatus);

// Employee ↔ Services
router.post("/workers/:uid/services", technicianController.assignEmployeeServices);
router.delete("/workers/:uid/services/:serviceId", technicianController.removeEmployeeService);
router.get("/workers/:uid/services", technicianController.getEmployeeServices);
router.get("/services/:serviceId/workers", technicianController.getWorkersByService);

// Worker Requirements
router.post("/workers/:uid/requirements", technicianController.uploadRequirements);
router.get("/workers/:uid/requirements", technicianController.getRequirements);
router.delete("/workers/:uid/requirements/:id", technicianController.deleteRequirement);

// Worker Bank Account
router.put("/workers/:uid/bank-account", technicianController.upsertBankAccount);
router.get("/workers/:uid/bank-account", technicianController.getBankAccount);
router.delete("/workers/:uid/bank-account", technicianController.deleteBankAccount);

// Worker History & Earnings
router.get("/workers/:uid/booking-history", technicianController.getBookingHistory);
router.get("/workers/:uid/disbursement-history", technicianController.getDisbursementHistory);
router.get("/workers/:uid/earnings-history", technicianController.getEarningsHistory);

export default router;
