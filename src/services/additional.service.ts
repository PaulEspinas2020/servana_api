import { db } from "../config";
import dbQuery, { pool } from "../db/dbQuery";
const dbSchema = db.schema;
import { createPayment } from "./paymentService";
import { refundService } from "./refund.service";
import { send } from "../helpers/mailer";
import { getUserInfoByBookingId } from "./user.service";

class AdditionalService {
  async authorizeBookingActor(
    bookingId: number,
    actorUid: string,
    access: "provider" | "participant",
  ) {
    if (!Number.isInteger(bookingId) || bookingId <= 0) {
      throw Object.assign(new Error("Booking not found"), { statusCode: 404 });
    }
    const result = await dbQuery.query(
      `SELECT id, user_id, worker_uid FROM ${dbSchema}.bookings WHERE id = $1 LIMIT 1`,
      [bookingId],
    );
    const booking = result.rows[0];
    const authorized = booking && (
      booking.worker_uid === actorUid ||
      (access === "participant" && booking.user_id === actorUid)
    );
    if (!authorized) {
      throw Object.assign(new Error("Booking not found"), { statusCode: 404 });
    }
    return booking;
  }

  private fail(
    message: string,
    statusCode: 400 | 404 | 409 = 400,
    code = "ADDITIONAL_WORK_INVALID",
  ): never {
    throw Object.assign(new Error(message), { statusCode, code });
  }

  async getRequestContext(id: number) {
    if (!Number.isSafeInteger(id) || id <= 0) {
      this.fail("Invalid additional work request id");
    }
    const result = await dbQuery.query(
      `SELECT id, booking_id, status, total_amount
       FROM ${dbSchema}.booking_additional_requests
       WHERE id = $1`,
      [id],
    );
    if (!result.rowCount) {
      this.fail("Additional work request not found", 404, "ADDITIONAL_WORK_NOT_FOUND");
    }
    return result.rows[0];
  }

  async createRequest(bookingId: number, items: any[], providerUid: string) {
    if (!Number.isSafeInteger(bookingId) || bookingId <= 0) {
      this.fail("Invalid booking id");
    }
    if (!providerUid) this.fail("Authentication is required", 400, "UNAUTHENTICATED");
    if (!Array.isArray(items) || items.length === 0 || items.length > 25) {
      this.fail("At least one and no more than 25 additional work items are required");
    }

    // The provider portal historically sent { amount } while the backend only
    // read { unitPrice, quantity }. Multiplication by undefined produced NaN and
    // either a database error or a zero-looking request. Accept both shapes at
    // the boundary and reduce them to one validated representation.
    const normalized = items.map((item: any) => {
      const quantity = Number(item?.quantity ?? 1);
      const unitPrice = Number(item?.unitPrice ?? item?.amount);
      const serviceOptionId = item?.serviceOptionId == null
        ? null
        : Number(item.serviceOptionId);
      if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 100) {
        this.fail("Each item quantity must be a whole number between 1 and 100");
      }
      if (!Number.isFinite(unitPrice) || unitPrice <= 0 || unitPrice > 1_000_000) {
        this.fail("Each item amount must be between PHP 0.01 and PHP 1,000,000");
      }
      if (serviceOptionId !== null &&
          (!Number.isSafeInteger(serviceOptionId) || serviceOptionId <= 0)) {
        this.fail("Invalid service option id");
      }
      return { quantity, unitPrice, serviceOptionId };
    });

    const total = Math.round(normalized.reduce(
      (sum, item) => sum + item.unitPrice * item.quantity,
      0,
    ) * 100) / 100;
    if (!Number.isFinite(total) || total <= 0 || total > 1_000_000) {
      this.fail("Additional work total must be between PHP 0.01 and PHP 1,000,000");
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Creation is an operational booking action. The assignment row is the
      // provider-state source of truth, and only an in-progress job may acquire
      // on-site additional work. The lock prevents completion/reassignment from
      // racing this write.
      const booking = await client.query(
        `SELECT b.id, b.service_option_id
         FROM ${dbSchema}.bookings b
         JOIN ${dbSchema}.booking_workers bw ON bw.booking_id = b.id
         WHERE b.id = $1 AND bw.worker_uid = $2 AND bw.status = 'IN_PROGRESS'
         FOR UPDATE OF b`,
        [bookingId, providerUid],
      );
      if (!booking.rowCount) {
        this.fail(
          "Additional work can only be submitted by the provider working this booking",
          409,
          "ADDITIONAL_WORK_BOOKING_NOT_IN_PROGRESS",
        );
      }

      const requestRes = await client.query(
        `INSERT INTO ${dbSchema}.booking_additional_requests
           (booking_id, requested_by, status, total_amount)
         VALUES ($1,$2,'PENDING_ADMIN_APPROVAL',$3)
         RETURNING *`,
        [bookingId, providerUid, total],
      );
      const request = requestRes.rows[0];

      for (const item of normalized) {
        await client.query(
          `INSERT INTO ${dbSchema}.booking_additional_items
             (additional_request_id, service_option_id, quantity, unit_price, total_price)
           VALUES ($1,$2,$3,$4,$5)`,
          [
            request.id,
            item.serviceOptionId ?? booking.rows[0].service_option_id,
            item.quantity,
            item.unitPrice,
            Math.round(item.unitPrice * item.quantity * 100) / 100,
          ],
        );
      }
      await client.query("COMMIT");
      return request;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async approve(id: number) {
    const result = await dbQuery.query(
      `UPDATE ${dbSchema}.booking_additional_requests
       SET status = 'WAITING_FOR_PAYMENT',
           approved_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'PENDING_ADMIN_APPROVAL'
       RETURNING *, total_amount AS approved_amount`,
      [id]
    );
    if (!result.rowCount) {
      const current = await this.getRequestContext(id);
      this.fail(
        `Cannot approve from status: ${current.status}`,
        409,
        "ADDITIONAL_WORK_INVALID_TRANSITION",
      );
    }
    return result.rows[0];
  }

  async generatePayment(id: number, options?: { returnOrigin?: string }) {

    const res = await dbQuery.query(
      `SELECT * FROM ${dbSchema}.booking_additional_requests WHERE id = $1`,
      [id]
    );

    const request = res.rows[0];
    if (!request) this.fail("Additional work request not found", 404, "ADDITIONAL_WORK_NOT_FOUND");
    if (request.status !== "WAITING_FOR_PAYMENT") {
      this.fail(`Cannot create payment from status: ${request.status}`, 409, "ADDITIONAL_WORK_INVALID_TRANSITION");
    }

    const existing = await dbQuery.query(
      `SELECT checkout_url FROM ${dbSchema}.payments
       WHERE additional_request_id = $1 AND provider = 'PAYMONGO' AND status = 'PENDING'
         AND checkout_url IS NOT NULL AND updated_at > NOW() - INTERVAL '2 hours'
       ORDER BY id DESC LIMIT 1`,
      [id]
    );
    const checkoutUrl = existing.rows[0]?.checkout_url || await createPayment(request, options);

    // Notify customer that additional work was approved and payment is needed
    try {
      if (request?.booking_id) {
        const userInfo = await getUserInfoByBookingId(request.booking_id);
        if (userInfo) {
          send(userInfo.email, "additional_work_approved", {
            first_name:   userInfo.firstName,
            booking_id:   request.booking_id,
            request_id:   id,
            total_amount: request.total_amount,
            checkout_url: checkoutUrl,
          });
        }
      }
    } catch (emailErr) {
      console.error("additional_work_approved email failed:", emailErr);
    }

    return checkoutUrl;
  }

  async markPaid(requestId: number) {
    const result = await dbQuery.query(
      `UPDATE ${dbSchema}.booking_additional_requests
       SET status = 'WAITING_WORKER_APPROVAL',
           paid_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'WAITING_FOR_PAYMENT'
       RETURNING *, total_amount AS approved_amount`,
      [requestId]
    );
    if (!result.rowCount) {
      const current = await this.getRequestContext(requestId);
      this.fail(
        `Cannot mark paid from status: ${current.status}`,
        409,
        "ADDITIONAL_WORK_INVALID_TRANSITION",
      );
    }
    return result.rows[0];
  }

  async workerDecision(id: number, decision: "ACCEPT" | "REJECT") {

    if (decision === "REJECT") {

      const reqRes = await dbQuery.query(
        `SELECT booking_id, total_amount FROM ${dbSchema}.booking_additional_requests WHERE id = $1`,
        [id]
      );

      const updated = await dbQuery.query(
        `UPDATE ${dbSchema}.booking_additional_requests
         SET status = 'REJECTED',
             worker_decision = 'REJECT',
             decided_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND status = 'WAITING_WORKER_APPROVAL'
         RETURNING *, total_amount AS approved_amount`,
        [id]
      );
      if (!updated.rowCount) {
        const current = await this.getRequestContext(id);
        this.fail(`Cannot reject from status: ${current.status}`, 409, "ADDITIONAL_WORK_INVALID_TRANSITION");
      }

      await refundService.refundAdditionalRequest(id);

      // Notify customer of rejection and that a refund has been issued
      try {
        const req = reqRes.rows[0];
        if (req?.booking_id) {
          const userInfo = await getUserInfoByBookingId(req.booking_id);
          if (userInfo) {
            send(userInfo.email, "additional_work_rejected", {
              first_name:   userInfo.firstName,
              booking_id:   req.booking_id,
              request_id:   id,
              total_amount: req.total_amount,
            });
          }
        }
      } catch (emailErr) {
        console.error("additional_work_rejected email failed:", emailErr);
      }

      return updated.rows[0];
    }

    const updated = await dbQuery.query(
      `UPDATE ${dbSchema}.booking_additional_requests
       SET status = 'ACCEPTED',
           worker_decision = 'ACCEPT',
           decided_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'WAITING_WORKER_APPROVAL'
       RETURNING *, total_amount AS approved_amount`,
      [id]
    );
    if (!updated.rowCount) {
      const current = await this.getRequestContext(id);
      this.fail(`Cannot accept from status: ${current.status}`, 409, "ADDITIONAL_WORK_INVALID_TRANSITION");
    }
    return updated.rows[0];
  }

  async workerWithdraw(id: number) {
    const check = await dbQuery.query(
      `SELECT status FROM ${dbSchema}.booking_additional_requests WHERE id = $1`,
      [id]
    );
    const current = check.rows[0]?.status;
    if (!current || !['PENDING_ADMIN_APPROVAL', 'WAITING_WORKER_APPROVAL'].includes(current)) {
      if (!current) this.fail("Additional work request not found", 404, "ADDITIONAL_WORK_NOT_FOUND");
      this.fail(`Cannot withdraw from status: ${current}`, 409, "ADDITIONAL_WORK_INVALID_TRANSITION");
    }
    const result = await dbQuery.query(
      `UPDATE ${dbSchema}.booking_additional_requests
       SET status = 'CANCELLED', updated_at = NOW()
       WHERE id = $1 AND status = ANY($2::text[])
       RETURNING *`,
      [id, ['PENDING_ADMIN_APPROVAL', 'WAITING_WORKER_APPROVAL']],
    );
    if (!result.rowCount) {
      this.fail(`Cannot withdraw from status: ${current}`, 409, "ADDITIONAL_WORK_INVALID_TRANSITION");
    }
    return result.rows[0];
  }

  async workerConfirmProceed(id: number) {
    const check = await dbQuery.query(
      `SELECT status FROM ${dbSchema}.booking_additional_requests WHERE id = $1`,
      [id]
    );
    const current = check.rows[0]?.status;
    if (current !== 'ACCEPTED') {
      if (!current) this.fail("Additional work request not found", 404, "ADDITIONAL_WORK_NOT_FOUND");
      this.fail(`Cannot confirm proceed from status: ${current}`, 409, "ADDITIONAL_WORK_INVALID_TRANSITION");
    }
    const result = await dbQuery.query(
      `UPDATE ${dbSchema}.booking_additional_requests
       SET status = 'IN_PROGRESS', updated_at = NOW()
       WHERE id = $1 AND status = 'ACCEPTED'
       RETURNING *, total_amount AS approved_amount`,
      [id]
    );
    if (!result.rowCount) {
      this.fail(`Cannot confirm proceed from status: ${current}`, 409, "ADDITIONAL_WORK_INVALID_TRANSITION");
    }
    return result.rows[0];
  }

  async getByBooking(bookingId: number) {
    const res = await dbQuery.query(
      `SELECT id, booking_id, status, total_amount,
              CASE WHEN status IN (
                'WAITING_FOR_PAYMENT','WAITING_WORKER_APPROVAL','ACCEPTED',
                'IN_PROGRESS','PROCEEDING','COMPLETED'
              ) THEN total_amount ELSE NULL END AS approved_amount,
              approved_at, paid_at, worker_decision, decided_at,
              created_at, updated_at
       FROM ${dbSchema}.booking_additional_requests
       WHERE booking_id = $1
       ORDER BY created_at DESC`,
      [bookingId]
    );

    return res.rows;
  }
}

export const additionalService = new AdditionalService();
