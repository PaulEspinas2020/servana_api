import { db } from "../config";
import dbQuery from "../db/dbQuery";
import {
  CONVERSATION_STATUS,
  WRITABLE_STATUSES,
  type ConversationStatus,
} from "../services/messaging/messagingPolicy";

const dbSchema = db.schema;

/**
 * The lifecycle vocabulary now DECLARED in `services/messaging/messagingPolicy`
 * and re-exported here, unchanged, because that is where every existing caller
 * imports it from.
 *
 * The declaration moved for one reason: this module imports `../config`, so
 * anything living here needs a database to be read at all — which put the
 * conversation policy out of reach of the docs generator and forced every test
 * that wanted to check a rule to mock pg first. The policy module has no
 * imports, so it can be executed. Nothing about the values changed.
 */
export { CONVERSATION_STATUS, WRITABLE_STATUSES };
export type { ConversationStatus };

/**
 * All chat SQL lives here. Queries are parameterized ($1, $2 ...) and
 * schema-prefixed, matching the rest of the codebase (bookingService, etc.).
 */

// ---- Conversations ---------------------------------------------------------

export const findConversationByBookingId = async (bookingId: number) => {
  const r = await dbQuery.query(
    `SELECT * FROM ${dbSchema}.chat_conversations WHERE booking_id = $1`,
    [bookingId]
  );
  return r.rows[0] || null;
};

export const findConversationById = async (conversationId: number) => {
  const r = await dbQuery.query(
    `SELECT * FROM ${dbSchema}.chat_conversations WHERE id = $1`,
    [conversationId]
  );
  return r.rows[0] || null;
};

export const createConversation = async (bookingId: number) => {
  const r = await dbQuery.query(
    `INSERT INTO ${dbSchema}.chat_conversations (booking_id)
     VALUES ($1)
     ON CONFLICT (booking_id) DO UPDATE SET booking_id = EXCLUDED.booking_id
     RETURNING *`,
    [bookingId]
  );
  return r.rows[0];
};

export const closeConversation = async (conversationId: number) => {
  const r = await dbQuery.query(
    `UPDATE ${dbSchema}.chat_conversations
     SET is_closed = TRUE, updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [conversationId]
  );
  return r.rows[0] || null;
};

export const touchConversation = async (conversationId: number) => {
  await dbQuery.query(
    `UPDATE ${dbSchema}.chat_conversations
     SET last_message_at = now(), updated_at = now()
     WHERE id = $1`,
    [conversationId]
  );
};

// ---- Booking-derived access facts -----------------------------------------

/** The client (booking owner) uid for a booking. */
export const getBookingClientUid = async (bookingId: number) => {
  const r = await dbQuery.query(
    `SELECT user_id FROM ${dbSchema}.bookings WHERE id = $1`,
    [bookingId]
  );
  return r.rows[0]?.user_id || null;
};

/**
 * Worker statuses that still confer active chat membership.
 *
 * EN_ROUTE and ARRIVED were missing here until 2026-08-07. They are written by
 * `technicianService.advanceArrivalStage` (ACCEPTED -> EN_ROUTE -> ARRIVED), so
 * a provider lost chat the moment they tapped "On my way" and got it back only
 * once the job reached IN_PROGRESS — precisely the window where "I'm at the
 * gate" / "which unit?" / "running late" have to get through. The customer's
 * messages kept arriving; the provider could neither read nor answer them.
 *
 * Keep this list in sync with the lifecycle in technicianService.
 */
export const ACTIVE_WORKER_STATUSES = [
  'ASSIGNED',
  'ACCEPTED',
  'EN_ROUTE',
  'ARRIVED',
  'IN_PROGRESS',
  'COMPLETED',
] as const;

/** Active worker uids assigned to a booking. */
export const getBookingWorkerUids = async (bookingId: number): Promise<string[]> => {
  const r = await dbQuery.query(
    `SELECT worker_uid
       FROM ${dbSchema}.booking_workers
      WHERE booking_id = $1
        AND status = ANY($2::text[])`,
    [bookingId, ACTIVE_WORKER_STATUSES as unknown as string[]]
  );
  return r.rows.map((row: any) => row.worker_uid).filter(Boolean);
};

/**
 * Worker uids that WERE on this booking but are no longer active — reassigned
 * away, declined, or cancelled. Used to distinguish "never had access" (deny
 * with 404) from "had access and lost it" (deny with 403, and eligible for
 * read-only historical scope where policy allows it).
 */
export const getFormerBookingWorkerUids = async (bookingId: number): Promise<string[]> => {
  const r = await dbQuery.query(
    `SELECT worker_uid
       FROM ${dbSchema}.booking_workers
      WHERE booking_id = $1
        AND NOT (status = ANY($2::text[]))`,
    [bookingId, ACTIVE_WORKER_STATUSES as unknown as string[]]
  );
  return r.rows.map((row: any) => row.worker_uid).filter(Boolean);
};

/**
 * The acting provider's ASSIGNMENT window, straight from `booking_workers`.
 *
 * This is the authorization source of record. `chat_participants` is a
 * projection of it — repairable, and never permitted to widen what this says.
 *
 * Returns the LATEST active assignment. A reassignment can leave a provider
 * with two rows on one booking (production booking 75 has exactly that), and
 * the current grant is the newest active one, not the first.
 */
export const getProviderAssignmentWindow = async (
  bookingId: number,
  providerUid: string,
): Promise<{ assignedAt: string | null; active: boolean } | null> => {
  const r = await dbQuery.query(
    `SELECT assigned_at, status
       FROM ${dbSchema}.booking_workers
      WHERE booking_id = $1 AND worker_uid = $2
      ORDER BY (status = ANY($3::text[])) DESC, assigned_at DESC NULLS LAST, id DESC
      LIMIT 1`,
    [bookingId, providerUid, ACTIVE_WORKER_STATUSES as unknown as string[]],
  );
  if (!r.rows.length) return null;
  const row = r.rows[0];
  return {
    // Timestamps come back as strings (see the pg type parsers), which is what
    // listMessages wants for its ::timestamptz bind.
    assignedAt: row.assigned_at ?? null,
    active: (ACTIVE_WORKER_STATUSES as readonly string[]).includes(String(row.status)),
  };
};

/** Numeric role for a user, cast to int (role column is stored as text/num). */
export const getUserRole = async (uid: string): Promise<number | null> => {
  const r = await dbQuery.query(
    `SELECT role::int AS role FROM ${dbSchema}.user_credentials WHERE uid = $1`,
    [uid]
  );
  return r.rows.length ? Number(r.rows[0].role) : null;
};

// ---- Participants ----------------------------------------------------------

export const upsertParticipant = async (
  conversationId: number,
  userUid: string,
  role: number
) => {
  const r = await dbQuery.query(
    `INSERT INTO ${dbSchema}.chat_participants (conversation_id, user_uid, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (conversation_id, user_uid)
       DO UPDATE SET role = EXCLUDED.role,
                     joined_at = CASE
                       WHEN ${dbSchema}.chat_participants.left_at IS NOT NULL THEN NOW()
                       ELSE ${dbSchema}.chat_participants.joined_at
                     END,
                     left_at = NULL,
                     can_read = TRUE,
                     can_send = TRUE
     RETURNING *`,
    [conversationId, userUid, role]
  );
  return r.rows[0];
};

export const listParticipants = async (conversationId: number, includeDeparted = false) => {
  const r = await dbQuery.query(
    `SELECT p.*, u.first_name, u.last_name, up.photo_url
       FROM ${dbSchema}.chat_participants p
       LEFT JOIN ${dbSchema}.user_credentials u ON u.uid = p.user_uid
       LEFT JOIN ${dbSchema}.user_profile up ON up.uid = p.user_uid
      WHERE p.conversation_id = $1
        AND ($2::boolean = TRUE OR p.left_at IS NULL)
      ORDER BY p.joined_at ASC`,
    [conversationId, includeDeparted]
  );
  return r.rows;
};

export const setLastRead = async (
  conversationId: number,
  userUid: string,
  lastReadMessageId: number
) => {
  const r = await dbQuery.query(
    `UPDATE ${dbSchema}.chat_participants p
        SET last_read_message_id = $3,
            last_read_at = now()
      WHERE p.conversation_id = $1 AND p.user_uid = $2
        AND (p.last_read_message_id IS NULL OR p.last_read_message_id < $3)
        AND EXISTS (
          SELECT 1 FROM ${dbSchema}.chat_messages m
           WHERE m.id = $3
             AND m.conversation_id = $1
             AND m.created_at >= p.joined_at
        )
      RETURNING p.last_read_message_id`,
    [conversationId, userUid, lastReadMessageId]
  );
  return r.rowCount > 0;
};

// ---- Messages --------------------------------------------------------------

export const insertMessage = async (input: {
  conversationId: number;
  senderUid: string | null;
  senderRole: number | null;
  type: string;
  body: string | null;
  metadata?: any;
  clientMsgId?: string | null;
}) => {
  const r = await dbQuery.query(
    `INSERT INTO ${dbSchema}.chat_messages
       (conversation_id, sender_uid, sender_role, type, body, metadata, client_msg_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING *`,
    [
      input.conversationId,
      input.senderUid,
      input.senderRole,
      input.type,
      input.body,
      input.metadata || {},
      input.clientMsgId || null,
    ]
  );
  return r.rows[0];
};

/**
 * Atomic user-message insert. The pre-read in chat.service is a fast path, but
 * only this database constraint closes the two-device race.
 */
export const insertMessageIdempotent = async (input: {
  conversationId: number;
  senderUid: string;
  senderRole: number;
  type: string;
  body: string | null;
  metadata?: any;
  clientMsgId: string;
}): Promise<{ message: any; inserted: boolean }> => {
  const r = await dbQuery.query(
    `INSERT INTO ${dbSchema}.chat_messages
       (conversation_id, sender_uid, sender_role, type, body, metadata, client_msg_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (conversation_id, sender_uid, client_msg_id)
       WHERE client_msg_id IS NOT NULL
       DO NOTHING
     RETURNING *`,
    [
      input.conversationId,
      input.senderUid,
      input.senderRole,
      input.type,
      input.body,
      input.metadata || {},
      input.clientMsgId,
    ]
  );
  if (r.rows[0]) return { message: r.rows[0], inserted: true };
  const existing = await findMessageByClientId(
    input.conversationId,
    input.senderUid,
    input.clientMsgId
  );
  if (!existing) throw new Error("Idempotent message insert could not reconcile");
  return { message: existing, inserted: false };
};

export const findMessageByClientId = async (
  conversationId: number,
  senderUid: string,
  clientMsgId: string
) => {
  const r = await dbQuery.query(
    `SELECT * FROM ${dbSchema}.chat_messages
      WHERE conversation_id = $1 AND sender_uid = $2 AND client_msg_id = $3`,
    [conversationId, senderUid, clientMsgId]
  );
  return r.rows[0] || null;
};

export const getMessageById = async (messageId: number) => {
  const r = await dbQuery.query(
    `SELECT * FROM ${dbSchema}.chat_messages WHERE id = $1`,
    [messageId]
  );
  return r.rows[0] || null;
};

/** Keyset pagination: pass `before` (a message id) to page backwards. */
export const listMessages = async (
  conversationId: number,
  limit: number,
  before?: number,
  visibleAfter?: string | null,
) => {
  const params: any[] = [conversationId, limit, before ?? null, visibleAfter ?? null];
  const r = await dbQuery.query(
    `SELECT * FROM ${dbSchema}.chat_messages
      WHERE conversation_id = $1
        AND ($3::bigint IS NULL OR id < $3)
        AND ($4::timestamptz IS NULL OR created_at >= $4)
      ORDER BY id DESC
      LIMIT $2`,
    params
  );
  return r.rows;
};

export const editMessage = async (messageId: number, body: string) => {
  const r = await dbQuery.query(
    `UPDATE ${dbSchema}.chat_messages
     SET body = $2, edited_at = now()
     WHERE id = $1 AND deleted_at IS NULL
     RETURNING *`,
    [messageId, body]
  );
  return r.rows[0] || null;
};

export const softDeleteMessage = async (messageId: number) => {
  const r = await dbQuery.query(
    `UPDATE ${dbSchema}.chat_messages
     SET deleted_at = now(), body = NULL
     WHERE id = $1
     RETURNING *`,
    [messageId]
  );
  return r.rows[0] || null;
};

// ---- Attachments -----------------------------------------------------------

export const insertAttachment = async (
  messageId: number,
  a: { url: string; fileName?: string; mimeType?: string; sizeBytes?: number; width?: number; height?: number }
) => {
  const r = await dbQuery.query(
    `INSERT INTO ${dbSchema}.chat_message_attachments
       (message_id, url, file_name, mime_type, size_bytes, width, height)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING *`,
    [messageId, a.url, a.fileName || null, a.mimeType || null, a.sizeBytes || null, a.width || null, a.height || null]
  );
  return r.rows[0];
};

export const listAttachments = async (messageId: number) => {
  const r = await dbQuery.query(
    `SELECT a.* FROM ${dbSchema}.chat_message_attachments a
       JOIN ${dbSchema}.chat_messages m ON m.id = a.message_id
      WHERE a.message_id = $1 AND m.deleted_at IS NULL`,
    [messageId]
  );
  return r.rows;
};

// ---- Inbox / conversation list --------------------------------------------

/**
 * Conversations a participant belongs to, newest activity first, + unread count.
 *
 * `p.left_at IS NULL` was missing until 2026-08-07. Because nothing ever called
 * `removeParticipant`, a reassigned provider kept their participant row AND
 * appeared in this list — so their inbox still showed the customer's name, the
 * last-activity time and an unread badge for a booking they had been removed
 * from. Opening it correctly 403'd (access is booking-derived), which made the
 * leak metadata-only, but it was a leak and the ghost rows were unopenable.
 *
 * Two guards, deliberately: `left_at IS NULL` covers explicit removal, and
 * `can_read` covers policy-driven revocation without a removal.
 */
/**
 * THE unread expression. One string, two call sites, no second opinion.
 *
 * `UNREAD_DEFINITION` in `messagingPolicy` states these five clauses in prose;
 * this is the same five in SQL. They were previously written out once inside
 * the inbox query and nowhere else, which meant the badge had a definition and
 * the thread had none — so nothing could disagree with it and nothing could
 * check it either. `countUnreadFor` below computes the SAME number for a single
 * conversation, and `messagingService` compares the two and reports drift.
 *
 * `$1` is the participant uid; `c`/`p` are the conversation and participant rows
 * in scope at the call site.
 */
const UNREAD_COUNT_SQL = `
  (SELECT COUNT(*) FROM ${dbSchema}.chat_messages m
     WHERE m.conversation_id = c.id
       AND m.deleted_at IS NULL
       AND m.created_at >= p.joined_at
       AND (p.last_read_message_id IS NULL OR m.id > p.last_read_message_id)
       AND m.sender_uid IS DISTINCT FROM $1
  )`;

export const listConversationsForUser = async (userUid: string) => {
  const r = await dbQuery.query(
    `SELECT c.*, ${UNREAD_COUNT_SQL} AS unread_count,
            (b.user_id = $1)                AS viewer_is_client,
            COALESCE(p.can_send, TRUE)      AS viewer_can_send
       FROM ${dbSchema}.chat_conversations c
       JOIN ${dbSchema}.chat_participants p ON p.conversation_id = c.id
       LEFT JOIN ${dbSchema}.bookings b ON b.id = c.booking_id
      WHERE p.user_uid = $1
        AND p.left_at IS NULL
        AND COALESCE(p.can_read, TRUE) = TRUE
      ORDER BY c.last_message_at DESC NULLS LAST`,
    [userUid]
  );
  return r.rows;
};

/**
 * The unread count for ONE conversation, from the same expression the inbox uses.
 *
 * Returns null when the caller holds no readable participant row — an admin
 * authorized by role has no pointer, and reporting a number for them would be
 * inventing one. `UNREAD_FOR_NON_PARTICIPANT` is what the DTO publishes then.
 */
export const countUnreadFor = async (
  conversationId: number,
  userUid: string,
): Promise<number | null> => {
  const r = await dbQuery.query(
    `SELECT ${UNREAD_COUNT_SQL} AS unread_count
       FROM ${dbSchema}.chat_conversations c
       JOIN ${dbSchema}.chat_participants p ON p.conversation_id = c.id
      WHERE p.user_uid = $1
        AND p.conversation_id = $2
        AND p.left_at IS NULL
        AND COALESCE(p.can_read, TRUE) = TRUE`,
    [userUid, conversationId]
  );
  return r.rows.length ? Number(r.rows[0].unread_count) : null;
};

/**
 * The raw material for an INDEPENDENT recount — ids and senders of every live
 * message in the conversation, plus the caller's own pointer and join time.
 *
 * Deliberately not an aggregate. The point of the drift check is to arrive at
 * the number a different way; asking the database to count it again with the
 * same expression would prove only that COUNT is deterministic.
 */
export const unreadAuditRows = async (
  conversationId: number,
  userUid: string,
): Promise<{
  joinedAt: string | null;
  lastReadMessageId: number | null;
  messages: Array<{ id: number; senderUid: string | null; createdAt: string }>;
} | null> => {
  const p = await dbQuery.query(
    `SELECT joined_at, last_read_message_id
       FROM ${dbSchema}.chat_participants
      WHERE conversation_id = $1 AND user_uid = $2 AND left_at IS NULL
        AND COALESCE(can_read, TRUE) = TRUE`,
    [conversationId, userUid]
  );
  if (!p.rows.length) return null;
  const m = await dbQuery.query(
    `SELECT id, sender_uid, created_at
       FROM ${dbSchema}.chat_messages
      WHERE conversation_id = $1 AND deleted_at IS NULL`,
    [conversationId]
  );
  return {
    joinedAt: p.rows[0].joined_at ?? null,
    lastReadMessageId:
      p.rows[0].last_read_message_id === null || p.rows[0].last_read_message_id === undefined
        ? null
        : Number(p.rows[0].last_read_message_id),
    messages: m.rows.map((row: any) => ({
      id: Number(row.id),
      senderUid: row.sender_uid ?? null,
      createdAt: String(row.created_at),
    })),
  };
};

/** Admin oversight view: every conversation. */
export const listAllConversations = async () => {
  const r = await dbQuery.query(
    `SELECT * FROM ${dbSchema}.chat_conversations
      ORDER BY last_message_at DESC NULLS LAST`,
    []
  );
  return r.rows;
};

// ---- Lifecycle schema ------------------------------------------------------


/**
 * Additive DDL, matching the lazy-migration convention already used by
 * `chat_message_reports`, `booking_timeline_events`, `admin_audit_events` etc.
 * Every statement is IF NOT EXISTS, so this is safe to run on every boot and
 * safe to run against a database that predates it.
 */
// `ensureChatLifecycleSchema` was the LAST deferred bootstrap (TAB 02).
//
// It did four things, and all four are now spent:
//
//   chat_conversations.{status, read_only_at, archived_at, escalated_at}
//   chat_participants.{can_read, can_send, last_read_at}
//   idx_chat_message_client_idempotency
//     -- all three declared by the BASELINE, so every database built from
//        this repository already has them.
//
//   UPDATE chat_conversations SET status = CLOSED WHERE is_closed AND status = ACTIVE
//     -- a ONE-TIME derivation for rows that predate the `status` column.
//        Verified spent against production on 2026-08-18: 0 rows matched.
//        It cannot come back, because `setConversationStatus` writes
//        `status` and `is_closed` in the SAME UPDATE — the two cannot
//        diverge again without someone writing one without the other.
//
// This was deferred rather than deleted with the other 148 statements
// precisely because of that DML: a derivation is not idempotent in the way a
// CREATE IF NOT EXISTS is, and dropping one that had NOT run would have left
// closed conversations reading as ACTIVE. It had run.

/** Internal alias used by helpers declared above the lazy schema initializer. */

// ---- Conversation status ---------------------------------------------------

/**
 * Move a conversation to a new lifecycle state, keeping `is_closed` in step.
 * Returns the updated row, or null if the conversation is gone.
 */
export const setConversationStatus = async (
  conversationId: number,
  status: ConversationStatus
) => {
  const isClosed = !WRITABLE_STATUSES.includes(status);
  const stamp =
    status === CONVERSATION_STATUS.READ_ONLY
      ? 'read_only_at'
      : status === CONVERSATION_STATUS.ARCHIVED
        ? 'archived_at'
        : status === CONVERSATION_STATUS.SUPPORT_ESCALATED
          ? 'escalated_at'
          : null;

  const r = await dbQuery.query(
    `UPDATE ${dbSchema}.chat_conversations
        SET status     = $2,
            is_closed  = $3,
            ${stamp ? `${stamp} = COALESCE(${stamp}, now()),` : ''}
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [conversationId, status, isClosed]
  );
  return r.rows[0] || null;
};

/**
 * Conversations eligible to leave the post-completion grace window.
 * `graceHours` is applied against the moment the conversation was completed,
 * which we take from `updated_at` at the time COMPLETED was recorded.
 */
export const findConversationsPastGrace = async (graceHours: number) => {
  const r = await dbQuery.query(
    `SELECT c.id
       FROM ${dbSchema}.chat_conversations c
       JOIN ${dbSchema}.bookings b ON b.id = c.booking_id
      WHERE c.status = 'ACTIVE'
        AND b.status IN ('COMPLETED','completed')
        AND c.updated_at < now() - ($1 || ' hours')::interval`,
    [String(graceHours)]
  );
  return r.rows.map((row: any) => Number(row.id));
};

// ---- Participants: capabilities and removal --------------------------------

export const findParticipant = async (conversationId: number, userUid: string) => {
  const r = await dbQuery.query(
    `SELECT * FROM ${dbSchema}.chat_participants
      WHERE conversation_id = $1 AND user_uid = $2`,
    [conversationId, userUid]
  );
  return r.rows[0] || null;
};

export const setParticipantCapabilities = async (
  conversationId: number,
  userUid: string,
  caps: { canRead?: boolean; canSend?: boolean }
) => {
  const r = await dbQuery.query(
    `UPDATE ${dbSchema}.chat_participants
        SET can_read = COALESCE($3, can_read),
            can_send = COALESCE($4, can_send)
      WHERE conversation_id = $1 AND user_uid = $2
      RETURNING *`,
    [conversationId, userUid, caps.canRead ?? null, caps.canSend ?? null]
  );
  return r.rows[0] || null;
};

/**
 * Remove a participant — reassignment, decline, or cancellation.
 *
 * `retainRead` implements the "old provider keeps read-only historical scope"
 * option. It defaults to FALSE, which preserves the behaviour the platform has
 * today: a reassigned provider loses the conversation outright, because access
 * is booking-derived and `adminReassignProvider` sets their booking_workers row
 * to DECLINED. Flipping it to true is a deliberate WIDENING of access and must
 * be a policy decision, not a side effect of wiring this up.
 */
export const removeParticipant = async (
  conversationId: number,
  userUid: string,
  opts: { retainRead?: boolean } = {}
) => {
  const retainRead = opts.retainRead === true;
  await dbQuery.query(
    `UPDATE ${dbSchema}.chat_participants
        SET left_at  = COALESCE(left_at, NOW()),
            can_send = FALSE,
            can_read = $3
      WHERE conversation_id = $1 AND user_uid = $2`,
    [conversationId, userUid, retainRead]
  );
};

/** Participants still active in a conversation (for handoff + display). */
export const listActiveParticipants = async (conversationId: number) => {
  const r = await dbQuery.query(
    `SELECT * FROM ${dbSchema}.chat_participants
      WHERE conversation_id = $1 AND left_at IS NULL`,
    [conversationId]
  );
  return r.rows;
};

// ---- System-message deduplication ------------------------------------------

/** Returns the existing system message row if one with this eventKey already exists. */
export const findSystemMessage = async (conversationId: number, eventKey: string) => {
  const r = await dbQuery.query(
    `SELECT id FROM ${dbSchema}.chat_messages
     WHERE conversation_id = $1 AND type = 'system' AND metadata->>'eventKey' = $2
     LIMIT 1`,
    [conversationId, eventKey]
  );
  return r.rows[0] || null;
};

// ---- Conversation existence check (non-creating) ---------------------------

export const findExistingConversationByBookingId = async (bookingId: number) => {
  const r = await dbQuery.query(
    `SELECT id FROM ${dbSchema}.chat_conversations WHERE booking_id = $1`,
    [bookingId]
  );
  return r.rows[0] || null;
};

// ---- Message reports -------------------------------------------------------

export const insertMessageReport = async (input: {
  reporterUid: string;
  messageId: number;
  conversationId: number;
  category: string;
  description: string;
}): Promise<{ id: number }> => {
  // `chat_message_reports` is declared by the BASELINE. The comment here
  // read "lazy table creation - no separate migration required", which was
  // the assumption TAB 02 exists to end: a CREATE on a write path is a second
  // schema authority, and it needs DDL privileges the app should not hold.
  const r = await dbQuery.query(
    `INSERT INTO ${dbSchema}.chat_message_reports
       (reporter_uid, message_id, conversation_id, category, description)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING id`,
    [input.reporterUid, input.messageId, input.conversationId, input.category, input.description]
  );
  return r.rows[0];
};
