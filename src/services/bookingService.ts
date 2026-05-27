import { db } from "../config";
import dbQuery from "../db/dbQuery";
const dbSchema = db.schema;
import { generateOTP } from "../helpers/otp";
import { computeQuote } from "./pricingService";

import { checkCoverageGeo } from "../services/serviceService";
import { getLatLonByLocationId } from "../services/address.service";

import { assignNearestWorker } from "../services/technicianService";
import { send } from "../helpers/mailer";
import { getEmailById, getNameByEmail } from "./user.service";

export const createBooking = async (
  userId: string,
  payload: {
    userAddressId: string;
    serviceOptionId: number;
    schedule: string;
    paymentMethod: "CASH" | "GCASH";
    pricing: any;
  }
) => {
  try {

    const svcRes = await dbQuery.query(
      `
      SELECT s.id AS service_id
      FROM ${dbSchema}.service_options so
      JOIN ${dbSchema}.services s ON s.id = so.service_id
      WHERE so.id = $1
      `,
      [payload.serviceOptionId]
    );

    if (!svcRes.rowCount) throw new Error("Invalid service option.");

    const serviceId = Number(svcRes.rows[0].service_id);

    const addressRes = await dbQuery.query(
      `
      SELECT *
      FROM ${dbSchema}.user_address
      WHERE address_id = $1
        AND uid = $2
      `,
      [payload.userAddressId, userId]
    );

    if (!addressRes.rowCount) throw new Error("Invalid address.");

    const address = addressRes.rows[0];
    const locationId = address.location_id || address.locationId;

    if (!locationId) throw new Error("Address missing locationId.");

    const [lon, lat] = await getLatLonByLocationId(String(locationId));

    const cov = await checkCoverageGeo(serviceId, Number(lat), Number(lon));
    if (!cov.covered) throw new Error("Service not available in your area.");

    payload.pricing = payload.pricing || {};
    payload.pricing.optionId = payload.serviceOptionId;

    const quote = await computeQuote(payload.pricing);

    const otp = generateOTP();

    const bookingRes = await dbQuery.query(
      `
      INSERT INTO ${dbSchema}.bookings
        (user_id, user_address_id, service_option_id,
         schedule, payment_method,
         otp_code, status,
         quoted_price, final_price, pricing_breakdown)
      VALUES ($1,$2,$3,$4,$5,$6,'PENDING_OTP',$7,$8,$9)
      RETURNING *
      `,
      [
        userId,
        payload.userAddressId,
        payload.serviceOptionId,
        payload.schedule,
        payload.paymentMethod,
        otp,
        quote.final,
        quote.final,
        quote
      ]
    );

    const booking = bookingRes.rows[0];

    await dbQuery.query(
      `
      INSERT INTO ${dbSchema}.payments (booking_id, method, amount, status)
      VALUES ($1,$2,$3,'PENDING')
      `,
      [booking.id, payload.paymentMethod, quote.final]
    );
    const email = await getEmailById(userId);
    const firstName = await getNameByEmail(email);
     send(email, "verify_booking_otp", {
                first_name: firstName,
                otp_code: booking.otp_code,
                booking_id: booking.id,
                booking_date: booking.schedule.toLocaleDateString("en-US", {
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                }),
                booking_time: booking.schedule.toLocaleTimeString("en-US", {
                    hour: "2-digit",
                    minute: "2-digit",
                })
    });

    return {
      bookingId: booking.id,
      status: booking.status,
      quotedPrice: booking.quoted_price,
      finalPrice: booking.final_price,
      otpDevOnly: otp
    };
  } catch (error) {
    throw error;
  }
};


export const confirmOtp = async (
  bookingId: number,
  otp: string
) => {
  try {
    const r = await dbQuery.query(
      `
      UPDATE ${dbSchema}.bookings
      SET status='CONFIRMED'
      WHERE id=$1
        AND otp_code=$2::text
        AND status='PENDING_OTP'
      RETURNING *
      `,
      [bookingId, otp]
    );

    if (!r.rowCount) {
      throw new Error("Invalid OTP or booking is not in PENDING_OTP.");
    }

    await dbQuery.query(
      `
      INSERT INTO ${dbSchema}.booking_tracking (booking_id,status,note)
      VALUES ($1,'CONFIRMED','OTP verified')
      `,
      [bookingId]
    );

    const bookingRes = await dbQuery.query(
      `
      SELECT
        s.worker_role,
        b.user_address_id,
        ua.location_id
      FROM ${dbSchema}.bookings b
      JOIN ${dbSchema}.service_options so ON so.id=b.service_option_id
      JOIN ${dbSchema}.services s ON s.id=so.service_id
      LEFT JOIN ${dbSchema}.user_address ua ON ua.address_id=b.user_address_id
      WHERE b.id=$1
      `,
      [bookingId]
    );

    if (!bookingRes.rowCount) return r.rows[0];

    const row = bookingRes.rows[0];

    if (!row.user_address_id) return r.rows[0];

    const locationId = row.location_id;
    if (!locationId) throw new Error("Address missing locationId.");

    const [lon, lat] = await getLatLonByLocationId(String(locationId));

    const workerRole =
      row.worker_role !== null
        ? Number(row.worker_role)
        : null;
    await assignNearestWorker(
      bookingId,
      Number(lat),
      Number(lon),
      workerRole
    );

    return r.rows[0];
  } catch (e) {
    throw e;
  }
};


export const getBookingById = async (
  bookingId: number
) => {
  const bookingRes = await dbQuery.query(
    `
    SELECT
      b.*,
      p.status AS payment_status,
      p.method AS payment_method_used,
      p.reference_no,
      p.proof_url,
      br.name AS branch_name,
      br.address AS branch_address,
      br.city AS branch_city,
      ua.address_one AS address,
      ua.post_town AS post_town,
      ua.country AS country,
      ua.zip_code AS zip_code,
      bw.status AS worker_status,
      bw.assigned_at,
      bw.started_at,
      bw.completed_at
    FROM ${dbSchema}.bookings b
    LEFT JOIN ${dbSchema}.payments p
      ON p.booking_id = b.id
    LEFT JOIN ${dbSchema}.branches br
      ON br.id = b.branch_id
    LEFT JOIN ${dbSchema}.user_address ua
      ON ua.address_id = b.user_address_id
    LEFT JOIN ${dbSchema}.booking_workers bw
      ON bw.booking_id = b.id AND bw.status IN ('ASSIGNED','ACCEPTED','IN_PROGRESS','COMPLETED','CANCELED')
    WHERE b.id = $1
    `,
    [bookingId]
  );

  if (!bookingRes.rowCount) return null;

  const addonsRes = await dbQuery.query(
    `
    SELECT
      ba.id,
      ba.addon_option_id,
      ba.qty,
      ba.unit_price,
      so.level_3 AS addon_name
    FROM ${dbSchema}.booking_addons ba
    JOIN ${dbSchema}.service_options so
      ON so.id = ba.addon_option_id
    WHERE ba.booking_id = $1
    ORDER BY ba.id ASC
    `,
    [bookingId]
  );

  return {
    ...bookingRes.rows[0],
    addons: addonsRes.rows,
  };
};

export const getAllBookings = async () => {
  const res = await dbQuery.query(
    `
    SELECT
      b.*,
      u.first_name || ' ' || u.last_name AS customer_name,
      w.first_name || ' ' || w.last_name AS worker_name,
      p.status AS payment_status,
      p.method AS payment_method_used,
      p.reference_no,
      p.proof_url,
      br.name AS branch_name,
      br.address AS branch_address,
      br.city AS branch_city,
      ua.address_one AS address,
      ua.post_town AS post_town,
      ua.country AS country,
      ua.zip_code AS zip_code,
      bw.status AS worker_status,
      bw.assigned_at,
      bw.started_at,
      bw.completed_at
    FROM ${dbSchema}.bookings b
    LEFT JOIN ${dbSchema}.user_credentials u
      ON u.uid = b.user_id
    LEFT JOIN ${dbSchema}.payments p
      ON p.booking_id = b.id
    LEFT JOIN ${dbSchema}.branches br
      ON br.id = b.branch_id
    LEFT JOIN ${dbSchema}.user_address ua
      ON ua.address_id = b.user_address_id
    LEFT JOIN ${dbSchema}.booking_workers bw
      ON bw.booking_id = b.id
      AND bw.status IN ('ASSIGNED','ACCEPTED','IN_PROGRESS','COMPLETED','CANCELED')
    LEFT JOIN ${dbSchema}.user_credentials w
      ON w.uid = bw.worker_uid
    ORDER BY b.created_at DESC
    `,
    []
  );

  return res.rows;
};

export const getBookingsByUserId = async (userId: string) => {
  const res = await dbQuery.query(
    `
    SELECT
      b.*,
      p.status AS payment_status,
      p.method AS payment_method_used,
      p.reference_no,
      p.proof_url,
      br.name AS branch_name,
      br.address AS branch_address,
      br.city AS branch_city,
      ua.address_one AS address,
      ua.post_town AS post_town,
      ua.country AS country,
      ua.zip_code AS zip_code,
      bw.status AS worker_status,
      bw.assigned_at,
      bw.started_at,
      bw.completed_at
    FROM ${dbSchema}.bookings b
    LEFT JOIN ${dbSchema}.payments p
      ON p.booking_id = b.id
    LEFT JOIN ${dbSchema}.branches br
      ON br.id = b.branch_id
    LEFT JOIN ${dbSchema}.user_address ua
      ON ua.address_id = b.user_address_id
    LEFT JOIN ${dbSchema}.booking_workers bw
      ON bw.booking_id = b.id AND bw.status IN ('ASSIGNED','ACCEPTED','IN_PROGRESS','COMPLETED','CANCELED')
    WHERE b.user_id = $1
    ORDER BY b.created_at DESC
    `,
    [userId]
  );

  return res.rows;
};

export const getTracking = async (
  bookingId: number

) => {

  const r = await dbQuery.query(
    `
    SELECT status, note, created_at
    FROM ${dbSchema}.booking_tracking
    WHERE booking_id=$1
    ORDER BY created_at ASC
    `,
    [bookingId]
  );

  return r.rows;
};

export const getDashboardAnalytics = async () => {
  const res = await dbQuery.query(
    `
    WITH latest_status AS (
      SELECT DISTINCT ON (bt.booking_id)
        bt.booking_id,
        bt.status
      FROM ${dbSchema}.booking_workers bt
      ORDER BY bt.booking_id
    ),

    booking_stats AS (
      SELECT
        COUNT(*) AS total_bookings,
        COUNT(*) FILTER (WHERE ls.status IN ('ACCEPTED','IN_PROGRESS')) AS active_jobs,
        COUNT(*) FILTER (WHERE ls.status = 'COMPLETED') AS completed_jobs,
        COUNT(*) FILTER (WHERE ls.status = 'ASSIGNED') AS pending_requests,
        SUM((b.pricing_breakdown->>'total')::NUMERIC)
          FILTER (WHERE ls.status = 'PAID') AS revenue
      FROM ${dbSchema}.bookings b
      LEFT JOIN latest_status ls
        ON ls.booking_id = b.id
    ),

    revenue_stats AS (
      SELECT 
        COALESCE(SUM(amount), 0) AS revenue
      FROM ${dbSchema}.payments
      WHERE status = 'PAID'
    ),

    user_stats AS (
      SELECT
        COUNT(*) FILTER (WHERE role::int = 3) AS total_customers,
        COUNT(*) FILTER (WHERE role::integer NOT IN (0,1,3)) AS total_workers
      FROM ${dbSchema}.user_credentials
    ),

    status_breakdown AS (
      SELECT
        COUNT(*) FILTER (WHERE status = 'ASSIGNED') AS assigned,
        COUNT(*) FILTER (WHERE status = 'ACCEPTED') AS accepted,
        COUNT(*) FILTER (WHERE status = 'IN_PROGRESS') AS in_progress,
        COUNT(*) FILTER (WHERE status = 'COMPLETED') AS completed,
        COUNT(*) FILTER (WHERE status = 'CANCELED') AS canceled
      FROM latest_status
    )

    SELECT
      bs.total_bookings,
      bs.active_jobs,
      bs.completed_jobs,
      bs.pending_requests,
      rs.revenue,

      us.total_customers,
      us.total_workers,

      json_build_object(
        'ASSIGNED', sb.assigned,
        'ACCEPTED', sb.accepted,
        'IN_PROGRESS', sb.in_progress,
        'COMPLETED', sb.completed,
        'CANCELED', sb.canceled
      ) AS job_status_breakdown

    FROM booking_stats bs
    CROSS JOIN revenue_stats rs
    CROSS JOIN user_stats us
    CROSS JOIN status_breakdown sb
    `,
    []
  );

  return res.rows[0];
};