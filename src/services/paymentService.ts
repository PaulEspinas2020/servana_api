import { db } from "../config";
import { Request, Response } from "express";
import dbQuery from "../db/dbQuery";
import crypto from "crypto";

const dbSchema = db.schema;
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

  return {
    booking_id: bookingId,
    provider_payment_id: providerPaymentId,
    checkout_url: checkoutUrl
  };
};

const PAYMONGO_WEBHOOK_SECRET = process.env.PAYMONGO_WEBHOOK_SECRET || "";

const verifySignature = (rawBody: string, signatureHeader?: string) => {
  if (!PAYMONGO_WEBHOOK_SECRET || !signatureHeader) return true;

  const digest = crypto
    .createHmac("sha256", PAYMONGO_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");

  return signatureHeader.includes(digest);
};

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

export const processWebhook = async (req: Request) => {
  const rawBody =
    (req as any).rawBody?.toString?.() || JSON.stringify(req.body);

  const signatureHeader =
    (req.headers["paymongo-signature"] as string | undefined) ||
    (req.headers["Paymongo-Signature"] as string | undefined);

  console.log("Webhook signature:", signatureHeader);
  console.log("Webhook rawBody:", rawBody);
  console.log("Webhook parsed body:", req.body);

  if (!verifySignature(rawBody, signatureHeader)) {
    throw new Error("Invalid PayMongo signature");
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
    const r = await dbQuery.query(
      `
      UPDATE ${dbSchema}.payments
      SET status = 'PAID',
          paid_at = NOW(),
          webhook_event_id = $2,
          raw_response = $3
      WHERE provider_payment_id = $1
      RETURNING booking_id
      `,
      [providerPaymentId, eventId, payload]
    );

    if (r.rowCount) {
      const bookingId = r.rows[0].booking_id;

      await dbQuery.query(
        `
        UPDATE ${dbSchema}.bookings
        SET status = 'PAID'
        WHERE id = $1
        `,
        [bookingId]
      );

      await dbQuery.query(
        `
        INSERT INTO ${dbSchema}.booking_tracking
          (booking_id, status, note)
        VALUES
          ($1, 'PAYMENT_PAID', 'PayMongo webhook confirmed payment')
        `,
        [bookingId]
      );

      // await dispatchAfterPayment(bookingId);
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
  }
};