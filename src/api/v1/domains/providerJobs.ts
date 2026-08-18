/**
 * v1 provider job-card handlers.
 *
 * Three legacy paths reach this same pair of service calls:
 *
 *   GET /api/workers/:workerId/job-cards   ServanaWorker    uid from the PATH
 *   GET /api/worker/job-cards              Provider Web     uid from the TOKEN
 *   GET /api/v1/provider/jobs              (this)           uid from the TOKEN
 *
 * They are not three capabilities. They are one query wearing three names, and
 * the only material difference is where the provider identity comes from —
 * which is precisely the difference that produced a BOLA on the first of them.
 * v1 takes the identity from the token and offers no way to name another
 * provider (§7, §11).
 *
 * `formatJobCard` is shared with both legacy controllers, so the card a
 * provider sees is byte-identical whichever path they arrive on.
 */

import { Request, Response } from 'express';
import * as technicianService from '../../../services/technicianService';
import { formatJobCard } from '../../../controllers/jobCardView';
import { ok, sendCaught, readPage, pageMeta } from '../envelope';
import { ApiError } from '../errors';
import { V1Handlers } from '../types';

const actorOf = (req: Request): string => {
  const uid = (req as any).user?.uid as string | undefined;
  if (!uid) throw new ApiError('UNAUTHENTICATED', 'Authentication is required.');
  return uid;
};

export const handlers: V1Handlers = {
  'provider.jobs.list': async (req: Request, res: Response) => {
    try {
      const uid = actorOf(req);
      const page = readPage(req, { defaultLimit: 50, maxLimit: 100 });

      const jobs = await technicianService.getJobCardsByWorker(uid);
      const total = jobs.length;
      const window = jobs.slice(page.offset, page.offset + page.limit);

      return ok(
        res,
        req,
        { jobs: window.map(formatJobCard) },
        { page: pageMeta(page, window.length, total) },
      );
    } catch (error) {
      return sendCaught(res, req, 'provider.jobs.list', error);
    }
  },

  'provider.jobs.get': async (req: Request, res: Response) => {
    try {
      const uid = actorOf(req);
      const bookingId = Number(req.params.bookingId);
      if (!Number.isSafeInteger(bookingId) || bookingId <= 0) {
        throw ApiError.validation('bookingId must be a positive integer.');
      }

      // Scoped by uid inside the query, so a provider cannot read another
      // provider's card by guessing a booking id — the 404 below is a genuine
      // "not yours or not there", and deliberately does not distinguish the two.
      const job = await technicianService.getJobCardByWorker(uid, bookingId);
      if (!job) throw new ApiError('NOT_FOUND', 'No job card for that booking.');

      return ok(res, req, formatJobCard(job));
    } catch (error) {
      return sendCaught(res, req, 'provider.jobs.get', error);
    }
  },
};
