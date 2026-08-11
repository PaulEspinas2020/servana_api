/**
 * v1 catalog handlers.
 *
 * Thin by design. Every one of these calls exactly the domain service the
 * legacy `/api/catalog/*` router calls, so the two paths cannot return
 * different catalogs. What v1 adds is the envelope and nothing else.
 */

import { Request, Response } from 'express';
import * as svc from '../../../services/catalogPublicService';
import { ok, sendCaught } from '../envelope';
import { ApiError } from '../errors';
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
};
