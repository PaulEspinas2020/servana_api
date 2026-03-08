import express from 'express'
const router = express.Router()
import * as serviceController from "../controllers/serviceController";

router.get("/services", serviceController.listServices);
router.get("/services/:serviceId/level2", serviceController.listLevel2);
router.get("/:serviceId/options-with-addons", serviceController.listOptionsWithAddons);

router.get("/services/:serviceId/branches", serviceController.listBranches);
router.get("/branches/:branchId/slots", serviceController.listAvailableSlots);
router.post("/branches/slots", serviceController.createSlot);

router.get("/services/:serviceId/coverage-geo", serviceController.list);
router.post("/services/:serviceId/coverage-geo", serviceController.create);
router.get("/services/:serviceId/coverage-geo/check", serviceController.check);


export default router;
