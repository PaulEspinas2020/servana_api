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

/** Active worker uids assigned to a booking. */
export const getBookingWorkerUids = async (bookingId: number): Promise<string[]> => {
  const r = await dbQuery.query(
    `SELECT worker_uid
       FROM ${dbSchema}.booking_workers
      WHERE booking_id = $1
        AND status IN ('ASSIGNED','ACCEPTED','IN_PROGRESS','COMPLETED')`,
    [bookingId]
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

/** Conversations a participant belongs to, newest activity first, + unread count. */
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
