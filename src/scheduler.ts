import cron from "node-cron";
import { db } from "./config";
import dbQuery from "./db/dbQuery";
import { processPendingDisbursements, retryFailedDisbursements } from "./services/disbursement.service";
import { createCheckoutSession } from "./services/paymentService";
import { send } from "./helpers/mailer";
import { getUserInfoByBookingId } from "./services/user.service";
import { sweepGracePeriod } from "./chat/chat.service";
import { notifyAllAdmins } from './services/adminNotificationService';

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
        -- Both spellings, deliberately. Cancels are written inconsistently:
        -- bookings.status gets 'CANCELLED' (bookingService.customerCancelBooking)
        -- while booking_workers.status gets 'CANCELED', and technicianService
        -- writes 'CANCELED' to bookings in four places. NON_CANCELLABLE_STATUSES
        -- already matches both; this filter matched only one, so a booking
        -- cancelled through the customer app stayed eligible for payment retry.
        --
        -- Dormant until 799b6aa: this job died on a missing payments.updated_at
        -- every run, so it had never reached this line in production. Creating
        -- that column armed it. Left as-is, the first scheduler tick would email
        -- live PayMongo checkout links for cancelled bookings.
        AND UPPER(b.status) NOT IN ('COMPLETED', 'CANCELED', 'CANCELLED', 'PAID')
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
        // createCheckoutSession serializes by booking and advances FAILED to a
        // fresh session only after PayMongo returns a valid hosted URL. Changing
        // the row to PENDING here made its stale failed URL look recent, so the
        // old checkout was reused and emailed instead of being replaced.
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
// Booking conversations past their post-completion grace window
// ---------------------------------------------------------------------------

const runConversationGraceSweep = async () => {
  try {
    const ids = await sweepGracePeriod();
    if (ids.length) {
      console.log(`[scheduler] ${ids.length} booking conversation(s) moved to read-only.`);
    }
  } catch (err) {
    console.error("[scheduler] Conversation grace sweep error:", err);
  }
};

export const runDailyAdminBookingSummary = async () => {
  try {
    const result = await dbQuery.query(`
      SELECT COUNT(*) AS total
        FROM ${dbSchema}.bookings
       WHERE (schedule AT TIME ZONE 'Asia/Manila')::date =
             (NOW() AT TIME ZONE 'Asia/Manila')::date
         AND UPPER(status) NOT IN ('COMPLETED', 'CANCELED', 'CANCELLED')
    `, []);
    const total = Number(result.rows[0]?.total ?? 0);
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
    await notifyAllAdmins({
      type: 'daily_active_bookings', severity: 'info', title: 'Today’s active bookings',
      body: `${total} active booking${total === 1 ? '' : 's'} scheduled for today.`,
      notificationKey: `daily_active_bookings_${day}`,
    });
  } catch (err) {
    console.error('[scheduler] Daily admin booking summary error:', err);
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

  // Hourly — retire booking conversations whose post-completion grace window
  // has lapsed. Completion deliberately does NOT close the chat: the 48 hours
  // after a job are when "you left a cable behind", "can I get a receipt" and
  // "something isn't right" actually happen. After that it goes read-only, so
  // a finished booking cannot quietly become a permanent private channel.
  cron.schedule("30 * * * *", runConversationGraceSweep);

  // 07:00 every morning in the operational timezone, independent of host UTC.
  cron.schedule('0 7 * * *', runDailyAdminBookingSummary, { timezone: 'Asia/Manila' });

  console.log("[scheduler] All cron jobs started.");
};
