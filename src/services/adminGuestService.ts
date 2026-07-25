/**
 * adminGuestService — Guest Customer management
 *
 * Guests are walk-in / phone / social-channel bookings that have no Firebase account.
 * They live in guest_customers. They can later be linked to a full client (role=3)
 * via linkGuestToClient — which sets linked_customer_uid without altering the guest row.
 *
 * NEVER creates fake Firebase UIDs, fake FCM tokens, or fake CometChat identities.
 * Source-channel values: phone | facebook_messenger | instagram | walk_in |
 *                        referral | admin_support | other
 */

import dbQuery from '../db/dbQuery';
import { db } from '../config';
import { auditFire } from './adminAuditService';

const s = db.schema;

// ── Lazy schema bootstrap — runs once per process ─────────────────────────────
// guest_customers is created by ensureAdminCreateBookingSchema() but that only
// runs when an admin creates a booking. Guard all reads with this singleton so
// the table is always present before any query references it.

let _guestTableReady = false;
const ensureGuestCustomersTable = async (): Promise<void> => {
  if (_guestTableReady) return;
  await dbQuery.query(
    `CREATE TABLE IF NOT EXISTS ${s}.guest_customers (
       id                    SERIAL PRIMARY KEY,
       guest_customer_id     UUID    NOT NULL DEFAULT gen_random_uuid(),
       first_name            VARCHAR(100) NOT NULL,
       last_name             VARCHAR(100) NOT NULL,
       phone_normalized      VARCHAR(20)  NOT NULL,
       email                 VARCHAR(255),
       created_by_admin_uid  VARCHAR(256) NOT NULL DEFAULT 'system',
       linked_customer_uid   VARCHAR(256),
       linked_at             TIMESTAMPTZ,
       linked_by_admin_uid   VARCHAR(256),
       link_reason           TEXT,
       created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    []
  );
  await dbQuery.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_gc_phone_unique ON ${s}.guest_customers (phone_normalized)`,
    []
  ).catch(() => {});
  await dbQuery.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_gc_uuid ON ${s}.guest_customers (guest_customer_id)`,
    []
  ).catch(() => {});
  await dbQuery.query(
    `ALTER TABLE ${s}.guest_customers ADD COLUMN IF NOT EXISTS source_channel VARCHAR(50)`,
    []
  ).catch(() => {});
  _guestTableReady = true;
};

// ── Allowed source-channel values ─────────────────────────────────────────────

const VALID_SOURCE_CHANNELS = new Set([
  'phone', 'facebook_messenger', 'instagram', 'walk_in',
  'referral', 'admin_support', 'other',
]);

// ── List guests ────────────────────────────────────────────────────────────────

export interface ListGuestsParams {
  search?: string;
  sourceChannel?: string;
  linkedStatus?: 'linked' | 'unlinked' | 'all';
  page?: number;
  limit?: number;
}

export async function listGuests(params: ListGuestsParams): Promise<{
  data: any[];
  total: number;
  page: number;
  limit: number;
}> {
  await ensureGuestCustomersTable();
  const page  = Math.max(1, params.page  || 1);
  const limit = Math.min(100, Math.max(1, params.limit || 25));
  const offset = (page - 1) * limit;

  const wheres: string[] = [];
  const queryParams: unknown[] = [];
  let p = 1;

  if (params.search && params.search.trim()) {
    const safe = params.search.trim().slice(0, 200).replace(/[%_]/g, '\\$&');
    const q = `%${safe}%`;
    wheres.push(
      `(gc.first_name ILIKE $${p} ESCAPE '\\' OR gc.last_name ILIKE $${p} ESCAPE '\\' OR gc.email ILIKE $${p} ESCAPE '\\' OR gc.phone_normalized ILIKE $${p} ESCAPE '\\' OR (gc.first_name || ' ' || gc.last_name) ILIKE $${p} ESCAPE '\\')`
    );
    queryParams.push(q);
    p++;
  }

  if (params.sourceChannel && params.sourceChannel !== 'all') {
    wheres.push(`gc.source_channel = $${p++}`);
    queryParams.push(params.sourceChannel);
  }

  if (params.linkedStatus === 'linked') {
    wheres.push('gc.linked_customer_uid IS NOT NULL');
  } else if (params.linkedStatus === 'unlinked') {
    wheres.push('gc.linked_customer_uid IS NULL');
  }

  const whereClause = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';

  // CTE aggregates booking stats per guest — no N+1
  const countRes = await dbQuery.query(
    `SELECT COUNT(*) AS total
     FROM ${s}.guest_customers gc
     ${whereClause}`,
    queryParams
  );
  const total = Number(countRes.rows[0].total || 0);

  const dataRes = await dbQuery.query(
    `WITH booking_stats AS (
       SELECT
         b.guest_customer_id,
         COUNT(b.id)                                          AS booking_count,
         MAX(b.schedule)                                      AS last_booking_at,
         COUNT(b.id) FILTER (WHERE b.schedule > NOW())       AS upcoming_booking_count,
         COALESCE(SUM(b.final_price), 0)                     AS total_spend
       FROM ${s}.bookings b
       WHERE b.guest_customer_id IS NOT NULL
       GROUP BY b.guest_customer_id
     )
     SELECT
       gc.guest_customer_id,
       gc.first_name,
       gc.last_name,
       gc.first_name || ' ' || gc.last_name           AS display_name,
       gc.phone_normalized                             AS phone_display,
       gc.email,
       gc.source_channel,
       gc.linked_customer_uid,
       gc.created_at,
       COALESCE(bs.booking_count, 0)                  AS booking_count,
       bs.last_booking_at,
       COALESCE(bs.upcoming_booking_count, 0)         AS upcoming_booking_count,
       COALESCE(bs.total_spend, 0)                    AS total_spend
     FROM ${s}.guest_customers gc
     LEFT JOIN booking_stats bs ON bs.guest_customer_id = gc.guest_customer_id
     ${whereClause}
     ORDER BY gc.created_at DESC
     LIMIT $${p} OFFSET $${p + 1}`,
    [...queryParams, limit, offset]
  );

  return {
    data: dataRes.rows.map((r: any) => ({
      guestCustomerId:       r.guest_customer_id,
      firstName:             r.first_name,
      lastName:              r.last_name,
      displayName:           (r.first_name + ' ' + r.last_name).trim(),
      phoneDisplay:          r.phone_display,
      email:                 r.email || null,
      sourceChannel:         r.source_channel || null,
      linkedCustomerUid:     r.linked_customer_uid || null,
      bookingCount:          Number(r.booking_count),
      lastBookingAt:         r.last_booking_at || null,
      upcomingBookingCount:  Number(r.upcoming_booking_count),
      totalSpend:            Number(r.total_spend),
      createdAt:             r.created_at,
    })),
    total,
    page,
    limit,
  };
}

// ── Guest metrics ──────────────────────────────────────────────────────────────

export async function getGuestMetrics(): Promise<{
  totalGuests: number;
  guestsWithUpcomingBookings: number;
  repeatGuests: number;
  linkedToClient: number;
  withPaymentOutstanding: number;
}> {
  await ensureGuestCustomersTable();
  const res = await dbQuery.query(
    `WITH booking_stats AS (
       SELECT
         b.guest_customer_id,
         COUNT(b.id)                                    AS booking_count,
         COUNT(b.id) FILTER (WHERE b.schedule > NOW()) AS upcoming_count
       FROM ${s}.bookings b
       WHERE b.guest_customer_id IS NOT NULL
       GROUP BY b.guest_customer_id
     ),
     payment_stats AS (
       SELECT DISTINCT b.guest_customer_id
       FROM ${s}.bookings b
       JOIN ${s}.payments pay ON pay.booking_id = b.id
       WHERE b.guest_customer_id IS NOT NULL
         AND pay.status NOT IN ('PAID', 'REFUNDED')
     )
     SELECT
       COUNT(gc.id)                                                     AS total_guests,
       COUNT(gc.id) FILTER (WHERE bs.upcoming_count > 0)               AS guests_with_upcoming,
       COUNT(gc.id) FILTER (WHERE bs.booking_count > 1)                AS repeat_guests,
       COUNT(gc.id) FILTER (WHERE gc.linked_customer_uid IS NOT NULL)  AS linked_to_client,
       COUNT(gc.id) FILTER (WHERE ps.guest_customer_id IS NOT NULL)    AS with_payment_outstanding
     FROM ${s}.guest_customers gc
     LEFT JOIN booking_stats bs   ON bs.guest_customer_id = gc.guest_customer_id
     LEFT JOIN payment_stats ps   ON ps.guest_customer_id = gc.guest_customer_id`,
    []
  );

  const row = res.rows[0] || {};
  return {
    totalGuests:               Number(row.total_guests || 0),
    guestsWithUpcomingBookings: Number(row.guests_with_upcoming || 0),
    repeatGuests:              Number(row.repeat_guests || 0),
    linkedToClient:            Number(row.linked_to_client || 0),
    withPaymentOutstanding:    Number(row.with_payment_outstanding || 0),
  };
}

// ── Guest detail ───────────────────────────────────────────────────────────────

export async function getGuestDetail(guestCustomerId: string): Promise<any | null> {
  await ensureGuestCustomersTable();
  const res = await dbQuery.query(
    `WITH booking_stats AS (
       SELECT
         b.guest_customer_id,
         COUNT(b.id)                                          AS booking_count,
         MAX(b.schedule)                                      AS last_at,
         COUNT(b.id) FILTER (WHERE b.schedule > NOW())       AS upcoming_count,
         COALESCE(SUM(b.final_price), 0)                     AS total_spend
       FROM ${s}.bookings b
       WHERE b.guest_customer_id = $1
       GROUP BY b.guest_customer_id
     )
     SELECT
       gc.*,
       COALESCE(bs.booking_count, 0)   AS booking_count,
       bs.last_at                       AS last_booking_at,
       COALESCE(bs.upcoming_count, 0)  AS upcoming_booking_count,
       COALESCE(bs.total_spend, 0)     AS total_spend
     FROM ${s}.guest_customers gc
     LEFT JOIN booking_stats bs ON bs.guest_customer_id = gc.guest_customer_id
     WHERE gc.guest_customer_id = $1
     LIMIT 1`,
    [guestCustomerId]
  );

  if (!res.rowCount) return null;
  const row = res.rows[0];

  return {
    guestCustomerId:       row.guest_customer_id,
    firstName:             row.first_name,
    lastName:              row.last_name,
    displayName:           (row.first_name + ' ' + row.last_name).trim(),
    phoneDisplay:          row.phone_normalized,
    email:                 row.email || null,
    sourceChannel:         row.source_channel || null,
    sourceDetails:         row.source_details || null,
    internalNotes:         row.internal_notes || null,
    linkedCustomerUid:     row.linked_customer_uid || null,
    linkedAt:              row.linked_at || null,
    linkedByAdminUid:      row.linked_by_admin_uid || null,
    linkReason:            row.link_reason || null,
    createdByAdminUid:     row.created_by_admin_uid || null,
    createdAt:             row.created_at,
    updatedAt:             row.updated_at || null,
    bookingCount:          Number(row.booking_count),
    lastBookingAt:         row.last_booking_at || null,
    upcomingBookingCount:  Number(row.upcoming_booking_count),
    totalSpend:            Number(row.total_spend),
    bookingSummary: {
      count:        Number(row.booking_count),
      lastAt:       row.last_booking_at || null,
      upcoming:     Number(row.upcoming_booking_count),
      totalSpend:   Number(row.total_spend),
    },
  };
}

// ── Guest bookings ─────────────────────────────────────────────────────────────

export async function getGuestBookings(guestCustomerId: string): Promise<any[]> {
  await ensureGuestCustomersTable();
  const res = await dbQuery.query(
    `SELECT
       b.id              AS booking_id,
       b.schedule,
       b.status,
       b.payment_method,
       b.final_price,
       b.quoted_price,
       b.admin_created,
       b.admin_created_by,
       b.service_address,
       b.created_at,
       so.level_2,
       so.level_3,
       svc.name          AS service_name
     FROM ${s}.bookings b
     LEFT JOIN ${s}.service_options so  ON so.id = b.service_option_id
     LEFT JOIN ${s}.services svc        ON svc.id = so.service_id
     WHERE b.guest_customer_id = $1
     ORDER BY b.schedule DESC`,
    [guestCustomerId]
  );

  return res.rows.map((r: any) => ({
    bookingId:       r.booking_id,
    schedule:        r.schedule,
    status:          r.status,
    paymentMethod:   r.payment_method,
    finalPrice:      Number(r.final_price || 0),
    quotedPrice:     Number(r.quoted_price || 0),
    adminCreated:    r.admin_created,
    adminCreatedBy:  r.admin_created_by || null,
    serviceAddress:  r.service_address || null,
    serviceName:     r.service_name || null,
    serviceDetail: [r.level_2, r.level_3].filter(Boolean).join(' / ') || null,
    createdAt:       r.created_at,
  }));
}

// ── Update guest ───────────────────────────────────────────────────────────────

export interface UpdateGuestFields {
  firstName?: string;
  lastName?: string;
  email?: string | null;
  sourceChannel?: string | null;
  sourceDetails?: string | null;
  internalNotes?: string | null;
}

export async function updateGuest(
  guestCustomerId: string,
  adminUid: string,
  fields: UpdateGuestFields
): Promise<any> {
  await ensureGuestCustomersTable();
  // Validate source_channel if provided
  if (fields.sourceChannel && !VALID_SOURCE_CHANNELS.has(fields.sourceChannel)) {
    throw Object.assign(
      new Error('Invalid source_channel. Must be one of: ' + Array.from(VALID_SOURCE_CHANNELS).join(', ')),
      { statusCode: 400 }
    );
  }

  const existing = await getGuestDetail(guestCustomerId);
  if (!existing) {
    throw Object.assign(new Error('Guest customer not found'), { code: 'NOT_FOUND' });
  }

  const sets: string[] = ['updated_at = NOW()'];
  const queryParams: unknown[] = [guestCustomerId];
  let p = 2;

  if (fields.firstName !== undefined && fields.firstName.trim()) {
    sets.push(`first_name = $${p++}`);
    queryParams.push(fields.firstName.trim());
  }
  if (fields.lastName !== undefined && fields.lastName.trim()) {
    sets.push(`last_name = $${p++}`);
    queryParams.push(fields.lastName.trim());
  }
  if (fields.email !== undefined) {
    sets.push(`email = $${p++}`);
    queryParams.push(fields.email || null);
  }
  if (fields.sourceChannel !== undefined) {
    sets.push(`source_channel = $${p++}`);
    queryParams.push(fields.sourceChannel || null);
  }
  if (fields.sourceDetails !== undefined) {
    sets.push(`source_details = $${p++}`);
    queryParams.push(fields.sourceDetails || null);
  }
  if (fields.internalNotes !== undefined) {
    sets.push(`internal_notes = $${p++}`);
    queryParams.push(fields.internalNotes || null);
  }

  if (sets.length === 1) {
    // Only updated_at — nothing meaningful changed; return existing
    return existing;
  }

  await dbQuery.query(
    `UPDATE ${s}.guest_customers SET ${sets.join(', ')} WHERE guest_customer_id = $1`,
    queryParams
  );

  auditFire({
    actionCategory: 'customer',
    action: 'guest_updated',
    entityType: 'customer',
    entityId: guestCustomerId,
    actorUid: adminUid,
    outcome: 'success',
    metadata: { fields },
    requestId: null,
  });

  return getGuestDetail(guestCustomerId);
}

// ── Link guest to client ───────────────────────────────────────────────────────

export async function linkGuestToClient(
  guestCustomerId: string,
  customerUid: string,
  adminUid: string,
  reason: string
): Promise<any> {
  // Validate guest exists
  const guest = await getGuestDetail(guestCustomerId);
  if (!guest) {
    throw Object.assign(new Error('Guest customer not found'), { code: 'NOT_FOUND' });
  }

  // Validate not already linked
  if (guest.linkedCustomerUid) {
    throw Object.assign(
      new Error('Guest is already linked to a client account'),
      { code: 'CONFLICT' }
    );
  }

  // Validate the client exists in user_credentials with role=3
  const clientRes = await dbQuery.query(
    `SELECT uid, first_name, last_name, email
     FROM ${s}.user_credentials
     WHERE uid = $1 AND role::int = 3
     LIMIT 1`,
    [customerUid]
  );
  if (!clientRes.rowCount) {
    throw Object.assign(
      new Error('Client not found or is not a customer account (role 3)'),
      { code: 'NOT_FOUND' }
    );
  }
  const client = clientRes.rows[0];

  await dbQuery.query(
    `UPDATE ${s}.guest_customers
     SET linked_customer_uid = $2,
         linked_at            = NOW(),
         linked_by_admin_uid  = $3,
         link_reason          = $4,
         updated_at           = NOW()
     WHERE guest_customer_id = $1`,
    [guestCustomerId, customerUid, adminUid, reason || null]
  );

  auditFire({
    actionCategory: 'customer',
    action: 'guest_linked_to_client',
    entityType: 'customer',
    entityId: guestCustomerId,
    actorUid: adminUid,
    outcome: 'success',
    metadata: {
      guestCustomerId,
      linkedCustomerUid: customerUid,
      clientEmail: client.email || null,
      reason: reason || null,
    },
    requestId: null,
  });

  return getGuestDetail(guestCustomerId);
}

// ── List all customers (clients + guests unified) ─────────────────────────────

export interface ListAllCustomersParams {
  search?: string;
  identityType?: 'client' | 'guest' | 'all';
  page?: number;
  limit?: number;
}

export async function listAllCustomers(params: ListAllCustomersParams): Promise<{
  data: any[];
  total: number;
  page: number;
  limit: number;
}> {
  await ensureGuestCustomersTable();
  const page  = Math.max(1, params.page  || 1);
  const limit = Math.min(100, Math.max(1, params.limit || 25));
  const offset = (page - 1) * limit;

  const rawSearch = params.search ? params.search.trim().slice(0, 200) : null;
  const searchTerm = rawSearch ? '%' + rawSearch.replace(/[%_]/g, '\\$&') + '%' : null;
  const identityType = params.identityType || 'all';

  // Build discriminated UNION query.
  // Both branches must select the same columns in the same order for UNION ALL.
  // Client-specific fields (customer_uid) are NULL in the guest branch and vice-versa.
  // Booking stats aggregated via CTE — no N+1.

  const rows: unknown[] = [];
  let paramIndex = 1;

  if (searchTerm) {
    rows.push(searchTerm);
    paramIndex++;
  }

  const clientSearchWhere = searchTerm
    ? `AND (uc.first_name ILIKE $1 ESCAPE '\\' OR uc.last_name ILIKE $1 ESCAPE '\\' OR uc.email ILIKE $1 ESCAPE '\\' OR uc.phone_number ILIKE $1 ESCAPE '\\' OR (uc.first_name || ' ' || uc.last_name) ILIKE $1 ESCAPE '\\')`
    : '';
  const guestSearchWhere = searchTerm
    ? `AND (gc.first_name ILIKE $1 ESCAPE '\\' OR gc.last_name ILIKE $1 ESCAPE '\\' OR gc.email ILIKE $1 ESCAPE '\\' OR gc.phone_normalized ILIKE $1 ESCAPE '\\' OR (gc.first_name || ' ' || gc.last_name) ILIKE $1 ESCAPE '\\')`
    : '';

  // 13 columns per branch — must match exactly for UNION ALL:
  // identity_type, identity_id, customer_uid, guest_customer_id,
  // display_name, phone, email, source_channel, linked_client_uid,
  // booking_count, last_booking_at, total_spend, created_at

  const clientBranch = `
    SELECT
      'client'::text                                                              AS identity_type,
      uc.uid                                                                      AS identity_id,
      uc.uid                                                                      AS customer_uid,
      NULL::text                                                                  AS guest_customer_id,
      COALESCE(uc.first_name, '') || ' ' || COALESCE(uc.last_name, '')          AS display_name,
      uc.phone_number                                                             AS phone,
      uc.email,
      NULL::text                                                                  AS source_channel,
      NULL::text                                                                  AS linked_client_uid,
      COALESCE(cbs.booking_count, 0)                                             AS booking_count,
      cbs.last_booking_at,
      COALESCE(cbs.total_spend, 0)                                               AS total_spend,
      uc.created_at
    FROM ${s}.user_credentials uc
    LEFT JOIN client_booking_stats cbs ON cbs.user_id = uc.uid
    WHERE uc.role::int = 3 ${clientSearchWhere}
  `;

  const guestBranch = `
    SELECT
      'guest'::text                                                               AS identity_type,
      gc.guest_customer_id::text                                                  AS identity_id,
      NULL::text                                                                  AS customer_uid,
      gc.guest_customer_id::text                                                  AS guest_customer_id,
      COALESCE(gc.first_name, '') || ' ' || COALESCE(gc.last_name, '')          AS display_name,
      gc.phone_normalized                                                         AS phone,
      gc.email,
      gc.source_channel,
      gc.linked_customer_uid                                                      AS linked_client_uid,
      COALESCE(gbs.booking_count, 0)                                             AS booking_count,
      gbs.last_booking_at,
      COALESCE(gbs.total_spend, 0)                                               AS total_spend,
      gc.created_at
    FROM ${s}.guest_customers gc
    LEFT JOIN guest_booking_stats gbs ON gbs.guest_customer_id = gc.guest_customer_id
    WHERE 1=1 ${guestSearchWhere}
  `;

  let unionQuery: string;

  if (identityType === 'client') {
    unionQuery = `
      WITH client_booking_stats AS (
        SELECT user_id,
               COUNT(b.id)                   AS booking_count,
               MAX(b.schedule)               AS last_booking_at,
               COALESCE(SUM(b.final_price), 0) AS total_spend
        FROM ${s}.bookings b WHERE b.user_id IS NOT NULL GROUP BY b.user_id
      )
      ${clientBranch}
    `;
  } else if (identityType === 'guest') {
    unionQuery = `
      WITH guest_booking_stats AS (
        SELECT guest_customer_id,
               COUNT(b.id)                   AS booking_count,
               MAX(b.schedule)               AS last_booking_at,
               COALESCE(SUM(b.final_price), 0) AS total_spend
        FROM ${s}.bookings b WHERE b.guest_customer_id IS NOT NULL GROUP BY b.guest_customer_id
      )
      ${guestBranch}
    `;
  } else {
    unionQuery = `
      WITH client_booking_stats AS (
        SELECT user_id,
               COUNT(b.id)                   AS booking_count,
               MAX(b.schedule)               AS last_booking_at,
               COALESCE(SUM(b.final_price), 0) AS total_spend
        FROM ${s}.bookings b WHERE b.user_id IS NOT NULL GROUP BY b.user_id
      ),
      guest_booking_stats AS (
        SELECT guest_customer_id,
               COUNT(b.id)                   AS booking_count,
               MAX(b.schedule)               AS last_booking_at,
               COALESCE(SUM(b.final_price), 0) AS total_spend
        FROM ${s}.bookings b WHERE b.guest_customer_id IS NOT NULL GROUP BY b.guest_customer_id
      )
      ${clientBranch}
      UNION ALL
      ${guestBranch}
    `;
  }

  const countRes = await dbQuery.query(
    `SELECT COUNT(*) AS total FROM (${unionQuery}) combined`,
    rows
  );
  const total = Number(countRes.rows[0].total || 0);

  const limitParam = paramIndex;
  const offsetParam = paramIndex + 1;

  const dataRes = await dbQuery.query(
    `SELECT * FROM (${unionQuery}) combined
     ORDER BY created_at DESC
     LIMIT $${limitParam} OFFSET $${offsetParam}`,
    [...rows, limit, offset]
  );

  return {
    data: dataRes.rows.map((r: any) => {
      const base = {
        identityType:  r.identity_type,
        identityId:    r.identity_id,
        displayName:   (r.display_name || '').trim(),
        phone:         r.phone || null,
        email:         r.email || null,
        bookingCount:  Number(r.booking_count || 0),
        lastBookingAt: r.last_booking_at || null,
        totalSpend:    Number(r.total_spend || 0),
        createdAt:     r.created_at,
      };
      if (r.identity_type === 'client') {
        return { ...base, customerUid: r.customer_uid, guestCustomerId: null, sourceChannel: null, linkedClientUid: null };
      }
      return { ...base, customerUid: null, guestCustomerId: r.guest_customer_id, sourceChannel: r.source_channel || null, linkedClientUid: r.linked_client_uid || null };
    }),
    total,
    page,
    limit,
  };
}

// ── Client detail (registered client, role=3) ────────────────────────────────

export async function getClientDetail(identityId: string): Promise<any | null> {
  const res = await dbQuery.query(
    `WITH booking_stats AS (
       SELECT
         user_id,
         COUNT(b.id)                                          AS booking_count,
         MAX(b.schedule)                                      AS last_at,
         COUNT(b.id) FILTER (WHERE b.schedule > NOW())       AS upcoming_count,
         COALESCE(SUM(b.final_price), 0)                     AS total_spend
       FROM ${s}.bookings b
       WHERE b.user_id = $1
       GROUP BY b.user_id
     )
     SELECT
       uc.uid,
       uc.first_name,
       uc.last_name,
       uc.email,
       uc.phone_number   AS phone,
       uc.created_at,
       COALESCE(bs.booking_count, 0)   AS booking_count,
       bs.last_at                       AS last_booking_at,
       COALESCE(bs.upcoming_count, 0)  AS upcoming_booking_count,
       COALESCE(bs.total_spend, 0)     AS total_spend
     FROM ${s}.user_credentials uc
     LEFT JOIN booking_stats bs ON bs.user_id = uc.uid
     WHERE uc.uid = $1 AND uc.role::int = 3
     LIMIT 1`,
    [identityId]
  );

  if (!res.rowCount) return null;
  const row = res.rows[0];
  return {
    identityId:           row.uid,
    identityType:         'client',
    firstName:            row.first_name,
    lastName:             row.last_name,
    displayName:          ((row.first_name || '') + ' ' + (row.last_name || '')).trim(),
    phone:                row.phone || null,
    email:                row.email || null,
    createdAt:            row.created_at,
    bookingSummary: {
      count:      Number(row.booking_count),
      lastAt:     row.last_booking_at || null,
      upcoming:   Number(row.upcoming_booking_count),
      totalSpend: Number(row.total_spend),
    },
  };
}

// ── Customer metrics (combined clients + guests) ───────────────────────────────

export async function getCustomerMetrics(): Promise<{
  totalClients: number;
  totalGuests: number;
  totalCustomers: number;
  guestsWithUpcomingBookings: number;
  repeatGuests: number;
  linkedToClient: number;
  withPaymentOutstanding: number;
}> {
  const clientCountRes = await dbQuery.query(
    `SELECT COUNT(*) AS total FROM ${s}.user_credentials WHERE role::int = 3`,
    []
  );
  const totalClients = Number(clientCountRes.rows[0].total || 0);

  const guestMetrics = await getGuestMetrics();

  return {
    totalClients,
    totalGuests:               guestMetrics.totalGuests,
    totalCustomers:            totalClients + guestMetrics.totalGuests,
    guestsWithUpcomingBookings: guestMetrics.guestsWithUpcomingBookings,
    repeatGuests:              guestMetrics.repeatGuests,
    linkedToClient:            guestMetrics.linkedToClient,
    withPaymentOutstanding:    guestMetrics.withPaymentOutstanding,
  };
}
