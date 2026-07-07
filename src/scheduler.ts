import cron from "node-cron";
import { db } from "./config";
import dbQuery from "./db/dbQuery";
import { processPendingDisbursements, retryFailedDisbursements } from "./services/disbursement.service";
import { createCheckoutSession } from "./services/paymentService";
import { send } from "./helpers/mailer";
import { getUserInfoByBookingId } from "./services/user.service";

const dbSchema = db.schema;

// ---------------------------------------------------------------------------
// JOB 1 — Disbursement release (every hour at :00)
// Releases worker payouts for bookings completed 72+ hours ago.
// ---------------------------------------------------------------------------

const runDisbursements = async () => {
  console.log("[scheduler] Running disbursement release…");
  try {
    await processPendingDisbursements();
  } catch (err) {
    console.error("[scheduler] Disbursement release error:", err);
  }
};

// ---------------------------------------------------------------------------
// JOB 2 — PENDING_OTP reminder (every 4 hours)
// Sends a reminder email to customers whose booking OTP is unconfirmed for 2–48 h.
// ---------------------------------------------------------------------------

const runOtpReminders = async () => {
  console.log("[scheduler] Sending PENDING_OTP reminders…");

  try {
    const res = await dbQuery.query(
      `
      SELECT
        b.id        AS booking_id,
        b.otp_code,
        b.schedule,
        b.created_at,
        uc.email,
        uc.first_name,
        so.level_2  AS service_name
      FROM ${dbSchema}.bookings b
      JOIN ${dbSchema}.user_credentials uc ON uc.uid = b.user_id
      LEFT JOIN ${dbSchema}.service_options so ON so.id = b.service_option_id
      WHERE b.status = 'PENDING_OTP'
        AND b.created_at < NOW() - INTERVAL '2 hours'
        AND b.created_at > NOW() - INTERVAL '48 hours'
      `,
      []
    );

    if (!res.rowCount) {
      console.log("[scheduler] No PENDING_OTP bookings to remind.");
      return;
    }

    for (const row of res.rows) {
      try {
        send(row.email, "booking_otp_reminder", {
          first_name:   row.first_name,
          booking_id:   row.booking_id,
          otp_code:     row.otp_code,
          service_name: row.service_name || "Home Service",
          booking_date: row.schedule
            ? new Date(row.schedule).toLocaleDateString("en-US", {
                year: "numeric",
                month: "long",
                day: "numeric",
              })
            : "",
        });
        console.log(`[scheduler] OTP reminder sent → booking #${row.booking_id}`);
      } catch (err) {
        console.error(`[scheduler] OTP reminder failed for booking #${row.booking_id}:`, err);
      }
    }
  } catch (err) {
    console.error("[scheduler] OTP reminder job error:", err);
  }
};

// ---------------------------------------------------------------------------
// JOB 3 — Failed payment retry (every 6 hours)
// Creates a new PayMongo checkout session for FAILED payments and emails the customer.
// ---------------------------------------------------------------------------

const runPaymentRetries = async () => {
  console.log("[scheduler] Retrying failed PayMongo payments…");

  try {
    const res = await dbQuery.query(
      `
      SELECT
        p.id        AS payment_id,
        p.booking_id,
        p.amount
      FROM ${dbSchema}.payments p
      JOIN ${dbSchema}.bookings b ON b.id = p.booking_id
      WHERE p.status  = 'FAILED'
        AND p.provider = 'PAYMONGO'
        AND b.status NOT IN ('COMPLETED', 'CANCELED', 'PAID')
        AND p.updated_at < NOW() - INTERVAL '6 hours'
      `,
      []
    );

    if (!res.rowCount) {
      console.log("[scheduler] No failed payments to retry.");
      return;
    }

    for (const row of res.rows) {
      try {
        // Reset payment to PENDING then create a fresh checkout session
        await dbQuery.query(
          `UPDATE ${dbSchema}.payments SET status = 'PENDING', updated_at = NOW() WHERE id = $1`,
          [row.payment_id]
        );

        const session = await createCheckoutSession(row.booking_id);

        const userInfo = await getUserInfoByBookingId(row.booking_id);
        if (userInfo) {
          send(userInfo.email, "payment_retry", {
            first_name:   userInfo.firstName,
            booking_id:   row.booking_id,
            amount:       row.amount,
            checkout_url: session.checkout_url,
          });
        }

        console.log(`[scheduler] Retry checkout created for booking #${row.booking_id}`);
      } catch (err) {
        console.error(`[scheduler] Payment retry failed for booking #${row.booking_id}:`, err);
      }
    }
  } catch (err) {
    console.error("[scheduler] Payment retry job error:", err);
  }
};

// ---------------------------------------------------------------------------
// Start all scheduled jobs
// ---------------------------------------------------------------------------

export const startScheduler = () => {
  // Every hour — release worker payouts due after 72 h
  cron.schedule("0 * * * *", runDisbursements);

  // Every 6 hours — retry failed disbursements
  cron.schedule("0 */6 * * *", retryFailedDisbursements);

  // Every 4 hours — remind customers with unconfirmed OTP
  cron.schedule("0 */4 * * *", runOtpReminders);

  // Every 6 hours — retry failed PayMongo checkout sessions
  cron.schedule("0 */6 * * *", runPaymentRetries);

  console.log("[scheduler] All cron jobs started.");
};
