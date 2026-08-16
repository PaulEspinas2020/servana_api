/**
 * v1 notification handlers: the inbox, preferences and device registration.
 *
 * ## The defect these fix
 *
 * `notifications.list` called `listCustomerNotifications` directly. A PROVIDER
 * calling the canonical endpoint therefore received an empty array — not an
 * error, not a 403, just nothing — while their notifications sat in
 * `provider_notifications` where only the legacy provider route looked. The
 * endpoint was documented as serving any authenticated caller and served one of
 * three seats.
 *
 * Every handler here now goes through `notificationInbox`, which resolves the
 * caller's store from their account and projects all three into one DTO.
 *
 * ## Identity is the token, everywhere
 *
 * No path, query or body field names an account. `actorOf` reads `req.user.uid`
 * from the verified token and looks the numeric role up in `user_credentials` —
 * the role decides which STORE is read, never which account.
 */

import { Request, Response } from 'express';
import * as inbox from '../../../services/events/notificationInbox';
import * as preferences from '../../../services/events/notificationPreferences';
import * as devices from '../../../services/events/deviceTokenService';
import * as notificationService from '../../../services/notification.service';
import { getUserRole } from '../../../chat/chat.repository';
import { ok, created, sendCaught, readPage, pageMeta } from '../envelope';
import { ApiError } from '../errors';
import { V1Handlers } from '../types';

const uidOf = (req: Request): string => {
  const uid = (req as any).user?.uid as string | undefined;
  if (!uid) throw new ApiError('UNAUTHENTICATED', 'Authentication is required.');
  return uid;
};

/**
 * The acting account.
 *
 * The role comes from `user_credentials`, not from a token claim: the token is a
 * Firebase identity and the role is Servana's own fact about it. Defaulting to 3
 * (customer) on a missing row is the least-privileged answer — an unknown
 * account is not staff and is not a provider.
 */
const actorOf = async (req: Request): Promise<inbox.InboxActor> => {
  const uid = uidOf(req);
  return { uid, role: (await getUserRole(uid)) ?? 3 };
};

const readKey = (req: Request): string => {
  const key = req.params.key as string;
  if (!notificationService.isSafeNotificationKey(key)) {
    throw ApiError.validation('Invalid notification key.');
  }
  return key;
};

export const handlers: V1Handlers = {
  /**
   * The caller's inbox, from whichever store holds it.
   *
   * Paged in memory over a service-capped read, which is what the legacy shape
   * already did. The cap is the service's; this adds the clamped window and the
   * page meta so a client is never handed an unbounded list.
   */
  'notifications.list': async (req: Request, res: Response) => {
    try {
      const actor = await actorOf(req);
      const filter = typeof req.query.filter === 'string' ? req.query.filter : undefined;
      const page = readPage(req, { defaultLimit: 50, maxLimit: 100 });

      const all = await inbox.listNotifications(actor, { filter });
      const window = all.slice(page.offset, page.offset + page.limit);

      return ok(
        res,
        req,
        { notifications: window },
        {
          page: pageMeta(page, window.length, all.length),
          // The badge, from the SAME store resolution the list used — so the
          // count and the screen can never be reading different tables.
          unreadCount: await inbox.countUnread(actor),
        },
      );
    } catch (error) {
      return sendCaught(res, req, 'notifications.list', error);
    }
  },

  'notifications.unreadCount': async (req: Request, res: Response) => {
    try {
      return ok(res, req, { count: await inbox.countUnread(await actorOf(req)) });
    } catch (error) {
      return sendCaught(res, req, 'notifications.unreadCount', error);
    }
  },

  /**
   * Mark one read, and answer with the resulting unread count.
   *
   * Returning the count is the reconciliation half of the release gate: a client
   * that must re-fetch to learn its badge renders a stale one in between, and
   * then every client solves it locally by decrementing a number it guessed.
   */
  'notifications.markRead': async (req: Request, res: Response) => {
    try {
      const actor = await actorOf(req);
      const result = await inbox.markRead(actor, readKey(req));

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
      const result = await inbox.markAllRead(await actorOf(req));
      return ok(res, req, { marked: true, ...result });
    } catch (error) {
      return sendCaught(res, req, 'notifications.markAllRead', error);
    }
  },

  // ── Preferences ────────────────────────────────────────────────────────────

  /**
   * Every declared category, always, with the account's value or the category
   * default. A client never has to decide what a missing key means — which is
   * the decision that produces two different answers in two clients.
   */
  'me.notificationPreferences.get': async (req: Request, res: Response) => {
    try {
      return ok(res, req, await preferences.getPreferences(uidOf(req)));
    } catch (error) {
      return sendCaught(res, req, 'me.notificationPreferences.get', error);
    }
  },

  /**
   * A PARTIAL update, deliberately.
   *
   * The legacy `/settings/notification-preferences` PUT is a full replace, and a
   * client that knows about seven categories silently resets the two it has
   * never heard of every time the backend adds one. PATCH cannot do that.
   */
  'me.notificationPreferences.patch': async (req: Request, res: Response) => {
    try {
      const uid = uidOf(req);
      const body = req.body;
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw ApiError.validation('Body must be a JSON object of category flags.');
      }
      return ok(res, req, await preferences.patchPreferences(uid, body));
    } catch (error) {
      return sendCaught(res, req, 'me.notificationPreferences.patch', asApiError(error));
    }
  },

  // ── Device tokens ──────────────────────────────────────────────────────────

  /**
   * Register THIS device for push, for the authenticated account.
   *
   * Account-scoped by construction: the uid is the token subject and the row is
   * upserted on the device token, so registering a handset that another account
   * holds MOVES it rather than adding a second owner. A shared or resold device
   * receiving two accounts' notifications is a cross-account leak with a lock
   * screen attached.
   */
  'me.devices.register': async (req: Request, res: Response) => {
    try {
      const uid = uidOf(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const result = await devices.registerDevice(uid, body.token, {
        platform: body.platform,
        app: body.app,
      });
      if (!result.registered) {
        throw ApiError.validation('A valid device token is required.');
      }
      return created(res, req, result);
    } catch (error) {
      return sendCaught(res, req, 'me.devices.register', error);
    }
  },

  /**
   * Release a device. With a token it is "this handset"; without one it is
   * every device — which is what a sign-out-everywhere wants, and what
   * `endAllSessions` performs.
   */
  'me.devices.release': async (req: Request, res: Response) => {
    try {
      const uid = uidOf(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      await devices.releaseDevice(uid, body.token);
      return ok(res, req, { released: true, deviceCount: await devices.countDevices(uid) });
    } catch (error) {
      return sendCaught(res, req, 'me.devices.release', error);
    }
  },
};

/** The preference module's refusal, renamed into the v1 vocabulary. */
const asApiError = (error: unknown): unknown =>
  error instanceof preferences.PreferenceError
    ? new ApiError('VALIDATION_FAILED', error.message)
    : error;
