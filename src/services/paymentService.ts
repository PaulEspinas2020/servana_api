import { db } from "../config";
import { Request, Response } from "express";
import dbQuery from "../db/dbQuery";
import crypto from "crypto";
import axios from "axios";
import { additionalService } from "./additional.service";
import { generateOTP } from "../helpers/otp";
import { send } from "../helpers/mailer";
import { getUserInfoByBookingId } from "./user.service";
import { createNotification } from "./notification.service";

const dbSchema = db.schema;

// const SERVANA_COMMISSION = 0.20; // 20%
// const WORKER_SHARE_RATE  = 0.80; // 80%

// export const computeDisbursement = (totalAmount: number) => {
//   const servanaShare = Math.round(totalAmount * SERVANA_COMMISSION * 100) / 100;
//   const workerShare  = Math.round(totalAmount * WORKER_SHARE_RATE * 100) / 100;
//   return { totalAmount, servanaShare, workerShare };
// };

// /**
//  * Creates a disbursement record when a booking payment is confirmed.
//  * Safe to call multiple times — uses ON CONFLICT DO NOTHING.
//  */
// export const createDisbursement = async (bookingId: number) => {
//   const bookingRes = await dbQuery.query(
//     `SELECT final_price, worker_uid FROM ${dbSchema}.bookings WHERE id = $1`,
//     [bookingId]
//   );

//   if (!bookingRes.rowCount) throw new Error("Booking not found");

//   const { final_price, worker_uid } = bookingRes.rows[0];

//   if (!worker_uid) {
//     console.warn(`createDisbursement: booking ${bookingId} has no assigned worker — skipping`);
//     return null;
//   }

//   const { totalAmount, servanaShare, workerShare } = computeDisbursement(Number(final_price));

//   const res = await dbQuery.query(
//     `
//     INSERT INTO ${dbSchema}.disbursements
//       (booking_id, worker_uid, total_amount, servana_share, worker_share, status)
//     VALUES ($1, $2, $3, $4, $5, 'PENDING')
//     ON CONFLICT (booking_id) DO NOTHING
//     RETURNING *
//     `,
//     [bookingId, worker_uid, totalAmount, servanaShare, workerShare]
//   );

//   return res.rows[0] || null;
// };

export const submitGcash = async (bookingId: number, referenceNo: string, proofUrl?: string) => {
  const r = await dbQuery.query(
    `
    UPDATE ${dbSchema}.payments
    SET reference_no=$2,
        proof_url=$3,
        status='PENDING'
    WHERE booking_id=$1
      AND method='GCASH'
    RETURNING *
    `,
    [bookingId, referenceNo, proofUrl || null]
  );
  if (!r.rowCount) throw new Error("This booking is not configured for GCash payment.");
  return r.rows[0];
};

export const approvePayment = async (bookingId: number) => {
  const r = await dbQuery.query(
    `
    UPDATE ${dbSchema}.payments
    SET status='PAID', paid_at=NOW()
    WHERE booking_id=$1
      AND method='GCASH'
    RETURNING *
    `,
    [bookingId]
  );
  if (!r.rowCount) throw new Error("Only a GCash payment can be manually approved.");

  // try { await createDisbursement(bookingId); }
  // catch (e) { console.error("createDisbursement failed (approvePayment):", e); }

  const bRes = await dbQuery.query(
    `SELECT worker_uid, final_price FROM ${dbSchema}.bookings WHERE id = $1`,
    [bookingId]
  );
  const worker = bRes.rows[0];
  if (worker?.worker_uid) {
    const code = `SVN-${String(bookingId).padStart(6, "0")}`;
    createNotification(worker.worker_uid, {
      type: "earnings_payout",
      severity: "info",
      title: "Payment Received",
      safeBody: `Payment for booking ${code} has been confirmed. Your earnings will be reflected in your ledger.`,
      safeContextLabel: code,
      route: { page: "earnings", bookingId: String(bookingId) },
      canOpenDetail: true,
    }).catch((e) => console.error("createNotification (approvePayment):", e));
  }

  return r.rows[0];
};

export const markCashPaid = async (bookingId: number) => {
  const r = await dbQuery.query(
    `
    UPDATE ${dbSchema}.payments
    SET status='PAID', paid_at=NOW()
    WHERE booking_id=$1
      AND method='CASH'
    RETURNING *
    `,
    [bookingId]
  );
  if (!r.rowCount) throw new Error("This booking is not configured for cash payment.");

  // try { await createDisbursement(bookingId); }
  // catch (e) { console.error("createDisbursement failed (markCashPaid):", e); }

  const bRes = await dbQuery.query(
    `SELECT worker_uid, final_price FROM ${dbSchema}.bookings WHERE id = $1`,
    [bookingId]
  );
  const worker = bRes.rows[0];
  if (worker?.worker_uid) {
    const code = `SVN-${String(bookingId).padStart(6, "0")}`;
    createNotification(worker.worker_uid, {
      type: "earnings_payout",
      severity: "info",
      title: "Payment Received",
      safeBody: `Cash payment for booking ${code} has been recorded. Your earnings will be reflected in your ledger.`,
      safeContextLabel: code,
      route: { page: "earnings", bookingId: String(bookingId) },
      canOpenDetail: true,
    }).catch((e) => console.error("createNotification (markCashPaid):", e));
  }

  return r.rows[0];
};

const PAYMONGO_SECRET_KEY = process.env.PAYMONGO_SECRET_KEY || process.env.PAYMONGO_SK_DEV || "";
const PAYMONGO_BASE_URL = "https://api.paymongo.com/v1";

const getAuthHeader = () => {
  if (!PAYMONGO_SECRET_KEY) throw new Error("PayMongo is not configured");
  const token = Buffer.from(`${PAYMONGO_SECRET_KEY}:`).toString("base64");
  return `Basic ${token}`;
};

export const createCheckoutSession = async (bookingId: number) => {
  const r = await dbQuery.query(
    `
    SELECT b.id,
           b.status AS booking_status,
           COALESCE(b.final_price, b.quoted_price) AS final_price,
           p.method,
           p.status AS payment_status,
           p.provider,
           p.checkout_url,
           p.updated_at
    FROM ${dbSchema}.bookings b
    JOIN ${dbSchema}.payments p ON p.booking_id = b.id
    WHERE b.id = $1
    `,
    [bookingId]
  );

  if (!r.rowCount) {
    throw new Error("Booking not found");
  }

  const booking = r.rows[0];
  const amount = Math.round(Number(booking.final_price) * 100); // centavos

  if (String(booking.method).toUpperCase() !== "PAYMONGO") {
    throw new Error("This booking is not configured for PayMongo payment");
  }
  if (String(booking.payment_status).toUpperCase() === "PAID") {
    throw new Error("This booking is already paid");
  }
  if (["CANCELLED", "CANCELED", "EXPIRED", "FAILED", "REFUNDED"].includes(
    String(booking.booking_status).toUpperCase(),
  )) {
    throw new Error("Payment cannot be started for an inactive booking");
  }
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error("Booking amount must be greater than zero");
  }

  // Reuse a recent pending session. This protects double taps and transient
  // retries without keeping stale PayMongo URLs forever.
  const updatedAt = booking.updated_at ? new Date(booking.updated_at).getTime() : 0;
  const isRecent = updatedAt > 0 && Date.now() - updatedAt < 2 * 60 * 60 * 1000;
  if (
    String(booking.payment_status).toUpperCase() === "PENDING" &&
    String(booking.provider).toUpperCase() === "PAYMONGO" &&
    typeof booking.checkout_url === "string" &&
    booking.checkout_url.length > 0 &&
    isRecent
  ) {
    return {
      booking_id: bookingId,
      provider_payment_id: null,
      checkout_url: booking.checkout_url,
    };
  }

  const payload = {
    data: {
      attributes: {
        line_items: [
          {
            currency: "PHP",
            amount,
            name: `Booking #${bookingId}`,
            quantity: 1
          }
        ],
        payment_method_types: ["gcash", "card"],
        description: `Booking payment for booking #${bookingId}`,
        reference_number: `BOOKING-${bookingId}`,
        success_url: `${process.env.APP_URL}/payment-success?bookingId=${bookingId}`,
        cancel_url: `${process.env.APP_URL}/payment-cancel?bookingId=${bookingId}`,
        send_email_receipt: false,
        show_description: true,
        show_line_items: true
      }
    }
  };

  const response = await fetch(`${PAYMONGO_BASE_URL}/checkout_sessions`, {
    method: "POST",
    headers: {
      "Authorization": getAuthHeader(),
      "Content-Type": "application/json",
      "accept": "application/json"
    },
    body: JSON.stringify(payload)
  });
  type PaymongoResponse = {
    data?: {
      id: string;
      attributes: {
        checkout_url?: string;
      };
    };
    errors?: {
      detail: string;
    }[];
  };
  const result = (await response.json()) as PaymongoResponse;

  if (!response.ok) {
    throw new Error(result?.errors?.[0]?.detail || "Failed to create PayMongo checkout session");
  }

  const providerPaymentId = result?.data?.id;
  const checkoutUrl = result?.data?.attributes?.checkout_url;
  if (!providerPaymentId || !checkoutUrl) {
    throw new Error("PayMongo returned an incomplete checkout session");
  }

  await dbQuery.query(
    `
    UPDATE ${dbSchema}.payments
    SET provider = 'PAYMONGO',
        provider_payment_id = $2,
        checkout_url = $3,
        raw_response = $4
    WHERE booking_id = $1
    `,
    [bookingId, providerPaymentId, checkoutUrl, result]
  );

  // const otp = generateOTP();
  
  // await dbQuery.query(
  //   `
  //   UPDATE ${dbSchema}.bookings
  //   SET worker_code = $2
  //   WHERE booking_id = $1
  //   `,
  //   [bookingId, otp]
  // );


  return {
    booking_id: bookingId,
    provider_payment_id: providerPaymentId,
    checkout_url: checkoutUrl
  };
};

const PAYMONGO_WEBHOOK_SECRET = process.env.PAYMONGO_WEBHOOK_SECRET || "";

function verifySignature(rawBody: Buffer, signatureHeader: string): boolean {
  const secret = PAYMONGO_WEBHOOK_SECRET;
  if (!secret || !signatureHeader) return false;

  const parts = signatureHeader.split(",");
  let timestamp = "";
  let signature = "";

  for (const part of parts) {
    const [key, value] = part.split("=");
    if (key === "t") timestamp = value;
    // PayMongo sends "li" (live) or "te" (test) — accept both so live webhooks verify correctly.
    if (key === "li") signature = value;
    if (key === "te" && !signature) signature = value; // fall back to test key only if live absent
  }

  if (!timestamp || !signature || !/^[a-f\d]{64}$/i.test(signature)) return false;
  const payload = `${timestamp}.${rawBody.toString("utf8")}`;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");

  const expectedBuffer = Buffer.from(expected, "hex");
  const signatureBuffer = Buffer.from(signature, "hex");
  return expectedBuffer.length === signatureBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, signatureBuffer);
}

// const dispatchAfterPayment = async (bookingId: number) => {
//   const r = await dbQuery.query(
//     `
//     SELECT
//       s.worker_role,
//       ua.location_id
//     FROM ${dbSchema}.bookings b
//     JOIN ${dbSchema}.service_options so ON so.id = b.service_option_id
//     JOIN ${dbSchema}.services s ON s.id = so.service_id
//     JOIN ${dbSchema}.user_address ua ON ua.address_id = b.user_address_id
//     WHERE b.id = $1
//     `,
//     [bookingId]
//   );

//   if (!r.rowCount) return;

//   const { worker_role, location_id } = r.rows[0];
//   if (!location_id) return;

//   const [lon, lat] = await getLatLonByLocationId(String(location_id));
//   await assignNearestWorker(
//     bookingId,
//     Number(lat),
//     Number(lon),
//     Number(worker_role)
//   );
// };

export const createPayment = async (request: any) => {

  const amount = Math.round(request.total_amount * 100);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error("Additional work amount must be greater than zero");
  }

  const payload = {
    data: {
      attributes: {
        line_items: [
          {
            currency: "PHP",
            amount,
            name: `Additional Work #${request.id}`,
            quantity: 1
          }
        ],
        payment_method_types: ["gcash", "card"],
        description: `Additional Work #${request.id}`,
        reference_number: `ADD-${request.id}`
      }
    }
  };

  const response = await fetch(`${PAYMONGO_BASE_URL}/checkout_sessions`, {
    method: "POST",
    headers: {
      Authorization: getAuthHeader(),
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  type PaymongoCheckoutResponse = {
    data?: {
      id: string;
      attributes: {
        checkout_url: string;
      };
    };
    errors?: { detail?: string }[];
  };

  const result = (await response.json()) as PaymongoCheckoutResponse;

  if (!response.ok) {
    throw new Error(result.errors?.[0]?.detail || "Failed to create PayMongo checkout session");
  }

  const providerPaymentId = result?.data?.id;
  const checkoutUrl = result?.data?.attributes?.checkout_url;
  if (!providerPaymentId || !checkoutUrl) {
    throw new Error("PayMongo returned an incomplete checkout session");
  }

  await dbQuery.query(
    `
    INSERT INTO ${dbSchema}.payments
      (booking_id, additional_request_id, amount, status, provider_payment_id, checkout_url, provider, raw_response)
    VALUES ($1,$2,$3,'PENDING',$4,$5,'PAYMONGO',$6)
    `,
    [
      request.booking_id,
      request.id,
      request.total_amount,
      providerPaymentId,
      checkoutUrl,
      result
    ]
  );

  return checkoutUrl;
};

/**
 * Guarantees that one PayMongo event can only ever produce one payment row.
 *
 * C20 §31 (F-08). `processWebhook` deduplicates by SELECTing on
 * `webhook_event_id` and returning early if a row exists — but that is
 * check-then-act. PayMongo retries webhooks, and a retry that overlaps the
 * original means both requests run the SELECT before either INSERTs, so both
 * proceed and the same payment is recorded twice.
 *
 * That matters more here than it would elsewhere: Servana uses PayMongo for the
 * actual money and this database purely as the RECORD. A duplicated payment row
 * is not a cosmetic bug, it is the record disagreeing with the processor — and
 * it flows straight into disbursements, earnings and the provider ledger.
 *
 * The index is the real fix; the SELECT stays as the cheap path that avoids
 * doing work before failing. Partial, because rows predating webhook capture
 * have a NULL event id and several NULLs are not a uniqueness conflict.
 */
let webhookIndexReady: Promise<void> | null = null;

const ensureWebhookEventUniqueness = (): Promise<void> => {
  webhookIndexReady ??= dbQuery
    .query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_webhook_event_id
         ON ${dbSchema}.payments (webhook_event_id)
       WHERE webhook_event_id IS NOT NULL`,
      []
    )
    .then(() => undefined)
    .catch((e: any) => {
      // Reset so a transient failure can be retried rather than poisoning the
      // process. A pre-existing duplicate will also land here — that is a data
      // problem to resolve, not something to silently ignore.
      webhookIndexReady = null;
      console.error("[paymongo] webhook uniqueness index failed:", e?.message);
      throw e;
    });
  return webhookIndexReady;
};

/** Postgres unique_violation. */
const isUniqueViolation = (e: any) => e?.code === "23505";

export const processWebhook = async (req: Request, _res: Response) => {
  const rawBody = (req as any).rawBody as Buffer;

  if (!rawBody) {
    throw new Error("Missing raw body");
  }

  const signatureHeader = req.headers["paymongo-signature"] as string;

  if (!signatureHeader) {
    throw new Error("Missing signature header");
  }

  // Throw so the controller sends exactly one response — previously this called res.send()
  // directly which caused a double-response (ERR_HTTP_HEADERS_SENT) on the 200 path.
  if (!verifySignature(rawBody, signatureHeader)) {
    throw new Error("Invalid signature");
  }


  const payload = req.body;
  const eventId = payload?.data?.id;
  const eventType = payload?.data?.attributes?.type;
  const eventData = payload?.data?.attributes?.data;
  const providerPaymentId = eventData?.id;
  if (!eventId || !eventType || !providerPaymentId) {
    throw new Error("Invalid webhook payload");
  }

  // The index below is what actually guarantees uniqueness; this SELECT is the
  // cheap path that avoids doing work before failing on it.
  await ensureWebhookEventUniqueness();

  // idempotency
  const existing = await dbQuery.query(
    `
    SELECT id
    FROM ${dbSchema}.payments
    WHERE webhook_event_id = $1
    LIMIT 1
    `,
    [eventId]
  );

  if (existing.rowCount) {
    return;
  }

  if (eventType === "checkout_session.payment.paid") {

    const checkoutSession = payload?.data;

    const checkoutSessionId = payload.data.attributes.data.id;
    const attributes = checkoutSession?.attributes;
    if (!checkoutSessionId) {
      throw new Error("Missing checkout_session_id");
    }

    const paymentResource = eventData?.attributes?.payments?.[0];
    const processorPaymentId = paymentResource?.id;
    const paidAmount = Number(paymentResource?.attributes?.amount);
    const paidCurrency = String(paymentResource?.attributes?.currency ?? '').toUpperCase();
    if (!processorPaymentId || !processorPaymentId.startsWith('pay_')) {
      throw new Error("Missing PayMongo payment id");
    }
    if (!Number.isSafeInteger(paidAmount) || paidAmount <= 0 || paidCurrency !== 'PHP') {
      throw new Error("Invalid PayMongo payment amount or currency");
    }

    const r = await dbQuery.query(
      `
    UPDATE ${dbSchema}.payments
    SET status = 'PAID',
        paid_at = NOW(),
        webhook_event_id = $2,
        raw_response = $3,
        provider_payment_id = $4
    WHERE provider_payment_id = $1
      AND ROUND(amount * 100) = $5
    RETURNING booking_id, additional_request_id
    `,
      [checkoutSessionId, eventId, payload, processorPaymentId, paidAmount]
    );

    if (!r.rowCount) {
      // A paid event must map to a checkout created by this application. A
      // transient replication/order race should be retried; acknowledging it
      // here would permanently lose the authoritative payment event.
      throw new Error("PayMongo checkout session not found");
    }

    const payment = r.rows[0];
    // ======================
    // ADDITIONAL REQUEST
    // ======================
    if (payment.additional_request_id) {

      await additionalService.markPaid(payment.additional_request_id);

      await dbQuery.query(
        `
      INSERT INTO ${dbSchema}.booking_tracking
        (booking_id, status, note)
      VALUES
        ($1,'ADDITIONAL_PAID','Additional request paid')
      `,
        [payment.booking_id]
      );

      return;
    }

    // NORMAL BOOKING: `payments.status` is authoritative for settlement.
    // bookings.status is the service lifecycle and must not be overwritten by
    // a webhook before OTP/assignment or after WORKER_ASSIGNED.

    await dbQuery.query(
      `
    INSERT INTO ${dbSchema}.booking_tracking
      (booking_id, status, note)
    VALUES
      ($1,'PAYMENT_PAID','Booking paid')
    `,
      [payment.booking_id]
    );

    // try { await createDisbursement(payment.booking_id); }
    // catch (e) { console.error("createDisbursement failed (webhook):", e); }

    // Send payment confirmation email to customer
    try {
      const userInfo = await getUserInfoByBookingId(payment.booking_id);
      if (userInfo) {
        const paymentRes = await dbQuery.query(
          `SELECT amount, method, paid_at, reference_no FROM ${dbSchema}.payments WHERE booking_id = $1 AND status = 'PAID' LIMIT 1`,
          [payment.booking_id]
        );
        const p = paymentRes.rows[0] || {};
        send(userInfo.email, "payment_confirmed", {
          first_name:     userInfo.firstName,
          booking_id:     payment.booking_id,
          amount:         p.amount || "0.00",
          payment_method: p.method || "ONLINE",
          paid_at:        p.paid_at ? new Date(p.paid_at).toLocaleString("en-US", { month: "long", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "",
          reference_no:   p.reference_no || eventId,
        });
      }
    } catch (emailErr) {
      console.error("payment_confirmed email failed:", emailErr);
    }
  }

  if (eventType === "checkout_session.payment.failed") {
    const failedUpdate = await dbQuery.query(
      `
      UPDATE ${dbSchema}.payments
      SET status = 'FAILED',
          webhook_event_id = $2,
          raw_response = $3
      WHERE provider_payment_id = $1
      RETURNING booking_id
      `,
      [providerPaymentId, eventId, payload]
    );

    if (!failedUpdate.rowCount) {
      // Preserve ordering-race recovery: PayMongo must retry until the checkout
      // row created by this application is visible, just like paid events.
      throw new Error("PayMongo checkout session not found");
    }

    // Send payment failed email to customer
    try {
      const failedPayment = await dbQuery.query(
        `SELECT booking_id, amount FROM ${dbSchema}.payments WHERE provider_payment_id = $1 LIMIT 1`,
        [providerPaymentId]
      );
      if (failedPayment.rowCount && failedPayment.rows[0].booking_id) {
        const bookingId = failedPayment.rows[0].booking_id;
        const userInfo = await getUserInfoByBookingId(bookingId);
        if (userInfo) {
          const bookingRes = await dbQuery.query(
            `SELECT schedule FROM ${dbSchema}.bookings WHERE id = $1`,
            [bookingId]
          );
          const schedule = bookingRes.rows[0]?.schedule;
          send(userInfo.email, "payment_failed", {
            first_name:   userInfo.firstName,
            booking_id:   bookingId,
            amount:       failedPayment.rows[0].amount || "0.00",
            booking_date: schedule ? new Date(schedule).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }) : "",
            // retry_url:    `${process.env.APP_URL}/bookings/${bookingId}/pay`,
          });
        }
      }
    } catch (emailErr) {
      console.error("payment_failed email failed:", emailErr);
    }
  }
};

// ---------------------------------------------------------------------------
// Disbursement dashboard
// ---------------------------------------------------------------------------

/**
 * Daily disbursement view per worker.
 * Pulls from payments WHERE status='PAID', groups by date + worker,
 * and joins worker_daily_payouts for the current payout status.
 */
// export const getDailyDisbursements = async () => {
//   const res = await dbQuery.query(
//     `
//     SELECT
//       DATE(p.paid_at)                                       AS date,
//       b.worker_uid,
//       uc.first_name || ' ' || uc.last_name                 AS worker_name,
//       COUNT(p.id)                                           AS total_transactions,
//       COALESCE(SUM(p.amount), 0)                            AS total_collected,
//       ROUND(COALESCE(SUM(p.amount), 0) * 0.20, 2)          AS servana_share,
//       ROUND(COALESCE(SUM(p.amount), 0) * 0.80, 2)          AS worker_share,
//       COALESCE(wdp.status, 'PENDING')                       AS payout_status,
//       wdp.paymongo_payout_id,
//       wdp.payout_error,
//       wdp.released_at
//     FROM ${dbSchema}.payments p
//     JOIN ${dbSchema}.bookings b
//       ON b.id = p.booking_id
//     JOIN ${dbSchema}.user_credentials uc
//       ON uc.uid = b.worker_uid
//     LEFT JOIN ${dbSchema}.worker_daily_payouts wdp
//       ON wdp.worker_uid = b.worker_uid
//       AND wdp.payout_date = DATE(p.paid_at)
//     WHERE p.status = 'PAID'
//       AND p.paid_at IS NOT NULL
//       AND b.worker_uid IS NOT NULL
//     GROUP BY
//       DATE(p.paid_at),
//       b.worker_uid,
//       uc.first_name,
//       uc.last_name,
//       wdp.status,
//       wdp.paymongo_payout_id,
//       wdp.payout_error,
//       wdp.released_at
//     ORDER BY DATE(p.paid_at) DESC, uc.first_name
//     `,
//     []
//   );

//   return res.rows;
// };

// /**
//  * Trigger the actual PayMongo payout for a worker's accumulated share on a given date.
//  * Aggregates all PAID payments for that worker+date, upserts a worker_daily_payouts record,
//  * then calls the PayMongo Disbursements API.
//  */
// export const triggerDailyPayout = async (workerUid: string, payoutDate: string) => {
//   // 1. Aggregate PAID payments for this worker on this date
//   const aggRes = await dbQuery.query(
//     `
//     SELECT
//       COALESCE(SUM(p.amount), 0)                   AS total_collected,
//       ROUND(COALESCE(SUM(p.amount), 0) * 0.20, 2)  AS servana_share,
//       ROUND(COALESCE(SUM(p.amount), 0) * 0.80, 2)  AS worker_share,
//       COUNT(p.id)                                   AS transaction_count
//     FROM ${dbSchema}.payments p
//     JOIN ${dbSchema}.bookings b ON b.id = p.booking_id
//     WHERE p.status = 'PAID'
//       AND b.worker_uid = $1
//       AND DATE(p.paid_at) = $2::date
//     `,
//     [workerUid, payoutDate]
//   );

//   const agg = aggRes.rows[0];
//   const workerShare = Number(agg.worker_share);
//   const totalCollected = Number(agg.total_collected);

//   if (totalCollected === 0) {
//     throw new Error(`No PAID payments found for worker ${workerUid} on ${payoutDate}`);
//   }

//   // 2. Upsert the daily payout record (idempotent)
//   const upsertRes = await dbQuery.query(
//     `
//     INSERT INTO ${dbSchema}.worker_daily_payouts
//       (worker_uid, payout_date, total_collected, servana_share, worker_share, status)
//     VALUES ($1, $2::date, $3, $4, $5, 'PENDING')
//     ON CONFLICT (worker_uid, payout_date) DO UPDATE
//       SET total_collected = EXCLUDED.total_collected,
//           servana_share   = EXCLUDED.servana_share,
//           worker_share    = EXCLUDED.worker_share,
//           updated_at      = NOW()
//     RETURNING *
//     `,
//     [workerUid, payoutDate, totalCollected, agg.servana_share, workerShare]
//   );

//   const record = upsertRes.rows[0];

//   if (record.status === 'RELEASED') {
//     throw new Error(`Payout for worker ${workerUid} on ${payoutDate} is already released`);
//   }

//   // 3. Load worker's bank account
//   const bankRes = await dbQuery.query(
//     `SELECT * FROM ${dbSchema}.worker_bank_accounts WHERE worker_uid = $1`,
//     [workerUid]
//   );
//   if (!bankRes.rowCount) throw new Error("Worker has no registered bank account");
//   const bank = bankRes.rows[0];

//   // 4. Call PayMongo Disbursements API (amount in centavos)
//   const amountCentavos = Math.round(workerShare * 100);

//   try {
//     const response = await axios.post(
//       `${PAYMONGO_BASE_URL}/disbursements`,
//       {
//         data: {
//           attributes: {
//             amount: amountCentavos,
//             currency: "PHP",
//             bank_code: bank.bank_code,
//             account_number: bank.account_number,
//             account_name: bank.account_name,
//             narration: `Servana daily payout ${payoutDate}`,
//             reference_id: `WDP-${workerUid}-${payoutDate}`
//           }
//         }
//       },
//       {
//         headers: {
//           Authorization: getAuthHeader(),
//           "Content-Type": "application/json"
//         }
//       }
//     );

//     const payoutId = response.data?.data?.id;

//     const updated = await dbQuery.query(
//       `
//       UPDATE ${dbSchema}.worker_daily_payouts
//       SET status             = 'RELEASED',
//           paymongo_payout_id = $3,
//           payout_error       = NULL,
//           released_at        = NOW(),
//           updated_at         = NOW()
//       WHERE worker_uid = $1 AND payout_date = $2::date
//       RETURNING *
//       `,
//       [workerUid, payoutDate, payoutId]
//     );

//     return {
//       success: true,
//       payoutId,
//       workerShare,
//       totalCollected,
//       payout: updated.rows[0]
//     };

//   } catch (err: any) {
//     const errMsg = err?.response?.data?.errors?.[0]?.detail || err.message || "PayMongo payout failed";

//     await dbQuery.query(
//       `
//       UPDATE ${dbSchema}.worker_daily_payouts
//       SET status       = 'FAILED',
//           payout_error = $3,
//           updated_at   = NOW()
//       WHERE worker_uid = $1 AND payout_date = $2::date
//       `,
//       [workerUid, payoutDate, errMsg]
//     );

//     throw new Error(`Payout failed: ${errMsg}`);
//   }
// };
