import { Router } from "express";
import verifyAuth from "../middleware/verifyAuth";
import verifyRoles from "../middleware/verifyRoles";
import requireProviderRole from "../middleware/requireProviderRole";
import { requirePermission } from "../middleware/requirePermission";
import * as ctrl from "../controllers/providerCatalogController";

const router = Router();

// ── Provider-facing catalog read (authenticated provider, NOT admin) ──────────
// Returns active, provider-web-visible offerings with specific services.
// Does NOT replace any mobile endpoint — mobile still uses GET /services, /level2, /options-with-addons.
router.get(
  "/provider-catalog/v1/offerings",
  verifyAuth,
  requireProviderRole,
  ctrl.getOfferingsForProvider
);

// ── Admin catalog management (role 1 = admin) ─────────────────────────────────
// All mutations go through these endpoints; they operate at the item level
// (no whole-tree replacement) so existing service_options IDs are preserved.

// Offerings
router.get(
  "/admin/provider-catalog/offerings",
  verifyAuth, verifyRoles([1]), requirePermission('services.view'),
  ctrl.listOfferings
);
router.post(
  "/admin/provider-catalog/offerings",
  verifyAuth, verifyRoles([1]), requirePermission('services.offering.create'),
  ctrl.createOffering
);

// Cross-offering specific-services list (no path param — must be before /:serviceOptionId)
router.get(
  "/admin/provider-catalog/specific-services",
  verifyAuth, verifyRoles([1]), requirePermission('services.view'),
  ctrl.listAllSpecificServicesAdmin
);

// Distinct filter values for the Services Management filter bar.
// MUST stay above /specific-services/:serviceOptionId — otherwise Express matches
// "filter-options" as the id param and the handler 400s on a NaN id.
router.get(
  "/admin/provider-catalog/specific-services/filter-options",
  verifyAuth, verifyRoles([1]), requirePermission('services.view'),
  ctrl.getSpecificServiceFilterOptions
);

// Specific-service routes BEFORE :offeringId to avoid route shadowing
router.get(
  "/admin/provider-catalog/specific-services/:serviceOptionId",
  verifyAuth, verifyRoles([1]), requirePermission('services.details.view'),
  ctrl.getSpecificService
);
router.post(
  "/admin/provider-catalog/specific-services/:serviceOptionId/banner",
  verifyAuth, verifyRoles([1]), requirePermission('services.specific.edit'),
  ctrl.setSpecificServiceBanner
);
router.delete(
  "/admin/provider-catalog/specific-services/:serviceOptionId/banner",
  verifyAuth, verifyRoles([1]), requirePermission('services.specific.edit'),
  ctrl.removeSpecificServiceBanner
);
router.patch(
  "/admin/provider-catalog/specific-services/:serviceOptionId",
  verifyAuth, verifyRoles([1]), requirePermission('services.specific.edit'),
  ctrl.updateSpecificService
);
router.patch(
  "/admin/provider-catalog/specific-services/:serviceOptionId/status",
  verifyAuth, verifyRoles([1]), requirePermission('services.specific.archive'),
  ctrl.updateSpecificServiceStatus
);
router.post(
  "/admin/provider-catalog/specific-services/:serviceOptionId/addons",
  verifyAuth, verifyRoles([1]), requirePermission('services.addon.create'),
  ctrl.createAddon
);

// Add-on routes (no :offeringId param)
router.patch(
  "/admin/provider-catalog/addons/:addonOptionId",
  verifyAuth, verifyRoles([1]), requirePermission('services.addon.edit'),
  ctrl.updateAddon
);
router.patch(
  "/admin/provider-catalog/addons/:addonOptionId/status",
  verifyAuth, verifyRoles([1]), requirePermission('services.addon.archive'),
  ctrl.updateAddonStatus
);

// Service family lookup for the wizard's mapping step
router.get(
  "/admin/provider-catalog/service-families",
  verifyAuth, verifyRoles([1]), requirePermission('services.view'),
  ctrl.listServiceFamilies
);
router.get(
  "/admin/provider-catalog/policy-dimensions",
  verifyAuth, verifyRoles([1]), requirePermission('services.view'),
  ctrl.getPolicyDimensions
);

// Overview + Audit (no :offeringId — must be before /offerings/:offeringId to avoid shadowing)
router.get(
  "/admin/provider-catalog/overview",
  verifyAuth, verifyRoles([1]), requirePermission('services.view'),
  ctrl.getCatalogOverview
);
router.get(
  "/admin/provider-catalog/audit",
  verifyAuth, verifyRoles([1]), requirePermission('services.view'),
  ctrl.getCatalogAuditTrail
);

// Mapping routes (no :offeringId segment on PATCH/DELETE)
router.patch(
  "/admin/provider-catalog/mappings/:mappingId",
  verifyAuth, verifyRoles([1]), requirePermission('services.mapping.edit'),
  ctrl.updateOfferingMapping
);
router.delete(
  "/admin/provider-catalog/mappings/:mappingId",
  verifyAuth, verifyRoles([1]), requirePermission('services.mapping.archive'),
  ctrl.archiveOfferingMapping
);

// Offering routes with :offeringId (must be after /specific-services/* to avoid shadowing)
router.get(
  "/admin/provider-catalog/offerings/:offeringId",
  verifyAuth, verifyRoles([1]), requirePermission('services.details.view'),
  ctrl.getOffering
);
router.patch(
  "/admin/provider-catalog/offerings/:offeringId",
  verifyAuth, verifyRoles([1]), requirePermission('services.offering.edit'),
  ctrl.updateOffering
);
router.put(
  "/admin/provider-catalog/offerings/:offeringId/policy",
  verifyAuth, verifyRoles([1]), requirePermission('services.offering.edit'),
  ctrl.saveOfferingPolicy
);
router.patch(
  "/admin/provider-catalog/offerings/:offeringId/status",
  verifyAuth, verifyRoles([1]), requirePermission('services.offering.archive'),
  ctrl.updateOfferingStatus
);
router.post(
  "/admin/provider-catalog/offerings/:offeringId/mappings",
  verifyAuth, verifyRoles([1]), requirePermission('services.mapping.create'),
  ctrl.createOfferingMapping
);
router.post(
  "/admin/provider-catalog/offerings/:offeringId/publish-preview",
  verifyAuth, verifyRoles([1]), requirePermission('services.compatibility_preview.run'),
  ctrl.publishPreviewOffering
);
router.post(
  "/admin/provider-catalog/offerings/:offeringId/publish",
  verifyAuth, verifyRoles([1]), requirePermission('services.publish'),
  ctrl.publishOffering
);
router.get(
  "/admin/provider-catalog/offerings/:offeringId/providers",
  verifyAuth, verifyRoles([1]), requirePermission('services.details.view'),
  ctrl.getOfferingProviders
);
router.get(
  "/admin/provider-catalog/offerings/:offeringId/specific-services",
  verifyAuth, verifyRoles([1]), requirePermission('services.details.view'),
  ctrl.listSpecificServices
);
router.post(
  "/admin/provider-catalog/offerings/:offeringId/specific-services",
  verifyAuth, verifyRoles([1]), requirePermission('services.specific.create'),
  ctrl.createSpecificService
);

export default router;
