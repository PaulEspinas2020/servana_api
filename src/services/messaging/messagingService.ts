/**
 * The canonical messaging domain service.
 *
 * Every canonical endpoint in `api/v1/domains/conversations.ts` calls exactly
 * one function here, and every function here delegates authorization to
 * `chat/chat.service` — the SAME resolver the legacy `/api/chat/...` routes and
 * the Socket.IO gateway use. There is one authorization implementation for
 * messaging, and it reads `booking_workers`.
 *
 * ## What this layer adds, and what it deliberately does not
 *
 * It adds the canonical PROJECTION (`conversationDto`), the unread derivation
 * and the drift check. It does NOT re-authorize, re-validate a message, or
 * decide when a conversation is writable — all three live in the domain service
 * or the policy, because a second implementation of a rule is a rule that will
 * eventually disagree with itself.
 *
 * ## Why the inbox does not resolve full access per row
 *
 * `resolveAccessForConversation` costs three to five queries, and running it per
 * conversation would make a provider's inbox O(n) round trips against a table
 * they may have fifty rows in. The list query instead returns two derived
 * columns — `viewer_is_client` from the booking, and the participant's own
 * `can_send` — which is enough to name the seat and to render a composer.
 *
 * That value is ADVISORY and says so in the DTO's docs: the authoritative check
 * runs on the write, against `booking_workers`, in `chat.service.sendMessage`.
 * The failure mode of an advisory `canSend: true` is a composer that produces a
 * 409, which is a bad second, not a leak. The failure mode of skipping the write
 * check would be the leak, and that check is not skipped.
 */

import * as chat from '../../chat/chat.service';
import * as repo from '../../chat/chat.repository';
import {
  bookingCode,
  readPointersOf,
  toConversationDto,
  toMessageDto,
  toMessagePageDto,
  type ConversationDto,
  type MessageDto,
  type MessagePageDto,
  type ParticipantRow,
} from './conversationDto';
import {
  MESSAGE_PAGE,
  SEAT_OF_ACCESS_ROLE,
  mayOpenConversation,
  mayWrite,
  type ConversationStatus,
  type ParticipantSeat,
} from './messagingPolicy';
import { recordUnreadDrift } from './messagingTelemetry';

export type MessagingActor = chat.ChatActor;

// ─── Refusals ─────────────────────────────────────────────────────────────────

export type MessagingErrorCode =
  | chat.MessagingRefusalCode
  | 'CONVERSATION_NOT_AVAILABLE'
  | 'BOOKING_NOT_FOUND';

/**
 * A refusal this layer raises itself.
 *
 * Errors thrown by `chat.service` travel as `HttpError` with a `code`; this
 * class carries the same vocabulary for the two refusals that only exist up
 * here. The v1 handler translates both into the canonical enum and never
 * re-decides which refusal applies.
 */
export class MessagingError extends Error {
  constructor(
    readonly code: MessagingErrorCode,
    message: string,
    readonly status: number = 409,
  ) {
    super(message);
    this.name = 'MessagingError';
  }
}

// ─── Seats ────────────────────────────────────────────────────────────────────

const seatOfAccess = (role: chat.AccessResult['role']): ParticipantSeat =>
  SEAT_OF_ACCESS_ROLE[(role ?? 'coworker') as 'client' | 'coworker' | 'admin'];

const isSupport = (actor: MessagingActor): boolean =>
  actor.role === 0 || actor.role === 1;

// ─── Unread ───────────────────────────────────────────────────────────────────

/**
 * The unread count, plus a check that it is right.
 *
 * The count comes from the SQL expression the inbox uses. It is then recomputed
 * in TypeScript from the raw message rows, applying the same five clauses
 * `UNREAD_DEFINITION` states, and the two are compared.
 *
 * The recount is NOT used to correct the answer. Silently returning the
 * "better" number would hide the fact that two readings of one table disagree,
 * and the disagreement is the only interesting part — a badge that self-heals
 * on read is a badge that is wrong everywhere it is not read.
 */
export const unreadCountFor = async (
  conversationId: number,
  userUid: string,
): Promise<{ count: number; isParticipant: boolean }> => {
  const count = await repo.countUnreadFor(conversationId, userUid);
  if (count === null) return { count: 0, isParticipant: false };

  try {
    const audit = await repo.unreadAuditRows(conversationId, userUid);
    if (audit) {
      const joinedAt = audit.joinedAt ? new Date(audit.joinedAt).getTime() : 0;
      const recomputed = audit.messages.filter((m) => {
        if (m.senderUid === userUid) return false;
        if (audit.lastReadMessageId !== null && m.id <= audit.lastReadMessageId) return false;
        return new Date(m.createdAt).getTime() >= joinedAt;
      }).length;
      if (recomputed !== count) recordUnreadDrift(count - recomputed);
    }
  } catch {
    // The check is diagnostic. It must never turn a readable conversation into
    // an error, so a failure to verify the count is not a failure to return it.
  }

  return { count, isParticipant: true };
};

// ─── Conversations ────────────────────────────────────────────────────────────

/**
 * Open, or resolve, the conversation for a booking. Idempotent.
 *
 * The creation RULE is `mayOpenConversation`, not this function: a booking
 * conversation is a consequence of a provider being confirmed, and the read path
 * deliberately never creates one. Without that check the canonical POST would
 * become a back door that manufactures empty threads for unassigned bookings —
 * the exact behaviour that was removed from `getBookingConversation`.
 */
export const openConversation = async (
  actor: MessagingActor,
  bookingId: number,
): Promise<{ conversation: ConversationDto; created: boolean }> => {
  const access = await chat.resolveAccessForBooking(actor, bookingId);
  if (!access.allowed) {
    // 403 and not 404: the caller may be a former provider on a real booking,
    // and the two are already distinguished by `resolveAccessForBooking`.
    throw new MessagingError(
      'CONVERSATION_ACCESS_DENIED',
      'You are not a participant of this booking.',
      403,
    );
  }

  const existing = await chat.getExistingConversation(bookingId);
  const seat = seatOfAccess(access.role);

  if (!existing) {
    const workers = await repo.getBookingWorkerUids(bookingId);
    const decision = mayOpenConversation(seat, { hasActiveProvider: workers.length > 0 });
    if (!decision.allowed) {
      throw new MessagingError(
        'CONVERSATION_NOT_AVAILABLE',
        decision.reason ?? 'This booking has no conversation yet.',
        409,
      );
    }
  }

  const row = await chat.getOrCreateConversation(bookingId);
  const dto = await projectConversation(actor, row, { seat, access });
  return { conversation: dto, created: !existing };
};

/**
 * Build the full conversation DTO for one row.
 *
 * Participants including departed ones are disclosed to SUPPORT only: "who was
 * on this booking and when did they leave" is an audit question, and publishing
 * it to the customer would expose a provider who was reassigned away for
 * reasons that are not the customer's business.
 */
const projectConversation = async (
  actor: MessagingActor,
  row: any,
  opts: { seat: ParticipantSeat; access: chat.AccessResult },
): Promise<ConversationDto> => {
  const conversationId = Number(row.id);
  const includeDeparted = opts.seat === 'support';
  const participants = (await repo.listParticipants(
    conversationId,
    includeDeparted,
  )) as ParticipantRow[];

  const unread = await unreadCountFor(conversationId, actor.uid);

  // The most recent message the CALLER may see, built by the same page reader
  // the transcript uses — so a provider's preview cannot show a message from
  // before their assignment began.
  let lastMessage: MessageDto | null = null;
  try {
    const page = await chat.getMessagePage(actor, conversationId, 1);
    lastMessage = page.messages.length ? toMessageDto(page.messages[0]) : null;
  } catch {
    // A read floor that refuses (a provider with no usable assignment
    // timestamp) leaves the preview empty rather than failing the whole
    // conversation read, which they are otherwise entitled to.
    lastMessage = null;
  }

  return toConversationDto(row, {
    viewerUid: actor.uid,
    viewerSeat: opts.seat,
    canSend: opts.access.canSend,
    cannotSendReason: opts.access.sendRefusalReason ?? null,
    unreadCount: unread.count,
    isParticipant: unread.isParticipant,
    participants,
    lastMessage,
  });
};

/**
 * The caller's inbox.
 *
 * The subject is the TOKEN. There is no uid parameter anywhere in the path,
 * query or body, which is what makes the leakage test a statement about the code
 * rather than about today's set of routes.
 */
export const listConversations = async (
  actor: MessagingActor,
): Promise<ConversationDto[]> => {
  if (isSupport(actor)) {
    /**
     * The admin oversight list. A privileged read of the same resource, not a
     * second inbox with its own rules — and deliberately without unread counts:
     * an admin holds no read pointer on a booking they are merely supervising,
     * so any number here would be invented.
     */
    const rows = await repo.listAllConversations();
    return rows.map((row: any) =>
      toConversationDto(row, {
        viewerUid: actor.uid,
        viewerSeat: 'support',
        canSend: mayWrite((row.status ?? 'ACTIVE') as ConversationStatus, 'support').allowed,
        unreadCount: 0,
        isParticipant: false,
        participants: [],
      }),
    );
  }

  const rows = await repo.listConversationsForUser(actor.uid);
  return rows.map((row: any) => {
    const seat: ParticipantSeat = row.viewer_is_client === true ? 'customer' : 'provider';
    const decision = mayWrite((row.status ?? 'ACTIVE') as ConversationStatus, seat, {
      legacyIsClosed: row.is_closed === true,
    });
    // The participant projection may only NARROW. `viewer_can_send` reflects a
    // revoked or ended assignment; the state decides the rest.
    const canSend = decision.allowed && row.viewer_can_send !== false;
    return toConversationDto(row, {
      viewerUid: actor.uid,
      viewerSeat: seat,
      canSend,
      cannotSendReason: canSend
        ? null
        : decision.reason ?? 'You are no longer able to send messages in this conversation.',
      // The list query already computed it with the canonical expression.
      unreadCount: row.unread_count == null ? 0 : Number(row.unread_count),
      isParticipant: true,
      participants: [],
    });
  });
};

/** One conversation, with participants and the caller's own unread count. */
export const getConversation = async (
  actor: MessagingActor,
  conversationId: number,
): Promise<ConversationDto> => {
  const { access, conversation } = await chat.resolveAccessForConversation(actor, conversationId);
  /**
   * ONE refusal for "no such conversation" and "not yours".
   *
   * Answering 404 for an unknown id and 403 for a real one makes the endpoint an
   * enumeration oracle: conversation ids are sequential integers, so a caller
   * who can tell the two apart can count the platform's conversations by
   * walking them. The legacy detail route already refuses both with 403 for
   * exactly this reason; the canonical route matches it, and the canonical
   * TRANSCRIPT route stops distinguishing them too.
   *
   * `CONVERSATION_ACCESS_DENIED` therefore means "this id does not resolve to a
   * conversation you may read", which is the only fact a caller is entitled to.
   */
  if (!conversation || !access.allowed) {
    throw new MessagingError(
      'CONVERSATION_ACCESS_DENIED',
      'Not a participant of this conversation',
      403,
    );
  }
  return projectConversation(actor, conversation, {
    seat: seatOfAccess(access.role),
    access,
  });
};

// ─── Messages ─────────────────────────────────────────────────────────────────

/**
 * A page of the transcript, newest first.
 *
 * `cursor` is the id of the oldest message the caller already has. Offset paging
 * would be wrong here: rows arrive at the end while a reader pages, so page two
 * of an offset scan silently repeats or skips messages.
 */
export const listMessages = async (
  actor: MessagingActor,
  conversationId: number,
  opts: { limit?: number; cursor?: number } = {},
): Promise<MessagePageDto> => {
  const limit = opts.limit ?? MESSAGE_PAGE.defaultLimit;
  const page = await chat.getMessagePage(actor, conversationId, limit, opts.cursor);
  return toMessagePageDto(conversationId, page.messages.map(toMessageDto), page.limit);
};

/**
 * Send. The identity is the TOKEN's, always.
 *
 * `actor` is built from the verified token by the handler; nothing in the body
 * names a sender, and `chat.service` writes `sender_uid` from the actor it was
 * given. A `senderId` in a request body would be an authorization decision made
 * by the caller.
 */
export const sendMessage = async (
  actor: MessagingActor,
  conversationId: number,
  input: {
    type?: string;
    body?: string | null;
    clientMsgId?: string | null;
    attachments?: Array<{
      url: string;
      fileName?: string;
      mimeType?: string;
      sizeBytes?: number;
      width?: number;
      height?: number;
    }>;
  },
): Promise<MessageDto> => {
  const view = await chat.sendMessage(actor, conversationId, {
    type: input.type,
    body: input.body,
    clientMsgId: input.clientMsgId,
    attachments: input.attachments,
  });
  return toMessageDto(view);
};

// ─── Read state ───────────────────────────────────────────────────────────────

export interface ReadStateDto {
  conversationId: number;
  lastReadMessageId: number;
  unreadCount: number;
  isParticipant: boolean;
}

/**
 * Advance the caller's read pointer and report what unread is NOW.
 *
 * Returning the resulting count is the whole point: a client that has to
 * re-fetch the inbox to learn what its badge should say will render a stale one
 * in between, and every client solves that locally by decrementing a number it
 * guessed. One round trip, one authoritative answer.
 *
 * The pointer is monotonic and is only ever advanced to a message that exists in
 * THIS conversation and is visible to this participant, both enforced in SQL.
 */
export const markRead = async (
  actor: MessagingActor,
  conversationId: number,
  lastReadMessageId: number,
): Promise<ReadStateDto> => {
  await chat.markRead(actor, conversationId, lastReadMessageId);
  const unread = await unreadCountFor(conversationId, actor.uid);
  return {
    conversationId,
    lastReadMessageId,
    unreadCount: unread.count,
    isParticipant: unread.isParticipant,
  };
};

/** Exported for the docs generator, which names the code in its examples. */
export const CONVERSATION_CODE = bookingCode;

/** The read pointers helper, re-exported so tests need one import. */
export { readPointersOf };
