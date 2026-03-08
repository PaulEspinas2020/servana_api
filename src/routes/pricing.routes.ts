import { Router } from "express";
import * as pricingController from "../controllers/pricingController";

const router = Router();


router.post("/quote", pricingController.quote);

export default router;
