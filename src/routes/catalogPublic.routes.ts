/**
 * Canonical PUBLIC Catalog routes — mounted at `/api`, so every path below is
 * prefixed `/api`.
 *
 * Unauthenticated by design and consistent with the catalog reads that already
 * exist on `/api/services*`: the catalog is public product information, and
 * gating it would only mean an unauthenticated customer could not browse before
 * signing up. Nothing personal, provider-identifying or admin-only is projected
 * — see the exclusion list in `catalogPublicService`.
 *
 * READ ONLY. Every mutation lives on `/api/admin/catalog/*` behind
 * `verifyAuth → verifyRoles([1]) → requirePermission`. A write handler must
 * never be added here; §12 is not satisfiable on an unauthenticated route.
 *
 * Route ordering is load-bearing: `/catalog/services` is declared before
 * `/catalog/services/:serviceId` is reached, and `/catalog/summary` before any
 * parameterised sibling, or Express binds the literal as an id and the handler
 * 400s on `NaN`. This is the same trap `filter-options` hit on the legacy
 * catalog routes and `/reorder` hit on the admin router.
 */

import express from "express";
import * as catalogPublicController from "../controllers/catalogPublicController";

const router = express.Router();

router.get("/catalog", catalogPublicController.getCatalog);
router.get("/catalog/summary", catalogPublicController.getSummary);
router.get("/catalog/services", catalogPublicController.listServices);
// Declared before the parameterised sibling below, for the same reason the
// header gives: Express binds the first match, and a literal segment reached
// after `:serviceId` never runs.
router.get(
  "/catalog/services/:serviceId/serviceability",
  catalogPublicController.getServiceability,
);
router.get(
  "/catalog/services/:serviceId",
  catalogPublicController.getService,
);

export default router;
