import cron from "node-cron";
import { db } from "./config";
import dbQuery from "./db/dbQuery";
import { processPendingDisbursements, retryFailedDisbursements } from "./services/disbursement.service";
import { createCheckoutSession } from "./services/paymentService";
import { send } from "./helpers/mailer";
import { getUserInfoByBookingId } from "./services/user.service";
import { sweepGracePeriod } from "./chat/chat.service";
import { notifyAllAdmins } from './services/adminNotificationService';
import { withJobLease } from './services/scheduler/jobLease';

const dbSchema = db.schema;

/**
 * The actor recorded for a sweep nobody triggered.
 *
 * A uid-shaped literal rather than an empty string: the support-case event row
 * takes an actor, and an empty actor reads in a timeline as missing data rather
 * than as "the system did this".
 */
export const SLA_SWEEP_SYSTEM_ACTOR = 'system:sla-sweep';

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

/**
 * The scheduled jobs, declared rather than registered inline.
 *
 * Separating the WHAT from the WHEN is a TAB 08 work package, and it buys two
 * things immediately: the duplicate-effect risk of each job is written down next
 * to it, and a test can enumerate the jobs without starting cron.
 *
 * `name` is the lease identity. Changing one is not cosmetic — two replicas on
 * different names hold different locks and both run.
 */
export interface ScheduledJob {
  name: string;
  schedule: string;
  run: () => Promise<void>;
  options?: { timezone?: string };
  /** What a duplicate run would actually do. Kept honest, not aspirational. */
  duplicateEffect: string;
}

/**
 * JOB — support-case SLA sweep (every 15 minutes).
 *
 * ## Why this is a cron and not a button (TAB 09)
 *
 * `POST /api/admin/support/cases/sla-sweep` existed with a permission and no
 * caller and no schedule. The book asks which it should be. It is a cron, and
 * the reason is in what the sweep actually does rather than in convention:
 *
 *   - An SLA breach is created by the PASSAGE OF TIME. Nothing an operator does
 *     causes it and nothing they do reveals it. A control that only fires when
 *     somebody remembers to press it is not an SLA control, it is a report.
 *   - The sweep writes a PROVIDER-VISIBLE event — "Review target delayed". That
 *     is a commitment to the provider about their own case. Delivering it only
 *     when an admin happens to click is worse than never promising it, because
 *     the provider learns the delay at a moment unrelated to the delay.
 *   - It also raises priority NORMAL → HIGH, which is how a breached case
 *     reaches the top of a queue. Left unswept, the case that most needs
 *     attention is the one least likely to get it.
 *
 * ## Duplicate-safe by construction, not by luck
 *
 * The UPDATE carries `AND escalation_state <> 'SLA_BREACHED'` and only RETURNS
 * rows it actually moved, so the event insert and the realtime emit are driven
 * by the transition rather than by the query. A second pass finds nothing and
 * writes nothing. That is what makes it safe to run every fifteen minutes and
 * safe to run manually at the same time.
 *
 * ## The manual route stays
 *
 * It is permissioned (`support.sla.manage`) and it is genuinely useful — after
 * an incident, or when an operator wants the queue correct now rather than
 * within fifteen minutes. Scheduled by default, triggerable on demand, and the
 * same function either way (§9).
 */
const runSupportSlaSweep = async () => {
  console.log('[scheduler] Sweeping breached support-case SLAs…');
  try {
    const { sweepBreachedCases } = await import('./services/adminSupportCaseService');
    // No admin performed this. The event row already records actor_type
    // 'SYSTEM'; naming the job in the uid means an operator reading the case
    // timeline can tell a sweep from a person without cross-referencing.
    const result = await sweepBreachedCases(SLA_SWEEP_SYSTEM_ACTOR);
    if (result.processed) {
      console.log(`[scheduler] SLA sweep marked ${result.processed} case(s) breached.`);
    }
  } catch (err) {
    console.error('[scheduler] SLA sweep error:', err);
  }
};

export const SCHEDULED_JOBS: ScheduledJob[] = [
  {
    name: 'disbursement-release',
    schedule: '0 * * * *',
    run: runDisbursements,
    duplicateEffect:
      'None for money: releaseDisbursement claims each row with UPDATE ... WHERE status = PENDING ' +
      'and sends a per-attempt Idempotency-Key. A duplicate run wastes queries.',
  },
  {
    name: 'disbursement-retry',
    schedule: '0 */6 * * *',
    run: retryFailedDisbursements,
    duplicateEffect:
      'None for money: the same conditional claim on status = FAILED. Duplicate run wastes queries.',
  },
  {
    name: 'otp-reminder',
    schedule: '0 */4 * * *',
    run: runOtpReminders,
    duplicateEffect:
      'DUPLICATE EMAILS. A plain SELECT then send() per row, with no per-booking dedupe — ' +
      'this is the job the lease most protects.',
  },
  {
    name: 'payment-retry',
    schedule: '0 */6 * * *',
    run: runPaymentRetries,
    duplicateEffect:
      'DUPLICATE EMAILS. createCheckoutSession is serialized per booking by an advisory lock, so ' +
      'the session is safe, but the send() after it is not.',
  },
  {
    // Hourly — retire booking conversations whose post-completion grace window
    // has lapsed. Completion deliberately does NOT close the chat: the 48 hours
    // after a job are when "you left a cable behind", "can I get a receipt" and
    // "something isn't right" actually happen. After that it goes read-only, so
    // a finished booking cannot quietly become a permanent private channel.
    name: 'conversation-grace-sweep',
    schedule: '30 * * * *',
    run: runConversationGraceSweep,
    duplicateEffect:
      'Low: the sweep is a state transition to read-only, so a second pass finds nothing to move.',
  },
  {
    name: 'daily-admin-booking-summary',
    schedule: '0 7 * * *',
    run: runDailyAdminBookingSummary,
    // 07:00 in the operational timezone, independent of host UTC.
    options: { timezone: 'Asia/Manila' },
    duplicateEffect:
      'DUPLICATE ADMIN NOTIFICATIONS. Guarded by notificationKey, but that idempotency is ' +
      'currently defeated in production by 39 stale global unique constraints (migration 037), ' +
      'so the key cannot be relied on until that is applied.',
  },
  {
    name: 'support-sla-sweep',
    // Every fifteen minutes. An SLA measured in hours does not need a tighter
    // loop, and a breach discovered up to an hour late partly defeats the point
    // of measuring it.
    schedule: '*/15 * * * *',
    run: runSupportSlaSweep,
    duplicateEffect:
      'None. The UPDATE excludes rows already SLA_BREACHED and only RETURNS rows it moved, ' +
      'so the provider-visible event and the realtime emit are driven by the transition ' +
      'rather than by the query. A second pass writes nothing.',
  },
];

export const startScheduler = () => {
  for (const job of SCHEDULED_JOBS) {
    cron.schedule(
      job.schedule,
      // Every tick goes through the lease, so only one replica runs the job.
      // withJobLease never throws — node-cron has no error channel, and a throw
      // here would be swallowed silently rather than reported.
      () => withJobLease(job.name, job.run),
      job.options,
    );
  }

  console.log(`[scheduler] ${SCHEDULED_JOBS.length} cron jobs started (lease-protected).`);
};
