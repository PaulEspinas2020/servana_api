import { Router } from "express";
import verifyAuth from "../middleware/verifyAuth";
import verifyRoles from "../middleware/verifyRoles";
import * as ctrl from "../controllers/providerCatalogController";

const router = Router();

// ── Provider-facing catalog read (authenticated provider) ─────────────────────
// Returns active, provider-web-visible offerings with specific services.
// Does NOT replace any mobile endpoint — mobile still uses GET /services, /level2, /options-with-addons.
router.get(
  "/provider-catalog/v1/offerings",
  verifyAuth,
  ctrl.getOfferingsForProvider
);

// ── Admin catalog management (role 1 = admin) ─────────────────────────────────
// All mutations go through these endpoints; they operate at the item level
// (no whole-tree replacement) so existing service_options IDs are preserved.

// Offerings
router.get(
  "/admin/provider-catalog/offerings",
  verifyAuth, verifyRoles([1]),
  ctrl.listOfferings
);
router.post(
  "/admin/provider-catalog/offerings",
  verifyAuth, verifyRoles([1]),
  ctrl.createOffering
);

// Specific-service routes BEFORE :offeringId to avoid route shadowing
router.get(
  "/admin/provider-catalog/specific-services/:serviceOptionId",
  verifyAuth, verifyRoles([1]),
  ctrl.getSpecificService
);
router.patch(
  "/admin/provider-catalog/specific-services/:serviceOptionId",
  verifyAuth, verifyRoles([1]),
  ctrl.updateSpecificService
);
router.patch(
  "/admin/provider-catalog/specific-services/:serviceOptionId/status",
  verifyAuth, verifyRoles([1]),
  ctrl.updateSpecificServiceStatus
);
router.post(
  "/admin/provider-catalog/specific-services/:serviceOptionId/addons",
  verifyAuth, verifyRoles([1]),
  ctrl.createAddon
);

// Add-on routes (no :offeringId param)
router.patch(
  "/admin/provider-catalog/addons/:addonOptionId",
  verifyAuth, verifyRoles([1]),
  ctrl.updateAddon
);
router.patch(
  "/admin/provider-catalog/addons/:addonOptionId/status",
  verifyAuth, verifyRoles([1]),
  ctrl.updateAddonStatus
);

// Offering routes with :offeringId (must be after /specific-services/* to avoid shadowing)
router.get(
  "/admin/provider-catalog/offerings/:offeringId",
  verifyAuth, verifyRoles([1]),
  ctrl.getOffering
);
router.patch(
  "/admin/provider-catalog/offerings/:offeringId",
  verifyAuth, verifyRoles([1]),
  ctrl.updateOffering
);
router.patch(
  "/admin/provider-catalog/offerings/:offeringId/status",
  verifyAuth, verifyRoles([1]),
  ctrl.updateOfferingStatus
);
router.get(
  "/admin/provider-catalog/offerings/:offeringId/specific-services",
  verifyAuth, verifyRoles([1]),
  ctrl.listSpecificServices
);
router.post(
  "/admin/provider-catalog/offerings/:offeringId/specific-services",
  verifyAuth, verifyRoles([1]),
  ctrl.createSpecificService
);

export default router;
