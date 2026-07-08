/**
 * Worker Service Application — persistence layer
 *
 * Manages worker_service_applications table. Separate from employee_services:
 *   - worker_service_applications: tracks pending/review lifecycle
 *   - employee_services: confirmed-active assignment (eligibility for booking)
 *
 * Only an approved application should insert into employee_services.
 */

import dbQuery from '../db/dbQuery';
import { db } from '../config';

const dbSchema = db.schema;

let _tableReady: Promise<void> | null = null;

const ensureTable = (): Promise<void> => {
  if (_tableReady) return _tableReady;
  _tableReady = (async () => {
    await dbQuery.query(`
      CREATE TABLE IF NOT EXISTS ${dbSchema}.worker_service_applications (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        worker_uid    TEXT NOT NULL,
        service_id    INT NOT NULL REFERENCES ${dbSchema}.services(id),
        status        TEXT NOT NULL DEFAULT 'pending_review'
                      CHECK (status IN ('pending_review','action_required','rejected','cancelled','approved')),
        submitted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        cancelled_at  TIMESTAMPTZ,
        approved_at   TIMESTAMPTZ,
        reviewed_at   TIMESTAMPTZ,
        reviewed_by   TEXT,
        review_reason TEXT,
        version       INT NOT NULL DEFAULT 1
      )
    `);

    // Partial unique index: only one open application per worker+service
    await dbQuery.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS wsa_unique_open_application
      ON ${dbSchema}.worker_service_applications (worker_uid, service_id)
      WHERE status IN ('pending_review', 'action_required')
    `);

    await dbQuery.query(`
      CREATE INDEX IF NOT EXISTS wsa_worker_uid_idx
      ON ${dbSchema}.worker_service_applications (worker_uid)
    `);

    await dbQuery.query(`
      CREATE INDEX IF NOT EXISTS wsa_service_id_idx
      ON ${dbSchema}.worker_service_applications (service_id)
    `);

    await dbQuery.query(`
      CREATE INDEX IF NOT EXISTS wsa_status_idx
      ON ${dbSchema}.worker_service_applications (status)
    `);
  })().catch((err) => {
    // Reset so next request retries
    _tableReady = null;
    throw err;
  });
  return _tableReady;
};

const APPLICATION_FIELDS = `
  id, worker_uid, service_id, status,
  submitted_at, updated_at, cancelled_at, approved_at,
  reviewed_at, review_reason, version
`;

// ── Queries ───────────────────────────────────────────────────────────────────

/** All active (non-terminal) applications for a provider. */
export const getApplicationsByWorker = async (workerUid: string) => {
  await ensureTable();
  const res = await dbQuery.query(
    `SELECT ${APPLICATION_FIELDS}
     FROM ${dbSchema}.worker_service_applications
     WHERE worker_uid = $1
       AND status NOT IN ('cancelled', 'rejected')
     ORDER BY submitted_at DESC`,
    [workerUid],
  );
  return res.rows;
};

/** Create a pending_review application. Blocks duplicates and already-active services. */
export const submitApplication = async (workerUid: string, serviceId: number) => {
  await ensureTable();

  // Guard: already an active assignment?
  const activeCheck = await dbQuery.query(
    `SELECT 1 FROM ${dbSchema}.employee_services
     WHERE employee_uid = $1 AND service_id = $2 LIMIT 1`,
    [workerUid, serviceId],
  );
  if (activeCheck.rowCount) {
    const err: any = new Error('Provider is already approved for this service.');
    err.code = 'SERVICE_ALREADY_ACTIVE';
    err.statusCode = 409;
    throw err;
  }

  try {
    const res = await dbQuery.query(
      `INSERT INTO ${dbSchema}.worker_service_applications
         (worker_uid, service_id, status, submitted_at, updated_at, version)
       VALUES ($1, $2, 'pending_review', NOW(), NOW(), 1)
       RETURNING ${APPLICATION_FIELDS}`,
      [workerUid, serviceId],
    );
    return res.rows[0];
  } catch (e: any) {
    if (e.code === '23505') {
      // Partial unique index violation — open application already exists
      const existing = await dbQuery.query(
        `SELECT ${APPLICATION_FIELDS}
         FROM ${dbSchema}.worker_service_applications
         WHERE worker_uid = $1 AND service_id = $2
           AND status IN ('pending_review', 'action_required')
         LIMIT 1`,
        [workerUid, serviceId],
      );
      const dupErr: any = new Error('An application for this service is already under review.');
      dupErr.code = 'SERVICE_APPLICATION_ALREADY_EXISTS';
      dupErr.statusCode = 409;
      dupErr.application = existing.rows[0] ?? null;
      throw dupErr;
    }
    throw e;
  }
};

/** Atomically cancel an application — only works for pending/action_required. */
export const cancelApplication = async (applicationId: string, workerUid: string) => {
  await ensureTable();

  const res = await dbQuery.query(
    `UPDATE ${dbSchema}.worker_service_applications
     SET status       = 'cancelled',
         cancelled_at = NOW(),
         updated_at   = NOW(),
         version      = version + 1
     WHERE id = $1
       AND worker_uid = $2
       AND status IN ('pending_review', 'action_required')
     RETURNING ${APPLICATION_FIELDS}`,
    [applicationId, workerUid],
  );

  if (res.rowCount) return res.rows[0];

  // Diagnose why the update matched 0 rows
  const check = await dbQuery.query(
    `SELECT status FROM ${dbSchema}.worker_service_applications
     WHERE id = $1 AND worker_uid = $2 LIMIT 1`,
    [applicationId, workerUid],
  );

  if (!check.rowCount) {
    const err: any = new Error('Application not found.');
    err.code = 'SERVICE_APPLICATION_NOT_FOUND';
    err.statusCode = 404;
    throw err;
  }

  const currentStatus = check.rows[0].status;
  if (currentStatus === 'approved') {
    const err: any = new Error(
      'This application has already been approved and can no longer be cancelled.',
    );
    err.code = 'SERVICE_APPLICATION_ALREADY_APPROVED';
    err.statusCode = 409;
    throw err;
  }

  const err: any = new Error('This application cannot be cancelled in its current state.');
  err.code = 'SERVICE_APPLICATION_STATE_CONFLICT';
  err.statusCode = 409;
  throw err;
};
