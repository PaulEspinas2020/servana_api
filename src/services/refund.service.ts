import axios from "axios";
import { db } from "../config";
import dbQuery from "../db/dbQuery";
import { send } from "../helpers/mailer";
import { getUserInfoByBookingId } from "./user.service";

const dbSchema = db.schema;

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

    try {
      // 3. Call PayMongo refund API
      const refundRes = await axios.post(
        "https://api.paymongo.com/v1/refunds",
        {
          data: {
            attributes: {
              payment_id: payment.provider_payment_id,
              amount: payment.amount * 100, // PayMongo uses cents
              reason: "requested_by_customer"
            }
          }
        },
        {
          headers: {
            Authorization: `Basic ${Buffer.from(
              process.env.PAYMONGO_SECRET_KEY + ":"
            ).toString("base64")}`,
            "Content-Type": "application/json"
          }
        }
      );

      const refundData = refundRes.data.data;

      // 4. Update payment status
      await dbQuery.query(
        `
        UPDATE ${dbSchema}.payments
        SET status = 'REFUNDED',
            refunded_at = NOW(),
            refund_reference = $2,
            raw_response = $3
        WHERE id = $1
        `,
        [payment.id, refundData.id, refundRes.data]
      );

      // 5. Update additional request
      await dbQuery.query(
        `
        UPDATE ${dbSchema}.booking_additional_requests
        SET status = 'REFUNDED',
            decided_at = NOW()
        WHERE id = $1
        `,
        [additionalRequestId]
      );

      // 6. Send refund confirmation email to customer
      try {
        if (payment.booking_id) {
          const userInfo = await getUserInfoByBookingId(payment.booking_id);
          if (userInfo) {
            send(userInfo.email, "refund_processed", {
              first_name:  userInfo.firstName,
              booking_id:  payment.booking_id,
              amount:      payment.amount,
              refund_id:   refundData.id,
              refunded_at: new Date().toLocaleString("en-US", { month: "long", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" }),
            });
          }
        }
      } catch (emailErr) {
        console.error("refund_processed email failed:", emailErr);
      }

      return {
        success: true,
        refundId: refundData.id
      };

    } catch (err: any) {

      console.error("Refund failed:", err?.response?.data || err.message);

      throw new Error("Refund failed");
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

    const refundRes = await axios.post(
      "https://api.paymongo.com/v1/refunds",
      {
        data: {
          attributes: {
            payment_id: payment.provider_payment_id,
            amount: payment.amount * 100
          }
        }
      },
      {
        headers: {
          Authorization: `Basic ${Buffer.from(
            process.env.PAYMONGO_SECRET_KEY + ":"
          ).toString("base64")}`
        }
      }
    );

    await dbQuery.query(
      `
      UPDATE ${dbSchema}.payments
      SET status = 'REFUNDED',
          refunded_at = NOW(),
          refund_reference = $2
      WHERE id = $1
      `,
      [paymentId, refundRes.data.data.id]
    );

    return { success: true };
  }
}

export const refundService = new RefundService();