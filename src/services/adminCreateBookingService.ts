/**
 * adminCreateBookingService — Admin-initiated booking creation
 *
 * Guest flow:  no Firebase UID, no fake credentials; stores in guest_customers
 * Client flow: canonical customerUid from existing user_credentials
 *
 * All creation goes through a single pool.connect() transaction so a crash
 * after INSERT bookings but before INSERT booking_workers cannot leave a
 * partial booking in prod.
 */

import { pool } from '../db/dbQuery';
import { toE164PhMobile } from '../helpers/phoneIdentifier';
import dbQuery from '../db/dbQuery';
import { db } from '../config';
import { randomUUID } from 'crypto';
import { uploadFileToStorage } from '../helpers/firebaseStorageUploader';
import { evaluateProviderForSlot } from './providerEligibilityEngine';
import { serviceDurationMinsSql } from './booking/eligibilityPipeline';
import { generateOTP } from '../helpers/otp';

const s = db.schema;

// ── Types ─────────────────────────────────────────────────────────────────────

export type CustomerType = 'guest' | 'client';

export interface GuestCustomerInput {
  firstName: string;
  lastName: string;
  phone: string;        // raw; will be normalized
  email?: string | null;
  sourceChannel?: string | null;
}

export interface AdminCreateBookingParams {
  idempotencyKey: string;
  adminActorUid: string;
  customerType: CustomerType;
  // guest fields (customerType === 'guest')
  guest?: GuestCustomerInput;
  // client fields (customerType === 'client')
  customerUid?: string;
  // service
  serviceOptionId: number;
  addonOptionIds?: number[];
  // schedule
  scheduledAt: string;        // ISO 8601, Asia/Manila tz context
  // address (manually entered — no user_address_id for admin creation)
  addressLine: string;
  city: string;
  lat: number;
  lon: number;
  instructions?: string | null;
  // address location id (optional — used to resolve cityId for service-area enforcement)
  locationId?: number | null;
  // provider
  providerUid: string;
  // payment
  paymentMethod: 'CASH' | 'GCASH' | 'ONLINE';
  paymentStatus: 'PAID' | 'PAY_LATER';
  // optional receipt (already uploaded, stored url + metadata)
  paymentEvidence?: {
    storageUrl: string;
    mimeType: string;
    fileSizeBytes: number;
    originalFileName: string;
  } | null;
}

export interface AdminCreateBookingResult {
  bookingId: number;
  guestCustomerId: string | null;
}

// ── Schema bootstrap ──────────────────────────────────────────────────────────

export const ensureAdminCreateBookingSchema = async (): Promise<void> => {
  // guest_customers — one row per unique guest identity, reusable across bookings
  await dbQuery.query(`
    CREATE TABLE IF NOT EXISTS ${s}.guest_customers (
      id                    SERIAL PRIMARY KEY,
      guest_customer_id     UUID    NOT NULL DEFAULT gen_random_uuid(),
      first_name            VARCHAR(100) NOT NULL,
      last_name             VARCHAR(100) NOT NULL,
      phone_normalized      VARCHAR(20)  NOT NULL,
      email                 VARCHAR(255),
      created_by_admin_uid  VARCHAR(256) NOT NULL,
      linked_customer_uid   VARCHAR(256),
      linked_at             TIMESTAMPTZ,
      linked_by_admin_uid   VARCHAR(256),
      link_reason           TEXT,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `, []);

  // UNIQUE on phone_normalized — required for ON CONFLICT (phone_normalized) DO NOTHING to work
  await dbQuery.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_gc_phone_unique ON ${s}.guest_customers (phone_normalized)
  `, []);
  await dbQuery.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_gc_uuid ON ${s}.guest_customers (guest_customer_id)
  `, []);

  // booking_payment_evidence — receipt images attached to paid bookings
  await dbQuery.query(`
    CREATE TABLE IF NOT EXISTS ${s}.booking_payment_evidence (
      id                    SERIAL PRIMARY KEY,
      booking_id            INTEGER     NOT NULL,
      storage_url           TEXT        NOT NULL,
      original_file_name    VARCHAR(255),
      mime_type             VARCHAR(50) NOT NULL,
      file_size_bytes       INTEGER     NOT NULL,
      uploaded_by_admin_uid VARCHAR(256) NOT NULL,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `, []);
  await dbQuery.query(`
    CREATE INDEX IF NOT EXISTS idx_bpe_booking_id ON ${s}.booking_payment_evidence (booking_id)
  `, []);

  // booking_create_idempotency — guards against duplicate creation from a
  // retried or double-tapped request. Used by BOTH the admin create-booking flow
  // and the customer POST /api/bookings, which is why the actor column is named
  // generically: it holds whichever uid issued the request.
  await dbQuery.query(`
    CREATE TABLE IF NOT EXISTS ${s}.booking_create_idempotency (
      id               SERIAL PRIMARY KEY,
      idempotency_key  VARCHAR(64)  NOT NULL,
      actor_uid        VARCHAR(256) NOT NULL,
      booking_id       INTEGER      NOT NULL,
      created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      UNIQUE (idempotency_key, actor_uid)
    )
  `, []);

  // Rename for installs created before customers shared this table. Postgres
  // has no IF EXISTS on RENAME COLUMN, so the catalog is checked first; the
  // UNIQUE constraint follows the rename automatically. Idempotent, because
  // this whole function runs on every boot.
  await dbQuery.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = '${s}'
          AND table_name = 'booking_create_idempotency'
          AND column_name = 'admin_actor_uid'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = '${s}'
          AND table_name = 'booking_create_idempotency'
          AND column_name = 'actor_uid'
      ) THEN
        ALTER TABLE ${s}.booking_create_idempotency
          RENAME COLUMN admin_actor_uid TO actor_uid;
      END IF;
    END $$;
  `, []);

  // bookings.guest_customer_id — links a booking to its guest_customers row
  try {
    await dbQuery.query(
      `ALTER TABLE ${s}.bookings ADD COLUMN IF NOT EXISTS guest_customer_id UUID`,
      []
    );
  } catch { /* column already present — safe to skip */ }

  // bookings.admin_created — flag distinguishing admin-created from customer-self-created
  try {
    await dbQuery.query(
      `ALTER TABLE ${s}.bookings ADD COLUMN IF NOT EXISTS admin_created BOOLEAN DEFAULT false`,
      []
    );
  } catch { /* column already present — safe to skip */ }

  // bookings.admin_created_by — which admin initiated the booking
  try {
    await dbQuery.query(
      `ALTER TABLE ${s}.bookings ADD COLUMN IF NOT EXISTS admin_created_by VARCHAR(256)`,
      []
    );
  } catch { /* column already present — safe to skip */ }

  // bookings.user_id may be NOT NULL on older schemas; relax it for guest support
  try {
    await dbQuery.query(
      `ALTER TABLE ${s}.bookings ALTER COLUMN user_id DROP NOT NULL`,
      []
    );
  } catch { /* already nullable or constraint doesn't exist — safe to skip */ }

  // bookings.service_address — stores admin-entered address JSON for non-user-address bookings
  try {
    await dbQuery.query(
      `ALTER TABLE ${s}.bookings ADD COLUMN IF NOT EXISTS service_address JSONB`,
      []
    );
  } catch { /* already present */ }

  // Sparse index for admin-created bookings queries
  try {
    await dbQuery.query(
      `CREATE INDEX IF NOT EXISTS idx_bookings_admin_created ON ${s}.bookings (admin_created) WHERE admin_created = true`,
      []
    );
  } catch { /* non-fatal */ }

  // guest_customers — additional columns added in C10 Guest Customer Management
  try {
    await dbQuery.query(
      `ALTER TABLE ${s}.guest_customers ADD COLUMN IF NOT EXISTS source_channel VARCHAR(50)`,
      []
    );
  } catch { /* already present */ }

  try {
    await dbQuery.query(
      `ALTER TABLE ${s}.guest_customers ADD COLUMN IF NOT EXISTS source_details TEXT`,
      []
    );
  } catch { /* already present */ }

  try {
    await dbQuery.query(
      `ALTER TABLE ${s}.guest_customers ADD COLUMN IF NOT EXISTS internal_notes TEXT`,
      []
    );
  } catch { /* already present */ }

  try {
    await dbQuery.query(
      `ALTER TABLE ${s}.guest_customers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`,
      []
    );
  } catch { /* already present */ }

  // booking_workers.admin_actor_uid — which admin created the assignment
  try {
    await dbQuery.query(
      `ALTER TABLE ${s}.booking_workers ADD COLUMN IF NOT EXISTS admin_actor_uid VARCHAR(256)`,
      []
    );
  } catch { /* already present */ }

  // service_options.duration_mins — actual service duration; used for endAt calculation
  try {
    await dbQuery.query(
      `ALTER TABLE ${s}.service_options ADD COLUMN IF NOT EXISTS duration_mins INT NOT NULL DEFAULT 120`,
      []
    );
  } catch { /* already present */ }
};

// ── Phone normalization ───────────────────────────────────────────────────────

/**
 * Guest contact numbers — best effort, never fails.
 *
 * Delegates to the strict identifier normalizer and falls back only when that
 * rejects. The fallback is deliberate here and stated rather than accidental: a
 * guest's contact number is something an admin typed off a phone call, and
 * refusing to record a booking because the number looks odd is worse than
 * storing it as given.
 *
 * DO NOT use this for anything that feeds a uniqueness constraint. Because it
 * cannot fail, every malformed spelling produces a distinct output, so an index
 * over it will not catch duplicates. Use `toE164PhMobile`, which returns null.
 */
export function normalizePhilippinePhone(raw: string): string {
  const strict = toE164PhMobile(raw);
  if (strict) return strict;
  const cleaned = String(raw ?? '').replace(/[\s\-().+]/g, '');
  return raw?.startsWith('+') ? raw : '+' + cleaned;
}

// ── Client search ─────────────────────────────────────────────────────────────

export const searchClients = async (query: string): Promise<any[]> => {
  if (!query?.trim() || query.trim().length < 2) return [];
  const q = `%${query.trim()}%`;
  const res = await dbQuery.query(
    `SELECT uid, first_name, last_name, email, phone_number
     FROM ${s}.user_credentials
     WHERE role::int = 3
       AND (
         first_name  ILIKE $1
         OR last_name ILIKE $1
         OR email     ILIKE $1
         OR phone_number ILIKE $1
         OR (first_name || ' ' || last_name) ILIKE $1
       )
     ORDER BY first_name, last_name
     LIMIT 20`,
    [q]
  );
  return res.rows.map((r: any) => ({
    uid: r.uid,
    name: `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim(),
    email: r.email ?? null,
    phone: r.phone_number ?? null,
  }));
};

// ── Guest duplicate detection ─────────────────────────────────────────────────

export const detectGuestDuplicate = async (
  phoneNormalized: string
): Promise<{ exists: boolean; guestCustomerId?: string; name?: string }> => {
  const res = await dbQuery.query(
    `SELECT guest_customer_id, first_name, last_name
     FROM ${s}.guest_customers
     WHERE phone_normalized = $1
     LIMIT 1`,
    [phoneNormalized]
  );
  if (!res.rowCount) return { exists: false };
  const row = res.rows[0];
  return {
    exists: true,
    guestCustomerId: row.guest_customer_id,
    name: `${row.first_name} ${row.last_name}`.trim(),
  };
};

// ── Bookable services ─────────────────────────────────────────────────────────

export const getBookableServicesForAdmin = async (): Promise<any[]> => {
  const servicesRes = await dbQuery.query(
    `SELECT id, name FROM ${s}.services ORDER BY name`,
    []
  );

  const optionsRes = await dbQuery.query(
    `SELECT so.id, so.service_id, so.level_2, so.level_3,
            so.base_price, so.option_type, so.parent_option_id
     FROM ${s}.service_options so
     ORDER BY so.service_id, so.option_type, so.level_2, so.level_3`,
    []
  );

  const addonsByParent: Record<number, any[]> = {};
  const mainsByService: Record<number, any[]> = {};

  for (const opt of optionsRes.rows) {
    if (opt.option_type === 'ADD_ON' && opt.parent_option_id) {
      addonsByParent[opt.parent_option_id] = addonsByParent[opt.parent_option_id] ?? [];
      addonsByParent[opt.parent_option_id].push({
        optionId: opt.id,
        name: opt.level_3 ?? opt.level_2 ?? 'Add-on',
        basePrice: opt.base_price ? Number(opt.base_price) : 0,
      });
    } else if (opt.option_type === 'MAIN') {
      mainsByService[opt.service_id] = mainsByService[opt.service_id] ?? [];
      mainsByService[opt.service_id].push({
        optionId: opt.id,
        level1: null,
        level2: opt.level_2 ?? null,
        level3: opt.level_3 ?? null,
        basePrice: opt.base_price ? Number(opt.base_price) : 0,
        addons: addonsByParent[opt.id] ?? [],
      });
    }
  }

  return servicesRes.rows
    .filter((svc: any) => (mainsByService[svc.id] ?? []).length > 0)
    .map((svc: any) => ({
      serviceId: svc.id,
      serviceName: svc.name,
      options: mainsByService[svc.id] ?? [],
    }));
};

// ── Slot candidates (without existing bookingId) ──────────────────────────────

export const listCandidatesForSlot = async (slot: {
  startAt: string;
  endAt: string;
  serviceId: string | null;
  cityId: string | null;
  branchId: string | null;
  serviceOptionId?: string | null;
}): Promise<any[]> => {
  // When serviceOptionId is provided, look up duration_mins for an accurate conflict window.
  // The controller default (startAt+2h) is only used when no option is known.
  let endAt = slot.endAt;
  if (slot.serviceOptionId) {
    const durRes = await dbQuery.query(
      `SELECT COALESCE(duration_mins, 120) AS duration_mins
       FROM ${s}.service_options WHERE id = $1`,
      [Number(slot.serviceOptionId)]
    );
    if (durRes.rows.length) {
      const durationMins = Number(durRes.rows[0].duration_mins);
      endAt = new Date(new Date(slot.startAt).getTime() + durationMins * 60 * 1000).toISOString();
    }
  }

  // Fetch all non-archived role 2/4 providers (max 50).
  // account_status filter is intentionally omitted here — the eligibility engine
  // flags non-active providers as ACCOUNT_INACTIVE (blocker) so admins can see
  // WHY a provider is unavailable rather than getting a silent empty list.
  const providersRes = await dbQuery.query(
    `SELECT uid, first_name, last_name, email, phone_number,
            account_status, is_archive, photo_url
     FROM ${s}.user_credentials
     WHERE role::int IN (2, 4)
       AND (is_archive IS NULL OR is_archive = false)
     ORDER BY account_status = 'active' DESC, created_at ASC
     LIMIT 50`,
    []
  );

  if (!providersRes.rows.length) return [];

  // Batch-fetch active services for all candidates in one query
  const providerUids = providersRes.rows.map((p: any) => p.uid);
  const activeSvcRes = await dbQuery.query(
    `SELECT es.employee_uid, s.name AS service_name
     FROM ${s}.employee_services es
     JOIN ${s}.services s ON s.id = es.service_id
     WHERE es.employee_uid = ANY($1)`,
    [providerUids]
  );
  const activeServicesByUid: Record<string, string[]> = {};
  for (const row of activeSvcRes.rows) {
    if (!activeServicesByUid[row.employee_uid]) activeServicesByUid[row.employee_uid] = [];
    activeServicesByUid[row.employee_uid].push(row.service_name);
  }

  const slotWithDuration = { ...slot, endAt };

  const results = await Promise.all(
    providersRes.rows.map(async (p: any) => {
      let eligibility: any;
      try {
        eligibility = await evaluateProviderForSlot(p.uid, slotWithDuration);
      } catch {
        eligibility = { providerUid: p.uid, eligible: false, score: 0, reasons: [], checks: {} };
      }
      return {
        ...eligibility,
        provider: {
          uid: p.uid,
          name: `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim(),
          email: p.email ?? null,
          phone: p.phone_number ?? null,
          avatarUrl: p.photo_url ?? null,
          activeServices: activeServicesByUid[p.uid] ?? [],
        },
      };
    })
  );

  // Eligible-first, then by score descending
  return results.sort((a: any, b: any) => {
    if (a.eligible && !b.eligible) return -1;
    if (!a.eligible && b.eligible) return 1;
    return b.score - a.score;
  });
};

// ── Payment evidence upload ───────────────────────────────────────────────────

const ALLOWED_EVIDENCE_MIMES = ['image/jpeg', 'image/png', 'image/webp'];
const MAGIC_BYTES: Record<string, number[][]> = {
  'image/jpeg': [[0xFF, 0xD8, 0xFF]],
  'image/png':  [[0x89, 0x50, 0x4E, 0x47]],
  'image/webp': [[0x52, 0x49, 0x46, 0x46]],   // RIFF — full WEBP check is 12 bytes; RIFF header is sufficient
};

export const validateAndUploadEvidence = async (params: {
  dataUri: string;
  originalFileName: string;
  adminUid: string;
}): Promise<{ storageUrl: string; mimeType: string; fileSizeBytes: number }> => {
  const { dataUri, originalFileName, adminUid } = params;

  if (!dataUri.startsWith('data:')) {
    throw Object.assign(new Error('file must be a base64 data URI'), { statusCode: 422 });
  }

  const mimeType = dataUri.slice(dataUri.indexOf(':') + 1, dataUri.indexOf(';'));
  if (!ALLOWED_EVIDENCE_MIMES.includes(mimeType)) {
    throw Object.assign(
      new Error('File type not allowed. Use JPG, PNG, or WebP.'),
      { statusCode: 422 }
    );
  }

  const base64Part = dataUri.split(',')[1];
  if (!base64Part) {
    throw Object.assign(new Error('Invalid data URI: no base64 payload'), { statusCode: 422 });
  }

  const buffer = Buffer.from(base64Part, 'base64');

  // Magic-byte check
  const magic = MAGIC_BYTES[mimeType];
  if (magic) {
    const valid = magic.some(sig => sig.every((byte, i) => buffer[i] === byte));
    if (!valid) {
      throw Object.assign(
        new Error('File content does not match declared MIME type.'),
        { statusCode: 422 }
      );
    }
  }

  // 7 MB raw → ~9.3 MB base64 → stays under the 10 MB express.json body limit
  const MAX_BYTES = 7 * 1024 * 1024;
  if (buffer.byteLength > MAX_BYTES) {
    throw Object.assign(new Error('File exceeds 7 MB limit.'), { statusCode: 422 });
  }

  const fileName = `admin-evidence/${adminUid}_${Date.now()}`;
  const storageUrl = await uploadFileToStorage('payment-evidence', fileName, dataUri);

  return { storageUrl, mimeType, fileSizeBytes: buffer.byteLength };
};

// ── Main transactional creation ───────────────────────────────────────────────

export const adminCreateBooking = async (
  params: AdminCreateBookingParams
): Promise<AdminCreateBookingResult> => {
  const {
    idempotencyKey, adminActorUid, customerType,
    guest, customerUid,
    serviceOptionId, addonOptionIds,
    scheduledAt,
    addressLine, city, lat, lon, instructions,
    locationId: serviceLocationId,
    providerUid,
    paymentMethod, paymentStatus,
    paymentEvidence,
  } = params;

  // ── Pre-flight: idempotency check (outside transaction) ──────────────────
  const existing = await dbQuery.query(
    `SELECT booking_id FROM ${s}.booking_create_idempotency
     WHERE idempotency_key = $1 AND actor_uid = $2
     LIMIT 1`,
    [idempotencyKey, adminActorUid]
  );
  if (existing.rowCount) {
    return { bookingId: existing.rows[0].booking_id, guestCustomerId: null };
  }

  // ── Validate inputs ───────────────────────────────────────────────────────
  if (customerType === 'guest') {
    if (!guest?.firstName?.trim()) throw Object.assign(new Error('Guest firstName is required'), { statusCode: 400 });
    if (!guest?.lastName?.trim())  throw Object.assign(new Error('Guest lastName is required'),  { statusCode: 400 });
    if (!guest?.phone?.trim())     throw Object.assign(new Error('Guest phone is required'),     { statusCode: 400 });
  } else {
    if (!customerUid?.trim()) throw Object.assign(new Error('customerUid is required for client bookings'), { statusCode: 400 });
  }

  if (!serviceOptionId || isNaN(serviceOptionId)) {
    throw Object.assign(new Error('serviceOptionId is required'), { statusCode: 400 });
  }
  if (!scheduledAt) {
    throw Object.assign(new Error('scheduledAt is required'), { statusCode: 400 });
  }
  if (!providerUid?.trim()) {
    throw Object.assign(new Error('providerUid is required'), { statusCode: 400 });
  }

  // ── Pre-flight: verify service option exists ──────────────────────────────
  const svcRes = await dbQuery.query(
    `SELECT so.id, so.base_price, so.service_id, s.name AS service_name,
            ${serviceDurationMinsSql('so')} AS duration_mins
     FROM ${s}.service_options so
     JOIN ${s}.services s ON s.id = so.service_id
     WHERE so.id = $1 AND so.option_type = 'MAIN'`,
    [serviceOptionId]
  );
  if (!svcRes.rowCount) {
    throw Object.assign(new Error('Service option not found or is not a bookable specific service'), { statusCode: 400 });
  }
  const svcRow = svcRes.rows[0];

  // ── Pre-flight: provider eligibility recheck ──────────────────────────────
  const endAt = new Date(new Date(scheduledAt).getTime() + Number(svcRow.duration_mins) * 60 * 1000).toISOString();

  // Resolve cityId from serviceLocationId for service-area enforcement (S-05)
  let resolvedCityId: string | null = null;
  if (serviceLocationId) {
    const locRes = await dbQuery.query(
      `SELECT city_id FROM ${s}.locations WHERE id = $1 LIMIT 1`,
      [serviceLocationId]
    );
    if (locRes.rowCount && locRes.rows[0].city_id != null) {
      resolvedCityId = String(locRes.rows[0].city_id);
    }
  }
  if (resolvedCityId === null) {
    // TODO(S-05): cityId still null — caller should pass locationId so city-based
    // service-area enforcement is enforced at booking creation time.
    console.warn('[adminCreateBooking] evaluateProviderForSlot called with cityId=null; service-area check is incomplete', {
      providerUid,
      serviceLocationId: serviceLocationId ?? null,
    });
  }

  const eligibility = await evaluateProviderForSlot(providerUid, {
    startAt:   scheduledAt,
    endAt,
    serviceId: String(svcRow.service_id),
    cityId:    resolvedCityId,
    branchId:  null,
  });
  if (!eligibility.eligible) {
    const blockerMsg = eligibility.reasons
      .filter((r: any) => r.severity === 'blocker')
      .map((r: any) => r.message)
      .join('; ');
    throw Object.assign(
      new Error(`Provider is not eligible for this slot: ${blockerMsg || 'eligibility check failed'}`),
      { statusCode: 409 }
    );
  }

  // ── Compute pricing ───────────────────────────────────────────────────────
  const basePrice = Number(svcRow.base_price ?? 0);
  let addonsTotal = 0;
  const addonDetails: { id: number; name: string; price: number }[] = [];

  if (addonOptionIds?.length) {
    const addonsRes = await dbQuery.query(
      `SELECT id, level_3, base_price FROM ${s}.service_options
       WHERE id = ANY($1) AND option_type = 'ADD_ON'`,
      [addonOptionIds]
    );
    for (const a of addonsRes.rows) {
      const p = Number(a.base_price ?? 0);
      addonsTotal += p;
      addonDetails.push({ id: a.id, name: a.level_3 ?? 'Add-on', price: p });
    }
  }

  const quotedPrice = basePrice + addonsTotal;
  const finalPrice  = quotedPrice;
  const pricingBreakdown = {
    base_price:    basePrice,
    addons:        addonDetails,
    addons_total:  addonsTotal,
    final:         finalPrice,
    transpo_fee:   0,
  };

  // ── Address payload ───────────────────────────────────────────────────────
  const locationId = `loc_${lat.toFixed(6)}_${lon.toFixed(6)}`;
  const serviceAddress: Record<string, any> = { addressLine, city, lat, lon, locationId };
  if (instructions) serviceAddress['instructions'] = instructions;

  // ── Normalize guest phone if applicable ──────────────────────────────────
  const guestPhoneNormalized = guest ? normalizePhilippinePhone(guest.phone) : null;

  // ── Worker code for job start verification ────────────────────────────────
  // The mobile startJob endpoint validates b.worker_code; without it the job
  // can never be started.  Generate before the transaction so it is stable
  // on any retry after a network failure.
  const workerCode = generateOTP();

  // ─── TRANSACTION ─────────────────────────────────────────────────────────
  const client = await pool.connect();
  let bookingId: number;
  let guestCustomerId: string | null = null;

  try {
    await client.query('BEGIN');

    // 0. Serialise concurrent requests with the same idempotency key.
    // pg_advisory_xact_lock is scoped to the transaction — auto-released on COMMIT/ROLLBACK.
    // Two concurrent requests with the same key queue here; the second re-reads the row
    // already committed by the first and returns early.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1 || ':' || $2)::bigint)`,
      [idempotencyKey, adminActorUid]
    );
    const existingInTx = await client.query(
      `SELECT booking_id FROM ${s}.booking_create_idempotency
       WHERE idempotency_key = $1 AND actor_uid = $2
       LIMIT 1`,
      [idempotencyKey, adminActorUid]
    );
    if (existingInTx.rows.length > 0) {
      await client.query('COMMIT');
      client.release();
      return { bookingId: existingInTx.rows[0].booking_id, guestCustomerId: null };
    }

    // 1. Create/fetch guest customer
    if (customerType === 'guest' && guest) {
      const guestId = randomUUID();
      // Upsert by phone (same phone = same guest identity across bookings)
      const guestUpsert = await client.query(
        `INSERT INTO ${s}.guest_customers
           (guest_customer_id, first_name, last_name, phone_normalized, email, created_by_admin_uid, source_channel)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (phone_normalized) DO NOTHING
         RETURNING guest_customer_id`,
        [
          guestId,
          guest.firstName.trim(),
          guest.lastName.trim(),
          guestPhoneNormalized!,
          guest.email?.trim() || null,
          adminActorUid,
          guest.sourceChannel || null,
        ]
      );

      if (guestUpsert.rowCount) {
        guestCustomerId = guestUpsert.rows[0].guest_customer_id;
      } else {
        // Phone already exists — fetch the existing guest_customer_id
        const existing = await client.query(
          `SELECT guest_customer_id FROM ${s}.guest_customers
           WHERE phone_normalized = $1 LIMIT 1`,
          [guestPhoneNormalized]
        );
        guestCustomerId = existing.rows[0]?.guest_customer_id ?? null;
      }
    }

    // 2. Insert booking
    // worker_uid is set here (same field the mobile job-cards query filters on:
    //   WHERE b.worker_uid = $1)  — without it the provider's job list is blind
    //   to this booking.  worker_code is required by the mobile startJob endpoint.
    const bookingRes = await client.query(
      `INSERT INTO ${s}.bookings
         (user_id, guest_customer_id, service_option_id, schedule,
          payment_method, otp_code, status, quoted_price, final_price,
          pricing_breakdown, service_address, admin_created, admin_created_by,
          worker_uid, worker_code)
       VALUES ($1, $2, $3, $4, $5, NULL, 'CONFIRMED', $6, $7, $8, $9, true, $10,
               $11, $12)
       RETURNING id`,
      [
        customerType === 'client' ? customerUid : null,
        guestCustomerId,
        serviceOptionId,
        scheduledAt,
        paymentMethod,
        quotedPrice,
        finalPrice,
        JSON.stringify(pricingBreakdown),
        JSON.stringify(serviceAddress),
        adminActorUid,
        providerUid,   // $11 — sets bookings.worker_uid so mobile job-cards can find it
        workerCode,    // $12 — sets bookings.worker_code so mobile startJob can verify
      ]
    );
    bookingId = bookingRes.rows[0].id;

    // 3. Insert booking_addons rows
    if (addonDetails.length) {
      for (const addon of addonDetails) {
        await client.query(
          `INSERT INTO ${s}.booking_addons (booking_id, addon_option_id, qty, unit_price)
           VALUES ($1, $2, 1, $3)`,
          [bookingId, addon.id, addon.price]
        );
      }
    }

    // 4. Insert payment row
    const dbPaymentStatus = paymentStatus === 'PAID' ? 'PAID' : 'PENDING';
    await client.query(
      `INSERT INTO ${s}.payments (booking_id, method, amount, status)
       VALUES ($1, $2, $3, $4)`,
      [bookingId, paymentMethod, finalPrice, dbPaymentStatus]
    );

    // 5. Insert booking_workers row (ASSIGNED status — provider still confirms separately)
    await client.query(
      `INSERT INTO ${s}.booking_workers
         (booking_id, worker_uid, status, assigned_at, admin_actor_uid)
       VALUES ($1, $2, 'ASSIGNED', NOW(), $3)`,
      [bookingId, providerUid, adminActorUid]
    );

    // 6. Insert payment evidence metadata (file already uploaded to Firebase)
    if (paymentEvidence?.storageUrl) {
      await client.query(
        `INSERT INTO ${s}.booking_payment_evidence
           (booking_id, storage_url, original_file_name, mime_type, file_size_bytes, uploaded_by_admin_uid)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          bookingId,
          paymentEvidence.storageUrl,
          paymentEvidence.originalFileName ?? null,
          paymentEvidence.mimeType,
          paymentEvidence.fileSizeBytes,
          adminActorUid,
        ]
      );
    }

    // 7. Record idempotency key
    await client.query(
      `INSERT INTO ${s}.booking_create_idempotency
         (idempotency_key, actor_uid, booking_id)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [idempotencyKey, adminActorUid, bookingId]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // ── Post-commit side effects (failures here are non-fatal) ───────────────

  // Timeline event
  dbQuery.query(
    `INSERT INTO ${s}.booking_timeline_events
       (booking_id, event_type, title, description, actor_type, actor_uid)
     VALUES ($1, 'booking_created_by_admin', 'Booking created by admin',
             $2, 'admin', $3)`,
    [
      bookingId,
      customerType === 'guest'
        ? `Guest booking: ${guest!.firstName} ${guest!.lastName}`
        : 'Client booking created by admin',
      adminActorUid,
    ]
  ).catch((e: any) => { console.error('[admin-create-booking] timeline write failed:', e?.message); });

  // Audit event
  dbQuery.query(
    `INSERT INTO ${s}.booking_audit_events
       (booking_id, actor_uid, actor_role, action, after_json)
     VALUES ($1, $2, 'admin', 'booking_created_by_admin', $3)`,
    [bookingId, adminActorUid, JSON.stringify({
      customerType,
      providerUid,
      serviceOptionId,
      scheduledAt,
      paymentMethod,
      paymentStatus,
    })]
  ).catch((e: any) => { console.error('[admin-create-booking] audit write failed:', e?.message); });

  // Provider real-time notification — lets the mobile app know it has a new job
  // without requiring a manual poll.  Fire-and-forget; non-fatal on failure.
  import('./notification.service').then(({ createNotification }) => {
    const code = `SVN-${String(bookingId).padStart(6, '0')}`;
    return createNotification(providerUid, {
      type: 'assigned_job',
      severity: 'info',
      title: 'New Job Assigned',
      safeBody: `You have been assigned to booking ${code} by admin. Please check your upcoming jobs.`,
      safeContextLabel: code,
      route: { page: 'jobs', bookingId: String(bookingId) },
      canOpenDetail: true,
    });
  }).catch((e: any) => { console.error('[admin-create-booking] provider notification failed:', e?.message); });

  return { bookingId, guestCustomerId };
};
