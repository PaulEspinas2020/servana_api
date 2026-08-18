/**
 * The ONE projection for conversations, participants and messages.
 *
 * ## Why one builder matters more here than anywhere else
 *
 * A message reaches a client down two independent paths: a Socket.IO event when
 * it is written, and a REST page when the client reconnects, backgrounds, or
 * misses the event. If those two paths build their own shapes, the client has to
 * reconcile two representations of one row — and it will do it by comparing
 * bodies and timestamps, because that is all it can do, and it will get it wrong
 * on edits, on soft deletes and on attachments.
 *
 * ## The shape problem this file solves, and how
 *
 * There is a real tension. Four shipped clients read the CURRENT realtime
 * payload — `payload.id`, `payload.body`, `payload.createdAt`, `payload.senderRole`
 * — and none of them can be redeployed by this backend. A canonical DTO that
 * replaced those keys would break every one of them on the day it shipped.
 *
 * So there is one builder producing one object with BOTH vocabularies:
 *
 *      buildMessageView(row, attachments, ctx)   ->  MessageView
 *                    │                                  │
 *          legacy keys (createdAt, senderRole, ...)     │  canonical keys
 *                    │                                  │  (sentAt, senderSeat,
 *      toLegacyMessage(view)                            │   isMine, readByCount)
 *      -> what /api/chat/... returns                    │
 *                                                 toMessageDto(view)
 *                                                 -> what /api/v1/... returns
 *
 * The realtime emit sends the whole `MessageView`. That means:
 *
 *   - shipped clients keep reading the keys they already read;
 *   - a migrated client reads the canonical keys off the SAME payload;
 *   - `toMessageDto(realtimePayload)` is byte-for-byte the REST DTO, which is
 *     the reconciliation guarantee stated as an equation rather than a promise.
 *
 * `tests/messaging-realtime-schema.test.ts` asserts exactly that equality.
 *
 * ## Ids stay numbers
 *
 * A string id would be the better shape for a bigint column, and it is not
 * available: every shipped client parses `id` as a number today, and the
 * realtime payload has to stay readable by them. `chat_messages.id` is a
 * 32-bit SERIAL, so the value is representable; the day it is not is the day
 * the column type changes, and that is the change that would carry this one.
 *
 * ## Additive, not subtractive
 *
 * Every DTO NAMES its fields. Nothing is built by copying a row and deleting the
 * sensitive columns — a subtractive projection discloses every column somebody
 * forgets to remove, and `listParticipants` joins `user_credentials` and
 * `user_profile`, so "forgot to remove" means a person's account row.
 */

import { isProviderRole } from '../../constants/providerRoles';
import {
  MESSAGE_PAGE,
  RECEIPT_MODEL,
  REALTIME_SCHEMA_VERSION,
  UNREAD_FOR_NON_PARTICIPANT,
  type ConversationStatus,
  type MessageType,
  type ParticipantSeat,
} from './messagingPolicy';

// ─── Row shapes, as the repository returns them ───────────────────────────────

export interface MessageRow {
  id: number | string;
  conversation_id: number | string;
  sender_uid: string | null;
  sender_role: number | string | null;
  type: string;
  body: string | null;
  metadata?: unknown;
  client_msg_id?: string | null;
  created_at: string | Date;
  edited_at?: string | Date | null;
  deleted_at?: string | Date | null;
}

export interface AttachmentRow {
  id: number | string;
  message_id: number | string;
  url: string;
  file_name?: string | null;
  mime_type?: string | null;
  size_bytes?: number | string | null;
  width?: number | null;
  height?: number | null;
  created_at?: string | Date | null;
}

export interface ParticipantRow {
  conversation_id: number | string;
  user_uid: string;
  role: number | string | null;
  joined_at?: string | Date | null;
  left_at?: string | Date | null;
  last_read_message_id?: number | string | null;
  last_read_at?: string | Date | null;
  can_read?: boolean | null;
  can_send?: boolean | null;
  first_name?: string | null;
  last_name?: string | null;
  photo_url?: string | null;
}

export interface ConversationRow {
  id: number | string;
  booking_id: number | string;
  status?: string | null;
  is_closed?: boolean | null;
  created_at?: string | Date | null;
  updated_at?: string | Date | null;
  last_message_at?: string | Date | null;
  /** Present on the inbox query only. */
  unread_count?: number | string | null;
}

// ─── Small conversions ────────────────────────────────────────────────────────

const num = (value: unknown): number => Number(value);

const iso = (value: string | Date | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
};

/** Roles 0 and 1 are staff in `user_credentials`. Matches `chat.service`. */
const STAFF_ROLES = new Set(['0', '1']);

/**
 * Which seat a stored role value represents.
 *
 * `sender_role` is the numeric role captured when the message was written, so a
 * message keeps the seat it was sent from even if the person's role changes
 * later — which is the correct behaviour for a transcript.
 */
export const seatOfRole = (role: unknown): ParticipantSeat => {
  if (role === null || role === undefined || String(role).trim() === '') return 'customer';
  if (STAFF_ROLES.has(String(role).trim())) return 'support';
  if (isProviderRole(role)) return 'provider';
  return 'customer';
};

// ─── Attachments ──────────────────────────────────────────────────────────────

/**
 * The full attachment view: the legacy camelCase row plus nothing extra.
 *
 * The canonical DTO is a strict SUBSET of it — `messageId` and `createdAt` are
 * dropped, because a client rendering a thumbnail has the message already and
 * the upload time of an attachment is not a thing any surface shows.
 */
export interface AttachmentView {
  id: number;
  messageId: number;
  url: string;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  createdAt: string | null;
}

export interface AttachmentDto {
  id: number;
  url: string;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
}

/**
 * `url` is republished as stored. It is either an owned storage key or a
 * Firebase download URL in the configured bucket under `chat-attachments/`,
 * both proven at WRITE time by `normaliseAttachment` — the reference cannot name
 * another person's object, because the object name must begin with the
 * uploader's uid. Authorization happens where the object is created and where
 * the message is written; there is no third place for it to be skipped.
 */
export const buildAttachmentView = (row: AttachmentRow): AttachmentView => ({
  id: num(row.id),
  messageId: num(row.message_id),
  url: row.url,
  fileName: row.file_name ?? null,
  mimeType: row.mime_type ?? null,
  sizeBytes: row.size_bytes === null || row.size_bytes === undefined ? null : num(row.size_bytes),
  width: row.width ?? null,
  height: row.height ?? null,
  createdAt: iso(row.created_at ?? null),
});

export const toAttachmentDto = (view: AttachmentView): AttachmentDto => ({
  id: view.id,
  url: view.url,
  fileName: view.fileName,
  mimeType: view.mimeType,
  sizeBytes: view.sizeBytes,
  width: view.width,
  height: view.height,
});

// ─── Messages ─────────────────────────────────────────────────────────────────

/** The canonical half. What `/api/v1` publishes and what a migrated client reads. */
export interface MessageDto {
  id: number;
  conversationId: number;
  bookingId: number | null;
  type: MessageType | string;
  body: string | null;
  senderSeat: ParticipantSeat | 'system';
  senderUid: string | null;
  isMine: boolean;
  isSystem: boolean;
  clientMsgId: string | null;
  sentAt: string | null;
  editedAt: string | null;
  deletedAt: string | null;
  isDeleted: boolean;
  readByCount: number;
  readByAll: boolean;
  attachments: AttachmentDto[];
  metadata: Record<string, unknown>;
}

/**
 * Canonical keys plus the legacy ones the four shipped clients read.
 *
 * `senderRole` and `createdAt` are the legacy names; `senderSeat` and `sentAt`
 * are the canonical ones, carrying the same facts. Both are present because
 * both have readers, and one builder produces them together so they cannot
 * disagree about the same message.
 */
export interface MessageView extends Omit<MessageDto, 'attachments'> {
  /** LEGACY. The numeric role at send time. `senderSeat` is the canonical form. */
  senderRole: number | null;
  /** LEGACY. Same instant as `sentAt`. */
  createdAt: string | null;
  /**
   * The FULL attachment rows, camelCased exactly as `/api/chat/...` returned
   * them. `toMessageDto` narrows each one; the wider shape stays on the wire so
   * a shipped client reading `attachments[].messageId` keeps working.
   */
  attachments: AttachmentView[];
}

export interface MessageViewContext {
  /** The uid the message is rendered FOR. Drives `isMine` only. */
  viewerUid: string | null;
  bookingId?: number | string | null;
  /**
   * Read pointers of the conversation's ACTIVE participants, used to derive the
   * receipt. Omitted yields `readByCount: 0` and `readByAll: false`, which is
   * the honest answer when the pointers were not loaded.
   */
  readPointers?: ReadonlyArray<{ uid: string; lastReadMessageId: number | null }>;
}

export const buildMessageView = (
  row: MessageRow,
  attachments: readonly AttachmentRow[],
  context: MessageViewContext,
): MessageView => {
  const id = num(row.id);
  const isSystem = row.type === 'system' || row.sender_uid === null;
  const senderUid = row.sender_uid ?? null;

  /**
   * The receipt, derived — never stored per message.
   *
   * A recipient's pointer is a high-water mark, so "read" is `pointer >= id`.
   * The sender is excluded from the denominator: a message is not "read by
   * everyone" because its author has seen it. With no other participants loaded
   * `readByAll` is false rather than vacuously true — an empty set is not
   * evidence that everybody read it.
   */
  const others = (context.readPointers ?? []).filter((p) => p.uid !== senderUid);
  const readByCount = others.filter(
    (p) => p.lastReadMessageId !== null && Number(p.lastReadMessageId) >= id,
  ).length;

  const attachmentViews = attachments.map(buildAttachmentView);
  const sentAt = iso(row.created_at);

  return {
    id,
    conversationId: num(row.conversation_id),
    bookingId:
      context.bookingId === null || context.bookingId === undefined
        ? null
        : num(context.bookingId),
    type: String(row.type) as MessageType,
    // A soft-deleted message has its body nulled in the database. Republishing
    // whatever is there keeps the tombstone visible without resurrecting text.
    body: row.body ?? null,
    senderSeat: isSystem ? 'system' : seatOfRole(row.sender_role),
    senderUid,
    isMine: !!senderUid && !!context.viewerUid && senderUid === context.viewerUid,
    isSystem,
    clientMsgId: row.client_msg_id ?? null,
    sentAt,
    editedAt: iso(row.edited_at ?? null),
    deletedAt: iso(row.deleted_at ?? null),
    isDeleted: !!row.deleted_at,
    readByCount,
    readByAll: others.length > 0 && readByCount === others.length,
    attachments: attachmentViews,
    metadata:
      row.metadata && typeof row.metadata === 'object'
        ? (row.metadata as Record<string, unknown>)
        : {},
    // ── legacy half ──
    senderRole:
      row.sender_role === null || row.sender_role === undefined ? null : num(row.sender_role),
    createdAt: sentAt,
  };
};

/**
 * The canonical projection.
 *
 * Takes a `MessageView` — which is what the realtime payload IS — so applying it
 * to a received socket payload yields exactly the REST body for the same
 * message. That is what makes fallback reconciliation an id comparison.
 */
export const toMessageDto = (view: MessageView): MessageDto => ({
  id: view.id,
  conversationId: view.conversationId,
  bookingId: view.bookingId,
  type: view.type,
  body: view.body,
  senderSeat: view.senderSeat,
  senderUid: view.senderUid,
  isMine: view.isMine,
  isSystem: view.isSystem,
  clientMsgId: view.clientMsgId,
  sentAt: view.sentAt,
  editedAt: view.editedAt,
  deletedAt: view.deletedAt,
  isDeleted: view.isDeleted,
  readByCount: view.readByCount,
  readByAll: view.readByAll,
  attachments: view.attachments.map(toAttachmentDto),
  metadata: view.metadata,
});

// ─── Participants ─────────────────────────────────────────────────────────────

export interface ParticipantDto {
  uid: string;
  seat: ParticipantSeat;
  displayName: string | null;
  photoUrl: string | null;
  joinedAt: string | null;
  leftAt: string | null;
  isActive: boolean;
  lastReadMessageId: number | null;
  lastReadAt: string | null;
}

/**
 * A participant, with the contact columns the join makes available deliberately
 * left out.
 *
 * `listParticipants` joins `user_credentials` and `user_profile`; those rows
 * carry email, phone and address. A display name and an avatar are what a chat
 * header needs, and nothing here is a channel for reaching someone off-platform
 * — a rule the platform enforces elsewhere and would be pointless to enforce
 * everywhere except the screen where the two parties are talking.
 */
export const toParticipantDto = (row: ParticipantRow): ParticipantDto => {
  const name = [row.first_name, row.last_name]
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter(Boolean)
    .join(' ');
  return {
    uid: String(row.user_uid),
    seat: seatOfRole(row.role),
    displayName: name || null,
    photoUrl: row.photo_url ?? null,
    joinedAt: iso(row.joined_at ?? null),
    leftAt: iso(row.left_at ?? null),
    isActive: !row.left_at,
    lastReadMessageId:
      row.last_read_message_id === null || row.last_read_message_id === undefined
        ? null
        : num(row.last_read_message_id),
    lastReadAt: iso(row.last_read_at ?? null),
  };
};

/** Read pointers in the shape `buildMessageView` wants. */
export const readPointersOf = (
  participants: readonly ParticipantRow[],
): Array<{ uid: string; lastReadMessageId: number | null }> =>
  participants
    // A departed participant's stale pointer must not make a later message look
    // read: they are not going to read it.
    .filter((p) => !p.left_at)
    .map((p) => ({
      uid: String(p.user_uid),
      lastReadMessageId:
        p.last_read_message_id === null || p.last_read_message_id === undefined
          ? null
          : num(p.last_read_message_id),
    }));

// ─── Conversations ────────────────────────────────────────────────────────────

export interface ConversationDto {
  id: number;
  kind: 'BOOKING';
  bookingId: number;
  bookingCode: string;
  status: ConversationStatus | string;
  /** The compatibility boolean, republished so a client needs only one field. */
  isClosed: boolean;
  viewerSeat: ParticipantSeat;
  canSend: boolean;
  /** Present when `canSend` is false. Why, in words a client can show. */
  cannotSendReason: string | null;
  unreadCount: number;
  isParticipant: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  lastMessageAt: string | null;
  participants: ParticipantDto[];
  lastMessage: MessageDto | null;
}

export interface ConversationDtoContext {
  viewerUid: string;
  viewerSeat: ParticipantSeat;
  canSend: boolean;
  cannotSendReason?: string | null;
  unreadCount?: number | null;
  isParticipant?: boolean;
  participants?: readonly ParticipantRow[];
  lastMessage?: MessageDto | null;
}

/** `SVN-000075`. The code support and both apps say out loud. */
export const bookingCode = (bookingId: number | string): string =>
  `SVN-${String(num(bookingId)).padStart(6, '0')}`;

export const toConversationDto = (
  row: ConversationRow,
  context: ConversationDtoContext,
): ConversationDto => {
  const unread =
    context.unreadCount === null || context.unreadCount === undefined
      ? row.unread_count === null || row.unread_count === undefined
        ? UNREAD_FOR_NON_PARTICIPANT.count
        : num(row.unread_count)
      : num(context.unreadCount);

  return {
    id: num(row.id),
    kind: 'BOOKING',
    bookingId: num(row.booking_id),
    bookingCode: bookingCode(row.booking_id),
    status: (row.status ?? 'ACTIVE') as ConversationStatus,
    isClosed: row.is_closed === true,
    viewerSeat: context.viewerSeat,
    canSend: context.canSend,
    cannotSendReason: context.canSend ? null : context.cannotSendReason ?? null,
    unreadCount: unread,
    isParticipant: context.isParticipant ?? true,
    createdAt: iso(row.created_at ?? null),
    updatedAt: iso(row.updated_at ?? null),
    lastMessageAt: iso(row.last_message_at ?? null),
    participants: (context.participants ?? []).map(toParticipantDto),
    lastMessage: context.lastMessage ?? null,
  };
};

// ─── Pages ────────────────────────────────────────────────────────────────────

export interface MessagePageDto {
  conversationId: number;
  messages: MessageDto[];
  /** The id to pass as `cursor` for the next (older) page. Null at the end. */
  nextCursor: number | null;
  hasMore: boolean;
  /** Echoed so a client can tell a clamped limit from the one it asked for. */
  limit: number;
}

export const toMessagePageDto = (
  conversationId: number | string,
  messages: MessageDto[],
  limit: number,
): MessagePageDto => {
  // A full page is the ONLY evidence that more may exist. Reporting hasMore from
  // a count query would need a second scan of a table that is appended to
  // between the two, and would still be wrong by the time it arrived.
  const hasMore = messages.length === limit && messages.length > 0;
  return {
    conversationId: num(conversationId),
    messages,
    nextCursor: hasMore ? messages[messages.length - 1].id : null,
    hasMore,
    limit,
  };
};

// ─── Realtime envelope ────────────────────────────────────────────────────────

/**
 * The three keys stamped on every server-emitted payload.
 *
 * Stamped ADDITIVELY onto the existing payload object rather than wrapping it.
 * All four shipped clients read the message fields at the top level; wrapping
 * would break every one of them on the day it deployed and would buy a tidiness
 * nobody can see. None of the three collides with a message field.
 */
export interface RealtimeEnvelope {
  event: string;
  schemaVersion: number;
  emittedAt: string;
}

export const withRealtimeEnvelope = <T extends object>(
  event: string,
  payload: T,
): T & RealtimeEnvelope => ({
  ...payload,
  event,
  schemaVersion: REALTIME_SCHEMA_VERSION,
  emittedAt: new Date().toISOString(),
});

/**
 * The inverse: recover the canonical DTO from a received realtime payload.
 *
 * This is the function a migrating client mirrors, and the one the test uses to
 * prove the two transports agree. It is deliberately total — it reads only the
 * canonical keys and ignores the envelope and the legacy half.
 */
export const messageDtoFromRealtime = (payload: MessageView & Partial<RealtimeEnvelope>): MessageDto =>
  toMessageDto(payload);

/** Re-exported so a consumer needs one import to know what is and is not tracked. */
export const RECEIPTS = RECEIPT_MODEL;
export const PAGE_DEFAULTS = MESSAGE_PAGE;
