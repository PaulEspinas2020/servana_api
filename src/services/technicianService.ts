import { db } from "../config";
import dbQuery from "../db/dbQuery";
import mongoDb from "../db/mongodbQuery";
import { generateOTP } from "../helpers/otp";
import { send } from "../helpers/mailer";
import { getUserInfoByBookingId } from "./user.service";
import { computeTranspoFee } from "./pricingService";
import { createNotification } from "./notification.service";
import { createDisbursement } from "./disbursement.service";

const dbSchema = db.schema;

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
    SELECT id, file_url, file_name, uploaded_at, requirement_type
    FROM ${dbSchema}.worker_requirements
    WHERE worker_uid = $1
    ORDER BY uploaded_at ASC
    `,
    [workerUid]
  );
  return res.rows.map((f: any) => ({
    id: f.id,
    fileUrl: f.file_url,
    fileName: f.file_name,
    uploadedAt: f.uploaded_at,
    requirementType: f.requirement_type ?? null,
  }));
};

export const deleteWorkerRequirement = async (workerUid: string, id: number) => {
  const res = await dbQuery.query(
    `
    DELETE FROM ${dbSchema}.worker_requirements
    WHERE id = $1 AND worker_uid = $2
    RETURNING id, file_name
    `,
    [id, workerUid]
  );
  if (!res.rowCount) throw new Error("Requirement not found for this worker");
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

    console.log(`No worker assigned — using nearest DB worker distance ${roundedDist} km → transpo_fee ${transpoFee}`);

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

export const assignNearestWorker = async (
  bookingId: number,
  userLat: number,
  userLon: number,
  serviceId?: number | null
) => {

  // 1. Get the booking's schedule for availability check
  const bookingRes = await dbQuery.query(
    `SELECT schedule FROM ${dbSchema}.bookings WHERE id = $1`,
    [bookingId]
  );

  console.log("Booking schedule:", bookingRes.rows[0]?.schedule);

  if (!bookingRes.rowCount) {
    throw new Error("Booking not found");
  }

  const schedule = new Date(bookingRes.rows[0].schedule);
  const windowStart = new Date(schedule.getTime() - 2 * 60 * 60 * 1000);
  const windowEnd   = new Date(schedule.getTime() + 2 * 60 * 60 * 1000);

  // 2. Find UIDs that are busy within ±2h of the booking schedule
  const busyRes = await dbQuery.query(
    `
    SELECT DISTINCT worker_uid
    FROM ${dbSchema}.bookings
    WHERE worker_uid IS NOT NULL
      AND schedule BETWEEN $1 AND $2
      AND status NOT IN ('COMPLETED', 'CANCELED')
      AND id != $3
    `,
    [windowStart, windowEnd, bookingId]
  );
  const busyUids = new Set(busyRes.rows.map((r: any) => r.worker_uid));

  // 3. Get online workers qualified for this service, filter out busy ones
  const onlineWorkers = serviceId
    ? await listOnlineWorkersByService(serviceId)
    : await listOnlineWorkers();

  if (!onlineWorkers.length) {
    await applyNearestWorkerTranspoFee(bookingId, userLat, userLon, serviceId);
    return { assigned: false, reason: "NO_WORKER_ONLINE" };
  }
  console.log(`Found ${onlineWorkers.length} online workers${serviceId ? ` for service ${serviceId}` : ""}`);
  const availableWorkers = onlineWorkers.filter((w: any) => !busyUids.has(w.uid));
  console.log(`After filtering busy workers, ${availableWorkers.length} available workers remain`);
  if (!availableWorkers.length) {
    await applyNearestWorkerTranspoFee(bookingId, userLat, userLon, serviceId);
    return { assigned: false, reason: "NO_WORKER_AVAILABLE" };
  }

  // 4. Rank available workers by distance and pick the nearest
  const ranked = availableWorkers
    .map((w: any) => {
      const [lon, lat] = w.loc.coordinates;
      return {
        uid: w.uid,
        distanceKm: haversineKm(userLat, userLon, lat, lon)
      };
    })
    .sort((a, b) => a.distanceKm - b.distanceKm);

  const best = ranked[0];
    console.log(`Nearest worker: ${best.uid} at ${best.distanceKm.toFixed(2)} km`);
  const avgSpeedKph = 30;
  const etaMinutes = Math.floor(
    Math.max(5, Math.ceil((best.distanceKm / avgSpeedKph) * 60))
  );
  const otpCode = generateOTP();
  const transpoFee = computeTranspoFee(best.distanceKm);
  console.log(`Computed ETA: ${etaMinutes} minutes, OTP: ${otpCode}, Transpo Fee: ${transpoFee}`);
  // Apply transpo fee: add to final_price and persist into pricing_breakdown
  await dbQuery.query(
    `
    UPDATE ${dbSchema}.bookings
    SET worker_uid    = $1,
        status        = 'WORKER_ASSIGNED',
        eta_minutes   = $2::int,
        eta_at        = NOW() + ($2::int * interval '1 minute'),
        worker_code   = $4,
        transpo_fee   = $5,
        final_price   = quoted_price + $5,
        pricing_breakdown = pricing_breakdown || jsonb_build_object(
          'transpo_fee',     $5::numeric,
          'worker_distance', $6::numeric
        )
    WHERE id = $3
    `,
    [best.uid, etaMinutes, bookingId, otpCode, transpoFee, Math.round(best.distanceKm * 100) / 100]
  );

  await dbQuery.query(
    `
    INSERT INTO ${dbSchema}.booking_workers (booking_id, worker_uid, status)
    VALUES ($1,$2,'ASSIGNED')
    `,
    [bookingId, best.uid]
  );

  await dbQuery.query(
    `
    INSERT INTO ${dbSchema}.booking_tracking (booking_id,status,note)
    VALUES ($1,'WORKER_ASSIGNED','Nearest worker assigned')
    `,
    [bookingId]
  );

  // Notify customer that a technician has been assigned
  try {
    const userInfo = await getUserInfoByBookingId(bookingId);
    if (userInfo) {
      const bookingRes = await dbQuery.query(
        `SELECT schedule FROM ${dbSchema}.bookings WHERE id = $1`,
        [bookingId]
      );
      const workerRes = await dbQuery.query(
        `SELECT first_name, last_name FROM ${dbSchema}.user_credentials WHERE uid = $1`,
        [best.uid]
      );
      const schedule = bookingRes.rows[0]?.schedule;
      const workerName = workerRes.rows[0]
        ? `${workerRes.rows[0].first_name} ${workerRes.rows[0].last_name}`
        : "Your technician";
      const etaAt = schedule
        ? new Date(new Date(schedule).getTime() - etaMinutes * 60000).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
        : "";
      send(userInfo.email, "booking_worker_assigned", {
        first_name:   userInfo.firstName,
        booking_id:   bookingId,
        worker_name:  workerName,
        eta_minutes:  etaMinutes,
        eta_at:       etaAt,
        booking_date: schedule ? new Date(schedule).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }) : "",
        booking_time: schedule ? new Date(schedule).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }) : "",
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
    workerDistanceKm: Math.round(best.distanceKm * 100) / 100,
    otpCode
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
      ua.address_one,
      ua.address_two,
      ua.zip_code,
      ua.post_town,
      ua.country,
      b.created_at,
      p.status AS payment_status,
      bw.status AS worker_status,
      bw.assigned_at,
      bw.started_at,
      bw.completed_at
    FROM ${dbSchema}.bookings b
    LEFT JOIN ${dbSchema}.payments p
      ON p.booking_id = b.id
    LEFT JOIN ${dbSchema}.user_address ua
      ON ua.address_id = b.user_address_id
    LEFT JOIN ${dbSchema}.booking_workers bw
      ON bw.booking_id = b.id AND bw.worker_uid = $1
    WHERE b.worker_uid = $1
    ORDER BY b.schedule ASC
    `,
    [workerId]
  );

  return res.rows;
};

export const getJobCardsByWorker = async (workerId: string) => {
  const res = await dbQuery.query(
    `
    SELECT
      b.id AS booking_id,
      b.status,
      b.schedule,

      u.uid AS customer_id,
      u.first_name,
      u.last_name,
      u.phone_number,

      ua.address_one,
      ua.address_two,
      ua.post_town,
      ua.zip_code,
      ua.country,
      ua.label,

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

    LEFT JOIN ${dbSchema}.booking_workers bw
      ON bw.booking_id = b.id AND bw.worker_uid = $1

    WHERE b.worker_uid = $1
    AND bw.status IN ('ASSIGNED','ACCEPTED','IN_PROGRESS','COMPLETED','CANCELED','DECLINED')
    ORDER BY b.schedule ASC
    `,
    [workerId]
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
      AND b.status NOT IN ('COMPLETED', 'CANCELED')
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

  if (!eligibilityRes.rowCount) {
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
  const windowStart = new Date(schedule.getTime() - 2 * 60 * 60 * 1000);
  const windowEnd   = new Date(schedule.getTime() + 2 * 60 * 60 * 1000);

  const conflictRes = await dbQuery.query(
    `
    SELECT id FROM ${dbSchema}.bookings
    WHERE worker_uid = $1
      AND schedule BETWEEN $2 AND $3
      AND status NOT IN ('COMPLETED', 'CANCELED')
      AND id != $4
    LIMIT 1
    `,
    [workerUid, windowStart, windowEnd, bookingId]
  );

  if (conflictRes.rowCount) {
    throw new Error(
      `Worker is not available at ${schedule.toLocaleString("en-US", { month: "long", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" })}. ` +
      `They have an existing booking within a 2-hour window.`
    );
  }

  // 3. Assign the worker
  const res = await dbQuery.query(
    `
    INSERT INTO ${dbSchema}.booking_workers (worker_uid, booking_id, status, assigned_at)
    VALUES ($1, $2, 'ASSIGNED', NOW())
    RETURNING *
    `,
    [workerUid, bookingId]
  );

  if (!res.rowCount) {
    throw new Error("Failed to assign worker");
  }

  // 4. Update the booking with the assigned worker
  await dbQuery.query(
    `UPDATE ${dbSchema}.bookings SET worker_uid = $1, status = 'WORKER_ASSIGNED' WHERE id = $2`,
    [workerUid, bookingId]
  );

  await dbQuery.query(
    `INSERT INTO ${dbSchema}.booking_tracking (booking_id, status, note) VALUES ($1, 'WORKER_ASSIGNED', 'Worker manually assigned')`,
    [bookingId]
  );

  const code = `SVN-${String(bookingId).padStart(6, "0")}`;
  createNotification(workerUid, {
    type: "assigned_job",
    severity: "info",
    title: "New Job Assigned",
    safeBody: `You have been assigned to booking ${code}. Please check your upcoming jobs.`,
    safeContextLabel: code,
    route: { page: "jobs", bookingId: String(bookingId) },
    canOpenDetail: true,
  }).catch((e) => console.error("createNotification (assignWorker):", e));

  return res.rows[0];
};

export const acceptJob = async (bookingId: number, workerUid: string) => {
  const res = await dbQuery.query(
    `
    UPDATE ${dbSchema}.booking_workers
    SET status = 'ACCEPTED'
    WHERE booking_id = $1
    AND worker_uid = $2
    AND status = 'ASSIGNED'
    RETURNING *
    `,
    [bookingId, workerUid]
  );

  if (!res.rowCount) {
    throw new Error("Job not available for acceptance");
  }

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

  return res.rows[0];
};

export const declineJob = async (bookingId: number, workerUid: string) => {
  // 1. Mark the booking_workers row as DECLINED (only if currently ASSIGNED)
  const declineRes = await dbQuery.query(
    `
    UPDATE ${dbSchema}.booking_workers
    SET status = 'DECLINED'
    WHERE booking_id = $1
      AND worker_uid = $2
      AND status = 'ASSIGNED'
    RETURNING *
    `,
    [bookingId, workerUid]
  );

  if (!declineRes.rowCount) {
    throw new Error("No ASSIGNED job found for this worker on this booking");
  }

  // 2. Get booking details needed for re-assignment
  const bookingRes = await dbQuery.query(
    `
    SELECT
      b.schedule,
      b.user_address_id,
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
    VALUES ($1, 'CONFIRMED', 'Worker declined — seeking reassignment')
    `,
    [bookingId]
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
  }

  return {
    declined: true,
    bookingId,
    workerUid,
    reassignment,
  };
};

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
      AND bw.status = 'ACCEPTED'
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

  return res.rows[0];
};

export const completeJob = async (bookingId: number, workerUid: string) => {
  const res = await dbQuery.query(
    `
    UPDATE ${dbSchema}.booking_workers
    SET status = 'COMPLETED',
        completed_at = NOW()
    WHERE booking_id = $1
    AND worker_uid = $2
    AND status = 'IN_PROGRESS'
    RETURNING *
    `,
    [bookingId, workerUid]
  );

  if (!res.rowCount) {
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

  return res.rows[0];
};

// ---------------------------------------------------------------------------
// Employee ↔ Services
// ---------------------------------------------------------------------------

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
  const res = await dbQuery.query(
    `
    SELECT s.id, s.name, s.category, es.created_at AS assigned_at
    FROM ${dbSchema}.employee_services es
    JOIN ${dbSchema}.services s ON s.id = es.service_id
    WHERE es.employee_uid = $1
    ORDER BY s.name
    `,
    [employeeUid]
  );

  return res.rows;
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
      `SELECT COUNT(*) AS total_jobs,
              COALESCE(SUM(CASE WHEN bw.status = 'COMPLETED' THEN 1 ELSE 0 END), 0) AS completed,
              COALESCE(SUM(CASE WHEN bw.status = 'CANCELLED' THEN 1 ELSE 0 END), 0) AS cancelled
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