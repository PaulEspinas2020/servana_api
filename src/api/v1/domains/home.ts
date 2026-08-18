/**
 * The canonical home composition endpoints.
 *
 * ## Caching is decided by the RESPONSE, not by the route
 *
 * `cacheControlFor` reads the sections actually present. A response containing
 * any personal section is `private, no-store`, whatever the individual TTLs say
 * — a shared cache holding one customer's active booking and serving it to the
 * next request is the leak §115 forbids, and it is one the server cannot observe
 * once a proxy is in front of it.
 *
 * So `?sections=categories,featuredServices` is genuinely cacheable and the
 * default set is not, and neither is a property of the URL.
 *
 * ## Anonymous callers get a page
 *
 * The contract marks `/home` authenticated because the default set includes
 * personal sections. The composition itself degrades: a personal section for a
 * caller with no uid resolves to `REQUIRES_AUTH` rather than failing, so the
 * same service can serve a signed-out surface the day a public variant is added.
 */

import { Request, Response } from 'express';
import { composeHome, describeSections } from '../../../services/home/homeService';
import { cacheControlFor, isSectionType, type SectionType } from '../../../services/home/homePolicy';
import { getUserRole } from '../../../chat/chat.repository';
import { ok, sendCaught } from '../envelope';
import { ApiError } from '../errors';
import { V1Handlers } from '../types';

const uidOf = (req: Request): string => {
  const uid = (req as any).user?.uid as string | undefined;
  if (!uid) throw new ApiError('UNAUTHENTICATED', 'Authentication is required.');
  return uid;
};

/**
 * The requested section list.
 *
 * An unknown name is IGNORED rather than refused. A client shipped against a
 * newer registry asking for a section this build does not have should get the
 * rest of its page, not a 400 — the registry is append-only and version-safe by
 * design, and refusing would make adding a section a breaking change for every
 * older client.
 */
const requestedSections = (req: Request): SectionType[] | undefined => {
  const raw = req.query.sections;
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const names = raw.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 16);
  const known = names.filter(isSectionType);
  // Every name was unknown: treat it as "no preference" rather than composing an
  // empty page, which would look like an outage to a client that simply asked
  // for something this build has not heard of.
  return known.length ? known : undefined;
};

export const handlers: V1Handlers = {
  /**
   * The composed home surface.
   *
   * One request instead of the three or four serial calls the customer app makes
   * on launch, each with its own round trip on a Philippine mobile network.
   * Sections compose in parallel, so the cost is the slowest section rather than
   * the sum.
   */
  'home.feed': async (req: Request, res: Response) => {
    try {
      const uid = uidOf(req);
      const role = (await getUserRole(uid)) ?? 3;
      const sections = requestedSections(req);

      const feed = await composeHome({ uid, role }, sections);

      // Derived from what is actually in the response. See the docblock above.
      res.set('Cache-Control', cacheControlFor(feed.meta.requested));
      // A cached copy keyed only on the URL would be shared across accounts.
      // `Vary: Authorization` tells every intermediary that the identity is part
      // of the key — belt and braces beside the no-store above.
      res.set('Vary', 'Authorization');

      return ok(res, req, { sections: feed.sections }, feed.meta);
    } catch (error) {
      return sendCaught(res, req, 'home.feed', error);
    }
  },

  /**
   * The section registry: what the page is made of and what owns each part.
   *
   * Metadata, not content — so it is genuinely cacheable and identical for every
   * caller. A client uses it to render an unknown section safely rather than
   * crashing on it; an operator uses it to see what home is composed of without
   * reading the source.
   */
  'home.sections': async (req: Request, res: Response) => {
    try {
      // Public metadata about the shape of the page. It names no account and no
      // resource, so it caches like the catalog it describes.
      res.set('Cache-Control', 'public, max-age=300');
      return ok(res, req, describeSections());
    } catch (error) {
      return sendCaught(res, req, 'home.sections', error);
    }
  },
};
