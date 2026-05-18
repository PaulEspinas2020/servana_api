import { db } from "../config";
import { Request, Response } from "express";
import dbQuery from "../db/dbQuery";
import crypto from "crypto";
import axios from "axios";
import { additionalService } from "./additional.service";

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

    const checkoutSessionId = checkoutSession?.id;
    const attributes = checkoutSession?.attributes;

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