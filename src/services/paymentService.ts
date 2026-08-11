import { db } from "../config";
import { returnOriginMatches } from "./paymentReturnOrigin";
import { Request, Response } from "express";
import dbQuery, { pool } from "../db/dbQuery";
import crypto from "crypto";
import axios from "axios";
import { generateOTP } from "../helpers/otp";
import { send } from "../helpers/mailer";
import { getUserInfoByBookingId } from "./user.service";
import { createCustomerNotification, createNotification } from "./notification.service";

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
const PAYMONGO_TIMEOUT_MS = 15_000;

const paymentError = (message: string, code: string, statusCode: number) =>
  Object.assign(new Error(message), { code, statusCode });

const getAuthHeader = () => {
  if (!PAYMONGO_SECRET_KEY) {
    throw paymentError("Online payment is temporarily unavailable", "PAYMONGO_NOT_CONFIGURED", 503);
  }
  const token = Buffer.from(`${PAYMONGO_SECRET_KEY}:`).toString("base64");
  return `Basic ${token}`;
};

/**
 * `returnOrigin` is an entry from the server-side allowlist in
 * paymentReturnOrigin.ts — never a caller-supplied string. Omitted (native
 * mobile, the scheduler) it falls back to the configured default, which is the
 * behaviour every client had before the allowlist existed.
 */
const getReturnUrl = (
  path: "/payment-success" | "/payment-cancel",
  params: Record<string, string>,
  returnOrigin?: string,
) => {
  const configured = String(
    returnOrigin || process.env.PAYMONGO_RETURN_URL || process.env.APP_URL || "",
  ).trim();
  let base: URL;
  try {
    base = new URL(configured);
  } catch {
    throw paymentError("Online payment is temporarily unavailable", "PAYMONGO_RETURN_URL_INVALID", 503);
  }
  const isLocalDevelopment = process.env.NODE_ENV !== "production" &&
    base.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(base.hostname);
  if ((base.protocol !== "https:" && !isLocalDevelopment) || base.username || base.password) {
    throw paymentError("Online payment is temporarily unavailable", "PAYMONGO_RETURN_URL_INVALID", 503);
  }
  const target = new URL(path, `${base.origin}/`);
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
  return target.toString();
};

const isAllowedCheckoutUrl = (value: unknown): value is string => {
  if (typeof value !== "string" || !value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" &&
      (parsed.hostname === "checkout.paymongo.com" || parsed.hostname.endsWith(".checkout.paymongo.com"));
  } catch {
    return false;
  }
};

const createPaymongoCheckout = async (payload: unknown, idempotencyKey: string) => {
  let response: globalThis.Response;
  try {
    response = await fetch(`${PAYMONGO_BASE_URL}/checkout_sessions`, {
      method: "POST",
      headers: {
        Authorization: getAuthHeader(),
        "Idempotency-Key": idempotencyKey,
        "Content-Type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(PAYMONGO_TIMEOUT_MS),
    });
  } catch {
    throw paymentError("Online payment is temporarily unavailable", "PAYMONGO_UNAVAILABLE", 502);
  }

  type PaymongoResponse = {
    data?: { id: string; attributes: { checkout_url?: string } };
    errors?: { detail?: string }[];
  };
  const result = (await response.json().catch(() => ({}))) as PaymongoResponse;
  if (!response.ok) {
    // Processor details can contain fraud/risk signals and must not be reflected
    // to the customer. The request id in server logs is the support handle.
    throw paymentError("Online payment is temporarily unavailable", "PAYMONGO_CHECKOUT_FAILED", 502);
  }
  const providerPaymentId = result?.data?.id;
  const checkoutUrl = result?.data?.attributes?.checkout_url;
  if (!providerPaymentId || !checkoutUrl) {
    throw paymentError("Online payment is temporarily unavailable", "PAYMONGO_RESPONSE_INVALID", 502);
  }
  if (!isAllowedCheckoutUrl(checkoutUrl)) {
    throw paymentError("Online payment is temporarily unavailable", "PAYMONGO_RESPONSE_INVALID", 502);
  }
  return { providerPaymentId, checkoutUrl, result };
};

export const createCheckoutSession = async (
  bookingId: number,
  options?: { returnOrigin?: string },
) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `paymongo-checkout:booking:${bookingId}`,
    ]);
    const r = await client.query(
      `SELECT b.id,
              b.status AS booking_status,
              COALESCE(b.final_price, b.quoted_price) AS final_price,
              p.id AS payment_id,
              p.method,
              p.status AS payment_status,
              p.provider,
              p.checkout_url,
              p.return_origin,
              p.updated_at,
              COALESCE(p.checkout_attempt, 0) AS checkout_attempt
         FROM ${dbSchema}.bookings b
         JOIN ${dbSchema}.payments p ON p.booking_id = b.id
        WHERE b.id = $1
        FOR UPDATE OF p`,
      [bookingId],
    );
    if (!r.rowCount) throw paymentError("Booking not found", "PAYMENT_NOT_FOUND", 404);

    const booking = r.rows[0];
    const amount = Math.round(Number(booking.final_price) * 100);
    const paymentStatus = String(booking.payment_status).toUpperCase();
    if (String(booking.method).toUpperCase() !== "PAYMONGO") {
      throw paymentError("This booking is not configured for PayMongo payment", "PAYMONGO_METHOD_MISMATCH", 409);
    }
    if (paymentStatus === "PAID") throw paymentError("This booking is already paid", "PAYMENT_ALREADY_PAID", 409);
    if (["REFUNDING", "REFUNDED"].includes(paymentStatus)) {
      throw paymentError("Payment cannot be restarted while a refund is active", "PAYMENT_REFUND_ACTIVE", 409);
    }
    if (!["PENDING", "FAILED"].includes(paymentStatus)) {
      throw paymentError("Payment cannot be started from its current status", "PAYMENT_STATE_CONFLICT", 409);
    }
    if (["CANCELLED", "CANCELED", "EXPIRED", "FAILED", "REFUNDED", "COMPLETED"].includes(
      String(booking.booking_status).toUpperCase(),
    )) {
      throw paymentError("Payment cannot be started for an inactive booking", "BOOKING_INACTIVE", 409);
    }
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw paymentError("Booking amount must be greater than zero", "PAYMENT_AMOUNT_INVALID", 422);
    }

    const updatedAt = booking.updated_at ? new Date(booking.updated_at).getTime() : 0;
    const isRecent = updatedAt > 0 && Date.now() - updatedAt < 2 * 60 * 60 * 1000;
    // The stored session encodes the return URLs it was created with, so it may
    // only be handed back to a caller resolving to the SAME origin. A mismatch
    // falls through and mints a fresh session rather than returning the payer to
    // another application after they pay.
    const originMatches = returnOriginMatches(booking.return_origin, options?.returnOrigin);
    if (paymentStatus === "PENDING" &&
        String(booking.provider).toUpperCase() === "PAYMONGO" &&
        isAllowedCheckoutUrl(booking.checkout_url) && isRecent && originMatches) {
      await client.query("COMMIT");
      return { booking_id: bookingId, checkout_url: booking.checkout_url, reused: true };
    }

    const attempt = Number(booking.checkout_attempt) + 1;
    if (!Number.isSafeInteger(attempt) || attempt <= 0) {
      throw paymentError("Online payment is temporarily unavailable", "PAYMONGO_STATE_INVALID", 503);
    }
    const payload = {
      data: {
        attributes: {
          line_items: [{ currency: "PHP", amount, name: `Booking #${bookingId}`, quantity: 1 }],
          payment_method_types: ["gcash", "card"],
          description: `Booking payment for booking #${bookingId}`,
          reference_number: `BOOKING-${bookingId}`,
          success_url: getReturnUrl("/payment-success", { bookingId: String(bookingId) }, options?.returnOrigin),
          cancel_url: getReturnUrl("/payment-cancel", { bookingId: String(bookingId) }, options?.returnOrigin),
          send_email_receipt: false,
          show_description: true,
          show_line_items: true,
        },
      },
    };
    const idempotencyKey = `servana-booking-${booking.payment_id}-checkout-${attempt}`;
    const { providerPaymentId, checkoutUrl, result } = await createPaymongoCheckout(payload, idempotencyKey);
    const updated = await client.query(
      `UPDATE ${dbSchema}.payments
          SET provider = 'PAYMONGO', provider_payment_id = $2,
              checkout_url = $3, raw_response = $4, status = 'PENDING',
              checkout_attempt = $5, return_origin = $6, updated_at = NOW(),
              -- The session being replaced stays payable at PayMongo. Keep its
              -- id so the webhook can still find this row if the customer pays
              -- the old one; without it that payment is received and never
              -- recorded. Guarded on cs_ so a pay_ id can never be appended.
              superseded_session_ids = CASE
                WHEN provider_payment_id IS NOT NULL
                 AND provider_payment_id <> $2
                 AND provider_payment_id LIKE 'cs_%'
                THEN array_append(COALESCE(superseded_session_ids, '{}'), provider_payment_id)
                ELSE superseded_session_ids
              END
        WHERE id = $1 AND status IN ('PENDING', 'FAILED')
        RETURNING id`,
      [booking.payment_id, providerPaymentId, checkoutUrl, result, attempt, options?.returnOrigin ?? null],
    );
    if (!updated.rowCount) throw paymentError("Payment changed while checkout was being created", "PAYMENT_STATE_CONFLICT", 409);
    await client.query("COMMIT");
    return { booking_id: bookingId, checkout_url: checkoutUrl, reused: false };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};

const PAYMONGO_WEBHOOK_SECRET = process.env.PAYMONGO_WEBHOOK_SECRET || "";
const configuredWebhookTolerance = Number(process.env.PAYMONGO_WEBHOOK_TOLERANCE_SECONDS || 300);
const PAYMONGO_WEBHOOK_TOLERANCE_SECONDS = Number.isFinite(configuredWebhookTolerance)
  ? Math.max(60, Math.floor(configuredWebhookTolerance))
  : 300;
const PAYMONGO_EXPECT_LIVE_MODE = process.env.PAYMONGO_EXPECT_LIVE_MODE == null
  ? process.env.NODE_ENV === "production"
  : process.env.PAYMONGO_EXPECT_LIVE_MODE === "true";

function verifySignature(rawBody: Buffer, signatureHeader: string): boolean {
  const secret = PAYMONGO_WEBHOOK_SECRET;
  if (!secret || !signatureHeader) return false;

  const parts = signatureHeader.split(",");
  let timestamp = "";
  let signature = "";

  for (const part of parts) {
    const [key, value] = part.trim().split("=", 2);
    if (key === "t") timestamp = value;
    // PayMongo sends "li" (live) or "te" (test) — accept both so live webhooks verify correctly.
    if (key === "li") signature = value;
    if (key === "te" && !signature) signature = value; // fall back to test key only if live absent
  }

  if (!timestamp || !signature || !/^[a-f\d]{64}$/i.test(signature)) return false;
  const timestampSeconds = Number(timestamp);
  if (!Number.isSafeInteger(timestampSeconds) || timestampSeconds <= 0 ||
      Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds) > PAYMONGO_WEBHOOK_TOLERANCE_SECONDS) {
    return false;
  }
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
//     JOIN ${dbSchema}.service_families s ON s.id = so.service_id
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

export const createPayment = async (request: any, options?: { returnOrigin?: string }) => {
  const requestId = Number(request?.id);
  if (!Number.isSafeInteger(requestId) || requestId <= 0) {
    throw new Error("Additional work request is invalid");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `paymongo-checkout:additional:${requestId}`,
    ]);
    const requestRes = await client.query(
      `SELECT id, booking_id, total_amount, status
         FROM ${dbSchema}.booking_additional_requests
        WHERE id = $1
        FOR UPDATE`,
      [requestId],
    );
    if (!requestRes.rowCount) throw new Error("Additional work request not found");
    const currentRequest = requestRes.rows[0];
    if (String(currentRequest.status).toUpperCase() !== "WAITING_FOR_PAYMENT") {
      throw new Error("Additional work is not awaiting payment");
    }
    const amount = Math.round(Number(currentRequest.total_amount) * 100);
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new Error("Additional work amount must be greater than zero");
    }

    const existingRes = await client.query(
      `SELECT id, status, checkout_url, return_origin, updated_at,
              COALESCE(checkout_attempt, 0) AS checkout_attempt
         FROM ${dbSchema}.payments
        WHERE additional_request_id = $1 AND provider = 'PAYMONGO'
        ORDER BY id DESC LIMIT 1
        FOR UPDATE`,
      [requestId],
    );
    const existing = existingRes.rows[0];
    const existingStatus = String(existing?.status ?? "").toUpperCase();
    if (["PAID", "REFUNDING", "REFUNDED"].includes(existingStatus)) {
      throw new Error("Additional work payment is already settled");
    }
    const updatedAt = existing?.updated_at ? new Date(existing.updated_at).getTime() : 0;
    // Same rule as createCheckoutSession: a stored session carries the return
    // URLs it was built with, so it is only reusable for the same origin.
    if (existingStatus === "PENDING" && isAllowedCheckoutUrl(existing.checkout_url) &&
        updatedAt > 0 && Date.now() - updatedAt < 2 * 60 * 60 * 1000 &&
        returnOriginMatches(existing.return_origin, options?.returnOrigin)) {
      await client.query("COMMIT");
      return existing.checkout_url;
    }

    const attempt = Number(existing?.checkout_attempt ?? 0) + 1;
    if (!Number.isSafeInteger(attempt) || attempt <= 0) {
      throw new Error("Additional work checkout attempt is invalid");
    }
    const payload = {
      data: {
        attributes: {
          line_items: [{ currency: "PHP", amount, name: `Additional Work #${requestId}`, quantity: 1 }],
          payment_method_types: ["gcash", "card"],
          description: `Additional Work #${requestId}`,
          reference_number: `ADD-${requestId}`,
          success_url: getReturnUrl("/payment-success", {
            bookingId: String(currentRequest.booking_id), additionalRequestId: String(requestId),
          }, options?.returnOrigin),
          cancel_url: getReturnUrl("/payment-cancel", {
            bookingId: String(currentRequest.booking_id), additionalRequestId: String(requestId),
          }, options?.returnOrigin),
          send_email_receipt: false,
          show_description: true,
          show_line_items: true,
        },
      },
    };
    const operationId = existing?.id ?? `request-${requestId}`;
    const idempotencyKey = `servana-additional-${operationId}-checkout-${attempt}`;
    const { providerPaymentId, checkoutUrl, result } = await createPaymongoCheckout(payload, idempotencyKey);
    if (existing?.id) {
      const updated = await client.query(
        `UPDATE ${dbSchema}.payments
            SET amount = $2, status = 'PENDING', provider_payment_id = $3,
                checkout_url = $4, raw_response = $5, checkout_attempt = $6,
                return_origin = $7, updated_at = NOW(),
                superseded_session_ids = CASE
                  WHEN provider_payment_id IS NOT NULL
                   AND provider_payment_id <> $3
                   AND provider_payment_id LIKE 'cs_%'
                  THEN array_append(COALESCE(superseded_session_ids, '{}'), provider_payment_id)
                  ELSE superseded_session_ids
                END
          WHERE id = $1 AND status IN ('PENDING', 'FAILED')`,
        [existing.id, currentRequest.total_amount, providerPaymentId, checkoutUrl, result, attempt,
          options?.returnOrigin ?? null],
      );
      if (!updated.rowCount) throw new Error("Additional work payment changed during checkout creation");
    } else {
      await client.query(
        `INSERT INTO ${dbSchema}.payments
          (booking_id, additional_request_id, amount, status, provider_payment_id,
           checkout_url, provider, raw_response, checkout_attempt, return_origin)
         VALUES ($1,$2,$3,'PENDING',$4,$5,'PAYMONGO',$6,$7,$8)`,
        [currentRequest.booking_id, requestId, currentRequest.total_amount,
          providerPaymentId, checkoutUrl, result, attempt, options?.returnOrigin ?? null],
      );
    }
    await client.query("COMMIT");
    return checkoutUrl;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
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
 * Migration 017 owns the partial unique index. Advisory transaction locks keep
 * overlapping deliveries deterministic before the constraint is reached.
 */
const claimWebhookEvent = async (client: any, eventId: string): Promise<boolean> => {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `paymongo-webhook:${eventId}`,
  ]);
  const existing = await client.query(
    `SELECT id FROM ${dbSchema}.payments WHERE webhook_event_id = $1 LIMIT 1`,
    [eventId],
  );
  return !existing.rowCount;
};

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
  if (!eventId || !eventType || !eventData?.id) {
    throw new Error("Invalid webhook payload");
  }
  if (typeof payload?.data?.attributes?.livemode !== "boolean" ||
      payload.data.attributes.livemode !== PAYMONGO_EXPECT_LIVE_MODE) {
    throw new Error("PayMongo webhook environment mismatch");
  }

  const handledEventTypes = new Set([
    "checkout_session.payment.paid",
    "checkout_session.payment.failed",
    "refund.succeeded",
  ]);
  if (!handledEventTypes.has(eventType)) return;
  const providerPaymentId = eventData.id;

  // The index below is what actually guarantees uniqueness; this SELECT is the
  // cheap path that avoids doing work before failing on it.
  if (eventType === "checkout_session.payment.paid") {
    const checkoutSessionId = payload.data.attributes.data.id;
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

    const client = await pool.connect();
    let payment: { booking_id: number; additional_request_id?: number | null } | null = null;
    try {
      await client.query("BEGIN");
      if (!(await claimWebhookEvent(client, eventId))) {
        await client.query("COMMIT");
        return;
      }
      const r = await client.query(
        `UPDATE ${dbSchema}.payments
            SET status = 'PAID', paid_at = NOW(), webhook_event_id = $2,
                raw_response = $3, provider_payment_id = $4
          WHERE (provider_payment_id = $1
                 OR superseded_session_ids @> ARRAY[$1])
            AND provider = 'PAYMONGO'
            AND status IN ('PENDING', 'FAILED')
            AND ROUND(amount * 100) = $5
          RETURNING booking_id, additional_request_id`,
        [checkoutSessionId, eventId, payload, processorPaymentId, paidAmount],
      );

      if (!r.rowCount) {
        // A distinct duplicate paid event must be harmless too. After the first
        // event, provider_payment_id intentionally holds the refundable pay_
        // id, so locate the original checkout id in the signed raw event.
        const current = await client.query(
          `SELECT status, ROUND(amount * 100) AS amount_centavos
             FROM ${dbSchema}.payments
            WHERE provider = 'PAYMONGO'
              AND (provider_payment_id = $1
                OR superseded_session_ids @> ARRAY[$1]
                OR raw_response #>> '{data,id}' = $1
                OR raw_response #>> '{data,attributes,data,id}' = $1)
            LIMIT 1`,
          [checkoutSessionId],
        );
        const row = current.rows[0];
        if (row && ['PAID', 'REFUNDING', 'REFUNDED'].includes(String(row.status).toUpperCase()) &&
            Number(row.amount_centavos) === paidAmount) {
          await client.query("COMMIT");
          return;
        }
        throw new Error("PayMongo checkout session not found");
      }

      payment = r.rows[0];
      if (payment?.additional_request_id) {
        await client.query(
          `UPDATE ${dbSchema}.booking_additional_requests
              SET status = 'WAITING_WORKER_APPROVAL', paid_at = NOW()
            WHERE id = $1 AND status = 'WAITING_FOR_PAYMENT'`,
          [payment.additional_request_id],
        );
        await client.query(
          `INSERT INTO ${dbSchema}.booking_tracking (booking_id, status, note)
           VALUES ($1,'ADDITIONAL_PAID','Additional request paid')`,
          [payment.booking_id],
        );
      } else {
        // payments.status is settlement truth; bookings.status remains the
        // service lifecycle and is deliberately untouched.
        await client.query(
          `INSERT INTO ${dbSchema}.booking_tracking (booking_id, status, note)
           VALUES ($1,'PAYMENT_PAID','Booking paid')`,
          [payment?.booking_id],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    if (!payment) return;
    if (payment.additional_request_id) return;

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
          reference_no:   p.reference_no || `SVN-${String(payment.booking_id).padStart(6, "0")}`,
        });
      }
    } catch (emailErr) {
      console.error("payment_confirmed email failed:", emailErr);
    }
  }

  if (eventType === "checkout_session.payment.failed") {
    const client = await pool.connect();
    let failedPayment: { booking_id: number; amount: number | string } | null = null;
    try {
      await client.query("BEGIN");
      if (!(await claimWebhookEvent(client, eventId))) {
        await client.query("COMMIT");
        return;
      }
      const failedUpdate = await client.query(
        `UPDATE ${dbSchema}.payments
            SET status = 'FAILED', webhook_event_id = $2, raw_response = $3
          WHERE (provider_payment_id = $1
                 OR superseded_session_ids @> ARRAY[$1])
            AND provider = 'PAYMONGO'
            AND status = 'PENDING'
          RETURNING booking_id, amount`,
        [providerPaymentId, eventId, payload],
      );

      if (!failedUpdate.rowCount) {
        const current = await client.query(
          `SELECT status
             FROM ${dbSchema}.payments
            WHERE provider = 'PAYMONGO'
              AND (provider_payment_id = $1
                OR superseded_session_ids @> ARRAY[$1]
                OR raw_response #>> '{data,id}' = $1
                OR raw_response #>> '{data,attributes,data,id}' = $1)
            LIMIT 1`,
          [providerPaymentId],
        );
        const status = String(current.rows[0]?.status ?? '').toUpperCase();
        // Failure is monotonic: a delayed/duplicate failure can never demote a
        // charge that has subsequently settled or entered refund handling.
        if (['FAILED', 'PAID', 'REFUNDING', 'REFUNDED'].includes(status)) {
          await client.query("COMMIT");
          return;
        }
        throw new Error("PayMongo checkout session not found");
      }
      failedPayment = failedUpdate.rows[0];
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    // Send payment failed email to customer
    try {
      if (failedPayment?.booking_id) {
        const bookingId = failedPayment.booking_id;
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
            amount:       failedPayment.amount || "0.00",
            booking_date: schedule ? new Date(schedule).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }) : "",
            // retry_url:    `${process.env.APP_URL}/bookings/${bookingId}/pay`,
          });
        }
      }
    } catch (emailErr) {
      console.error("payment_failed email failed:", emailErr);
    }
  }

  if (eventType === "refund.succeeded") {
    const refundId = String(eventData.id);
    const refundAttributes = eventData.attributes ?? {};
    const refundedPaymentId = String(refundAttributes.payment_id ?? "");
    const refundAmount = Number(refundAttributes.amount);
    const refundCurrency = String(refundAttributes.currency ?? "").toUpperCase();
    if (!refundId.startsWith("ref_") || !refundedPaymentId.startsWith("pay_") ||
        !Number.isSafeInteger(refundAmount) || refundAmount <= 0 || refundCurrency !== "PHP" ||
        String(refundAttributes.status ?? "").toLowerCase() !== "succeeded") {
      throw new Error("Invalid PayMongo refund payload");
    }

    const client = await pool.connect();
    let confirmedRefund: { bookingId: number; paymentId: number; refundAttempt: number; amount: number } | null = null;
    try {
      await client.query("BEGIN");
      if (!(await claimWebhookEvent(client, eventId))) {
        await client.query("COMMIT");
        return;
      }
      const current = await client.query(
        `SELECT id, booking_id, additional_request_id, status, refund_reference,
                COALESCE(refund_attempt, 0) AS refund_attempt, amount,
                ROUND(amount * 100) AS amount_centavos
           FROM ${dbSchema}.payments
          WHERE provider = 'PAYMONGO' AND provider_payment_id = $1
          LIMIT 1 FOR UPDATE`,
        [refundedPaymentId],
      );
      const payment = current.rows[0];
      if (!payment || Number(payment.amount_centavos) !== refundAmount) {
        throw new Error("PayMongo refund payment or amount did not match");
      }
      if (String(payment.status).toUpperCase() === "REFUNDED" &&
          String(payment.refund_reference ?? "") === refundId) {
        await client.query(
          `UPDATE ${dbSchema}.payments SET webhook_event_id = $2, raw_response = $3, updated_at = NOW()
            WHERE id = $1`,
          [payment.id, eventId, payload],
        );
        await client.query("COMMIT");
        return;
      }
      if (!["PAID", "REFUNDING"].includes(String(payment.status).toUpperCase())) {
        throw new Error("Payment is not eligible for refund settlement");
      }
      await client.query(
        `UPDATE ${dbSchema}.payments
            SET status = 'REFUNDED', refunded_at = NOW(), refunded_amount = amount,
                refund_reference = $2, webhook_event_id = $3, raw_response = $4,
                updated_at = NOW()
          WHERE id = $1`,
        [payment.id, refundId, eventId, payload],
      );
      if (payment.additional_request_id) {
        await client.query(
          `UPDATE ${dbSchema}.booking_additional_requests
              SET status = 'REFUNDED', decided_at = COALESCE(decided_at, NOW()), updated_at = NOW()
            WHERE id = $1`,
          [payment.additional_request_id],
        );
      }
      await client.query(
        `INSERT INTO ${dbSchema}.booking_tracking (booking_id, status, note)
         VALUES ($1, 'PAYMENT_REFUNDED', 'Payment refund confirmed')`,
        [payment.booking_id],
      );
      confirmedRefund = {
        bookingId: Number(payment.booking_id),
        paymentId: Number(payment.id),
        refundAttempt: Number(payment.refund_attempt),
        amount: Number(payment.amount),
      };
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    if (confirmedRefund) {
      const refund = confirmedRefund as { bookingId: number; paymentId: number; refundAttempt: number; amount: number };
      const safeReference = `SVN-RF-${String(refund.paymentId).padStart(8, "0")}-${String(refund.refundAttempt).padStart(2, "0")}`;
      const customer = await dbQuery.query(
        `SELECT b.user_id FROM ${dbSchema}.bookings b WHERE b.id = $1`,
        [refund.bookingId],
      ).catch(() => ({ rows: [] as any[] }));
      const customerUid = customer.rows[0]?.user_id;
      if (customerUid) {
        createCustomerNotification(customerUid, {
          type: "payment_refunded",
          severity: "info",
          title: "Refund confirmed",
          safeBody: `Your refund for booking SVN-${String(refund.bookingId).padStart(6, "0")} has been confirmed.`,
          safeContextLabel: safeReference,
          route: { page: "booking_detail", bookingId: String(refund.bookingId) },
          canOpenDetail: true,
          notificationKey: `payment_refunded_${refund.bookingId}_${refund.paymentId}`,
        }).catch((e) => console.error("refund customer notification failed", e));
      }
      try {
        const userInfo = await getUserInfoByBookingId(refund.bookingId);
        if (userInfo) {
          send(userInfo.email, "refund_processed", {
            first_name: userInfo.firstName,
            booking_id: refund.bookingId,
            amount: refund.amount,
            refund_id: safeReference,
            refunded_at: new Date().toLocaleString("en-US", {
              month: "long", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit",
            }),
          });
        }
      } catch (emailErr) {
        console.error("refund_processed webhook email failed:", emailErr);
      }
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
