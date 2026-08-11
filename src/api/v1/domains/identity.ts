/**
 * v1 identity handler.
 *
 * Calls `identityService.getIdentity` — the same function `/api/auth/me` now
 * calls — so the canonical route and the legacy alias answer from one query.
 */

import { getIdentity } from '../../../services/identityService';
import { ok, sendCaught } from '../envelope';
import { ApiError } from '../errors';
import { V1Handlers } from '../types';

export const handlers: V1Handlers = {
  'identity.me': async (req, res) => {
    try {
      // `auth: 'authenticated'` in the contract means verifyAuth has already
      // run and req.user.uid is present. The check is defence in depth, not
      // redundancy — the identical shape elsewhere in this codebase turned out
      // to be reachable when a route's middleware changed underneath it.
      const uid = (req as any).user?.uid as string | undefined;
      if (!uid) throw new ApiError('UNAUTHENTICATED', 'Authentication is required.');

      const identity = await getIdentity(uid);
      if (!identity) {
        throw new ApiError('NOT_FOUND', 'No account record exists for this identity yet.');
      }
      return ok(res, req, identity);
    } catch (error) {
      return sendCaught(res, req, 'identity.me', error);
    }
  },
};
