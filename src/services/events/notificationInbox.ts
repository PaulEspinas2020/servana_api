/**
 * ONE inbox contract over three physical stores (§93).
 *
 * ## The defect this closes
 *
 * `GET /api/v1/notifications` read `customer_notifications` and nothing else. A
 * provider calling the canonical endpoint therefore received an EMPTY INBOX —
 * not an error, not a 403, just nothing — while their notifications sat in
 * `provider_notifications` where only the legacy provider route looked. The
 * canonical route was documented as serving any authenticated caller and served
 * one of the three seats.
 *
 * ## Why three tables and not one
 *
 * `provider_notifications`, `customer_notifications` and `admin_notifications`
 * each have live writers, live readers and different columns. Merging them is a
 * data migration against the only reachable database, which is production. What
 * the release gate actually needs is one CONTRACT: one DTO, one unread
 * definition, one ordering, one mark-read semantic. That is achievable now, and
 * it is what this module is.
 *
 * The store is resolved from the caller's ROLE, not from a parameter. Every
 * statement underneath is predicated on the owner uid from the token, so the
 * three tables are three private inboxes rather than one shared surface.
 *
 * ## The unread definition, stated once
 *
 * A notification is unread when its status is `unread` and it has not expired.
 * `admin_notifications` has no expiry column and expresses read as a
 * `read_at IS NULL`; the projection normalises both into `readAt` so a client
 * branches on one field.
 */

import * as notificationService from '../notification.service';
import * as adminNotifications from '../adminNotificationService';
import { isProviderRole } from '../../constants/providerRoles';
import { DEEP_LINK_TARGETS, type DeepLinkTarget } from './domainEvents';

/** Which physical store holds this account's notifications. */
export type InboxStore = 'provider' | 'customer' | 'admin';

/**
 * Roles 0 and 1 are staff. Matches `chat.service` and the dashboard analytics,
 * and is the same predicate `notifyAllAdmins` fans out on.
 */
const STAFF_ROLES = new Set(['0', '1']);

export const storeForRole = (role: unknown): InboxStore => {
  const raw = String(role ?? '').trim();
  if (STAFF_ROLES.has(raw)) return 'admin';
  if (isProviderRole(role)) return 'provider';
  return 'customer';
};

// ─── The one DTO ──────────────────────────────────────────────────────────────

export interface NotificationDto {
  /** Opaque, owner-scoped. The identifier every mutation takes. */
  notificationKey: string;
  type: string;
  severity: string;
  title: string;
  body: string;
  contextLabel: string | null;
  createdAt: string | null;
  readAt: string | null;
  isRead: boolean;
  expiresAt: string | null;
  /**
   * The canonical deep-link target, when the stored route resolves to one.
   *
   * Null for a notification written before this tab, or one whose route names
   * no declared target. Null is honest: the client shows it un-tappable rather
   * than navigating somewhere invented.
   */
  target: DeepLinkTarget | null;
  /** The stored route, as the shipped clients already parse it. */
  route: Record<string, unknown> | null;
  canOpenDetail: boolean;
  canMarkRead: boolean;
}

const iso = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
};

/**
 * Recover the canonical target from a stored route.
 *
 * New notifications carry `target` because the projector puts it there. Old ones
 * do not, so the target is INFERRED from the legacy route shape — which is
 * possible precisely because `DEEP_LINK_TARGETS` declares both projections, so
 * the inference reads the same table the rendering does rather than a second
 * hand-written mapping.
 */
export const targetOfRoute = (route: unknown): DeepLinkTarget | null => {
  if (!route || typeof route !== 'object') return null;
  const r = route as Record<string, unknown>;

  const declared = String(r.target ?? '');
  if (declared && Object.prototype.hasOwnProperty.call(DEEP_LINK_TARGETS, declared)) {
    return declared as DeepLinkTarget;
  }

  for (const [name, spec] of Object.entries(DEEP_LINK_TARGETS)) {
    for (const projection of [spec.customer, spec.provider]) {
      if (!projection) continue;
      const keys = Object.keys(projection);
      // Every literal (non-substituted) value must match, and every key present.
      const matches = keys.every((key) => {
        const template = (projection as Record<string, string>)[key];
        if (template.includes('{id}')) return r[key] !== undefined && r[key] !== null;
        return String(r[key] ?? '') === template;
      });
      if (matches && keys.length) return name as DeepLinkTarget;
    }
  }
  return null;
};

/** Provider and customer rows already share a mapper shape upstream. */
const fromOwnerRow = (row: any): NotificationDto => ({
  notificationKey: String(row.notificationKey),
  type: String(row.type ?? 'system'),
  severity: String(row.severity ?? 'info'),
  title: String(row.title ?? ''),
  body: String(row.safeBody ?? ''),
  contextLabel: row.safeContextLabel ?? null,
  createdAt: iso(row.createdAt),
  readAt: iso(row.readAt),
  isRead: row.status === 'read' || !!row.readAt,
  expiresAt: iso(row.expiresAt),
  target: targetOfRoute(row.route),
  route: (row.route ?? null) as Record<string, unknown> | null,
  canOpenDetail: !!row.canOpenDetail,
  canMarkRead: !!row.canMarkRead,
});

/**
 * The admin store keys on a numeric id and has no notification_key, no severity
 * defaults and no route. It is normalised into the same DTO so an admin client
 * reads one shape — the id becomes the opaque key, which is exactly what the key
 * is for.
 */
const fromAdminRow = (row: any): NotificationDto => {
  const route =
    row.booking_id != null
      ? { ...DEEP_LINK_TARGETS.BOOKING_DETAIL.customer, resourceId: String(row.booking_id), target: 'BOOKING_DETAIL' }
      : null;
  return {
    notificationKey: String(row.id),
    type: String(row.type ?? 'system'),
    severity: String(row.severity ?? 'info'),
    title: String(row.title ?? ''),
    body: String(row.body ?? ''),
    contextLabel: null,
    createdAt: iso(row.created_at),
    readAt: iso(row.read_at),
    isRead: !!row.read_at,
    expiresAt: null,
    target: route ? 'BOOKING_DETAIL' : null,
    route,
    canOpenDetail: !!route,
    canMarkRead: !row.read_at,
  };
};

// ─── Reads ────────────────────────────────────────────────────────────────────

export interface InboxActor {
  uid: string;
  role: number;
}

export const listNotifications = async (
  actor: InboxActor,
  options: { filter?: string } = {},
): Promise<NotificationDto[]> => {
  switch (storeForRole(actor.role)) {
    case 'provider': {
      const rows = await notificationService.listNotifications(actor.uid, options.filter);
      return rows.map(fromOwnerRow);
    }
    case 'admin': {
      const rows = await adminNotifications.listForAdmin(actor.uid, 100);
      return rows.map(fromAdminRow);
    }
    default: {
      const rows = await notificationService.listCustomerNotifications(actor.uid, options.filter);
      return (Array.isArray(rows) ? rows : []).map(fromOwnerRow);
    }
  }
};

export const countUnread = async (actor: InboxActor): Promise<number> => {
  switch (storeForRole(actor.role)) {
    case 'provider':
      return notificationService.countUnreadNotifications(actor.uid);
    case 'admin':
      return adminNotifications.unreadCount(actor.uid);
    default:
      return notificationService.countCustomerUnreadNotifications(actor.uid);
  }
};

export interface MarkReadResult {
  found: boolean;
  allowed: boolean;
  changed: boolean;
  /** The count AFTER the mutation, so a client never has to guess its badge. */
  unreadCount: number;
}

/**
 * Mark one read, and answer with the resulting unread count.
 *
 * Returning the count is the reconciliation half of the release gate: a client
 * that has to re-fetch to learn its badge renders a stale one in between, and
 * every client then solves it locally by decrementing a number it guessed. One
 * round trip, one authoritative answer — the same decision TAB 08 made for
 * conversations.
 */
export const markRead = async (actor: InboxActor, key: string): Promise<MarkReadResult> => {
  const store = storeForRole(actor.role);
  let result = { found: false, allowed: false, changed: false };

  if (store === 'provider') {
    result = await notificationService.markNotificationReadByKey(actor.uid, key);
  } else if (store === 'admin') {
    const id = Number(key);
    if (Number.isSafeInteger(id) && id > 0) {
      const affected = await adminNotifications.markRead(actor.uid, id);
      result = { found: affected > 0, allowed: true, changed: affected > 0 };
    }
  } else {
    result = await notificationService.markCustomerNotificationReadByKey(actor.uid, key);
  }

  return { ...result, unreadCount: await countUnread(actor) };
};

export const markAllRead = async (actor: InboxActor): Promise<{ unreadCount: number }> => {
  switch (storeForRole(actor.role)) {
    case 'provider':
      await notificationService.markAllNotificationsReadForWorker(actor.uid);
      break;
    case 'admin':
      await adminNotifications.markRead(actor.uid);
      break;
    default:
      await notificationService.markAllCustomerNotificationsRead(actor.uid);
  }
  // Recounted rather than assumed zero. A row written between the update and
  // the count — which is the normal case on a busy account — would make a
  // hardcoded 0 a lie the client renders as an empty badge over a full inbox.
  return { unreadCount: await countUnread(actor) };
};
