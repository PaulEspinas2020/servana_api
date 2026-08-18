import * as repo from "./chat.repository";
import { randomUUID } from "crypto";
import { uploadFileToStorage } from "../helpers/firebaseStorageUploader";
import { validateDataUri, AllowedUploadMime } from "../helpers/fileSignature";
import { emitToConversation, evictUserFromConversation } from "./chat.realtime";
import { toCamel } from "../helpers/idGenerator";
import { notifyAdminsSafely } from '../services/adminNotificationService';
import { createCustomerNotification, createNotification } from '../services/notification.service';
import { firebaseConfig } from '../config';
import {
  ATTACHMENT_POLICY,
  CLIENT_MESSAGE_ID,
  MESSAGE_PAGE,
  MESSAGE_BODY_MAX as POLICY_MESSAGE_BODY_MAX,
  SEND_RATE_LIMIT,
  SENDABLE_MESSAGE_TYPES,
  SEAT_OF_ACCESS_ROLE,
  mayWrite,
  messageReadFloor,
} from '../services/messaging/messagingPolicy';
import {
  recordDuplicateSuppressed,
  recordSendFailure,
} from '../services/messaging/messagingTelemetry';
import {
  buildMessageView,
  readPointersOf,
  type MessageView,
} from '../services/messaging/conversationDto';
import { publishEventSafely } from '../services/events/eventOutbox';
import { dispatchSoon } from '../services/events/notificationProjector';

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
  /**
   * When this provider's assignment began — the earliest message they may read.
   *
   * From `booking_workers`, the same row that granted access, so the floor
   * cannot disagree with the authorization. Null for admin and the customer,
   * who read the whole thread, and null for a denial.
   */
  assignedAt?: string | null;
  /** Their assignment is CURRENTLY active. Governs send, never read. */
  assignmentActive?: boolean;
  /**
   * Why `canSend` is false, in words a client may show.
   *
   * Carried on the result rather than recomputed at the call site: the v1
   * conversation DTO publishes it as `cannotSendReason`, and a transport layer
   * that decides for itself why a write was refused is a second implementation
   * of the rule that refused it.
   */
  sendRefusalReason?: string | null;
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
    /**
     * The window travels WITH the authorization, from the same table.
     *
     * Previously access came from `booking_workers` and the message floor came
     * from `chat_participants`, so the two could disagree — and when they did,
     * the disagreement resolved towards more access: a provider with no
     * participant row read the entire transcript, including the previous
     * provider's messages. Reading both from one row makes that unreachable.
     */
    const window = await repo.getProviderAssignmentWindow(bookingId, actor.uid);
    return {
      allowed: true, role: "coworker", canRead: true,
      // Send is the ACTIVE assignment, not a participant flag. A stale
      // `can_send = true` left behind by a failed membership update must not
      // let a departed provider keep messaging the customer.
      canSend: window?.active === true,
      wasParticipant: false,
      assignedAt: window?.assignedAt ?? null,
      assignmentActive: window?.active === true,
    };
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
  /**
   * `chat_participants` is a PROJECTION. It may narrow access and may never
   * widen it.
   *
   * A missing row therefore contributes nothing rather than defaulting to
   * permissive — the booking has already granted whatever is granted. The old
   * `row ? row.can_x !== false : true` said the opposite: no row meant full
   * capability, which is precisely the fail-open a dropped membership update
   * produced.
   */
  const rowCanRead = row ? row.can_read !== false : true;
  const rowCanSend = row ? row.can_send !== false : true;
  const stillPresent = row ? row.left_at == null : true;

  /**
   * Writability is DECIDED by the policy, not restated here.
   *
   * `mayWrite(status, seat)` is the same function the generated contract
   * document builds its state table from, so the table is evidence of this
   * behaviour rather than a description of it. `legacyIsClosed` carries the
   * pre-`status` boolean, which may only refuse.
   */
  const status = conversation.status || repo.CONVERSATION_STATUS.ACTIVE;
  const seat = SEAT_OF_ACCESS_ROLE[base.role as 'client' | 'coworker'];
  const writeDecision = mayWrite(status, seat, {
    legacyIsClosed: conversation.is_closed === true,
  });
  const writable = writeDecision.allowed;

  const canRead = rowCanRead;
  /**
   * Both sources must agree before a provider may send.
   *
   * `base.canSend` is the booking's answer — an ACTIVE assignment. The
   * participant row can only take that away. So a departed provider whose
   * stale row still reads `can_send = true` is refused by the booking side,
   * and a provider whose row is missing entirely is still governed by the
   * assignment.
   */
  const canSend = base.canSend && canRead && stillPresent && rowCanSend && writable;

  if (!canRead) return { access: deny(true), conversation };

  return {
    access: {
      allowed: true, role: base.role, canRead, canSend, wasParticipant: false,
      assignedAt: base.assignedAt ?? null,
      assignmentActive: base.assignmentActive === true,
      sendRefusalReason: canSend
        ? null
        : writeDecision.reason
          // The conversation is writable and this participant still cannot post:
          // their assignment ended, or their participant row revoked it.
          ?? 'You are no longer able to send messages in this conversation.',
    },
    conversation,
  };
};

// ---- Conversations ---------------------------------------------------------

/**
 * Human-readable reason a write was refused, for the 409 body.
 *
 * Asks the policy rather than switching on the status a second time. The strings
 * are unchanged — the customer app and the provider portal both show them.
 */
const conversationClosedMessage = (conversation: any, access?: AccessResult): string =>
  access?.sendRefusalReason
  ?? mayWrite(conversation?.status ?? repo.CONVERSATION_STATUS.ACTIVE, 'customer', {
    legacyIsClosed: conversation?.is_closed === true,
  }).reason
  ?? 'Conversation is closed';

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

/**
 * Hydrate a message row into THE message view.
 *
 * This used to be `toCamel(row)` with camelCased attachments stapled on, which
 * meant the realtime payload, the REST body and the admin portal each got
 * whatever columns the query happened to select. It now goes through
 * `buildMessageView`, the single builder in `services/messaging/conversationDto`
 * — the same one the canonical v1 DTO projects from. The legacy keys
 * (`senderRole`, `createdAt`, the full attachment rows) are all still present
 * and unchanged, because four shipped clients read them.
 *
 * `viewerUid`/`readPointers` are optional. When they are not supplied — the
 * broadcast case, where there is no single viewer — `isMine` is false and the
 * receipt counts are zero, which is the honest answer for a payload addressed
 * to a room rather than a person. A client renders `isMine` from `senderUid`
 * against its own identity anyway, which is the only place that comparison can
 * be correct for a broadcast.
 */
const hydrateMessage = async (
  row: any,
  context: { viewerUid?: string | null; bookingId?: number | string | null; readPointers?: ReadonlyArray<{ uid: string; lastReadMessageId: number | null }> } = {},
): Promise<MessageView> => {
  const attachments = await repo.listAttachments(row.id);
  return buildMessageView(row, attachments, {
    viewerUid: context.viewerUid ?? null,
    bookingId: context.bookingId ?? null,
    readPointers: context.readPointers,
  });
};

/**
 * Tell the OTHER participants that a message arrived.
 *
 * ## The gap this closes (SW-03)
 *
 * Until now `sendMessage` did exactly two things after persisting: emit
 * `message:new` over Socket.IO, and notify ADMINS. Neither reaches a provider's
 * phone — ServanaWorker has no Socket.IO client at all, and it does not poll —
 * so a customer's message reached the provider through **no channel**. They
 * discovered it only by opening Messages and pulling to refresh.
 *
 * `notification.service` already carried a `newMessage` push preference with no
 * producer, which is exactly what made this look wired.
 *
 * Riding the notification service rather than pushing directly is what makes
 * this reach installed builds with no client release: the row lands in the
 * inbox both apps already read, and the FCM push is sent by the same code that
 * sends every other one — including the per-type preference check, so a
 * provider who has turned `newMessage` off still gets the row and not the push.
 *
 * ## Rules it obeys
 *
 * - **§58.** The message BODY never travels. A push payload is readable by the
 *   OS on a lock screen, and this is a conversation between a customer and
 *   someone standing in their home. Only who-and-which-booking goes out.
 * - **§11, fail closed.** Recipients come from the BOOKING — the same source
 *   `resolveAccessForBooking` authorizes reads from — so a notification can
 *   never be sent to somebody who would be refused the transcript. Anyone whose
 *   participant row records a `left_at` is then subtracted, so a reassigned or
 *   declined provider stops hearing about the thread.
 * - **§17.** Keyed `chat_msg:<messageId>`, and both INSERTs are
 *   `ON CONFLICT DO NOTHING` per recipient, so a retried send cannot produce a
 *   second notification.
 * - **§45.** Fire-and-forget. A message that is already committed must not fail
 *   because a notification could not be written.
 *
 * ## Why the two sides get different routes
 *
 * The customer gets `CONVERSATION` + the conversation id: client mobile maps
 * that straight to the thread (`notification_target.dart`), and client web has
 * no such key so the notification renders un-clickable rather than wrong.
 *
 * The provider gets `page: 'messages'` and deliberately **no `bookingId`**.
 * ServanaWorker's `NotificationRouteResolver` prefers a booking id over a page
 * name and would open `JobDetailsView` — which has no chat entry point (PM-257),
 * so a tap would land them on a screen with no way to reach the message they
 * were told about. Without the id it falls back to the tab shell, where
 * Messages is one tap away. Restore the id once the job screen can open a
 * thread.
 */
export const messageNotificationRecipients = (input: {
  clientUid: string | null | undefined;
  workerUids: readonly string[];
  departedUids: readonly string[];
  senderUid: string;
}): { providers: string[]; customer: string | null } => {
  // Subtractive, not a membership requirement: a `left_at` is evidence that
  // someone LEFT, and the absence of a participant row is not evidence that
  // they are not on the booking. Requiring presence would silently drop the
  // customer on any conversation whose seeding predates their row.
  const departed = new Set(input.departedUids.map(String));
  const eligible = (uid: string | null | undefined): uid is string =>
    !!uid && uid !== input.senderUid && !departed.has(String(uid));

  const providers: string[] = [];
  for (const uid of input.workerUids) {
    // A booking can carry the same provider twice after a reassignment
    // (production booking 75 has two booking_workers rows), and two rows must
    // not become two notifications.
    if (eligible(uid) && !providers.includes(uid)) providers.push(uid);
  }

  return {
    providers,
    customer: eligible(input.clientUid) ? String(input.clientUid) : null,
  };
};

const notifyMessageRecipients = async (
  conversation: any,
  messageId: number | string,
  senderUid: string,
  senderRole: "client" | "coworker" | "admin" | null,
): Promise<void> => {
  const bookingId = conversation?.booking_id ?? null;
  if (!bookingId) return;

  const [clientUid, workerUids, participants] = await Promise.all([
    repo.getBookingClientUid(bookingId),
    repo.getBookingWorkerUids(bookingId),
    repo.listParticipants(conversation.id, true),
  ]);

  const { providers, customer } = messageNotificationRecipients({
    clientUid,
    workerUids: (workerUids ?? []) as string[],
    departedUids: (participants ?? [])
      .filter((p: any) => p.left_at != null)
      .map((p: any) => String(p.user_uid)),
    senderUid,
  });

  const code = `SVN-${String(bookingId).padStart(6, '0')}`;
  const notificationKey = `chat_msg:${messageId}`;
  const sender =
    senderRole === 'admin' ? 'Servana support'
      : senderRole === 'client' ? 'The customer'
        : 'Another provider';

  for (const uid of providers) {
    void createNotification(uid, {
      notificationKey,
      type: 'new_message',
      severity: 'info',
      title: 'New message',
      safeBody: `${sender} sent a message about booking ${code}.`,
      safeContextLabel: code,
      route: { page: 'messages' },
      canOpenDetail: true,
    }).catch((e: any) =>
      console.error('[chat] provider message notification failed:', e?.message));
  }

  if (customer) {
    const toCustomer = senderRole === 'admin' ? 'Servana support' : 'Your provider';
    void createCustomerNotification(customer, {
      notificationKey,
      type: 'new_message',
      severity: 'info',
      title: 'New message',
      safeBody: `${toCustomer} sent you a message about booking ${code}.`,
      safeContextLabel: code,
      route: { routeKey: 'CONVERSATION', resourceId: String(conversation.id) },
      canOpenDetail: true,
    }).catch((e: any) =>
      console.error('[chat] customer message notification failed:', e?.message));
  }
};

/**
 * The message limits, taken from the policy rather than restated.
 *
 * These four numbers previously lived here as literals and again in the
 * hardening test as regexes, which is two places and no declaration. They are
 * now one declaration with three readers — this module, the generated contract
 * document, and the tests.
 */
const MESSAGE_BODY_MAX = POLICY_MESSAGE_BODY_MAX;
const MESSAGE_PAGE_MAX = MESSAGE_PAGE.maxLimit;
const ATTACHMENT_MAX = ATTACHMENT_POLICY.maxPerMessage;
const ATTACHMENT_BYTES_MAX = ATTACHMENT_POLICY.maxBytes;
const ALLOWED_ATTACHMENT_MIMES = new Set<string>(ATTACHMENT_POLICY.allowedMimeTypes);
const sendWindows = new Map<string, number[]>();

const assertSendRate = (uid: string) => {
  const now = Date.now();
  const { windowMs, maxMessages } = SEND_RATE_LIMIT;
  const recent = (sendWindows.get(uid) ?? []).filter(t => now - t < windowMs);
  if (recent.length >= maxMessages) {
    throw httpError(429, 'Too many messages. Please wait a moment and try again.', 'MESSAGE_RATE_LIMITED');
  }
  recent.push(now);
  sendWindows.set(uid, recent);
  if (sendWindows.size > 10_000) {
    for (const [key, timestamps] of sendWindows) {
      if (!timestamps.some(t => now - t < windowMs)) sendWindows.delete(key);
    }
  }
};

const normaliseAttachment = (actorUid: string, raw: any) => {
  if (!raw || typeof raw !== 'object') throw httpError(422, 'Attachment is malformed', 'ATTACHMENT_REJECTED');
  const url = typeof raw.url === 'string' ? raw.url.trim() : '';
  if (!url || url.length > 2048) throw httpError(422, 'Attachment reference is invalid', 'ATTACHMENT_REJECTED');

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
    throw httpError(422, 'Attachment must come from your Servana chat upload', 'ATTACHMENT_REJECTED');
  }

  const mimeType = typeof raw.mimeType === 'string' ? raw.mimeType.trim().toLowerCase() : null;
  if (mimeType && !ALLOWED_ATTACHMENT_MIMES.has(mimeType)) {
    throw httpError(422, 'Attachment type is not allowed', 'ATTACHMENT_REJECTED');
  }
  const sizeBytes = raw.sizeBytes == null ? null : Number(raw.sizeBytes);
  if (sizeBytes !== null && (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > ATTACHMENT_BYTES_MAX)) {
    throw httpError(422, 'Attachment size is invalid', 'ATTACHMENT_REJECTED');
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
  if (!conversation) {
    recordSendFailure('CONVERSATION_NOT_FOUND');
    throw httpError(404, "Conversation not found", 'CONVERSATION_NOT_FOUND');
  }
  if (!access.allowed) {
    recordSendFailure('CONVERSATION_ACCESS_DENIED');
    throw httpError(403, "Not a participant of this conversation", 'CONVERSATION_ACCESS_DENIED');
  }
  if (!access.canSend) {
    // 409 preserved for the closed case — the customer app and provider portal
    // both already branch on it. A read-only or archived conversation is the
    // same situation from the caller's point of view: the transcript is
    // readable, this write is not accepted.
    recordSendFailure('CONVERSATION_NOT_WRITABLE');
    throw httpError(409, conversationClosedMessage(conversation, access), 'CONVERSATION_NOT_WRITABLE');
  }

  const type = input.type || "text";
  if (!(SENDABLE_MESSAGE_TYPES as readonly string[]).includes(type)) {
    recordSendFailure('MESSAGE_TYPE_NOT_ALLOWED');
    throw httpError(422, "Message type is not allowed", 'MESSAGE_TYPE_NOT_ALLOWED');
  }

  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (body.length > MESSAGE_BODY_MAX) throw httpError(422, "Message is too long", 'MESSAGE_TOO_LONG');
  if (/[^\t\n\r\x20-\uFFFF]/u.test(body)) throw httpError(422, 'Message contains unsupported control characters', 'MESSAGE_CONTROL_CHARACTERS');
  const hasBody = body.length > 0;
  const hasAttachments = !!(input.attachments && input.attachments.length);
  if (type !== "system" && !hasBody && !hasAttachments) {
    throw httpError(422, "Message must have a body or an attachment", 'MESSAGE_EMPTY');
  }

  const clientMsgId = input.clientMsgId?.trim();
  if (
    !clientMsgId
    || clientMsgId.length < CLIENT_MESSAGE_ID.minLength
    || clientMsgId.length > CLIENT_MESSAGE_ID.maxLength
  ) {
    recordSendFailure('CLIENT_MSG_ID_INVALID');
    throw httpError(422, "A valid message idempotency key is required", 'CLIENT_MSG_ID_INVALID');
  }
  if (!new RegExp(CLIENT_MESSAGE_ID.pattern).test(clientMsgId)) {
    recordSendFailure('CLIENT_MSG_ID_INVALID');
    throw httpError(422, 'Message idempotency key contains unsupported characters', 'CLIENT_MSG_ID_INVALID');
  }

  // Idempotency: a retried send returns the original message.
  if (clientMsgId) {
    const existing = await repo.findMessageByClientId(conversationId, actor.uid, clientMsgId);
    if (existing) {
      // Counted, not treated as a failure — this is the retry path working. A
      // rising rate means clients are timing out on writes that do succeed.
      recordDuplicateSuppressed();
      return hydrateMessage(existing);
    }
  }

  assertSendRate(actor.uid);
  if ((input.attachments?.length ?? 0) > ATTACHMENT_MAX) {
    throw httpError(422, `A message can include at most ${ATTACHMENT_MAX} attachments`, 'ATTACHMENT_REJECTED');
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

  if (!inserted.inserted) {
    // The pre-read above missed and the unique index caught it: two devices
    // sending the same clientMsgId at the same moment. Same outcome, same
    // counter — the original message, once.
    recordDuplicateSuppressed();
    return hydrateMessage(inserted.message);
  }
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
  // The other side of the conversation. Admins were already told above; until
  // now the people actually talking to each other were not. See SW-03.
  void notifyMessageRecipients(conversation, message.id, actor.uid, access.role)
    .catch((e: any) => console.error('[chat] message notification failed:', e?.message));

  /**
   * The canonical domain event (TAB 09).
   *
   * Published BESIDE `notifyMessageRecipients`, not instead of it, and the
   * projection uses the identical `chat_msg:{messageId}` key — so the
   * owner-scoped unique index collapses the two producers into exactly one
   * notification whichever wins the race. That is what lets the event layer
   * become the producer without a flag day, and it is asserted in
   * `tests/notification-dedup.test.ts` rather than assumed.
   *
   * `publishEventSafely` never throws: the message is already committed, and
   * §45 says a committed fact must not fail because its announcement did.
   */
  void publishEventSafely({
    name: 'MessageReceived',
    refs: {
      conversationId,
      messageId: message.id,
      bookingId: conversation.booking_id,
    },
    display: {
      bookingCode: `SVN-${String(conversation.booking_id ?? 0).padStart(6, '0')}`,
    },
    // The sender, so the projector does not tell somebody they sent a message.
    // The BODY never travels — a push payload is readable on a lock screen, and
    // this is a conversation between a customer and someone in their home.
    metadata: { actorUid: actor.uid, senderSeat: access.role },
    dedupeKey: `MessageReceived:${message.id}`,
  }).then(() => dispatchSoon());

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

export interface MessagePage {
  messages: MessageView[];
  nextCursor: number | null;
  /** The resolved access, so a caller need not authorize a second time. */
  access: AccessResult;
  conversation: any;
  /** The limit actually applied after clamping. */
  limit: number;
}

/**
 * The transcript read, once.
 *
 * `getMessages` below is the legacy projection of this — same authorization,
 * same query, same builder, narrower return. The canonical v1 handler calls
 * THIS, so the two endpoints cannot page differently, apply different floors, or
 * disagree about what a message looks like.
 */
export const getMessagePage = async (
  actor: ChatActor,
  conversationId: number,
  limit = MESSAGE_PAGE.defaultLimit,
  before?: number
): Promise<MessagePage> => {
  const { access, conversation } = await resolveAccessForConversation(actor, conversationId);
  if (!conversation) throw httpError(404, "Conversation not found", 'CONVERSATION_NOT_FOUND');
  if (!access.allowed) throw httpError(403, "Not a participant of this conversation", 'CONVERSATION_ACCESS_DENIED');

  if (!Number.isSafeInteger(limit) || limit < 1) throw httpError(422, 'limit must be a positive integer', 'PAGE_PARAMETER_INVALID');
  if (before !== undefined && (!Number.isSafeInteger(before) || before <= 0)) {
    throw httpError(422, 'before must be a positive message id', 'PAGE_PARAMETER_INVALID');
  }
  /**
   * The read floor, DECIDED by the policy from the ASSIGNMENT.
   *
   * Admin and the customer read the whole thread: the audit trail is the point
   * for one, and it is their own conversation for the other. A provider reads
   * from their `assigned_at` onward, and a missing timestamp FAILS CLOSED —
   * a null floor used to mean "no floor", which is how a provider with no
   * participant row came to read the previous provider's entire conversation.
   *
   * `messageReadFloor` is the same function the generated document renders its
   * visibility table from, so the table cannot describe a floor this code does
   * not apply.
   */
  const seat = SEAT_OF_ACCESS_ROLE[(access.role ?? 'coworker') as 'client' | 'coworker' | 'admin'];
  const floor = messageReadFloor(seat, access.assignedAt ?? null);
  if (floor.mode === 'denied') {
    throw httpError(403, floor.reason ?? 'Message history is not available for this assignment', 'MESSAGE_HISTORY_UNAVAILABLE');
  }
  const visibleAfter: string | null = floor.since;
  const boundedLimit = Math.min(limit, MESSAGE_PAGE_MAX);
  const rows = await repo.listMessages(conversationId, boundedLimit, before, visibleAfter);

  // Read pointers come from the ACTIVE participants, so the receipt counts on
  // every message in the page are derived from one load rather than one query
  // per message.
  const participants = await repo.listParticipants(conversationId, false);
  const readPointers = readPointersOf(participants);

  const messages = await Promise.all(
    rows.map((row: any) =>
      hydrateMessage(row, {
        viewerUid: actor.uid,
        bookingId: conversation.booking_id ?? null,
        readPointers,
      }),
    ),
  );
  const nextCursor = rows.length === boundedLimit ? Number(rows[rows.length - 1].id) : null;
  return { messages, nextCursor, access, conversation, limit: boundedLimit };
};

/**
 * The legacy transcript shape. `{ messages, nextCursor }` and nothing else —
 * `chat.controller` spreads this straight into its response body, so anything
 * added here becomes a public field of a route four clients read.
 */
export const getMessages = async (
  actor: ChatActor,
  conversationId: number,
  limit = MESSAGE_PAGE.defaultLimit,
  before?: number
) => {
  const page = await getMessagePage(actor, conversationId, limit, before);
  return { messages: page.messages, nextCursor: page.nextCursor };
};

export const editMessage = async (
  actor: ChatActor,
  conversationId: number,
  messageId: number,
  body: string
) => {
  const { access, conversation } = await resolveAccessForConversation(actor, conversationId);
  if (!conversation) throw httpError(404, "Conversation not found", 'CONVERSATION_NOT_FOUND');
  if (!access.allowed) throw httpError(403, "Not allowed", 'CONVERSATION_ACCESS_DENIED');
  if (!access.canSend) throw httpError(409, conversationClosedMessage(conversation, access), 'CONVERSATION_NOT_WRITABLE');

  const original = await repo.getMessageById(messageId);
  if (!original || original.conversation_id !== conversation.id) throw httpError(404, "Message not found", 'MESSAGE_NOT_FOUND');
  if (original.sender_uid !== actor.uid && access.role !== "admin") {
    throw httpError(403, "Can only edit your own messages", 'MESSAGE_NOT_EDITABLE');
  }
  if (original.type === 'system') throw httpError(409, 'System messages cannot be edited', 'MESSAGE_NOT_EDITABLE');
  const cleanBody = typeof body === 'string' ? body.trim() : '';
  if (!cleanBody) throw httpError(422, 'Message body is required', 'MESSAGE_EMPTY');
  if (cleanBody.length > MESSAGE_BODY_MAX) throw httpError(422, 'Message is too long');
  if (/[^\t\n\r\x20-\uFFFF]/u.test(cleanBody)) throw httpError(422, 'Message contains unsupported control characters', 'MESSAGE_CONTROL_CHARACTERS');

  const updated = await repo.editMessage(messageId, cleanBody);
  if (!updated) throw httpError(409, "Message cannot be edited", 'MESSAGE_NOT_EDITABLE');
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
  if (!conversation) throw httpError(404, "Conversation not found", 'CONVERSATION_NOT_FOUND');
  if (!access.allowed) throw httpError(403, "Not allowed", 'CONVERSATION_ACCESS_DENIED');

  const original = await repo.getMessageById(messageId);
  if (!original || original.conversation_id !== conversation.id) throw httpError(404, "Message not found", 'MESSAGE_NOT_FOUND');
  if (original.sender_uid !== actor.uid && access.role !== "admin") {
    throw httpError(403, "Can only delete your own messages", 'MESSAGE_NOT_EDITABLE');
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
  if (!conversation) throw httpError(404, "Conversation not found", 'CONVERSATION_NOT_FOUND');
  if (!access.allowed) throw httpError(403, "Not a participant of this conversation", 'CONVERSATION_ACCESS_DENIED');

  if (!Number.isSafeInteger(lastReadMessageId) || lastReadMessageId <= 0) {
    throw httpError(422, 'lastReadMessageId must be a positive message id', 'READ_POINTER_INVALID');
  }
  const target = await repo.getMessageById(lastReadMessageId);
  if (!target || Number(target.conversation_id) !== conversationId) {
    throw httpError(422, 'Read pointer must reference a message in this conversation', 'READ_POINTER_INVALID');
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

/**
 * The chat attachment allowlist and ceiling.
 *
 * Lived in `chat.controller` as two module-private constants, so the only way
 * for a second entry point to honour them was to re-declare them. Exported here
 * because that is now the point: the v1 route and the legacy route must not be
 * able to disagree about what a chat attachment may be.
 */
export const ALLOWED_CHAT_MIMES: readonly AllowedUploadMime[] = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
];

export const MAX_CHAT_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export interface AttachmentUploadResult {
  attachmentId: string;
  previewUrl: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

/**
 * Validate, store and describe one chat attachment.
 *
 * ## Why this moved out of the controller
 *
 * Every byte of this was inline in `chat.controller.uploadAttachment`, which
 * meant the v1 endpoint had two options: call the legacy controller, or copy
 * the validation. A copy of a MIME allowlist and a size ceiling is the shape of
 * duplication that drifts silently and is only discovered by the file that gets
 * through.
 *
 * ## The access check is no longer optional
 *
 * The legacy handler checks conversation access only `if (rawConversationId
 * !== undefined)` — the caller decides whether to be checked. Omitting the
 * field skipped the check entirely and still returned a stored file and a URL.
 * Here `conversationId` is a required argument, so the check always runs, and
 * the v1 route carries it in the PATH where it cannot be left out.
 *
 * Legacy keeps its optional parameter and its exact behaviour: this function
 * takes `conversationId: number | null` and the legacy controller passes null
 * when the client omitted it. Same code, same answer, and the tightening is
 * bound to the new route rather than applied retroactively to shipped clients.
 */
export const uploadAttachment = async (
  actor: ChatActor,
  conversationId: number | null,
  input: { file: unknown; name: unknown },
): Promise<AttachmentUploadResult> => {
  const { file, name } = input;
  if (!file || !name) {
    throw httpError(400, "file (data URI) and name are required", 'ATTACHMENT_REJECTED');
  }

  const validation = validateDataUri(file, {
    allowed: ALLOWED_CHAT_MIMES,
    maxBytes: MAX_CHAT_ATTACHMENT_BYTES,
  });
  if (!validation.ok) {
    throw httpError(422, validation.message, 'ATTACHMENT_REJECTED');
  }

  if (conversationId !== null) {
    const { access } = await resolveAccessForConversation(actor, conversationId);
    if (!access.allowed || !access.canSend) {
      throw httpError(403, 'Cannot upload to this conversation', 'CONVERSATION_ACCESS_DENIED');
    }
  }

  const sanitizedName =
    String(name).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || 'attachment';
  const storageKey = `${actor.uid}_${randomUUID()}`;
  // `file` is `unknown` at the boundary and `validateDataUri` above has already
  // proven it is a well-formed data URI of an allowed type and size. Narrowing
  // here rather than widening the uploader's parameter keeps that proof local.
  const previewUrl = await uploadFileToStorage("chat-attachments", storageKey, String(file));

  return {
    attachmentId: storageKey,
    previewUrl,
    fileName: sanitizedName,
    mimeType: validation.mime,
    sizeBytes: validation.bytes,
  };
};

export const reportMessage = async (
  actor: ChatActor,
  conversationId: number,
  messageId: number,
  category: string,
  description: string,
): Promise<{ reportId: string }> => {
  const { access } = await resolveAccessForConversation(actor, conversationId);
  if (!access.allowed) throw httpError(403, "Not a participant of this conversation", 'CONVERSATION_ACCESS_DENIED');
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

/**
 * The refusal vocabulary.
 *
 * The legacy chat routes answer `{ success: false, message }` and a status, and
 * that is all four shipped clients have ever had to branch on. The canonical v1
 * endpoints answer a CODE, and deriving one from an English message would be a
 * transport layer re-deciding a domain question by string matching.
 *
 * So the refusal travels WITH the error. `status` and `message` are unchanged —
 * the legacy responses are byte-identical — and `code` is additive, read only by
 * `api/v1/domains/conversations.ts`, which renames it into the v1 enum and never
 * re-evaluates the policy that produced it.
 */
export type MessagingRefusalCode =
  | 'CONVERSATION_NOT_FOUND'
  | 'CONVERSATION_ACCESS_DENIED'
  | 'CONVERSATION_NOT_WRITABLE'
  | 'MESSAGE_HISTORY_UNAVAILABLE'
  | 'MESSAGE_INVALID'
  | 'MESSAGE_TYPE_NOT_ALLOWED'
  | 'MESSAGE_TOO_LONG'
  | 'MESSAGE_CONTROL_CHARACTERS'
  | 'MESSAGE_EMPTY'
  | 'CLIENT_MSG_ID_INVALID'
  | 'ATTACHMENT_REJECTED'
  | 'MESSAGE_RATE_LIMITED'
  | 'MESSAGE_NOT_FOUND'
  | 'MESSAGE_NOT_EDITABLE'
  | 'READ_POINTER_INVALID'
  | 'PAGE_PARAMETER_INVALID';

export interface HttpError extends Error {
  status: number;
  code?: MessagingRefusalCode;
}

export const httpError = (
  status: number,
  message: string,
  code?: MessagingRefusalCode,
): HttpError => {
  const e = new Error(message) as HttpError;
  e.status = status;
  if (code) e.code = code;
  return e;
};
