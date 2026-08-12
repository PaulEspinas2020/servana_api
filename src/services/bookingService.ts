import { db } from "../config";
import { deriveEffectiveBookingStatus } from "./bookingStatusProjection";
import dbQuery, { pool } from "../db/dbQuery";
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
import { assertBookingAccess, BookingAccessError } from "./bookingAccessService";
import {
  buildBookingTimeline,
  currentTimelineStep,
  mergeStoredEvents,
  projectTimelineForCustomer,
} from "../controllers/bookingTimeline";
import { notifyAdminsSafely } from './adminNotificationService';
import { transitionBooking, TransitionError } from './booking/transitionExecutor';

export const createBooking = async (
  userId: string,
  payload: {
    userAddressId: string;
    serviceOptionId: number;
    branchId?: number;
    schedule: string;
    paymentMethod: "CASH" | "GCASH" | "PAYMONGO";
    pricing: any;
  },
  idempotencyKey?: string | null,
) => {
  try {

    const svcRes = await dbQuery.query(
      `
      SELECT s.id AS service_id
      FROM ${dbSchema}.service_options so
      JOIN ${dbSchema}.service_families s ON s.id = so.service_id
      WHERE so.id = $1
        AND so.option_type = 'MAIN'
        AND so.is_active = true
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

    // A booking and its authoritative payment row are one domain write. Using
    // pool.query twice could commit the booking first and then fail the payment
    // insert, leaving an orphan that the idempotency record never sees. A retry
    // would then create a second booking. Keep both writes on one checked-out
    // client and commit them together.
    const client = await pool.connect();
    let booking: any;
    try {
      await client.query('BEGIN');
      if (payload.branchId !== undefined) {
        // Lock the concrete branch slot before counting and inserting. This
        // makes capacity enforcement atomic under concurrent checkouts.
        const slotRes = await client.query(
          `SELECT bs.max_capacity
             FROM ${dbSchema}.branch_slots bs
             JOIN ${dbSchema}.branches br ON br.id = bs.branch_id
            WHERE bs.branch_id = $1
              AND br.service_id = $2
              AND br.is_active = TRUE
              AND bs.slot_time::time = ($3::timestamptz AT TIME ZONE 'Asia/Manila')::time
            FOR UPDATE OF bs`,
          [payload.branchId, serviceId, payload.schedule],
        );
        if (!slotRes.rowCount) {
          throw Object.assign(new Error('The selected branch slot is no longer available.'), {
            statusCode: 409,
            code: 'SLOT_UNAVAILABLE',
          });
        }
        const bookedRes = await client.query(
          `SELECT COUNT(*)::integer AS booked_count
             FROM ${dbSchema}.bookings b
            WHERE b.branch_id = $1
              AND (b.schedule AT TIME ZONE 'Asia/Manila')::date =
                  ($2::timestamptz AT TIME ZONE 'Asia/Manila')::date
              AND (b.schedule AT TIME ZONE 'Asia/Manila')::time =
                  ($2::timestamptz AT TIME ZONE 'Asia/Manila')::time
              AND UPPER(COALESCE(b.status, '')) NOT IN
                  ('CANCELLED','CANCELED','COMPLETED','REVIEWED','EXPIRED','FAILED','REFUNDED')`,
          [payload.branchId, payload.schedule],
        );
        if (Number(bookedRes.rows[0]?.booked_count ?? 0) >= Number(slotRes.rows[0].max_capacity)) {
          throw Object.assign(new Error('That branch slot just filled up. Choose another time.'), {
            statusCode: 409,
            code: 'SLOT_FULL',
          });
        }
      }
      // Catalog V2 dual-write.
      //
      // Migration 020 added `bookings.catalog_service_id` and its comment reads
      // "written only from Phase 4, for NEW bookings". Phase 4 was never built,
      // so migration 021 backfilled history and then nothing ever wrote the
      // column again — measured on production: 109 of 111 bookings carry it,
      // and the two most recent, created after the backfill, are NULL. A
      // canonical column that only history populates is worse than an absent
      // one, because a reader cannot tell "not migrated" from "new booking".
      //
      // The subselect, not `payload.serviceOptionId` directly, is the point.
      // Canonical `services.id` currently EQUALS the legacy option id for all
      // 95 promoted rows, so copying the value would look correct today and
      // silently write a dangling id the moment a Service is created through
      // the Admin API — those take their id from `catalog_services_id_seq` and
      // have no legacy option at all. Resolving through
      // `legacy_service_option_id` stays correct on both sides of that change.
      //
      // NULL when the option has no canonical Service (the 5 active ADD_ON
      // rows, which are configuration and were never promoted). `service_option_id`
      // remains authoritative and is untouched, so no reader moves (§4).
      const bookingRes = await client.query(
        `
        INSERT INTO ${dbSchema}.bookings
          (user_id, user_address_id, service_option_id, catalog_service_id,
           schedule, payment_method, branch_id,
           otp_code, status,
           quoted_price, final_price, pricing_breakdown)
        VALUES (
          $1,$2,$3,
          (SELECT s.id FROM ${dbSchema}.services s WHERE s.legacy_service_option_id = $3),
          $4,$5,$6,$7,'PENDING_OTP',$8,$9,$10
        )
        RETURNING *
        `,
        [
          userId,
          payload.userAddressId,
          payload.serviceOptionId,
          payload.schedule,
          payload.paymentMethod,
          payload.branchId ?? null,
          otp,
          quote.final,
          quote.final,
          initialBreakdown
        ]
      );
      booking = bookingRes.rows[0];

      await client.query(
        `
        INSERT INTO ${dbSchema}.payments (booking_id, method, amount, status)
        VALUES ($1,$2,$3,'PENDING')
        `,
        [booking.id, payload.paymentMethod, quote.final]
      );
      if (idempotencyKey) {
        await client.query(
          `INSERT INTO ${dbSchema}.booking_create_idempotency
             (idempotency_key, actor_uid, booking_id)
           VALUES ($1, $2, $3)`,
          [idempotencyKey, userId, booking.id],
        );
      }
      await client.query('COMMIT');
    } catch (writeError) {
      await client.query('ROLLBACK').catch(() => {});
      throw writeError;
    } finally {
      client.release();
    }
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

    notifyAdminsSafely({
      type: 'new_booking', severity: 'info', title: 'New booking created',
      body: `Booking SVN-${String(booking.id).padStart(6, '0')} was created and is awaiting confirmation.`,
      bookingId: Number(booking.id), notificationKey: `booking_created_${booking.id}`,
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
    `SELECT id, user_id, status, schedule, worker_uid FROM ${dbSchema}.bookings WHERE id = $1`,
    [bookingId],
  );
  if (!res.rowCount) throw new Error('Booking not found');

  const booking = res.rows[0];
  const status = String(booking.status).toUpperCase();
  const awaitsOtp = status === 'PENDING_OTP' ||
    (status === 'PAID' && !booking.worker_uid);
  if (!awaitsOtp) {
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

/**
 * ─── PHASE C · CUSTOMER_CONFIRM_OTP, on the canonical executor ───────────────
 *
 * The customer proves presence with the booking OTP, and the booking is
 * released to the assignment pool.
 *
 * ## What was preserved, deliberately and in full
 *
 * The booking OTP has NO expiry, NO attempt limit and is NOT consumed — all
 * three absent by construction, not by oversight: `resendBookingOtp`'s own
 * docblock states the code has no expiry. Adding any of them here would be a
 * product-policy change wearing a refactor's clothes, so none was added. Replay
 * still errors rather than answering 200, because installed clients were built
 * against that.
 *
 * The credential predicate stays IN the write, exactly as the legacy
 * compare-and-swap had it. What did NOT come with it is the other half of that
 * statement — `status = 'PENDING_OTP' OR (status = 'PAID' AND worker_uid IS
 * NULL)` — which was a second state machine written in SQL. The canonical
 * machine decides legality now; the predicate is only for the credential.
 *
 * ## One behaviour change, and it is a bug fix
 *
 * The legacy sequence committed the status write, then inserted tracking, then
 * looked up the address for auto-assignment — and threw
 * `Error("Address missing locationId.")` if the address had no location. The
 * customer received HTTP 400 for a booking that was ALREADY confirmed.
 *
 * The address is needed only for auto-assignment: every earlier branch
 * (`no rows`, `no user_address_id`) returned the confirmed booking
 * successfully. So the coupling was accidental, and it is gone. Confirmation
 * commits, and a failure to find a provider afterwards leaves the booking
 * CONFIRMED with no worker — which is AWAITING_ASSIGNMENT, exactly the queue an
 * admin watches for bookings needing a provider.
 *
 * ## Authorization
 *
 * `assertBookingAccess` stays in the controller for now, and the executor
 * independently refuses a customer who does not own the booking. That is
 * duplicated ENFORCEMENT, not duplicated policy — and the executor's is the
 * one that cannot be bypassed by a caller that never touched HTTP. The
 * controller check is removed when the legacy endpoint migrates.
 */
export const confirmOtp = async (
  bookingId: number,
  otp: string,
  options: { actorUid?: string | null; correlationId?: string } = {},
) => {
  try {
    await transitionBooking({
      action: 'CUSTOMER_CONFIRM_OTP',
      bookingId,
      actorRole: options.actorUid ? 'customer' : 'admin',
      actorUid: options.actorUid ?? null,
      correlationId: options.correlationId,
      metadata: { otp },
    });
  } catch (error) {
    // The legacy message, byte for byte: both callers surface `e.message`
    // directly and answer 400 for every failure here.
    if (error instanceof TransitionError) {
      throw new Error("Invalid OTP or booking is not in PENDING_OTP.");
    }
    throw error;
  }

  const confirmed = await dbQuery.query(
    `SELECT * FROM ${dbSchema}.bookings WHERE id = $1`,
    [bookingId],
  );
  const booking = confirmed.rows[0];

  /**
   * Auto-assignment, AFTER the commit and unable to fail the confirmation.
   *
   * TAB 05 owns who gets assigned. What matters here is that the customer is
   * told their booking is confirmed — because it is — and a booking left
   * without a provider surfaces to an admin as awaiting assignment rather than
   * as a 400 the customer cannot act on.
   */
  try {
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

    const row = bookingRes.rows[0];
    if (row?.user_address_id && row.location_id) {
      const [lon, lat] = await getLatLonByLocationId(String(row.location_id));
      await assignNearestWorker(
        bookingId,
        Number(lat),
        Number(lon),
        row.service_id ? Number(row.service_id) : null,
      );
    }
  } catch (assignErr) {
    // Never surfaced to the customer: the booking IS confirmed, and telling
    // them otherwise is the defect this replaced.
    console.error(`auto-assignment after OTP confirm failed for booking ${bookingId}:`, assignErr);
  }

  return booking;
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
      -- Travel ETA belongs to the booking assignment projection and is stored
      -- on bookings by the assignment transaction.
      b.eta_minutes,
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
    LEFT JOIN ${dbSchema}.service_families s
      ON s.id = so.service_id
    LEFT JOIN ${dbSchema}.branches br
      ON br.id = b.branch_id
    LEFT JOIN ${dbSchema}.user_address ua
      ON ua.address_id = b.user_address_id
    LEFT JOIN LATERAL (
      SELECT bw0.* FROM ${dbSchema}.booking_workers bw0
      WHERE bw0.booking_id = b.id
      ORDER BY bw0.assigned_at DESC NULLS LAST, bw0.id DESC
      LIMIT 1
    ) bw ON TRUE
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
    LEFT JOIN LATERAL (
      SELECT bw0.* FROM ${dbSchema}.booking_workers bw0
      WHERE bw0.booking_id = b.id
      ORDER BY bw0.assigned_at DESC NULLS LAST, bw0.id DESC
      LIMIT 1
    ) bw ON TRUE
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
      -- Service identity and money, matching the detail query above.
      --
      -- The detail query gained these joins when the booking detail screen was
      -- found rendering a bare "Service" label with nothing beside it. The LIST
      -- query was never given the same treatment, so every consumer that shows
      -- a list of bookings has had to invent the name of the thing booked.
      --
      -- The customer app's live list mapper does exactly that
      -- (http_backend.dart:491-502): it digs the name out of
      -- pricingBreakdown.addons[0].level_3 and, when a booking has no addons,
      -- falls back to the literal string 'Beauty & Wellness'. A plumbing
      -- booking with no addons is currently labelled Beauty & Wellness in a
      -- shipped app. That is not a name the customer chose and not one anybody
      -- can act on.
      --
      -- Same columns and same aliases as the detail query, deliberately: a list
      -- row and a detail page describing the same booking differently is the
      -- drift this is meant to remove, not create.
      so.service_id,
      so.level_2 AS service_name,
      so.level_3 AS service_option_name,
      s.name     AS service_category,
      COALESCE(b.final_price, b.quoted_price) AS total_amount,
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
    -- LEFT, not INNER. A booking whose service_option row was deleted or is
    -- null must still appear in its owner's list; an inner join would delete
    -- bookings from a customer's history to avoid a missing label.
    LEFT JOIN ${dbSchema}.service_options so
      ON so.id = b.service_option_id
    LEFT JOIN ${dbSchema}.service_families s
      ON s.id = so.service_id
    LEFT JOIN ${dbSchema}.branches br
      ON br.id = b.branch_id
    LEFT JOIN ${dbSchema}.user_address ua
      ON ua.address_id = b.user_address_id
    LEFT JOIN LATERAL (
      SELECT bw0.* FROM ${dbSchema}.booking_workers bw0
      WHERE bw0.booking_id = b.id
      ORDER BY bw0.assigned_at DESC NULLS LAST, bw0.id DESC
      LIMIT 1
    ) bw ON TRUE
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
  const effectiveStatus = deriveEffectiveBookingStatus(statusVal, workerStatusVal);

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
    effectiveStatus,
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

/**
 * The customer's own booking history, as authoritative events.
 *
 * Command 6 §11. Reuses `buildBookingTimeline` and `mergeStoredEvents` — the
 * same derivation the provider timeline uses — then re-voices the result for
 * the customer. One source of truth for what happened; two ways of telling it.
 *
 * ## The query is scoped by booking, not by worker
 *
 * The provider handler filters `bw.worker_uid = $2` because a provider may only
 * see the assignment row that is theirs. A customer owns the booking itself, so
 * the join takes the most recent assignment regardless of who holds it — which
 * is what makes a reassigned booking still show its full history.
 *
 * LEFT JOIN, not JOIN: a booking at PENDING_OTP or CONFIRMED has no
 * `booking_workers` row at all. An inner join would return zero rows and the
 * caller would report "no timeline" for every booking that has not yet been
 * assigned — which is every newly created one.
 *
 * Ownership is NOT checked here. `assertBookingAccess` in the controller is the
 * authority, exactly as it is for `getTracking`; duplicating it would create a
 * second rule that can drift from the first.
 */
export const getCustomerBookingTimeline = async (bookingId: number) => {
  const schema = dbSchema || "";

  const result = await dbQuery.query(
    `SELECT b.created_at,
            b.status                AS booking_status,
            bw.status               AS worker_status,
            bw.assigned_at,
            bw.started_at,
            bw.completed_at,
            to_jsonb(bw) ->> 'accepted_at' AS accepted_at,
            to_jsonb(bw) ->> 'declined_at' AS declined_at,
            to_jsonb(bw) ->> 'en_route_at' AS en_route_at,
            to_jsonb(bw) ->> 'arrived_at'  AS arrived_at
       FROM ${schema}.bookings b
       LEFT JOIN ${schema}.booking_workers bw
         ON bw.booking_id = b.id
      WHERE b.id = $1
      ORDER BY bw.id DESC NULLS LAST
      LIMIT 1`,
    [bookingId]
  );

  if (!result.rowCount) {
    throw new BookingAccessError("Booking not found", 404, "BOOKING_NOT_FOUND");
  }

  // Only `event_type` and `created_at` cross. `title`, `description` and
  // `metadata` on booking_timeline_events are admin-authored and must never
  // reach a customer — the same rule the provider handler applies.
  const stored = await dbQuery
    .query(
      `SELECT event_type, created_at
         FROM ${schema}.booking_timeline_events
        WHERE booking_id = $1
        ORDER BY created_at ASC`,
      [bookingId]
    )
    .catch(() => null);

  // `true` for the assignee gate: a customer never stops owning their booking,
  // so every admin event on it is theirs to see. See the controller's note.
  const events = mergeStoredEvents(
    buildBookingTimeline(result.rows[0]),
    stored?.rows ?? [],
    true
  );

  const projected = projectTimelineForCustomer(events);

  return {
    bookingId,
    events: projected,
    currentStep: currentTimelineStep(events),
  };
};
