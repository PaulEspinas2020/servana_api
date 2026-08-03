import { db } from "../config";
import dbQuery from "../db/dbQuery";
import axios from "axios";
import { getWorkerBankAccount } from "./technicianService";

const dbSchema = db.schema;

const SERVANA_COMMISSION = 0.20;
const WORKER_SHARE_RATE  = 0.80;
const PAYMONGO_BASE_URL  = "https://api.paymongo.com/v1";
const RELEASE_HOURS      = 72;

const getAuthHeader = () => {
  const key = process.env.PAYMONGO_SK_DEV || process.env.PAYMONGO_SK || "";
  return `Basic ${Buffer.from(`${key}:`).toString("base64")}`;
};

const computeSplit = (total: number) => ({
  totalAmount:   Math.round(total * 100) / 100,
  servanaShare:  Math.round(total * SERVANA_COMMISSION * 100) / 100,
  workerShare:   Math.round(total * WORKER_SHARE_RATE  * 100) / 100,
});

// ---------------------------------------------------------------------------
// Called when worker marks job COMPLETED — creates a PENDING disbursement.
// ---------------------------------------------------------------------------

export const createDisbursement = async (bookingId: number) => {
  const r = await dbQuery.query(
    `SELECT final_price, worker_uid FROM ${dbSchema}.bookings WHERE id = $1`,
    [bookingId]
  );

  if (!r.rowCount) throw new Error("Booking not found");

  const { final_price, worker_uid } = r.rows[0];

  if (!worker_uid) {
    console.warn(`createDisbursement: booking ${bookingId} has no worker — skipping`);
    return null;
  }

  if (!final_price || Number(final_price) <= 0) {
    console.warn(`createDisbursement: booking ${bookingId} has no final_price — skipping`);
    return null;
  }

  const { totalAmount, servanaShare, workerShare } = computeSplit(Number(final_price));

  const res = await dbQuery.query(
    `
    INSERT INTO ${dbSchema}.disbursements
      (booking_id, worker_uid, total_amount, servana_share, worker_share, status)
    VALUES ($1, $2, $3, $4, $5, 'PENDING')
    ON CONFLICT (booking_id) DO NOTHING
    RETURNING *
    `,
    [bookingId, worker_uid, totalAmount, servanaShare, workerShare]
  );

  return res.rows[0] || null;
};

// ---------------------------------------------------------------------------
// Release a single disbursement via PayMongo Disbursements API.
// ---------------------------------------------------------------------------

const releaseDisbursement = async (disbursement: any) => {
  // Atomically claim the row — prevents double-payout if scheduler + manual retry run concurrently
  const claim = await dbQuery.query(
    `UPDATE ${dbSchema}.disbursements SET status = 'PROCESSING', updated_at = NOW()
     WHERE id = $1 AND status = 'PENDING' RETURNING id`,
    [disbursement.id]
  );
  if (!claim.rowCount) {
    console.warn(`[disbursement] Row ${disbursement.id} already claimed (not PENDING) — skipping`);
    return;
  }

  const bank = await getWorkerBankAccount(disbursement.worker_uid);

  if (!bank) {
    const msg = `Worker ${disbursement.worker_uid} has no registered bank account`;
    await dbQuery.query(
      `UPDATE ${dbSchema}.disbursements SET status = 'FAILED', payout_error = $2, updated_at = NOW() WHERE id = $1`,
      [disbursement.id, msg]
    );
    console.warn(`[disbursement] ${msg}`);
    return;
  }
  const amountCentavos = Math.round(Number(disbursement.worker_share) * 100);

  try {
    const response = await axios.post(
      `${PAYMONGO_BASE_URL}/disbursements`,
      {
        data: {
          attributes: {
            amount:         amountCentavos,
            currency:       "PHP",
            bank_code:      bank.bank_code,
            account_number: bank.account_number,
            account_name:   bank.account_name,
            narration:      `Servana payout booking #${disbursement.booking_id}`,
            reference_id:   `DISB-${disbursement.booking_id}-${disbursement.id}-${Date.now()}`,
          },
        },
      },
      { headers: { Authorization: getAuthHeader(), "Content-Type": "application/json" } }
    );

    const payoutId = response.data?.data?.id;

    await dbQuery.query(
      `
      UPDATE ${dbSchema}.disbursements
      SET status             = 'RELEASED',
          paymongo_payout_id = $2,
          payout_error       = NULL,
          released_at        = NOW(),
          updated_at         = NOW()
      WHERE id = $1
      `,
      [disbursement.id, payoutId]
    );

    console.log(`[disbursement] Released booking #${disbursement.booking_id} → payout ${payoutId}`);
  } catch (err: any) {
    const errMsg =
      err?.response?.data?.errors?.[0]?.detail || err.message || "PayMongo payout failed";

    await dbQuery.query(
      `
      UPDATE ${dbSchema}.disbursements
      SET status       = 'FAILED',
          payout_error = $2,
          updated_at   = NOW()
      WHERE id = $1
      `,
      [disbursement.id, errMsg]
    );

    console.error(`[disbursement] FAILED booking #${disbursement.booking_id}: ${errMsg}`);
  }
};

// ---------------------------------------------------------------------------
// Scheduler job — runs every hour.
// Finds PENDING disbursements where the job was completed 72 h+ ago.
// ---------------------------------------------------------------------------

export const processPendingDisbursements = async () => {
  const res = await dbQuery.query(
    `
    SELECT d.*
    FROM ${dbSchema}.disbursements d
    JOIN ${dbSchema}.booking_workers bw
      ON bw.booking_id = d.booking_id
     AND bw.worker_uid = d.worker_uid
     AND bw.status     = 'COMPLETED'
    WHERE d.status = 'PENDING'
      AND bw.completed_at + INTERVAL '${RELEASE_HOURS} hours' <= NOW()
      -- Honour an admin hold. holdPayout (adminFinanceService.ts:717) writes
      -- hold_reason/hold_until/held_by but deliberately leaves status='PENDING',
      -- and this query previously selected on status and elapsed time alone — so
      -- a held payout went out on the very next hourly tick. The control was
      -- permissioned and audit-logged and moved the money anyway.
      --
      -- holdReason is required but holdUntil is optional (adminFinanceController
      -- passes holdUntil ?? null), so a hold with no expiry means "indefinite"
      -- and must not age out. A hold whose expiry has passed releases normally.
      AND (
        d.hold_reason IS NULL
        OR (d.hold_until IS NOT NULL AND d.hold_until <= NOW())
      )
    `,
    []
  );

  if (!res.rowCount) {
    console.log("[disbursement] No pending disbursements due for release.");
    return;
  }

  console.log(`[disbursement] Processing ${res.rowCount} disbursement(s)…`);

  for (const row of res.rows) {
    try {
      await releaseDisbursement(row);
    } catch (err: any) {
      console.error(`[disbursement] processPending row ${row.id} threw:`, err.message);
    }
  }
};

// ---------------------------------------------------------------------------
// Scheduler job — retries FAILED disbursements (runs every 6 h).
// ---------------------------------------------------------------------------

export const retryFailedDisbursements = async () => {
  const res = await dbQuery.query(
    `
    SELECT d.*
    FROM ${dbSchema}.disbursements d
    JOIN ${dbSchema}.booking_workers bw
      ON bw.booking_id = d.booking_id
     AND bw.worker_uid = d.worker_uid
    WHERE d.status = 'FAILED'
      AND d.updated_at < NOW() - INTERVAL '6 hours'
      AND d.created_at >= NOW() - INTERVAL '7 days'
    `,
    []
  );

  if (!res.rowCount) return;

  console.log(`[disbursement] Retrying ${res.rowCount} failed disbursement(s)…`);

  for (const row of res.rows) {
    try {
      // Reset to PENDING so releaseDisbursement can proceed
      await dbQuery.query(
        `UPDATE ${dbSchema}.disbursements SET status = 'PENDING', payout_error = NULL, updated_at = NOW() WHERE id = $1`,
        [row.id]
      );
      await releaseDisbursement({ ...row, status: "PENDING" });
    } catch (err: any) {
      console.error(`[disbursement] retry row ${row.id} aborted:`, err.message);
    }
  }
};

// ---------------------------------------------------------------------------
// Manual retry — admin can force-retry a specific booking's disbursement.
// ---------------------------------------------------------------------------

export const manualRetry = async (disbursementId: number) => {
  const res = await dbQuery.query(
    `SELECT * FROM ${dbSchema}.disbursements WHERE id = $1`,
    [disbursementId]
  );

  if (!res.rowCount) throw new Error("Disbursement not found");

  const row = res.rows[0];

  if (row.status === "RELEASED") throw new Error("Disbursement is already released");

  // Guard against concurrent in-flight retries — only reset if not already PENDING/PROCESSING/RELEASED
  const reset = await dbQuery.query(
    `UPDATE ${dbSchema}.disbursements SET status = 'PENDING', payout_error = NULL, updated_at = NOW()
     WHERE id = $1 AND status NOT IN ('PENDING','PROCESSING','RELEASED') RETURNING *`,
    [disbursementId]
  );
  if (!reset.rowCount) throw new Error("Disbursement already in-flight or released");

  await releaseDisbursement({ ...row, status: "PENDING" });

  const updated = await dbQuery.query(
    `SELECT * FROM ${dbSchema}.disbursements WHERE id = $1`,
    [disbursementId]
  );

  return updated.rows[0];
};

// ---------------------------------------------------------------------------
// Admin dashboard — list all disbursements with booking + worker info.
// ---------------------------------------------------------------------------

export const listDisbursements = async (filters?: {
  status?: string;
  workerUid?: string;
}) => {
  const conditions: string[] = [];
  const params: any[]        = [];
  let   idx = 1;

  if (filters?.status) {
    conditions.push(`d.status = $${idx++}`);
    params.push(filters.status);
  }
  if (filters?.workerUid) {
    conditions.push(`d.worker_uid = $${idx++}`);
    params.push(filters.workerUid);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const res = await dbQuery.query(
    `
    SELECT
      d.*,
      b.final_price,
      b.status         AS booking_status,
      uc.first_name || ' ' || uc.last_name AS worker_name,
      uc.email         AS worker_email,
      bw.completed_at,
      bw.completed_at + INTERVAL '${RELEASE_HOURS} hours' AS release_after
    FROM ${dbSchema}.disbursements d
    JOIN ${dbSchema}.bookings         b  ON b.id       = d.booking_id
    JOIN ${dbSchema}.user_credentials uc ON uc.uid     = d.worker_uid
    LEFT JOIN ${dbSchema}.booking_workers bw
      ON bw.booking_id = d.booking_id
     AND bw.worker_uid = d.worker_uid
     AND bw.status     = 'COMPLETED'
    ${where}
    ORDER BY d.created_at DESC
    `,
    params
  );

  return res.rows;
};

export const getDisbursementByBooking = async (bookingId: number) => {
  const res = await dbQuery.query(
    `
    SELECT
      d.*,
      bw.completed_at,
      bw.completed_at + INTERVAL '${RELEASE_HOURS} hours' AS release_after
    FROM ${dbSchema}.disbursements d
    LEFT JOIN ${dbSchema}.booking_workers bw
      ON bw.booking_id = d.booking_id
     AND bw.worker_uid = d.worker_uid
     AND bw.status     = 'COMPLETED'
    WHERE d.booking_id = $1
    `,
    [bookingId]
  );

  return res.rows[0] || null;
};
