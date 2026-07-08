import { Router } from "express";
import verifyAuth from "../middleware/verifyAuth";
import * as locationController from "../controllers/locationController";

const router = Router();

// Address autocomplete proxy — web-only, requires authenticated provider
router.get("/location/address-suggestions", verifyAuth, locationController.getAddressSuggestions);
router.get("/location/address-details/:placeId", verifyAuth, locationController.getAddressDetails);

export default router;
