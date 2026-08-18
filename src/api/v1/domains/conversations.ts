/**
 * The canonical conversation and message endpoints.
 *
 * ## Sender identity comes from the token, and there is no other source
 *
 * Every handler builds its actor with `actorOf(req)`, which reads
 * `req.user.uid` — set by `verifyAuth` from a verified Firebase token — and
 * looks the numeric role up in `user_credentials`. Nothing in a path, query or
 * body can name a sender, a customer or a provider. `POST .../messages` takes
 * `type`, `body`, `clientMsgId` and `attachments`, and that is the entire
 * accepted surface; a `senderId` in a request body is an authorization decision
 * made by the caller.
 *
 * ## Authorization is not repeated here
 *
 * `messagingService` delegates every access question to `chat.service`, which
 * resolves it from `booking_workers` and `bookings`. These handlers do not check
 * roles, do not compare uids, and do not decide whether a conversation is
 * writable. A transport layer that can reach a different conclusion from its
 * domain service is a second implementation of the rule.
 *
 * ## Errors are renamed, never re-decided
 *
 * The domain raises a refusal code; `asApiError` maps it into the v1 enum. No
 * handler evaluates a policy to pick a code.
 */

import { Request, Response } from 'express';
import * as messaging from '../../../services/messaging/messagingService';
import { MessagingError } from '../../../services/messaging/messagingService';
import { getUserRole } from '../../../chat/chat.repository';
import { MESSAGE_PAGE } from '../../../services/messaging/messagingPolicy';
import { ok, created, sendCaught } from '../envelope';
import { ApiError, type V1ErrorCode } from '../errors';
import { V1Handlers } from '../types';

// ─── Request plumbing ─────────────────────────────────────────────────────────

const uidOf = (req: Request): string => {
  const uid = (req as any).user?.uid as string | undefined;
  if (!uid) throw new ApiError('UNAUTHENTICATED', 'Authentication is required.');
  return uid;
};

/**
 * The acting identity.
 *
 * The role is read from `user_credentials` rather than trusted from a token
 * claim, because the token is a Firebase identity and the role is Servana's own
 * fact about that identity. Defaulting to 3 (customer) on a missing row is the
 * least-privileged answer: an unknown account is not staff.
 */
const actorOf = async (req: Request): Promise<messaging.MessagingActor> => {
  const uid = uidOf(req);
  const role = (await getUserRole(uid)) ?? 3;
  return { uid, role };
};

const positiveInt = (raw: unknown, label: string): number => {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw ApiError.validation(`${label} must be a positive integer.`);
  }
  return value;
};

const bodyOf = (req: Request): Record<string, unknown> =>
  (req.body ?? {}) as Record<string, unknown>;

// ─── Error translation ────────────────────────────────────────────────────────

/**
 * Domain refusal → canonical code. Pure renaming.
 *
 * Several validation refusals collapse into `MESSAGE_INVALID`: a client cannot
 * do anything different about a body that is too long and a body with a control
 * character in it, and the human-readable message already says which. The ones
 * that stay distinct are the ones that lead to different screens.
 */
const REFUSAL_CODE: Record<messaging.MessagingErrorCode, V1ErrorCode> = {
  // Collapsed on purpose. `chat.service` distinguishes "no such conversation"
  // from "not yours" because the legacy transcript route always has; the
  // canonical surface must not, because conversation ids are sequential and a
  // caller who can tell the two apart can count the platform's conversations.
  CONVERSATION_NOT_FOUND: 'CONVERSATION_ACCESS_DENIED',
  CONVERSATION_ACCESS_DENIED: 'CONVERSATION_ACCESS_DENIED',
  CONVERSATION_NOT_WRITABLE: 'CONVERSATION_NOT_WRITABLE',
  CONVERSATION_NOT_AVAILABLE: 'CONVERSATION_NOT_AVAILABLE',
  BOOKING_NOT_FOUND: 'BOOKING_NOT_FOUND',
  MESSAGE_HISTORY_UNAVAILABLE: 'MESSAGE_HISTORY_UNAVAILABLE',
  MESSAGE_INVALID: 'MESSAGE_INVALID',
  MESSAGE_TYPE_NOT_ALLOWED: 'MESSAGE_INVALID',
  MESSAGE_TOO_LONG: 'MESSAGE_INVALID',
  MESSAGE_CONTROL_CHARACTERS: 'MESSAGE_INVALID',
  MESSAGE_EMPTY: 'MESSAGE_INVALID',
  CLIENT_MSG_ID_INVALID: 'MESSAGE_IDEMPOTENCY_KEY_INVALID',
  ATTACHMENT_REJECTED: 'MESSAGE_ATTACHMENT_REJECTED',
  MESSAGE_RATE_LIMITED: 'RATE_LIMITED',
  MESSAGE_NOT_FOUND: 'MESSAGE_NOT_FOUND',
  MESSAGE_NOT_EDITABLE: 'MESSAGE_NOT_EDITABLE',
  READ_POINTER_INVALID: 'READ_POINTER_INVALID',
  PAGE_PARAMETER_INVALID: 'VALIDATION_FAILED',
};

/**
 * `chat.service` refuses with an `HttpError` carrying a `code`; this layer
 * renames it. The status fallback exists for the handful of legacy throws that
 * predate the code field — it maps the STATUS, never the message, because
 * matching on English is how a copy edit becomes a behaviour change.
 */
const asApiError = (error: unknown): unknown => {
  if (error instanceof MessagingError) {
    return new ApiError(REFUSAL_CODE[error.code] ?? 'CONFLICT', error.message);
  }
  const candidate = error as { status?: number; code?: string; message?: string } | null;
  if (candidate && typeof candidate.status === 'number' && candidate.status < 500) {
    const named = candidate.code as messaging.MessagingErrorCode | undefined;
    if (named && REFUSAL_CODE[named]) {
      return new ApiError(REFUSAL_CODE[named], candidate.message ?? named);
    }
    const byStatus: Record<number, V1ErrorCode> = {
      400: 'VALIDATION_FAILED',
      401: 'UNAUTHENTICATED',
      403: 'CONVERSATION_ACCESS_DENIED',
      404: 'CONVERSATION_ACCESS_DENIED',
      409: 'CONVERSATION_NOT_WRITABLE',
      422: 'MESSAGE_INVALID',
      429: 'RATE_LIMITED',
    };
    return new ApiError(byStatus[candidate.status] ?? 'CONFLICT', candidate.message);
  }
  return error;
};

// ─── Handlers ─────────────────────────────────────────────────────────────────

export const handlers: V1Handlers = {
  /**
   * Open, or resolve, the conversation for a booking.
   *
   * Idempotent by construction: one conversation per booking, forever, enforced
   * by a unique constraint on `booking_id`. A repeat returns the existing one
   * with 201, because the caller's intent — "give me the thread for this
   * booking" — was satisfied either way and a client should not have to branch
   * on which of the two happened.
   */
  'conversations.create': async (req: Request, res: Response) => {
    try {
      const body = bodyOf(req);
      const bookingId = positiveInt(body.bookingId, 'bookingId');
      const actor = await actorOf(req);
      const result = await messaging.openConversation(actor, bookingId);
      return created(res, req, result.conversation);
    } catch (error) {
      return sendCaught(res, req, 'conversations.create', asApiError(error));
    }
  },

  /** The caller's own conversations. The subject is the token, never a parameter. */
  'conversations.list': async (req: Request, res: Response) => {
    try {
      const actor = await actorOf(req);
      const conversations = await messaging.listConversations(actor);
      return ok(res, req, conversations, {
        // The badge total, computed from the same per-conversation numbers the
        // list carries — so a client never has to sum them itself and arrive at
        // a different answer from the one the next screen shows.
        unreadTotal: conversations.reduce((sum, c) => sum + c.unreadCount, 0),
      });
    } catch (error) {
      return sendCaught(res, req, 'conversations.list', asApiError(error));
    }
  },

  /** One conversation: state, participants, the caller's unread count. */
  'conversations.get': async (req: Request, res: Response) => {
    try {
      const conversationId = positiveInt(req.params.conversationId, 'conversationId');
      const actor = await actorOf(req);
      return ok(res, req, await messaging.getConversation(actor, conversationId));
    } catch (error) {
      return sendCaught(res, req, 'conversations.get', asApiError(error));
    }
  },

  /**
   * A page of the transcript, newest first.
   *
   * The limit is clamped rather than refused — a client asking for 500 wants as
   * many as it can have, and a 400 would leave it unable to page at all.
   * The cursor is validated, because a malformed one means the client has lost
   * its place and silently returning the newest page would look like the
   * conversation had been truncated.
   */
  'conversations.messages.list': async (req: Request, res: Response) => {
    try {
      const conversationId = positiveInt(req.params.conversationId, 'conversationId');
      const actor = await actorOf(req);

      const rawLimit = req.query.limit;
      const limit =
        rawLimit === undefined
          ? MESSAGE_PAGE.defaultLimit
          : Math.min(
              MESSAGE_PAGE.maxLimit,
              Math.max(1, positiveInt(rawLimit, 'limit')),
            );
      const cursor =
        req.query.cursor === undefined
          ? undefined
          : positiveInt(req.query.cursor, 'cursor');

      return ok(res, req, await messaging.listMessages(actor, conversationId, { limit, cursor }));
    } catch (error) {
      return sendCaught(res, req, 'conversations.messages.list', asApiError(error));
    }
  },

  /**
   * Send a message.
   *
   * The sender is the token. `clientMsgId` is REQUIRED — a retry after a
   * timeout has no other way to say "this is the message I already sent", and a
   * chat that duplicates on a flaky connection is one people stop trusting.
   */
  'conversations.messages.create': async (req: Request, res: Response) => {
    try {
      const conversationId = positiveInt(req.params.conversationId, 'conversationId');
      const actor = await actorOf(req);
      const body = bodyOf(req);

      const message = await messaging.sendMessage(actor, conversationId, {
        type: typeof body.type === 'string' ? body.type : undefined,
        body: typeof body.body === 'string' ? body.body : null,
        clientMsgId: typeof body.clientMsgId === 'string' ? body.clientMsgId : null,
        // Passed through unvalidated ON PURPOSE. `normaliseAttachment` in the
        // domain service is the one place an attachment reference is checked
        // for ownership, type and size, and a transport-layer pre-filter here
        // would be a second, weaker copy of that rule.
        attachments: Array.isArray(body.attachments)
          ? (body.attachments as Array<{ url: string }>)
          : undefined,
      });
      return created(res, req, message);
    } catch (error) {
      return sendCaught(res, req, 'conversations.messages.create', asApiError(error));
    }
  },

  /**
   * Advance the caller's read pointer, and answer with the resulting unread
   * count.
   *
   * Returning the count is the point: a client that has to re-fetch its inbox to
   * learn what the badge should say will render a stale one in the meantime, and
   * every client solves that locally by decrementing a number it guessed.
   */
  /**
   * Store an attachment for this conversation.
   *
   * The conversation is named by the PATH, which is the whole point. On the
   * legacy route it was an optional body field and the access check ran only
   * when the caller supplied it — so a caller who omitted it uploaded a file to
   * Servana's storage and got a URL back without any conversation being
   * consulted. Here there is no request shape that can decline to be checked.
   */
  'conversations.attachments.create': async (req: Request, res: Response) => {
    try {
      const conversationId = positiveInt(req.params.conversationId, 'conversationId');
      const actor = await actorOf(req);
      const body = bodyOf(req);
      const attachment = await messaging.uploadAttachment(actor, conversationId, {
        file: body.file,
        name: body.name,
      });
      return created(res, req, attachment);
    } catch (error) {
      return sendCaught(res, req, 'conversations.attachments.create', asApiError(error));
    }
  },

  /**
   * Report one message to moderation.
   *
   * The reporter is the token subject and is never read from the body: a report
   * that could name its own author is a way to file one against someone else.
   */
  'conversations.messages.report': async (req: Request, res: Response) => {
    try {
      const conversationId = positiveInt(req.params.conversationId, 'conversationId');
      const messageId = positiveInt(req.params.messageId, 'messageId');
      const actor = await actorOf(req);
      const body = bodyOf(req);
      const report = await messaging.reportMessage(actor, conversationId, messageId, {
        category: body.category,
        description: body.description,
      });
      return created(res, req, report);
    } catch (error) {
      return sendCaught(res, req, 'conversations.messages.report', asApiError(error));
    }
  },

  'conversations.read': async (req: Request, res: Response) => {
    try {
      const conversationId = positiveInt(req.params.conversationId, 'conversationId');
      const actor = await actorOf(req);
      const lastReadMessageId = positiveInt(bodyOf(req).lastReadMessageId, 'lastReadMessageId');
      return ok(res, req, await messaging.markRead(actor, conversationId, lastReadMessageId));
    } catch (error) {
      return sendCaught(res, req, 'conversations.read', asApiError(error));
    }
  },
};
