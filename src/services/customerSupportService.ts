import dbQuery from "../db/dbQuery";
import { db } from "../config";
import mongoDb from "../db/mongodbQuery";

const dbSchema = db.schema;

// ─── Lazy table init ──────────────────────────────────────────────────────────

let tablesReady: Promise<void> | null = null;

async function initTables(): Promise<void> {
  await dbQuery.query(`
    CREATE TABLE IF NOT EXISTS ${dbSchema}.customer_support_tickets (
      id               BIGSERIAL    PRIMARY KEY,
      ticket_key       VARCHAR(64)  UNIQUE NOT NULL DEFAULT gen_random_uuid()::varchar,
      customer_uid     VARCHAR(128) NOT NULL,
      client_request_id VARCHAR(128),
      category         VARCHAR(64)  NOT NULL DEFAULT 'other',
      status           VARCHAR(64)  NOT NULL DEFAULT 'submitted',
      title            VARCHAR(200) NOT NULL,
      description      TEXT         NOT NULL,
      booking_id       VARCHAR(128),
      created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cst_client_req
      ON ${dbSchema}.customer_support_tickets (customer_uid, client_request_id)
      WHERE client_request_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_cst_customer_uid
      ON ${dbSchema}.customer_support_tickets (customer_uid, created_at DESC);

    CREATE TABLE IF NOT EXISTS ${dbSchema}.customer_support_ticket_replies (
      id          BIGSERIAL    PRIMARY KEY,
      ticket_key  VARCHAR(64)  NOT NULL,
      sender_type VARCHAR(32)  NOT NULL DEFAULT 'customer',
      safe_body   TEXT         NOT NULL,
      is_read     BOOLEAN      NOT NULL DEFAULT false,
      created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_cstr_ticket_key
      ON ${dbSchema}.customer_support_ticket_replies (ticket_key, created_at ASC);
  `);
}

export function ensureCustomerSupportTables(): Promise<void> {
  if (!tablesReady) tablesReady = initTables();
  return tablesReady;
}

// ─── Status rules ─────────────────────────────────────────────────────────────

const ACTIVE_STATUSES = [
  'submitted', 'open', 'waiting_for_support', 'waiting_for_customer', 'escalated',
];
const REPLY_STATUSES = [
  'open', 'waiting_for_support', 'waiting_for_customer', 'escalated',
];
const CLOSEABLE_STATUSES = [
  'submitted', 'open', 'waiting_for_support', 'escalated',
];
const REOPENABLE_STATUSES = ['resolved', 'closed'];

// ─── Row mapper ───────────────────────────────────────────────────────────────

function mapTicketRow(row: Record<string, unknown>) {
  const status = row.status as string;
  return {
    ticketKey:   row.ticket_key as string,
    category:    row.category   as string,
    status,
    title:       row.title      as string,
    safeSummary: (row.description as string).substring(0, 120),
    bookingId:   (row.booking_id as string | null) ?? null,
    createdAt:   row.created_at ?? null,
    updatedAt:   row.updated_at ?? null,
    canReply:    REPLY_STATUSES.includes(status),
    canClose:    CLOSEABLE_STATUSES.includes(status),
    canReopen:   REOPENABLE_STATUSES.includes(status),
  };
}

function mapReplyRow(row: Record<string, unknown>) {
  return {
    id:         String(row.id),
    senderType: row.sender_type as string,
    safeBody:   row.safe_body   as string,
    isRead:     row.is_read     as boolean,
    createdAt:  row.created_at  ?? null,
  };
}

// ─── Service functions ────────────────────────────────────────────────────────

export async function listCustomerTickets(customerUid: string) {
  await ensureCustomerSupportTables();
  const { rows } = await dbQuery.query(
    `SELECT * FROM ${dbSchema}.customer_support_tickets
     WHERE customer_uid = $1
     ORDER BY updated_at DESC
     LIMIT 50`,
    [customerUid],
  );
  return rows.map(mapTicketRow);
}

export async function createCustomerTicket(
  customerUid: string,
  title: string,
  description: string,
  category: string,
  clientRequestId?: string | null,
  bookingId?: string | null,
) {
  await ensureCustomerSupportTables();
  // Idempotent: same customer + clientRequestId → return existing ticket
  if (clientRequestId) {
    const { rows: existing } = await dbQuery.query(
      `SELECT * FROM ${dbSchema}.customer_support_tickets
       WHERE customer_uid = $1 AND client_request_id = $2`,
      [customerUid, clientRequestId],
    );
    if (existing.length > 0) return mapTicketRow(existing[0]);
  }
  const { rows } = await dbQuery.query(
    `INSERT INTO ${dbSchema}.customer_support_tickets
       (customer_uid, client_request_id, category, title, description, booking_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      customerUid,
      clientRequestId ?? null,
      category || 'other',
      title.substring(0, 200),
      description.substring(0, 2000),
      bookingId ?? null,
    ],
  );
  return mapTicketRow(rows[0]);
}

export async function getCustomerTicketDetail(customerUid: string, ticketKey: string) {
  await ensureCustomerSupportTables();
  const { rows } = await dbQuery.query(
    `SELECT * FROM ${dbSchema}.customer_support_tickets
     WHERE ticket_key = $1 AND customer_uid = $2`,
    [ticketKey, customerUid],
  );
  if (rows.length === 0) return null;
  const ticket = mapTicketRow(rows[0]);
  const { rows: replies } = await dbQuery.query(
    `SELECT * FROM ${dbSchema}.customer_support_ticket_replies
     WHERE ticket_key = $1
     ORDER BY created_at ASC`,
    [ticketKey],
  );
  return { ...ticket, replies: replies.map(mapReplyRow) };
}

export async function addCustomerTicketReply(
  customerUid: string,
  ticketKey: string,
  message: string,
) {
  await ensureCustomerSupportTables();
  const { rows } = await dbQuery.query(
    `SELECT * FROM ${dbSchema}.customer_support_tickets
     WHERE ticket_key = $1 AND customer_uid = $2`,
    [ticketKey, customerUid],
  );
  if (rows.length === 0) return null;
  const ticket = rows[0];
  if (!REPLY_STATUSES.includes(ticket.status)) {
    return { error: 'Ticket is not open for replies' };
  }
  await dbQuery.query(
    `INSERT INTO ${dbSchema}.customer_support_ticket_replies
       (ticket_key, sender_type, safe_body)
     VALUES ($1, 'customer', $2)`,
    [ticketKey, message.substring(0, 2000)],
  );
  const { rows: updated } = await dbQuery.query(
    `UPDATE ${dbSchema}.customer_support_tickets
     SET status = 'waiting_for_support', updated_at = NOW()
     WHERE ticket_key = $1 AND customer_uid = $2
     RETURNING *`,
    [ticketKey, customerUid],
  );
  return mapTicketRow(updated[0]);
}

export async function markCustomerTicketRead(customerUid: string, ticketKey: string) {
  await ensureCustomerSupportTables();
  // Verify ownership before mutating
  const { rows } = await dbQuery.query(
    `SELECT id FROM ${dbSchema}.customer_support_tickets
     WHERE ticket_key = $1 AND customer_uid = $2`,
    [ticketKey, customerUid],
  );
  if (rows.length === 0) return;
  await dbQuery.query(
    `UPDATE ${dbSchema}.customer_support_ticket_replies
     SET is_read = true
     WHERE ticket_key = $1 AND sender_type = 'support' AND is_read = false`,
    [ticketKey],
  );
}

export async function closeCustomerTicket(customerUid: string, ticketKey: string) {
  await ensureCustomerSupportTables();
  const { rows } = await dbQuery.query(
    `UPDATE ${dbSchema}.customer_support_tickets
     SET status = 'closed', updated_at = NOW()
     WHERE ticket_key = $1 AND customer_uid = $2
       AND status = ANY($3::varchar[])
     RETURNING *`,
    [ticketKey, customerUid, CLOSEABLE_STATUSES],
  );
  if (rows.length === 0) return null;
  return mapTicketRow(rows[0]);
}

export async function reopenCustomerTicket(customerUid: string, ticketKey: string) {
  await ensureCustomerSupportTables();
  const { rows } = await dbQuery.query(
    `UPDATE ${dbSchema}.customer_support_tickets
     SET status = 'open', updated_at = NOW()
     WHERE ticket_key = $1 AND customer_uid = $2
       AND status = ANY($3::varchar[])
     RETURNING *`,
    [ticketKey, customerUid, REOPENABLE_STATUSES],
  );
  if (rows.length === 0) return null;
  return mapTicketRow(rows[0]);
}

export async function countUnreadCustomerReplies(customerUid: string): Promise<number> {
  await ensureCustomerSupportTables();
  const { rows } = await dbQuery.query(
    `SELECT COUNT(r.id)::int AS count
     FROM ${dbSchema}.customer_support_ticket_replies r
     JOIN ${dbSchema}.customer_support_tickets t
       ON t.ticket_key = r.ticket_key
     WHERE t.customer_uid = $1
       AND r.is_read = false
       AND r.sender_type = 'support'`,
    [customerUid],
  );
  return (rows[0]?.count as number) ?? 0;
}

// ─── Safety incidents ─────────────────────────────────────────────────────────
// Stored in MongoDB collection customer_safety_incidents.
// Mirrors the provider safety incident pattern exactly.

export async function listCustomerSafetyIncidents(customerUid: string) {
  const col = (await mongoDb).collection('customer_safety_incidents');
  const incidents = await col
    .find({ uid: customerUid }, { projection: { uid: 0, _id: 0, clientIncidentId: 0 } })
    .sort({ reportedAt: -1 })
    .limit(50)
    .toArray();
  return incidents.map((inc: Record<string, unknown>) => ({
    caseKey:        inc.incidentId,
    safeReference:  inc.safeReference,
    category:       inc.category,
    categoryLabel:  String(inc.category).replace(/_/g, ' '),
    severity:       inc.severity,
    state:          inc.state ?? 'submitted',
    bookingId:      inc.bookingId ?? null,
    reportedAt:     inc.reportedAt ?? null,
    updatedAt:      inc.updatedAt ?? null,
    isOpen:         !['resolved', 'closed'].includes(String(inc.state)),
  }));
}

export async function submitCustomerSafetyIncident(params: {
  customerUid: string;
  clientIncidentId: string;
  category: string;
  severity: string;
  description: string;
  bookingId?: string | null;
  immediateDanger?: boolean;
}) {
  const col = (await mongoDb).collection('customer_safety_incidents');
  // Idempotent: same customer + clientIncidentId
  const existing = await col.findOne({
    uid: params.customerUid,
    clientIncidentId: params.clientIncidentId,
  });
  if (existing) return { duplicate: true, caseKey: existing['incidentId'], safeReference: existing['safeReference'] };

  const now = new Date().toISOString();
  const rand = Math.random().toString(36).substring(2, 7).toUpperCase();
  const incidentId = `cinc-${Date.now().toString(36)}-${rand}`;
  const safeReference = `CSAF-${new Date().getFullYear()}-${rand}`;

  await col.insertOne({
    uid:              params.customerUid,
    clientIncidentId: params.clientIncidentId,
    incidentId,
    safeReference,
    category:         params.category,
    severity:         params.severity,
    description:      params.description.substring(0, 2000),
    bookingId:        params.bookingId ?? null,
    immediateDanger:  params.immediateDanger ?? false,
    state:            'submitted',
    reportedAt:       now,
    updatedAt:        now,
  });

  return { duplicate: false, caseKey: incidentId, safeReference, state: 'submitted' };
}

// Emergency config is shared with providers — same static data
export function getEmergencyConfig() {
  return {
    locale: 'en-PH',
    country: 'Philippines',
    lines: [
      { label: 'National Emergency Hotline', number: 'tel:911', dialLabel: '911', description: 'Police, fire, and medical emergencies' },
      { label: 'Philippine National Police', number: 'tel:117', dialLabel: '117', description: 'Police assistance' },
      { label: 'Bureau of Fire Protection', number: 'tel:160', dialLabel: '160', description: 'Fire emergencies' },
    ],
    disclaimer:
      'Servana support is available during business hours. For life-threatening emergencies, contact local emergency services directly.',
  };
}
