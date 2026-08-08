import * as repo from "./chat.repository";
import { emitToConversation, evictUserFromConversation } from "./chat.realtime";
import { toCamel } from "../helpers/idGenerator";
import { notifyAdminsSafely } from '../services/adminNotificationService';
import { firebaseConfig } from '../config';

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
  /** May see the transcript. */
  canRead: boolean;
  /** May post into it right now — membership AND conversation state permitting. */
  canSend: boolean;
  /** Was on this booking and is no longer (reassigned, declined, cancelled). */
  wasParticipant: boolean;
}

const deny = (wasParticipant = false): AccessResult => ({
  allowed: false,
  role: null,
  canRead: false,
  canSend: false,
  wasParticipant,
});

// ---- Authorization (derived from the booking) ------------------------------

/**
 * Resolve how `actor` relates to the BOOKING. This answers membership only —
 * whether the conversation itself is currently writable is layered on top by
 * `resolveAccessForConversation`, because a booking relationship and a
 * conversation state are two different things and conflating them is what made
 * `is_closed` the only expressible rule.
 */
export const resolveAccessForBooking = async (
  actor: ChatActor,
  bookingId: number
): Promise<AccessResult> => {
  if (ADMIN_ROLES.includes(actor.role)) {
    return { allowed: true, role: "admin", canRead: true, canSend: true, wasParticipant: false };
  }
  const clientUid = await repo.getBookingClientUid(bookingId);
  if (clientUid && clientUid === actor.uid) {
    return { allowed: true, role: "client", canRead: true, canSend: true, wasParticipant: false };
  }
  const workerUids = await repo.getBookingWorkerUids(bookingId);
  if (workerUids.includes(actor.uid)) {
    return { allowed: true, role: "coworker", canRead: true, canSend: true, wasParticipant: false };
  }
  // Distinguish "was removed from this booking" from "never had anything to do
  // with it". Both are denied, but only the former is a candidate for
  // read-only historical scope, and the distinction is worth having at the
  // call site rather than reconstructing it later.
  const formerUids = await repo.getFormerBookingWorkerUids(bookingId);
  return deny(formerUids.includes(actor.uid));
};

/**
 * Same check, starting from a conversation id, then narrowed by the
 * conversation's lifecycle state and the participant's own capability flags.
 *
 * Precedence, most restrictive wins:
 *   booking membership -> participant row (can_read/can_send) -> conversation status
 *
 * Admins are exempt from the conversation-status narrowing so support can post
 * an official resolution into a closed or archived thread. They are NOT exempt
 * from membership: an admin is authorized by role, which is a deliberate,
 * audited grant.
 */
export const resolveAccessForConversation = async (
  actor: ChatActor,
  conversationId: number
): Promise<{ access: AccessResult; conversation: any | null }> => {
  const conversation = await repo.findConversationById(conversationId);
  if (!conversation) return { access: deny(), conversation: null };

  const base = await resolveAccessForBooking(actor, conversation.booking_id);

  // A former provider may be granted read-only historical scope by policy; it
  // is expressed on their participant row, never inferred from the booking.
  if (!base.allowed) {
    if (!base.wasParticipant) return { access: base, conversation };
    const row = await repo.findParticipant(conversationId, actor.uid);
    if (row && row.can_read === true) {
      return {
        access: { allowed: true, role: "coworker", canRead: true, canSend: false, wasParticipant: true },
        conversation,
      };
    }
    return { access: base, conversation };
  }

  if (base.role === "admin") return { access: base, conversation };

  const row = await repo.findParticipant(conversationId, actor.uid);
  const rowCanRead = row ? row.can_read !== false : true;
  const rowCanSend = row ? row.can_send !== false : true;
  const stillPresent = row ? row.left_at == null : true;

  const status = conversation.status || repo.CONVERSATION_STATUS.ACTIVE;
  const statusWritable = repo.WRITABLE_STATUSES.includes(status);
  // `is_closed` is still honoured for rows written before `status` existed.
  const writable = statusWritable && conversation.is_closed !== true;

  const canRead = rowCanRead;
  const canSend = canRead && stillPresent && rowCanSend && writable;

  if (!canRead) return { access: deny(true), conversation };

  return {
    access: { allowed: true, role: base.role, canRead, canSend, wasParticipant: false },
    conversation,
  };
};

// ---- Conversations ---------------------------------------------------------

/** Human-readable reason a write was refused, for the 409 body. */
const conversationClosedMessage = (conversation: any): string => {
  switch (conversation?.status) {
    case repo.CONVERSATION_STATUS.READ_ONLY:
      return "This booking conversation is read-only.";
    case repo.CONVERSATION_STATUS.ARCHIVED:
      return "This booking conversation has been archived.";
    default:
      return "Conversation is closed";
  }
};

/**
 * Get the conversation for a booking, creating it (and the client/coworker
 * participant rows) on first access. Idempotent.
 *
 * Called from the provider-confirmation path (`technicianService.acceptJob`)
 * and from admin tooling. It does NOT gate on booking state itself — the
 * caller owns that decision — but the only READ path that may create is now
 * `getBookingConversation`, and it gates. See `getExistingConversation`.
 */
export const getOrCreateConversation = async (bookingId: number) => {
  await repo.ensureChatLifecycleSchema();
  let conversation = await repo.findConversationByBookingId(bookingId);
  let created = false;
  if (!conversation) {
    conversation = await repo.createConversation(bookingId);
    created = true;
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

  if (created) {
    notifyAdminsSafely({
      type: 'booking_chat_created', severity: 'info', title: 'Booking chat created',
      body: `A new automatic chat was created for booking SVN-${String(bookingId).padStart(6, '0')}.`,
      bookingId, conversationId: conversation.id,
      notificationKey: `booking_chat_created_${bookingId}`,
    });
  }

  return conversation;
};

/**
 * Read-only lookup — never creates.
 *
 * The conversation is a consequence of a provider being confirmed, not of
 * someone opening a screen. The customer app already expects this: its
 * `MessagingRepository.resolveForBooking` maps a 404 to null and comments
 * "the conversation does not exist yet (provider not yet assigned)". The
 * backend was the side that drifted, lazily creating an empty conversation for
 * any authorized GET — including a customer looking at an unassigned booking.
 */
export const getExistingConversation = async (bookingId: number) => {
  return repo.findConversationByBookingId(bookingId);
};

// ---- Lifecycle transitions -------------------------------------------------

/**
 * A provider was confirmed for this booking. Creates the conversation, seeds
 * participants and posts the opening system message. Idempotent on every step,
 * so a retried confirmation cannot produce a second conversation or a
 * duplicate greeting.
 */
export const openConversationForConfirmedBooking = async (
  bookingId: number,
  opts: { providerName?: string } = {}
) => {
  const conversation = await getOrCreateConversation(bookingId);
  await postSystemMessageOnce(
    conversation.id,
    `booking_conversation_opened_${bookingId}`,
    "Your Servana booking is confirmed. This chat includes you, your service " +
      "provider, and Servana Support. Use it for booking-related updates and questions.",
    { event: "conversation_opened", bookingId }
  );
  if (opts.providerName) {
    await postSystemMessageOnce(
      conversation.id,
      `provider_joined_${bookingId}`,
      `${opts.providerName} has joined this booking conversation as your assigned service provider.`,
      { event: "provider_joined", bookingId }
    );
  }
  return conversation;
};

/**
 * Provider A replaced by Provider B.
 *
 * Revokes A (participant row marked left, can_send false, can_read per policy)
 * and admits B. `retainReadForPrevious` defaults to false, matching the
 * behaviour the platform has today — `adminReassignProvider` sets A's
 * booking_workers row to DECLINED, which already removes them from
 * `getBookingWorkerUids`. Granting read-back is a widening and must be chosen.
 *
 * B is NOT given A's transcript by inheritance; B reads the conversation from
 * their join point forward plus whatever structured handoff the caller posts.
 * This mirrors the C18-04 reassignment gate already applied to booking
 * timeline events in `bookingTimeline.ts`.
 */
export const handleProviderReassignment = async (
  bookingId: number,
  fromProviderUid: string | null,
  toProviderUid: string | null,
  opts: { retainReadForPrevious?: boolean } = {}
) => {
  const conversation = await repo.findConversationByBookingId(bookingId);
  if (!conversation) return null;

  if (fromProviderUid) {
    await repo.removeParticipant(conversation.id, fromProviderUid, {
      retainRead: opts.retainReadForPrevious === true,
    });
    evictUserFromConversation(conversation.id, fromProviderUid);
  }
  if (toProviderUid) {
    const role = (await repo.getUserRole(toProviderUid)) ?? 2;
    await repo.upsertParticipant(conversation.id, toProviderUid, role);
  }

  await postSystemMessageOnce(
    conversation.id,
    `provider_reassigned_${bookingId}_${toProviderUid ?? "none"}`,
    "The assigned provider has changed. Your new Servana provider has joined the conversation.",
    { event: "provider_reassigned", bookingId }
  );
  return conversation;
};

/** Booking cancelled — transcript stays readable, nobody but support may post. */
export const closeConversationForCancellation = async (
  bookingId: number,
  opts: { cancelledOn?: string } = {}
) => {
  const conversation = await repo.findConversationByBookingId(bookingId);
  if (!conversation) return null;
  const updated = await repo.setConversationStatus(
    conversation.id,
    repo.CONVERSATION_STATUS.CLOSED
  );
  const when = opts.cancelledOn ? ` on ${opts.cancelledOn}` : "";
  await postSystemMessageOnce(
    conversation.id,
    `booking_cancelled_${bookingId}`,
    `This booking was cancelled${when}. The conversation is now closed. ` +
      "Contact Servana Support if you need further assistance.",
    { event: "booking_cancelled", bookingId }
  );
  emitToConversation(conversation.id, "conversation:closed", { conversationId: conversation.id });
  return updated;
};

/**
 * Completion does NOT close the conversation. A short window stays open for
 * the things that legitimately come up right after a job: something left
 * behind, a question about the work, a receipt, an immediate concern.
 * `sweepGracePeriod` moves them to read-only once it lapses.
 */
export const GRACE_HOURS = 48;

export const sweepGracePeriod = async (graceHours: number = GRACE_HOURS) => {
  const ids = await repo.findConversationsPastGrace(graceHours);
  for (const id of ids) {
    await repo.setConversationStatus(id, repo.CONVERSATION_STATUS.READ_ONLY);
    await postSystemMessageOnce(
      id,
      `grace_elapsed_${id}`,
      "This booking conversation is now read-only. Contact Servana Support if you need further help.",
      { event: "conversation_read_only" }
    );
    emitToConversation(id, "conversation:closed", { conversationId: id });
  }
  return ids;
};

/** Read-only -> archived. Transcript retained; no new participants admitted. */
export const archiveConversation = async (bookingId: number) => {
  const conversation = await repo.findConversationByBookingId(bookingId);
  if (!conversation) return null;
  return repo.setConversationStatus(conversation.id, repo.CONVERSATION_STATUS.ARCHIVED);
};

/**
 * A dispute reopens the SAME conversation rather than starting a parallel one,
 * so the booking keeps one auditable timeline: assignment, chat, arrival, OTP,
 * service, payment, completion, complaint, resolution.
 */
export const escalateToSupport = async (bookingId: number) => {
  const conversation = await repo.findConversationByBookingId(bookingId);
  if (!conversation) return null;
  const updated = await repo.setConversationStatus(
    conversation.id,
    repo.CONVERSATION_STATUS.SUPPORT_ESCALATED
  );
  await postSystemMessageOnce(
    conversation.id,
    `dispute_opened_${bookingId}`,
    "Servana Support has joined this conversation to help resolve an issue with this booking.",
    { event: "support_escalated", bookingId }
  );
  return updated;
};

export const getConversationWithParticipants = async (conversationId: number, actor?: ChatActor) => {
  const conversation = await repo.findConversationById(conversationId);
  if (!conversation) return null;
  const participants = await repo.listParticipants(
    conversationId,
    !!actor && ADMIN_ROLES.includes(actor.role),
  );
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

const MESSAGE_BODY_MAX = 4000;
const ATTACHMENT_MAX = 5;
const ATTACHMENT_BYTES_MAX = 10 * 1024 * 1024;
const ALLOWED_ATTACHMENT_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'application/pdf',
]);
const sendWindows = new Map<string, number[]>();

const assertSendRate = (uid: string) => {
  const now = Date.now();
  const recent = (sendWindows.get(uid) ?? []).filter(t => now - t < 10_000);
  if (recent.length >= 20) throw httpError(429, 'Too many messages. Please wait a moment and try again.');
  recent.push(now);
  sendWindows.set(uid, recent);
  if (sendWindows.size > 10_000) {
    for (const [key, timestamps] of sendWindows) {
      if (!timestamps.some(t => now - t < 10_000)) sendWindows.delete(key);
    }
  }
};

const normaliseAttachment = (actorUid: string, raw: any) => {
  if (!raw || typeof raw !== 'object') throw httpError(422, 'Attachment is malformed');
  const url = typeof raw.url === 'string' ? raw.url.trim() : '';
  if (!url || url.length > 2048) throw httpError(422, 'Attachment reference is invalid');

  const ownerPrefix = `${actorUid}_`;
  const legacyOwnedId = url.startsWith(ownerPrefix) && /^[A-Za-z0-9._:-]+$/.test(url);
  let ownedFirebaseUrl = false;
  if (!legacyOwnedId) {
    try {
      const parsed = new URL(url);
      const decodedPath = decodeURIComponent(parsed.pathname);
      const marker = '/o/chat-attachments/';
      const objectName = decodedPath.includes(marker) ? decodedPath.split(marker)[1] : '';
      const configuredBucket = firebaseConfig.storageBucket?.trim();
      ownedFirebaseUrl = parsed.protocol === 'https:' &&
        parsed.hostname === 'firebasestorage.googleapis.com' &&
        !!configuredBucket &&
        decodedPath.startsWith(`/v0/b/${configuredBucket}${marker}`) &&
        objectName.startsWith(ownerPrefix) &&
        /^[A-Za-z0-9._-]+$/.test(objectName);
    } catch { /* rejected below */ }
  }
  if (!legacyOwnedId && !ownedFirebaseUrl) {
    throw httpError(422, 'Attachment must come from your Servana chat upload');
  }

  const mimeType = typeof raw.mimeType === 'string' ? raw.mimeType.trim().toLowerCase() : null;
  if (mimeType && !ALLOWED_ATTACHMENT_MIMES.has(mimeType)) {
    throw httpError(422, 'Attachment type is not allowed');
  }
  const sizeBytes = raw.sizeBytes == null ? null : Number(raw.sizeBytes);
  if (sizeBytes !== null && (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > ATTACHMENT_BYTES_MAX)) {
    throw httpError(422, 'Attachment size is invalid');
  }
  const fileName = typeof raw.fileName === 'string'
    ? raw.fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100)
    : null;
  return { url, fileName: fileName || undefined, mimeType: mimeType || undefined, sizeBytes: sizeBytes ?? undefined };
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
  if (!access.canSend) {
    // 409 preserved for the closed case — the customer app and provider portal
    // both already branch on it. A read-only or archived conversation is the
    // same situation from the caller's point of view: the transcript is
    // readable, this write is not accepted.
    throw httpError(409, conversationClosedMessage(conversation));
  }

  const type = input.type || "text";
  const allowedTypes = new Set(["text", "image", "file"]);
  if (!allowedTypes.has(type)) throw httpError(422, "Message type is not allowed");

  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (body.length > MESSAGE_BODY_MAX) throw httpError(422, "Message is too long");
  if (/[^\t\n\r\x20-\uFFFF]/u.test(body)) throw httpError(422, 'Message contains unsupported control characters');
  const hasBody = body.length > 0;
  const hasAttachments = !!(input.attachments && input.attachments.length);
  if (type !== "system" && !hasBody && !hasAttachments) {
    throw httpError(422, "Message must have a body or an attachment");
  }

  const clientMsgId = input.clientMsgId?.trim();
  if (!clientMsgId || clientMsgId.length < 16 || clientMsgId.length > 128) {
    throw httpError(422, "A valid message idempotency key is required");
  }
  if (!/^[A-Za-z0-9._:-]+$/.test(clientMsgId)) {
    throw httpError(422, 'Message idempotency key contains unsupported characters');
  }

  // Idempotency: a retried send returns the original message.
  if (clientMsgId) {
    const existing = await repo.findMessageByClientId(conversationId, actor.uid, clientMsgId);
    if (existing) return hydrateMessage(existing);
  }

  assertSendRate(actor.uid);
  if ((input.attachments?.length ?? 0) > ATTACHMENT_MAX) {
    throw httpError(422, `A message can include at most ${ATTACHMENT_MAX} attachments`);
  }
  const attachments = (input.attachments ?? []).map(a => normaliseAttachment(actor.uid, a));

  // An admin who posts has joined the conversation in the operational sense —
  // record it so "who from Servana touched this booking" is answerable from
  // the participant list rather than by reading every message. Deliberately on
  // send and not on read: adding every admin who merely opened a thread would
  // put every active booking in every admin's inbox.
  if (access.role === "admin") {
    await repo.upsertParticipant(conversationId, actor.uid, actor.role);
  }

  const inserted = await repo.insertMessageIdempotent({
    conversationId,
    senderUid: actor.uid,
    senderRole: actor.role,
    type,
    body: hasBody ? body : null,
    metadata: {},
    clientMsgId,
  });

  if (!inserted.inserted) return hydrateMessage(inserted.message);
  const message = inserted.message;

  if (attachments.length) {
    for (const a of attachments) {
      await repo.insertAttachment(message.id, a);
    }
  }

  await repo.touchConversation(conversationId);

  const full = await hydrateMessage(message);
  emitToConversation(conversationId, "message:new", full);
  if (access.role !== "admin") {
    notifyAdminsSafely({
      type: 'new_chat_message', severity: 'info', title: 'New booking message',
      body: `A ${access.role === 'coworker' ? 'provider' : 'client'} sent a new message in booking chat.`,
      bookingId: conversation.booking_id ?? null, conversationId,
      notificationKey: `chat_message_${message.id}`,
    });
  }
  return full;
};

/**
 * Idempotent system message. Uses `eventKey` stored in `metadata.eventKey`
 * as the deduplication key — safe to call on every booking status transition.
 */
export const postSystemMessageOnce = async (
  conversationId: number,
  eventKey: string,
  body: string,
  metadata: any = {}
) => {
  const existing = await repo.findSystemMessage(conversationId, eventKey);
  if (existing) return existing;
  return postSystemMessage(conversationId, body, { ...metadata, eventKey });
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

  if (!Number.isSafeInteger(limit) || limit < 1) throw httpError(422, 'limit must be a positive integer');
  if (before !== undefined && (!Number.isSafeInteger(before) || before <= 0)) {
    throw httpError(422, 'before must be a positive message id');
  }
  const participant = access.role === 'admin' ? null : await repo.findParticipant(conversationId, actor.uid);
  const visibleAfter = participant?.joined_at ?? null;
  const boundedLimit = Math.min(limit, 100);
  const rows = await repo.listMessages(conversationId, boundedLimit, before, visibleAfter);
  const messages = await Promise.all(rows.map(hydrateMessage));
  const nextCursor = rows.length === boundedLimit ? rows[rows.length - 1].id : null;
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
  if (!access.canSend) throw httpError(409, conversationClosedMessage(conversation));

  const original = await repo.getMessageById(messageId);
  if (!original || original.conversation_id !== conversation.id) throw httpError(404, "Message not found");
  if (original.sender_uid !== actor.uid && access.role !== "admin") {
    throw httpError(403, "Can only edit your own messages");
  }
  if (original.type === 'system') throw httpError(409, 'System messages cannot be edited');
  const cleanBody = typeof body === 'string' ? body.trim() : '';
  if (!cleanBody) throw httpError(422, 'Message body is required');
  if (cleanBody.length > MESSAGE_BODY_MAX) throw httpError(422, 'Message is too long');
  if (/[^\t\n\r\x20-\uFFFF]/u.test(cleanBody)) throw httpError(422, 'Message contains unsupported control characters');

  const updated = await repo.editMessage(messageId, cleanBody);
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

  if (!Number.isSafeInteger(lastReadMessageId) || lastReadMessageId <= 0) {
    throw httpError(422, 'lastReadMessageId must be a positive message id');
  }
  const target = await repo.getMessageById(lastReadMessageId);
  if (!target || Number(target.conversation_id) !== conversationId) {
    throw httpError(422, 'Read pointer must reference a message in this conversation');
  }
  const updated = await repo.setLastRead(conversationId, actor.uid, lastReadMessageId);
  if (updated) {
    emitToConversation(conversationId, "message:read", {
      conversationId,
      userUid: actor.uid,
      lastReadMessageId,
    });
  }
};

// ---- Small error helper (carries an HTTP status) ---------------------------

// ---- Message reports -------------------------------------------------------

export const reportMessage = async (
  actor: ChatActor,
  conversationId: number,
  messageId: number,
  category: string,
  description: string,
): Promise<{ reportId: string }> => {
  const { access } = await resolveAccessForConversation(actor, conversationId);
  if (!access.allowed) throw httpError(403, "Not a participant of this conversation");
  if (!Number.isSafeInteger(messageId) || messageId <= 0) throw httpError(422, 'Invalid message id');
  const message = await repo.getMessageById(messageId);
  if (!message || Number(message.conversation_id) !== conversationId) {
    throw httpError(404, 'Message not found in this conversation');
  }
  if (message.type === 'system') throw httpError(422, 'System messages cannot be reported');
  const cleanCategory = typeof category === 'string' ? category.trim().toLowerCase() : '';
  if (!/^[a-z][a-z0-9_]{1,39}$/.test(cleanCategory)) throw httpError(422, 'Invalid report category');
  const cleanDescription = typeof description === 'string' ? description.trim() : '';
  if (cleanDescription.length > 1000) throw httpError(422, 'Report description is too long');
  const report = await repo.insertMessageReport({
    reporterUid: actor.uid,
    messageId,
    conversationId,
    category: cleanCategory,
    description: cleanDescription,
  });
  return { reportId: String(report.id) };
};

export interface HttpError extends Error {
  status: number;
}

export const httpError = (status: number, message: string): HttpError => {
  const e = new Error(message) as HttpError;
  e.status = status;
  return e;
};
