/**
 * Canonical Admin Catalog routes — Category → Subcategory → Service.
 *
 * Mounted under /api, so the public paths are /api/admin/catalog/*.
 *
 * These are the endpoints the redesigned Admin consumes. They are deliberately
 * NOT the `/api/services*` family, which remains a LEGACY_PROVIDER_COMPATIBILITY
 * projection over `service_families` + `service_options` for live provider and
 * customer clients (§18, §19). Nothing here changes those responses.
 *
 * Permissions reuse the existing `services.*` keys rather than introducing new
 * ones. New keys would be unheld by the three regular admins in production and
 * would 403 them out of the catalog on day one; the existing grants already
 * express exactly these capabilities.
 */

import { Router } from "express";
import verifyAuth from "../middleware/verifyAuth";
import verifyRoles from "../middleware/verifyRoles";
import { adminRateLimit } from '../middleware/adminRateLimit';
import { requirePermission } from "../middleware/requirePermission";
import * as ctrl from "../controllers/catalogAdminController";

const router = Router();

const adminOnly = [verifyAuth, verifyRoles([1]), adminRateLimit] as const;

// ── Hierarchy read ───────────────────────────────────────────────────────────

router.get("/admin/catalog",
  ...adminOnly, requirePermission('services.view'), ctrl.getCatalog);

router.get("/admin/catalog/summary",
  ...adminOnly, requirePermission('services.view'), ctrl.getSummary);

router.get("/admin/catalog/content-gaps",
  ...adminOnly, requirePermission('services.view'), ctrl.getContentGaps);

// ── Categories ───────────────────────────────────────────────────────────────
// `/reorder` is registered before `/:categoryId`. Express matches in
// declaration order, so the reverse would bind "reorder" as the id and 400 on a
// NaN — the same trap `filter-options` hit on the legacy catalog routes.

router.get("/admin/catalog/categories",
  ...adminOnly, requirePermission('services.view'), ctrl.listCategories);

router.post("/admin/catalog/categories",
  ...adminOnly, requirePermission('services.offering.create'), ctrl.createCategory);

router.post("/admin/catalog/categories/reorder",
  ...adminOnly, requirePermission('services.offering.edit'), ctrl.reorderCategories);

router.patch("/admin/catalog/categories/:categoryId/status",
  ...adminOnly, requirePermission('services.offering.archive'), ctrl.setCategoryStatus);

router.patch("/admin/catalog/categories/:categoryId",
  ...adminOnly, requirePermission('services.offering.edit'), ctrl.updateCategory);

// ── Subcategories ────────────────────────────────────────────────────────────

router.get("/admin/catalog/subcategories",
  ...adminOnly, requirePermission('services.view'), ctrl.listSubcategories);

router.post("/admin/catalog/subcategories",
  ...adminOnly, requirePermission('services.offering.create'), ctrl.createSubcategory);

router.post("/admin/catalog/subcategories/reorder",
  ...adminOnly, requirePermission('services.offering.edit'), ctrl.reorderSubcategories);

router.patch("/admin/catalog/subcategories/:subcategoryId/status",
  ...adminOnly, requirePermission('services.offering.archive'), ctrl.setSubcategoryStatus);

// Move is an ordinary PATCH with a new categoryId — placement changes, identity
// does not, so it needs no separate verb or route (§11).
router.patch("/admin/catalog/subcategories/:subcategoryId",
  ...adminOnly, requirePermission('services.offering.edit'), ctrl.updateSubcategory);

// ── Services ─────────────────────────────────────────────────────────────────

router.get("/admin/catalog/services",
  ...adminOnly, requirePermission('services.view'), ctrl.listServices);

router.post("/admin/catalog/services",
  ...adminOnly, requirePermission('services.specific.create'), ctrl.createService);

router.post("/admin/catalog/services/reorder",
  ...adminOnly, requirePermission('services.specific.edit'), ctrl.reorderServices);

router.get("/admin/catalog/services/:serviceId/providers",
  ...adminOnly, requirePermission('services.details.view'), ctrl.getServiceProviders);

// Archive lives here. There is no destructive counterpart on this router by
// design — ordinary catalog management archives, it never hard-deletes (§48).
router.patch("/admin/catalog/services/:serviceId/status",
  ...adminOnly, requirePermission('services.specific.archive'), ctrl.setServiceStatus);

router.get("/admin/catalog/services/:serviceId",
  ...adminOnly, requirePermission('services.details.view'), ctrl.getService);

router.patch("/admin/catalog/services/:serviceId",
  ...adminOnly, requirePermission('services.specific.edit'), ctrl.updateService);

export default router;
