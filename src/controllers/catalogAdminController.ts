/**
 * Canonical Admin Catalog controller — Category → Subcategory → Service.
 *
 * Thin: validation of shape and identity lives here, business rules live in
 * `catalogAdminService`. Every handler surfaces a safe domain error and never a
 * driver message (§21).
 */

import { Request, Response } from "express";
import * as svc from "../services/catalogAdminService";

const isPositiveId = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

const invalidId = (res: Response, name: string) =>
  res.status(400).json({ status: "failed", message: `Invalid ${name}` });

/**
 * Domain errors carry `statusCode`; anything else is an unexpected fault and
 * becomes a 500 with a generic message. Without this, a validation failure
 * raised in the service layer would reach the admin as a 500 and read as an
 * outage rather than as "that name is already taken".
 */
const failure = (res: Response, error: any) => {
  const status = Number(error?.statusCode);
  if (Number.isSafeInteger(status) && status >= 400 && status < 500) {
    return res.status(status).json({
      status: "failed",
      message: error?.message ?? "Request rejected",
      ...(error?.code ? { code: error.code } : {}),
    });
  }
  return res.status(500).json({ status: "failed", message: "Server error" });
};

/** Admin actor for audit. Never a provider or customer uid (§6, §7). */
const actor = (req: Request): string => req.user?.uid ?? "unknown-admin";

const asBool = (v: unknown): boolean | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  if (v === true || v === 'true')  return true;
  if (v === false || v === 'false') return false;
  return undefined;
};

const asId = (v: unknown): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return isPositiveId(n) ? n : undefined;
};

// ─── Hierarchy + summary ─────────────────────────────────────────────────────

// GET /admin/catalog
export const getCatalog = async (req: Request, res: Response) => {
  try {
    const includeArchived = asBool(req.query.includeArchived) ?? false;
    const [categories, summary] = await Promise.all([
      svc.getCatalogHierarchy({ includeArchived }),
      svc.getCatalogSummary(),
    ]);
    return res.status(200).json({ status: "success", data: { categories, summary } });
  } catch (error) { return failure(res, error); }
};

// GET /admin/catalog/summary
export const getSummary = async (_req: Request, res: Response) => {
  try {
    return res.status(200).json({ status: "success", data: await svc.getCatalogSummary() });
  } catch (error) { return failure(res, error); }
};

// GET /admin/catalog/content-gaps
export const getContentGaps = async (_req: Request, res: Response) => {
  try {
    return res.status(200).json({ status: "success", data: await svc.getCatalogContentGaps() });
  } catch (error) { return failure(res, error); }
};

// ─── Categories ──────────────────────────────────────────────────────────────

// GET /admin/catalog/categories
export const listCategories = async (req: Request, res: Response) => {
  try {
    const data = await svc.listCategories(asBool(req.query.includeArchived) ?? false);
    return res.status(200).json({ status: "success", data });
  } catch (error) { return failure(res, error); }
};

// POST /admin/catalog/categories
export const createCategory = async (req: Request, res: Response) => {
  try {
    const data = await svc.createCategory(req.body ?? {}, actor(req));
    return res.status(201).json({ status: "success", data });
  } catch (error) { return failure(res, error); }
};

// PATCH /admin/catalog/categories/:categoryId
export const updateCategory = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.categoryId);
    if (!isPositiveId(id)) return invalidId(res, "categoryId");
    const data = await svc.updateCategory(id, req.body ?? {}, actor(req));
    return res.status(200).json({ status: "success", data });
  } catch (error) { return failure(res, error); }
};

// PATCH /admin/catalog/categories/:categoryId/status
export const setCategoryStatus = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.categoryId);
    if (!isPositiveId(id)) return invalidId(res, "categoryId");
    const data = await svc.updateCategory(id, { status: req.body?.status }, actor(req));
    return res.status(200).json({ status: "success", data });
  } catch (error) { return failure(res, error); }
};

// POST /admin/catalog/categories/reorder
export const reorderCategories = async (req: Request, res: Response) => {
  try {
    const data = await svc.reorder('category', req.body?.items, actor(req));
    return res.status(200).json({ status: "success", data });
  } catch (error) { return failure(res, error); }
};

// ─── Subcategories ───────────────────────────────────────────────────────────

// GET /admin/catalog/subcategories
export const listSubcategories = async (req: Request, res: Response) => {
  try {
    const data = await svc.listSubcategories(
      asId(req.query.categoryId),
      asBool(req.query.includeArchived) ?? false,
    );
    return res.status(200).json({ status: "success", data });
  } catch (error) { return failure(res, error); }
};

// POST /admin/catalog/subcategories
export const createSubcategory = async (req: Request, res: Response) => {
  try {
    const data = await svc.createSubcategory(req.body ?? {}, actor(req));
    return res.status(201).json({ status: "success", data });
  } catch (error) { return failure(res, error); }
};

// PATCH /admin/catalog/subcategories/:subcategoryId  — update, or MOVE when categoryId changes
export const updateSubcategory = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.subcategoryId);
    if (!isPositiveId(id)) return invalidId(res, "subcategoryId");
    const data = await svc.updateSubcategory(id, req.body ?? {}, actor(req));
    return res.status(200).json({ status: "success", data });
  } catch (error) { return failure(res, error); }
};

// PATCH /admin/catalog/subcategories/:subcategoryId/status
export const setSubcategoryStatus = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.subcategoryId);
    if (!isPositiveId(id)) return invalidId(res, "subcategoryId");
    const data = await svc.updateSubcategory(id, { status: req.body?.status }, actor(req));
    return res.status(200).json({ status: "success", data });
  } catch (error) { return failure(res, error); }
};

// POST /admin/catalog/subcategories/reorder
export const reorderSubcategories = async (req: Request, res: Response) => {
  try {
    const data = await svc.reorder('subcategory', req.body?.items, actor(req));
    return res.status(200).json({ status: "success", data });
  } catch (error) { return failure(res, error); }
};

// ─── Services ────────────────────────────────────────────────────────────────

// GET /admin/catalog/services
export const listServices = async (req: Request, res: Response) => {
  try {
    const q = req.query;
    const data = await svc.listServices({
      search: typeof q.search === 'string' ? q.search : undefined,
      categoryId: asId(q.categoryId),
      subcategoryId: asId(q.subcategoryId),
      status: typeof q.status === 'string' ? (q.status as svc.CatalogStatus) : undefined,
      bookable: asBool(q.bookable),
      coverage: q.coverage === 'with_providers' || q.coverage === 'without_providers' ? q.coverage : undefined,
      includeArchived: asBool(q.includeArchived) ?? false,
      sortBy: typeof q.sortBy === 'string' ? (q.sortBy as any) : undefined,
      sortOrder: q.sortOrder === 'desc' ? 'desc' : 'asc',
      page: Number(q.page) || undefined,
      limit: Number(q.limit) || undefined,
    });
    return res.status(200).json({ status: "success", data });
  } catch (error) { return failure(res, error); }
};

// POST /admin/catalog/services
// The body must NOT carry an id — services.id comes from the sequence (§14).
export const createService = async (req: Request, res: Response) => {
  try {
    const body = { ...(req.body ?? {}) };
    if (body.id !== undefined) {
      return res.status(400).json({
        status: "failed",
        message: "A Service id is assigned by the server and must not be supplied",
        code: "CLIENT_SUPPLIED_ID",
      });
    }
    const data = await svc.createService(body, actor(req));
    return res.status(201).json({ status: "success", data });
  } catch (error) { return failure(res, error); }
};

// GET /admin/catalog/services/:serviceId
export const getService = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.serviceId);
    if (!isPositiveId(id)) return invalidId(res, "serviceId");
    return res.status(200).json({ status: "success", data: await svc.getService(id) });
  } catch (error) { return failure(res, error); }
};

// PATCH /admin/catalog/services/:serviceId — update, or MOVE when subcategoryId changes
export const updateService = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.serviceId);
    if (!isPositiveId(id)) return invalidId(res, "serviceId");
    const data = await svc.updateService(id, req.body ?? {}, actor(req));
    return res.status(200).json({ status: "success", data });
  } catch (error) { return failure(res, error); }
};

// PATCH /admin/catalog/services/:serviceId/status — activate / deactivate / archive
export const setServiceStatus = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.serviceId);
    if (!isPositiveId(id)) return invalidId(res, "serviceId");
    const data = await svc.setServiceStatus(id, req.body?.status, actor(req));
    return res.status(200).json({ status: "success", data });
  } catch (error) { return failure(res, error); }
};

// GET /admin/catalog/services/:serviceId/providers
export const getServiceProviders = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.serviceId);
    if (!isPositiveId(id)) return invalidId(res, "serviceId");
    return res.status(200).json({ status: "success", data: await svc.getServiceProviders(id) });
  } catch (error) { return failure(res, error); }
};

// POST /admin/catalog/services/reorder
export const reorderServices = async (req: Request, res: Response) => {
  try {
    const data = await svc.reorder('service', req.body?.items, actor(req));
    return res.status(200).json({ status: "success", data });
  } catch (error) { return failure(res, error); }
};
