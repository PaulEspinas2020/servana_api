import { db } from "../config";
import dbQuery, { pool } from "../db/dbQuery";
import { send } from "../helpers/mailer";
import { getUserInfoByBookingId } from "./user.service";
import {
  handleProviderReassignment,
  closeConversationForCancellation,
  openConversationForConfirmedBooking,
  escalateToSupport,
} from "../chat/chat.service";
import { createCustomerNotification, createNotification } from "./notification.service";
import { emitToProvider } from "../provider.realtime";
import { deriveCanonicalState } from "./booking/canonicalState";
import { toAdminProjection } from "./booking/projections";
import { adminOpsStatusSql, normaliseProviderUid } from "./booking/adminOpsStatusSql";
import {
  transitionBooking,
  TransitionError,
  type TransitionResult,
} from './booking/transitionExecutor';
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

  // Sparse partial indexes for admin-confirm-on-behalf audit queries
  try {
    await dbQuery.query(
      `CREATE INDEX IF NOT EXISTS idx_bw_confirmation_source ON ${dbSchema}.booking_workers (confirmation_source) WHERE confirmation_source IS NOT NULL`,
      []
    );
    await dbQuery.query(
      `CREATE INDEX IF NOT EXISTS idx_bw_consent_method ON ${dbSchema}.booking_workers (consent_method) WHERE consent_method IS NOT NULL`,
      []
    );
  } catch { /* indexes optional — non-fatal if DDL fails */ }
};

// ─── Internal helpers ─────────────────────────────────────────────────────────

const logBookingAudit = (
  event: AuditEvent,
  runner: { query: (sql: string, params?: any[]) => Promise<any> } = dbQuery,
): Promise<void> | void => {
  const write = runner.query(
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
  );
  if (runner === dbQuery) {
    write.catch((e) => { console.error('[booking-audit] write failed:', e?.message); });
    return;
  }
  return write.then(() => undefined);
};

const addTimelineEvent = async (
  bookingId: number,
  eventType: string,
  title: string,
  description: string | null = null,
  actorType: string = 'admin',
  actorUid: string | null = null,
  metadata: any = null,
  runner: { query: (sql: string, params?: any[]) => Promise<any> } = dbQuery,
): Promise<void> => {
  await runner.query(
    `INSERT INTO ${dbSchema}.booking_timeline_events
       (booking_id, event_type, title, description, actor_type, actor_uid, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [bookingId, eventType, title, description, actorType, actorUid,
     metadata ? JSON.stringify(metadata) : null]
  );
};

const publishAdminAssignment = (input: {
  bookingId: number;
  providerUid: string;
  customerUid?: string | null;
  reassigned?: boolean;
}) => {
  const code = `SVN-${String(input.bookingId).padStart(6, '0')}`;
  createNotification(input.providerUid, {
    notificationKey: `assigned_job_${input.bookingId}_${input.providerUid}`,
    type: 'assigned_job',
    severity: 'info',
    title: input.reassigned ? 'Booking reassigned to you' : 'New Job Assigned',
    safeBody: `You have been assigned to booking ${code}. Please review and respond.`,
    safeContextLabel: code,
    route: { page: 'jobs', bookingId: String(input.bookingId) },
    canOpenDetail: true,
  }).catch((e) => console.error('[admin-assignment] provider notification failed', e));

  if (input.customerUid) {
    createCustomerNotification(input.customerUid, {
      notificationKey: `provider_assigned_${input.bookingId}`,
      type: input.reassigned ? 'provider_reassigned' : 'provider_assigned',
      severity: 'success',
      title: input.reassigned ? 'Provider updated' : 'Provider assigned',
      safeBody: input.reassigned
        ? 'A new provider has been assigned and is reviewing your booking.'
        : 'A provider has been assigned and is reviewing your booking.',
      safeContextLabel: code,
      route: { routeKey: 'BOOKING_DETAILS', resourceId: String(input.bookingId) },
      canOpenDetail: true,
    }).catch((e) => console.error('[admin-assignment] customer notification failed', e));
  }

  emitToProvider(input.providerUid, 'booking:updated', {
    bookingId: String(input.bookingId),
    status: 'ASSIGNED',
    assignmentSource: input.reassigned ? 'admin_reassignment' : 'admin',
    occurredAt: new Date().toISOString(),
  });
};

// ─── Operations Status Mapping ────────────────────────────────────────────────

/**
 * Admin operations status — now a PROJECTION of the canonical machine.
 *
 * ## What this used to be
 *
 * A second, independent collapse of `bookings.status` + `booking_workers.status`,
 * with its own rules and its own vocabulary. It disagreed with the
 * customer/provider derivation in ways that mattered: it reported a provider
 * who was EN_ROUTE or ARRIVED as merely `accepted`, and it alone knew about
 * disputes. One booking, three surfaces, three answers.
 *
 * It now derives the canonical state and asks the Admin projection to name it.
 * Both are shared with Customer and Provider, so the three cannot diverge.
 *
 * ## It still collapses EN_ROUTE and ARRIVED, and that is deliberate
 *
 * The Admin portal types this value as a closed union and looks its label and
 * colour up in `Record<AdminBookingOperationsStatus, …>` maps. An unknown key
 * returns `undefined`, so emitting `en_route` today renders a blank badge on a
 * live platform.
 *
 * The collapse is therefore COMPATIBILITY DEBT rather than canonical truth. The
 * full state travels beside it in `canonicalState` / `stateGroup` (see
 * `bookingCanonicalStateFor`), which the current portal ignores and the next
 * version reads. Once the portal consumes those, this function can be retired
 * on telemetry.
 *
 * ## Three behaviour changes, all deliberate
 *
 * 1. An open escalation now outranks a terminal booking rather than being
 *    checked before cancellation only — the transition table already allows
 *    COMPLETED → DISPUTED, and a dispute ABOUT a cancellation is exactly the
 *    case somebody escalates. Admin's visible behaviour is unchanged: it showed
 *    `disputed` first before, and still does.
 * 2. A status this platform does not recognise now reports
 *    `awaiting_assignment` instead of `new`. An unrecognised status is by
 *    definition not new, and surfacing it as needing a provider puts it in
 *    front of an admin rather than mislabelling it.
 * 3. A booking whose assignment row is DECLINED, REASSIGNED or CANCELLED now
 *    reports `awaiting_assignment` instead of `assigned`, as does one still at
 *    `WORKER_ASSIGNED` with `worker_uid` NULL. `declineJob` does not rewrite
 *    `bookings.status`, so those rows sat in the admin list labelled Assigned
 *    with nobody on them — the queue that most needs an operator's attention
 *    was the one hidden from it. Both values are already in the portal's closed
 *    union, so no badge goes blank. Found by the B1.1 accept tests, which
 *    caught the same gap letting a provider re-accept a job they had declined.
 */
export const mapOperationsStatus = (
  bookingStatus: string | null,
  workerStatus: string | null,
  workerUid: string | null,
  hasEscalation: boolean = false
): OperationsStatus => {
  const canonical = deriveCanonicalState({ bookingStatus, workerStatus, workerUid, hasEscalation });
  return toAdminProjection(canonical).operationsStatus as OperationsStatus;
};

/**
 * The full canonical state for a booking row, for the fields the portal will
 * read once migrated. Additive — nothing today consumes it, and it is what
 * makes the collapse above survivable rather than lossy.
 */
export const bookingCanonicalStateFor = (
  bookingStatus: string | null,
  workerStatus: string | null,
  workerUid: string | null,
  hasEscalation: boolean = false
) => toAdminProjection(deriveCanonicalState({ bookingStatus, workerStatus, workerUid, hasEscalation }));

// ─── Admin Booking List ───────────────────────────────────────────────────────

export const getAdminBookings = async (
  filter: BookingListFilter
): Promise<{ rows: any[]; total: number; page: number; limit: number }> => {
  const rawPage = Number(filter.page);
  const rawLimit = Number(filter.limit);
  const page = Number.isFinite(rawPage) ? Math.max(1, Math.trunc(rawPage)) : 1;
  const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, Math.trunc(rawLimit))) : 25;
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
      OR gc.email ILIKE $${pi}
      OR gc.phone_normalized ILIKE $${pi}
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
    conditions.push(`lp.payment_status = $${pi}`);
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
    // Match the canonical ops_status='awaiting_assignment' predicate exactly
    conditions.push(`(b.worker_uid IS NULL OR b.worker_uid = '') AND b.status IN ('CONFIRMED', 'PAID')`);
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
  if (filter.needsAdminAction === true) {
    conditions.push(`
      (b.worker_uid IS NULL OR b.worker_uid = '')
      AND b.status IN ('PENDING_OTP', 'CONFIRMED', 'PAID')
    `);
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
        booking_id, worker_uid, status AS worker_status, assigned_at, confirmation_source
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
        la.confirmation_source,
        lp.payment_status,
        CASE WHEN b.guest_customer_id IS NOT NULL THEN 'guest' ELSE 'client' END AS customer_type,
        b.guest_customer_id::text                    AS guest_customer_id,
        COALESCE(cu.uid, b.guest_customer_id::text)  AS customer_uid,
        COALESCE(
          NULLIF(TRIM(COALESCE(cu.first_name,'') || ' ' || COALESCE(cu.last_name,'')), ''),
          TRIM(COALESCE(gc.first_name,'') || ' ' || COALESCE(gc.last_name,''))
        )                                            AS customer_name,
        COALESCE(wu.first_name,'') || ' ' || COALESCE(wu.last_name,'') AS provider_name,
        s.id                                         AS service_id,
        so.id                                        AS service_option_id,
        s.name                                       AS service_name,
        so.level_3                                   AS specific_service_name,
        br.id                                        AS branch_id,
        br.name                                      AS branch_name,
        br.city                                      AS branch_city,
EXISTS (SELECT 1 FROM ${dbSchema}.booking_escalations esc2
                 WHERE esc2.booking_id = b.id AND esc2.resolved_at IS NULL) AS has_escalation,
${adminOpsStatusSql({ schema: dbSchema, bookingAlias: 'b', assignmentAlias: 'la' })} AS ops_status
      FROM ${dbSchema}.bookings b
      LEFT JOIN ${dbSchema}.user_credentials cu  ON cu.uid  = b.user_id
      LEFT JOIN ${dbSchema}.guest_customers  gc  ON gc.guest_customer_id = b.guest_customer_id
      LEFT JOIN ${dbSchema}.service_options so   ON so.id   = b.service_option_id
      LEFT JOIN ${dbSchema}.service_families s           ON s.id    = so.service_id
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
      normaliseProviderUid(row.worker_uid),
    );
    const isLate = !!row.scheduled_at &&
      new Date(row.scheduled_at) < new Date() &&
      !['completed', 'cancelled'].includes(opStatus);

    /**
     * The canonical state travels BESIDE the legacy field, never instead of it.
     *
     * `operationsStatus` cannot express EN_ROUTE or ARRIVED and reports both as
     * `accepted`; the portal's badge maps are keyed on the legacy union, so
     * removing it would blank a badge on a live platform. Additive per §4:
     * the new portal reads `canonicalState`, the old one keeps working, and the
     * legacy field retires on telemetry rather than on optimism.
     */
    const canonical = bookingCanonicalStateFor(
      row.raw_status,
      row.worker_status,
      normaliseProviderUid(row.worker_uid),
      !!row.has_escalation,
    );

    return {
      bookingId: row.booking_id,
      rawStatus: row.raw_status,
      operationsStatus: opStatus,
      canonicalState: canonical.canonicalState,
      stateGroup: canonical.stateGroup,
      stateLabel: canonical.label,
      stateIsCollapsedInLegacyField: canonical.stateIsCollapsedInLegacyField,
      terminal: canonical.terminal,
      customerType: (row.customer_type as 'guest' | 'client') ?? 'client',
      customerUid: row.customer_uid ?? null,
      guestCustomerId: row.guest_customer_id ?? null,
      customerName: (row.customer_name ?? '').trim() || null,
      providerUid: row.provider_uid ?? null,
      providerName: (row.provider_name ?? '').trim() || null,
      assignmentStatus: row.worker_status ?? null,
      confirmationSource: (row.confirmation_source as 'admin_on_behalf_of_provider' | null) ?? null,
      serviceId: row.service_id ?? null,
      serviceOptionId: row.service_option_id ?? null,
      serviceName: row.service_name ?? null,
      specificServiceName: row.specific_service_name ?? null,
      scheduledAt: row.scheduled_at ?? null,
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
      hasDispute: opStatus === 'disputed',
      needsAdminAction: !row.worker_uid && ['new', 'awaiting_assignment'].includes(opStatus),
      createdAt: row.created_at ?? null,
      updatedAt: null,
    };
  });

  return { rows, total: Number(countRes.rows[0]?.total ?? 0), page, limit };
};

// ─── Metrics ─────────────────────────────────────────────────────────────────

export const getAdminBookingMetrics = async (): Promise<any> => {
  const res = await dbQuery.query(`
    WITH latest_assignment AS (
      SELECT DISTINCT ON (booking_id)
        booking_id, worker_uid, status AS worker_status
      FROM ${dbSchema}.booking_workers
      ORDER BY booking_id, assigned_at DESC NULLS LAST
    ),
    escalated AS (
      SELECT DISTINCT booking_id
      FROM ${dbSchema}.booking_escalations
      WHERE resolved_at IS NULL
    )
    SELECT b.id, b.status, b.worker_uid, la.worker_status,
           CASE WHEN e.booking_id IS NOT NULL THEN TRUE ELSE FALSE END AS has_escalation
    FROM ${dbSchema}.bookings b
    LEFT JOIN latest_assignment la ON la.booking_id = b.id
    LEFT JOIN escalated e ON e.booking_id = b.id
  `, []);

  const counts: Record<string, number> = {
    total: 0, new: 0, awaiting_assignment: 0,
    assigned: 0, accepted: 0, in_progress: 0,
    completed: 0, cancelled: 0, disputed: 0,
  };

  for (const row of res.rows) {
    counts['total']++;
    const s = mapOperationsStatus(
      row.status, row.worker_status, normaliseProviderUid(row.worker_uid), !!row.has_escalation,
    );
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
      b.guest_customer_id, b.service_address, b.admin_created,
      CASE WHEN b.guest_customer_id IS NOT NULL THEN 'guest' ELSE 'client' END AS customer_type,
      COALESCE(
        NULLIF(TRIM(COALESCE(cu.first_name,'') || ' ' || COALESCE(cu.last_name,'')), ''),
        TRIM(COALESCE(gc.first_name,'') || ' ' || COALESCE(gc.last_name,''))
      )                                              AS customer_name,
      COALESCE(cu.uid, b.guest_customer_id::text)   AS customer_uid,
      COALESCE(cu.phone_number, gc.phone_normalized) AS customer_phone,
      COALESCE(cu.email, gc.email)                   AS customer_email,
      gc.guest_customer_id  AS gc_id,
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
      COALESCE(ua.address_one, b.service_address->>'addressLine')        AS address_line,
      COALESCE(ua.post_town,   b.service_address->>'city')               AS post_town,
      ua.country,
      ua.zip_code,
      (b.service_address->>'lat')::numeric                               AS lat,
      (b.service_address->>'lon')::numeric                               AS lon
    FROM ${dbSchema}.bookings b
    LEFT JOIN ${dbSchema}.user_credentials cu ON cu.uid = b.user_id
    LEFT JOIN ${dbSchema}.guest_customers  gc ON gc.guest_customer_id = b.guest_customer_id
    LEFT JOIN ${dbSchema}.service_options so  ON so.id  = b.service_option_id
    LEFT JOIN ${dbSchema}.service_families s          ON s.id   = so.service_id
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
      SELECT bw.*, wu.first_name || ' ' || wu.last_name AS worker_name, wu.phone_number AS worker_phone,
             up.photo_url AS worker_photo_url
      FROM ${dbSchema}.booking_workers bw
      LEFT JOIN ${dbSchema}.user_credentials wu ON wu.uid = bw.worker_uid
      LEFT JOIN ${dbSchema}.user_profile up ON up.uid = bw.worker_uid
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
  /**
   * Only an UNRESOLVED escalation makes a booking disputed.
   *
   * This counted every escalation row, so a settled dispute pinned the booking
   * at `disputed` permanently — while the list and the metrics query, which
   * both filter on `resolved_at IS NULL`, moved on. Two of the three call sites
   * already agreed; this was the one that did not.
   */
  const hasEscalation = escalationRes.rows.some((e: any) => e.resolved_at === null);
  const opStatus = mapOperationsStatus(
    bk.status,
    assignment?.status ?? null,
    normaliseProviderUid(bk.worker_uid),
    hasEscalation,
  );

  const canonical = bookingCanonicalStateFor(
    bk.status,
    assignment?.status ?? null,
    normaliseProviderUid(bk.worker_uid),
    hasEscalation,
  );

  return {
    bookingId: bk.id,
    rawStatus: bk.status,
    operationsStatus: opStatus,
    canonicalState: canonical.canonicalState,
    stateGroup: canonical.stateGroup,
    stateLabel: canonical.label,
    stateIsCollapsedInLegacyField: canonical.stateIsCollapsedInLegacyField,
    terminal: canonical.terminal,
    /**
     * What an admin may actually do from here, from the SAME transition
     * whitelist the executor enforces. The portal previously hard-coded these
     * as string arrays against `operationsStatus`, which is how a button stays
     * enabled for a state that has since stopped accepting it.
     */
    availableActions: canonical.availableActions,
    customer: {
      uid: bk.customer_uid ?? null,
      name: (bk.customer_name ?? '').trim() || null,
      phone: bk.customer_phone ?? null,
      email: bk.customer_email ?? null,
      customerType: (bk.customer_type as 'guest' | 'client') ?? 'client',
      guestCustomerId: bk.gc_id ?? null,
    },
    adminCreated: bk.admin_created ?? false,
    serviceAddress: bk.service_address ?? null,
    providerAssignment: assignment ? {
      providerUid: assignment.worker_uid,
      name: (assignment.worker_name ?? '').trim() || null,
      phone: assignment.worker_phone ?? null,
      photoUrl: assignment.worker_photo_url ?? null,
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

  // Two corrections here, both about matching what adminAssignProvider will actually
  // accept — a candidate list narrower than the assign guard hides usable providers,
  // and one wider than it offers providers the assign will reject.
  //
  //  1. role IN (2,4), not role = 2. Role 4 is the second provider role (internal /
  //     employee providers) and every other provider query in the codebase uses
  //     IN (2,4). Filtering on 2 alone meant no internal provider could ever be
  //     offered for a booking. Role 6 is deliberately NOT included: two production
  //     accounts hold it and its meaning is undefined, so it fails closed.
  //  2. Qualification is employee_services OR an approved worker_service_application,
  //     which is exactly the UNION adminAssignProvider's eligibility check uses. The
  //     INNER JOIN on employee_services alone hid providers whose approval had not
  //     been mirrored into that table yet — assignable, but never listed.
  const providersRes = await dbQuery.query(
    `SELECT DISTINCT uc.uid, uc.first_name, uc.last_name, uc.phone_number
     FROM ${dbSchema}.user_credentials uc
     WHERE uc.is_archive = false
       AND uc.role::int IN (2, 4)
       AND (
         EXISTS (SELECT 1 FROM ${dbSchema}.employee_services es
                  WHERE es.employee_uid = uc.uid AND es.service_id = $1)
         OR EXISTS (SELECT 1 FROM ${dbSchema}.worker_service_applications wsa
                     WHERE wsa.worker_uid = uc.uid AND wsa.service_id = $1
                       AND wsa.status = 'approved')
       )`,
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

/**
 * ─── D4 · ADMIN_ASSIGN, on the canonical executor ────────────────────────────
 *
 * Everything that has to be true at the moment of commit now happens inside
 * ONE transaction holding TWO locks, in a fixed order: the booking row, then
 * a provider-scoped advisory lock.
 *
 * ## Why the target validation moved with it
 *
 * The ±2-hour conflict check is meaningful only while the provider advisory
 * lock is held — without it, two admins assigning the same provider to two
 * overlapping bookings both read "no conflict" and both commit. Validating
 * here and then calling the executor would put the check outside the lock and
 * recreate the race, so provider existence, role, archive state,
 * qualification and the conflict check are all executor-side now.
 *
 * That is NOT provider selection. Which provider to suggest, how to rank them
 * and whether auto-assignment picks them remain TAB 05's. This is the atomic
 * validation required to safely commit a provider somebody already chose.
 *
 * ## BEHAVIOUR CHANGE: role-4 providers are assignable
 *
 * The legacy predicate was `role::int = 2`, so an admin could not assign a
 * role-4 provider and was told "Provider not found". Roles 2 AND 4 are
 * providers — this same file already used `IN (2, 4)` elsewhere. The predicate
 * is now built from the canonical role set, so the two cannot disagree again.
 *
 * ## Lock ORDER changed, deliberately
 *
 * Legacy took the advisory lock BEFORE the booking row. The executor takes the
 * booking row first. Two paths acquiring the same pair in opposite orders is a
 * deadlock, so one order is standardised and enforced by test.
 */
export const adminAssignProvider = async (
  bookingId: number,
  providerUid: string,
  adminUid: string | null,
  reason?: string
): Promise<any> => {
  const context = await dbQuery.query(
    `SELECT b.user_id, b.worker_uid,
            uc.first_name, uc.last_name
       FROM ${dbSchema}.bookings b
       LEFT JOIN ${dbSchema}.user_credentials uc ON uc.uid = $2
      WHERE b.id = $1`,
    [bookingId, providerUid],
  );
  if (!context.rowCount) throw new Error('Booking not found');
  const customerUid: string | null = context.rows[0].user_id ?? null;
  const providerName = (`${context.rows[0].first_name ?? ''} ${context.rows[0].last_name ?? ''}`).trim();

  /**
   * Already assigned to THIS provider: idempotent success, as before.
   *
   * Checked ahead of the executor because the machine would answer
   * INVALID_TRANSITION for a booking already at ASSIGNED, and this endpoint
   * has always returned success for a repeat of the same assignment.
   */
  if (context.rows[0].worker_uid) {
    if (String(context.rows[0].worker_uid) !== providerUid) {
      throw new Error('Booking is already assigned; use the reassignment action');
    }
    return { bookingId, providerUid, providerName, status: 'WORKER_ASSIGNED', idempotent: true };
  }

  try {
    await transitionBooking({
      action: 'ADMIN_ASSIGN',
      bookingId,
      actorRole: 'admin',
      actorUid: adminUid,
      metadata: {
        providerUid,
        providerName,
        ...(reason ? { reason } : {}),
      },
    });
  } catch (error) {
    if (error instanceof TransitionError) {
      // GUARD_FAILED carries the legacy message verbatim; everything else is
      // the state machine refusing, which legacy reported by status.
      throw new Error(
        error.code === 'GUARD_FAILED'
          ? error.message
          : `Booking cannot be assigned from status ${context.rows[0].worker_uid ?? 'unknown'}`,
      );
    }
    throw error;
  }

  await logBookingAudit({
    bookingId, actorUid: adminUid, actorRole: 'admin', action: 'booking_assigned',
    before: { workerUid: null, status: null },
    after: { workerUid: providerUid, status: 'WORKER_ASSIGNED' }, reason,
  });

  publishAdminAssignment({ bookingId, providerUid, customerUid });
  return { bookingId, providerUid, providerName, status: 'WORKER_ASSIGNED' };
};

// ─── Admin Reassign Provider ──────────────────────────────────────────────────

/**
 * ─── D5 · ADMIN_REASSIGN, on the canonical executor ──────────────────────────
 *
 * The last admin lifecycle writer. Everything now happens in one transaction
 * holding the booking row lock and — only for the INCOMING provider — the
 * provider advisory lock, in that order.
 *
 * ## The same-provider no-op is preserved exactly
 *
 * Reassigning to the provider a booking already has succeeds and writes
 * nothing: no closed row, no new row, no pointer change, no worker-code
 * change, no canonical event, no timeline, no notification. It is declared on
 * the action as `sameTarget: IDEMPOTENT_NO_OP` rather than falling out of a
 * generic `from === to` rule, because writing nothing is the SAFE answer and
 * the unsafe one is easy to reach by accident: closing and recreating the same
 * provider's row would fabricate decline history that both the matching
 * exclusion and the provider's acceptance rate read.
 *
 * Its precedence is preserved too. Legacy checked it before the terminal-status
 * guard, so a same-provider reassign of a COMPLETED or CANCELLED booking
 * answers success. Odd-looking, harmless, and measured.
 *
 * ## BEHAVIOUR CORRECTION: role-4 providers accepted
 *
 * The incoming-provider lookup was `role::int = 2`, so a role-4 target failed
 * as "New provider not found" — the same defect D4 fixed on the assign path,
 * in the same file. The canonical predicate is used now.
 *
 * ## The IN_PROGRESS refusal moved, not copied
 *
 * Legacy read the assignment row and refused IN_PROGRESS / COMPLETED itself.
 * The machine already expresses that: `from` omits IN_PROGRESS, and COMPLETED
 * is terminal. So the check is NOT reimplemented here — the refusal comes from
 * the machine and is translated back into the legacy sentence at this
 * boundary, which is a compatibility translation rather than a second source
 * of truth.
 *
 * ## Outgoing row and canonical evidence are atomic
 *
 * The outgoing assignment closes as DECLINED — a compatibility value two live
 * consumers read — and `booking_transitions` records ADMIN_REASSIGN as what
 * actually happened. Both in one transaction: matching exclusion must never
 * change without the canonical explanation of why, and vice versa.
 */
export const adminReassignProvider = async (
  bookingId: number,
  toProviderUid: string,
  adminUid: string | null,
  reason: string
): Promise<any> => {
  if (!reason?.trim()) throw new Error('Reason is required for reassignment');

  const before = await dbQuery.query(
    `SELECT b.worker_uid, b.status, b.user_id,
            uc.first_name, uc.last_name
       FROM ${dbSchema}.bookings b
       LEFT JOIN ${dbSchema}.user_credentials uc ON uc.uid = $2
      WHERE b.id = $1`,
    [bookingId, toProviderUid],
  );
  if (!before.rowCount) throw new Error('Booking not found');

  const fromProviderUid: string | null = before.rows[0].worker_uid
    ? String(before.rows[0].worker_uid)
    : null;
  const customerUid: string | null = before.rows[0].user_id ?? null;
  const providerName =
    (`${before.rows[0].first_name ?? ''} ${before.rows[0].last_name ?? ''}`).trim();

  if (!fromProviderUid) throw new Error('Booking has no provider to reassign');

  let result: TransitionResult;
  try {
    result = await transitionBooking({
      action: 'ADMIN_REASSIGN',
      bookingId,
      actorRole: 'admin',
      actorUid: adminUid,
      metadata: { providerUid: toProviderUid, fromProviderUid, toProviderUid, providerName, reason },
    });
  } catch (error) {
    if (error instanceof TransitionError) {
      // Compatibility translation, not a second source of truth. The machine
      // decided; these are the sentences this endpoint has always produced.
      if (error.code === 'GUARD_FAILED') {
        // Target-validation messages, already the legacy wording apart from
        // the "New provider" prefix this endpoint uses.
        throw new Error(error.message.replace(/^Provider /, 'New provider '));
      }
      if (error.code === 'TERMINAL_STATE') {
        throw new Error(`Booking cannot be reassigned from status ${before.rows[0].status}`);
      }
      // The only remaining refusal from these source states is a provider who
      // has already started work.
      throw new Error('Booking cannot be reassigned while provider status is IN_PROGRESS');
    }
    throw error;
  }

  // The same-provider case wrote nothing, and said nothing to anybody.
  if (result.noOp) {
    return { bookingId, fromProviderUid, toProviderUid, idempotent: true };
  }

  await logBookingAudit({
    bookingId, actorUid: adminUid, actorRole: 'admin', action: 'booking_reassigned',
    before: { workerUid: fromProviderUid }, after: { workerUid: toProviderUid }, reason,
  });

  publishAdminAssignment({
    bookingId,
    providerUid: toProviderUid,
    customerUid,
    reassigned: true,
  });
  createNotification(fromProviderUid, {
    notificationKey: `assignment_removed_${bookingId}_${fromProviderUid}`,
    type: 'assignment_removed', severity: 'warning', title: 'Booking reassigned',
    safeBody: `Booking SVN-${String(bookingId).padStart(6, '0')} is no longer assigned to you.`,
    route: null, canOpenDetail: false,
  }).catch((e) => console.error('[reassign] previous provider notification failed', e));

  // Move the booking conversation across with the assignment. The old provider
  // is marked left (can_send false), the new one admitted, and a system event
  // recorded. Fire-and-forget with its own catch: chat membership must never
  // be able to fail a reassignment that has already been committed above.
  (async () => {
    try {
      await handleProviderReassignment(bookingId, fromProviderUid, toProviderUid);
    } catch (err) {
      console.error('[reassign] chat membership update failed', bookingId, err);
    }
  })();

  return { bookingId, fromProviderUid, toProviderUid, providerName };
};

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

  const { schedule: prevSchedule, status } = bkRes.rows[0];
  if (['COMPLETED', 'CANCELLED', 'CANCELED'].includes((status || '').toUpperCase())) {
    throw new Error(`Cannot reschedule a booking with status ${status}`);
  }

  await dbQuery.query(
    `UPDATE ${dbSchema}.bookings SET schedule = $1 WHERE id = $2`,
    [scheduledAt, bookingId]
  );

  // C18 §14/§24. The provider is NOT a party to rescheduling — per operator
  // policy only the customer and admin may move a booking, and the provider
  // only responds to the outcome. But "only responds" still requires being
  // TOLD: before this, a provider's booking could move to a different day and
  // nothing informed them. They would arrive at the old time.
  //
  // Fire-and-forget: a notification failure must not roll back a reschedule
  // that has already been committed and told to the customer.
  (async () => {
    try {
      const w = await dbQuery.query(
        `SELECT worker_uid FROM ${dbSchema}.bookings WHERE id = $1`,
        [bookingId]
      );
      const workerUid = w.rows[0]?.worker_uid;
      if (!workerUid) return;
      const { createNotification } = await import('./notification.service');
      const code = `SVN-${String(bookingId).padStart(6, '0')}`;
      await createNotification(workerUid, {
        type: 'booking_rescheduled',
        severity: 'warning',
        title: 'Booking rescheduled',
        safeBody: `Booking ${code} has been moved to a new date and time. Check your schedule.`,
        safeContextLabel: code,
        route: { page: 'jobs', bookingId: String(bookingId) },
        canOpenDetail: true,
      });
    } catch (e: any) {
      console.error('[admin-reschedule] provider notification failed:', e?.message);
    }
  })();

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

  /**
   * ─── D2 · ADMIN_CANCEL, on the canonical executor ─────────────────────────
   *
   * Three statements become one transaction: the booking write, the closing of
   * every live assignment row, and the timeline event that is the ONLY record
   * of who cancelled.
   *
   * ## Admin cancellation has its own authority
   *
   * It shares a destination with CUSTOMER_CANCEL and PROVIDER_CANCEL and
   * neither of their guards — not the customer stage list, not the 48-hour
   * provider window. An admin cancelling a job already under way is precisely
   * the support case those rules exist to escalate TO.
   *
   * ## The timeline event is provenance, not decoration
   *
   * There is no `cancellation_source` column on `bookings` — measured, not
   * assumed. `actor_type = 'admin'` and the title on this row are the only
   * things distinguishing an admin cancellation from a customer's in every
   * support and audit view, which is why the write moved INSIDE the
   * transaction rather than staying after it.
   *
   * ## What was deliberately NOT changed
   *
   * `bookings.worker_uid` is left pointing at the cancelled assignment,
   * exactly as before. Clearing it would change what the admin portal shows
   * for a cancelled booking — provider name present today, absent after — and
   * that is a display change, not a lifecycle one. Recorded rather than
   * quietly made.
   */
  try {
    await transitionBooking({
      action: 'ADMIN_CANCEL',
      bookingId,
      actorRole: 'admin',
      actorUid: adminUid,
      metadata: {
        reason,
        ...(reasonCode ? { reasonCode } : {}),
        ...(refundAction ? { refundAction } : {}),
      },
    });
  } catch (error) {
    // The legacy message, verbatim.
    if (error instanceof TransitionError) {
      throw new Error(`Cannot cancel booking with status: ${prevStatus}`);
    }
    throw error;
  }

  // Close the booking conversation so a cancelled job cannot become an
  // open-ended private channel between customer and provider. The transcript
  // stays readable; support can still post an official resolution.
  (async () => {
    try {
      await closeConversationForCancellation(bookingId);
    } catch (err) {
      console.error('[cancel] chat close failed', bookingId, err);
    }
  })();

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

  // Reopen the SAME booking conversation rather than starting a parallel
  // dispute thread. One booking keeps one auditable timeline — assignment,
  // chat, arrival, OTP, service, payment, completion, complaint, resolution —
  // instead of the case being scattered across two messaging surfaces. This
  // also un-freezes a conversation that had already gone read-only, which is
  // the common case: disputes are raised after completion.
  (async () => {
    try {
      await escalateToSupport(bookingId);
    } catch (chatErr) {
      console.error('[escalate] chat escalation failed', bookingId, chatErr);
    }
  })();

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

  /**
   * ─── D3 · ADMIN_APPROVE_COMPLETION, on the canonical executor ────────────
   *
   * Measured before migrating, because the name does not say which it is: this
   * is a FORCE COMPLETION, not an approval of something already finished. It
   * had no status precondition at all — it read `bookings.status` only to fill
   * the audit `before` field and then wrote COMPLETED unconditionally.
   *
   * ## Two branches, and the difference is recorded
   *
   * ASSIGNED / ACCEPTED / IN_PROGRESS  the booking moves to COMPLETED
   * already COMPLETED                  an approval EVENT is recorded, and the
   *                                    booking does not transition again
   *
   * Legacy recorded a second approval on the repeat, and that record is
   * meaningful — an admin signing off on a finished job is a real act. What it
   * is not is a second completion, so the evidence row carries
   * `state_changed = false`. Two COMPLETED rows must never read as a booking
   * that completed twice.
   *
   * ## A defect fixed by migrating
   *
   * With no precondition, approving a CANCELLED booking revived it — the mirror
   * of the decline-on-cancelled defect from B1.2. The machine refuses a
   * terminal source, so that is now impossible. Declared, not incidental.
   *
   * ## What is deliberately NOT inherited
   *
   * No `cashPaymentSettledBeforeCompletion`, no disbursement, no receipt email,
   * no review trigger. Measured: this path has never done any of them — the
   * money workflow belongs to `technicianService.completeJob`. Whether admin
   * approval SHOULD move money is a finance decision, not a state-machine one.
   */
  try {
    await transitionBooking({
      action: 'ADMIN_APPROVE_COMPLETION',
      bookingId,
      actorRole: 'admin',
      actorUid: adminUid,
      metadata: reason ? { reason } : {},
    });
  } catch (error) {
    if (error instanceof TransitionError) {
      throw new Error(`Cannot approve completion for booking with status: ${prevStatus}`);
    }
    throw error;
  }

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

  /**
   * ─── D1 · ADMIN_CONFIRM_ASSIGNMENT, on the canonical executor ──────────────
   *
   * Acknowledgement only. This never creates or replaces provider identity —
   * the provider it confirms must already BE the current assignment — which is
   * why it is a distinct action from ADMIN_ASSIGN despite both involving an
   * admin and a provider.
   *
   * The whole consent trail (§23) is written in the SAME statement as the
   * status, inside the transition transaction. An ACCEPTED row whose
   * `confirmation_source` failed to land would be indistinguishable from the
   * provider tapping Accept themselves, which is the one distinction this
   * action exists to preserve.
   *
   * The three validations above are unchanged and still run first, so their
   * messages reach clients exactly as before. The executor re-checks the
   * provider match independently, because a caller that never touched this
   * function must not be able to confirm on behalf of the wrong provider.
   */
  try {
    await transitionBooking({
      action: 'ADMIN_CONFIRM_ASSIGNMENT',
      bookingId,
      actorRole: 'admin',
      actorUid: adminUid,
      metadata: {
        providerUid,
        consentMethod,
        consentReference: consentReference ?? null,
        reason,
      },
    });
  } catch (error) {
    // The legacy message for a concurrent change, verbatim.
    if (error instanceof TransitionError) {
      throw new Error('Confirmation failed — assignment may have changed concurrently');
    }
    throw error;
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

  // This is a provider confirmation, so it opens the booking conversation —
  // exactly as `technicianService.acceptJob` does when the provider taps accept
  // themselves. It has to be here explicitly: this path writes
  // booking_workers.status = 'ACCEPTED' directly and never goes through
  // acceptJob, so without this an admin-confirmed booking would have no
  // conversation at all now that read paths no longer create one lazily.
  (async () => {
    try {
      await openConversationForConfirmedBooking(bookingId);
    } catch (chatErr) {
      console.error('auto group-chat creation failed (admin on behalf):', bookingId, chatErr);
    }
  })();

  // `confirmed_at` came back from the UPDATE's RETURNING clause. The executor
  // does not hand its rows back, so it is read after the commit — the row is
  // this provider's and has just been written, so the value is the same one.
  const confirmedRes = await dbQuery.query(
    `SELECT confirmed_at FROM ${dbSchema}.booking_workers
      WHERE booking_id = $1 AND worker_uid = $2`,
    [bookingId, providerUid],
  );

  return {
    bookingId,
    providerUid,
    confirmationSource: 'admin_on_behalf_of_provider',
    confirmedAt: confirmedRes.rows[0]?.confirmed_at ?? null,
    consentMethod,
  };
};
