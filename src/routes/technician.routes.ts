import { Router } from "express";
import * as technicianController from "../controllers/technicianController";

const router = Router();


router.get("/workers/role/:role", technicianController.listByRole);
router.get("/workers/:uid", technicianController.getByUid);
router.post("/workers/location", technicianController.updateLocation);
router.get("/workers/location/:uid", technicianController.getLocation);

export default router;
