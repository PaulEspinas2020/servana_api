import { db } from "../config";
import dbQuery from "../db/dbQuery";
const dbSchema = db.schema;
import { generateOTP } from "../helpers/otp";
import { computeQuote } from "./pricingService";

import { checkCoverageGeo } from "../services/serviceService";
import { getLatLonByLocationId } from "../services/address.service"; // returns [lon, lat]

import { assignNearestWorker } from "../services/technicianService";

// computeQuote, generateOTP, dbQuery, dbSchema assumed imported/available

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
        // 1) Validate selected option + get service id
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

        // 2) Validate address belongs to user
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

        // 3) Get lat/lon from Mongo
        const [lon, lat] = await getLatLonByLocationId(String(locationId));

        // 4) Geo coverage check
        const cov = await checkCoverageGeo(serviceId, Number(lat), Number(lon));
        if (!cov.covered) throw new Error("Service not available in your area.");

        // 5) Compute quote
        payload.pricing = payload.pricing || {};
        payload.pricing.optionId = payload.serviceOptionId;

        const quote = await computeQuote(payload.pricing);

        // 6) OTP
        const otp = generateOTP();

        // 7) Create booking
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

        // 8) Create payment row
        await dbQuery.query(
            `
      INSERT INTO ${dbSchema}.payments (booking_id, method, amount, status)
      VALUES ($1,$2,$3,'PENDING')
      `,
            [booking.id, payload.paymentMethod, quote.final]
        );

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

    await assignNearestWorker(
      bookingId,
      Number(lat),
      Number(lon),
      Number(row.worker_role)
    );

    return r.rows[0];
  } catch (e) {
    throw e;
  }
};

/**
 * Get booking details
 * Returns booking + payment + addons + (branch or address details if present)
 */
export const getBookingById = async (
    bookingId: number
    // userId?: string
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
      ua.zip_code AS zip_code
    FROM ${dbSchema}.bookings b
    LEFT JOIN ${dbSchema}.payments p
      ON p.booking_id = b.id
    LEFT JOIN ${dbSchema}.branches br
      ON br.id = b.branch_id
    LEFT JOIN ${dbSchema}.user_address ua
      ON ua.address_id = b.user_address_id
    WHERE b.id = $1
    `,
        [bookingId]
    );

    if (!bookingRes.rowCount) return null;

    // Optional ownership check:
    // if (userId && bookingRes.rows[0].user_id !== userId) throw new Error("Forbidden");

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

/**
 * Get tracking history
 */
export const getTracking = async (
    bookingId: number
    // userId?: string
) => {
    // Optional ownership check:
    // const own = await dbQuery.query(`SELECT user_id FROM ${dbSchema}.bookings WHERE id=$1`, [bookingId]);
    // if (!own.rowCount) throw new Error("Booking not found");
    // if (userId && own.rows[0].user_id !== userId) throw new Error("Forbidden");

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
