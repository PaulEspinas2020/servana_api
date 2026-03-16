import { db } from "../config";
import dbQuery from "../db/dbQuery";
import mongoDb from "../db/mongodbQuery";

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

export const getWorkerByUid = async (uid: string) => {
  const r = await dbQuery.query(
    `
    SELECT uid, email, first_name, last_name, phone_number, role
    FROM ${dbSchema}.user_credentials
    WHERE uid = $1
    LIMIT 1
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
  workerRole: number
) => {
  const workers = await listOnlineWorkersByRole(workerRole);

  if (!workers.length) {
    return { assigned: false, reason: "NO_WORKER_ONLINE" };
  }

  const ranked = workers
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
  await dbQuery.query(
  `
  UPDATE ${dbSchema}.bookings
  SET worker_uid=$1,
      status='WORKER_ASSIGNED',
      eta_minutes=$2::int,
      eta_at = NOW() + ($2::int * interval '1 minute')
  WHERE id=$3
  `,
  [best.uid, etaMinutes, bookingId]
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

  return {
    assigned: true,
    worker_uid: best.uid,
    etaMinutes
  };
};
