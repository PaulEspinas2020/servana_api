import { db } from "../config";
import dbQuery from "../db/dbQuery";
import mongoDb from "../db/mongodbQuery";
import { generateOTP } from "../helpers/otp";
import { send } from "../helpers/mailer";
import { getUserInfoByBookingId } from "./user.service";

const dbSchema = db.schema;

export const listWorkersByRole = async (role: number) => {
  const r = await dbQuery.query(
    `
    SELECT uid, email, first_name, last_name, phone_number, role
    FROM ${dbSchema}.user_credentials
    WHERE role = $1
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
      r.role_name,
      r.description
    FROM ${dbSchema}.user_credentials u
    LEFT JOIN ${dbSchema}.roles r
      ON u.role::int = r.role_id
    WHERE u.role::int NOT IN (0, 1, 3)
    ORDER BY u.first_name, u.last_name
    `,
    []
  );

  return r.rows;
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
      r.role_name,
      r.description
    FROM ${dbSchema}.user_credentials u
    LEFT JOIN ${dbSchema}.roles r
      ON u.role::int = r.role_id
    WHERE u.uid = $1
    LIMIT 1;
        `,
    [uid]
  );

  return r.rowCount ? r.rows[0] : null;
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
  workerRole?: number | null
) => {

  // 1. Get the booking's schedule for availability check
  const bookingRes = await dbQuery.query(
    `SELECT schedule FROM ${dbSchema}.bookings WHERE id = $1`,
    [bookingId]
  );

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

  // 3. Get online workers and filter out the busy ones
  const onlineWorkers = workerRole
    ? await listOnlineWorkersByRole(workerRole)
    : await listOnlineWorkers();

  if (!onlineWorkers.length) {
    return { assigned: false, reason: "NO_WORKER_ONLINE" };
  }

  const availableWorkers = onlineWorkers.filter((w: any) => !busyUids.has(w.uid));

  if (!availableWorkers.length) {
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

  const avgSpeedKph = 30;
  const etaMinutes = Math.floor(
  Math.max(5, Math.ceil((best.distanceKm / avgSpeedKph) * 60))
);
  const otpCode = generateOTP();
  await dbQuery.query(
  `
  UPDATE ${dbSchema}.bookings
  SET worker_uid=$1,
      status='WORKER_ASSIGNED',
      eta_minutes=$2::int,
      eta_at = NOW() + ($2::int * interval '1 minute'),
      worker_code = $4
  WHERE id=$3
  `,
  [best.uid, etaMinutes, bookingId, otpCode]
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
    AND bw.status IN ('ASSIGNED','ACCEPTED','IN_PROGRESS','COMPLETED','CANCELED')
    ORDER BY b.schedule ASC
    `,
    [workerId]
  );

  return res.rows;
};

/**
 * Returns workers who have no active booking within a 2-hour window of the requested schedule.
 * Active statuses: PENDING_OTP, CONFIRMED, PAID, WORKER_ASSIGNED, ACCEPTED, IN_PROGRESS
 * Optionally filter by role.
 *
 * @param schedule  ISO datetime string, e.g. "2024-06-01T10:00:00"
 * @param role      Optional worker role number to filter by
 */
export const getAvailableWorkers = async (schedule: string, role?: number) => {
  const requestedTime = new Date(schedule);

  if (isNaN(requestedTime.getTime())) {
    throw new Error("Invalid schedule datetime");
  }

  // Fetch all workers (exclude customer role 3 and admin roles 0/1)
  const workerQuery = role
    ? `SELECT uid, email, first_name, last_name, phone_number, role
       FROM ${dbSchema}.user_credentials
       WHERE role = $1 AND is_archive = false`
    : `SELECT uid, email, first_name, last_name, phone_number, role
       FROM ${dbSchema}.user_credentials
       WHERE role::int NOT IN (0, 1, 3) AND is_archive = false`;

  const workerParams = role ? [role] : [];
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
  // 1. Get the booking's schedule
  const bookingRes = await dbQuery.query(
    `SELECT id, schedule, status FROM ${dbSchema}.bookings WHERE id = $1`,
    [bookingId]
  );

  if (!bookingRes.rowCount) {
    throw new Error("Booking not found");
  }

  const booking = bookingRes.rows[0];
  const schedule = new Date(booking.schedule);

  // 2. Check if the worker already has a conflicting booking within ±2h
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