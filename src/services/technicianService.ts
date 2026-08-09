import { db } from "../config";
import dbQuery, { pool } from "../db/dbQuery";
import mongoDb from "../db/mongodbQuery";
import { generateOTP } from "../helpers/otp";
import { send } from "../helpers/mailer";
import { getAutoBookableProviderUids } from "./providerAutoOnlineEngine";
import { filterUidsAvailableAt } from "./providerAvailabilityEngine";
import { getUserInfoByBookingId } from "./user.service";
import { computeTranspoFee } from "./pricingService";
import { createCustomerNotification, createNotification } from "./notification.service";
import { notifyAdminsSafely } from './adminNotificationService';
import { acceptanceConflictForSnapshot, classifyResponseMiss } from "./bookingResponseConflict";
import { createDisbursement } from "./disbursement.service";
import { getOrCreateConversation, postSystemMessageOnce } from "../chat/chat.service";
import { findExistingConversationByBookingId } from "../chat/chat.repository";
import { emitToProvider } from "../provider.realtime";

const dbSchema = db.schema;

const ASSIGNABLE_BOOKING_STATUSES = new Set(["CONFIRMED", "PAID"]);
const TERMINAL_BOOKING_STATUSES = new Set([
  "COMPLETED",
  "CANCELED",
  "CANCELLED",
  "REFUNDED",
  "FAILED",
  "EXPIRED",
]);

export class BookingAssignmentError extends Error {
  constructor(
    readonly code:
      | "BOOKING_NOT_FOUND"
      | "BOOKING_NOT_ASSIGNABLE"
      | "BOOKING_ALREADY_ASSIGNED",
    message: string,
  ) {
    super(message);
    this.name = "BookingAssignmentError";
  }
}

type AssignmentTravel = {
  etaMinutes: number;
  otpCode: string;
  transpoFee: number;
  distanceKm: number;
};

type AssignmentWriteResult = {
  kind: "created" | "existing" | "busy";
  workerUid: string;
  bookingStatus?: string;
  customerUid?: string | null;
  schedule?: Date;
  etaAt?: Date | null;
  assignment?: any;
};

/**
 * The one write boundary for automatic and legacy/manual provider assignment.
 *
 * The booking row lock prevents two providers being attached to one booking;
 * the provider advisory lock prevents two concurrent bookings selecting the
 * same provider before either transaction becomes visible to the other.
 * Booking, assignment and tracking are committed or rolled back together.
 */
const persistWorkerAssignment = async (input: {
  bookingId: number;
  workerUid: string;
  note: string;
  travel?: AssignmentTravel;
  returnExistingAssignment?: boolean;
}): Promise<AssignmentWriteResult> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      [`servana-provider-assignment:${input.workerUid}`],
    );

    const bookingRes = await client.query(
      `SELECT id, status, worker_uid, user_id, schedule
       FROM ${dbSchema}.bookings
       WHERE id = $1
       FOR UPDATE`,
      [input.bookingId],
    );
    if (!bookingRes.rowCount) {
      throw new BookingAssignmentError("BOOKING_NOT_FOUND", "Booking not found");
    }

    const booking = bookingRes.rows[0];
    const status = String(booking.status ?? "").toUpperCase();
    const currentWorkerUid = booking.worker_uid ? String(booking.worker_uid) : null;

    if (currentWorkerUid) {
      if (currentWorkerUid !== input.workerUid && !input.returnExistingAssignment) {
        throw new BookingAssignmentError(
          "BOOKING_ALREADY_ASSIGNED",
          "Booking is already assigned to another provider",
        );
      }
      await client.query("COMMIT");
      return {
        kind: "existing",
        workerUid: currentWorkerUid,
        bookingStatus: status,
        customerUid: booking.user_id ?? null,
        schedule: new Date(booking.schedule),
      };
    }

    if (TERMINAL_BOOKING_STATUSES.has(status) || !ASSIGNABLE_BOOKING_STATUSES.has(status)) {
      throw new BookingAssignmentError(
        "BOOKING_NOT_ASSIGNABLE",
        `Booking cannot be assigned from status ${status || "UNKNOWN"}`,
      );
    }

    const schedule = new Date(booking.schedule);
    const windowStart = new Date(schedule.getTime() - 2 * 60 * 60 * 1000);
    const windowEnd = new Date(schedule.getTime() + 2 * 60 * 60 * 1000);
    const busyRes = await client.query(
      `SELECT id
       FROM ${dbSchema}.bookings
       WHERE worker_uid = $1
         AND id <> $2
         AND schedule BETWEEN $3 AND $4
         AND status NOT IN ('COMPLETED','CANCELED','CANCELLED','REFUNDED','FAILED','EXPIRED')
       LIMIT 1`,
      [input.workerUid, input.bookingId, windowStart, windowEnd],
    );
    if (busyRes.rowCount) {
      await client.query("ROLLBACK");
      return { kind: "busy", workerUid: input.workerUid };
    }

    const travel = input.travel ?? null;
    const updateRes = await client.query(
      `UPDATE ${dbSchema}.bookings
       SET worker_uid = $2,
           status = 'WORKER_ASSIGNED',
           eta_minutes = CASE WHEN $3::int IS NULL THEN eta_minutes ELSE $3::int END,
           eta_at = CASE
             WHEN $3::int IS NULL THEN eta_at
             ELSE NOW() + ($3::int * interval '1 minute')
           END,
           worker_code = COALESCE($4, worker_code),
           transpo_fee = CASE WHEN $5::numeric IS NULL THEN transpo_fee ELSE $5::numeric END,
           final_price = CASE WHEN $5::numeric IS NULL THEN final_price ELSE quoted_price + $5::numeric END,
           pricing_breakdown = CASE
             WHEN $5::numeric IS NULL THEN pricing_breakdown
             ELSE COALESCE(pricing_breakdown, '{}'::jsonb) || jsonb_build_object(
               'transpo_fee', $5::numeric,
               'worker_distance', $6::numeric
             )
           END
       WHERE id = $1
         AND worker_uid IS NULL
         AND status IN ('CONFIRMED','PAID')
       RETURNING user_id, schedule, eta_at`,
      [
        input.bookingId,
        input.workerUid,
        travel?.etaMinutes ?? null,
        travel?.otpCode ?? null,
        travel?.transpoFee ?? null,
        travel ? Math.round(travel.distanceKm * 100) / 100 : null,
      ],
    );
    if (!updateRes.rowCount) {
      throw new BookingAssignmentError(
        "BOOKING_ALREADY_ASSIGNED",
        "Booking assignment changed concurrently",
      );
    }

    const assignmentRes = await client.query(
      `INSERT INTO ${dbSchema}.booking_workers
         (booking_id, worker_uid, status, assigned_at)
       VALUES ($1,$2,'ASSIGNED',NOW())
       RETURNING *`,
      [input.bookingId, input.workerUid],
    );
    await client.query(
      `INSERT INTO ${dbSchema}.booking_tracking (booking_id,status,note)
       VALUES ($1,'WORKER_ASSIGNED',$2)`,
      [input.bookingId, input.note],
    );

    await client.query("COMMIT");
    return {
      kind: "created",
      workerUid: input.workerUid,
      bookingStatus: "WORKER_ASSIGNED",
      customerUid: updateRes.rows[0]?.user_id ?? null,
      schedule: new Date(updateRes.rows[0]?.schedule ?? booking.schedule),
      etaAt: updateRes.rows[0]?.eta_at ? new Date(updateRes.rows[0].eta_at) : null,
      assignment: assignmentRes.rows[0],
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

const publishWorkerAssignment = (input: {
  bookingId: number;
  workerUid: string;
  customerUid?: string | null;
  source: "automatic" | "manual";
}) => {
  const code = `SVN-${String(input.bookingId).padStart(6, "0")}`;
  createNotification(input.workerUid, {
    notificationKey: `assigned_job_${input.bookingId}_${input.workerUid}`,
    type: "assigned_job",
    severity: "info",
    title: "New Job Assigned",
    safeBody: `You have been assigned to booking ${code}. Please review and respond.`,
    safeContextLabel: code,
    route: { page: "jobs", bookingId: String(input.bookingId) },
    canOpenDetail: true,
  }).catch((e) => console.error("createNotification (assignment):", e));

  if (input.customerUid) {
    createCustomerNotification(input.customerUid, {
      notificationKey: `provider_assigned_${input.bookingId}`,
      type: "provider_assigned",
      severity: "success",
      title: "Provider assigned",
      safeBody: "A provider has been assigned and is reviewing your booking.",
      safeContextLabel: code,
      route: { routeKey: "BOOKING_DETAILS", resourceId: String(input.bookingId) },
      canOpenDetail: true,
    }).catch((e) => console.error("createCustomerNotification (assignment):", e));
  }

  emitToProvider(input.workerUid, "booking:updated", {
    bookingId: String(input.bookingId),
    status: "ASSIGNED",
    assignmentSource: input.source,
    occurredAt: new Date().toISOString(),
  });
};

export const listWorkersByRole = async (role: number) => {
  const r = await dbQuery.query(
    `
    SELECT uid, email, first_name, last_name, phone_number, role, is_archive
    FROM ${dbSchema}.user_credentials
    WHERE role = $1 AND is_archive = false
    ORDER BY first_name, last_name
    `,
    [role]
  );

  return r.rows;
};

export const allWorkers = async () => {
  const r = await dbQuery.query(
    `
    SELECT
      u.uid,
      u.email,
      u.first_name,
      u.last_name,
      u.phone_number,
      u.role,
      u.is_archive,
      r.role_name,
      r.description
    FROM ${dbSchema}.user_credentials u
    LEFT JOIN ${dbSchema}.roles r
      ON u.role::int = r.role_id
    WHERE u.role::int = 2 AND u.is_archive = false
    ORDER BY u.first_name, u.last_name
    `,
    []
  );

  return r.rows;
};

export const setWorkerArchiveStatus = async (uid: string, isArchive: boolean) => {
  const res = await dbQuery.query(
    `
    UPDATE ${dbSchema}.user_credentials
    SET is_archive = $1
    WHERE uid = $2
    RETURNING uid, email, first_name, last_name, is_archive
    `,
    [isArchive, uid]
  );

  if (!res.rowCount) throw new Error("Worker not found");
  return res.rows[0];
};

export const getWorkerByUid = async (uid: string) => {
  const r = await dbQuery.query(
    `
    SELECT
      u.uid,
      u.email,
      u.first_name,
      u.last_name,
      u.phone_number,
      u.role,
      u.created_date,
      u.is_email_verified,
      u.is_archive,
      r.role_name,
      r.description,
      up.birthdate,
      up.gender,
      up.photo_url
    FROM ${dbSchema}.user_credentials u
    LEFT JOIN ${dbSchema}.roles r
      ON u.role::int = r.role_id
    LEFT JOIN ${dbSchema}.user_profile up
      ON up.uid = u.uid
    WHERE u.uid = $1
    LIMIT 1;
    `,
    [uid]
  );

  if (!r.rowCount) return null;

  const worker = r.rows[0];

  const [addrRes, servicesRes, reqRes, bookingsRes, disbursementsRes, earningsRes] = await Promise.all([
    dbQuery.query(
      `
      SELECT address_id, address_one, address_two, zip_code, post_town, country, label, is_primary
      FROM ${dbSchema}.user_address
      WHERE uid = $1
      ORDER BY is_primary DESC, created_at ASC
      `,
      [uid]
    ),
    dbQuery.query(
      `
      SELECT s.id, s.name, s.category, es.created_at AS assigned_at
      FROM ${dbSchema}.employee_services es
      JOIN ${dbSchema}.services s ON s.id = es.service_id
      WHERE es.employee_uid = $1
      ORDER BY s.name
      `,
      [uid]
    ),
    dbQuery.query(
      `
      SELECT id, file_url, file_name, uploaded_at
      FROM ${dbSchema}.worker_requirements
      WHERE worker_uid = $1
      ORDER BY uploaded_at ASC
      `,
      [uid]
    ),
    dbQuery.query(
      `
      SELECT
        b.id,
        b.schedule,
        b.status            AS booking_status,
        b.final_price,
        b.payment_method,
        so.level_2          AS service_name,
        so.level_3          AS service_variant,
        bw.status           AS worker_status,
        bw.assigned_at,
        bw.started_at,
        bw.completed_at,
        uc.first_name || ' ' || uc.last_name AS customer_name,
        p.status            AS payment_status,
        p.method            AS payment_provider,
        p.paid_at
      FROM ${dbSchema}.booking_workers bw
      JOIN ${dbSchema}.bookings b
        ON b.id = bw.booking_id
      JOIN ${dbSchema}.service_options so
        ON so.id = b.service_option_id
      JOIN ${dbSchema}.user_credentials uc
        ON uc.uid = b.user_id
      LEFT JOIN ${dbSchema}.payments p
        ON p.booking_id = b.id AND p.additional_request_id IS NULL
      WHERE bw.worker_uid = $1
      ORDER BY b.schedule DESC
      `,
      [uid]
    ),
    dbQuery.query(
      `
      SELECT
        d.id,
        d.booking_id,
        d.total_amount,
        d.servana_share,
        d.worker_share,
        d.status,
        d.paymongo_payout_id,
        d.payout_error,
        d.released_at,
        d.created_at,
        so.level_2          AS service_name,
        b.schedule,
        bw.completed_at,
        bw.completed_at + INTERVAL '72 hours' AS release_after
      FROM ${dbSchema}.disbursements d
      JOIN ${dbSchema}.bookings b
        ON b.id = d.booking_id
      JOIN ${dbSchema}.service_options so
        ON so.id = b.service_option_id
      LEFT JOIN ${dbSchema}.booking_workers bw
        ON bw.booking_id = d.booking_id
       AND bw.worker_uid  = d.worker_uid
       AND bw.status      = 'COMPLETED'
      WHERE d.worker_uid = $1
      ORDER BY d.created_at DESC
      `,
      [uid]
    ),
    dbQuery.query(
      `
      SELECT
        COUNT(*)                                                                      AS total_jobs,
        COALESCE(SUM(worker_share), 0)                                                AS total_gross,
        COALESCE(SUM(CASE WHEN status = 'RELEASED' THEN worker_share ELSE 0 END), 0) AS total_released,
        COALESCE(SUM(CASE WHEN status = 'PENDING'  THEN worker_share ELSE 0 END), 0) AS total_pending,
        COALESCE(SUM(CASE WHEN status = 'FAILED'   THEN worker_share ELSE 0 END), 0) AS total_failed,
        COALESCE(SUM(total_amount), 0)                                                AS total_collected,
        COALESCE(SUM(servana_share), 0)                                               AS total_servana_cut
      FROM ${dbSchema}.disbursements
      WHERE worker_uid = $1
      `,
      [uid]
    ),
  ]);

  return {
    ...worker,
    addresses: addrRes.rows.map((a: any) => ({
      addressId: a.address_id,
      addressOne: a.address_one,
      addressTwo: a.address_two,
      zipCode: a.zip_code,
      postTown: a.post_town,
      country: a.country,
      label: a.label,
      isPrimary: a.is_primary,
    })),
    services: servicesRes.rows.map((s: any) => ({
      id: s.id,
      name: s.name,
      category: s.category,
      assignedAt: s.assigned_at,
    })),
    requirements: reqRes.rows.map((f: any) => ({
      id: f.id,
      fileUrl: f.file_url,
      fileName: f.file_name,
      uploadedAt: f.uploaded_at,
    })),
    bookingHistory: bookingsRes.rows,
    disbursementHistory: disbursementsRes.rows,
    earningsSummary: earningsRes.rows[0],
  };
};

let _reqTypeColReady: Promise<void> | null = null;
const ensureRequirementTypeColumn = (): Promise<void> => {
  if (!_reqTypeColReady) {
    _reqTypeColReady = dbQuery.query(
      `ALTER TABLE ${dbSchema}.worker_requirements ADD COLUMN IF NOT EXISTS requirement_type VARCHAR(100)`
    ).then(() => undefined);
  }
  return _reqTypeColReady;
};

export const addWorkerRequirements = async (
  workerUid: string,
  files: Array<{ fileUrl: string; fileName: string; requirementType?: string }>
) => {
  await ensureRequirementTypeColumn();
  const inserted: any[] = [];
  for (const { fileUrl, fileName, requirementType } of files) {
    const res = await dbQuery.query(
      `
      INSERT INTO ${dbSchema}.worker_requirements (worker_uid, file_url, file_name, requirement_type)
      VALUES ($1, $2, $3, $4)
      RETURNING id, file_url, file_name, uploaded_at, requirement_type
      `,
      [workerUid, fileUrl, fileName, requirementType ?? null]
    );
    const row = res.rows[0];
    inserted.push({
      id: row.id,
      fileUrl: row.file_url,
      fileName: row.file_name,
      uploadedAt: row.uploaded_at,
      requirementType: row.requirement_type,
    });
  }
  return inserted;
};

export const getWorkerRequirements = async (workerUid: string) => {
  await ensureRequirementTypeColumn();
  const res = await dbQuery.query(
    `
    SELECT wr.id, wr.file_url, wr.file_name, wr.uploaded_at, wr.requirement_type,
           COALESCE(ld.decision, 'pending_review')          AS current_decision,
           ld.provider_message,
           ld.decided_at                                     AS reviewed_at
    FROM ${dbSchema}.worker_requirements wr
    LEFT JOIN LATERAL (
      SELECT decision, provider_message, decided_at
      FROM ${dbSchema}.provider_requirement_decisions
      WHERE worker_requirement_id = wr.id AND NOT is_superseded
      ORDER BY decided_at DESC LIMIT 1
    ) ld ON true
    WHERE wr.worker_uid = $1
    ORDER BY wr.uploaded_at ASC
    `,
    [workerUid]
  ).catch((err: any) => {
    // Only suppress "relation does not exist" (42P01) and "column does not exist" (42703)
    if (err?.code !== '42P01' && err?.code !== '42703') throw err;
    return dbQuery.query(
      `SELECT id, file_url, file_name, uploaded_at, requirement_type FROM ${dbSchema}.worker_requirements WHERE worker_uid = $1 ORDER BY uploaded_at ASC`,
      [workerUid]
    );
  });
  return res.rows.map((f: any) => ({
    id: f.id,
    fileUrl: f.file_url,
    fileName: f.file_name,
    uploadedAt: f.uploaded_at,
    requirementType: f.requirement_type ?? null,
    currentDecision: f.current_decision ?? 'pending_review',
    providerMessage: f.provider_message ?? null,
    reviewedAt: f.reviewed_at ?? null,
  }));
};

export const deleteWorkerRequirement = async (workerUid: string, id: number) => {
  const check = await dbQuery.query(
    `SELECT wr.id, COALESCE(ld.decision, 'pending_review') AS current_decision
     FROM ${dbSchema}.worker_requirements wr
     LEFT JOIN LATERAL (
       SELECT decision FROM ${dbSchema}.provider_requirement_decisions
       WHERE worker_requirement_id = wr.id AND NOT is_superseded
       ORDER BY decided_at DESC LIMIT 1
     ) ld ON true
     WHERE wr.id = $1 AND wr.worker_uid = $2 LIMIT 1`,
    [id, workerUid]
  ).catch((err: any) => {
    if (err?.code !== '42P01' && err?.code !== '42703') throw err;
    return dbQuery.query(
      `SELECT id, 'pending_review'::text AS current_decision FROM ${dbSchema}.worker_requirements WHERE id = $1 AND worker_uid = $2 LIMIT 1`,
      [id, workerUid]
    );
  });
  if (!check.rowCount) throw Object.assign(new Error('Requirement not found for this worker'), { statusCode: 404 });
  if (check.rows[0].current_decision === 'approved') {
    throw Object.assign(new Error('Approved documents cannot be deleted. Contact support if you need to replace an approved document.'), { statusCode: 409 });
  }
  const res = await dbQuery.query(
    `DELETE FROM ${dbSchema}.worker_requirements WHERE id = $1 AND worker_uid = $2 RETURNING id, file_name`,
    [id, workerUid]
  );
  if (!res.rowCount) throw Object.assign(new Error('Requirement not found for this worker'), { statusCode: 404 });
  return res.rows[0];
};

export const upsertWorkerLocation = async (payload: {
  uid: string;
  latitude: number;
  longitude: number;
  is_online: boolean;
}) => {

  const collection = (await mongoDb).collection("worker_locations");

  await collection.updateOne(
    { uid: payload.uid },
    {
      $set: {
        uid: payload.uid,
        is_online: payload.is_online,
        loc: {
          type: "Point",
          coordinates: [payload.longitude, payload.latitude]
        },
        updatedAt: new Date(),
      },
    },
    { upsert: true }
  );

  return true;
};

export const getWorkerLocation = async (uid: string) => {

  const collection = (await mongoDb).collection("worker_locations");

  return collection.findOne(
    { uid },
    {
      projection: {
        uid: 1,
        is_online: 1,
        loc: 1,
        updatedAt: 1
      }
    }
  );
};

export const listOnlineTechnicians = async () => {
  const collection = (await mongoDb).collection("technician_locations");
  return collection
    .find({ is_online: true, loc: { $exists: true } }, { projection: { uid: 1, loc: 1, updatedAt: 1 } })
    .toArray();
};

export const listOnlineWorkersByRole = async (role: number) => {
  const workersRes = await dbQuery.query(
    `
    SELECT uid
    FROM ${dbSchema}.user_credentials
    WHERE role=$1
    `,
    [role]
  );

  const uids = workersRes.rows.map((r: any) => r.uid);

  if (!uids.length) return [];

  const collection = (await mongoDb).collection("worker_locations");

  return collection
    .find({
      uid: { $in: uids },
      is_online: true,
      loc: { $exists: true }
    })
    .toArray();
};

export const listOnlineWorkers = async () => {
  const collection = (await mongoDb).collection("worker_locations");

  return collection
    .find({
      is_online: true,
      loc: { $exists: true }
    })
    .toArray();
};

export const listOnlineWorkersByService = async (serviceId: number) => {
  const workersRes = await dbQuery.query(
    `
    SELECT employee_uid
    FROM ${dbSchema}.employee_services
    WHERE service_id = $1
      AND COALESCE(status, 'active') = 'active'
    `,
    [serviceId]
  );

  const uids = workersRes.rows.map((r: any) => r.employee_uid);

  if (!uids.length) return [];

  const collection = (await mongoDb).collection("worker_locations");

  return collection
    .find({
      uid: { $in: uids },
      is_online: true,
      loc: { $exists: true }
    })
    .toArray();
};

const applyNearestWorkerTranspoFee = async (
  bookingId: number,
  userLat: number,
  userLon: number,
  serviceId?: number | null
) => {
  try {
    const collection = (await mongoDb).collection("worker_locations");

    let filter: any = { loc: { $exists: true } };

    if (serviceId) {
      const workersRes = await dbQuery.query(
        `SELECT employee_uid FROM ${dbSchema}.employee_services WHERE service_id = $1`,
        [serviceId]
      );
      const uids = workersRes.rows.map((r: any) => r.employee_uid);
      if (!uids.length) return;
      filter.uid = { $in: uids };
    }

    const allWorkers = await collection.find(filter).toArray();
    if (!allWorkers.length) return;

    const nearest = allWorkers
      .map((w: any) => {
        const [lon, lat] = w.loc.coordinates;
        return { distanceKm: haversineKm(userLat, userLon, lat, lon) };
      })
      .sort((a, b) => a.distanceKm - b.distanceKm)[0];

    const transpoFee = computeTranspoFee(nearest.distanceKm);
    const roundedDist = Math.round(nearest.distanceKm * 100) / 100;

    await dbQuery.query(
      `
      UPDATE ${dbSchema}.bookings
      SET transpo_fee = $1,
          final_price = quoted_price + $1,
          pricing_breakdown = pricing_breakdown || jsonb_build_object(
            'transpo_fee',     $1::numeric,
            'worker_distance', $2::numeric
          )
      WHERE id = $3
      `,
      [transpoFee, roundedDist, bookingId]
    );
  } catch (err) {
    console.error("applyNearestWorkerTranspoFee failed:", err);
  }
};

const haversineKm = (lat1: number, lon1: number, lat2: number, lon2: number) => {
  const toRad = (v: number) => (v * Math.PI) / 180;
  const R = 6371;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(a));
};

// Merge auto-bookable providers who may only be in worker_service_applications (not employee_services)
const mergeAutoBookableProviders = async (existing: any[], serviceId: number | null | undefined): Promise<any[]> => {
  try {
    const autoUids = await getAutoBookableProviderUids(serviceId ?? undefined);
    if (!autoUids.length) return existing;
    const existingSet = new Set(existing.map((w: any) => w.uid));
    const missing = autoUids.filter(uid => !existingSet.has(uid));
    if (!missing.length) return existing;
    const col = (await mongoDb).collection('worker_locations');
    const docs = await col.find(
      { uid: { $in: missing }, is_online: true, loc: { $exists: true } },
      { projection: { uid: 1, loc: 1, updatedAt: 1 } }
    ).toArray();
    return [...existing, ...docs];
  } catch {
    return existing;
  }
};

export const assignNearestWorker = async (
  bookingId: number,
  userLat: number,
  userLon: number,
  serviceId?: number | null
) => {

  // 1. Resolve the booking once for candidate filtering. The transactional
  // write below re-locks and revalidates it before changing any state.
  const bookingRes = await dbQuery.query(
    `SELECT schedule, status, worker_uid, user_id
     FROM ${dbSchema}.bookings
     WHERE id = $1`,
    [bookingId]
  );

  if (!bookingRes.rowCount) {
    throw new Error("Booking not found");
  }

  const booking = bookingRes.rows[0];
  const bookingStatus = String(booking.status ?? "").toUpperCase();
  if (booking.worker_uid) {
    return {
      assigned: true,
      worker_uid: String(booking.worker_uid),
      idempotent: true,
    };
  }
  if (TERMINAL_BOOKING_STATUSES.has(bookingStatus) ||
      !ASSIGNABLE_BOOKING_STATUSES.has(bookingStatus)) {
    return { assigned: false, reason: "BOOKING_NOT_ASSIGNABLE", status: bookingStatus };
  }

  const schedule = new Date(booking.schedule);
  const windowStart = new Date(schedule.getTime() - 2 * 60 * 60 * 1000);
  const windowEnd   = new Date(schedule.getTime() + 2 * 60 * 60 * 1000);

  // 2. Find UIDs that are busy within ±2h of the booking schedule
  const busyRes = await dbQuery.query(
    `
    SELECT DISTINCT worker_uid
    FROM ${dbSchema}.bookings
    WHERE worker_uid IS NOT NULL
      AND schedule BETWEEN $1 AND $2
      AND status NOT IN ('COMPLETED','CANCELED','CANCELLED','REFUNDED','FAILED','EXPIRED')
      AND id != $3
    `,
    [windowStart, windowEnd, bookingId]
  );
  const busyUids = new Set(busyRes.rows.map((r: any) => r.worker_uid));

  // 3. Get online workers qualified for this service, filter out busy ones
  // Merge auto-bookable providers who may only be in worker_service_applications
  const rawOnline = serviceId
    ? await listOnlineWorkersByService(serviceId)
    : await listOnlineWorkers();
  const onlineWorkers = await mergeAutoBookableProviders(rawOnline, serviceId);

  if (!onlineWorkers.length) {
    await applyNearestWorkerTranspoFee(bookingId, userLat, userLon, serviceId);
    return { assigned: false, reason: "NO_WORKER_ONLINE" };
  }
  const notBusyWorkers = onlineWorkers.filter((w: any) => !busyUids.has(w.uid));
  if (!notBusyWorkers.length) {
    await applyNearestWorkerTranspoFee(bookingId, userLat, userLon, serviceId);
    return { assigned: false, reason: "NO_WORKER_AVAILABLE" };
  }

  // 3b. Honour the provider's own weekly schedule and time-off.
  //
  // Step 2 only rules out providers already booked elsewhere; it never asked
  // whether the provider said they work at this hour at all, so auto-assignment
  // could hand someone a job on their day off.
  //
  // missingScheduleIsAvailable is deliberately true: most providers have never
  // saved a schedule, and treating "not configured" as "not available" would
  // silently shrink the candidate pool to almost nobody. Absence of a
  // declaration is not a declaration of unavailability (§28). Only a provider
  // who HAS a schedule that excludes this window is filtered out, which makes
  // this change strictly narrowing and safe to ship against live data.
  let scheduleEligible = notBusyWorkers;
  try {
    const { eligible, excluded } = await filterUidsAvailableAt(
      notBusyWorkers.map((w: any) => w.uid),
      schedule.toISOString(),
      new Date(schedule.getTime() + 60 * 60 * 1000).toISOString(),
      { missingScheduleIsAvailable: true },
    );
    if (excluded.length) {
      console.info(
        `[assignNearestWorker] booking ${bookingId}: ${excluded.length} provider(s) excluded by schedule/time-off:`,
        excluded.map(e => `${e.uid}:${e.reason}`).join(", ")
      );
    }
    const eligibleSet = new Set(eligible);
    scheduleEligible = notBusyWorkers.filter((w: any) => eligibleSet.has(w.uid));
  } catch (e: any) {
    // Availability is an additional filter, not the assignment's source of
    // truth. If it fails, assign as before rather than stranding the booking.
    console.error(`[assignNearestWorker] availability filter failed, proceeding unfiltered:`, e?.message ?? e);
  }

  if (!scheduleEligible.length) {
    await applyNearestWorkerTranspoFee(bookingId, userLat, userLon, serviceId);
    return { assigned: false, reason: "NO_WORKER_AVAILABLE_IN_SCHEDULE" };
  }

  // 3b. Exclude providers who have ALREADY DECLINED THIS BOOKING.
  //
  // Ranking is by distance alone, and `releaseBookingAndReassign` calls back
  // into this function on decline — so without this filter the nearest provider
  // who just refused the job is deterministically the next one offered it.
  // Production booking 94 shows the outcome: the same provider declined three
  // times and was re-selected each time, with the customer waiting through all
  // of it.
  //
  // Scoped to THIS booking only. A decline is a statement about one job, not
  // about the provider, and it must not affect their candidacy for anything
  // else.
  let candidates = scheduleEligible;
  try {
    const declinedRes = await dbQuery.query(
      `SELECT DISTINCT worker_uid
         FROM ${dbSchema}.booking_workers
        WHERE booking_id = $1 AND status = 'DECLINED'`,
      [bookingId]
    );

    const declined = new Set<string>(
      declinedRes.rows.map((r: any) => r.worker_uid).filter(Boolean)
    );

    if (declined.size) {
      candidates = scheduleEligible.filter((w: any) => !declined.has(w.uid));
      console.info(
        `[assignNearestWorker] booking ${bookingId}: ${declined.size} provider(s) excluded — already declined this booking`
      );
    }
  } catch (e: any) {
    // Fail OPEN, and deliberately unlike the availability filter above.
    //
    // A failed availability check that proceeds unfiltered can hand a provider
    // a job on their day off — a correctness problem. A failed decline check
    // that proceeds unfiltered merely restores the behaviour that existed
    // before this block: an inefficient re-offer. Stranding a live booking to
    // avoid that trade would be the worse outcome.
    console.error(
      `[assignNearestWorker] decline filter failed, proceeding unfiltered:`,
      e?.message ?? e
    );
  }

  const availableWorkers = candidates;

  // Everyone eligible has already refused this specific booking. Retrying is
  // what §44 calls endless retry — the loop has no new information and will
  // produce the same declines. Hand it to operations instead.
  if (!availableWorkers.length) {
    await applyNearestWorkerTranspoFee(bookingId, userLat, userLon, serviceId);
    return { assigned: false, reason: "ALL_ELIGIBLE_WORKERS_DECLINED" };
  }

  // 4. Rank available workers by distance. Candidate availability is checked
  // again inside the transaction, so a concurrent assignment falls through to
  // the next candidate instead of double-booking the nearest provider.
  const ranked = availableWorkers
    .map((w: any) => {
      const [lon, lat] = w.loc.coordinates;
      return {
        uid: w.uid,
        distanceKm: haversineKm(userLat, userLon, lat, lon)
      };
    })
    .sort((a, b) => a.distanceKm - b.distanceKm);

  let selected: typeof ranked[number] | null = null;
  let persisted: AssignmentWriteResult | null = null;
  let etaMinutes = 0;
  let transpoFee = 0;

  for (const candidate of ranked) {
    const avgSpeedKph = 30;
    const candidateEta = Math.floor(
      Math.max(5, Math.ceil((candidate.distanceKm / avgSpeedKph) * 60))
    );
    const candidateFee = computeTranspoFee(candidate.distanceKm);
    const result = await persistWorkerAssignment({
      bookingId,
      workerUid: candidate.uid,
      note: "Nearest worker assigned",
      returnExistingAssignment: true,
      travel: {
        etaMinutes: candidateEta,
        otpCode: generateOTP(),
        transpoFee: candidateFee,
        distanceKm: candidate.distanceKm,
      },
    });
    if (result.kind === "busy") continue;
    if (result.kind === "existing") {
      return {
        assigned: true,
        worker_uid: result.workerUid,
        idempotent: true,
      };
    }
    selected = candidate;
    persisted = result;
    etaMinutes = candidateEta;
    transpoFee = candidateFee;
    break;
  }

  if (!selected || !persisted) {
    await applyNearestWorkerTranspoFee(bookingId, userLat, userLon, serviceId);
    return { assigned: false, reason: "NO_WORKER_AVAILABLE_AFTER_RECHECK" };
  }

  const best = selected;

  notifyAdminsSafely({
    type: 'booking_auto_assigned', severity: 'success', title: 'Booking auto-assigned',
    body: `Booking SVN-${String(bookingId).padStart(6, '0')} was automatically assigned to a provider.`,
    bookingId, notificationKey: `booking_auto_assigned_${bookingId}_${best.uid}`,
  });

  publishWorkerAssignment({
    bookingId,
    workerUid: best.uid,
    customerUid: persisted.customerUid,
    source: "automatic",
  });

  // Notify customer that a technician has been assigned
  try {
    const userInfo = await getUserInfoByBookingId(bookingId);
    if (userInfo) {
      const workerRes = await dbQuery.query(
        `SELECT first_name, last_name FROM ${dbSchema}.user_credentials WHERE uid = $1`,
        [best.uid]
      );
      const assignedSchedule = persisted.schedule ?? schedule;
      const workerName = workerRes.rows[0]
        ? `${workerRes.rows[0].first_name} ${workerRes.rows[0].last_name}`
        : "Your technician";
      const etaAt = persisted.etaAt
        ? new Date(persisted.etaAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
        : "";
      send(userInfo.email, "booking_worker_assigned", {
        first_name:   userInfo.firstName,
        booking_id:   bookingId,
        worker_name:  workerName,
        eta_minutes:  etaMinutes,
        eta_at:       etaAt,
        booking_date: assignedSchedule ? new Date(assignedSchedule).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }) : "",
        booking_time: assignedSchedule ? new Date(assignedSchedule).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }) : "",
      });
    }
  } catch (emailErr) {
    console.error("booking_worker_assigned email failed:", emailErr);
  }

  return {
    assigned: true,
    worker_uid: best.uid,
    etaMinutes,
    transpoFee,
    workerDistanceKm: Math.round(best.distanceKm * 100) / 100
  };
};

export const getWorkerSchedule = async (workerId: string) => {
  const res = await dbQuery.query(
    `
    SELECT
      b.id,
      b.status,
      b.schedule,
      b.user_address_id,
      COALESCE(ua.address_one, b.service_address->>'addressLine') AS address_one,
      ua.address_two,
      ua.zip_code,
      COALESCE(ua.post_town, b.service_address->>'city')          AS post_town,
      ua.country,
      b.created_at,
      p.status AS payment_status,
      bw.status AS worker_status,
      bw.assigned_at,
      bw.started_at,
      bw.completed_at
    FROM ${dbSchema}.bookings b
    LEFT JOIN LATERAL (
      SELECT p1.status
      FROM ${dbSchema}.payments p1
      WHERE p1.booking_id = b.id
      ORDER BY p1.id DESC
      LIMIT 1
    ) p ON TRUE
    LEFT JOIN ${dbSchema}.user_address ua
      ON ua.address_id = b.user_address_id
    JOIN LATERAL (
      SELECT bw1.status, bw1.assigned_at, bw1.started_at, bw1.completed_at
      FROM ${dbSchema}.booking_workers bw1
      WHERE bw1.booking_id = b.id AND bw1.worker_uid = $1
      ORDER BY bw1.assigned_at DESC NULLS LAST, bw1.id DESC
      LIMIT 1
    ) bw ON TRUE
    WHERE b.worker_uid = $1
    ORDER BY b.schedule ASC
    `,
    [workerId]
  );

  return res.rows;
};

export const getJobCardsByWorker = async (workerId: string, bookingId?: number | null) => {
  const res = await dbQuery.query(
    `
    SELECT
      b.id AS booking_id,
      b.worker_uid,
      b.status,
      b.schedule,
      p.method AS payment_method,
      p.status AS payment_status,

      -- Customer: for admin-created guest bookings user_id is NULL; LEFT JOIN
      -- still works, customer fields will be null and the mobile app must handle that.
      u.uid AS customer_id,
      u.first_name,
      u.last_name,
      u.phone_number,

      -- Address: admin-created bookings store address in service_address JSONB
      -- rather than a user_address row.  COALESCE falls back to the JSONB so the
      -- provider mobile app always receives a readable address.
      COALESCE(ua.address_one,  b.service_address->>'addressLine') AS address_one,
      ua.address_two,
      COALESCE(ua.post_town,    b.service_address->>'city')        AS post_town,
      ua.zip_code,
      ua.country,
      ua.label,
      b.service_address->>'instructions' AS delivery_instructions,

      s.level_2 AS service_name,
      s.level_3 AS service_type,

      b.pricing_breakdown,
      bw.status AS worker_status,
      bw.assigned_at,
      bw.started_at,
      bw.completed_at

    FROM ${dbSchema}.bookings b

    LEFT JOIN ${dbSchema}.user_credentials u
      ON u.uid = b.user_id

    LEFT JOIN ${dbSchema}.user_address ua
      ON ua.address_id = b.user_address_id

    LEFT JOIN ${dbSchema}.service_options s
      ON s.id = b.service_option_id

    LEFT JOIN LATERAL (
      SELECT p1.method, p1.status
      FROM ${dbSchema}.payments p1
      WHERE p1.booking_id = b.id
      ORDER BY p1.id DESC
      LIMIT 1
    ) p ON TRUE

    JOIN LATERAL (
      SELECT bw1.status, bw1.assigned_at, bw1.started_at, bw1.completed_at
      FROM ${dbSchema}.booking_workers bw1
      WHERE bw1.booking_id = b.id AND bw1.worker_uid = $1
      ORDER BY bw1.assigned_at DESC NULLS LAST, bw1.id DESC
      LIMIT 1
    ) bw ON TRUE

    WHERE b.worker_uid = $1
    AND ($2::int IS NULL OR b.id = $2)
    AND bw.status IN ('ASSIGNED','ACCEPTED','EN_ROUTE','ARRIVED','IN_PROGRESS','COMPLETED','CANCELED','CANCELLED','DECLINED')
    ORDER BY b.schedule ASC
    `,
    [workerId, bookingId ?? null]
  );

  return res.rows;
};

/**
 * Returns workers who have no active booking within a 2-hour window of the requested schedule.
 * Active statuses: PENDING_OTP, CONFIRMED, PAID, WORKER_ASSIGNED, ACCEPTED, IN_PROGRESS
 * Optionally filter by serviceId — returns only workers who offer that service.
 *
 * @param schedule   ISO datetime string, e.g. "2024-06-01T10:00:00"
 * @param serviceId  Optional service ID to filter by employee_services
 */
export const getAvailableWorkers = async (schedule: string, serviceId?: number) => {
  const requestedTime = new Date(schedule);

  if (isNaN(requestedTime.getTime())) {
    throw new Error("Invalid schedule datetime");
  }

  // Fetch workers: if serviceId provided, only those assigned to that service
  const workerQuery = serviceId
    ? `SELECT uc.uid, uc.email, uc.first_name, uc.last_name, uc.phone_number, uc.role
       FROM ${dbSchema}.user_credentials uc
       JOIN ${dbSchema}.employee_services es ON es.employee_uid = uc.uid
       WHERE es.service_id = $1 AND uc.is_archive = false`
    : `SELECT uid, email, first_name, last_name, phone_number, role
       FROM ${dbSchema}.user_credentials
       WHERE role::int = 2 AND is_archive = false`;

  const workerParams = serviceId ? [serviceId] : [];
  const { rows: allWorkers } = await dbQuery.query(workerQuery, workerParams);

  if (!allWorkers.length) return [];

  // Find workers who are busy within ±2 hours of the requested time
  const windowStart = new Date(requestedTime.getTime() - 2 * 60 * 60 * 1000); // -2h
  const windowEnd   = new Date(requestedTime.getTime() + 2 * 60 * 60 * 1000); // +2h

  const busyQuery = `
    SELECT DISTINCT b.worker_uid
    FROM ${dbSchema}.bookings b
    WHERE b.worker_uid IS NOT NULL
      AND b.schedule BETWEEN $1 AND $2
      AND b.status NOT IN ('COMPLETED','CANCELED','CANCELLED','REFUNDED','FAILED','EXPIRED')
  `;
  const { rows: busyRows } = await dbQuery.query(busyQuery, [windowStart, windowEnd]);
  const busyUids = new Set(busyRows.map((r: any) => r.worker_uid));

  return allWorkers
    .filter((w: any) => !busyUids.has(w.uid))
    .map((w: any) => ({
      uid:         w.uid,
      email:       w.email,
      firstName:   w.first_name,
      lastName:    w.last_name,
      phoneNumber: w.phone_number,
      role:        w.role,
    }));
};

export const assignWorker = async (bookingId: number, workerUid: string) => {
  // 1. Get the booking's schedule and service
  const bookingRes = await dbQuery.query(
    `
    SELECT b.id, b.schedule, b.status, so.service_id
    FROM ${dbSchema}.bookings b
    JOIN ${dbSchema}.service_options so ON so.id = b.service_option_id
    WHERE b.id = $1
    `,
    [bookingId]
  );

  if (!bookingRes.rowCount) {
    throw new Error("Booking not found");
  }

  const booking = bookingRes.rows[0];
  const schedule = new Date(booking.schedule);
  const serviceId = Number(booking.service_id);

  // 2. Validate the worker is qualified for this service
  const eligibilityRes = await dbQuery.query(
    `
    SELECT 1
    FROM ${dbSchema}.employee_services
    WHERE employee_uid = $1 AND service_id = $2
    LIMIT 1
    `,
    [workerUid, serviceId]
  );

  const approvedApplicationUids = eligibilityRes.rowCount
    ? []
    : await getAutoBookableProviderUids(serviceId);
  if (!eligibilityRes.rowCount && !approvedApplicationUids.includes(workerUid)) {
    // Fetch service name for a helpful error message
    const svcRes = await dbQuery.query(
      `SELECT name FROM ${dbSchema}.services WHERE id = $1`,
      [serviceId]
    );
    const serviceName = svcRes.rows[0]?.name || `service #${serviceId}`;
    throw new Error(
      `Worker is not qualified for "${serviceName}". ` +
      `Assign the service to this worker first via POST /workers/:uid/services.`
    );
  }

  // 3. Check if the worker already has a conflicting booking within ±2h
  const availability = await filterUidsAvailableAt(
    [workerUid],
    schedule.toISOString(),
    new Date(schedule.getTime() + 60 * 60 * 1000).toISOString(),
    { missingScheduleIsAvailable: true },
  );
  if (!availability.eligible.includes(workerUid)) {
    throw new Error(
      `Worker is not available at ${schedule.toLocaleString("en-US", { month: "long", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" })}. ` +
      `Their saved schedule or time off excludes this booking.`
    );
  }

  const persisted = await persistWorkerAssignment({
    bookingId,
    workerUid,
    note: "Worker manually assigned",
  });
  if (persisted.kind === "busy") {
    throw new Error(
      `Worker is not available at ${schedule.toLocaleString("en-US", { month: "long", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" })}. ` +
      `They have an existing booking within a 2-hour window.`
    );
  }

  if (persisted.kind === "created") {
    publishWorkerAssignment({
      bookingId,
      workerUid,
      customerUid: persisted.customerUid,
      source: "manual",
    });
  }

  return persisted.kind === "existing"
    ? { booking_id: bookingId, worker_uid: workerUid, status: "ASSIGNED", idempotent: true }
    : persisted.assignment;
};

export const getJobCardByWorker = async (workerId: string, bookingId: number) => {
  const rows = await getJobCardsByWorker(workerId, bookingId);
  return rows[0] ?? null;
};

export const acceptJob = async (bookingId: number, workerUid: string) => {
  // accepted_at is added by this lazy DDL; the UPDATE below writes it.
  await ensureArrivalColumns();

  const client = await pool.connect();
  let accepted: any;
  let customerUid: string | null = null;
  try {
    await client.query("BEGIN");

    // Lock the booking first so cancellation/reassignment cannot cross the
    // acceptance boundary between validation and the assignment CAS.
    const bookingRes = await client.query(
      `SELECT id, status, worker_uid, user_id
       FROM ${dbSchema}.bookings
       WHERE id = $1
       FOR UPDATE`,
      [bookingId],
    );
    const booking = bookingRes.rows[0] ?? null;

    const assignmentRes = await client.query(
      `SELECT id, status
       FROM ${dbSchema}.booking_workers
       WHERE booking_id = $1 AND worker_uid = $2
       ORDER BY assigned_at DESC NULLS LAST, id DESC
       LIMIT 1
       FOR UPDATE`,
      [bookingId, workerUid],
    );
    const assignment = assignmentRes.rows[0] ?? null;

    const conflict = acceptanceConflictForSnapshot({
      bookingStatus: booking?.status ?? null,
      bookingWorkerUid: booking?.worker_uid ?? null,
      assignmentStatus: assignment?.status ?? null,
      workerUid,
    });
    if (conflict) throw conflict;

    const updateRes = await client.query(
      `UPDATE ${dbSchema}.booking_workers
       SET status = 'ACCEPTED', accepted_at = NOW()
       WHERE id = $1 AND status = 'ASSIGNED'
       RETURNING *`,
      [assignment.id],
    );
    if (!updateRes.rowCount) {
      throw new Error("Booking acceptance changed concurrently");
    }

    await client.query(
      `INSERT INTO ${dbSchema}.booking_tracking (booking_id, status, note)
       VALUES ($1, 'ACCEPTED', 'Provider accepted the booking')`,
      [bookingId],
    );

    accepted = updateRes.rows[0];
    customerUid = booking.user_id ?? null;
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  notifyAdminsSafely({
    type: 'provider_accepted', severity: 'success', title: 'Provider accepted booking',
    body: `The auto-assigned provider accepted booking SVN-${String(bookingId).padStart(6, '0')}.`,
    bookingId, notificationKey: `provider_accepted_${bookingId}_${workerUid}`,
  });

  if (customerUid) {
    createCustomerNotification(customerUid, {
      notificationKey: `booking_accepted_${bookingId}`,
      type: "booking_accepted",
      severity: "success",
      title: "Provider confirmed",
      safeBody: "Your provider accepted the booking and will arrive as scheduled.",
      safeContextLabel: `SVN-${String(bookingId).padStart(6, "0")}`,
      route: { routeKey: "BOOKING_DETAILS", resourceId: String(bookingId) },
      canOpenDetail: true,
    }).catch((e) => console.error("createCustomerNotification (acceptJob):", e));
  }

  emitToProvider(workerUid, "booking:updated", {
    bookingId: String(bookingId),
    status: "ACCEPTED",
    acceptedAt: accepted.accepted_at ?? null,
    occurredAt: new Date().toISOString(),
  });

  // Notify customer that the technician has accepted and is on the way
  try {
    const userInfo = await getUserInfoByBookingId(bookingId);
    if (userInfo) {
      const bookingRes = await dbQuery.query(
        `SELECT schedule FROM ${dbSchema}.bookings WHERE id = $1`,
        [bookingId]
      );
      const workerRes = await dbQuery.query(
        `SELECT first_name, last_name FROM ${dbSchema}.user_credentials WHERE uid = $1`,
        [workerUid]
      );
      const schedule = bookingRes.rows[0]?.schedule;
      const workerName = workerRes.rows[0]
        ? `${workerRes.rows[0].first_name} ${workerRes.rows[0].last_name}`
        : "Your technician";
      send(userInfo.email, "booking_accepted", {
        first_name:   userInfo.firstName,
        booking_id:   bookingId,
        worker_name:  workerName,
        booking_date: schedule ? new Date(schedule).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }) : "",
        booking_time: schedule ? new Date(schedule).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }) : "",
        address:      "",
      });
    }
  } catch (emailErr) {
    console.error("booking_accepted email failed:", emailErr);
  }

  // AUTO GROUP CHAT: create (or find) the canonical booking conversation and
  // post an idempotent system message. Fire-and-forget — never blocks job acceptance.
  (async () => {
    try {
      const conv = await getOrCreateConversation(bookingId);
      await postSystemMessageOnce(
        conv.id,
        `provider_accepted_${bookingId}`,
        'Your service provider has accepted the booking. You can now message them here.',
        { bookingId, providerUid: workerUid, eventType: 'provider_accepted' }
      );
    } catch (chatErr) {
      console.error('auto group-chat creation failed (acceptJob):', chatErr);
    }
  })();

  return { ...accepted, effectiveStatus: "ACCEPTED", idempotent: false };
};

/**
 * Releases a booking back to the pool and finds the next nearest provider.
 *
 * Extracted from declineJob so provider CANCELLATION reuses exactly the same
 * path (C18 §26 requires cancellation to auto-reassign, like decline). One
 * implementation means the two can never drift into reassigning differently.
 *
 * `trackingNote` and the system-message text differ between the two because a
 * decline and a post-acceptance cancellation are different events to a
 * customer reading their booking history.
 */
/**
 * Provider cancels a booking they already accepted (C18 §26).
 *
 * Operator policy, recorded not inferred: allowed up to 48 hours before the
 * scheduled start, RECORD ONLY (no penalty, no fee, no rating impact), and it
 * auto-reassigns exactly like a decline while notifying admin.
 *
 * The 48-hour check happens in the CONTROLLER against server time before this
 * runs; the compare-and-swap here is what makes it safe against a double tap,
 * mirroring acceptJob/declineJob.
 */
export const cancelAcceptedJob = async (
  bookingId: number,
  workerUid: string,
  reasonCode: string,
  note?: string | null
) => {
  await ensureArrivalColumns();
  await ensureCancellationColumns();

  const res = await dbQuery.query(
    `
    UPDATE ${dbSchema}.booking_workers
    SET status = 'CANCELLED',
        cancelled_at = NOW(),
        cancellation_reason_code = $3,
        cancellation_note = $4
    WHERE booking_id = $1
      AND worker_uid = $2
      AND status IN ('ACCEPTED','EN_ROUTE','ARRIVED')
    RETURNING *
    `,
    [bookingId, workerUid, reasonCode, note ?? null]
  );

  if (!res.rowCount) {
    // Same classification the response path uses, so a double tap reads as
    // "already done" rather than a server error.
    throw await classifyResponseMiss(bookingId, workerUid, "DECLINE");
  }

  const reassignment = await releaseBookingAndReassign(
    bookingId,
    workerUid,
    "Provider cancelled — seeking reassignment",
    "provider_cancelled",
    "The assigned provider can no longer attend this booking. We are finding a new provider for you."
  );

  // §26 requires admin notification. Fire-and-forget: a notification failure
  // must not roll back a cancellation the provider has already been told about.
  createNotification(workerUid, {
    type: "booking_cancelled_by_you",
    severity: "info",
    title: "Booking cancelled",
    safeBody: `You cancelled booking SVN-${String(bookingId).padStart(6, "0")}. We are finding a replacement provider.`,
    safeContextLabel: `SVN-${String(bookingId).padStart(6, "0")}`,
    canOpenDetail: false,
  }).catch((e: any) => console.error("cancellation notification failed:", e?.message));

  return { cancelled: true, bookingId, workerUid, reasonCode, reassignment };
};

let cancellationColumnsReady: Promise<void> | null = null;

/** Lazily adds the cancellation record columns, like the arrival ones. */
const ensureCancellationColumns = (): Promise<void> => {
  cancellationColumnsReady ??= dbQuery
    .query(
      `ALTER TABLE ${dbSchema}.booking_workers
         ADD COLUMN IF NOT EXISTS cancelled_at             TIMESTAMPTZ,
         ADD COLUMN IF NOT EXISTS cancellation_reason_code VARCHAR(60),
         ADD COLUMN IF NOT EXISTS cancellation_note        TEXT`,
      []
    )
    .then(() => undefined)
    .catch((e: any) => {
      cancellationColumnsReady = null;
      throw e;
    });
  return cancellationColumnsReady;
};

export const releaseBookingAndReassign = async (
  bookingId: number,
  workerUid: string,
  trackingNote: string,
  eventKind: "provider_declined" | "provider_cancelled",
  customerMessage: string
) => {
  // 2. Get booking details needed for re-assignment
  const bookingRes = await dbQuery.query(
    `
    SELECT
      b.schedule,
      b.user_address_id,
      b.service_address,
      ua.location_id,
      so.service_id
    FROM ${dbSchema}.bookings b
    JOIN ${dbSchema}.service_options so ON so.id = b.service_option_id
    LEFT JOIN ${dbSchema}.user_address ua ON ua.address_id = b.user_address_id
    WHERE b.id = $1
    `,
    [bookingId]
  );

  if (!bookingRes.rowCount) throw new Error("Booking not found");

  const row = bookingRes.rows[0];

  // 3. Reset booking to CONFIRMED and clear the worker
  await dbQuery.query(
    `
    UPDATE ${dbSchema}.bookings
    SET worker_uid  = NULL,
        status      = 'CONFIRMED',
        eta_minutes = NULL,
        eta_at      = NULL,
        worker_code = NULL
    WHERE id = $1
    `,
    [bookingId]
  );

  await dbQuery.query(
    `
    INSERT INTO ${dbSchema}.booking_tracking (booking_id, status, note)
    VALUES ($1, 'CONFIRMED', $2)
    `,
    [bookingId, trackingNote]
  );

  // 4. Attempt to find the next nearest qualified worker
  let reassignment: any = { assigned: false, reason: "NO_LOCATION" };

  if (row.location_id) {
    const { getLatLonByLocationId } = await import("./address.service");
    const [lon, lat] = await getLatLonByLocationId(String(row.location_id));
    reassignment = await assignNearestWorker(
      bookingId,
      Number(lat),
      Number(lon),
      row.service_id ? Number(row.service_id) : null
    );
  } else if (row.service_address && row.service_address.lat && row.service_address.lon) {
    // Admin-created booking: no location_id, fall back to JSONB lat/lon
    reassignment = await assignNearestWorker(
      bookingId,
      Number(row.service_address.lat),
      Number(row.service_address.lon),
      row.service_id ? Number(row.service_id) : null
    );
  }

  // Post a system message (non-blocking, non-creating — only if chat already open)
  (async () => {
    try {
      const existing = await findExistingConversationByBookingId(bookingId);
      if (existing) {
        await postSystemMessageOnce(
          existing.id,
          `${eventKind}_${bookingId}_${workerUid}`,
          customerMessage,
          { bookingId, providerUid: workerUid, eventType: eventKind }
        );
      }
    } catch (chatErr) {
      console.error('system message failed (declineJob):', chatErr);
    }
  })();

  return reassignment;
};

export const declineJob = async (bookingId: number, workerUid: string) => {
  await ensureArrivalColumns();

  // 1. Mark the booking_workers row as DECLINED (only if currently ASSIGNED)
  const declineRes = await dbQuery.query(
    `
    UPDATE ${dbSchema}.booking_workers
    SET status = 'DECLINED',
        declined_at = NOW()
    WHERE booking_id = $1
      AND worker_uid = $2
      AND status = 'ASSIGNED'
    RETURNING *
    `,
    [bookingId, workerUid]
  );

  if (!declineRes.rowCount) {
    throw await classifyResponseMiss(bookingId, workerUid, "DECLINE");
  }

  const reassignment = await releaseBookingAndReassign(
    bookingId,
    workerUid,
    "Worker declined — seeking reassignment",
    "provider_declined",
    "The assigned provider was unable to accept this booking. We are finding a new provider for you."
  );

  notifyAdminsSafely({
    type: 'provider_declined', severity: 'warning', title: 'Provider declined booking',
    body: reassignment?.assigned
      ? `A provider declined booking SVN-${String(bookingId).padStart(6, '0')}; another provider was auto-assigned.`
      : `A provider declined booking SVN-${String(bookingId).padStart(6, '0')}. Please assign a provider.`,
    bookingId, notificationKey: `provider_declined_${bookingId}_${workerUid}`,
  });

  return {
    declined: true,
    bookingId,
    workerUid,
    reassignment,
  };
};

/**
 * ACCEPTED -> EN_ROUTE, and EN_ROUTE -> ARRIVED.
 *
 * These two stages did not exist. `EN_ROUTE` and `ARRIVED` were read in
 * `serviceService.ts:125` and mapped by both mobile apps, but nothing anywhere
 * ever wrote them — the customer app even branches on them in three places
 * (booking_action_resolver, bookings_screen, booking_detail_screen), so it was
 * carrying UI for a journey stage the platform could not express. A customer
 * watching the tracking screen saw the provider accept and then nothing until
 * work started.
 *
 * Written to `booking_workers.status`, because that is where provider state
 * lives (SERVANA_PROVIDER_STATUS_MATRIX.md), and cascaded to `bookings.status`
 * so the customer's booking view can show it — the same shape `completeJob`
 * already uses for COMPLETED.
 *
 * Guarded like every other transition: the UPDATE carries the expected current
 * status, so an out-of-order call changes nothing rather than corrupting state,
 * and a duplicate tap is a no-op instead of a second event. That makes these
 * idempotent in effect, which is the standard the rest of the lifecycle meets.
 *
 * Both stages remain OPTIONAL. `startJob` still accepts a booking sitting at
 * ACCEPTED, so a provider who never taps "on my way" can still start the job and
 * an older app build keeps working unchanged.
 */
/**
 * Adds the two arrival timestamp columns.
 *
 * Additive and nullable, so every existing row and every shipped client is
 * unaffected — a build that has never heard of these stages reads the same
 * fields it always did.
 */
let arrivalColumnsReady: Promise<void> | null = null;

/**
 * Lazily adds the optional lifecycle timestamp columns.
 *
 * Named for arrival historically; it now also covers accepted_at/declined_at,
 * so EVERY writer of those columns must await it first. acceptJob and
 * declineJob do — without that, the first accept after deploy would fail on a
 * column that does not exist yet.
 */
const ensureArrivalColumns = (): Promise<void> => {
  // Memoised: this runs on the first arrival transition rather than at boot, so
  // it must not issue a DDL statement on every tap.
  arrivalColumnsReady ??= dbQuery
    .query(
      `ALTER TABLE ${dbSchema}.booking_workers
         ADD COLUMN IF NOT EXISTS en_route_at TIMESTAMPTZ,
         ADD COLUMN IF NOT EXISTS arrived_at  TIMESTAMPTZ,
         ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ,
         ADD COLUMN IF NOT EXISTS declined_at TIMESTAMPTZ`,
      []
    )
    .then(() => undefined)
    .catch((e: any) => {
      // Reset so a transient failure can be retried rather than poisoning the
      // process for its lifetime.
      arrivalColumnsReady = null;
      throw e;
    });
  return arrivalColumnsReady;
};

const advanceArrivalStage = async (
  bookingId: number,
  workerUid: string,
  from: string,
  to: string,
  timestampColumn: string,
  trackingNote: string
) => {
  await ensureArrivalColumns();

  const res = await dbQuery.query(
    `
    UPDATE ${dbSchema}.booking_workers
    SET status = $4,
        ${timestampColumn} = NOW()
    WHERE booking_id = $1
      AND worker_uid = $2
      AND status = $3
    RETURNING *
    `,
    [bookingId, workerUid, from, to]
  );

  if (!res.rowCount) {
    throw new Error(`Job cannot move to ${to}`);
  }

  // Cascade so the customer's booking view reflects it. Scoped to this worker's
  // booking and to the statuses this transition can legally follow, so a
  // concurrent admin action cannot be clobbered.
  await dbQuery.query(
    `UPDATE ${dbSchema}.bookings
     SET status = $2
     WHERE id = $1 AND worker_uid = $3`,
    [bookingId, to, workerUid]
  );

  // Customer-facing timeline. booking_tracking previously carried only four
  // event kinds and nothing between assignment and completion.
  try {
    await dbQuery.query(
      `INSERT INTO ${dbSchema}.booking_tracking (booking_id, status, note)
       VALUES ($1, $2, $3)`,
      [bookingId, to, trackingNote]
    );
  } catch (e: any) {
    // A timeline row is not worth failing the transition over — the state
    // change is already committed and is the thing that matters.
    console.warn(`[arrival] tracking insert failed for booking ${bookingId}: ${e.message}`);
  }

  return res.rows[0];
};

/** The provider is travelling to the customer. */
export const markEnRoute = (bookingId: number, workerUid: string) =>
  advanceArrivalStage(
    bookingId,
    workerUid,
    "ACCEPTED",
    "EN_ROUTE",
    "en_route_at",
    "Provider is on the way"
  );

/** The provider has reached the address and has not yet started work. */
export const markArrived = (bookingId: number, workerUid: string) =>
  advanceArrivalStage(
    bookingId,
    workerUid,
    "EN_ROUTE",
    "ARRIVED",
    "arrived_at",
    "Provider has arrived"
  );

export const startJob = async (
  bookingId: number,
  workerUid: string,
  workerCode?: string
) => {
  if (!workerCode) {
    throw new Error("worker_code is required to start job");
  }

  const res = await dbQuery.query(
    `
    UPDATE ${dbSchema}.booking_workers bw
    SET status = 'IN_PROGRESS',
        started_at = NOW()
    FROM ${dbSchema}.bookings b
    WHERE bw.booking_id = $1
      AND bw.worker_uid = $2
      -- ACCEPTED plus the two optional arrival stages. Requiring ACCEPTED
      -- alone would mean a provider who tapped "on my way" could never start
      -- the job — the arrival stages advance the status, so demanding the
      -- pre-arrival value would strand them one tap from the work.
      AND bw.status IN ('ACCEPTED', 'EN_ROUTE', 'ARRIVED')
      AND bw.booking_id = b.id
      AND b.worker_code = $3
    RETURNING bw.*
    `,
    [bookingId, workerUid, workerCode]
  );

  if (!res.rowCount) {
    throw new Error("Job cannot be started");
  }

  // Notify customer that the service has begun
  try {
    const userInfo = await getUserInfoByBookingId(bookingId);
    if (userInfo) {
      const workerRes = await dbQuery.query(
        `SELECT first_name, last_name FROM ${dbSchema}.user_credentials WHERE uid = $1`,
        [workerUid]
      );
      const bookingRes = await dbQuery.query(
        `SELECT so.level_2 AS service_name FROM ${dbSchema}.bookings b JOIN ${dbSchema}.service_options so ON so.id = b.service_option_id WHERE b.id = $1`,
        [bookingId]
      );
      send(userInfo.email, "booking_started", {
        first_name:   userInfo.firstName,
        booking_id:   bookingId,
        worker_name:  workerRes.rows[0] ? `${workerRes.rows[0].first_name} ${workerRes.rows[0].last_name}` : "Your technician",
        service_name: bookingRes.rows[0]?.service_name || "Home Service",
        started_at:   new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
      });
    }
  } catch (emailErr) {
    console.error("booking_started email failed:", emailErr);
  }

  // System message: service started
  (async () => {
    try {
      const existing = await findExistingConversationByBookingId(bookingId);
      if (existing) {
        await postSystemMessageOnce(
          existing.id,
          `service_started_${bookingId}`,
          'Your service provider is on the way. Service has started.',
          { bookingId, providerUid: workerUid, eventType: 'service_started' }
        );
      }
    } catch (chatErr) {
      console.error('system message failed (startJob):', chatErr);
    }
  })();

  return res.rows[0];
};

export class UnpaidCashBookingError extends Error {
  readonly code = "CASH_PAYMENT_REQUIRED";

  constructor() {
    super("Record the customer's cash payment before completing this job");
    this.name = "UnpaidCashBookingError";
  }
}

export const completeJob = async (bookingId: number, workerUid: string) => {
  const res = await dbQuery.query(
    `
    UPDATE ${dbSchema}.booking_workers bw
    SET status = 'COMPLETED',
        completed_at = NOW()
    WHERE bw.booking_id = $1
    AND bw.worker_uid = $2
    AND bw.status = 'IN_PROGRESS'
    AND EXISTS (
      SELECT 1
      FROM ${dbSchema}.payments p
      WHERE p.booking_id = bw.booking_id
        AND (UPPER(COALESCE(p.method, '')) <> 'CASH' OR UPPER(COALESCE(p.status, '')) = 'PAID')
    )
    RETURNING bw.*
    `,
    [bookingId, workerUid]
  );

  if (!res.rowCount) {
    const payment = await dbQuery.query(
      `SELECT method, status FROM ${dbSchema}.payments WHERE booking_id = $1`,
      [bookingId]
    );
    const row = payment.rows[0];
    if (
      String(row?.method ?? '').toUpperCase() === 'CASH' &&
      String(row?.status ?? '').toUpperCase() !== 'PAID'
    ) {
      throw new UnpaidCashBookingError();
    }
    throw new Error("Job cannot be completed");
  }

  // Mark the parent booking as COMPLETED and queue the 72-h disbursement
  await dbQuery.query(
    `UPDATE ${dbSchema}.bookings SET status = 'COMPLETED' WHERE id = $1`,
    [bookingId]
  );

  try { await createDisbursement(bookingId); }
  catch (e) { console.error("createDisbursement failed (completeJob):", e); }

  // Notify customer that the service has been completed
  try {
    const userInfo = await getUserInfoByBookingId(bookingId);
    if (userInfo) {
      const detailsRes = await dbQuery.query(
        `
        SELECT
          b.final_price,
          b.schedule,
          so.level_2 AS service_name,
          uc.first_name || ' ' || uc.last_name AS worker_name
        FROM ${dbSchema}.bookings b
        JOIN ${dbSchema}.service_options so ON so.id = b.service_option_id
        JOIN ${dbSchema}.user_credentials uc ON uc.uid = b.worker_uid
        WHERE b.id = $1
        `,
        [bookingId]
      );
      const d = detailsRes.rows[0] || {};
      send(userInfo.email, "booking_completed", {
        first_name:   userInfo.firstName,
        booking_id:   bookingId,
        worker_name:  d.worker_name || "Your technician",
        service_name: d.service_name || "Home Service",
        final_price:  d.final_price || "0.00",
        booking_date: d.schedule ? new Date(d.schedule).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }) : "",
        completed_at: new Date().toLocaleString("en-US", { month: "long", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" }),
        // review_url:   `${process.env.APP_URL}/review?bookingId=${bookingId}`,
      });
    }
  } catch (emailErr) {
    console.error("booking_completed email failed:", emailErr);
  }

  // System message: service completed
  (async () => {
    try {
      const existing = await findExistingConversationByBookingId(bookingId);
      if (existing) {
        await postSystemMessageOnce(
          existing.id,
          `service_completed_${bookingId}`,
          'Service has been completed. Thank you for using Servana! This chat will remain available for 48 hours.',
          { bookingId, providerUid: workerUid, eventType: 'service_completed' }
        );
      }
    } catch (chatErr) {
      console.error('system message failed (completeJob):', chatErr);
    }
  })();

  return res.rows[0];
};

// ---------------------------------------------------------------------------
// Employee ↔ Services
// ---------------------------------------------------------------------------

let _esColumnsReady: Promise<void> | null = null;

const ensureEmployeeServicesColumns = (): Promise<void> => {
  if (_esColumnsReady) return _esColumnsReady;
  _esColumnsReady = (async () => {
    await dbQuery.query(`ALTER TABLE ${dbSchema}.employee_services ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'`);
    await dbQuery.query(`ALTER TABLE ${dbSchema}.employee_services ADD COLUMN IF NOT EXISTS pause_reason TEXT`);
    await dbQuery.query(`ALTER TABLE ${dbSchema}.employee_services ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
    await dbQuery.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'employee_services_status_check'
        ) THEN
          ALTER TABLE ${dbSchema}.employee_services
          ADD CONSTRAINT employee_services_status_check
          CHECK (status IN ('active', 'paused'));
        END IF;
      END $$
    `);
  })().catch((err) => { _esColumnsReady = null; throw err; });
  return _esColumnsReady;
};

export const assignServicesToEmployee = async (employeeUid: string, serviceIds: number[]) => {
  if (!serviceIds.length) throw new Error("serviceIds must not be empty");

  const values = serviceIds
    .map((_, i) => `($1, $${i + 2})`)
    .join(", ");

  const res = await dbQuery.query(
    `
    INSERT INTO ${dbSchema}.employee_services (employee_uid, service_id)
    VALUES ${values}
    ON CONFLICT (employee_uid, service_id) DO NOTHING
    RETURNING *
    `,
    [employeeUid, ...serviceIds]
  );

  return res.rows;
};

export const removeServiceFromEmployee = async (employeeUid: string, serviceId: number) => {
  const res = await dbQuery.query(
    `
    DELETE FROM ${dbSchema}.employee_services
    WHERE employee_uid = $1 AND service_id = $2
    RETURNING *
    `,
    [employeeUid, serviceId]
  );

  if (!res.rowCount) throw new Error("Service not found for this employee");

  return res.rows[0];
};

export const getServicesByEmployee = async (employeeUid: string) => {
  await ensureEmployeeServicesColumns();
  const res = await dbQuery.query(
    `
    SELECT s.id, s.name, s.category, es.created_at AS assigned_at,
           COALESCE(es.status, 'active') AS status, es.pause_reason
    FROM ${dbSchema}.employee_services es
    JOIN ${dbSchema}.services s ON s.id = es.service_id
    WHERE es.employee_uid = $1
    ORDER BY s.name
    `,
    [employeeUid]
  );

  return res.rows;
};

export const pauseService = async (workerUid: string, serviceId: number, reason?: string) => {
  await ensureEmployeeServicesColumns();
  const res = await dbQuery.query(
    `UPDATE ${dbSchema}.employee_services
     SET status = 'paused', pause_reason = $3, updated_at = NOW()
     WHERE employee_uid = $1 AND service_id = $2 AND COALESCE(status, 'active') = 'active'
     RETURNING *`,
    [workerUid, serviceId, reason ?? null],
  );
  if (res.rowCount) return res.rows[0];

  const check = await dbQuery.query(
    `SELECT COALESCE(status, 'active') AS status FROM ${dbSchema}.employee_services
     WHERE employee_uid = $1 AND service_id = $2 LIMIT 1`,
    [workerUid, serviceId],
  );
  if (!check.rowCount) {
    const err: any = new Error('Service not assigned to this worker.');
    err.code = 'SERVICE_NOT_FOUND'; err.statusCode = 404; throw err;
  }
  const err: any = new Error('Service is already paused.');
  err.code = 'SERVICE_ALREADY_PAUSED'; err.statusCode = 409; throw err;
};

export const reactivateService = async (workerUid: string, serviceId: number) => {
  await ensureEmployeeServicesColumns();
  const res = await dbQuery.query(
    `UPDATE ${dbSchema}.employee_services
     SET status = 'active', pause_reason = NULL, updated_at = NOW()
     WHERE employee_uid = $1 AND service_id = $2 AND COALESCE(status, 'active') = 'paused'
     RETURNING *`,
    [workerUid, serviceId],
  );
  if (res.rowCount) return res.rows[0];

  const check = await dbQuery.query(
    `SELECT COALESCE(status, 'active') AS status FROM ${dbSchema}.employee_services
     WHERE employee_uid = $1 AND service_id = $2 LIMIT 1`,
    [workerUid, serviceId],
  );
  if (!check.rowCount) {
    const err: any = new Error('Service not assigned to this worker.');
    err.code = 'SERVICE_NOT_FOUND'; err.statusCode = 404; throw err;
  }
  const err: any = new Error('Service is not paused.');
  err.code = 'SERVICE_NOT_PAUSED'; err.statusCode = 409; throw err;
};

export const getWorkersByService = async (serviceId: number) => {
  const res = await dbQuery.query(
    `
    SELECT
      uc.uid,
      uc.email,
      uc.first_name,
      uc.last_name,
      uc.phone_number,
      uc.role,
      es.created_at AS assigned_at
    FROM ${dbSchema}.employee_services es
    JOIN ${dbSchema}.user_credentials uc ON uc.uid = es.employee_uid
    WHERE es.service_id = $1 AND uc.role::int = 2 AND uc.is_archive = false
    ORDER BY uc.first_name, uc.last_name
    `,
    [serviceId]
  );

  return res.rows;
};

// ---------------------------------------------------------------------------
// Worker Bank Account CRUD
// ---------------------------------------------------------------------------

const ensureWorkerBankAccountsTable = async () => {
  await dbQuery.query(
    `CREATE TABLE IF NOT EXISTS ${dbSchema}.worker_bank_accounts (
       worker_uid     TEXT PRIMARY KEY,
       bank_code      TEXT NOT NULL,
       account_number TEXT NOT NULL,
       account_name   TEXT NOT NULL,
       updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    []
  );
};

export const upsertWorkerBankAccount = async (
  workerUid: string,
  payload: { bankCode: string; accountNumber: string; accountName: string }
) => {
  await ensureWorkerBankAccountsTable();
  const res = await dbQuery.query(
    `
    INSERT INTO ${dbSchema}.worker_bank_accounts
      (worker_uid, bank_code, account_number, account_name)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (worker_uid) DO UPDATE
      SET bank_code      = EXCLUDED.bank_code,
          account_number = EXCLUDED.account_number,
          account_name   = EXCLUDED.account_name,
          updated_at     = NOW()
    RETURNING *
    `,
    [workerUid, payload.bankCode, payload.accountNumber, payload.accountName]
  );

  return res.rows[0];
};

export const getWorkerBankAccount = async (workerUid: string) => {
  await ensureWorkerBankAccountsTable();
  const res = await dbQuery.query(
    `SELECT * FROM ${dbSchema}.worker_bank_accounts WHERE worker_uid = $1`,
    [workerUid]
  );

  return res.rows[0] || null;
};

export const deleteWorkerBankAccount = async (workerUid: string) => {
  await ensureWorkerBankAccountsTable();
  const res = await dbQuery.query(
    `DELETE FROM ${dbSchema}.worker_bank_accounts WHERE worker_uid = $1 RETURNING *`,
    [workerUid]
  );

  if (!res.rowCount) throw new Error("No bank account found for this worker");

  return res.rows[0];
};

// ---------------------------------------------------------------------------
// Worker History & Earnings
// ---------------------------------------------------------------------------

export const getWorkerBookingHistory = async (workerUid: string) => {
  const res = await dbQuery.query(
    `
    SELECT
      b.id,
      b.schedule,
      b.status            AS booking_status,
      b.final_price,
      b.payment_method,
      so.level_2          AS service_name,
      so.level_3          AS service_variant,
      bw.status           AS worker_status,
      bw.assigned_at,
      bw.started_at,
      bw.completed_at,
      COALESCE(
        NULLIF(TRIM(COALESCE(uc.first_name,'') || ' ' || COALESCE(uc.last_name,'')), ''),
        TRIM(COALESCE(gc.first_name,'') || ' ' || COALESCE(gc.last_name,''))
      )                   AS customer_name,
      p.status            AS payment_status,
      p.method            AS payment_provider,
      p.paid_at
    FROM ${dbSchema}.booking_workers bw
    JOIN ${dbSchema}.bookings b
      ON b.id = bw.booking_id
    JOIN ${dbSchema}.service_options so
      ON so.id = b.service_option_id
    LEFT JOIN ${dbSchema}.user_credentials uc
      ON uc.uid = b.user_id
    LEFT JOIN ${dbSchema}.guest_customers gc
      ON gc.guest_customer_id = b.guest_customer_id
    LEFT JOIN ${dbSchema}.payments p
      ON p.booking_id = b.id AND p.additional_request_id IS NULL
    WHERE bw.worker_uid = $1
    ORDER BY b.schedule DESC
    `,
    [workerUid]
  );

  return res.rows;
};

export const getWorkerDisbursementHistory = async (workerUid: string) => {
  const res = await dbQuery.query(
    `
    SELECT
      d.id,
      d.booking_id,
      d.total_amount,
      d.servana_share,
      d.worker_share,
      d.status,
      d.paymongo_payout_id,
      d.payout_error,
      d.released_at,
      d.created_at,
      so.level_2          AS service_name,
      b.schedule,
      bw.completed_at,
      bw.completed_at + INTERVAL '72 hours' AS release_after
    FROM ${dbSchema}.disbursements d
    JOIN ${dbSchema}.bookings b
      ON b.id = d.booking_id
    JOIN ${dbSchema}.service_options so
      ON so.id = b.service_option_id
    LEFT JOIN ${dbSchema}.booking_workers bw
      ON bw.booking_id = d.booking_id
     AND bw.worker_uid  = d.worker_uid
     AND bw.status      = 'COMPLETED'
    WHERE d.worker_uid = $1
    ORDER BY d.created_at DESC
    `,
    [workerUid]
  );

  return res.rows;
};

export const getWorkerEarningsHistory = async (workerUid: string) => {
  const [summaryRes, monthlyRes] = await Promise.all([
    dbQuery.query(
      `
      SELECT
        COUNT(*)                                                                      AS total_jobs,
        COALESCE(SUM(worker_share), 0)                                                AS total_gross,
        COALESCE(SUM(CASE WHEN status = 'RELEASED' THEN worker_share ELSE 0 END), 0) AS total_released,
        COALESCE(SUM(CASE WHEN status = 'PENDING'  THEN worker_share ELSE 0 END), 0) AS total_pending,
        COALESCE(SUM(CASE WHEN status = 'FAILED'   THEN worker_share ELSE 0 END), 0) AS total_failed,
        COALESCE(SUM(total_amount), 0)                                                AS total_collected,
        COALESCE(SUM(servana_share), 0)                                               AS total_servana_cut
      FROM ${dbSchema}.disbursements
      WHERE worker_uid = $1
      `,
      [workerUid]
    ),
    dbQuery.query(
      `
      SELECT
        TO_CHAR(DATE_TRUNC('month', bw.completed_at), 'YYYY-MM')   AS month,
        COUNT(d.id)                                                  AS jobs,
        COALESCE(SUM(d.total_amount), 0)                             AS total_collected,
        COALESCE(SUM(d.servana_share), 0)                            AS servana_deduction,
        COALESCE(SUM(d.worker_share), 0)                             AS gross_earnings,
        COALESCE(SUM(CASE WHEN d.status = 'RELEASED' THEN d.worker_share ELSE 0 END), 0) AS released,
        COALESCE(SUM(CASE WHEN d.status = 'PENDING'  THEN d.worker_share ELSE 0 END), 0) AS pending,
        COALESCE(SUM(CASE WHEN d.status = 'FAILED'   THEN d.worker_share ELSE 0 END), 0) AS failed
      FROM ${dbSchema}.disbursements d
      JOIN ${dbSchema}.booking_workers bw
        ON bw.booking_id = d.booking_id
       AND bw.worker_uid = d.worker_uid
       AND bw.status     = 'COMPLETED'
      WHERE d.worker_uid = $1
      GROUP BY DATE_TRUNC('month', bw.completed_at)
      ORDER BY DATE_TRUNC('month', bw.completed_at) DESC
      `,
      [workerUid]
    ),
  ]);

  return {
    summary: summaryRes.rows[0],
    monthly: monthlyRes.rows,
  };
};

// ---------------------------------------------------------------------------
// Worker Online Status (MongoDB)
// ---------------------------------------------------------------------------

export const getWorkerOnlineStatus = async (uid: string) => {
  const collection = (await mongoDb).collection("worker_locations");
  const doc = await collection.findOne(
    { uid },
    { projection: { uid: 1, is_online: 1, updatedAt: 1 } }
  );
  return {
    status: doc?.is_online ? "online" : "offline",
    updatedAt: (doc?.updatedAt as Date | undefined)?.toISOString() ?? null,
  };
};

export const setWorkerOnlineStatus = async (uid: string, isOnline: boolean) => {
  const collection = (await mongoDb).collection("worker_locations");
  await collection.updateOne(
    { uid },
    { $set: { is_online: isOnline, updatedAt: new Date() } },
    { upsert: true }
  );
  return { status: isOnline ? "online" : "offline" };
};

// ---------------------------------------------------------------------------
// Worker Availability (PostgreSQL)
// ---------------------------------------------------------------------------

const ensureAvailabilityTable = async () => {
  await dbQuery.query(
    `CREATE TABLE IF NOT EXISTS ${dbSchema}.worker_availability (
       worker_uid TEXT PRIMARY KEY,
       schedule   JSONB NOT NULL DEFAULT '{}',
       timezone   TEXT NOT NULL DEFAULT 'Asia/Manila',
       updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    []
  );
};

export const getWorkerAvailability = async (uid: string) => {
  await ensureAvailabilityTable();
  const res = await dbQuery.query(
    `SELECT * FROM ${dbSchema}.worker_availability WHERE worker_uid = $1`,
    [uid]
  );
  if (!res.rows[0]) {
    return { worker_uid: uid, schedule: [], timezone: "Asia/Manila", updated_at: null };
  }
  const row = res.rows[0];
  // Normalize: JSONB default '{}' is not iterable as an array
  if (!Array.isArray(row.schedule)) {
    row.schedule = [];
  }
  return row;
};

export const saveWorkerAvailability = async (
  uid: string,
  payload: { schedule: object; timezone?: string }
) => {
  await ensureAvailabilityTable();
  const { schedule, timezone = "Asia/Manila" } = payload;
  await dbQuery.query(
    `INSERT INTO ${dbSchema}.worker_availability (worker_uid, schedule, timezone, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (worker_uid) DO UPDATE
       SET schedule = EXCLUDED.schedule, timezone = EXCLUDED.timezone, updated_at = NOW()`,
    [uid, JSON.stringify(schedule), timezone]
  );
  return { success: true };
};

// ---------------------------------------------------------------------------
// Worker Time-Off (PostgreSQL)
// ---------------------------------------------------------------------------

const ensureTimeOffTable = async () => {
  await dbQuery.query(
    `CREATE TABLE IF NOT EXISTS ${dbSchema}.worker_time_off (
       id         SERIAL PRIMARY KEY,
       worker_uid TEXT NOT NULL,
       start_date DATE NOT NULL,
       end_date   DATE NOT NULL,
       reason     TEXT,
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    []
  );
};

export const getWorkerTimeOff = async (uid: string) => {
  await ensureTimeOffTable();
  const res = await dbQuery.query(
    `SELECT * FROM ${dbSchema}.worker_time_off WHERE worker_uid = $1 ORDER BY start_date ASC`,
    [uid]
  );
  return res.rows;
};

export const createWorkerTimeOff = async (
  uid: string,
  payload: { startDate: string; endDate: string; reason?: string }
) => {
  await ensureTimeOffTable();
  const res = await dbQuery.query(
    `INSERT INTO ${dbSchema}.worker_time_off (worker_uid, start_date, end_date, reason)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [uid, payload.startDate, payload.endDate, payload.reason ?? null]
  );
  return res.rows[0];
};

export const deleteWorkerTimeOff = async (uid: string, id: string) => {
  const res = await dbQuery.query(
    `DELETE FROM ${dbSchema}.worker_time_off WHERE id = $1 AND worker_uid = $2 RETURNING *`,
    [id, uid]
  );
  if (!res.rowCount) throw new Error("Time-off entry not found");
  return res.rows[0];
};

// ---------------------------------------------------------------------------
// Worker Service Area (PostgreSQL)
// ---------------------------------------------------------------------------

const ensureServiceAreaTable = async () => {
  await dbQuery.query(
    `CREATE TABLE IF NOT EXISTS ${dbSchema}.worker_service_areas (
       worker_uid TEXT PRIMARY KEY,
       city_ids   JSONB NOT NULL DEFAULT '[]',
       label      TEXT,
       updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    []
  );
};

export const getWorkerServiceArea = async (uid: string) => {
  await ensureServiceAreaTable();
  const res = await dbQuery.query(
    `SELECT * FROM ${dbSchema}.worker_service_areas WHERE worker_uid = $1`,
    [uid]
  );
  return res.rows[0] ?? { worker_uid: uid, city_ids: [], label: null };
};

export const saveWorkerServiceArea = async (
  uid: string,
  payload: { cityIds: string[]; label?: string }
) => {
  await ensureServiceAreaTable();
  const label = payload.label ?? payload.cityIds.slice(0, 3).join(", ") ?? null;
  await dbQuery.query(
    `INSERT INTO ${dbSchema}.worker_service_areas (worker_uid, city_ids, label, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (worker_uid) DO UPDATE
       SET city_ids = EXCLUDED.city_ids, label = EXCLUDED.label, updated_at = NOW()`,
    [uid, JSON.stringify(payload.cityIds), label]
  );
  return { success: true, updatedAt: new Date().toISOString() };
};

// ---------------------------------------------------------------------------
// Worker Profile Photo (PostgreSQL)
// ---------------------------------------------------------------------------

export const updateWorkerPhotoUrl = async (uid: string, photoUrl: string) => {
  await dbQuery.query(
    `CREATE TABLE IF NOT EXISTS ${dbSchema}.user_profile (
       uid        TEXT PRIMARY KEY,
       photo_url  TEXT,
       updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    []
  );
  await dbQuery.query(
    `INSERT INTO ${dbSchema}.user_profile (uid, photo_url, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (uid) DO UPDATE SET photo_url = EXCLUDED.photo_url, updated_at = NOW()`,
    [uid, photoUrl]
  );
  return { photoUrl };
};

// ---------------------------------------------------------------------------
// Worker Dashboard
// ---------------------------------------------------------------------------

export const getWorkerDashboard = async (uid: string) => {
  const [historyRes, pendingRes, onlineDoc] = await Promise.all([
    dbQuery.query(
      // booking_workers is only ever written 'CANCELED' (single L) — see
      // bookingService.ts:659 and adminBookingService.ts:942. The parent
      // bookings row uses 'CANCELLED' (double L). This counted the parent's
      // spelling against the child's table, so `cancelled` was permanently 0.
      //
      // Both spellings are matched rather than just the correct one: the split
      // is real across the schema, and a counter that silently reads zero is
      // worse than one that over-matches. Normalising the two spellings is
      // tracked separately — it is a data migration, not a query fix.
      `SELECT COUNT(*) AS total_jobs,
              COALESCE(SUM(CASE WHEN bw.status = 'COMPLETED' THEN 1 ELSE 0 END), 0) AS completed,
              COALESCE(SUM(CASE WHEN bw.status IN ('CANCELED', 'CANCELLED') THEN 1 ELSE 0 END), 0) AS cancelled
       FROM ${dbSchema}.booking_workers bw WHERE bw.worker_uid = $1`,
      [uid]
    ),
    dbQuery.query(
      `SELECT COUNT(*) AS pending_jobs
       FROM ${dbSchema}.booking_workers bw
       WHERE bw.worker_uid = $1 AND bw.status IN ('ASSIGNED', 'ACCEPTED')`,
      [uid]
    ),
    (await mongoDb).collection("worker_locations").findOne({ uid }, { projection: { is_online: 1 } }),
  ]);
  return {
    totalJobs: Number(historyRes.rows[0]?.total_jobs ?? 0),
    completedJobs: Number(historyRes.rows[0]?.completed ?? 0),
    cancelledJobs: Number(historyRes.rows[0]?.cancelled ?? 0),
    pendingJobs: Number(pendingRes.rows[0]?.pending_jobs ?? 0),
    isOnline: onlineDoc?.is_online ?? false,
  };
};

// ---------------------------------------------------------------------------
// Worker Onboarding (PostgreSQL)
// ---------------------------------------------------------------------------

const ensureOnboardingTable = async () => {
  await dbQuery.query(
    `CREATE TABLE IF NOT EXISTS ${dbSchema}.worker_onboarding (
       worker_uid      TEXT PRIMARY KEY,
       status          TEXT NOT NULL DEFAULT 'pending',
       current_step    TEXT NOT NULL DEFAULT 'personal_info',
       completed_steps JSONB NOT NULL DEFAULT '[]',
       step_data       JSONB NOT NULL DEFAULT '{}',
       submitted_at    TIMESTAMPTZ,
       updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    []
  );
};

export const getWorkerOnboarding = async (uid: string) => {
  await ensureOnboardingTable();
  const res = await dbQuery.query(
    `SELECT * FROM ${dbSchema}.worker_onboarding WHERE worker_uid = $1`,
    [uid]
  );
  return res.rows[0] ?? {
    worker_uid: uid, status: "pending", current_step: "personal_info",
    completed_steps: [], step_data: {}, submitted_at: null,
  };
};

export const saveWorkerOnboardingStep = async (
  uid: string,
  stepKey: string,
  data: object
) => {
  await ensureOnboardingTable();
  await dbQuery.query(
    `INSERT INTO ${dbSchema}.worker_onboarding (worker_uid, current_step, step_data, updated_at)
     VALUES ($1, $2, $3::jsonb, NOW())
     ON CONFLICT (worker_uid) DO UPDATE
       SET current_step    = EXCLUDED.current_step,
           step_data       = worker_onboarding.step_data || EXCLUDED.step_data,
           completed_steps = (
             SELECT jsonb_agg(DISTINCT val)
             FROM jsonb_array_elements_text(
               worker_onboarding.completed_steps || jsonb_build_array($2)
             ) val
           ),
           updated_at = NOW()`,
    [uid, stepKey, JSON.stringify({ [stepKey]: data })]
  );
  return { success: true, stepKey };
};

export const submitWorkerOnboarding = async (uid: string, payload: object) => {
  await ensureOnboardingTable();
  await dbQuery.query(
    `INSERT INTO ${dbSchema}.worker_onboarding (worker_uid, status, current_step, submitted_at, step_data, updated_at)
     VALUES ($1, 'pending_review', 'submitted', NOW(), $2::jsonb, NOW())
     ON CONFLICT (worker_uid) DO UPDATE
       SET status = 'pending_review', current_step = 'submitted',
           submitted_at = NOW(), step_data = EXCLUDED.step_data, updated_at = NOW()`,
    [uid, JSON.stringify(payload)]
  );
  return { status: "pending_review", submittedAt: new Date().toISOString() };
};

// ---------------------------------------------------------------------------
// Worker Review Status
// ---------------------------------------------------------------------------

export const getWorkerReviewStatus = async (uid: string) => {
  const res = await dbQuery.query(
    `SELECT account_status, is_email_verified FROM ${dbSchema}.user_credentials WHERE uid = $1`,
    [uid]
  );
  const row = res.rows[0];
  return {
    reviewStatus: row?.account_status ?? "pending",
    isEmailVerified: row?.is_email_verified ?? false,
  };
};

export const submitWorkerForReview = async (uid: string) => {
  await dbQuery.query(
    `UPDATE ${dbSchema}.user_credentials SET account_status = 'under_review' WHERE uid = $1`,
    [uid]
  );
  return { reviewStatus: "under_review" };
};

// ---------------------------------------------------------------------------
// Worker Notification Preferences (PostgreSQL)
// ---------------------------------------------------------------------------

const ensureNotificationPrefsTable = async () => {
  await dbQuery.query(
    `CREATE TABLE IF NOT EXISTS ${dbSchema}.worker_notification_prefs (
       worker_uid        TEXT PRIMARY KEY,
       job_assigned      BOOLEAN NOT NULL DEFAULT TRUE,
       job_reminder      BOOLEAN NOT NULL DEFAULT TRUE,
       payment_received  BOOLEAN NOT NULL DEFAULT TRUE,
       new_message       BOOLEAN NOT NULL DEFAULT TRUE,
       promotions        BOOLEAN NOT NULL DEFAULT FALSE,
       quiet_hours       JSONB NOT NULL DEFAULT '{}',
       updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    []
  );
};

export const getWorkerNotificationPrefs = async (uid: string) => {
  await ensureNotificationPrefsTable();
  const res = await dbQuery.query(
    `SELECT * FROM ${dbSchema}.worker_notification_prefs WHERE worker_uid = $1`,
    [uid]
  );
  return res.rows[0] ?? {
    worker_uid: uid, job_assigned: true, job_reminder: true,
    payment_received: true, new_message: true, promotions: false, quiet_hours: {},
  };
};

export const saveWorkerNotificationPrefs = async (
  uid: string,
  payload: {
    jobAssigned?: boolean; jobReminder?: boolean; paymentReceived?: boolean;
    newMessage?: boolean; promotions?: boolean; quietHours?: object;
  }
) => {
  await ensureNotificationPrefsTable();
  await dbQuery.query(
    `INSERT INTO ${dbSchema}.worker_notification_prefs
       (worker_uid, job_assigned, job_reminder, payment_received, new_message, promotions, quiet_hours, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW())
     ON CONFLICT (worker_uid) DO UPDATE
       SET job_assigned     = EXCLUDED.job_assigned,
           job_reminder     = EXCLUDED.job_reminder,
           payment_received = EXCLUDED.payment_received,
           new_message      = EXCLUDED.new_message,
           promotions       = EXCLUDED.promotions,
           quiet_hours      = EXCLUDED.quiet_hours,
           updated_at       = NOW()`,
    [
      uid,
      payload.jobAssigned ?? true,
      payload.jobReminder ?? true,
      payload.paymentReceived ?? true,
      payload.newMessage ?? true,
      payload.promotions ?? false,
      JSON.stringify(payload.quietHours ?? {}),
    ]
  );
  return { success: true };
};
/**
 * The provider currently serving a booking, or null when none is assigned.
 *
 * "Currently" excludes DECLINED and CANCELED assignments, so a provider who
 * turned the job down — or was reassigned away — is not reported as the one on
 * their way (§22). Used by the booking-scoped location endpoint so a customer
 * can only ever be told about the provider actually attached to their booking.
 */
export const getAssignedWorkerUid = async (
  bookingId: number,
): Promise<string | null> => {
  const { rows } = await dbQuery.query(
    `SELECT worker_uid FROM ${dbSchema}.booking_workers
      WHERE booking_id = $1
        AND status IN ('ASSIGNED','ACCEPTED','IN_PROGRESS','COMPLETED')
      ORDER BY assigned_at DESC NULLS LAST
      LIMIT 1`,
    [bookingId],
  );
  return rows.length ? (rows[0].worker_uid as string) ?? null : null;
};
