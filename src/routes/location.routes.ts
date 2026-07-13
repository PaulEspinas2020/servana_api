import { Router } from "express";
import verifyAuth from "../middleware/verifyAuth";
import * as locationController from "../controllers/locationController";

const router = Router();

// Address autocomplete proxy — web-only (mobile does not call these routes).
// Requires a valid JWT (provider or admin); coordinates remain server-side.
router.get("/location/address-suggestions", verifyAuth, locationController.getAddressSuggestions);
router.get("/location/address-details/:placeId", verifyAuth, locationController.getAddressDetails);

export default router;
