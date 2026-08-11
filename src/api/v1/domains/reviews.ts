/**
 * v1 public review handlers.
 *
 * Same `customerReviewService` functions as the legacy
 * `/api/providers/:providerUid/reviews` pair. Two things differ, both
 * deliberate:
 *
 *   - paging is clamped. The legacy route does `Number(req.query.offset ?? 0)`
 *     with no guard, so `?offset=-1` reaches pg and answers 500 (BE-10).
 *   - the provider uid is validated as a shape before it reaches a query.
 *
 * The projection itself is untouched, and it is already right: rating, comment
 * and provider response only — no customer identity, and visibility,
 * publication state and moderation state are all filtered server-side (§58).
 */

import { Request, Response } from 'express';
import {
  listProviderReviews,
  getProviderAggregate,
} from '../../../services/customerReviewService';
import { ok, sendCaught, readPage, pageMeta } from '../envelope';
import { ApiError } from '../errors';
import { V1Handlers } from '../types';

/**
 * A Firebase uid is 28 URL-safe characters, but Servana also holds uids minted
 * by other paths, so this checks a permissive SHAPE rather than a length: it
 * exists to keep control characters and path fragments out of a query, not to
 * authenticate anything.
 */
const readProviderUid = (req: Request): string => {
  const uid = String(req.params.providerUid ?? '');
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(uid)) {
    throw ApiError.validation('providerUid is not a valid identifier.');
  }
  return uid;
};

export const handlers: V1Handlers = {
  'reviews.provider.list': async (req: Request, res: Response) => {
    try {
      const providerUid = readProviderUid(req);
      const page = readPage(req, { defaultLimit: 20, maxLimit: 50 });

      const result = await listProviderReviews(providerUid, page.limit, page.offset);
      const reviews = result?.reviews ?? [];
      const total = typeof result?.total === 'number' ? result.total : null;

      return ok(res, req, { reviews }, { page: pageMeta(page, reviews.length, total) });
    } catch (error) {
      return sendCaught(res, req, 'reviews.provider.list', error);
    }
  },

  'reviews.provider.rating': async (req: Request, res: Response) => {
    try {
      const providerUid = readProviderUid(req);
      const aggregate = await getProviderAggregate(providerUid);
      return ok(res, req, aggregate);
    } catch (error) {
      return sendCaught(res, req, 'reviews.provider.rating', error);
    }
  },
};
