import { db } from "../config";
import dbQuery from "../db/dbQuery";

const dbSchema = db.schema;

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
       DO UPDATE SET role = EXCLUDED.role, left_at = NULL
     RETURNING *`,
    [conversationId, userUid, role]
  );
  return r.rows[0];
};

export const listParticipants = async (conversationId: number) => {
  const r = await dbQuery.query(
    `SELECT p.*, u.first_name, u.last_name, up.photo_url
       FROM ${dbSchema}.chat_participants p
       LEFT JOIN ${dbSchema}.user_credentials u ON u.uid = p.user_uid
       LEFT JOIN ${dbSchema}.user_profile up ON up.uid = p.user_uid
      WHERE p.conversation_id = $1
      ORDER BY p.joined_at ASC`,
    [conversationId]
  );
  return r.rows;
};

export const setLastRead = async (
  conversationId: number,
  userUid: string,
  lastReadMessageId: number
) => {
  await dbQuery.query(
    `UPDATE ${dbSchema}.chat_participants
     SET last_read_message_id = $3
     WHERE conversation_id = $1 AND user_uid = $2`,
    [conversationId, userUid, lastReadMessageId]
  );
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
  before?: number
) => {
  const params: any[] = [conversationId, limit];
  let cursor = "";
  if (before) {
    cursor = `AND id < $3`;
    params.push(before);
  }
  const r = await dbQuery.query(
    `SELECT * FROM ${dbSchema}.chat_messages
      WHERE conversation_id = $1
        ${cursor}
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
    `SELECT * FROM ${dbSchema}.chat_message_attachments WHERE message_id = $1`,
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
export const listConversationsForUser = async (userUid: string) => {
  const r = await dbQuery.query(
    `SELECT c.*,
            (SELECT COUNT(*) FROM ${dbSchema}.chat_messages m
               WHERE m.conversation_id = c.id
                 AND m.deleted_at IS NULL
                 AND (p.last_read_message_id IS NULL OR m.id > p.last_read_message_id)
                 AND m.sender_uid IS DISTINCT FROM $1
            ) AS unread_count
       FROM ${dbSchema}.chat_conversations c
       JOIN ${dbSchema}.chat_participants p ON p.conversation_id = c.id
      WHERE p.user_uid = $1
        AND p.left_at IS NULL
        AND COALESCE(p.can_read, TRUE) = TRUE
      ORDER BY c.last_message_at DESC NULLS LAST`,
    [userUid]
  );
  return r.rows;
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
 * Conversation lifecycle states.
 *
 * `is_closed` (the original boolean) is KEPT and kept correct: three consumers
 * read it — the Flutter customer app (`conversation_mapper.dart`), the provider
 * portal (`adaptBackendConversation` maps it to status 'closed'|'active') and
 * the admin portal. It is now maintained as a derived compatibility flag
 * meaning "customer and provider cannot write here", so a client that knows
 * nothing about `status` still renders and behaves correctly. Never drop it.
 */
export const CONVERSATION_STATUS = {
  ACTIVE: 'ACTIVE',
  READ_ONLY: 'READ_ONLY',
  ARCHIVED: 'ARCHIVED',
  CLOSED: 'CLOSED',
  SUPPORT_ESCALATED: 'SUPPORT_ESCALATED',
} as const;

export type ConversationStatus =
  (typeof CONVERSATION_STATUS)[keyof typeof CONVERSATION_STATUS];

/** States in which the customer and the assigned provider may still post. */
export const WRITABLE_STATUSES: ConversationStatus[] = [
  CONVERSATION_STATUS.ACTIVE,
  CONVERSATION_STATUS.SUPPORT_ESCALATED,
];

let lifecycleSchemaReady: Promise<void> | null = null;

/**
 * Additive DDL, matching the lazy-migration convention already used by
 * `chat_message_reports`, `booking_timeline_events`, `admin_audit_events` etc.
 * Every statement is IF NOT EXISTS, so this is safe to run on every boot and
 * safe to run against a database that predates it.
 */
export const ensureChatLifecycleSchema = async (): Promise<void> => {
  if (lifecycleSchemaReady) return lifecycleSchemaReady;
  lifecycleSchemaReady = (async () => {
    await dbQuery.query(
      `ALTER TABLE ${dbSchema}.chat_conversations
         ADD COLUMN IF NOT EXISTS status        VARCHAR(24) NOT NULL DEFAULT 'ACTIVE',
         ADD COLUMN IF NOT EXISTS read_only_at  TIMESTAMPTZ,
         ADD COLUMN IF NOT EXISTS archived_at   TIMESTAMPTZ,
         ADD COLUMN IF NOT EXISTS escalated_at  TIMESTAMPTZ`,
      []
    );
    await dbQuery.query(
      `ALTER TABLE ${dbSchema}.chat_participants
         ADD COLUMN IF NOT EXISTS can_read  BOOLEAN NOT NULL DEFAULT TRUE,
         ADD COLUMN IF NOT EXISTS can_send  BOOLEAN NOT NULL DEFAULT TRUE`,
      []
    );
    // Existing rows predate `status`; derive it once from the boolean so the
    // two never disagree on a database that already had closed conversations.
    await dbQuery.query(
      `UPDATE ${dbSchema}.chat_conversations
          SET status = 'CLOSED'
        WHERE is_closed = TRUE AND status = 'ACTIVE'`,
      []
    );
  })().catch((e) => {
    // Never let a DDL failure take the chat module down — the columns are
    // additive and every read path COALESCEs. Reset so a later call retries.
    lifecycleSchemaReady = null;
    throw e;
  });
  return lifecycleSchemaReady;
};

// ---- Conversation status ---------------------------------------------------

/**
 * Move a conversation to a new lifecycle state, keeping `is_closed` in step.
 * Returns the updated row, or null if the conversation is gone.
 */
export const setConversationStatus = async (
  conversationId: number,
  status: ConversationStatus
) => {
  await ensureChatLifecycleSchema();
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
  await ensureChatLifecycleSchema();
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
  await ensureChatLifecycleSchema();
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
  await ensureChatLifecycleSchema();
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
  // Lazy table creation — no separate migration required.
  await dbQuery.query(
    `CREATE TABLE IF NOT EXISTS ${dbSchema}.chat_message_reports (
       id             SERIAL PRIMARY KEY,
       reporter_uid   TEXT NOT NULL,
       message_id     INT  NOT NULL,
       conversation_id INT NOT NULL,
       category       TEXT NOT NULL,
       description    TEXT,
       created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
    []
  );
  const r = await dbQuery.query(
    `INSERT INTO ${dbSchema}.chat_message_reports
       (reporter_uid, message_id, conversation_id, category, description)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING id`,
    [input.reporterUid, input.messageId, input.conversationId, input.category, input.description]
  );
  return r.rows[0];
};
