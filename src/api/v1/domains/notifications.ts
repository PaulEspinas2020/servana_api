/**
 * v1 notification handlers.
 *
 * Same `notificationService` functions the legacy `/api/user/notifications*`
 * routes call, including `isSafeNotificationKey` — the key is opaque and is
 * validated before it reaches a query.
 *
 * Both mutations here are naturally idempotent: marking a read notification
 * read again, or marking all read twice, reaches the same end state. They
 * therefore need no Idempotency-Key, and the contract records that with
 * `idempotent: true` rather than leaving it to be inferred.
 */

import { Request, Response } from 'express';
import * as notificationService from '../../../services/notification.service';
import { ok, sendCaught, readPage, pageMeta } from '../envelope';
import { ApiError } from '../errors';
import { V1Handlers } from '../types';

const actorOf = (req: Request): string => {
  const uid = (req as any).user?.uid as string | undefined;
  if (!uid) throw new ApiError('UNAUTHENTICATED', 'Authentication is required.');
  return uid;
};

const readKey = (req: Request): string => {
  const key = req.params.key as string;
  if (!notificationService.isSafeNotificationKey(key)) {
    throw ApiError.validation('Invalid notification key.');
  }
  return key;
};

export const handlers: V1Handlers = {
  'notifications.list': async (req: Request, res: Response) => {
    try {
      const uid = actorOf(req);
      const filter = typeof req.query.filter === 'string' ? req.query.filter : undefined;
      const page = readPage(req, { defaultLimit: 50, maxLimit: 100 });

      const all = await notificationService.listCustomerNotifications(uid, filter);
      const total = Array.isArray(all) ? all.length : 0;
      const window = Array.isArray(all) ? all.slice(page.offset, page.offset + page.limit) : [];

      return ok(res, req, { notifications: window }, { page: pageMeta(page, window.length, total) });
    } catch (error) {
      return sendCaught(res, req, 'notifications.list', error);
    }
  },

  'notifications.unreadCount': async (req: Request, res: Response) => {
    try {
      const count = await notificationService.countCustomerUnreadNotifications(actorOf(req));
      return ok(res, req, { count });
    } catch (error) {
      return sendCaught(res, req, 'notifications.unreadCount', error);
    }
  },

  'notifications.markRead': async (req: Request, res: Response) => {
    try {
      const uid = actorOf(req);
      const key = readKey(req);

      const result = await notificationService.markCustomerNotificationReadByKey(uid, key);
      if (!result.found) {
        throw new ApiError('NOTIFICATION_NOT_FOUND', 'No notification with that key.');
      }
      if (!result.allowed) {
        throw new ApiError('NOTIFICATION_NOT_ACTIONABLE', 'That notification cannot be marked read.');
      }
      return ok(res, req, result);
    } catch (error) {
      return sendCaught(res, req, 'notifications.markRead', error);
    }
  },

  'notifications.markAllRead': async (req: Request, res: Response) => {
    try {
      await notificationService.markAllCustomerNotificationsRead(actorOf(req));
      return ok(res, req, { marked: true });
    } catch (error) {
      return sendCaught(res, req, 'notifications.markAllRead', error);
    }
  },
};
