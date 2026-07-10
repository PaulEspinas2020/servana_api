import { Request, Response } from "express";
import * as svc from "../services/providerCatalogService";

// ─── Provider-facing read ─────────────────────────────────────────────────────

// GET /provider-catalog/v1/offerings
// Requires: verifyAuth (authenticated provider)
// Returns: active, provider-web-visible offerings with specific services + legacy mappings
export const getOfferingsForProvider = async (req: Request, res: Response) => {
  try {
    const data = await svc.getOfferingsForProvider();
    return res.status(200).json({ status: "success", data });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: error?.message ?? "Server error" });
  }
};

// ─── Admin — Offerings ────────────────────────────────────────────────────────

// GET /admin/provider-catalog/offerings
export const listOfferings = async (req: Request, res: Response) => {
  try {
    const data = await svc.listAdminOfferings();
    return res.status(200).json({ status: "success", data });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: error?.message ?? "Server error" });
  }
};

// POST /admin/provider-catalog/offerings
export const createOffering = async (req: Request, res: Response) => {
  try {
    const adminUid = (req as any).user?.uid ?? "system";
    const data = await svc.createOffering(req.body, adminUid);
    return res.status(201).json({ status: "success", data });
  } catch (error: any) {
    const is409 = error.code === "23505"; // unique violation
    return res.status(is409 ? 409 : 400).json({ status: "failed", message: error?.message ?? "Bad request" });
  }
};

// GET /admin/provider-catalog/offerings/:offeringId
export const getOffering = async (req: Request, res: Response) => {
  try {
    const offeringId = Number(req.params.offeringId);
    if (!offeringId) return res.status(400).json({ status: "failed", message: "Invalid offeringId" });
    const data = await svc.getAdminOffering(offeringId);
    if (!data) return res.status(404).json({ status: "failed", message: "Offering not found" });
    return res.status(200).json({ status: "success", data });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: error?.message ?? "Server error" });
  }
};

// PATCH /admin/provider-catalog/offerings/:offeringId
export const updateOffering = async (req: Request, res: Response) => {
  try {
    const offeringId = Number(req.params.offeringId);
    const adminUid = (req as any).user?.uid ?? "system";
    const { version } = req.body;
    if (version == null) return res.status(400).json({ status: "failed", message: "version is required for optimistic concurrency" });
    const data = await svc.updateOffering(offeringId, { ...req.body, version: Number(version) }, adminUid);
    return res.status(200).json({ status: "success", data });
  } catch (error: any) {
    if (error.code === "CONFLICT") return res.status(409).json({ status: "failed", message: error.message });
    return res.status(400).json({ status: "failed", message: error?.message ?? "Bad request" });
  }
};

// PATCH /admin/provider-catalog/offerings/:offeringId/status
export const updateOfferingStatus = async (req: Request, res: Response) => {
  try {
    const offeringId = Number(req.params.offeringId);
    const adminUid = (req as any).user?.uid ?? "system";
    const { status: newStatus } = req.body;
    if (!newStatus) return res.status(400).json({ status: "failed", message: "status is required" });
    const data = await svc.updateOfferingStatus(offeringId, newStatus, adminUid);
    return res.status(200).json({ status: "success", data });
  } catch (error: any) {
    return res.status(400).json({ status: "failed", message: error?.message ?? "Bad request" });
  }
};

// ─── Admin — Specific Services ────────────────────────────────────────────────

// GET /admin/provider-catalog/offerings/:offeringId/specific-services
export const listSpecificServices = async (req: Request, res: Response) => {
  try {
    const offeringId = Number(req.params.offeringId);
    const data = await svc.listSpecificServicesForOffering(offeringId);
    return res.status(200).json({ status: "success", data });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: error?.message ?? "Server error" });
  }
};

// POST /admin/provider-catalog/offerings/:offeringId/specific-services
export const createSpecificService = async (req: Request, res: Response) => {
  try {
    const offeringId = Number(req.params.offeringId);
    const adminUid = (req as any).user?.uid ?? "system";
    const body = req.body;
    const data = await svc.createSpecificService(
      offeringId,
      {
        level2: body.level2,
        level3: body.level3 ?? body.name,
        description: body.description,
        unit: body.unit,
        basePrice: Number(body.basePrice ?? body.base_price ?? 0),
        inclusions: body.inclusions ?? [],
        exclusions: body.exclusions ?? [],
      },
      adminUid
    );
    return res.status(201).json({ status: "success", data });
  } catch (error: any) {
    return res.status(400).json({ status: "failed", message: error?.message ?? "Bad request" });
  }
};

// GET /admin/provider-catalog/specific-services/:serviceOptionId
export const getSpecificService = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.serviceOptionId);
    const data = await svc.getAdminSpecificService(id);
    if (!data) return res.status(404).json({ status: "failed", message: "Specific service not found" });
    return res.status(200).json({ status: "success", data });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: error?.message ?? "Server error" });
  }
};

// PATCH /admin/provider-catalog/specific-services/:serviceOptionId
export const updateSpecificService = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.serviceOptionId);
    const adminUid = (req as any).user?.uid ?? "system";
    const body = req.body;
    const data = await svc.updateSpecificService(
      id,
      {
        level3: body.level3 ?? body.name,
        description: body.description,
        unit: body.unit,
        basePrice: body.basePrice != null ? Number(body.basePrice) : undefined,
        inclusions: body.inclusions,
        exclusions: body.exclusions,
      },
      adminUid
    );
    return res.status(200).json({ status: "success", data });
  } catch (error: any) {
    return res.status(400).json({ status: "failed", message: error?.message ?? "Bad request" });
  }
};

// PATCH /admin/provider-catalog/specific-services/:serviceOptionId/status
export const updateSpecificServiceStatus = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.serviceOptionId);
    const isActive = req.body.isActive === true || req.body.isActive === "true";
    const data = await svc.updateSpecificServiceStatus(id, isActive);
    return res.status(200).json({ status: "success", data });
  } catch (error: any) {
    return res.status(400).json({ status: "failed", message: error?.message ?? "Bad request" });
  }
};

// ─── Admin — Add-ons ──────────────────────────────────────────────────────────

// POST /admin/provider-catalog/specific-services/:serviceOptionId/addons
export const createAddon = async (req: Request, res: Response) => {
  try {
    const parentId = Number(req.params.serviceOptionId);
    const adminUid = (req as any).user?.uid ?? "system";
    const body = req.body;
    const data = await svc.createAddon(
      parentId,
      {
        level3: body.level3 ?? body.name,
        unit: body.unit,
        basePrice: Number(body.basePrice ?? body.base_price ?? 0),
      },
      adminUid
    );
    return res.status(201).json({ status: "success", data });
  } catch (error: any) {
    return res.status(400).json({ status: "failed", message: error?.message ?? "Bad request" });
  }
};

// PATCH /admin/provider-catalog/addons/:addonOptionId
export const updateAddon = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.addonOptionId);
    const adminUid = (req as any).user?.uid ?? "system";
    const body = req.body;
    const data = await svc.updateAddon(
      id,
      {
        level3: body.level3 ?? body.name,
        unit: body.unit,
        basePrice: body.basePrice != null ? Number(body.basePrice) : undefined,
      },
      adminUid
    );
    return res.status(200).json({ status: "success", data });
  } catch (error: any) {
    return res.status(400).json({ status: "failed", message: error?.message ?? "Bad request" });
  }
};

// PATCH /admin/provider-catalog/addons/:addonOptionId/status
export const updateAddonStatus = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.addonOptionId);
    const isActive = req.body.isActive === true || req.body.isActive === "true";
    const data = await svc.updateAddonStatus(id, isActive);
    return res.status(200).json({ status: "success", data });
  } catch (error: any) {
    return res.status(400).json({ status: "failed", message: error?.message ?? "Bad request" });
  }
};

// ─── Admin — Catalog Overview ─────────────────────────────────────────────────

// GET /admin/provider-catalog/overview
export const getCatalogOverview = async (req: Request, res: Response) => {
  try {
    const { search, status, mobileProtected } = req.query as Record<string, string>;
    const filter: any = {};
    if (search) filter.search = search;
    if (status) filter.status = status;
    if (mobileProtected !== undefined) filter.mobileProtected = mobileProtected === "true";
    const data = await svc.getAdminCatalogOverview(filter);
    return res.status(200).json({ status: "success", data });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: error?.message ?? "Server error" });
  }
};

// ─── Admin — Mappings CRUD ────────────────────────────────────────────────────

// POST /admin/provider-catalog/offerings/:offeringId/mappings
export const createMapping = async (req: Request, res: Response) => {
  try {
    const offeringId = Number(req.params.offeringId);
    if (!offeringId) return res.status(400).json({ status: "failed", message: "Invalid offeringId" });
    const adminUid = (req as any).user?.uid ?? "system";
    const { serviceId, level2, displayOrder } = req.body;
    if (!serviceId || !level2) {
      return res.status(400).json({ status: "failed", message: "serviceId and level2 are required" });
    }
    const data = await svc.createMapping(offeringId, { serviceId: Number(serviceId), level2, displayOrder }, adminUid);
    return res.status(201).json({ status: "success", data });
  } catch (error: any) {
    return res.status(400).json({ status: "failed", message: error?.message ?? "Bad request" });
  }
};

// PATCH /admin/provider-catalog/mappings/:mappingId
export const updateMapping = async (req: Request, res: Response) => {
  try {
    const mappingId = Number(req.params.mappingId);
    if (!mappingId) return res.status(400).json({ status: "failed", message: "Invalid mappingId" });
    const adminUid = (req as any).user?.uid ?? "system";
    const data = await svc.updateMapping(mappingId, req.body, adminUid);
    return res.status(200).json({ status: "success", data });
  } catch (error: any) {
    return res.status(400).json({ status: "failed", message: error?.message ?? "Bad request" });
  }
};

// DELETE /admin/provider-catalog/mappings/:mappingId
export const archiveMapping = async (req: Request, res: Response) => {
  try {
    const mappingId = Number(req.params.mappingId);
    if (!mappingId) return res.status(400).json({ status: "failed", message: "Invalid mappingId" });
    const adminUid = (req as any).user?.uid ?? "system";
    const data = await svc.archiveMapping(mappingId, adminUid);
    return res.status(200).json({ status: "success", data });
  } catch (error: any) {
    return res.status(400).json({ status: "failed", message: error?.message ?? "Bad request" });
  }
};

// ─── Admin — Publish ──────────────────────────────────────────────────────────

// POST /admin/provider-catalog/offerings/:offeringId/publish-preview
export const publishPreview = async (req: Request, res: Response) => {
  try {
    const offeringId = Number(req.params.offeringId);
    if (!offeringId) return res.status(400).json({ status: "failed", message: "Invalid offeringId" });
    const data = await svc.runPublishPreview(offeringId);
    return res.status(200).json({ status: "success", data });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: error?.message ?? "Server error" });
  }
};

// POST /admin/provider-catalog/offerings/:offeringId/publish
export const publish = async (req: Request, res: Response) => {
  try {
    const offeringId = Number(req.params.offeringId);
    if (!offeringId) return res.status(400).json({ status: "failed", message: "Invalid offeringId" });
    const adminUid = (req as any).user?.uid ?? "system";
    const data = await svc.publishOffering(offeringId, adminUid);
    return res.status(200).json({ status: "success", data });
  } catch (error: any) {
    if (error?.code === "PUBLISH_BLOCKED") {
      return res.status(422).json({ status: "failed", message: error.message, blockers: error.blockers });
    }
    return res.status(400).json({ status: "failed", message: error?.message ?? "Bad request" });
  }
};

// ─── Admin — Audit Trail ──────────────────────────────────────────────────────

// GET /admin/provider-catalog/audit
export const getAudit = async (req: Request, res: Response) => {
  try {
    const { entityType, entityId, limit, offset } = req.query as Record<string, string>;
    const data = await svc.getAuditTrail({
      entityType: entityType || undefined,
      entityId: entityId || undefined,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
    return res.status(200).json({ status: "success", data });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: error?.message ?? "Server error" });
  }
};
