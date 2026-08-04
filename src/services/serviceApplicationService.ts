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
import { createNotification } from './notification.service';

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

/** Resubmit an action_required application — resets to pending_review. */
export const resubmitApplication = async (applicationId: string, workerUid: string) => {
  await ensureTable();
  const res = await dbQuery.query(
    `UPDATE ${dbSchema}.worker_service_applications
     SET status       = 'pending_review',
         review_reason = NULL,
         reviewed_at  = NULL,
         reviewed_by  = NULL,
         updated_at   = NOW(),
         version      = version + 1
     WHERE id = $1
       AND worker_uid = $2
       AND status = 'action_required'
     RETURNING ${APPLICATION_FIELDS}`,
    [applicationId, workerUid],
  );
  if (res.rowCount) return res.rows[0];

  const check = await dbQuery.query(
    `SELECT status FROM ${dbSchema}.worker_service_applications
     WHERE id = $1 AND worker_uid = $2 LIMIT 1`,
    [applicationId, workerUid],
  );
  if (!check.rowCount) {
    const err: any = new Error('Application not found.');
    err.code = 'SERVICE_APPLICATION_NOT_FOUND'; err.statusCode = 404; throw err;
  }
  const err: any = new Error('Only action_required applications can be resubmitted.');
  err.code = 'SERVICE_APPLICATION_STATE_CONFLICT'; err.statusCode = 409; throw err;
};

/**
 * Admin: approve an application — writes to employee_services and marks approved.
 * Safe to retry: employee_services insert is idempotent.
 */
export const approveApplication = async (applicationId: string, adminUid: string) => {
  await ensureTable();
  const appRes = await dbQuery.query(
    `SELECT wsa.id, wsa.worker_uid, wsa.service_id, wsa.status,
            wsa.submitted_at, wsa.updated_at, wsa.cancelled_at, wsa.approved_at,
            wsa.reviewed_at, wsa.review_reason, wsa.version,
            s.name AS service_name
     FROM ${dbSchema}.worker_service_applications wsa
     LEFT JOIN ${dbSchema}.services s ON s.id = wsa.service_id
     WHERE wsa.id = $1 AND wsa.status IN ('pending_review', 'action_required') LIMIT 1`,
    [applicationId],
  );
  if (!appRes.rowCount) {
    const err: any = new Error('Application not found or not in a reviewable state.');
    err.code = 'SERVICE_APPLICATION_NOT_FOUND'; err.statusCode = 404; throw err;
  }
  const app = appRes.rows[0];
  const serviceName: string = app.service_name ?? `service #${app.service_id}`;

  // Write to employee_services first (idempotent), then mark approved.
  await dbQuery.query(
    `INSERT INTO ${dbSchema}.employee_services (employee_uid, service_id)
     VALUES ($1, $2) ON CONFLICT (employee_uid, service_id) DO NOTHING`,
    [app.worker_uid, app.service_id],
  );
  const res = await dbQuery.query(
    `UPDATE ${dbSchema}.worker_service_applications
     SET status      = 'approved',
         approved_at = NOW(),
         reviewed_at = NOW(),
         reviewed_by = $2,
         updated_at  = NOW(),
         version     = version + 1
     WHERE id = $1
     RETURNING ${APPLICATION_FIELDS}`,
    [applicationId, adminUid],
  );

  // Notify provider — fire-and-forget
  createNotification(app.worker_uid, {
    notificationKey: `svc_app_approved_${applicationId}`,
    type: 'requirement_review',
    severity: 'info',
    title: 'Application Approved',
    safeBody: `Your application for ${serviceName} has been approved. You can now receive bookings for this service.`,
    safeContextLabel: serviceName,
    route: { screen: 'ServiceApplications' },
    canOpenDetail: false,
  }).catch(() => {});

  return res.rows[0];
};

/** Admin: reject an application with a mandatory review reason. */
export const rejectApplication = async (applicationId: string, adminUid: string, reason: string) => {
  await ensureTable();
  const res = await dbQuery.query(
    `UPDATE ${dbSchema}.worker_service_applications
     SET status       = 'rejected',
         review_reason = $3,
         reviewed_at  = NOW(),
         reviewed_by  = $2,
         updated_at   = NOW(),
         version      = version + 1
     WHERE id = $1
       AND status IN ('pending_review', 'action_required')
     RETURNING ${APPLICATION_FIELDS}`,
    [applicationId, adminUid, reason],
  );
  if (res.rowCount) {
    const app = res.rows[0];
    // Fetch service name for notification copy
    const svcRes = await dbQuery.query(
      `SELECT name FROM ${dbSchema}.services WHERE id = $1 LIMIT 1`,
      [app.service_id],
    ).catch(() => ({ rows: [] }));
    const serviceName: string = svcRes.rows[0]?.name ?? `service #${app.service_id}`;
    createNotification(app.worker_uid, {
      notificationKey: `svc_app_rejected_${applicationId}`,
      type: 'requirement_review',
      severity: 'warning',
      title: 'Application Not Approved',
      safeBody: `Your application for ${serviceName} was not approved${reason ? ': ' + reason : '.'}`,
      safeContextLabel: serviceName,
      route: { screen: 'ServiceApplications' },
    }).catch(() => {});
    return app;
  }
  const err: any = new Error('Application not found or not in a reviewable state.');
  err.code = 'SERVICE_APPLICATION_NOT_FOUND'; err.statusCode = 404; throw err;
};

/**
 * Admin: flag an application as action_required with a mandatory reason.
 * The provider will be prompted to correct and resubmit.
 */
export const flagApplicationActionRequired = async (applicationId: string, adminUid: string, reason: string) => {
  await ensureTable();
  const res = await dbQuery.query(
    `UPDATE ${dbSchema}.worker_service_applications
     SET status       = 'action_required',
         review_reason = $3,
         reviewed_at  = NOW(),
         reviewed_by  = $2,
         updated_at   = NOW(),
         version      = version + 1
     WHERE id = $1
       AND status = 'pending_review'
     RETURNING ${APPLICATION_FIELDS}`,
    [applicationId, adminUid, reason],
  );
  if (res.rowCount) {
    const app = res.rows[0];
    const svcRes = await dbQuery.query(
      `SELECT name FROM ${dbSchema}.services WHERE id = $1 LIMIT 1`,
      [app.service_id],
    ).catch(() => ({ rows: [] }));
    const serviceName: string = svcRes.rows[0]?.name ?? `service #${app.service_id}`;
    createNotification(app.worker_uid, {
      notificationKey: `svc_app_action_required_${applicationId}`,
      type: 'requirement_review',
      severity: 'warning',
      title: 'Action Required on Your Application',
      safeBody: `Your application for ${serviceName} requires action${reason ? ': ' + reason : '. Please resubmit with the requested changes.'}`,
      safeContextLabel: serviceName,
      route: { screen: 'ServiceApplications' },
    }).catch(() => {});
    return app;
  }
  const err: any = new Error('Application not found or not pending review.');
  err.code = 'SERVICE_APPLICATION_NOT_FOUND'; err.statusCode = 404; throw err;
};

/** Admin: list all applications with optional filters and pagination. */
export const listApplicationsAdmin = async (params: {
  status?: string; search?: string;
  sortBy?: 'submittedAt' | 'updatedAt' | 'status'; sortOrder?: 'asc' | 'desc';
  page?: number; limit?: number;
}) => {
  await ensureTable();
  const page  = Math.max(1, params.page ?? 1);
  const limit = Math.min(100, Math.max(1, params.limit ?? 25));
  const offset = (page - 1) * limit;

  const VALID_SORT: Record<string, string> = {
    submittedAt: 'wsa.submitted_at',
    updatedAt:   'wsa.updated_at',
    status:      'wsa.status',
  };
  const sortField = VALID_SORT[params.sortBy ?? 'submittedAt'] ?? 'wsa.submitted_at';
  const sortDir   = params.sortOrder === 'asc' ? 'ASC' : 'DESC';

  const conditions: string[] = [];
  const bindValues: any[] = [];
  let idx = 1;

  if (params.status) {
    conditions.push(`wsa.status = $${idx++}`);
    bindValues.push(params.status);
  }
  if (params.search) {
    conditions.push(`(uc.first_name ILIKE $${idx} OR uc.last_name ILIKE $${idx} OR uc.email ILIKE $${idx} OR s.name ILIKE $${idx})`);
    bindValues.push(`%${params.search}%`);
    idx++;
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const res = await dbQuery.query(
    `SELECT
       wsa.id, wsa.worker_uid, wsa.service_id, wsa.status,
       wsa.submitted_at, wsa.updated_at, wsa.review_reason, wsa.version,
       wsa.approved_at, wsa.cancelled_at, wsa.reviewed_at, wsa.reviewed_by,
       uc.first_name, uc.last_name, uc.email,
       s.name AS service_name, s.category AS service_category,
       COUNT(*) OVER() AS total_count
     FROM ${dbSchema}.worker_service_applications wsa
     LEFT JOIN ${dbSchema}.user_credentials uc ON uc.uid = wsa.worker_uid
     LEFT JOIN ${dbSchema}.services s ON s.id = wsa.service_id
     ${where}
     ORDER BY ${sortField} ${sortDir}, wsa.id ASC
     LIMIT $${idx} OFFSET $${idx + 1}`,
    [...bindValues, limit, offset],
  );

  const total = Number(res.rows[0]?.total_count ?? 0);
  return {
    items: res.rows.map((r: any) => ({
      id: r.id, workerUid: r.worker_uid, serviceId: Number(r.service_id),
      status: r.status, submittedAt: r.submitted_at, updatedAt: r.updated_at,
      reviewReason: r.review_reason ?? null, version: Number(r.version),
      approvedAt: r.approved_at ?? null, cancelledAt: r.cancelled_at ?? null,
      reviewedAt: r.reviewed_at ?? null, reviewedBy: r.reviewed_by ?? null,
      provider: { uid: r.worker_uid, firstName: r.first_name ?? null, lastName: r.last_name ?? null, email: r.email ?? null },
      service: { id: Number(r.service_id), name: r.service_name ?? null, category: r.service_category ?? null },
    })),
    total, page, limit, totalPages: Math.ceil(total / limit),
  };
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
