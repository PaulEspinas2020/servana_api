/**
 * v1 catalog handlers.
 *
 * Thin by design. Every one of these calls exactly the domain service the
 * legacy `/api/catalog/*` router calls, so the two paths cannot return
 * different catalogs. What v1 adds is the envelope and nothing else.
 */

import { Request, Response } from 'express';
import * as svc from '../../../services/catalogPublicService';
import { searchCatalog, type SearchEntityType } from '../../../services/catalogSearchService';
import { ok, sendCaught } from '../envelope';
import { ApiError, type V1ErrorCode } from '../errors';
import { V1Handlers } from '../types';

/**
 * Catalog freshness, carried over from the legacy controller.
 *
 * The catalog is small, public and only changes when an admin edits it, so a
 * short shared cache plus a validator is the right shape. `lastUpdatedAt` is
 * `MAX(services.updated_at)` — an admin edit moves it, which is exactly the
 * event a client must not miss.
 */
const applyFreshness = (res: Response, lastUpdatedAt: string | null) => {
  res.set('Cache-Control', 'public, max-age=300');
  if (lastUpdatedAt) res.set('ETag', `W/"catalog-${lastUpdatedAt}"`);
};

const notModified = (req: Request, lastUpdatedAt: string | null): boolean => {
  if (!lastUpdatedAt) return false;
  const sent = req.get('If-None-Match');
  return !!sent && sent.includes(`catalog-${lastUpdatedAt}`);
};

/**
 * A positive integer path parameter, or a refusal.
 *
 * Every canonical catalog id is validated the same way and against the same
 * rule, so a client cannot discover that one endpoint tolerates `abc` and
 * another does not.
 */
const readId = (raw: unknown, field: string): number => {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw ApiError.validation(`${field} must be a positive integer.`);
  }
  return id;
};

/**
 * The service layer signals "no such row" by throwing `{ statusCode: 404 }`.
 * Each level maps to its OWN code — a single CATALOG_NOT_FOUND would leave a
 * client unable to tell a missing Subcategory from a missing Service, which are
 * different screens.
 */
const notFoundAs = (error: unknown, code: V1ErrorCode, message: string): unknown =>
  Number((error as any)?.statusCode) === 404 ? new ApiError(code, message) : error;

/** Shared by `/search` and `/catalog/search` — one implementation, two names. */
const runSearch = async (req: Request, res: Response, context: string) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : undefined;

    const VALID: SearchEntityType[] = ['category', 'subcategory', 'service'];
    const types =
      typeof req.query.types === 'string' && req.query.types.trim()
        ? req.query.types
            .split(',')
            .map((t) => t.trim())
            .filter((t): t is SearchEntityType => (VALID as string[]).includes(t))
        : undefined;

    // An unrecognised type is a refusal rather than a silent narrowing: a
    // client asking for `types=provider` and receiving services would conclude
    // providers are searchable.
    if (typeof req.query.types === 'string' && req.query.types.trim() && !types?.length) {
      throw ApiError.validation('types must be a comma-separated list of: category, subcategory, service.');
    }

    const result = await searchCatalog(q, { limit, types });
    return ok(res, req, result);
  } catch (error) {
    return sendCaught(res, req, context, error);
  }
};

export const handlers: V1Handlers = {
  'catalog.browse': async (req, res) => {
    try {
      const summary = await svc.getPublicCatalogSummary();
      applyFreshness(res, summary.lastUpdatedAt);
      if (notModified(req, summary.lastUpdatedAt)) return res.status(304).end();

      const categories = await svc.getPublicCatalog();
      return ok(res, req, { categories }, { summary });
    } catch (error) {
      return sendCaught(res, req, 'catalog.browse', error);
    }
  },

  'catalog.summary': async (req, res) => {
    try {
      const summary = await svc.getPublicCatalogSummary();
      return ok(res, req, summary);
    } catch (error) {
      return sendCaught(res, req, 'catalog.summary', error);
    }
  },

  'catalog.services.list': async (req, res) => {
    try {
      const summary = await svc.getPublicCatalogSummary();
      applyFreshness(res, summary.lastUpdatedAt);
      if (notModified(req, summary.lastUpdatedAt)) return res.status(304).end();

      const services = await svc.listPublicServices();
      return ok(res, req, { services }, { summary });
    } catch (error) {
      return sendCaught(res, req, 'catalog.services.list', error);
    }
  },

  'catalog.services.get': async (req, res) => {
    try {
      const serviceId = Number(req.params.serviceId);
      if (!Number.isSafeInteger(serviceId) || serviceId <= 0) {
        throw ApiError.validation('serviceId must be a positive integer.');
      }
      const service = await svc.getServiceDetail(serviceId);
      return ok(res, req, service);
    } catch (error) {
      // `getServiceDetail` signals "no such service" by throwing an object
      // carrying `statusCode: 404`, not an ApiError. Translate it here rather
      // than changing the service — the legacy `/api/catalog` route calls the
      // same function and reads the same field.
      if (Number((error as any)?.statusCode) === 404) {
        return sendCaught(
          res,
          req,
          'catalog.services.get',
          new ApiError('CATALOG_SERVICE_NOT_FOUND', 'No service with that id.'),
        );
      }
      return sendCaught(res, req, 'catalog.services.get', error);
    }
  },

  // ── Hierarchy navigation ───────────────────────────────────────────────────

  'catalog.categories.list': async (req, res) => {
    try {
      const summary = await svc.getPublicCatalogSummary();
      applyFreshness(res, summary.lastUpdatedAt);
      if (notModified(req, summary.lastUpdatedAt)) return res.status(304).end();

      const categories = await svc.listCategories();
      return ok(res, req, { categories }, { summary });
    } catch (error) {
      return sendCaught(res, req, 'catalog.categories.list', error);
    }
  },

  'catalog.categories.get': async (req, res) => {
    try {
      const categoryId = readId(req.params.categoryId, 'categoryId');
      const category = await svc.getCategory(categoryId);
      return ok(res, req, category);
    } catch (error) {
      return sendCaught(
        res,
        req,
        'catalog.categories.get',
        notFoundAs(error, 'CATALOG_CATEGORY_NOT_FOUND', 'No category with that id.'),
      );
    }
  },

  'catalog.categories.subcategories': async (req, res) => {
    try {
      const categoryId = readId(req.params.categoryId, 'categoryId');
      const subcategories = await svc.listSubcategoriesOfCategory(categoryId);
      return ok(res, req, { subcategories });
    } catch (error) {
      return sendCaught(
        res,
        req,
        'catalog.categories.subcategories',
        notFoundAs(error, 'CATALOG_CATEGORY_NOT_FOUND', 'No category with that id.'),
      );
    }
  },

  'catalog.subcategories.get': async (req, res) => {
    try {
      const subcategoryId = readId(req.params.subcategoryId, 'subcategoryId');
      const subcategory = await svc.getSubcategory(subcategoryId);
      return ok(res, req, subcategory);
    } catch (error) {
      return sendCaught(
        res,
        req,
        'catalog.subcategories.get',
        notFoundAs(error, 'CATALOG_SUBCATEGORY_NOT_FOUND', 'No subcategory with that id.'),
      );
    }
  },

  'catalog.subcategories.services': async (req, res) => {
    try {
      const subcategoryId = readId(req.params.subcategoryId, 'subcategoryId');
      const services = await svc.listServicesOfSubcategory(subcategoryId);
      return ok(res, req, { services });
    } catch (error) {
      return sendCaught(
        res,
        req,
        'catalog.subcategories.services',
        notFoundAs(error, 'CATALOG_SUBCATEGORY_NOT_FOUND', 'No subcategory with that id.'),
      );
    }
  },

  // ── Search ─────────────────────────────────────────────────────────────────
  //
  // Two paths, ONE implementation. The command named both `/api/v1/search` and
  // `/api/v1/catalog/search` as the target, and serving them from two functions
  // would be two search behaviours wearing one name — the exact thing this whole
  // programme exists to remove.

  'search.query': async (req, res) => runSearch(req, res, 'search.query'),
  'catalog.search': async (req, res) => runSearch(req, res, 'catalog.search'),
};
