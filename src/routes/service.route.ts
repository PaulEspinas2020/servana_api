import express from 'express'
const router = express.Router()
import * as serviceController from "../controllers/serviceController";
import verifyAuth from "../middleware/verifyAuth";
import verifyRoles from "../middleware/verifyRoles";

// Read routes — unprotected (mobile + customer apps use these)
router.get("/services", serviceController.listServices);
router.get("/services/list", serviceController.listServicesSimple);
router.get("/services/full", serviceController.getFullServiceCatalog);
router.get("/services/:serviceId/level2", serviceController.listLevel2);
router.get("/:serviceId/options-with-addons", serviceController.listOptionsWithAddons);
router.get("/services/:serviceId/branches", serviceController.listBranches);
router.get("/branches/:branchId/slots", serviceController.listAvailableSlots);
router.get("/services/:serviceId/coverage-geo", serviceController.list);
router.get("/services/:serviceId/coverage-geo/check", serviceController.check);

// Write routes — admin only (role 1)
router.post("/services", verifyAuth, verifyRoles([1]), serviceController.createService);
router.put("/services/:serviceId", verifyAuth, verifyRoles([1]), serviceController.updateService);
router.delete("/services/:serviceId/force", verifyAuth, verifyRoles([1]), serviceController.forceDeleteService);
router.post("/branches/slots", verifyAuth, verifyRoles([1]), serviceController.createSlot);
router.post("/services/:serviceId/coverage-geo", verifyAuth, verifyRoles([1]), serviceController.create);


export default router;
