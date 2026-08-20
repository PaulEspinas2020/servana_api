/**
 * Canonical PUBLIC Catalog controller — Category → Subcategory → Service.
 *
 * Read-only and unauthenticated, matching the existing public catalog reads on
 * `/api/services*`. There is no write handler in this file and no route file
 * may add one: mutation belongs to the Admin router, behind
 * `verifyAuth → verifyRoles([1]) → requirePermission` (§12).
 *
 * Errors are safe domain messages. A driver message, constraint name or stack
 * never reaches a customer (§21).
 */

import { Request, Response } from "express";
import * as svc from "../services/catalogPublicService";

const isPositiveId = (value: number): boolean =>
  Number.isSafeInteger(value) && value > 0;

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

/**
 * Catalog freshness for the client's cache (§48).
 *
 * The catalog is small, public and changes only when an admin edits it, so a
 * short shared cache plus a validator is the right shape: an unchanged catalog
 * costs a 304 and no body. `lastUpdatedAt` comes from `MAX(services.updated_at)`
 * — an admin edit moves it, which is precisely the event the client must not
 * miss.
 *
 * The ETag is weak because two responses with the same `lastUpdatedAt` are
 * semantically equivalent but not guaranteed byte-identical (price formatting
 * is locale-driven).
 */
const applyFreshness = (res: Response, lastUpdatedAt: string | null) => {
  res.set("Cache-Control", "public, max-age=300");
  if (lastUpdatedAt) res.set("ETag", `W/"catalog-${lastUpdatedAt}"`);
};

const notModified = (req: Request, lastUpdatedAt: string | null): boolean => {
  if (!lastUpdatedAt) return false;
  const sent = req.get("If-None-Match");
  return !!sent && sent.includes(`catalog-${lastUpdatedAt}`);
};

// GET /catalog
export const getCatalog = async (req: Request, res: Response) => {
  try {
    const summary = await svc.getPublicCatalogSummary();
    applyFreshness(res, summary.lastUpdatedAt);
    if (notModified(req, summary.lastUpdatedAt)) return res.status(304).end();

    const categories = await svc.getPublicCatalog();
    return res.json({ status: "success", data: { categories, summary } });
  } catch (error) {
    return failure(res, error);
  }
};

// GET /catalog/summary
export const getSummary = async (_req: Request, res: Response) => {
  try {
    const summary = await svc.getPublicCatalogSummary();
    return res.json({ status: "success", data: summary });
  } catch (error) {
    return failure(res, error);
  }
};

// GET /catalog/services
export const listServices = async (req: Request, res: Response) => {
  try {
    const summary = await svc.getPublicCatalogSummary();
    applyFreshness(res, summary.lastUpdatedAt);
    if (notModified(req, summary.lastUpdatedAt)) return res.status(304).end();

    const services = await svc.listPublicServices();
    return res.json({ status: "success", data: { services, summary } });
  } catch (error) {
    return failure(res, error);
  }
};

// GET /catalog/services/:serviceId
export const getService = async (req: Request, res: Response) => {
  try {
    const serviceId = Number(req.params.serviceId);
    if (!isPositiveId(serviceId)) {
      return res
        .status(400)
        .json({ status: "failed", message: "Invalid serviceId" });
    }
    const service = await svc.getServiceDetail(serviceId);
    return res.json({ status: "success", data: service });
  } catch (error) {
    return failure(res, error);
  }
};

// GET /catalog/services/:serviceId/serviceability?lat=&lon=
//
// The verdict `createBooking` would reach, offered BEFORE the customer fills in
// a form instead of after they submit one. Same family resolution, same
// coverage test — see `serviceabilityService`.
//
// Public, like the rest of this router and like the `/api/services/:id/
// coverage-geo` it supersedes for canonical services. It answers strictly less
// than that route does: a yes or no, never the discs, never the legacy id.
export const getServiceability = async (req: Request, res: Response) => {
  try {
    const serviceId = Number(req.params.serviceId);
    if (!isPositiveId(serviceId)) {
      return res
        .status(400)
        .json({ status: "failed", message: "Invalid serviceId" });
    }

    // Parsed, not trusted. An absent or unparseable coordinate is answered
    // INVALID_LOCATION by the service rather than defaulted to somewhere.
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);

    const result = await svc.getServiceability(serviceId, lat, lon);
    return res.json({ status: "success", data: result });
  } catch (error) {
    return failure(res, error);
  }
};
