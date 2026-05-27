import * as repo from "./chat.repository";
import { emitToConversation } from "./chat.realtime";
import { toCamel } from "../helpers/idGenerator";

/**
 * Transport-agnostic chat logic. Both the REST controller and the Socket.IO
 * gateway call into this service, so a message sent over HTTP and one sent
 * over the socket behave identically.
 */

// Roles 0 and 1 are admins/staff in user_credentials (see dashboard analytics).
const ADMIN_ROLES = [0, 1];

export type ChatActor = { uid: string; role: number };

export interface AccessResult {
  allowed: boolean;
  role: "client" | "coworker" | "admin" | null;
}

// ---- Authorization (derived from the booking) ------------------------------

/** Resolve how `actor` relates to the booking behind a conversation. */
export const resolveAccessForBooking = async (
  actor: ChatActor,
  bookingId: number
): Promise<AccessResult> => {
  if (ADMIN_ROLES.includes(actor.role)) {
    return { allowed: true, role: "admin" };
  }
  const clientUid = await repo.getBookingClientUid(bookingId);
  if (clientUid && clientUid === actor.uid) {
    return { allowed: true, role: "client" };
  }
  const workerUids = await repo.getBookingWorkerUids(bookingId);
  if (workerUids.includes(actor.uid)) {
    return { allowed: true, role: "coworker" };
  }
  return { allowed: false, role: null };
};

/** Same check but starting from a conversation id. */
export const resolveAccessForConversation = async (
  actor: ChatActor,
  conversationId: number
): Promise<{ access: AccessResult; conversation: any | null }> => {
  const conversation = await repo.findConversationById(conversationId);
  if (!conversation) return { access: { allowed: false, role: null }, conversation: null };
  const access = await resolveAccessForBooking(actor, conversation.booking_id);
  return { access, conversation };
};

// ---- Conversations ---------------------------------------------------------

/**
 * Get the conversation for a booking, creating it (and the client/coworker
 * participant rows) on first access. Idempotent.
 */
export const getOrCreateConversation = async (bookingId: number) => {
  let conversation = await repo.findConversationByBookingId(bookingId);
  if (!conversation) {
    conversation = await repo.createConversation(bookingId);
  }

  // Sync participant rows from the booking (client + active workers).
  const clientUid = await repo.getBookingClientUid(bookingId);
  if (clientUid) {
    const role = (await repo.getUserRole(clientUid)) ?? 3;
    await repo.upsertParticipant(conversation.id, clientUid, role);
  }
  const workerUids = await repo.getBookingWorkerUids(bookingId);
  for (const w of workerUids) {
    const role = (await repo.getUserRole(w)) ?? 2;
    await repo.upsertParticipant(conversation.id, w, role);
  }

  return conversation;
};

export const getConversationWithParticipants = async (conversationId: number) => {
  const conversation = await repo.findConversationById(conversationId);
  if (!conversation) return null;
  const participants = await repo.listParticipants(conversationId);
  return { ...toCamel(conversation), participants: participants.map(toCamel) };
};

export const listConversations = async (actor: ChatActor) => {
  const rows = ADMIN_ROLES.includes(actor.role)
    ? await repo.listAllConversations()
    : await repo.listConversationsForUser(actor.uid);
  return rows.map(toCamel);
};

export const closeConversation = async (conversationId: number) => {
  const c = await repo.closeConversation(conversationId);
  if (c) emitToConversation(conversationId, "conversation:closed", { conversationId });
  return c ? toCamel(c) : null;
};

// ---- Messages --------------------------------------------------------------

/** Hydrate a message row with its attachments, camelCased. */
const hydrateMessage = async (row: any) => {
  const attachments = await repo.listAttachments(row.id);
  return { ...toCamel(row), attachments: attachments.map(toCamel) };
};

/**
 * Core write path used by REST and socket alike.
 * Authorizes, dedupes on clientMsgId, persists message + attachments,
 * bumps the conversation, then broadcasts `message:new`.
 */
export const sendMessage = async (
  actor: ChatActor,
  conversationId: number,
  input: {
    type?: string;
    body?: string | null;
    metadata?: any;
    clientMsgId?: string | null;
    attachments?: Array<{
      url: string;
      fileName?: string;
      mimeType?: string;
      sizeBytes?: number;
      width?: number;
      height?: number;
    }>;
  }
) => {
  const { access, conversation } = await resolveAccessForConversation(actor, conversationId);
  if (!conversation) throw httpError(404, "Conversation not found");
  if (!access.allowed) throw httpError(403, "Not a participant of this conversation");
  if (conversation.is_closed && access.role !== "admin") {
    throw httpError(409, "Conversation is closed");
  }

  const type = input.type || "text";
  const hasBody = !!(input.body && input.body.trim());
  const hasAttachments = !!(input.attachments && input.attachments.length);
  if (type !== "system" && !hasBody && !hasAttachments) {
    throw httpError(422, "Message must have a body or an attachment");
  }

  // Idempotency: a retried send returns the original message.
  if (input.clientMsgId) {
    const existing = await repo.findMessageByClientId(conversationId, actor.uid, input.clientMsgId);
    if (existing) return hydrateMessage(existing);
  }

  const message = await repo.insertMessage({
    conversationId,
    senderUid: actor.uid,
    senderRole: actor.role,
    type,
    body: input.body ?? null,
    metadata: input.metadata,
    clientMsgId: input.clientMsgId,
  });

  if (hasAttachments) {
    for (const a of input.attachments!) {
      await repo.insertAttachment(message.id, a);
    }
  }

  await repo.touchConversation(conversationId);

  const full = await hydrateMessage(message);
  emitToConversation(conversationId, "message:new", full);
  return full;
};

/** System message helper — call from booking lifecycle code. */
export const postSystemMessage = async (
  conversationId: number,
  body: string,
  metadata: any = {}
) => {
  const message = await repo.insertMessage({
    conversationId,
    senderUid: null,
    senderRole: null,
    type: "system",
    body,
    metadata,
  });
  await repo.touchConversation(conversationId);
  const full = await hydrateMessage(message);
  emitToConversation(conversationId, "message:new", full);
  return full;
};

export const getMessages = async (
  actor: ChatActor,
  conversationId: number,
  limit = 30,
  before?: number
) => {
  const { access, conversation } = await resolveAccessForConversation(actor, conversationId);
  if (!conversation) throw httpError(404, "Conversation not found");
  if (!access.allowed) throw httpError(403, "Not a participant of this conversation");

  const rows = await repo.listMessages(conversationId, Math.min(limit, 100), before);
  const messages = await Promise.all(rows.map(hydrateMessage));
  const nextCursor = rows.length === Math.min(limit, 100) ? rows[rows.length - 1].id : null;
  return { messages, nextCursor };
};

export const editMessage = async (
  actor: ChatActor,
  conversationId: number,
  messageId: number,
  body: string
) => {
  const { access, conversation } = await resolveAccessForConversation(actor, conversationId);
  if (!conversation) throw httpError(404, "Conversation not found");
  if (!access.allowed) throw httpError(403, "Not allowed");

  const original = await repo.getMessageById(messageId);
  if (!original || original.conversation_id !== conversation.id) throw httpError(404, "Message not found");
  if (original.sender_uid !== actor.uid && access.role !== "admin") {
    throw httpError(403, "Can only edit your own messages");
  }

  const updated = await repo.editMessage(messageId, body);
  if (!updated) throw httpError(409, "Message cannot be edited");
  const full = await hydrateMessage(updated);
  emitToConversation(conversationId, "message:updated", full);
  return full;
};

export const deleteMessage = async (
  actor: ChatActor,
  conversationId: number,
  messageId: number
) => {
  const { access, conversation } = await resolveAccessForConversation(actor, conversationId);
  if (!conversation) throw httpError(404, "Conversation not found");
  if (!access.allowed) throw httpError(403, "Not allowed");

  const original = await repo.getMessageById(messageId);
  if (!original || original.conversation_id !== conversation.id) throw httpError(404, "Message not found");
  if (original.sender_uid !== actor.uid && access.role !== "admin") {
    throw httpError(403, "Can only delete your own messages");
  }

  const deleted = await repo.softDeleteMessage(messageId);
  const full = await hydrateMessage(deleted);
  emitToConversation(conversationId, "message:updated", full);
  return full;
};

export const markRead = async (
  actor: ChatActor,
  conversationId: number,
  lastReadMessageId: number
) => {
  const { access, conversation } = await resolveAccessForConversation(actor, conversationId);
  if (!conversation) throw httpError(404, "Conversation not found");
  if (!access.allowed) throw httpError(403, "Not a participant of this conversation");

  await repo.setLastRead(conversationId, actor.uid, lastReadMessageId);
  emitToConversation(conversationId, "message:read", {
    conversationId,
    userUid: actor.uid,
    lastReadMessageId,
  });
};

// ---- Small error helper (carries an HTTP status) ---------------------------

export interface HttpError extends Error {
  status: number;
}

export const httpError = (status: number, message: string): HttpError => {
  const e = new Error(message) as HttpError;
  e.status = status;
  return e;
};
