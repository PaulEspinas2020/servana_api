import axios from "axios";
import { db } from "../config";
import dbQuery, { pool } from "../db/dbQuery";
import { send } from "../helpers/mailer";
import { getUserInfoByBookingId } from "./user.service";
import { ensureFinanceLedgerSchema, recordPaymentRefunded } from "./finance/financeLedger";

const dbSchema = db.schema;
const PAYMONGO_REFUND_TIMEOUT_MS = 15_000;

const paymongoAuthHeader = () => {
  const key = process.env.PAYMONGO_SECRET_KEY || process.env.PAYMONGO_SK_DEV || "";
  if (!key) throw new Error("PayMongo is not configured");
  return `Basic ${Buffer.from(`${key}:`).toString("base64")}`;
};

// A timeout/5xx is an unknown outcome: PayMongo may have accepted the refund
// even though Servana did not receive the response. Keep REFUNDING so an admin
// reconciles it instead of issuing a second irreversible refund.
const isDefinitelyRejected = (err: any) => {
  if (err?.definitelyRejected === true) return true;
  const status = Number(err?.response?.status);
  return status >= 400 && status < 500 && ![408, 409, 425, 429].includes(status);
};

const safeRefundReference = (paymentId: number, attempt: number) =>
  `SVN-RF-${String(paymentId).padStart(8, "0")}-${String(attempt).padStart(2, "0")}`;

const parseRefund = (body: any, paymentId: string, amount: number) => {
  const data = body?.data;
  const attributes = data?.attributes ?? {};
  const status = String(attributes.status ?? "").toLowerCase();
  if (!String(data?.id ?? "").startsWith("ref_") ||
      String(attributes.payment_id ?? "") !== paymentId ||
      Number(attributes.amount) !== amount ||
      String(attributes.currency ?? "").toUpperCase() !== "PHP" ||
      !["pending", "processing", "succeeded", "failed"].includes(status)) {
    throw new Error("Invalid PayMongo refund response");
  }
  return { id: String(data.id), status };
};

const persistSuccessfulRefund = async (
  payment: any,
  refundId: string,
  rawResponse: any,
  additionalRequestId?: number,
) => {
  // Ensured before the transaction opens: the ledger write below runs on this
  // transaction's client, and issuing DDL from a second connection while it is
  // open is ordering nobody should have to reason about.
  await ensureFinanceLedgerSchema();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query(
      `UPDATE ${dbSchema}.payments
          SET status = 'REFUNDED', refunded_at = NOW(), refunded_amount = amount,
              refund_reference = $2, raw_response = $3, updated_at = NOW()
        WHERE id = $1 AND status = 'REFUNDING'
        RETURNING booking_id, amount, COALESCE(refund_attempt, 0) AS refund_attempt`,
      [payment.id, refundId, rawResponse],
    );
    if (!updated.rowCount) throw new Error("Refund state changed before settlement");

    // The money went back. Recorded in the same transaction that records the
    // state change, so the two can never disagree about whether it happened.
    await recordPaymentRefunded(
      {
        bookingId: Number(updated.rows[0].booking_id),
        paymentId: Number(payment.id),
        refundAttempt: Number(updated.rows[0].refund_attempt),
        amount: updated.rows[0].amount,
        processorReference: refundId,
      },
      client,
    );
    if (additionalRequestId) {
      await client.query(
        `UPDATE ${dbSchema}.booking_additional_requests
            SET status = 'REFUNDED', decided_at = COALESCE(decided_at, NOW()), updated_at = NOW()
          WHERE id = $1`,
        [additionalRequestId],
      );
    }
    await client.query(
      `INSERT INTO ${dbSchema}.booking_tracking (booking_id, status, note)
       VALUES ($1, 'PAYMENT_REFUNDED', 'Payment refund confirmed')`,
      [updated.rows[0].booking_id],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};

class RefundService {

  async refundAdditionalRequest(additionalRequestId: number) {

    // 1. Get payment linked to additional request
    const paymentRes = await dbQuery.query(
      `
      SELECT *
      FROM ${dbSchema}.payments
      WHERE additional_request_id = $1
      LIMIT 1
      `,
      [additionalRequestId]
    );

    const payment = paymentRes.rows[0];

    if (!payment) {
      throw new Error("Payment not found for refund");
    }

    // 2. Prevent double refund (idempotency)
    if (payment.status === "REFUNDED") {
      return { message: "Already refunded" };
    }

    if (payment.status !== "PAID") {
      throw new Error("Only paid payments can be refunded");
    }

    if (payment.provider !== 'PAYMONGO' || !String(payment.provider_payment_id ?? '').startsWith('pay_')) {
      throw new Error('Payment is not refundable through PayMongo');
    }

    const amount = Math.round(Number(payment.amount) * 100);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Invalid refund amount');

    // Atomically claim the refund before making the irreversible processor
    // call. This closes the double-click/concurrent-worker refund race.
    const claimed = await dbQuery.query(
      `UPDATE ${dbSchema}.payments
          SET status = 'REFUNDING', refund_attempt = COALESCE(refund_attempt, 0) + 1,
              updated_at = NOW()
        WHERE id = $1 AND status = 'PAID'
        RETURNING id, refund_attempt`,
      [payment.id],
    );
    if (!claimed.rowCount) throw new Error('Refund already in progress');
    const refundAttempt = Number(claimed.rows[0].refund_attempt);
    const publicReference = safeRefundReference(Number(payment.id), refundAttempt);

    try {
      // 3. Call PayMongo refund API
      const refundRes = await axios.post(
        "https://api.paymongo.com/v1/refunds",
        {
          data: {
            attributes: {
              payment_id: payment.provider_payment_id,
              amount,
              reason: "requested_by_customer"
            }
          }
        },
        {
          headers: {
            Authorization: paymongoAuthHeader(),
            "Content-Type": "application/json",
            "Idempotency-Key": `servana-refund-payment-${payment.id}-attempt-${refundAttempt}`,
          },
          timeout: PAYMONGO_REFUND_TIMEOUT_MS,
        }
      );

      const refund = parseRefund(refundRes.data, payment.provider_payment_id, amount);
      if (refund.status === "failed") {
        throw Object.assign(new Error("Refund was rejected"), { definitelyRejected: true });
      }
      if (["pending", "processing"].includes(refund.status)) {
        await dbQuery.query(
          `UPDATE ${dbSchema}.payments
              SET refund_reference = $2, raw_response = $3, updated_at = NOW()
            WHERE id = $1 AND status = 'REFUNDING'`,
          [payment.id, refund.id, refundRes.data],
        );
        return { success: true, pending: true, reference: publicReference };
      }

      await persistSuccessfulRefund(payment, refund.id, refundRes.data, additionalRequestId);

      // 6. Send refund confirmation email to customer
      try {
        if (payment.booking_id) {
          const userInfo = await getUserInfoByBookingId(payment.booking_id);
          if (userInfo) {
            send(userInfo.email, "refund_processed", {
              first_name:  userInfo.firstName,
              booking_id:  payment.booking_id,
              amount:      payment.amount,
              refund_id:   publicReference,
              refunded_at: new Date().toLocaleString("en-US", { month: "long", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" }),
            });
          }
        }
      } catch (emailErr) {
        console.error("refund_processed email failed:", emailErr);
      }

      return {
        success: true,
        reference: publicReference,
      };

    } catch (err: any) {

      if (isDefinitelyRejected(err)) {
        await dbQuery.query(
          `UPDATE ${dbSchema}.payments SET status = 'PAID', updated_at = NOW()
           WHERE id = $1 AND status = 'REFUNDING'`,
          [payment.id],
        ).catch(() => undefined);
      }
      console.error("Refund request failed", {
        paymentId: payment.id,
        outcome: isDefinitelyRejected(err) ? "rejected" : "unknown",
        httpStatus: err?.response?.status ?? null,
      });
      throw new Error(isDefinitelyRejected(err)
        ? "Refund was rejected"
        : "Refund outcome is pending reconciliation");
    }
  }

  // Optional: manual refund for admin override
  async forceRefund(paymentId: number) {

    const paymentRes = await dbQuery.query(
      `
      SELECT *
      FROM ${dbSchema}.payments
      WHERE id = $1
      `,
      [paymentId]
    );

    const payment = paymentRes.rows[0];

    if (!payment) throw new Error("Payment not found");

    if (payment.status === "REFUNDED") {
      return;
    }

    if (payment.status !== 'PAID') throw new Error('Only paid payments can be refunded');
    if (payment.provider !== 'PAYMONGO' || !String(payment.provider_payment_id ?? '').startsWith('pay_')) {
      throw new Error('Payment is not refundable through PayMongo');
    }
    const amount = Math.round(Number(payment.amount) * 100);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Invalid refund amount');

    const claimed = await dbQuery.query(
      `UPDATE ${dbSchema}.payments
          SET status = 'REFUNDING', refund_attempt = COALESCE(refund_attempt, 0) + 1,
              updated_at = NOW()
        WHERE id = $1 AND status = 'PAID'
        RETURNING id, refund_attempt`,
      [payment.id],
    );
    if (!claimed.rowCount) throw new Error('Refund already in progress');
    const refundAttempt = Number(claimed.rows[0].refund_attempt);
    const publicReference = safeRefundReference(Number(payment.id), refundAttempt);

    try {
      const refundRes = await axios.post(
      "https://api.paymongo.com/v1/refunds",
      {
        data: {
          attributes: {
            payment_id: payment.provider_payment_id,
            amount
          }
        }
      },
      {
        headers: {
          Authorization: paymongoAuthHeader(),
          "Content-Type": "application/json",
          "Idempotency-Key": `servana-refund-payment-${payment.id}-attempt-${refundAttempt}`,
        },
        timeout: PAYMONGO_REFUND_TIMEOUT_MS,
      }
    );

      const refund = parseRefund(refundRes.data, payment.provider_payment_id, amount);
      if (refund.status === "failed") {
        throw Object.assign(new Error("Refund was rejected"), { definitelyRejected: true });
      }
      if (["pending", "processing"].includes(refund.status)) {
        await dbQuery.query(
          `UPDATE ${dbSchema}.payments
              SET refund_reference = $2, raw_response = $3, updated_at = NOW()
            WHERE id = $1 AND status = 'REFUNDING'`,
          [payment.id, refund.id, refundRes.data],
        );
        return { success: true, pending: true, reference: publicReference };
      }
      await persistSuccessfulRefund(payment, refund.id, refundRes.data);
      return { success: true, reference: publicReference };
    } catch (err: any) {
      if (isDefinitelyRejected(err)) {
        await dbQuery.query(
          `UPDATE ${dbSchema}.payments SET status = 'PAID', updated_at = NOW()
           WHERE id = $1 AND status = 'REFUNDING'`,
          [payment.id],
        ).catch(() => undefined);
      }
      throw new Error(isDefinitelyRejected(err)
        ? "Refund was rejected"
        : "Refund outcome is pending reconciliation");
    }
  }
}

export const refundService = new RefundService();
