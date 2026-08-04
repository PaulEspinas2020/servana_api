/**
 * adminBookingDraftService — Admin Booking Draft persistence layer
 *
 * Drafts live in admin_booking_drafts, completely separate from the bookings
 * table. They never enter the live booking lifecycle and are excluded from all
 * dashboard/pipeline/finance metrics automatically.
 *
 * Lifecycle: editing → ready_for_review → converting → converted
 *                               ↓
 *                         discarded | expired
 *
 * Conversion delegates to adminCreateBooking() — the same canonical transaction
 * used by the direct wizard path — so no second booking-creator is needed.
 */

import { pool } from '../db/dbQuery';
import dbQuery from '../db/dbQuery';
import { db } from '../config';
import { randomUUID } from 'crypto';
import { adminCreateBooking } from './adminCreateBookingService';
import type { AdminCreateBookingResult } from './adminCreateBookingService';

const s = db.schema;

// ── Types ─────────────────────────────────────────────────────────────────────

export type DraftStatus =
  | 'editing'
  | 'ready_for_review'
  | 'converting'
  | 'converted'
  | 'discarded'
  | 'expired';

export interface DraftGuestPayload {
  firstName: string;
  lastName: string;
  phone: string;
  email?: string | null;
  sourceChannel?: string | null;
}

export interface DraftAddressPayload {
  formattedAddress: string;
  addressOne: string;
  postTown: string;
  lat: number;
  lon: number;
  servanaLocationId: string;
  unitFloor?: string | null;
  instructions?: string | null;
}

export interface DraftEvidencePayload {
  storageUrl: string;
  mimeType: string;
  fileSizeBytes: number;
  originalFileName: string;
}

export interface DraftProviderSnapshot {
  uid: string;
  name: string;
  email: string | null;
  phone: string | null;
  score: number;
}

export interface AdminBookingDraft {
  draftId: string;
  createdByAdminUid: string;
  lastUpdatedByAdminUid: string | null;
  status: DraftStatus;
  currentStep: number;
  customerType: 'guest' | 'client' | null;
  customerUid: string | null;
  customerName: string | null;
  guestPayload: DraftGuestPayload | null;
  serviceOptionId: number | null;
  addonOptionIds: number[];
  scheduleAt: string | null;
  addressPayload: DraftAddressPayload | null;
  selectedProviderUid: string | null;
  providerSnapshot: DraftProviderSnapshot | null;
  paymentMethod: string | null;
  paymentStatusChoice: string | null;
  paymentEvidencePayload: DraftEvidencePayload | null;
  internalNotes: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string | null;
  expiresAt: string;
  convertedBookingId: number | null;
  convertedAt: string | null;
  discardedAt: string | null;
  discardedByAdminUid: string | null;
  discardReason: string | null;
}

export interface DraftPatchSections {
  step?: number;
  customerType?: 'guest' | 'client';
  customerUid?: string | null;
  customerName?: string | null;
  guestPayload?: DraftGuestPayload | null;
  serviceOptionId?: number | null;
  addonOptionIds?: number[];
  scheduleAt?: string | null;
  addressPayload?: DraftAddressPayload | null;
  selectedProviderUid?: string | null;
  providerSnapshot?: DraftProviderSnapshot | null;
  paymentMethod?: string | null;
  paymentStatusChoice?: string | null;
  paymentEvidencePayload?: DraftEvidencePayload | null;
  internalNotes?: string | null;
  expectedVersion?: number;
}

export interface DraftListFilters {
  adminUid: string;
  status?: DraftStatus[];
  search?: string;
  page?: number;
  limit?: number;
}

// ── Schema bootstrap ──────────────────────────────────────────────────────────

export const ensureAdminBookingDraftSchema = async (): Promise<void> => {
  await dbQuery.query(`
    CREATE TABLE IF NOT EXISTS ${s}.admin_booking_drafts (
      id                          SERIAL PRIMARY KEY,
      draft_id                    UUID        NOT NULL DEFAULT gen_random_uuid(),
      created_by_admin_uid        VARCHAR(256) NOT NULL,
      last_updated_by_admin_uid   VARCHAR(256),
      status                      VARCHAR(30)  NOT NULL DEFAULT 'editing',
      current_step                SMALLINT     NOT NULL DEFAULT 1,
      customer_type               VARCHAR(10),
      customer_uid                VARCHAR(256),
      guest_payload               JSONB,
      service_option_id           INTEGER,
      addon_option_ids            INTEGER[]    NOT NULL DEFAULT '{}',
      schedule_at                 TIMESTAMPTZ,
      address_payload             JSONB,
      selected_provider_uid       VARCHAR(256),
      provider_snapshot           JSONB,
      payment_method              VARCHAR(20),
      payment_status_choice       VARCHAR(20),
      payment_evidence_payload    JSONB,
      internal_notes              TEXT,
      version                     INTEGER      NOT NULL DEFAULT 1,
      created_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      last_opened_at              TIMESTAMPTZ,
      expires_at                  TIMESTAMPTZ  NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
      converted_booking_id        INTEGER,
      converted_at                TIMESTAMPTZ,
      discarded_at                TIMESTAMPTZ,
      discarded_by_admin_uid      VARCHAR(256),
      discard_reason              TEXT,
      CONSTRAINT uq_draft_id UNIQUE (draft_id),
      CONSTRAINT chk_draft_status CHECK (status IN (
        'editing','ready_for_review','converting','converted','discarded','expired'
      ))
    )
  `, []);

  await dbQuery.query(`
    CREATE INDEX IF NOT EXISTS idx_abd_admin_status
    ON ${s}.admin_booking_drafts (created_by_admin_uid, status, updated_at DESC)
  `, []);

  await dbQuery.query(`
    CREATE INDEX IF NOT EXISTS idx_abd_expires
    ON ${s}.admin_booking_drafts (expires_at) WHERE status IN ('editing','ready_for_review')
  `, []);

  // Additive migration — safe to run on every start
  await dbQuery.query(`
    ALTER TABLE ${s}.admin_booking_drafts
    ADD COLUMN IF NOT EXISTS customer_name VARCHAR(256)
  `, []);
};

// ── Row mapper ────────────────────────────────────────────────────────────────

function mapRow(r: any): AdminBookingDraft {
  return {
    draftId:               r.draft_id,
    createdByAdminUid:     r.created_by_admin_uid,
    lastUpdatedByAdminUid: r.last_updated_by_admin_uid ?? null,
    status:                r.status,
    currentStep:           r.current_step,
    customerType:          r.customer_type ?? null,
    customerUid:           r.customer_uid ?? null,
    customerName:          r.customer_name ?? null,
    guestPayload:          r.guest_payload ?? null,
    serviceOptionId:       r.service_option_id != null ? Number(r.service_option_id) : null,
    addonOptionIds:        (r.addon_option_ids ?? []).map(Number),
    scheduleAt:            r.schedule_at ? new Date(r.schedule_at).toISOString() : null,
    addressPayload:        r.address_payload ?? null,
    selectedProviderUid:   r.selected_provider_uid ?? null,
    providerSnapshot:      r.provider_snapshot ?? null,
    paymentMethod:         r.payment_method ?? null,
    paymentStatusChoice:   r.payment_status_choice ?? null,
    paymentEvidencePayload: r.payment_evidence_payload ?? null,
    internalNotes:         r.internal_notes ?? null,
    version:               r.version,
    createdAt:             new Date(r.created_at).toISOString(),
    updatedAt:             new Date(r.updated_at).toISOString(),
    lastOpenedAt:          r.last_opened_at ? new Date(r.last_opened_at).toISOString() : null,
    expiresAt:             new Date(r.expires_at).toISOString(),
    convertedBookingId:    r.converted_booking_id != null ? Number(r.converted_booking_id) : null,
    convertedAt:           r.converted_at ? new Date(r.converted_at).toISOString() : null,
    discardedAt:           r.discarded_at ? new Date(r.discarded_at).toISOString() : null,
    discardedByAdminUid:   r.discarded_by_admin_uid ?? null,
    discardReason:         r.discard_reason ?? null,
  };
}

// ── Completion scoring ────────────────────────────────────────────────────────

export function calcDraftCompletion(draft: AdminBookingDraft): number {
  let done = 0;
  const total = 7;
  if (draft.customerType)                                                  done++;
  if (draft.customerType === 'client' ? !!draft.customerUid
      : (draft.guestPayload?.firstName && draft.guestPayload?.phone))     done++;
  if (draft.serviceOptionId)                                               done++;
  if (draft.scheduleAt && draft.addressPayload?.formattedAddress)         done++;
  if (draft.selectedProviderUid)                                           done++;
  if (draft.paymentMethod)                                                 done++;
  if (draft.status !== 'editing')                                          done++; // step 7 = review step reached (status advanced past editing)
  return Math.round((done / total) * 100);
}

// ── Create ────────────────────────────────────────────────────────────────────

export const createDraft = async (adminUid: string): Promise<AdminBookingDraft> => {
  const res = await dbQuery.query(
    `INSERT INTO ${s}.admin_booking_drafts
       (created_by_admin_uid, last_updated_by_admin_uid, status, current_step, version)
     VALUES ($1, $1, 'editing', 1, 1)
     RETURNING *`,
    [adminUid]
  );
  const draft = mapRow(res.rows[0]);

  // Fire audit (non-blocking)
  _auditDraft(draft.draftId, adminUid, null, 'editing', 'ADMIN.BOOKING_DRAFT.CREATED').catch(() => {});

  return draft;
};

// ── Get one ───────────────────────────────────────────────────────────────────

export const getDraft = async (
  draftId: string,
  adminUid: string
): Promise<AdminBookingDraft | null> => {
  const res = await dbQuery.query(
    `SELECT * FROM ${s}.admin_booking_drafts
     WHERE draft_id = $1 AND created_by_admin_uid = $2
     LIMIT 1`,
    [draftId, adminUid]
  );
  if (!res.rowCount) return null;

  const draft = mapRow(res.rows[0]);

  // Enforce expiry — transition mutable drafts to 'expired' if past their expires_at
  if ((draft.status === 'editing' || draft.status === 'ready_for_review') &&
      new Date(draft.expiresAt) < new Date()) {
    dbQuery.query(
      `UPDATE ${s}.admin_booking_drafts SET status = 'expired', updated_at = NOW()
       WHERE draft_id = $1 AND status IN ('editing','ready_for_review')`,
      [draftId]
    ).catch(() => {});
    throw Object.assign(new Error('Draft has expired'), { statusCode: 410, code: 'DRAFT_EXPIRED' });
  }

  // Touch last_opened_at (non-blocking)
  dbQuery.query(
    `UPDATE ${s}.admin_booking_drafts SET last_opened_at = NOW()
     WHERE draft_id = $1`,
    [draftId]
  ).catch(() => {});

  _auditDraft(draftId, adminUid, null, draft.status, 'ADMIN.BOOKING_DRAFT.RESUMED').catch(() => {});

  return draft;
};

// ── Patch (autosave) ──────────────────────────────────────────────────────────

export const patchDraft = async (
  draftId: string,
  adminUid: string,
  sections: DraftPatchSections
): Promise<{ version: number; updatedAt: string }> => {
  const { expectedVersion, ...data } = sections;

  // Build SET clauses dynamically — only send changed fields
  const setClauses: string[] = ['updated_at = NOW()', 'version = version + 1', 'last_updated_by_admin_uid = $1'];
  const values: any[] = [adminUid, draftId];
  let idx = 3;

  const maybe = (col: string, val: any) => {
    if (val === undefined) return;
    setClauses.push(`${col} = $${idx++}`);
    values.push(val === null ? null : val);
  };

  if (data.step !== undefined)                maybe('current_step', data.step);
  if (data.customerType !== undefined)        maybe('customer_type', data.customerType);
  if (data.customerUid !== undefined)         maybe('customer_uid', data.customerUid);
  if (data.customerName !== undefined)        maybe('customer_name', data.customerName);
  if (data.guestPayload !== undefined)        maybe('guest_payload', data.guestPayload ? JSON.stringify(data.guestPayload) : null);
  if (data.serviceOptionId !== undefined)     maybe('service_option_id', data.serviceOptionId);
  if (data.addonOptionIds !== undefined)      maybe('addon_option_ids', data.addonOptionIds);
  if (data.scheduleAt !== undefined)          maybe('schedule_at', data.scheduleAt);
  if (data.addressPayload !== undefined)      maybe('address_payload', data.addressPayload ? JSON.stringify(data.addressPayload) : null);
  if (data.selectedProviderUid !== undefined) maybe('selected_provider_uid', data.selectedProviderUid);
  if (data.providerSnapshot !== undefined)    maybe('provider_snapshot', data.providerSnapshot ? JSON.stringify(data.providerSnapshot) : null);
  if (data.paymentMethod !== undefined)       maybe('payment_method', data.paymentMethod);
  if (data.paymentStatusChoice !== undefined) maybe('payment_status_choice', data.paymentStatusChoice);
  if (data.paymentEvidencePayload !== undefined) maybe('payment_evidence_payload', data.paymentEvidencePayload ? JSON.stringify(data.paymentEvidencePayload) : null);
  if (data.internalNotes !== undefined)       maybe('internal_notes', data.internalNotes);

  // Recompute status based on completeness
  // (simple: if all required fields present → ready_for_review, else editing)
  setClauses.push(`status = CASE
    WHEN customer_type IS NOT NULL
     AND (customer_uid IS NOT NULL OR (guest_payload IS NOT NULL))
     AND service_option_id IS NOT NULL
     AND schedule_at IS NOT NULL
     AND address_payload IS NOT NULL
     AND selected_provider_uid IS NOT NULL
     AND payment_method IS NOT NULL
    THEN 'ready_for_review'
    ELSE 'editing'
  END`);

  let whereExtra = '';
  if (expectedVersion !== undefined) {
    whereExtra = ` AND version = ${Number(expectedVersion)}`;
  }

  const sql = `
    UPDATE ${s}.admin_booking_drafts
    SET ${setClauses.join(', ')}
    WHERE draft_id = $2
      AND created_by_admin_uid = $1
      AND status IN ('editing','ready_for_review')
      ${whereExtra}
    RETURNING version, updated_at, status
  `;

  const res = await dbQuery.query(sql, values);

  if (!res.rowCount) {
    // Check if draft exists at all
    const check = await dbQuery.query(
      `SELECT status, version FROM ${s}.admin_booking_drafts WHERE draft_id = $1`,
      [draftId]
    );
    if (!check.rowCount) {
      throw Object.assign(new Error('Draft not found'), { statusCode: 404, code: 'DRAFT_NOT_FOUND' });
    }
    const row = check.rows[0];
    if (row.status === 'converted') {
      throw Object.assign(new Error('Draft already converted'), { statusCode: 409, code: 'DRAFT_ALREADY_CONVERTED' });
    }
    if (row.status === 'discarded') {
      throw Object.assign(new Error('Draft has been discarded'), { statusCode: 409, code: 'DRAFT_DISCARDED' });
    }
    if (expectedVersion !== undefined && row.version !== expectedVersion) {
      throw Object.assign(new Error('Draft was updated elsewhere'), { statusCode: 409, code: 'DRAFT_CHANGED' });
    }
    throw Object.assign(new Error('Draft could not be updated'), { statusCode: 409, code: 'DRAFT_SAVE_FAILED' });
  }

  const row = res.rows[0];
  _auditDraft(draftId, adminUid, null, row.status, 'ADMIN.BOOKING_DRAFT.UPDATED').catch(() => {});

  return { version: row.version, updatedAt: new Date(row.updated_at).toISOString() };
};

// ── List ──────────────────────────────────────────────────────────────────────

export const listDrafts = async (
  filters: DraftListFilters
): Promise<{ rows: any[]; total: number }> => {
  const {
    adminUid,
    status = ['editing', 'ready_for_review'],
    search,
    page = 1,
    limit = 25,
  } = filters;

  const conditions: string[] = ['created_by_admin_uid = $1'];
  const values: any[] = [adminUid];
  let idx = 2;

  // Status filter
  conditions.push(`status = ANY($${idx++})`);
  values.push(status);

  // Expiry guard — don't show expired drafts even if status didn't update
  conditions.push(`(expires_at > NOW() OR status IN ('converted','discarded'))`);

  // Search across guest name, client uid, address
  if (search?.trim()) {
    conditions.push(`(
      guest_payload->>'firstName' ILIKE $${idx}
      OR guest_payload->>'lastName' ILIKE $${idx}
      OR (guest_payload->>'firstName' || ' ' || guest_payload->>'lastName') ILIKE $${idx}
      OR customer_uid ILIKE $${idx}
      OR address_payload->>'formattedAddress' ILIKE $${idx}
    )`);
    values.push(`%${search.trim()}%`);
    idx++;
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const offset = (page - 1) * limit;

  const [dataRes, countRes] = await Promise.all([
    dbQuery.query(
      `SELECT
         draft_id, status, current_step,
         customer_type, customer_uid, customer_name, guest_payload,
         service_option_id, schedule_at, address_payload,
         selected_provider_uid, provider_snapshot,
         payment_method, payment_status_choice,
         version, created_at, updated_at, expires_at,
         converted_booking_id, discarded_at
       FROM ${s}.admin_booking_drafts
       ${where}
       ORDER BY updated_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...values, limit, offset]
    ),
    dbQuery.query(
      `SELECT COUNT(*) FROM ${s}.admin_booking_drafts ${where}`,
      values
    ),
  ]);

  const total = parseInt(countRes.rows[0].count, 10);

  const rows = dataRes.rows.map((r: any) => {
    const draft = mapRow({ ...r, created_by_admin_uid: adminUid });
    return {
      ...draft,
      completionPct: calcDraftCompletion(draft),
      guestDisplayName: r.guest_payload
        ? `${r.guest_payload.firstName ?? ''} ${r.guest_payload.lastName ?? ''}`.trim()
        : null,
      serviceDisplayName: null, // resolved by controller via join if needed
    };
  });

  return { rows, total };
};

// ── Discard ───────────────────────────────────────────────────────────────────

export const discardDraft = async (
  draftId: string,
  adminUid: string,
  reason?: string
): Promise<void> => {
  const res = await dbQuery.query(
    `UPDATE ${s}.admin_booking_drafts
     SET status = 'discarded',
         discarded_at = NOW(),
         discarded_by_admin_uid = $1,
         discard_reason = $3,
         updated_at = NOW()
     WHERE draft_id = $2
       AND created_by_admin_uid = $1
       AND status IN ('editing','ready_for_review')
     RETURNING draft_id`,
    [adminUid, draftId, reason ?? null]
  );

  if (!res.rowCount) {
    const check = await dbQuery.query(
      `SELECT status FROM ${s}.admin_booking_drafts WHERE draft_id = $1`,
      [draftId]
    );
    if (!check.rowCount) {
      throw Object.assign(new Error('Draft not found'), { statusCode: 404, code: 'DRAFT_NOT_FOUND' });
    }
    const st = check.rows[0].status;
    if (st === 'converted') {
      throw Object.assign(new Error('Cannot discard a converted draft'), { statusCode: 409, code: 'DRAFT_ALREADY_CONVERTED' });
    }
    if (st === 'discarded') return; // idempotent
    throw Object.assign(new Error('Draft cannot be discarded in its current state'), { statusCode: 409, code: 'DRAFT_SAVE_FAILED' });
  }

  _auditDraft(draftId, adminUid, null, 'discarded', 'ADMIN.BOOKING_DRAFT.DISCARDED', { reason }).catch(() => {});
};

// ── Convert ───────────────────────────────────────────────────────────────────

export const convertDraft = async (
  draftId: string,
  adminUid: string,
  idempotencyKey: string
): Promise<AdminCreateBookingResult & { draftId: string }> => {
  // 1. Load and lock draft
  const res = await dbQuery.query(
    `SELECT * FROM ${s}.admin_booking_drafts
     WHERE draft_id = $1 AND created_by_admin_uid = $2
     FOR UPDATE SKIP LOCKED`,
    [draftId, adminUid]
  );

  if (!res.rowCount) {
    // Might be locked (concurrency) or not found
    const check = await dbQuery.query(
      `SELECT status, converted_booking_id FROM ${s}.admin_booking_drafts WHERE draft_id = $1`,
      [draftId]
    );
    if (!check.rowCount) {
      throw Object.assign(new Error('Draft not found'), { statusCode: 404, code: 'DRAFT_NOT_FOUND' });
    }
    const row = check.rows[0];
    if (row.status === 'converted') {
      return { bookingId: Number(row.converted_booking_id), guestCustomerId: null, draftId };
    }
    throw Object.assign(new Error('Draft is being processed. Try again in a moment.'), { statusCode: 409, code: 'DRAFT_CHANGED' });
  }

  const draft = mapRow(res.rows[0]);

  // 2. Guard against double-convert
  if (draft.status === 'converted' && draft.convertedBookingId) {
    return { bookingId: draft.convertedBookingId, guestCustomerId: null, draftId };
  }
  if (draft.status === 'discarded') {
    throw Object.assign(new Error('Draft has been discarded'), { statusCode: 409, code: 'DRAFT_DISCARDED' });
  }
  if (draft.status === 'expired') {
    throw Object.assign(new Error('Draft has expired'), { statusCode: 410, code: 'DRAFT_EXPIRED' });
  }

  // 3. Validate all required fields
  if (!draft.customerType) {
    throw Object.assign(new Error('Customer type is required'), { statusCode: 400 });
  }
  if (draft.customerType === 'guest') {
    if (!draft.guestPayload?.firstName?.trim() || !draft.guestPayload?.phone?.trim()) {
      throw Object.assign(new Error('Guest first name and phone are required'), { statusCode: 400 });
    }
  } else {
    if (!draft.customerUid?.trim()) {
      throw Object.assign(new Error('Customer UID is required for client booking'), { statusCode: 400 });
    }
  }
  if (!draft.serviceOptionId) {
    throw Object.assign(new Error('Service selection is required'), { statusCode: 400 });
  }
  if (!draft.scheduleAt) {
    throw Object.assign(new Error('Schedule date/time is required'), { statusCode: 400 });
  }
  if (!draft.addressPayload?.formattedAddress) {
    throw Object.assign(new Error('Service address is required'), { statusCode: 400 });
  }
  if (!draft.selectedProviderUid) {
    throw Object.assign(new Error('Provider selection is required'), { statusCode: 400 });
  }
  if (!draft.paymentMethod) {
    throw Object.assign(new Error('Payment method is required'), { statusCode: 400 });
  }

  // 4. Mark as converting (optimistic lock)
  const lockRes = await dbQuery.query(
    `UPDATE ${s}.admin_booking_drafts
     SET status = 'converting', updated_at = NOW()
     WHERE draft_id = $1 AND status IN ('editing','ready_for_review')
     RETURNING draft_id`,
    [draftId]
  );
  if (!lockRes.rowCount) {
    const check = await dbQuery.query(
      `SELECT status, converted_booking_id FROM ${s}.admin_booking_drafts WHERE draft_id = $1`,
      [draftId]
    );
    const row = check.rows[0];
    if (row?.status === 'converted') {
      return { bookingId: Number(row.converted_booking_id), guestCustomerId: null, draftId };
    }
    throw Object.assign(new Error('Draft cannot be converted in its current state'), { statusCode: 409, code: 'DRAFT_CHANGED' });
  }

  // 5. Delegate to canonical booking creation
  const addr = draft.addressPayload!;
  const unitFloor = addr.unitFloor?.trim() ?? '';
  const addressLine = unitFloor
    ? `${addr.addressOne}, ${unitFloor}`.trim()
    : addr.addressOne;

  let result: AdminCreateBookingResult;
  try {
    result = await adminCreateBooking({
      idempotencyKey,
      adminActorUid: adminUid,
      customerType: draft.customerType!,
      guest: draft.customerType === 'guest' ? {
        firstName:     draft.guestPayload!.firstName,
        lastName:      draft.guestPayload!.lastName ?? '',
        phone:         draft.guestPayload!.phone,
        email:         draft.guestPayload!.email ?? null,
        sourceChannel: draft.guestPayload!.sourceChannel ?? null,
      } : undefined,
      customerUid:     draft.customerType === 'client' ? draft.customerUid! : undefined,
      serviceOptionId: draft.serviceOptionId!,
      addonOptionIds:  draft.addonOptionIds,
      scheduledAt:     draft.scheduleAt!,
      addressLine,
      city:            addr.postTown ?? '',
      lat:             addr.lat,
      lon:             addr.lon,
      instructions:    addr.instructions ?? null,
      locationId:      addr.servanaLocationId ? (Number.isFinite(Number(addr.servanaLocationId)) ? Number(addr.servanaLocationId) : null) : null,
      providerUid:     draft.selectedProviderUid!,
      paymentMethod:   draft.paymentMethod as any,
      paymentStatus:   (draft.paymentStatusChoice ?? 'PAY_LATER') as any,
      paymentEvidence: draft.paymentEvidencePayload ?? null,
    });
  } catch (err) {
    // Conversion failed — revert to ready_for_review so admin can retry
    await dbQuery.query(
      `UPDATE ${s}.admin_booking_drafts
       SET status = 'ready_for_review', updated_at = NOW()
       WHERE draft_id = $1`,
      [draftId]
    );
    throw err;
  }

  // 6. Mark as converted
  await dbQuery.query(
    `UPDATE ${s}.admin_booking_drafts
     SET status = 'converted',
         converted_booking_id = $2,
         converted_at = NOW(),
         updated_at = NOW()
     WHERE draft_id = $1`,
    [draftId, result.bookingId]
  );

  _auditDraft(draftId, adminUid, result.bookingId, 'converted', 'ADMIN.BOOKING_DRAFT.CONVERTED').catch(() => {});

  return { ...result, draftId };
};

// ── Audit helper ──────────────────────────────────────────────────────────────

async function _auditDraft(
  draftId: string,
  adminUid: string,
  bookingId: number | null,
  newStatus: string,
  action: string,
  metadata: any = null
): Promise<void> {
  await dbQuery.query(
    `INSERT INTO ${s}.booking_audit_events
       (booking_id, actor_uid, actor_role, action, after_json)
     VALUES ($1, $2, 'admin', $3, $4)`,
    [
      bookingId,
      adminUid,
      action,
      JSON.stringify({ draftId, newStatus, ...(metadata ?? {}) }),
    ]
  );
}
