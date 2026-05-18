import { db } from "../config";
import dbQuery from "../db/dbQuery";
const dbSchema = db.schema;
import { createPayment } from "./paymentService";
import { refundService } from "./refund.service";

class AdditionalService {

  async createRequest(bookingId: number, items: any[], userId: string) {

    const booking = await dbQuery.query(
      `SELECT * FROM ${dbSchema}.bookings WHERE id = $1`,
      [bookingId]
    );

    if (!booking.rows[0]) throw new Error("Booking not found");

    // if (booking.rows[0].status !== "IN_PROGRESS") {
    //   throw new Error("Worker must be onsite (IN_PROGRESS)");
    // }

    let total = 0;

    const requestRes =await dbQuery.query(
      `INSERT INTO ${dbSchema}.booking_additional_requests
       (booking_id, requested_by, status, total_amount)
       VALUES ($1,$2,$3,$4)
       RETURNING *`,
      [bookingId, userId, "PENDING_ADMIN_APPROVAL", 0]
    );
    const request = requestRes.rows[0];
    for (const item of items) {
      const totalPrice = item.unitPrice * item.quantity;
      total += totalPrice;

      await dbQuery.query(
        `INSERT INTO ${dbSchema}.booking_additional_items
         (additional_request_id, service_option_id, quantity, unit_price, total_price)
         VALUES ($1,$2,$3,$4,$5)`,
        [
          request.id,
          item.serviceOptionId,
          item.quantity,
          item.unitPrice,
          totalPrice
        ]
      );
    }

    const resultReq = await dbQuery.query(
      `UPDATE ${dbSchema}.booking_additional_requests
       SET total_amount = $1 WHERE id = $2 RETURNING *`,
      [total, request.id]
    );
     const result = resultReq.rows[0];
    return result;
  }

  async approve(id: number) {
    await dbQuery.query(
      `UPDATE ${dbSchema}.booking_additional_requests
       SET status = 'WAITING_FOR_PAYMENT',
           approved_at = NOW()
       WHERE id = $1`,
      [id]
    );
  }

  async generatePayment(id: number) {

    const res = await dbQuery.query(
      `SELECT * FROM ${dbSchema}.booking_additional_requests WHERE id = $1`,
      [id]
    );

    return createPayment(res.rows[0]);
  }

  async markPaid(requestId: number) {

    await dbQuery.query(
      `UPDATE ${dbSchema}.booking_additional_requests
       SET status = 'WAITING_WORKER_APPROVAL',
           paid_at = NOW()
       WHERE id = $1`,
      [requestId]
    );
  }

  async workerDecision(id: number, decision: "ACCEPT" | "REJECT") {

    if (decision === "REJECT") {

      await dbQuery.query(
        `UPDATE ${dbSchema}.booking_additional_requests
         SET status = 'REJECTED',
             worker_decision = 'REJECT',
             decided_at = NOW()
         WHERE id = $1`,
        [id]
      );

      await refundService.refundAdditionalRequest(id);
      return;
    }

    await dbQuery.query(
      `UPDATE ${dbSchema}.booking_additional_requests
       SET status = 'ACCEPTED',
           worker_decision = 'ACCEPT',
           decided_at = NOW()
       WHERE id = $1`,
      [id]
    );
  }

  async getByBooking(bookingId: number) {
    const res = await dbQuery.query(
      `SELECT * FROM ${dbSchema}.booking_additional_requests
       WHERE booking_id = $1
       ORDER BY created_at DESC`,
      [bookingId]
    );

    return res.rows;
  }
}

export const additionalService = new AdditionalService();