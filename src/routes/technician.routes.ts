import { Router } from "express";
import * as technicianController from "../controllers/technicianController";

const router = Router();


router.get("/workers/role/:role", technicianController.listByRole);
router.get("/workers/all", technicianController.list);
router.get("/workers/available", technicianController.getAvailableWorkers);
router.get("/workers/:uid", technicianController.getByUid);
router.post("/workers/location", technicianController.updateLocation);
router.get("/workers/location/:uid", technicianController.getLocation);
router.get("/workers/:workerId/schedule", technicianController.workerSchedule);
``
router.get("/workers/:workerId/job-cards", technicianController.getJobCards);
router.put("/admin/bookings/:bookingId/assign", technicianController.assignWorker);
router.put("/workers/bookings/:bookingId/decline", technicianController.declineJob);
router.put("/workers/bookings/:bookingId/accept", technicianController.acceptJob);
router.put("/workers/bookings/:bookingId/start", technicianController.startJob);
router.put("/workers/bookings/:bookingId/complete", technicianController.completeJob);
// router.get("/bookings/:bookingId/job-card", technicianController.getActiveJobCards);

// Employee ↔ Services
router.post("/workers/:uid/services", technicianController.assignEmployeeServices);
router.delete("/workers/:uid/services/:serviceId", technicianController.removeEmployeeService);
router.get("/workers/:uid/services", technicianController.getEmployeeServices);
router.get("/services/:serviceId/workers", technicianController.getWorkersByService);

// // Worker Bank Account
// router.put("/workers/:uid/bank-account", technicianController.upsertBankAccount);
// router.get("/workers/:uid/bank-account", technicianController.getBankAccount);
// router.delete("/workers/:uid/bank-account", technicianController.deleteBankAccount);

export default router;
