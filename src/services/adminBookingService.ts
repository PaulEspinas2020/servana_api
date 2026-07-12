import { db } from "../config";
import dbQuery from "../db/dbQuery";
import { send } from "../helpers/mailer";
import { getUserInfoByBookingId } from "./user.service";
const dbSchema = db.schema;

// ─── Types ────────────────────────────────────────────────────────────────────

export type OperationsStatus =
  | 'new'
  | 'awaiting_assignment'
  | 'assigned'
  | 'accepted'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'disputed';

interface AuditEvent {
  bookingId: number;
  actorUid: string | null;
  actorRole: string;
  action: string;
  before?: any;
  after?: any;
  reason?: string;
  requestId?: string;
}

export interface BookingListFilter {
  search?: string;
  operationsStatus?: OperationsStatus | '';
  paymentMethod?: string;
  paymentStatus?: string;
  serviceId?: number;
  fromDate?: string;
  toDate?: string;
  isUnassigned?: boolean;
  isLate?: boolean;
  hasDispute?: boolean;
  needsAdminAction?: boolean;
  page?: number;
  limit?: number;
}

// ─── Schema Init ─────────────────────────────────────────────────────────────

export const ensureBookingOpsSchema = async (): Promise<void> => {
  await dbQuery.query(`
    CREATE TABLE IF NOT EXISTS ${dbSchema}.booking_timeline_events (
      id          SERIAL PRIMARY KEY,
      booking_id  INTEGER NOT NULL,
      event_type  VARCHAR(80) NOT NULL,
      title       VARCHAR(200) NOT NULL,
      description TEXT,
      actor_type  VARCHAR(20) NOT NULL DEFAULT 'admin',
      actor_uid   TEXT,
      metadata    JSONB,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `, []);

  await dbQuery.query(`
    CREATE INDEX IF NOT EXISTS idx_bte_booking_id
    ON ${dbSchema}.booking_timeline_events (booking_id, created_at DESC)
  `, []);

  await dbQuery.query(`
    CREATE TABLE IF NOT EXISTS ${dbSchema}.booking_notes (
      id          SERIAL PRIMARY KEY,
      booking_id  INTEGER NOT NULL,
      note_text   TEXT NOT NULL,
      author_uid  TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `, []);

  await dbQuery.query(`
    CREATE TABLE IF NOT EXISTS ${dbSchema}.booking_escalations (
      id             SERIAL PRIMARY KEY,
      booking_id     INTEGER NOT NULL,
      reason_code    VARCHAR(80),
      reason         TEXT NOT NULL,
      severity       VARCHAR(20) NOT NULL DEFAULT 'normal',
      assigned_team  TEXT,
      actor_uid      TEXT,
      resolved_at    TIMESTAMPTZ,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `, []);

  await dbQuery.query(`
    CREATE TABLE IF NOT EXISTS ${dbSchema}.booking_audit_events (
      id          SERIAL PRIMARY KEY,
      booking_id  INTEGER,
      actor_uid   TEXT,
      actor_role  VARCHAR(20) NOT NULL DEFAULT 'admin',
      action      VARCHAR(100) NOT NULL,
      before_json JSONB,
      after_json  JSONB,
      reason      TEXT,
      request_id  TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `, []);

  // booking_workers is a pre-existing table — add admin-portal columns if missing
  await dbQuery.query(`
    ALTER TABLE ${dbSchema}.booking_workers
    ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ DEFAULT NOW()
  `, []);

  // Confirmation-on-behalf columns — wrapped individually so one DDL failure doesn't abort the rest
  const confirmCols: [string, string][] = [
    ['confirmation_source',  'VARCHAR(40)'],
    ['admin_actor_uid',      'VARCHAR(256)'],
    ['consent_method',       'VARCHAR(30)'],
    ['consent_reference',    'TEXT'],
    ['confirmation_reason',  'TEXT'],
    ['confirmed_at',         'TIMESTAMPTZ'],
  ];
  for (const [col, typ] of confirmCols) {
    try {
      await dbQuery.query(`ALTER TABLE ${dbSchema}.booking_workers ADD COLUMN IF NOT EXISTS ${col} ${typ}`, []);
    } catch { /* column may already exist with a different type — safe to skip */ }
  }
};

// ─── Internal helpers ─────────────────────────────────────────────────────────

const logBookingAudit = (event: AuditEvent): void => {
  dbQuery.query(
    `INSERT INTO ${dbSchema}.booking_audit_events
       (booking_id, actor_uid, actor_role, action, before_json, after_json, reason, request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      event.bookingId,
      event.actorUid,
      event.actorRole,
      event.action,
      event.before ? JSON.stringify(event.before) : null,
      event.after  ? JSON.stringify(event.after)  : null,
      event.reason ?? null,
      event.requestId ?? null,
    ]
  ).catch((e) => { console.error('[booking-audit] write failed:', e?.message); });
};

const addTimelineEvent = async (
  bookingId: number,
  eventType: string,
  title: string,
  description: string | null = null,
  actorType: string = 'admin',
  actorUid: string | null = null,
  metadata: any = null
): Promise<void> => {
  await dbQuery.query(
    `INSERT INTO ${dbSchema}.booking_timeline_events
       (booking_id, event_type, title, description, actor_type, actor_uid, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [bookingId, eventType, title, description, actorType, actorUid,
     metadata ? JSON.stringify(metadata) : null]
  );
};

// ─── Operations Status Mapping ────────────────────────────────────────────────

export const mapOperationsStatus = (
  bookingStatus: string | null,
  workerStatus: string | null,
  workerUid: string | null,
  hasEscalation: boolean = false
): OperationsStatus => {
  if (hasEscalation) return 'disputed';
  const bs = (bookingStatus ?? '').toUpperCase();
  const ws = (workerStatus  ?? '').toUpperCase();

  if (['CANCELLED', 'CANCELED'].includes(bs)) return 'cancelled';
  if (ws === 'COMPLETED' || bs === 'COMPLETED') return 'completed';
  if (ws === 'IN_PROGRESS') return 'in_progress';
  if (ws === 'ACCEPTED') return 'accepted';
  if (ws === 'ASSIGNED' || bs === 'WORKER_ASSIGNED') return 'assigned';
  if (bs === 'PENDING_OTP') return 'new';
  if (['CONFIRMED', 'PAID'].includes(bs) && !workerUid) return 'awaiting_assignment';
  if (['CONFIRMED', 'PAID'].includes(bs) && workerUid)  return 'assigned';
  return 'new';
};

// ─── Admin Booking List ───────────────────────────────────────────────────────

export const getAdminBookings = async (
  filter: BookingListFilter
): Promise<{ rows: any[]; total: number }> => {
  const page   = Math.max(1, filter.page  ?? 1);
  const limit  = Math.min(100, Math.max(1, filter.limit ?? 25));
  const offset = (page - 1) * limit;

  const conditions: string[] = [];
  const params: any[]        = [];
  let pi = 1;

  if (filter.search?.trim()) {
    const s = `%${filter.search.trim()}%`;
    conditions.push(`(
      b.id::text ILIKE $${pi}
      OR (cu.first_name || ' ' || cu.last_name) ILIKE $${pi}
      OR cu.email ILIKE $${pi}
      OR cu.phone_number ILIKE $${pi}
      OR (wu.first_name || ' ' || wu.last_name) ILIKE $${pi}
      OR s.name ILIKE $${pi}
    )`);
    params.push(s); pi++;
  }
  if (filter.paymentMethod) {
    conditions.push(`b.payment_method = $${pi}`);
    params.push(filter.paymentMethod); pi++;
  }
  if (filter.paymentStatus) {
    conditions.push(`lp.status = $${pi}`);
    params.push(filter.paymentStatus); pi++;
  }
  if (filter.serviceId) {
    conditions.push(`s.id = $${pi}`);
    params.push(filter.serviceId); pi++;
  }
  if (filter.fromDate) {
    conditions.push(`b.schedule >= $${pi}`);
    params.push(filter.fromDate); pi++;
  }
  if (filter.toDate) {
    conditions.push(`b.schedule <= $${pi}`);
    params.push(filter.toDate); pi++;
  }
  if (filter.isUnassigned === true) {
    conditions.push(`b.worker_uid IS NULL`);
  }
  if (filter.isLate === true) {
    conditions.push(`b.schedule < NOW() AND b.status NOT IN ('COMPLETED','CANCELLED','CANCELED')`);
  }
  if (filter.hasDispute === true) {
    conditions.push(
      `EXISTS (SELECT 1 FROM ${dbSchema}.booking_escalations be2
               WHERE be2.booking_id = b.id AND be2.resolved_at IS NULL)`
    );
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  // ops_status is a computed field — add it to the SQL so COUNT + LIMIT apply to the filtered set
  if (filter.operationsStatus) {
    params.push(filter.operationsStatus);
  }
  const opsFilter = filter.operationsStatus ? `AND ops_status = $${pi++}` : '';

  const baseSQL = `
    WITH latest_assignment AS (
      SELECT DISTINCT ON (booking_id)
        booking_id, worker_uid, status AS worker_status, assigned_at
      FROM ${dbSchema}.booking_workers
      ORDER BY booking_id, assigned_at DESC NULLS LAST
    ),
    latest_payment AS (
      SELECT DISTINCT ON (booking_id)
        booking_id, status AS payment_status
      FROM ${dbSchema}.payments
      ORDER BY booking_id, id DESC
    ),
    bops AS (
      SELECT
        b.id                                         AS booking_id,
        b.status                                     AS raw_status,
        b.worker_uid,
        b.payment_method,
        b.quoted_price,
        b.final_price,
        b.schedule                                   AS scheduled_at,
        b.created_at,
        la.worker_uid                                AS provider_uid,
        la.worker_status,
        la.assigned_at,
        lp.payment_status,
        cu.uid                                       AS customer_uid,
        COALESCE(cu.first_name,'') || ' ' || COALESCE(cu.last_name,'') AS customer_name,
        cu.phone_number                              AS customer_phone,
        cu.email                                     AS customer_email,
        COALESCE(wu.first_name,'') || ' ' || COALESCE(wu.last_name,'') AS provider_name,
        wu.phone_number                              AS provider_phone,
        s.id                                         AS service_id,
        so.id                                        AS service_option_id,
        s.name                                       AS service_name,
        so.level_3                                   AS specific_service_name,
        ua.address_one                               AS address_line,
        ua.post_town                                 AS city,
        br.id                                        AS branch_id,
        br.name                                      AS branch_name,
        br.city                                      AS branch_city,
        CASE
          WHEN EXISTS (SELECT 1 FROM ${dbSchema}.booking_escalations esc
                       WHERE esc.booking_id = b.id AND esc.resolved_at IS NULL) THEN 'disputed'
          WHEN b.status = 'COMPLETED' OR la.worker_status = 'COMPLETED'        THEN 'completed'
          WHEN la.worker_status = 'IN_PROGRESS'                                 THEN 'in_progress'
          WHEN la.worker_status = 'ACCEPTED'                                    THEN 'accepted'
          WHEN la.worker_status = 'ASSIGNED' OR b.status = 'WORKER_ASSIGNED'   THEN 'assigned'
          WHEN b.status = 'PENDING_OTP'                                         THEN 'new'
          WHEN b.status IN ('CONFIRMED','PAID')
            AND (b.worker_uid IS NULL OR b.worker_uid = '')                     THEN 'awaiting_assignment'
          WHEN b.status IN ('CONFIRMED','PAID') AND b.worker_uid IS NOT NULL
            AND b.worker_uid != ''                                               THEN 'assigned'
          WHEN b.status IN ('CANCELLED','CANCELED')                             THEN 'cancelled'
          ELSE 'new'
        END AS ops_status
      FROM ${dbSchema}.bookings b
      LEFT JOIN ${dbSchema}.user_credentials cu  ON cu.uid  = b.user_id
      LEFT JOIN ${dbSchema}.service_options so   ON so.id   = b.service_option_id
      LEFT JOIN ${dbSchema}.services s           ON s.id    = so.service_id
      LEFT JOIN ${dbSchema}.user_address ua      ON ua.address_id = b.user_address_id
      LEFT JOIN latest_payment  lp               ON lp.booking_id = b.id
      LEFT JOIN ${dbSchema}.branches br          ON br.id   = b.branch_id
      LEFT JOIN latest_assignment la             ON la.booking_id = b.id
      LEFT JOIN ${dbSchema}.user_credentials wu  ON wu.uid  = la.worker_uid
      ${whereClause}
    )
    SELECT * FROM bops WHERE 1=1 ${opsFilter}
  `;

  const countRes = await dbQuery.query(
    `SELECT COUNT(*) AS total FROM (${baseSQL}) AS sub`,
    params
  );

  const dataRes = await dbQuery.query(
    `${baseSQL} ORDER BY created_at DESC LIMIT $${pi} OFFSET $${pi + 1}`,
    [...params, limit, offset]
  );

  let rows = dataRes.rows.map((row: any) => {
    const opStatus = (row.ops_status as string) ?? mapOperationsStatus(
      row.raw_status,
      row.worker_status,
      row.worker_uid
    );
    const isLate = !!row.scheduled_at &&
      new Date(row.scheduled_at) < new Date() &&
      !['completed', 'cancelled'].includes(opStatus);

    return {
      bookingId: row.booking_id,
      rawStatus: row.raw_status,
      operationsStatus: opStatus,
      customerUid: row.customer_uid ?? null,
      customerName: (row.customer_name ?? '').trim() || null,
      customerPhone: row.customer_phone ?? null,
      customerEmail: row.customer_email ?? null,
      providerUid: row.provider_uid ?? null,
      providerName: (row.provider_name ?? '').trim() || null,
      providerPhone: row.provider_phone ?? null,
      assignmentStatus: row.worker_status ?? null,
      serviceId: row.service_id ?? null,
      serviceOptionId: row.service_option_id ?? null,
      serviceName: row.service_name ?? null,
      specificServiceName: row.specific_service_name ?? null,
      scheduledAt: row.scheduled_at ?? null,
      addressLine: row.address_line ?? null,
      city: row.city ?? null,
      quotedPrice: row.quoted_price ?? null,
      finalPrice: row.final_price ?? null,
      paymentMethod: row.payment_method ?? null,
      paymentStatus: row.payment_status ?? null,
      branchId: row.branch_id ?? null,
      branchName: row.branch_name ?? null,
      branchCity: row.branch_city ?? null,
      isUnassigned: !row.worker_uid,
      isLate,
      hasPaymentIssue: ['FAILED', 'REFUND_PENDING'].includes(row.payment_status ?? ''),
      hasDispute: false,
      needsAdminAction: !row.worker_uid && ['new', 'awaiting_assignment'].includes(opStatus),
      createdAt: row.created_at ?? null,
      updatedAt: null,
    };
  });

  if (filter.needsAdminAction === true) {
    rows = rows.filter((r: any) => r.needsAdminAction);
  }

  return { rows, total: Number(countRes.rows[0]?.total ?? 0) };
};

// ─── Metrics ─────────────────────────────────────────────────────────────────

export const getAdminBookingMetrics = async (): Promise<any> => {
  const res = await dbQuery.query(`
    WITH latest_assignment AS (
      SELECT DISTINCT ON (booking_id)
        booking_id, worker_uid, status AS worker_status
      FROM ${dbSchema}.booking_workers
      ORDER BY booking_id, assigned_at DESC NULLS LAST
    )
    SELECT b.id, b.status, b.worker_uid, la.worker_status
    FROM ${dbSchema}.bookings b
    LEFT JOIN latest_assignment la ON la.booking_id = b.id
  `, []);

  const counts: Record<string, number> = {
    total: 0, new: 0, awaiting_assignment: 0,
    assigned: 0, accepted: 0, in_progress: 0,
    completed: 0, cancelled: 0, disputed: 0,
  };

  for (const row of res.rows) {
    counts['total']++;
    const s = mapOperationsStatus(row.status, row.worker_status, row.worker_uid);
    counts[s] = (counts[s] ?? 0) + 1;
  }

  return {
    total: counts['total'],
    new: counts['new'],
    awaitingAssignment: counts['awaiting_assignment'],
    assigned: counts['assigned'],
    accepted: counts['accepted'],
    inProgress: counts['in_progress'],
    completed: counts['completed'],
    cancelled: counts['cancelled'],
    disputed: counts['disputed'],
    paymentExceptions: 0,
    lateJobs: 0,
    needsAdminAction: (counts['new'] ?? 0) + (counts['awaiting_assignment'] ?? 0),
  };
};

// ─── Booking 360 Detail ───────────────────────────────────────────────────────

export const getAdminBookingDetail = async (bookingId: number): Promise<any | null> => {
  const res = await dbQuery.query(`
    SELECT
      b.id, b.status, b.worker_uid, b.payment_method,
      b.quoted_price, b.final_price, b.pricing_breakdown,
      b.schedule, b.created_at,
      b.service_option_id, b.branch_id, b.user_address_id, b.user_id,
      COALESCE(cu.first_name,'') || ' ' || COALESCE(cu.last_name,'')  AS customer_name,
      cu.uid    AS customer_uid,
      cu.phone_number AS customer_phone,
      cu.email  AS customer_email,
      so.id     AS service_option_id_val,
      so.level_3 AS specific_service_name,
      so.base_price,
      s.id      AS service_id,
      s.name    AS service_name,
      p.method  AS payment_method_used,
      p.status  AS payment_status,
      p.reference_no,
      p.proof_url,
      p.amount  AS payment_amount,
      br.id     AS branch_id_val,
      br.name   AS branch_name,
      br.address AS branch_address,
      br.city   AS branch_city,
      ua.address_one AS address_line,
      ua.post_town,
      ua.country,
      ua.zip_code,
      ua.lat,
      ua.lon
    FROM ${dbSchema}.bookings b
    LEFT JOIN ${dbSchema}.user_credentials cu ON cu.uid = b.user_id
    LEFT JOIN ${dbSchema}.service_options so  ON so.id  = b.service_option_id
    LEFT JOIN ${dbSchema}.services s          ON s.id   = so.service_id
    LEFT JOIN ${dbSchema}.payments p          ON p.booking_id = b.id
    LEFT JOIN ${dbSchema}.branches br         ON br.id  = b.branch_id
    LEFT JOIN ${dbSchema}.user_address ua     ON ua.address_id = b.user_address_id
    WHERE b.id = $1
    LIMIT 1
  `, [bookingId]);

  if (!res.rowCount) return null;
  const bk = res.rows[0];

  const [bwRes, addonsRes, escalationRes] = await Promise.all([
    dbQuery.query(`
      SELECT bw.*, wu.first_name || ' ' || wu.last_name AS worker_name, wu.phone_number AS worker_phone
      FROM ${dbSchema}.booking_workers bw
      LEFT JOIN ${dbSchema}.user_credentials wu ON wu.uid = bw.worker_uid
      WHERE bw.booking_id = $1
      ORDER BY bw.assigned_at DESC NULLS LAST
      LIMIT 1
    `, [bookingId]),
    dbQuery.query(`
      SELECT ba.id, ba.addon_option_id, ba.qty, ba.unit_price, so2.level_3 AS addon_name
      FROM ${dbSchema}.booking_addons ba
      JOIN ${dbSchema}.service_options so2 ON so2.id = ba.addon_option_id
      WHERE ba.booking_id = $1 ORDER BY ba.id ASC
    `, [bookingId]),
    dbQuery.query(`
      SELECT * FROM ${dbSchema}.booking_escalations
      WHERE booking_id = $1 ORDER BY created_at DESC
    `, [bookingId]),
  ]);

  const assignment = bwRes.rows[0] ?? null;
  const hasEscalation = (escalationRes.rowCount ?? 0) > 0;
  const opStatus = mapOperationsStatus(bk.status, assignment?.status ?? null, bk.worker_uid, hasEscalation);

  return {
    bookingId: bk.id,
    rawStatus: bk.status,
    operationsStatus: opStatus,
    customer: {
      uid: bk.customer_uid ?? null,
      name: (bk.customer_name ?? '').trim() || null,
      phone: bk.customer_phone ?? null,
      email: bk.customer_email ?? null,
    },
    providerAssignment: assignment ? {
      providerUid: assignment.worker_uid,
      name: (assignment.worker_name ?? '').trim() || null,
      phone: assignment.worker_phone ?? null,
      assignmentStatus: assignment.status,
      assignedAt: assignment.assigned_at ?? null,
      startedAt: assignment.started_at ?? null,
      completedAt: assignment.completed_at ?? null,
      confirmedAt: assignment.confirmed_at ?? null,
      confirmationSource: assignment.confirmation_source ?? null,
      consentMethod: assignment.consent_method ?? null,
    } : null,
    service: {
      serviceId: bk.service_id ?? null,
      serviceOptionId: bk.service_option_id_val ?? bk.service_option_id ?? null,
      serviceName: bk.service_name ?? null,
      specificServiceName: bk.specific_service_name ?? null,
      basePrice: bk.base_price ?? null,
      addons: addonsRes.rows.map((a: any) => ({
        addonOptionId: a.addon_option_id,
        name: a.addon_name,
        qty: a.qty,
        unitPrice: a.unit_price,
      })),
    },
    schedule: {
      scheduledAt: bk.schedule ?? null,
      timezone: 'Asia/Manila',
    },
    address: {
      formattedAddress: [bk.address_line, bk.post_town, bk.country, bk.zip_code]
        .filter(Boolean).join(', ') || null,
      city: bk.post_town ?? null,
      lat: bk.lat ?? null,
      lon: bk.lon ?? null,
    },
    pricing: {
      currency: 'PHP',
      quotedPrice: bk.quoted_price ?? null,
      finalPrice: bk.final_price ?? null,
      paymentMethod: bk.payment_method ?? null,
    },
    payment: {
      paymentMethodUsed: bk.payment_method_used ?? null,
      paymentStatus: bk.payment_status ?? null,
      amount: bk.payment_amount ?? null,
      referenceNo: bk.reference_no ?? null,
      proofUrl: bk.proof_url ?? null,
    },
    branch: {
      branchId: bk.branch_id_val ?? bk.branch_id ?? null,
      branchName: bk.branch_name ?? null,
      branchCity: bk.branch_city ?? null,
    },
    escalations: escalationRes.rows,
    pricingBreakdown: bk.pricing_breakdown ?? null,
    createdAt: bk.created_at ?? null,
    updatedAt: null,
  };
};

// ─── Timeline ─────────────────────────────────────────────────────────────────

export const getBookingTimeline = async (bookingId: number): Promise<any[]> => {
  const [trackingRes, adminRes] = await Promise.all([
    dbQuery.query(
      `SELECT 'tracking_' || id::text AS id, status AS event_type, status AS title,
              note AS description, 'system' AS actor_type, NULL AS actor_uid,
              created_at, NULL AS metadata
       FROM ${dbSchema}.booking_tracking WHERE booking_id = $1`,
      [bookingId]
    ),
    dbQuery.query(
      `SELECT 'admin_' || id::text AS id, event_type, title, description,
              actor_type, actor_uid, created_at, metadata
       FROM ${dbSchema}.booking_timeline_events WHERE booking_id = $1`,
      [bookingId]
    ),
  ]);

  return [
    ...trackingRes.rows,
    ...adminRes.rows,
  ].sort((a: any, b: any) =>
    new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );
};

// ─── Notes ────────────────────────────────────────────────────────────────────

export const getBookingNotes = async (bookingId: number): Promise<any[]> => {
  const res = await dbQuery.query(
    `SELECT n.id, n.booking_id, n.note_text, n.author_uid, n.created_at,
            COALESCE(uc.first_name,'') || ' ' || COALESCE(uc.last_name,'') AS author_name
     FROM ${dbSchema}.booking_notes n
     LEFT JOIN ${dbSchema}.user_credentials uc ON uc.uid = n.author_uid
     WHERE n.booking_id = $1 ORDER BY n.created_at ASC`,
    [bookingId]
  );
  return res.rows;
};

export const addBookingNote = async (
  bookingId: number,
  text: string,
  authorUid: string | null
): Promise<any> => {
  if (!text?.trim()) throw new Error('Note text is required');

  const res = await dbQuery.query(
    `INSERT INTO ${dbSchema}.booking_notes (booking_id, note_text, author_uid)
     VALUES ($1, $2, $3) RETURNING *`,
    [bookingId, text.trim(), authorUid]
  );

  await addTimelineEvent(
    bookingId, 'admin_note_added', 'Admin note added',
    text.substring(0, 100), 'admin', authorUid
  );
  logBookingAudit({
    bookingId, actorUid: authorUid, actorRole: 'admin',
    action: 'admin_note_added', after: { text: text.substring(0, 200) },
  });

  return res.rows[0];
};

// ─── Assignment Candidates ────────────────────────────────────────────────────

export const getAssignmentCandidates = async (bookingId: number): Promise<any[]> => {
  const bkRes = await dbQuery.query(
    `SELECT b.schedule, so.service_id
     FROM ${dbSchema}.bookings b
     JOIN ${dbSchema}.service_options so ON so.id = b.service_option_id
     WHERE b.id = $1`,
    [bookingId]
  );
  if (!bkRes.rowCount) return [];

  const { schedule, service_id } = bkRes.rows[0];
  const serviceId = Number(service_id);

  const providersRes = await dbQuery.query(
    `SELECT uc.uid, uc.first_name, uc.last_name, uc.phone_number
     FROM ${dbSchema}.user_credentials uc
     JOIN ${dbSchema}.employee_services es ON es.employee_uid = uc.uid
     WHERE es.service_id = $1 AND uc.is_archive = false AND uc.role::int = 2`,
    [serviceId]
  );

  const windowStart = new Date(new Date(schedule).getTime() - 2 * 60 * 60 * 1000);
  const windowEnd   = new Date(new Date(schedule).getTime() + 2 * 60 * 60 * 1000);

  const busyRes = await dbQuery.query(
    `SELECT DISTINCT worker_uid FROM ${dbSchema}.bookings
     WHERE schedule BETWEEN $1 AND $2
       AND status NOT IN ('COMPLETED','CANCELLED','CANCELED')
       AND worker_uid IS NOT NULL AND id != $3`,
    [windowStart, windowEnd, bookingId]
  );
  const busyUids = new Set(busyRes.rows.map((r: any) => r.worker_uid));

  return providersRes.rows.map((p: any) => ({
    providerUid: p.uid,
    displayName: (`${p.first_name ?? ''} ${p.last_name ?? ''}`).trim() || 'Unnamed Provider',
    phoneNumber: p.phone_number ?? null,
    serviceMatch: true,
    availabilityMatch: !busyUids.has(p.uid),
    serviceAreaMatch: 'unknown',
    distanceKm: null,
    eligibilityStatus: busyUids.has(p.uid) ? 'warning' : 'eligible',
    eligibilityReasons: busyUids.has(p.uid)
      ? ['Provider has a conflicting booking within 2 hours']
      : [],
  }));
};

// ─── Admin Assign Provider ────────────────────────────────────────────────────

export const adminAssignProvider = async (
  bookingId: number,
  providerUid: string,
  adminUid: string | null,
  reason?: string
): Promise<any> => {
  const bkRes = await dbQuery.query(
    `SELECT id, status, worker_uid FROM ${dbSchema}.bookings WHERE id = $1`,
    [bookingId]
  );
  if (!bkRes.rowCount) throw new Error('Booking not found');
  const before = bkRes.rows[0];

  const provRes = await dbQuery.query(
    `SELECT uid, first_name, last_name, is_archive FROM ${dbSchema}.user_credentials
     WHERE uid = $1 AND role::int = 2`,
    [providerUid]
  );
  if (!provRes.rowCount) throw new Error('Provider not found');
  if (provRes.rows[0].is_archive) throw new Error('Provider is archived and cannot be assigned');

  const soRes = await dbQuery.query(
    `SELECT so.service_id FROM ${dbSchema}.bookings b
     JOIN ${dbSchema}.service_options so ON so.id = b.service_option_id
     WHERE b.id = $1`,
    [bookingId]
  );
  const serviceId = soRes.rows[0]?.service_id;
  if (serviceId) {
    const eligRes = await dbQuery.query(
      `SELECT 1 FROM ${dbSchema}.employee_services
       WHERE employee_uid = $1 AND service_id = $2 LIMIT 1`,
      [providerUid, serviceId]
    );
    if (!eligRes.rowCount) throw new Error('Provider is not qualified for this booking service');
  }

  await dbQuery.query(
    `INSERT INTO ${dbSchema}.booking_workers (worker_uid, booking_id, status, assigned_at)
     VALUES ($1, $2, 'ASSIGNED', NOW())`,
    [providerUid, bookingId]
  );

  await dbQuery.query(
    `UPDATE ${dbSchema}.bookings SET worker_uid = $1, status = 'WORKER_ASSIGNED' WHERE id = $2`,
    [providerUid, bookingId]
  );

  const providerName = (`${provRes.rows[0].first_name ?? ''} ${provRes.rows[0].last_name ?? ''}`).trim();

  await addTimelineEvent(
    bookingId, 'booking_assigned',
    `Provider assigned: ${providerName}`,
    reason ?? null, 'admin', adminUid,
    { providerUid, providerName }
  );

  logBookingAudit({
    bookingId, actorUid: adminUid, actorRole: 'admin',
    action: 'booking_assigned',
    before: { workerUid: before.worker_uid, status: before.status },
    after:  { workerUid: providerUid, status: 'WORKER_ASSIGNED' },
    reason,
  });

  return { bookingId, providerUid, providerName, status: 'WORKER_ASSIGNED' };
};

// ─── Admin Reassign Provider ──────────────────────────────────────────────────

export const adminReassignProvider = async (
  bookingId: number,
  toProviderUid: string,
  adminUid: string | null,
  reason: string
): Promise<any> => {
  if (!reason?.trim()) throw new Error('Reason is required for reassignment');

  const bkRes = await dbQuery.query(
    `SELECT worker_uid, status FROM ${dbSchema}.bookings WHERE id = $1`,
    [bookingId]
  );
  if (!bkRes.rowCount) throw new Error('Booking not found');

  const fromProviderUid = bkRes.rows[0].worker_uid;

  const provRes = await dbQuery.query(
    `SELECT uid, first_name, last_name, is_archive FROM ${dbSchema}.user_credentials
     WHERE uid = $1 AND role::int = 2`,
    [toProviderUid]
  );
  if (!provRes.rowCount) throw new Error('New provider not found');
  if (provRes.rows[0].is_archive) throw new Error('New provider is archived');

  if (fromProviderUid) {
    await dbQuery.query(
      `UPDATE ${dbSchema}.booking_workers SET status = 'DECLINED'
       WHERE booking_id = $1 AND worker_uid = $2 AND status IN ('ASSIGNED','ACCEPTED')`,
      [bookingId, fromProviderUid]
    );
  }

  await dbQuery.query(
    `INSERT INTO ${dbSchema}.booking_workers (worker_uid, booking_id, status, assigned_at)
     VALUES ($1, $2, 'ASSIGNED', NOW())`,
    [toProviderUid, bookingId]
  );

  await dbQuery.query(
    `UPDATE ${dbSchema}.bookings SET worker_uid = $1, status = 'WORKER_ASSIGNED' WHERE id = $2`,
    [toProviderUid, bookingId]
  );

  const providerName = (`${provRes.rows[0].first_name ?? ''} ${provRes.rows[0].last_name ?? ''}`).trim();

  await addTimelineEvent(
    bookingId, 'provider_reassigned',
    `Provider reassigned to ${providerName}`,
    reason, 'admin', adminUid,
    { fromProviderUid, toProviderUid, providerName }
  );

  logBookingAudit({
    bookingId, actorUid: adminUid, actorRole: 'admin',
    action: 'booking_reassigned',
    before: { workerUid: fromProviderUid },
    after:  { workerUid: toProviderUid },
    reason,
  });

  return { bookingId, fromProviderUid, toProviderUid, providerName };
};

// ─── Admin Reschedule ─────────────────────────────────────────────────────────

export const adminRescheduleBooking = async (
  bookingId: number,
  scheduledAt: string,
  reason: string,
  adminUid: string | null
): Promise<any> => {
  if (!reason?.trim()) throw new Error('Reason is required for reschedule');
  if (!scheduledAt) throw new Error('scheduledAt is required');

  const bkRes = await dbQuery.query(
    `SELECT schedule, status FROM ${dbSchema}.bookings WHERE id = $1`,
    [bookingId]
  );
  if (!bkRes.rowCount) throw new Error('Booking not found');

  const prevSchedule = bkRes.rows[0].schedule;

  await dbQuery.query(
    `UPDATE ${dbSchema}.bookings SET schedule = $1 WHERE id = $2`,
    [scheduledAt, bookingId]
  );

  await addTimelineEvent(
    bookingId, 'booking_rescheduled',
    'Booking rescheduled by admin',
    reason, 'admin', adminUid,
    { from: prevSchedule, to: scheduledAt }
  );

  logBookingAudit({
    bookingId, actorUid: adminUid, actorRole: 'admin',
    action: 'booking_rescheduled',
    before: { schedule: prevSchedule },
    after:  { schedule: scheduledAt },
    reason,
  });

  return { bookingId, scheduledAt };
};

// ─── Admin Cancel ─────────────────────────────────────────────────────────────

export const adminCancelBooking = async (
  bookingId: number,
  reason: string,
  adminUid: string | null,
  reasonCode?: string,
  refundAction?: string
): Promise<any> => {
  if (!reason?.trim()) throw new Error('Reason is required for cancellation');

  const bkRes = await dbQuery.query(
    `SELECT status FROM ${dbSchema}.bookings WHERE id = $1`,
    [bookingId]
  );
  if (!bkRes.rowCount) throw new Error('Booking not found');

  const prevStatus = bkRes.rows[0].status;
  if (['CANCELLED', 'CANCELED', 'COMPLETED'].includes((prevStatus ?? '').toUpperCase())) {
    throw new Error(`Cannot cancel booking with status: ${prevStatus}`);
  }

  await dbQuery.query(
    `UPDATE ${dbSchema}.bookings SET status = 'CANCELLED', cancelled_at = NOW() WHERE id = $1`,
    [bookingId]
  );

  await dbQuery.query(
    `UPDATE ${dbSchema}.booking_workers SET status = 'CANCELED'
     WHERE booking_id = $1 AND status IN ('ASSIGNED','ACCEPTED')`,
    [bookingId]
  );

  await addTimelineEvent(
    bookingId, 'booking_cancelled',
    'Booking cancelled by admin',
    reason, 'admin', adminUid,
    { reasonCode, refundAction }
  );

  logBookingAudit({
    bookingId, actorUid: adminUid, actorRole: 'admin',
    action: 'booking_cancelled',
    before: { status: prevStatus },
    after:  { status: 'CANCELLED' },
    reason,
  });

  return { bookingId, status: 'CANCELLED' };
};

// ─── Admin Escalate ───────────────────────────────────────────────────────────

export const adminEscalateBooking = async (
  bookingId: number,
  reason: string,
  severity: string,
  adminUid: string | null,
  opts?: { reasonCode?: string; assignedTeam?: string }
): Promise<any> => {
  if (!reason?.trim()) throw new Error('Reason is required for escalation');

  const bkRes = await dbQuery.query(
    `SELECT id FROM ${dbSchema}.bookings WHERE id = $1`,
    [bookingId]
  );
  if (!bkRes.rowCount) throw new Error('Booking not found');

  const escRes = await dbQuery.query(
    `INSERT INTO ${dbSchema}.booking_escalations
       (booking_id, reason_code, reason, severity, assigned_team, actor_uid)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [bookingId, opts?.reasonCode ?? null, reason, severity ?? 'normal', opts?.assignedTeam ?? null, adminUid]
  );

  await addTimelineEvent(
    bookingId, 'dispute_opened',
    `Dispute opened (${severity ?? 'normal'})`,
    reason, 'admin', adminUid,
    { severity, reasonCode: opts?.reasonCode }
  );

  logBookingAudit({
    bookingId, actorUid: adminUid, actorRole: 'admin',
    action: 'booking_escalated',
    after:  { reason, severity },
    reason,
  });

  return escRes.rows[0];
};

// ─── Admin Approve Completion ─────────────────────────────────────────────────

export const adminApproveCompletion = async (
  bookingId: number,
  adminUid: string | null,
  reason?: string
): Promise<any> => {
  const bkRes = await dbQuery.query(
    `SELECT status FROM ${dbSchema}.bookings WHERE id = $1`,
    [bookingId]
  );
  if (!bkRes.rowCount) throw new Error('Booking not found');

  const prevStatus = bkRes.rows[0].status;

  await dbQuery.query(
    `UPDATE ${dbSchema}.bookings SET status = 'COMPLETED' WHERE id = $1`,
    [bookingId]
  );

  await dbQuery.query(
    `UPDATE ${dbSchema}.booking_workers
     SET status = 'COMPLETED', completed_at = NOW()
     WHERE booking_id = $1 AND status IN ('IN_PROGRESS','ACCEPTED','ASSIGNED')`,
    [bookingId]
  );

  await addTimelineEvent(
    bookingId, 'completion_approved',
    'Completion approved by admin',
    reason ?? null, 'admin', adminUid
  );

  logBookingAudit({
    bookingId, actorUid: adminUid, actorRole: 'admin',
    action: 'completion_approved',
    before: { status: prevStatus },
    after:  { status: 'COMPLETED' },
    reason,
  });

  return { bookingId, status: 'COMPLETED' };
};

// ─── Admin Confirm Provider Assignment (on behalf of provider) ────────────────

const VALID_CONSENT_METHODS = ['verbal', 'written', 'chat_message'] as const;
type ConsentMethod = typeof VALID_CONSENT_METHODS[number];

export const adminConfirmProviderAssignment = async (
  bookingId: number,
  providerUid: string,
  adminUid: string | null,
  reason: string,
  consentMethod: string,
  consentReference: string | null
): Promise<any> => {
  if (!reason?.trim()) throw new Error('reason is required');
  if (!VALID_CONSENT_METHODS.includes(consentMethod as ConsentMethod)) {
    throw new Error('consentMethod must be verbal | written | chat_message');
  }

  const bkRes = await dbQuery.query(
    `SELECT id, status, worker_uid FROM ${dbSchema}.bookings WHERE id = $1`,
    [bookingId]
  );
  if (!bkRes.rowCount) throw new Error('Booking not found');
  const bk = bkRes.rows[0];

  const rawStatus = (bk.status ?? '').toUpperCase();
  if (['CANCELLED', 'CANCELED', 'COMPLETED'].includes(rawStatus)) {
    throw new Error(`Cannot confirm assignment — booking status is ${bk.status}`);
  }
  if (rawStatus === 'IN_PROGRESS') {
    throw new Error('Booking is already in progress');
  }

  const bwRes = await dbQuery.query(
    `SELECT worker_uid, status FROM ${dbSchema}.booking_workers
     WHERE booking_id = $1
     ORDER BY assigned_at DESC NULLS LAST
     LIMIT 1`,
    [bookingId]
  );
  if (!bwRes.rowCount) throw new Error('No provider assignment found for this booking');
  const bw = bwRes.rows[0];

  if (bw.worker_uid !== providerUid) {
    throw new Error('providerUid does not match the currently assigned provider');
  }
  if (bw.status !== 'ASSIGNED') {
    throw new Error(`Assignment cannot be confirmed — current status is ${bw.status}`);
  }

  const updateRes = await dbQuery.query(
    `UPDATE ${dbSchema}.booking_workers
     SET status              = 'ACCEPTED',
         confirmation_source = 'admin_on_behalf_of_provider',
         admin_actor_uid     = $1,
         consent_method      = $2,
         consent_reference   = $3,
         confirmation_reason = $4,
         confirmed_at        = NOW()
     WHERE booking_id = $5
       AND worker_uid = $6
       AND status     = 'ASSIGNED'
     RETURNING confirmed_at`,
    [adminUid, consentMethod, consentReference ?? null, reason, bookingId, providerUid]
  );

  if (!updateRes.rowCount) {
    throw new Error('Confirmation failed — assignment may have changed concurrently');
  }

  await addTimelineEvent(
    bookingId,
    'provider_acceptance_confirmed_by_admin',
    'Admin confirmed on behalf of provider',
    reason, 'admin', adminUid,
    { providerUid, consentMethod, consentReference: consentReference ?? null }
  );

  // Notify customer — same email as when provider accepts directly
  try {
    const userInfo = await getUserInfoByBookingId(bookingId);
    if (userInfo) {
      const [schedRes, workerRes] = await Promise.all([
        dbQuery.query(`SELECT schedule FROM ${dbSchema}.bookings WHERE id = $1`, [bookingId]),
        dbQuery.query(`SELECT first_name, last_name FROM ${dbSchema}.user_credentials WHERE uid = $1`, [providerUid]),
      ]);
      const schedule    = schedRes.rows[0]?.schedule;
      const workerName  = workerRes.rows[0]
        ? `${workerRes.rows[0].first_name} ${workerRes.rows[0].last_name}`
        : 'Your provider';
      send(userInfo.email, 'booking_accepted', {
        first_name:   userInfo.firstName,
        booking_id:   bookingId,
        worker_name:  workerName,
        booking_date: schedule ? new Date(schedule).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '',
        booking_time: schedule ? new Date(schedule).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '',
        address:      '',
      });
    }
  } catch (emailErr) {
    console.error('booking_accepted email failed (admin on behalf):', emailErr);
  }

  logBookingAudit({
    bookingId, actorUid: adminUid, actorRole: 'admin',
    action: 'booking_provider_accepted_on_behalf',
    before: { assignmentStatus: 'ASSIGNED' },
    after:  { assignmentStatus: 'ACCEPTED', confirmationSource: 'admin_on_behalf_of_provider', consentMethod },
    reason,
  });

  return {
    bookingId,
    providerUid,
    confirmationSource: 'admin_on_behalf_of_provider',
    confirmedAt: updateRes.rows[0].confirmed_at,
    consentMethod,
  };
};
