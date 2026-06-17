import { db } from "../config";
import { Request, Response } from "express";
import dbQuery from "../db/dbQuery";
import crypto from "crypto";
import axios from "axios";
import { additionalService } from "./additional.service";
import { generateOTP } from "../helpers/otp";
import { send } from "../helpers/mailer";
import { getUserInfoByBookingId } from "./user.service";

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
    SET method='GCASH',
        reference_no=$2,
        proof_url=$3,
        status='PENDING'
    WHERE booking_id=$1
    RETURNING *
    `,
    [bookingId, referenceNo, proofUrl || null]
  );
  if (!r.rowCount) throw new Error("Payment record not found.");
  return r.rows[0];
};

export const approvePayment = async (bookingId: number) => {
  const r = await dbQuery.query(
    `
    UPDATE ${dbSchema}.payments
    SET status='PAID', paid_at=NOW()
    WHERE booking_id=$1
    RETURNING *
    `,
    [bookingId]
  );
  if (!r.rowCount) throw new Error("Payment record not found.");

  // try { await createDisbursement(bookingId); }
  // catch (e) { console.error("createDisbursement failed (approvePayment):", e); }

  return r.rows[0];
};

export const markCashPaid = async (bookingId: number) => {
  const r = await dbQuery.query(
    `
    UPDATE ${dbSchema}.payments
    SET method='CASH', status='PAID', paid_at=NOW()
    WHERE booking_id=$1
    RETURNING *
    `,
    [bookingId]
  );
  if (!r.rowCount) throw new Error("Payment record not found.");

  // try { await createDisbursement(bookingId); }
  // catch (e) { console.error("createDisbursement failed (markCashPaid):", e); }

  return r.rows[0];
};

const PAYMONGO_SECRET_KEY = process.env.PAYMONGO_SK_DEV || "";
const PAYMONGO_BASE_URL = "https://api.paymongo.com/v1";

const getAuthHeader = () => {
  const token = Buffer.from(`${PAYMONGO_SECRET_KEY}:`).toString("base64");
  return `Basic ${token}`;
};

export const createCheckoutSession = async (bookingId: number) => {
  const r = await dbQuery.query(
    `
    SELECT b.id, b.final_price
    FROM ${dbSchema}.bookings b
    WHERE b.id = $1
    `,
    [bookingId]
  );

  if (!r.rowCount) {
    throw new Error("Booking not found");
  }

  const booking = r.rows[0];
  const amount = Math.round(Number(booking.final_price) * 100); // centavos

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
  const secret = process.env.PAYMONGO_WEBHOOK_SECRET!;

  const parts = signatureHeader.split(",");
  let timestamp = "";
  let signature = "";

  for (const part of parts) {
    const [key, value] = part.split("=");
    if (key === "t") timestamp = value;
    if (key === "te") signature = value;
  }

  const payload = `${timestamp}.${rawBody.toString("utf8")}`;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");

  return crypto.timingSafeEqual(
    Buffer.from(expected),
    Buffer.from(signature)
  );
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
    data: {
      id: string;
      attributes: {
        checkout_url: string;
      };
    };
  };

  const result = (await response.json()) as PaymongoCheckoutResponse;

  const providerPaymentId = result?.data?.id;
  const checkoutUrl = result?.data?.attributes?.checkout_url;

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

export const processWebhook = async (req: Request, res: Response) => {
  const rawBody = (req as any).rawBody as Buffer;

  if (!rawBody) {
    throw new Error("Missing raw body");
  }

  const signatureHeader = req.headers["paymongo-signature"] as string;

  if (!signatureHeader) {
    throw new Error("Missing signature header");
  }

  if (!verifySignature(rawBody, signatureHeader)) {
    return res.status(400).send("Invalid signature");
  }


  const payload = req.body;
  const eventId = payload?.data?.id;
  const eventType = payload?.data?.attributes?.type;
  const eventData = payload?.data?.attributes?.data;
  const providerPaymentId = eventData?.id;
  console.log({ eventId, eventType, providerPaymentId });
  if (!eventId || !eventType || !providerPaymentId) {
    throw new Error("Invalid webhook payload");
  }

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
    console.log({ checkoutSessionId, attributes });
    if (!checkoutSessionId) {
      throw new Error("Missing checkout_session_id");
    }

    const r = await dbQuery.query(
      `
    UPDATE ${dbSchema}.payments
    SET status = 'PAID',
        paid_at = NOW(),
        webhook_event_id = $2,
        raw_response = $3
    WHERE provider_payment_id = $1
    RETURNING booking_id, additional_request_id
    `,
      [checkoutSessionId, eventId, payload]
    );

    if (!r.rowCount) return;

    const payment = r.rows[0];
    console.log({ payment });
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

    // ======================
    // NORMAL BOOKING
    // ======================
    await dbQuery.query(
      `
    UPDATE ${dbSchema}.bookings
    SET status = 'PAID'
    WHERE id = $1
    `,
      [payment.booking_id]
    );

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
    await dbQuery.query(
      `
      UPDATE ${dbSchema}.payments
      SET status = 'FAILED',
          webhook_event_id = $2,
          raw_response = $3
      WHERE provider_payment_id = $1
      `,
      [providerPaymentId, eventId, payload]
    );

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