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
import {
  acceptanceConflictForSnapshot,
  declineConflictForSnapshot,
  classifyResponseMiss,
} from "./bookingResponseConflict";
import { createDisbursement } from "./disbursement.service";
import { getOrCreateConversation, postSystemMessageOnce } from "../chat/chat.service";
import { findExistingConversationByBookingId } from "../chat/chat.repository";
import { emitToProvider } from "../provider.realtime";
import {
  transitionBooking,
  TransitionError,
  type TransitionResult,
} from "./booking/transitionExecutor";
import {
  CAPABILITY_GRANT_EXISTS_SQL,
  BUSY_PROVIDERS_SQL,
  bookingSpan,
  bookingEndSql,
} from "./booking/eligibilityPipeline";
import { providerRoleSqlPredicate } from "../constants/providerRoles";
import {
  projectFamilyGrantSafely,
  setFamilyGrantStatusSafely,
} from "./booking/capabilityProjection";
import { READABLE_WORKER_STATUS_SQL } from "../controllers/providerDisclosure";
import {
  isSkippableRefusal,
  noAssignmentDiagnosis,
  recordAutoAssignExhausted,
} from "./booking/autoAssignDiagnostics";

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
  /**
   * `ineligible` is new, and distinct from `busy` on purpose.
   *
   * Both mean "not this provider, try the next one", but they answer different
   * operational questions: `busy` is a diary that is full, `ineligible` is a
   * provider who should not have been offered at all. Collapsing them would
   * make a capability gap read as a scheduling problem.
   */
  kind: "created" | "existing" | "busy" | "ineligible";
  /** Canonical blocker code, on `busy` and `ineligible`. */
  reasonCode?: string;
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
/**
 * ─── E2 · AUTO_ASSIGN, on the canonical executor ─────────────────────────────
 *
 * Commits a provider the matching engine has ALREADY chosen. Selection,
 * ranking and exclusions stay entirely in `assignNearestWorker`; this function
 * is now a compatibility boundary around one executor call.
 *
 * ## Why it had to move
 *
 * It was the last writer of lifecycle state outside the executor, and after D4
 * it was actively dangerous: D4 moved admin assignment's locks into the
 * executor and reversed their order to booking→provider, while this path still
 * took provider→booking. Two paths acquiring the same two lock classes in
 * opposite orders is a deadlock, and `AUTO_ASSIGN(P→A)` racing
 * `ADMIN_ASSIGN(P→B)` could hit it. Both orders now converge on
 * booking→provider, with the same advisory key.
 *
 * ## What did NOT change
 *
 * The validation profile is `LEGACY_AUTO`: the ±2-hour conflict check and
 * nothing else. Auto-assignment has never checked provider role, archive state
 * or service qualification, and adding them here would silently change who the
 * matching engine may pick — a TAB 05 decision, recorded as a known gap rather
 * than made by accident.
 *
 * The three return shapes are preserved because the search loop depends on
 * them: `busy` is NOT an error (the loop tries the next candidate), `existing`
 * is idempotent success, and a different provider is BOOKING_ALREADY_ASSIGNED
 * unless `returnExistingAssignment`.
 *
 * `worker_code` keeps its COALESCE: an existing code is preserved, never
 * regenerated, because the customer may already be holding it.
 */
const persistWorkerAssignment = async (input: {
  bookingId: number;
  workerUid: string;
  note: string;
  travel?: AssignmentTravel;
  returnExistingAssignment?: boolean;
}): Promise<AssignmentWriteResult> => {
  const bookingRes = await dbQuery.query(
    `SELECT id, status, worker_uid, user_id, schedule
       FROM ${dbSchema}.bookings
      WHERE id = $1`,
    [input.bookingId],
  );
  if (!bookingRes.rowCount) {
    throw new BookingAssignmentError("BOOKING_NOT_FOUND", "Booking not found");
  }

  const booking = bookingRes.rows[0];
  const status = String(booking.status ?? "").toUpperCase();
  const currentWorkerUid = booking.worker_uid ? String(booking.worker_uid) : null;

  /**
   * Already assigned: answered before the executor, exactly as before.
   *
   * The machine would report INVALID_TRANSITION for a booking already at
   * ASSIGNED, and this function has always distinguished "the same provider,
   * fine" from "somebody else, refuse".
   */
  if (currentWorkerUid) {
    if (currentWorkerUid !== input.workerUid && !input.returnExistingAssignment) {
      throw new BookingAssignmentError(
        "BOOKING_ALREADY_ASSIGNED",
        "Booking is already assigned to another provider",
      );
    }
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

  const travel = input.travel ?? null;
  try {
    await transitionBooking({
      action: 'AUTO_ASSIGN',
      bookingId: input.bookingId,
      actorRole: 'system',
      actorUid: null,
      metadata: {
        providerUid: input.workerUid,
        trackingNote: input.note,
        assignment: {
          etaMinutes: travel?.etaMinutes ?? null,
          workerCode: travel?.otpCode ?? null,
          transpoFee: travel?.transpoFee ?? null,
          distanceKm: travel ? Math.round(travel.distanceKm * 100) / 100 : null,
        },
      },
    });
  } catch (error) {
    if (error instanceof TransitionError) {
      /**
       * A refusal about the PROVIDER is not an error to this caller.
       *
       * `assignNearestWorker` walks a ranked candidate list and moves to the
       * next one. Throwing here would end the search at the first provider who
       * happens to be occupied — or, since AUTO_ASSIGN moved to the canonical
       * strict validation, at the first archived or unqualified one.
       *
       * That distinction is why the tightening is safe: the executor now
       * refuses providers it used to accept, and every one of those refusals
       * costs a candidate rather than a booking.
       */
      const reasonCode = (error.detail as { reasonCode?: unknown } | undefined)?.reasonCode;
      if (isSkippableRefusal(reasonCode)) {
        return {
          kind: reasonCode === 'BOOKING_CONFLICT' ? "busy" : "ineligible",
          workerUid: input.workerUid,
          reasonCode,
        };
      }
      throw new BookingAssignmentError(
        "BOOKING_ALREADY_ASSIGNED",
        "Booking assignment changed concurrently",
      );
    }
    throw error;
  }

  const [after, assignmentRow] = await Promise.all([
    dbQuery.query(
      `SELECT user_id, schedule, eta_at FROM ${dbSchema}.bookings WHERE id = $1`,
      [input.bookingId],
    ),
    dbQuery.query(
      `SELECT * FROM ${dbSchema}.booking_workers
        WHERE booking_id = $1 AND worker_uid = $2
        ORDER BY assigned_at DESC NULLS LAST, id DESC
        LIMIT 1`,
      [input.bookingId, input.workerUid],
    ),
  ]);

  return {
    kind: "created",
    workerUid: input.workerUid,
    bookingStatus: "WORKER_ASSIGNED",
    customerUid: after.rows[0]?.user_id ?? null,
    schedule: new Date(after.rows[0]?.schedule ?? booking.schedule),
    etaAt: after.rows[0]?.eta_at ? new Date(after.rows[0].eta_at) : null,
    assignment: assignmentRow.rows[0],
  };
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
      JOIN ${dbSchema}.service_families s ON s.id = es.service_id
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

  /**
   * 2. Providers already occupied during THIS booking's span.
   *
   * The span is resolved in SQL from `duration_mins`, exactly as the executor
   * resolves it at commit. A selector that asked a different question from its
   * own committer would offer providers the commit then refuses, which reads to
   * operations as an intermittent assignment failure rather than a disagreement.
   */
  const busyRes = await dbQuery.query(
    `SELECT b.schedule AS start_at, ${bookingEndSql('b', 'so')} AS end_at
       FROM ${dbSchema}.bookings b
       LEFT JOIN ${dbSchema}.service_options so ON so.id = b.service_option_id
      WHERE b.id = $1`,
    [bookingId],
  ).then((span) => dbQuery.query(
    BUSY_PROVIDERS_SQL(dbSchema),
    [span.rows[0]?.start_at ?? schedule, span.rows[0]?.end_at ?? bookingSpan(schedule).to, bookingId],
  ));
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

  /** Attributed refusals collected while walking the ranked list. */
  const refusals: string[] = [];
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
    if (result.kind === "busy" || result.kind === "ineligible") {
      // Attributed and remembered, so the end of the walk can say what stopped
      // it rather than reporting an empty list.
      if (result.reasonCode) refusals.push(result.reasonCode);
      continue;
    }
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
    /**
     * Nobody could be committed. `NO_WORKER_AVAILABLE_AFTER_RECHECK` was true
     * and useless — it said the walk finished without saying what stopped it,
     * so an operator could not tell a capability gap from a full diary.
     *
     * The legacy `reason` string is preserved because callers switch on it;
     * the attribution travels beside it, in the same vocabulary the Admin
     * candidate pool uses.
     */
    recordAutoAssignExhausted();
    return { assigned: false, ...noAssignmentDiagnosis(refusals) };
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

      -- An OPEN escalation outranks every other state, so the provider card
      -- cannot derive a truthful canonical state without knowing about one.
      -- Without this the card would report IN_PROGRESS for a booking Admin
      -- shows as DISPUTED - a cross-surface disagreement introduced by the very
      -- projection meant to remove them. The resolved_at IS NULL test matches
      -- the predicate Admin's list and metrics already use.
      EXISTS (SELECT 1 FROM ${dbSchema}.booking_escalations esc
               WHERE esc.booking_id = b.id AND esc.resolved_at IS NULL) AS has_escalation,

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

      -- SW-05. The exact point, from whichever source holds it. user_address
      -- carries the canonical loc_{lat}_{lng}; admin-created bookings put
      -- lat/lon straight into service_address. jobCardView parses these and
      -- releases them at full disclosure only, so a provider who has not
      -- accepted still gets no precise location.
      --
      -- Selected, never trusted: one production row holds a Google place id in
      -- location_id instead of a location id (SW-13), which is why the parser
      -- returns null rather than guessing.
      ua.location_id,
      b.service_address->>'lat' AS service_address_lat,
      b.service_address->>'lon' AS service_address_lon,

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
    -- LEAKAGE RULE. A provider who declined, cancelled or was reassigned away
    -- gets the same answer as for a booking that does not exist. This list used
    -- to include DECLINED, CANCELED and CANCELLED: the PII was staged out by
    -- jobCardView, but the card still came back — an empty husk confirming the
    -- booking exists and when it was scheduled.
    --
    -- Built from the same declaration that decides disclosure, so the two
    -- cannot disagree about who has relinquished a job.
    AND bw.status IN (${READABLE_WORKER_STATUS_SQL})
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

  // Fetch workers: if serviceId provided, only those qualified for that service.
  //
  // Both predicates were locally written and both were wrong in the same
  // direction — they under-counted supply. `role::int = 2` excluded every
  // role-4 provider, and the INNER JOIN on employee_services excluded providers
  // holding only an approved application, whom the executor will happily
  // commit. This function has NO route today; the correction is made anyway,
  // because a divergent predicate sitting in a live service file is one `git
  // grep` away from being wired up as if it were canonical.
  const workerQuery = serviceId
    ? `SELECT uc.uid, uc.email, uc.first_name, uc.last_name, uc.phone_number, uc.role
       FROM ${dbSchema}.user_credentials uc
       WHERE uc.is_archive = false
         AND ${providerRoleSqlPredicate('uc.role')}
         AND ${CAPABILITY_GRANT_EXISTS_SQL(dbSchema, 'uc.uid', 'NULL', '$1')}`
    : `SELECT uid, email, first_name, last_name, phone_number, role
       FROM ${dbSchema}.user_credentials uc
       WHERE ${providerRoleSqlPredicate('uc.role')} AND is_archive = false`;

  const workerParams = serviceId ? [serviceId] : [];
  const { rows: allWorkers } = await dbQuery.query(workerQuery, workerParams);

  if (!allWorkers.length) return [];

  /**
   * Workers already occupied during the requested span.
   *
   * This entry point receives a schedule and, at most, a legacy FAMILY id — it
   * never sees a service option, so the job's real duration is unknowable here
   * and `bookingSpan` applies the declared default. Stated rather than hidden:
   * a caller that knows the option should be asking through the booking.
   */
  const { from: windowStart, to: windowEnd } = bookingSpan(requestedTime);
  const { rows: busyRows } = await dbQuery.query(
    BUSY_PROVIDERS_SQL(dbSchema),
    [windowStart, windowEnd, null],
  );
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

// assignWorker was removed with PUT /admin/bookings/:bookingId/assign, its only
// caller. Admin assignment goes through adminBookingService.adminAssignProvider,
// which audits the actor and records a reason. persistWorkerAssignment — the
// shared transactional write this used — stays: assignNearestWorker still uses it.

export const getJobCardByWorker = async (workerId: string, bookingId: number) => {
  const rows = await getJobCardsByWorker(workerId, bookingId);
  return rows[0] ?? null;
};

/**
 * Re-expresses an executor refusal in the vocabulary the provider clients know.
 *
 * The executor answers in eight codes about lifecycle legality. Provider
 * acceptance answers in six about *this provider's* relationship to *this*
 * assignment, and one of them — `ALREADY_ACCEPTED_BY_YOU` — is a 200. That
 * distinction is the reason the classifier exists, so it survives the
 * migration unchanged rather than being approximated.
 *
 * It runs on `error.snapshot`: the rows the executor read while holding the
 * lock it refused under. Re-reading here instead would classify against a
 * later state and could explain the refusal with a reason that was not the
 * reason.
 *
 * A refusal the snapshot cannot explain is re-thrown as-is. DISPUTED is the
 * live example: the rows look perfectly acceptable and the machine still says
 * no, because a dispute is not visible in either status column. Inventing a
 * conflict code for it would be a guess, and the executor's own message is the
 * honest answer.
 */
const asAcceptanceConflict = (error: unknown, workerUid: string): unknown => {
  if (!(error instanceof TransitionError)) return error;

  // BOOKING_NOT_FOUND carries no snapshot; all-null is exactly what the legacy
  // classifier saw when its own SELECT returned nothing, and it answered
  // NO_LONGER_ASSIGNED — §12 forbids confirming whether the booking exists.
  const conflict = acceptanceConflictForSnapshot({
    bookingStatus: error.snapshot?.bookingStatus ?? null,
    bookingWorkerUid: error.snapshot?.bookingWorkerUid ?? null,
    assignmentStatus: error.snapshot?.assignmentStatus ?? null,
    workerUid,
  });

  return conflict ?? error;
};

/**
 * ─── B1.1 · PROVIDER_ACCEPT, on the canonical executor ───────────────────────
 *
 * This function used to own the transition: it took both row locks, validated
 * the snapshot itself, ran its own compare-and-swap and wrote the tracking row.
 * All of that now lives in `transitionBooking`, so acceptance is decided by the
 * same machine that decides every other lifecycle move.
 *
 * ## What did NOT change, deliberately
 *
 * The six-code `BookingResponseConflict` contract. Five clients branch on those
 * codes, and `ALREADY_ACCEPTED_BY_YOU` is the one that answers 200 rather than
 * 409, so collapsing them into the executor's coarser vocabulary would turn a
 * provider's double-tap into an error dialog. The classifier is unchanged and
 * still reads `acceptanceConflictForSnapshot` — but it now runs on the snapshot
 * the executor captured under `FOR UPDATE`, rather than on a snapshot this
 * function took itself. Same data, same lock, one authority for the decision.
 *
 * The side effects keep their exact shape and order: admin notification,
 * customer notification, provider socket emit, acceptance email, group chat.
 * Cleaning them up in the same commit as the transition migration would make a
 * behaviour change indistinguishable from a refactor in the diff.
 *
 * ## What did change
 *
 * The legacy CAS carried `WHERE id = $1 AND status = 'ASSIGNED'` and threw a
 * bare `Error("Booking acceptance changed concurrently")` on a miss. That miss
 * was already unreachable — the booking row was locked before the snapshot was
 * read, so nothing could move between validating and writing — and the machine
 * now refuses a non-ASSIGNED source state before any write happens. The bare
 * Error is gone with it; every refusal is a typed conflict.
 *
 * `ensureArrivalColumns()` stays here. It is lazy DDL, and a booking transition
 * must not be able to alter schema.
 */
export const acceptJob = async (
  bookingId: number,
  workerUid: string,
  options: { idempotencyKey?: string; correlationId?: string } = {},
) => {
  // accepted_at is added by this lazy DDL; the executor's ACCEPTED write fills it.
  await ensureArrivalColumns();

  let result: TransitionResult;
  try {
    result = await transitionBooking({
      action: 'PROVIDER_ACCEPT',
      bookingId,
      actorRole: 'assigned_provider',
      actorUid: workerUid,
      idempotencyKey: options.idempotencyKey,
      correlationId: options.correlationId,
    });
  } catch (error) {
    throw asAcceptanceConflict(error, workerUid);
  }

  // The assignment row as it now stands. Legacy returned it from `RETURNING *`
  // inside the transaction; the executor does not hand its rows back, so this
  // is a read after commit. A reassignment landing in that window would return
  // the newer row — which is the truer answer, and the provider's next poll
  // would show it anyway.
  const acceptedRes = await dbQuery.query(
    `SELECT * FROM ${dbSchema}.booking_workers
      WHERE booking_id = $1 AND worker_uid = $2
      ORDER BY assigned_at DESC NULLS LAST, id DESC
      LIMIT 1`,
    [bookingId, workerUid],
  );
  const accepted: any = acceptedRes.rows[0] ?? {};

  const customerRes = await dbQuery.query(
    `SELECT user_id FROM ${dbSchema}.bookings WHERE id = $1`,
    [bookingId],
  );
  const customerUid: string | null = customerRes.rows[0]?.user_id ?? null;

  /**
   * A replayed key returns the original outcome and sends nothing.
   *
   * The transition is already committed and its notifications already went out.
   * Re-running them would email the customer twice and post the group-chat
   * message again for what the client intended as one action — §17: a retry is
   * the same request, not a second one.
   */
  if (result.idempotentReplay) {
    return { ...accepted, effectiveStatus: "ACCEPTED", idempotent: true };
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

/**
 * Lazily adds the cancellation record columns, like the arrival ones.
 *
 * Stays here rather than moving with the transition: a booking transition must
 * not be able to alter schema. Queued for a real migration alongside 027's
 * arrival columns.
 */
// `ensureCancellationColumns` added booking_workers.{cancelled_at,
// cancellation_reason_code, cancellation_note}. Migration 036 owns all three.
//
// Its own comment said it was "queued for a real migration alongside 027's
// arrival columns". This is that migration.

/**
 * ─── E1 · PROVIDER_CANCEL, on the canonical executor ─────────────────────────
 *
 * Provider cancels a booking they already accepted (C18 §26).
 *
 * Operator policy, recorded not inferred: allowed up to 48 hours before the
 * scheduled start, RECORD ONLY (no penalty, no fee, no rating impact), and it
 * auto-reassigns exactly like a decline while notifying admin.
 *
 * ## The 48-hour policy is now the executor's, not the controller's
 *
 * `providerCancellationWindow` runs inside the transition transaction, so no
 * caller can reach a provider cancellation without it — which was the whole
 * point of moving the policy into the domain layer. The controller no longer
 * evaluates it; it formats the refusal the executor produces.
 *
 * ## The cancellation record is written WITH the status
 *
 * `cancelled_at`, `cancellation_reason_code` and `cancellation_note` land in
 * the same statement as CANCELLED. §26 requires the reason to be recorded, and
 * a cancelled assignment with no reason is the shape support cannot act on.
 *
 * ## Everything else preserved
 *
 * The six-code conflict contract on a refusal, the release back to the pool,
 * the reassignment search after commit, and the provider's own notification —
 * unchanged, in the same order.
 *
 * `ensureCancellationColumns()` stays here with `ensureArrivalColumns()`: lazy
 * DDL is not a booking transition's business.
 */
export const cancelAcceptedJob = async (
  bookingId: number,
  workerUid: string,
  reasonCode: string,
  note?: string | null,
  options: { correlationId?: string } = {},
) => {
  await ensureArrivalColumns();

  try {
    await transitionBooking({
      action: 'PROVIDER_CANCEL',
      bookingId,
      actorRole: 'assigned_provider',
      actorUid: workerUid,
      correlationId: options.correlationId,
      metadata: { reasonCode, note: note ?? null },
    });
  } catch (error) {
    if (error instanceof TransitionError) {
      // A policy refusal is the controller's to format — it carries the whole
      // eligibility verdict — so it travels unchanged.
      if (error.code === 'POLICY_REFUSED') throw error;
      // Everything else is the assignment having moved on, which this endpoint
      // has always reported through the six-code conflict vocabulary.
      throw declineConflictForSnapshot({
        actorAssignmentStatus: error.snapshot?.actorAssignmentStatus ?? null,
      });
    }
    throw error;
  }

  const reassignment = await findAndAssignNextProvider(
    bookingId,
    workerUid,
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

/**
 * Finds the next nearest qualified provider and tells the customer.
 *
 * The half of the release that is NOT a lifecycle transition. TAB 05 owns who
 * gets assigned; this stays outside the executor deliberately, and runs after
 * it has committed.
 */
export const findAndAssignNextProvider = async (
  bookingId: number,
  workerUid: string,
  eventKind: "provider_declined" | "provider_cancelled",
  customerMessage: string
) => {
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

/**
 * ─── B1.2 · PROVIDER_DECLINE, on the canonical executor ──────────────────────
 *
 * The release is now part of the transition rather than a sequence of
 * autocommit statements after it. Previously: CAS the assignment row, then
 * reset the booking, then insert the tracking row — three separate commits, so
 * a failure between them left a booking declined but not released, or released
 * with no timeline entry and no reassignment attempted.
 *
 * ## The refusal vocabulary, and why it needed the actor's own row
 *
 * `declineConflictForSnapshot` replaces `classifyResponseMiss` here. Same
 * codes, same precedence, but read from the rows the executor locked instead of
 * a fresh SELECT. That required the executor to load the ACTOR's assignment row
 * as well as the booking's current one: a decline clears
 * `bookings.worker_uid`, so a provider double-tapping is, from the booking's
 * point of view, a stranger. Only their own row still says DECLINED, and that
 * is what makes the second tap a 200 rather than an error dialog.
 *
 * ## One behaviour change
 *
 * Declining a CANCELLED booking is now refused. The legacy CAS only checked
 * `status = 'ASSIGNED'` on the assignment row, so it succeeded — and then the
 * release reset `bookings.status` to CONFIRMED and looked for another provider.
 * A cancelled booking was being un-cancelled and reassigned by a provider
 * tapping decline. The machine refuses from a terminal state.
 */
export const declineJob = async (
  bookingId: number,
  workerUid: string,
  options: { idempotencyKey?: string; correlationId?: string } = {},
) => {
  await ensureArrivalColumns();

  let result: TransitionResult;
  try {
    result = await transitionBooking({
      action: 'PROVIDER_DECLINE',
      bookingId,
      actorRole: 'assigned_provider',
      actorUid: workerUid,
      idempotencyKey: options.idempotencyKey,
      correlationId: options.correlationId,
    });
  } catch (error) {
    throw error instanceof TransitionError
      ? declineConflictForSnapshot({ actorAssignmentStatus: error.snapshot?.actorAssignmentStatus ?? null })
      : error;
  }

  // A replay must not search for a second provider. The first call already
  // reassigned; running it again would assign the booking twice.
  if (result.idempotentReplay) {
    return {
      declined: true,
      bookingId,
      workerUid,
      reassignment: { assigned: false, reason: 'IDEMPOTENT_REPLAY' },
    };
  }

  const reassignment = await findAndAssignNextProvider(
    bookingId,
    workerUid,
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

/**
 * ─── B1.3 · PROVIDER_EN_ROUTE, on the canonical executor ─────────────────────
 *
 * The provider is travelling to the customer.
 *
 * This no longer goes through `advanceArrivalStage`. That helper served both
 * arrival stages, and migrating it would have moved EN_ROUTE and ARRIVED in a
 * single commit; duplicating it temporarily to fake two commits would have
 * been more risk, not less. So EN_ROUTE leaves the helper here and ARRIVED
 * follows in B1.3's successor, which then deletes it.
 *
 * ## What the executor now owns
 *
 *   - the ACCEPTED → EN_ROUTE legality check, from the canonical machine
 *     rather than from `AND status = $3` in the SQL;
 *   - `booking_workers.status` and `en_route_at`, in one statement;
 *   - the `bookings.status` cascade, as LEGACY_STATUS_PROJECTION;
 *   - the `booking_tracking` row, now inside the transaction.
 *
 * ## The tracking row is no longer best-effort
 *
 * The legacy insert was wrapped in a try/catch justified as "the state change
 * is already committed and is the thing that matters" — true when the status
 * write was a separate autocommit statement. Inside the executor nothing is
 * committed yet, so the catch would guard nothing and would instead
 * manufacture the outcome it was written to tolerate: a committed transition
 * with a permanently missing timeline row, on three surfaces that read it.
 * Recorded as a deliberate change in docs/TAB04_OPEN_GAPS.md.
 *
 * ## The refusal message is preserved verbatim
 *
 * `providerController.arrivalHandler` matches `/cannot move to/i` to answer
 * 409 rather than 500. The executor's richer codes are available on the
 * `/api/v1` path; this legacy endpoint keeps flattening them exactly as it
 * did, because changing its response vocabulary is a client-visible change
 * that belongs to the endpoint's own migration, not to this one.
 */
export const markEnRoute = async (
  bookingId: number,
  workerUid: string,
  options: { idempotencyKey?: string; correlationId?: string } = {},
) => {
  await ensureArrivalColumns();
  return runArrivalTransition(bookingId, workerUid, 'PROVIDER_EN_ROUTE', 'EN_ROUTE', options);
};

/**
 * Shared shape for the executor-backed arrival stages.
 *
 * Returns the assignment row, which is what `arrivalHandler` reads to compute
 * `availableActions`. Legacy returned it from `RETURNING *` inside the
 * transaction; this reads it after the commit, which can only ever return a
 * fresher row.
 */
const runArrivalTransition = async (
  bookingId: number,
  workerUid: string,
  action: 'PROVIDER_EN_ROUTE' | 'PROVIDER_ARRIVED',
  to: 'EN_ROUTE' | 'ARRIVED',
  options: { idempotencyKey?: string; correlationId?: string } = {},
) => {
  try {
    await transitionBooking({
      action,
      bookingId,
      actorRole: 'assigned_provider',
      actorUid: workerUid,
      idempotencyKey: options.idempotencyKey,
      correlationId: options.correlationId,
    });
  } catch (error) {
    if (error instanceof TransitionError) {
      // Byte-identical to the legacy refusal, so the controller's 409 mapping
      // keeps working. The specific reason travels on /api/v1.
      throw new Error(`Job cannot move to ${to}`);
    }
    throw error;
  }

  const res = await dbQuery.query(
    `SELECT * FROM ${dbSchema}.booking_workers
      WHERE booking_id = $1 AND worker_uid = $2
      ORDER BY assigned_at DESC NULLS LAST, id DESC
      LIMIT 1`,
    [bookingId, workerUid],
  );
  return res.rows[0];
};

/**
 * ─── B1.4 · PROVIDER_ARRIVED, on the canonical executor ──────────────────────
 *
 * The provider has reached the address and has not yet started work.
 *
 * This completes the arrival family and retires `advanceArrivalStage`, which
 * was the last shared writer of the provider lifecycle outside the executor.
 * A repo-wide search found no remaining callers before it was deleted; the
 * only references left are comments describing what it used to do.
 */
export const markArrived = async (
  bookingId: number,
  workerUid: string,
  options: { idempotencyKey?: string; correlationId?: string } = {},
) => {
  await ensureArrivalColumns();
  return runArrivalTransition(bookingId, workerUid, 'PROVIDER_ARRIVED', 'ARRIVED', options);
};

/**
 * ─── B1.5 · PROVIDER_START, on the canonical executor ────────────────────────
 *
 * The last of the B1 family, and the one that was already half-migrated: the
 * atomic worker-code predicate moved into the executor during Phase A, so this
 * commit removes the duplicate rather than inventing anything.
 *
 * ## The predicate stayed atomic, and lost its state machine
 *
 * The legacy statement carried both the credential check and
 * `bw.status IN ('ACCEPTED','EN_ROUTE','ARRIVED')` — a second copy of the
 * transition table, written in SQL and maintained separately from the real
 * one. The executor keeps the credential check in the same statement as the
 * write, because a check-then-write leaves a window on the one gate that
 * protects a chargeable job; it does NOT reproduce the state list, because the
 * canonical machine has already decided the move is legal from this state,
 * under the row lock, before that line runs.
 *
 * Which is what makes a zero-row result mean exactly one thing. State,
 * assignment and terminality are all validated by then, so the only remaining
 * explanation is the code — and the caller gets
 * BOOKING_WORKER_CODE_INVALID rather than the legacy "Job cannot be started",
 * which conflated a wrong code, a wrong state, a wrong provider and a finished
 * booking into one unactionable sentence.
 *
 * ## The legacy message is preserved anyway
 *
 * Both legacy controllers answer 500 for any error from this function. Their
 * clients cannot distinguish the causes today and this migration is not the
 * place to change that, so the thrown message stays byte-identical. The
 * specific codes are available on `/api/v1/provider/jobs/:id/start`.
 */
export const startJob = async (
  bookingId: number,
  workerUid: string,
  workerCode?: string,
  options: { idempotencyKey?: string; correlationId?: string } = {},
) => {
  if (!workerCode) {
    throw new Error("worker_code is required to start job");
  }

  let result: TransitionResult;
  try {
    result = await transitionBooking({
      action: 'PROVIDER_START',
      bookingId,
      actorRole: 'assigned_provider',
      actorUid: workerUid,
      idempotencyKey: options.idempotencyKey,
      correlationId: options.correlationId,
      metadata: { workerCode },
    });
  } catch (error) {
    // Byte-identical to the legacy refusal, whatever the executor's reason.
    if (error instanceof TransitionError) throw new Error("Job cannot be started");
    throw error;
  }

  const startedRes = await dbQuery.query(
    `SELECT * FROM ${dbSchema}.booking_workers
      WHERE booking_id = $1 AND worker_uid = $2
      ORDER BY assigned_at DESC NULLS LAST, id DESC
      LIMIT 1`,
    [bookingId, workerUid],
  );
  const started = startedRes.rows[0];

  // A replay already sent these. Re-running them would email the customer a
  // second time and post the group-chat message again for one tap.
  if (result.idempotentReplay) return started;

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

  return started;
};

export class UnpaidCashBookingError extends Error {
  readonly code = "CASH_PAYMENT_REQUIRED";

  constructor() {
    super("Record the customer's cash payment before completing this job");
    this.name = "UnpaidCashBookingError";
  }
}

/**
 * ─── B2 · PROVIDER_COMPLETE, on the canonical executor ───────────────────────
 *
 * Completion is isolated from B1 because it is the first provider transition
 * with broad downstream consequences — disbursement, earnings, reviews, the
 * customer's receipt email. TAB 04's job here is narrow and specific: establish
 * that completion happened EXACTLY ONCE and is authoritative. What completion
 * triggers is deliberately left alone.
 *
 * ## The precondition moved; the side effects did not
 *
 * The unpaid-cash check was an `EXISTS` clause inside the UPDATE, which made it
 * a genuine transition guard rather than a side effect: the write simply did
 * not happen. It is now the named canonical guard
 * `cashPaymentSettledBeforeCompletion`, evaluated inside the transaction
 * before any write.
 *
 * That classification is the whole risk of this migration. Had it been treated
 * as a post-transition check, a caller would receive `UnpaidCashBookingError`
 * for a booking that had already committed COMPLETED — a failure response over
 * a successful state change, with the provider's app showing the job open
 * while the money pipeline treated it as done.
 *
 * Everything else — disbursement, the receipt email, the group-chat message —
 * keeps its current position and its current failure behaviour. None of them
 * is a precondition, and none is redesigned here.
 *
 * ## Exactly-once past the state row
 *
 * `createDisbursement` already dedupes on its own
 * (`ON CONFLICT (booking_id) DO NOTHING`) and `postSystemMessageOnce` is keyed.
 * The receipt email is NOT idempotent, which is why the replay gate below is
 * on `idempotentReplay` rather than trusting the downstream effects to sort
 * themselves out.
 */
export const completeJob = async (
  bookingId: number,
  workerUid: string,
  options: { idempotencyKey?: string; correlationId?: string } = {},
) => {
  let result: TransitionResult;
  try {
    result = await transitionBooking({
      action: 'PROVIDER_COMPLETE',
      bookingId,
      actorRole: 'assigned_provider',
      actorUid: workerUid,
      idempotencyKey: options.idempotencyKey,
      correlationId: options.correlationId,
    });
  } catch (error) {
    if (error instanceof TransitionError) {
      // The one refusal callers branch on. `providerController.completeBooking`
      // answers 409 CASH_PAYMENT_REQUIRED for it and 500 for everything else,
      // so collapsing the two would turn an actionable prompt into a server
      // error on a live money path.
      if (error.detail?.reasonCode === 'BOOKING_CASH_PAYMENT_REQUIRED') {
        throw new UnpaidCashBookingError();
      }
      throw new Error("Job cannot be completed");
    }
    throw error;
  }

  const completedRes = await dbQuery.query(
    `SELECT * FROM ${dbSchema}.booking_workers
      WHERE booking_id = $1 AND worker_uid = $2
      ORDER BY assigned_at DESC NULLS LAST, id DESC
      LIMIT 1`,
    [bookingId, workerUid],
  );
  const completed = completedRes.rows[0];

  // A replay must not re-run the downstream. Disbursement would be caught by
  // its own conflict clause, but the receipt email would go out twice.
  if (result.idempotentReplay) return completed;

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

  return completed;
};

// ---------------------------------------------------------------------------
// Employee ↔ Services
// ---------------------------------------------------------------------------

let _esColumnsReady: Promise<void> | null = null;

// TAB 02 — schema removed from here. employee_services: status (NOT NULL DEFAULT active), pause_reason, updated_at. The status default is what lets pause/resume be a state change rather than a delete.

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

  // Canonical projection, one family at a time. Fanned out to `services.id`,
  // which is the grain matching keys on — the legacy row is per FAMILY and
  // already implies every bookable service under it, so this widens nothing.
  for (const familyId of serviceIds) {
    await projectFamilyGrantSafely(
      (sql, params) => dbQuery.query(sql, params as any[]),
      dbSchema,
      { providerUid: employeeUid, familyId: Number(familyId), origin: 'admin_grant' },
    );
  }

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

  // ARCHIVED, never deleted: a removed row cannot answer "was this provider
  // ever approved for that service, and when did it stop" — the question a
  // payout dispute asks. Scoped by the family this grant came from, so a
  // service the provider holds through another family is untouched.
  await setFamilyGrantStatusSafely(
    (sql, params) => dbQuery.query(sql, params as any[]),
    dbSchema,
    { providerUid: employeeUid, familyId: Number(serviceId), status: 'archived' },
  );

  return res.rows[0];
};

export const getServicesByEmployee = async (employeeUid: string) => {
  const res = await dbQuery.query(
    `
    SELECT s.id, s.name, s.category, es.created_at AS assigned_at,
           COALESCE(es.status, 'active') AS status, es.pause_reason
    FROM ${dbSchema}.employee_services es
    JOIN ${dbSchema}.service_families s ON s.id = es.service_id
    WHERE es.employee_uid = $1
    ORDER BY s.name
    `,
    [employeeUid]
  );

  return res.rows;
};

export const pauseService = async (workerUid: string, serviceId: number, reason?: string) => {
  const res = await dbQuery.query(
    `UPDATE ${dbSchema}.employee_services
     SET status = 'paused', pause_reason = $3, updated_at = NOW()
     WHERE employee_uid = $1 AND service_id = $2 AND COALESCE(status, 'active') = 'active'
     RETURNING *`,
    [workerUid, serviceId, reason ?? null],
  );
  if (res.rowCount) {
    // The canonical table tracks the pause too, or matching would keep offering
    // a provider who has explicitly stepped back from this service.
    await setFamilyGrantStatusSafely(
      (sql, params) => dbQuery.query(sql, params as any[]),
      dbSchema,
      { providerUid: workerUid, familyId: Number(serviceId), status: 'paused' },
    );
    return res.rows[0];
  }

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
  const res = await dbQuery.query(
    `UPDATE ${dbSchema}.employee_services
     SET status = 'active', pause_reason = NULL, updated_at = NOW()
     WHERE employee_uid = $1 AND service_id = $2 AND COALESCE(status, 'active') = 'paused'
     RETURNING *`,
    [workerUid, serviceId],
  );
  if (res.rowCount) {
    await setFamilyGrantStatusSafely(
      (sql, params) => dbQuery.query(sql, params as any[]),
      dbSchema,
      { providerUid: workerUid, familyId: Number(serviceId), status: 'active' },
    );
    return res.rows[0];
  }

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

// TAB 02 — schema removed from here. worker_bank_accounts, keyed on worker_uid as its PRIMARY KEY — which is what the ON CONFLICT (worker_uid) DO UPDATE upsert below resolves against. One payout destination per provider, enforced by the database.

export const upsertWorkerBankAccount = async (
  workerUid: string,
  payload: { bankCode: string; accountNumber: string; accountName: string }
) => {
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
  const res = await dbQuery.query(
    `SELECT * FROM ${dbSchema}.worker_bank_accounts WHERE worker_uid = $1`,
    [workerUid]
  );

  return res.rows[0] || null;
};

export const deleteWorkerBankAccount = async (workerUid: string) => {
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

// TAB 02 — schema removed from here. worker_availability. providerAvailabilityEngine also created it until TAB 02 removed that copy; this was the other side of that race.

export const getWorkerAvailability = async (uid: string) => {
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

// TAB 02 — schema removed from here. worker_time_off. Same story — providerAvailabilityEngine held the other definition.

export const getWorkerTimeOff = async (uid: string) => {
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

// TAB 02 — schema removed from here. worker_service_areas. providerServiceAreaEngine held the other definition.

export const getWorkerServiceArea = async (uid: string) => {
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

// `ensureOnboardingTable` created `worker_onboarding` on every onboarding
// read or write. Migration 036 owns it — this was the LAST gated deletion,
// deliberately left behind when six sibling bootstraps in this same file
// went, because production lacked the table and a sweep would have taken it
// along with the rest.

export const getWorkerOnboarding = async (uid: string) => {
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

// TAB 02 — schema removed from here. worker_notification_prefs. Every flag is NOT NULL with a default, and promotions defaults FALSE while the rest default TRUE — an absent row means "notify, except marketing", which is the safe reading of no preference.

export const getWorkerNotificationPrefs = async (uid: string) => {
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
