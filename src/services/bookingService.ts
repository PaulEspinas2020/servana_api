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
import { closeConversationForCancellation } from "../chat/chat.service";
import { toCamel } from "../helpers/idGenerator";
import { assertBookingAccess } from "./bookingAccessService";

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

    // transpo_fee starts at 0 — updated with actual amount when a worker is assigned
    const initialBreakdown = { ...quote, transpo_fee: 0, worker_distance: null };

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
        initialBreakdown
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
    // Best-effort: the booking and its payment row are already committed above.
    // Anything that goes wrong from here is a NOTIFICATION failure, and failing
    // the request for it would tell the customer their booking did not happen
    // while it sits in the database — which is exactly what used to occur.
    //
    // `booking.schedule` is a STRING, not a Date. dbQuery.ts installs a global
    // node-postgres type parser (OIDs 1114/1184) that renders every timestamp as
    // a UTC ISO 8601 string, deliberately, so no value in this codebase is ever
    // a Date object. Calling .toLocaleDateString() straight on it threw
    // `TypeError: booking.schedule.toLocaleDateString is not a function` — and
    // because the argument list is evaluated BEFORE send() is invoked, the throw
    // escaped createBooking entirely. Every booking creation returned an error
    // to the app after having written the booking and payment rows, so customers
    // saw a failure and retried, each retry orphaning another row.
    try {
      const email = await getEmailById(userId);
      const firstName = await getNameByEmail(email);
      send(email, "verify_booking_otp", {
        first_name: firstName,
        otp_code: booking.otp_code,
        booking_id: booking.id,
        booking_date: booking.schedule
          ? new Date(booking.schedule).toLocaleDateString("en-US", {
              year: "numeric",
              month: "long",
              day: "numeric",
            })
          : "",
        booking_time: booking.schedule
          ? new Date(booking.schedule).toLocaleTimeString("en-US", {
              hour: "2-digit",
              minute: "2-digit",
            })
          : "",
      });
    } catch (mailErr) {
      console.error(
        `[createBooking] booking ${booking.id} created; OTP email failed:`,
        mailErr,
      );
    }

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


/**
 * Re-issues the booking OTP and re-sends the email.
 *
 * The OTP screen's Resend button called POST /api/:bookingId/resend-otp, which
 * did not exist — a comment in the client even said so
 * (servana_api_client.dart:594 "must exist on the backend"). So a customer whose
 * verification email never arrived had no recovery at all: the booking sat in
 * PENDING_OTP, the only route out was an OTP they did not have, and the code has
 * no expiry to force a new one.
 *
 * A NEW code is generated rather than re-sending the old one. Re-sending would
 * make every superseded email valid forever, which turns a delivery problem into
 * a security one.
 *
 * Restricted to PENDING_OTP. Re-issuing against a booking that is already
 * confirmed, cancelled or completed would move it backwards, and an OTP for a
 * finished job is only useful to someone who should not have one.
 */
export const resendBookingOtp = async (bookingId: number) => {
  const res = await dbQuery.query(
    `SELECT id, user_id, status, schedule FROM ${dbSchema}.bookings WHERE id = $1`,
    [bookingId],
  );
  if (!res.rowCount) throw new Error('Booking not found');

  const booking = res.rows[0];
  if (String(booking.status).toUpperCase() !== 'PENDING_OTP') {
    throw Object.assign(
      new Error('This booking is no longer awaiting verification.'),
      { statusCode: 409 },
    );
  }

  const otp = generateOTP();
  await dbQuery.query(
    `UPDATE ${dbSchema}.bookings SET otp_code = $1 WHERE id = $2`,
    [otp, bookingId],
  );

  // Best-effort: the code IS rotated regardless of whether the mail goes out.
  // Failing here would leave the customer holding a code that no longer works,
  // which is worse than a missing email.
  try {
    const email = await getEmailById(booking.user_id);
    const firstName = await getNameByEmail(email);
    send(email, 'verify_booking_otp', {
      first_name: firstName,
      otp_code: otp,
      booking_id: bookingId,
      booking_date: booking.schedule
        ? new Date(booking.schedule).toLocaleDateString('en-US', {
            year: 'numeric', month: 'long', day: 'numeric',
          })
        : '',
      booking_time: booking.schedule
        ? new Date(booking.schedule).toLocaleTimeString('en-US', {
            hour: '2-digit', minute: '2-digit',
          })
        : '',
    });
  } catch {
    // Swallowed deliberately — see above.
  }

  // The code itself is never returned: it travels by email only.
  return { bookingId, resent: true };
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
        so.service_id,
        b.user_address_id,
        ua.location_id
      FROM ${dbSchema}.bookings b
      JOIN ${dbSchema}.service_options so ON so.id = b.service_option_id
      LEFT JOIN ${dbSchema}.user_address ua ON ua.address_id = b.user_address_id
      WHERE b.id = $1
      `,
      [bookingId]
    );

    if (!bookingRes.rowCount) return r.rows[0];

    const row = bookingRes.rows[0];

    if (!row.user_address_id) return r.rows[0];

    const locationId = row.location_id;
    if (!locationId) throw new Error("Address missing locationId.");

    const [lon, lat] = await getLatLonByLocationId(String(locationId));

    const serviceId = row.service_id ? Number(row.service_id) : null;
    await assignNearestWorker(
      bookingId,
      Number(lat),
      Number(lon),
      serviceId
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
      -- Service identity. This query joined payments, branches, addresses and
      -- workers but never the service itself, so the detail response carried no
      -- name for the thing being booked. The customer app reads serviceName and
      -- falls back to an empty string, which rendered the booking detail as a
      -- bare "Service" label with nothing beside it.
      --
      -- Column choice follows the existing convention rather than inventing one:
      -- so.level_2 AS service_name matches providerController and scheduler,
      -- so.level_3 is the specific option (what the addons query already calls
      -- addon_name), and services.name is the family the option belongs to.
      so.service_id,
      so.level_2 AS service_name,
      so.level_3 AS service_option_name,
      s.name     AS service_category,
      COALESCE(ua.address_one, b.service_address->>'addressLine') AS address,
      COALESCE(ua.post_town,   b.service_address->>'city')        AS post_town,
      ua.country AS country,
      ua.zip_code AS zip_code,
      bw.status AS worker_status,
      bw.assigned_at,
      bw.started_at,
      bw.completed_at,
      -- The customer app reads etaMinutes on the booking detail screen.
      -- booking_workers was joined for its status and timestamps but never for
      -- the ETA, so the key was always absent from the response and the app had
      -- nothing to show.
      bw.eta_minutes,
      -- Money. The app renders "Amount" from totalAmount, which is not a column
      -- on this table and never was — bookings stores quoted_price and
      -- final_price. The key was simply missing from the payload, the client's
      -- zero default took over, and every booking detail displayed a total of
      -- zero. Aliased rather than renamed so quotedPrice/finalPrice keep
      -- working for the admin portal and the provider app.
      COALESCE(b.final_price, b.quoted_price) AS total_amount
    FROM ${dbSchema}.bookings b
    LEFT JOIN ${dbSchema}.payments p
      ON p.booking_id = b.id
    LEFT JOIN ${dbSchema}.service_options so
      ON so.id = b.service_option_id
    LEFT JOIN ${dbSchema}.services s
      ON s.id = so.service_id
    LEFT JOIN ${dbSchema}.branches br
      ON br.id = b.branch_id
    LEFT JOIN ${dbSchema}.user_address ua
      ON ua.address_id = b.user_address_id
    LEFT JOIN ${dbSchema}.booking_workers bw
      ON bw.booking_id = b.id AND bw.status IN ('ASSIGNED','ACCEPTED','IN_PROGRESS','COMPLETED','CANCELED','CANCELLED','DECLINED')
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

export const getAllBookings = async (from?: string, to?: string) => {
  const params: string[] = [];
  let whereClause = '';

  if (from && to) {
    params.push(from, to);
    whereClause = `WHERE b.schedule >= $1 AND b.schedule < $2`;
  }

  const res = await dbQuery.query(
    `
    SELECT
      b.*,
      so.service_id,
      u.first_name || ' ' || u.last_name AS customer_name,
      w.first_name || ' ' || w.last_name AS worker_name,
      p.status AS payment_status,
      p.method AS payment_method_used,
      p.reference_no,
      p.proof_url,
      br.name AS branch_name,
      br.address AS branch_address,
      br.city AS branch_city,
      COALESCE(ua.address_one, b.service_address->>'addressLine') AS address,
      COALESCE(ua.post_town,   b.service_address->>'city')        AS post_town,
      ua.country AS country,
      ua.zip_code AS zip_code,
      bw.status AS worker_status,
      bw.assigned_at,
      bw.started_at,
      bw.completed_at
    FROM ${dbSchema}.bookings b
    LEFT JOIN ${dbSchema}.service_options so
      ON so.id = b.service_option_id
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
      AND bw.status IN ('ASSIGNED','ACCEPTED','IN_PROGRESS','COMPLETED','CANCELED','CANCELLED','DECLINED')
    LEFT JOIN ${dbSchema}.user_credentials w
      ON w.uid = bw.worker_uid
    ${whereClause}
    ORDER BY b.created_at DESC
    `,
    params
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
      -- Admin-created bookings store address in service_address JSONB; COALESCE
      -- ensures customer mobile always receives a readable address line.
      COALESCE(ua.address_one, b.service_address->>'addressLine') AS address,
      COALESCE(ua.post_town,   b.service_address->>'city')        AS post_town,
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
      ON bw.booking_id = b.id AND bw.status IN ('ASSIGNED','ACCEPTED','IN_PROGRESS','COMPLETED','CANCELED','CANCELLED','DECLINED')
    -- Guest bookings surface to a registered customer only through the
    -- explicit link an admin created (linked_customer_uid, alongside
    -- linked_at / linked_by_admin_uid / link_reason). That link is deliberate
    -- and audited, which is what §8 requires — a guest is never automatically
    -- converted to a client.
    --
    -- This previously joined user_credentials and matched the two tables'
    -- phone columns. That was wrong twice over. The column it named on
    -- guest_customers does not exist (the table stores phone_normalized), so
    -- the subquery raised at runtime and took the whole booking list with it.
    -- And had it existed, matching an unverified, non-unique phone number
    -- would have handed one customer another's guest bookings — anyone who
    -- ever gave Servana the same number, including a recycled or mistyped one.
    WHERE (
      b.user_id = $1
      OR b.guest_customer_id IN (
        SELECT gc.guest_customer_id
        FROM ${dbSchema}.guest_customers gc
        WHERE gc.linked_customer_uid = $1
      )
    )
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
        COUNT(*) FILTER (WHERE role::int = 2) AS total_workers
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

/**
 * SWEEP Field Parity — Booking Entity Formatter
 *
 * Converts a raw DB booking row to a cross-platform normalised shape:
 *   - Keeps every field toCamel() produces (preserves mobile/web contracts)
 *   - Adds alias fields so every platform finds the name it expects:
 *       id / bookingId          — booking primary key
 *       schedule / scheduleAt / scheduledAt — appointment datetime
 *       workerUid / providerUid — assigned provider Firebase UID
 *       userId / customerId / customerUid — customer Firebase UID
 *       status / statusLower    — booking status (UPPERCASE + lowercase variant)
 *       workerStatus / assignmentStatus — booking_workers.status
 *       bookingCode             — human-readable SVN-XXXXXX code
 *
 * NON-DESTRUCTIVE: never overwrites an existing field.
 * Booking `id` = numeric PK, NOT a Firebase UID — applyParity() is NOT used
 * here to avoid the id→uid alias collision that applies only to user objects.
 */
export const formatBooking = (raw: any): Record<string, unknown> => {
  const c: any = toCamel(raw);

  const bookingPk = c.id ?? raw.id;
  const scheduleVal = c.schedule ?? raw.schedule ?? null;
  const workerUidVal = c.workerUid ?? raw.worker_uid ?? null;
  const userIdVal = c.userId ?? raw.user_id ?? null;
  const statusVal: string = (c.status ?? raw.status ?? '');
  const workerStatusVal = c.workerStatus ?? raw.worker_status ?? null;

  return {
    ...c,
    // Booking ID aliases
    ...(bookingPk !== undefined && !('bookingId' in c) ? { bookingId: bookingPk } : {}),
    bookingCode: c.bookingCode ?? `SVN-${String(bookingPk).padStart(6, '0')}`,
    // Schedule aliases
    ...(scheduleVal !== null && !('scheduleAt' in c)  ? { scheduleAt:  scheduleVal } : {}),
    ...(scheduleVal !== null && !('scheduledAt' in c) ? { scheduledAt: scheduleVal } : {}),
    // Provider/worker UID aliases
    ...(workerUidVal !== null && !('providerUid' in c) ? { providerUid: workerUidVal } : {}),
    // Customer UID aliases
    ...(userIdVal !== null && !('customerId'  in c) ? { customerId:  userIdVal } : {}),
    ...(userIdVal !== null && !('customerUid' in c) ? { customerUid: userIdVal } : {}),
    // Status: UPPERCASE from DB stays, lowercase variant added for platforms that normalise
    ...(statusVal && !('statusLower' in c) ? { statusLower: statusVal.toLowerCase() } : {}),
    // Worker/assignment status aliases
    ...(workerStatusVal !== null && !('assignmentStatus' in c) ? { assignmentStatus: workerStatusVal } : {}),
  };
};

export const formatBookings = (rows: any[]): Record<string, unknown>[] =>
  rows.map(formatBooking);

// ─── Customer Self-Cancel (BACKEND_GAP-C15-001 implementation) ────────────────

const NON_CANCELLABLE_STATUSES = new Set([
  'CANCELLED', 'CANCELED', 'COMPLETED', 'IN_PROGRESS',
  'EN_ROUTE', 'ARRIVED', 'AWAITING_COMPLETION',
  'REVIEWED', 'REFUNDED', 'EXPIRED', 'FAILED',
]);

/**
 * Allows a customer to cancel their own booking.
 *
 * Ownership: if customerUid is provided, the booking must belong to that customer.
 * State guard: terminal and in-progress states cannot be cancelled.
 */
export const customerCancelBooking = async (
  bookingId: number,
  reason: string,
  customerUid: string | null,
  reasonCode?: string,
): Promise<any> => {
  if (!reason?.trim()) throw new Error('Reason is required');

  const bkRes = await dbQuery.query(
    `SELECT id, status, user_id FROM ${dbSchema}.bookings WHERE id = $1`,
    [bookingId],
  );
  if (!bkRes.rowCount) throw new Error('Booking not found');

  const { status: prevStatus } = bkRes.rows[0];

  // This used to be an inline three-term conjunction: caller present, owner
  // present, owner differs — throw. It failed open twice over.
  //
  // `bookings.user_id` is NULL on a guest booking, so the owner-present term was
  // falsy and the whole check short-circuited: ANY authenticated caller could
  // cancel ANY guest booking. A null caller skipped the check for the same
  // reason — the same anonymous-bypass shape bd8c355 removed from the middleware
  // layer, still living one layer down in the service. Deleting the middleware
  // removed the carrier, not the pattern.
  //
  // The literal expression is deliberately not reproduced here: a regression
  // test greps this function for it, and quoting it in a comment would defeat
  // that (tests/guest-booking-cancel.test.ts).
  //
  // assertBookingAccess fails closed and understands admin-linked guest
  // ownership, so a linked customer keeps the ability to cancel their own.
  const actorRole = await assertBookingAccess(bookingId, customerUid);
  if (actorRole === 'provider') {
    // Providers decline or reassign; they do not cancel on the customer's
    // behalf, and this route writes a 'cancelled by customer' timeline event.
    throw Object.assign(new Error('Access denied'), { statusCode: 403 });
  }

  if (NON_CANCELLABLE_STATUSES.has((prevStatus ?? '').toUpperCase())) {
    throw new Error(`Cannot cancel booking with status: ${prevStatus}`);
  }

  await dbQuery.query(
    `UPDATE ${dbSchema}.bookings SET status = 'CANCELLED', cancelled_at = NOW() WHERE id = $1`,
    [bookingId],
  );

  await dbQuery.query(
    `UPDATE ${dbSchema}.booking_workers SET status = 'CANCELLED'
     WHERE booking_id = $1 AND status IN ('ASSIGNED','ACCEPTED','EN_ROUTE','ARRIVED')`,
    [bookingId],
  );

  await dbQuery.query(
    `INSERT INTO ${dbSchema}.booking_timeline_events
       (booking_id, event_type, title, description, actor_type, actor_uid, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      bookingId, 'booking_cancelled', 'Booking cancelled by customer',
      reason, 'customer', customerUid ?? null,
      reasonCode ? JSON.stringify({ reasonCode }) : null,
    ],
  );

  // Close the conversation on the customer-cancelled path too. Both cancel
  // routes must behave identically or a cancelled booking stays a live private
  // channel depending only on who pressed the button.
  (async () => {
    try {
      await closeConversationForCancellation(bookingId);
    } catch (err) {
      console.error('[cancel] chat close failed', bookingId, err);
    }
  })();

  const updatedRes = await dbQuery.query(
    `SELECT * FROM ${dbSchema}.bookings WHERE id = $1`,
    [bookingId],
  );
  return updatedRes.rows[0] ?? { id: bookingId, status: 'CANCELLED' };
};