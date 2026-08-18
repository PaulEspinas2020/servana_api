/**
 * v1 settings handlers.
 *
 * ## Why this is not `/provider/settings`
 *
 * Notification preferences reach the backend by three legacy paths today:
 *
 *   GET/PUT /api/provider/notification-preferences      verifyAuth + requireProviderRole
 *   GET/PUT /api/workers/:uid/notification-preferences  verifyAuth + verifyOwnership
 *
 * Both are gated on a provider role, and both call
 * `notificationService.getNotificationPrefs(uid)` / `saveNotificationPrefs(uid, …)`,
 * which are keyed on a uid and know nothing about roles — the preference table
 * has no role column. The role gate is an accident of where the feature was
 * built, not a property of the capability. Customers receive notifications too
 * and today have no way to configure them.
 *
 * v1 therefore serves any authenticated caller. This is additive: both legacy
 * routes keep their guards, so no provider client changes and no customer
 * gains access to anything that was not already their own row.
 */

import { Request, Response } from 'express';
import * as notificationService from '../../../services/notification.service';
import { ok, sendCaught } from '../envelope';
import { ApiError } from '../errors';
import { V1Handlers } from '../types';

const actorOf = (req: Request): string => {
  const uid = (req as any).user?.uid as string | undefined;
  if (!uid) throw new ApiError('UNAUTHENTICATED', 'Authentication is required.');
  return uid;
};

export const handlers: V1Handlers = {
  'settings.notificationPreferences.get': async (req: Request, res: Response) => {
    try {
      const prefs = await notificationService.getNotificationPrefs(actorOf(req));
      return ok(res, req, prefs);
    } catch (error) {
      return sendCaught(res, req, 'settings.notificationPreferences.get', error);
    }
  },

  'settings.notificationPreferences.put': async (req: Request, res: Response) => {
    try {
      const uid = actorOf(req);
      const body = req.body;
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw ApiError.validation('Body must be a JSON object of preference flags.');
      }

      // A full replace, so a repeat of the same body reaches the same state —
      // which is what `idempotent: true` on the contract entry asserts, and why
      // this needs no Idempotency-Key.
      const saved = await notificationService.saveNotificationPrefs(uid, body);
      return ok(res, req, saved);
    } catch (error) {
      return sendCaught(res, req, 'settings.notificationPreferences.put', error);
    }
  },
};
