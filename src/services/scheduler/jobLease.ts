/**
 * Scheduler job leases — one replica runs each logical job per tick.
 *
 * ## What this protects, and what was already safe
 *
 * `scheduler.ts` runs six in-process cron jobs. Before this, nothing stopped two
 * API replicas from running all six simultaneously. What that actually risked is
 * narrower than it first appears, and the distinction matters:
 *
 * ALREADY SAFE — the money paths guard themselves at row level:
 *   - `releaseDisbursement` claims atomically with
 *     `UPDATE ... WHERE id = $1 AND status = 'PENDING'` and sends PayMongo a
 *     per-attempt `Idempotency-Key`. A second replica's UPDATE hits 0 rows.
 *   - `retryFailedDisbursements` claims the same way on `status = 'FAILED'`.
 *   - `createCheckoutSession` takes `pg_advisory_xact_lock(hashtext(...))` per
 *     booking plus `FOR UPDATE`.
 *   Payouts and checkout sessions therefore cannot be duplicated by concurrency.
 *
 * NOT SAFE — the user-visible side effects, which have no such guard:
 *   - OTP reminder emails: a plain SELECT then a send() per row.
 *   - Payment retry emails: the session is serialized, but the send() after it
 *     is not, so two replicas mail the customer twice.
 *   - Admin daily summary: relies on `notificationKey` idempotency, which is
 *     currently defeated in production by 39 stale global unique constraints
 *     (see migration 037). Until that is applied its dedupe cannot be trusted.
 *
 * So this lease exists to stop duplicate MESSAGES, not duplicate money. Do not
 * remove the row-level claims above on the strength of it — a lease is a
 * coordination hint, not a transactional guarantee.
 *
 * ## Why advisory locks rather than a jobs table
 *
 * TAB 08 permits either. Advisory locks win here for one decisive reason: they
 * need no schema. Migrations are the sole schema authority (TAB 02) and 036/037
 * are authored but NOT applied, so a `scheduler_jobs` table could not run until
 * a human applies it. This works today, on the schema production already has.
 *
 * The trade-off is honest: no durable run history, no dead-letter queue, no
 * resumable cursors. Those need a table. What IS delivered is the acceptance
 * criterion that matters most — two replicas execute each logical job once — plus
 * observable outcomes in memory. When a jobs table lands, `recordOutcome` below
 * is the seam to persist through.
 *
 * ## Crash release comes free
 *
 * `pg_try_advisory_lock` is SESSION-scoped: PostgreSQL drops it when the
 * connection ends, including when the process dies. That satisfies "a crashed
 * worker releases or expires its lease" without a heartbeat or a TTL sweeper.
 *
 * ## The connection trap
 *
 * A session advisory lock belongs to ONE connection. Acquiring it via the pool
 * helper and releasing it later would take a DIFFERENT connection from the pool
 * and unlock nothing — the lock would leak until the process exits, and the job
 * would never run again on that replica. So a client is checked out explicitly,
 * held for the whole job, and released in `finally`.
 */

import { pool } from '../../db/dbQuery';

/** Outcome of one attempted job run. */
export type JobRunOutcome = 'success' | 'failure' | 'skipped_locked';

export interface JobRunRecord {
  job: string;
  outcome: JobRunOutcome;
  /** Wall-clock duration in ms. 0 for skipped_locked — no work was done. */
  durationMs: number;
  /** Error message when outcome is 'failure'. Never the stack, never a payload. */
  error?: string;
  startedAt: string;
}

/**
 * The last run of each job, plus counters. In-memory and per-replica, so it is
 * diagnostic rather than authoritative — a durable history needs the jobs table
 * described above. Exposed for readiness/metrics endpoints.
 */
const runs = new Map<
  string,
  { last: JobRunRecord; success: number; failure: number; skipped: number }
>();

export const recordOutcome = (record: JobRunRecord): void => {
  const prev = runs.get(record.job);
  runs.set(record.job, {
    last: record,
    success: (prev?.success ?? 0) + (record.outcome === 'success' ? 1 : 0),
    failure: (prev?.failure ?? 0) + (record.outcome === 'failure' ? 1 : 0),
    skipped: (prev?.skipped ?? 0) + (record.outcome === 'skipped_locked' ? 1 : 0),
  });
};

/** Snapshot for metrics/diagnostics. Copied, so callers cannot mutate the registry. */
export const schedulerJobStats = () =>
  Array.from(runs.entries()).map(([job, s]) => ({ job, ...s, last: { ...s.last } }));

/** Test-only: clear the registry between cases. */
export const __resetJobStats = () => runs.clear();

/**
 * Stable 64-bit lock key for a job name.
 *
 * `hashtext` is used elsewhere in this codebase for exactly this
 * (`paymongo-checkout:booking:*`), so the same idiom is kept. The namespace
 * prefix keeps job locks from colliding with those booking-scoped locks: a
 * collision would not corrupt data, but it would make a job silently skip
 * whenever an unrelated checkout was mid-flight, which is the kind of bug that
 * looks like "the scheduler sometimes doesn't run".
 */
const lockKey = (job: string) => `servana-scheduler-job:${job}`;

/**
 * Run `fn` if this replica can take the lease for `job`; otherwise skip.
 *
 * Never throws: a scheduler tick that throws takes down nothing useful and
 * node-cron has no error channel. Failures are recorded and logged instead.
 */
export const withJobLease = async (
  job: string,
  fn: () => Promise<void>,
): Promise<JobRunOutcome> => {
  const startedAt = new Date().toISOString();
  const started = Date.now();

  let client;
  try {
    client = await pool.connect();
  } catch (err: any) {
    // Could not even reach the pool. Report it rather than running unguarded:
    // running without the lease is what this module exists to prevent.
    const record: JobRunRecord = {
      job,
      outcome: 'failure',
      durationMs: Date.now() - started,
      error: `lease connection failed: ${err?.message ?? 'unknown'}`,
      startedAt,
    };
    recordOutcome(record);
    console.error(`[scheduler] ${job}: could not acquire a connection for its lease`, err);
    return 'failure';
  }

  try {
    const res = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [
      lockKey(job),
    ]);
    const locked = res.rows[0]?.locked === true;

    if (!locked) {
      // Another replica holds it. Normal under horizontal scale, not an error.
      recordOutcome({ job, outcome: 'skipped_locked', durationMs: 0, startedAt });
      console.log(`[scheduler] ${job}: lease held elsewhere — skipping this tick`);
      return 'skipped_locked';
    }

    try {
      await fn();
      const durationMs = Date.now() - started;
      recordOutcome({ job, outcome: 'success', durationMs, startedAt });
      console.log(`[scheduler] ${job}: completed in ${durationMs}ms`);
      return 'success';
    } catch (err: any) {
      const durationMs = Date.now() - started;
      recordOutcome({
        job,
        outcome: 'failure',
        durationMs,
        error: err?.message ?? 'unknown',
        startedAt,
      });
      console.error(`[scheduler] ${job}: failed after ${durationMs}ms`, err);
      return 'failure';
    } finally {
      // Release on the SAME client that took it. Wrapped because a failure to
      // unlock must not mask the job's own outcome — and the lock dies with the
      // connection anyway when this client is destroyed.
      try {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey(job)]);
      } catch (unlockErr) {
        console.error(`[scheduler] ${job}: advisory unlock failed`, unlockErr);
      }
    }
  } finally {
    client.release();
  }
};
