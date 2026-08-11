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
import { pool } from '../db/dbQuery';
import { db } from '../config';
import { createNotification } from './notification.service';
import { ensureActivationSchema } from './providerActivationService';
import { evaluateServicePolicy, ServicePolicyCode } from './providerServicePolicyService';

const dbSchema = db.schema;

let _tableReady: Promise<void> | null = null;

const ensureTable = (): Promise<void> => {
  if (_tableReady) return _tableReady;
  _tableReady = (async () => {
    await dbQuery.query(`
      CREATE TABLE IF NOT EXISTS ${dbSchema}.worker_service_applications (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        worker_uid    TEXT NOT NULL,
        -- Deploy 2: service_families is a real TABLE now, so this FK can finally name
        -- it. It could not in Deploy 1, when service_families was a view and a FOREIGN
        -- KEY cannot reference one.
        service_id    INT NOT NULL REFERENCES ${dbSchema}.service_families(id),
        status        TEXT NOT NULL DEFAULT 'pending_review'
                      CHECK (status IN ('pending_review','action_required','rejected','cancelled','approved')),
        submitted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        cancelled_at  TIMESTAMPTZ,
        approved_at   TIMESTAMPTZ,
        reviewed_at   TIMESTAMPTZ,
        reviewed_by   TEXT,
        review_reason TEXT,
        provider_reason_code TEXT,
        provider_reason_detail TEXT,
        client_request_id VARCHAR(128),
        requirements_version INT NOT NULL DEFAULT 1,
        service_snapshot JSONB,
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

    // Existing installations predate the fields above, so CREATE TABLE alone
    // is insufficient. These additive migrations are safe to retry.
    await dbQuery.query(`ALTER TABLE ${dbSchema}.worker_service_applications ADD COLUMN IF NOT EXISTS provider_reason_code TEXT`);
    await dbQuery.query(`ALTER TABLE ${dbSchema}.worker_service_applications ADD COLUMN IF NOT EXISTS provider_reason_detail TEXT`);
    await dbQuery.query(`ALTER TABLE ${dbSchema}.worker_service_applications ADD COLUMN IF NOT EXISTS client_request_id VARCHAR(128)`);
    await dbQuery.query(`ALTER TABLE ${dbSchema}.worker_service_applications ADD COLUMN IF NOT EXISTS requirements_version INT NOT NULL DEFAULT 1`);
    await dbQuery.query(`ALTER TABLE ${dbSchema}.worker_service_applications ADD COLUMN IF NOT EXISTS service_snapshot JSONB`);
    await dbQuery.query(`ALTER TABLE ${dbSchema}.employee_services ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'`);
    await dbQuery.query(`ALTER TABLE ${dbSchema}.employee_services ADD COLUMN IF NOT EXISTS pause_reason TEXT`);
    await dbQuery.query(`ALTER TABLE ${dbSchema}.employee_services ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);

    await dbQuery.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS wsa_provider_request_idempotency
      ON ${dbSchema}.worker_service_applications (worker_uid, client_request_id)
      WHERE client_request_id IS NOT NULL
    `);

    await dbQuery.query(`
      CREATE TABLE IF NOT EXISTS ${dbSchema}.worker_service_application_timeline (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        application_id UUID NOT NULL REFERENCES ${dbSchema}.worker_service_applications(id),
        event_key TEXT NOT NULL,
        event_code TEXT NOT NULL,
        provider_label TEXT NOT NULL,
        provider_explanation TEXT,
        actor_category TEXT NOT NULL DEFAULT 'system',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (application_id, event_key)
      )
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
  reviewed_at, provider_reason_code, provider_reason_detail,
  requirements_version, service_snapshot, version
`;
const APPLICATION_SELECT_FIELDS = `
  wsa.id, wsa.worker_uid, wsa.service_id, wsa.status,
  wsa.submitted_at, wsa.updated_at, wsa.cancelled_at, wsa.approved_at,
  wsa.reviewed_at, wsa.provider_reason_code, wsa.provider_reason_detail,
  wsa.requirements_version, wsa.service_snapshot, wsa.version
`;

const applicationError = (message: string, code: string, statusCode: number, extra?: Record<string, unknown>) => {
  const err: any = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  if (extra) Object.assign(err, extra);
  return err;
};

const addTimelineEvent = async (
  query: (sql: string, params?: unknown[]) => Promise<any>,
  applicationId: string,
  eventKey: string,
  eventCode: string,
  label: string,
  explanation: string | null,
  actorCategory: 'provider' | 'admin' | 'system',
) => {
  await query(
    `INSERT INTO ${dbSchema}.worker_service_application_timeline
       (application_id, event_key, event_code, provider_label, provider_explanation, actor_category)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (application_id, event_key) DO NOTHING`,
    [applicationId, eventKey, eventCode, label, explanation, actorCategory],
  );
};

// ── Queries ───────────────────────────────────────────────────────────────────

/** All applications for a provider, including immutable terminal history. */
export const getApplicationsByWorker = async (workerUid: string) => {
  await ensureTable();
  const res = await dbQuery.query(
    `SELECT ${APPLICATION_SELECT_FIELDS}, s.name AS service_name, s.category AS service_category
     FROM ${dbSchema}.worker_service_applications wsa
     JOIN ${dbSchema}.service_families s ON s.id = wsa.service_id
     WHERE wsa.worker_uid = $1
     ORDER BY
       CASE wsa.status WHEN 'action_required' THEN 0 WHEN 'pending_review' THEN 1
         WHEN 'approved' THEN 2 ELSE 3 END,
       wsa.updated_at DESC`,
    [workerUid],
  );
  return res.rows;
};

export type ServiceApplicationEligibilityCode =
  | 'ELIGIBLE'
  | 'ALREADY_APPROVED'
  | 'APPLICATION_PENDING'
  | 'ADDITIONAL_INFORMATION_REQUIRED'
  | 'PROVIDER_ACCOUNT_NOT_ACTIVE'
  | 'SERVICE_NOT_AVAILABLE'
  | 'APPLICATION_CLOSED'
  | ServicePolicyCode;

export interface ServiceApplicationEligibility {
  eligible: boolean;
  code: ServiceApplicationEligibilityCode;
  message: string;
  nextAction: 'APPLY' | 'VIEW_SERVICE' | 'VIEW_APPLICATION' | 'CONTACT_SUPPORT' | 'NONE';
  service: { id: number; name: string; category: string | null; catalogVersion: number } | null;
  applicationId: string | null;
  requirementsVersion: number;
  requirements: Array<{ id: string; type: string; required: boolean; state: string; description: string }>;
}

/**
 * Provider-facing application eligibility. The authenticated uid is supplied
 * by the controller; no provider id from a request body participates.
 *
 * Branch, area, provider-type and qualification policy is read from the
 * canonical offering policy. Draft/absent policy remains additive; enforced
 * policy is backend-authoritative.
 */
export const evaluateApplicationEligibility = async (
  workerUid: string,
  serviceId: number,
): Promise<ServiceApplicationEligibility> => {
  await ensureTable();
  const serviceRes = await dbQuery.query(
    `SELECT s.id, s.name, s.category,
            COALESCE(MAX(o.version), 1)::int AS catalog_version,
            BOOL_OR(o.status = 'active' AND o.provider_web_visible = true AND m.is_active = true) AS application_open
     FROM ${dbSchema}.service_families s
     LEFT JOIN ${dbSchema}.provider_catalog_offering_mappings m ON m.service_id = s.id
     LEFT JOIN ${dbSchema}.provider_catalog_offerings o ON o.id = m.offering_id
     WHERE s.id = $1
     GROUP BY s.id, s.name, s.category`,
    [serviceId],
  );
  if (!serviceRes.rowCount) {
    return { eligible: false, code: 'SERVICE_NOT_AVAILABLE', message: 'This service is not available.', nextAction: 'NONE', service: null, applicationId: null, requirementsVersion: 1, requirements: [] };
  }
  const s = serviceRes.rows[0];
  const service = { id: Number(s.id), name: String(s.name), category: s.category ?? null, catalogVersion: Number(s.catalog_version ?? 1) };

  const accountRes = await dbQuery.query(
    `SELECT account_status, is_archive FROM ${dbSchema}.user_credentials
     WHERE uid = $1 AND role::int IN (2, 4) LIMIT 1`,
    [workerUid],
  );
  const account = accountRes.rows[0];
  if (!account || account.is_archive === true || account.account_status !== 'active') {
    return { eligible: false, code: 'PROVIDER_ACCOUNT_NOT_ACTIVE', message: 'Activate your provider account before applying for another service.', nextAction: 'CONTACT_SUPPORT', service, applicationId: null, requirementsVersion: service.catalogVersion, requirements: [] };
  }

  const approved = await dbQuery.query(
    `SELECT 1 FROM ${dbSchema}.employee_services WHERE employee_uid = $1 AND service_id = $2 LIMIT 1`,
    [workerUid, serviceId],
  );
  if (approved.rowCount) {
    return { eligible: false, code: 'ALREADY_APPROVED', message: 'You are already approved for this service.', nextAction: 'VIEW_SERVICE', service, applicationId: null, requirementsVersion: service.catalogVersion, requirements: [] };
  }

  const open = await dbQuery.query(
    `SELECT id, status FROM ${dbSchema}.worker_service_applications
     WHERE worker_uid = $1 AND service_id = $2 AND status IN ('pending_review', 'action_required')
     ORDER BY updated_at DESC LIMIT 1`,
    [workerUid, serviceId],
  );
  if (open.rowCount) {
    const app = open.rows[0];
    const actionRequired = app.status === 'action_required';
    return {
      eligible: false,
      code: actionRequired ? 'ADDITIONAL_INFORMATION_REQUIRED' : 'APPLICATION_PENDING',
      message: actionRequired ? 'Servana needs more information for your existing application.' : 'Your application is already pending review.',
      nextAction: 'VIEW_APPLICATION', service, applicationId: app.id,
      requirementsVersion: service.catalogVersion, requirements: [],
    };
  }

  if (s.application_open !== true) {
    return { eligible: false, code: 'APPLICATION_CLOSED', message: 'Applications for this service are currently closed.', nextAction: 'NONE', service, applicationId: null, requirementsVersion: service.catalogVersion, requirements: [] };
  }

  const policy = await evaluateServicePolicy(workerUid, serviceId);
  if (!policy.eligible) {
    return {
      eligible: false,
      code: policy.code,
      message: policy.message,
      nextAction: policy.code === 'SERVICE_POLICY_INCOMPLETE' ? 'CONTACT_SUPPORT' : 'NONE',
      service,
      applicationId: null,
      requirementsVersion: policy.requirementsVersion,
      requirements: policy.requirements,
    };
  }

  return {
    eligible: true,
    code: 'ELIGIBLE',
    message: 'You can apply for this service.',
    nextAction: 'APPLY',
    service,
    applicationId: null,
    requirementsVersion: policy.requirementsVersion,
    requirements: policy.requirements,
  };
};

export const getApplicationByWorker = async (applicationId: string, workerUid: string) => {
  await ensureTable();
  const result = await dbQuery.query(
    `SELECT ${APPLICATION_SELECT_FIELDS}, s.name AS service_name, s.category AS service_category
     FROM ${dbSchema}.worker_service_applications wsa
     JOIN ${dbSchema}.service_families s ON s.id = wsa.service_id
     WHERE wsa.id = $1 AND wsa.worker_uid = $2 LIMIT 1`,
    [applicationId, workerUid],
  );
  if (!result.rowCount) throw applicationError('Application not found.', 'SERVICE_APPLICATION_NOT_FOUND', 404);
  const timeline = await dbQuery.query(
    `SELECT event_code, provider_label, provider_explanation, actor_category, created_at
     FROM ${dbSchema}.worker_service_application_timeline
     WHERE application_id = $1 ORDER BY created_at, id`,
    [applicationId],
  );
  return { ...result.rows[0], timeline: timeline.rows };
};

export const getProviderServicesOverview = async (workerUid: string) => {
  await ensureTable();
  await ensureActivationSchema();
  const [services, applications, account] = await Promise.all([
    dbQuery.query(
      `SELECT es.service_id, s.name, s.category, es.created_at AS approved_at,
              COALESCE(es.status, 'active') AS operational_status,
              es.pause_reason, es.updated_at
       FROM ${dbSchema}.employee_services es
       JOIN ${dbSchema}.service_families s ON s.id = es.service_id
       WHERE es.employee_uid = $1 ORDER BY s.name`,
      [workerUid],
    ),
    getApplicationsByWorker(workerUid),
    dbQuery.query(
      `SELECT uc.account_status, uc.is_archive, pa.activation_status
       FROM ${dbSchema}.user_credentials uc
       LEFT JOIN ${dbSchema}.provider_activation pa ON pa.provider_uid = uc.uid
       WHERE uc.uid = $1 LIMIT 1`,
      [workerUid],
    ),
  ]);
  const accountActive = account.rows[0]?.account_status === 'active' && account.rows[0]?.is_archive !== true;
  const activationActive = account.rows[0]?.activation_status === 'ACTIVE';
  const accountReady = accountActive && activationActive;
  return {
    services: services.rows.map((row: any) => {
      const active = row.operational_status === 'active';
      return {
        providerServiceId: `${workerUid}:${row.service_id}`,
        serviceId: Number(row.service_id),
        name: row.name,
        category: row.category ?? null,
        approvalState: 'APPROVED',
        operationalState: active ? 'ACTIVE' : 'INACTIVE',
        qualificationState: 'NOT_APPLICABLE',
        readinessState: accountReady && active ? 'READY' : 'BLOCKED',
        readinessReasons: !accountActive
          ? ['PROVIDER_ACCOUNT_NOT_ACTIVE']
          : !activationActive
            ? ['PROVIDER_ACTIVATION_NOT_ACTIVE']
            : !active
              ? ['SERVICE_TEMPORARILY_INACTIVE']
              : [],
        approvedAt: row.approved_at,
        updatedAt: row.updated_at,
        pauseReason: row.pause_reason ?? null,
        availableActions: active ? ['PAUSE'] : ['REACTIVATE'],
      };
    }),
    applications,
  };
};

export const approveApplicationAtomic = async (
  applicationId: string,
  adminUid: string,
  expectedVersion: number,
  internalNote?: string,
) => {
  await ensureTable();
  const client = await pool.connect();
  let committed: any;
  try {
    await client.query('BEGIN');
    const locked = await client.query(
      `SELECT wsa.*, s.name AS service_name FROM ${dbSchema}.worker_service_applications wsa
       JOIN ${dbSchema}.service_families s ON s.id = wsa.service_id
       WHERE wsa.id = $1 FOR UPDATE`,
      [applicationId],
    );
    if (!locked.rowCount) throw applicationError('Application not found.', 'SERVICE_APPLICATION_NOT_FOUND', 404);
    const app = locked.rows[0];
    if (Number(app.version) !== expectedVersion) {
      throw applicationError('The application changed. Refresh before deciding.', 'SERVICE_APPLICATION_VERSION_CONFLICT', 409);
    }
    if (!['pending_review', 'action_required'].includes(app.status)) {
      throw applicationError(`Cannot approve an application with status '${app.status}'.`, 'SERVICE_APPLICATION_STATE_CONFLICT', 409);
    }
    await client.query(
      `INSERT INTO ${dbSchema}.employee_services (employee_uid, service_id)
       VALUES ($1, $2) ON CONFLICT (employee_uid, service_id) DO NOTHING`,
      [app.worker_uid, app.service_id],
    );
    const updated = await client.query(
      `UPDATE ${dbSchema}.worker_service_applications
       SET status = 'approved', approved_at = NOW(), reviewed_at = NOW(),
           reviewed_by = $2, review_reason = $3,
           provider_reason_code = NULL, provider_reason_detail = NULL,
           updated_at = NOW(), version = version + 1
       WHERE id = $1 RETURNING ${APPLICATION_FIELDS}`,
      [applicationId, adminUid, internalNote?.trim() || null],
    );
    await addTimelineEvent(
      (sql, params) => client.query(sql, params), applicationId,
      `approved:${expectedVersion + 1}`, 'APPLICATION_APPROVED',
      'Application approved', 'Servana approved your service application.', 'admin',
    );
    await client.query('COMMIT');
    committed = { ...updated.rows[0], service_name: app.service_name };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  createNotification(committed.worker_uid, {
    notificationKey: `svc_app_approved_${applicationId}_${committed.version}`,
    type: 'requirement_review', severity: 'info', title: 'Application approved',
    safeBody: `Your application for ${committed.service_name} was approved. Check My Services for readiness.`,
    safeContextLabel: committed.service_name,
    route: { screen: 'ServiceApplication', applicationId }, canOpenDetail: true,
  }).catch(() => {});
  return committed;
};

export const decideApplicationAtomic = async (
  applicationId: string,
  adminUid: string,
  expectedVersion: number,
  decision: 'rejected' | 'action_required',
  providerReasonCode: string,
  providerReasonDetail: string,
  internalNote?: string,
) => {
  await ensureTable();
  if (!/^[A-Z0-9_]{3,80}$/.test(providerReasonCode)) {
    throw applicationError('A stable provider reason code is required.', 'INVALID_PROVIDER_REASON_CODE', 400);
  }
  const safeDetail = providerReasonDetail.trim();
  if (!safeDetail || safeDetail.length > 500) {
    throw applicationError('providerReasonDetail must be between 1 and 500 characters.', 'INVALID_PROVIDER_REASON_DETAIL', 400);
  }
  const client = await pool.connect();
  let committed: any;
  try {
    await client.query('BEGIN');
    const locked = await client.query(
      `SELECT wsa.*, s.name AS service_name FROM ${dbSchema}.worker_service_applications wsa
       JOIN ${dbSchema}.service_families s ON s.id = wsa.service_id
       WHERE wsa.id = $1 FOR UPDATE`,
      [applicationId],
    );
    if (!locked.rowCount) throw applicationError('Application not found.', 'SERVICE_APPLICATION_NOT_FOUND', 404);
    const app = locked.rows[0];
    if (Number(app.version) !== expectedVersion) {
      throw applicationError('The application changed. Refresh before deciding.', 'SERVICE_APPLICATION_VERSION_CONFLICT', 409);
    }
    if (!['pending_review', 'action_required'].includes(app.status)) {
      throw applicationError(`Cannot update an application with status '${app.status}'.`, 'SERVICE_APPLICATION_STATE_CONFLICT', 409);
    }
    const updated = await client.query(
      `UPDATE ${dbSchema}.worker_service_applications
       SET status = $2, reviewed_at = NOW(), reviewed_by = $3,
           review_reason = $4, provider_reason_code = $5, provider_reason_detail = $6,
           updated_at = NOW(), version = version + 1
       WHERE id = $1 RETURNING ${APPLICATION_FIELDS}`,
      [applicationId, decision, adminUid, internalNote?.trim() || null, providerReasonCode, safeDetail],
    );
    const code = decision === 'rejected' ? 'APPLICATION_REJECTED' : 'ADDITIONAL_INFORMATION_REQUIRED';
    const label = decision === 'rejected' ? 'Application not approved' : 'Additional information required';
    await addTimelineEvent(
      (sql, params) => client.query(sql, params), applicationId,
      `${decision}:${expectedVersion + 1}`, code, label, safeDetail, 'admin',
    );
    await client.query('COMMIT');
    committed = { ...updated.rows[0], service_name: app.service_name };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  createNotification(committed.worker_uid, {
    notificationKey: `svc_app_${decision}_${applicationId}_${committed.version}`,
    type: 'requirement_review', severity: 'warning',
    title: decision === 'rejected' ? 'Application update' : 'Application action required',
    safeBody: safeDetail, safeContextLabel: committed.service_name,
    route: { screen: 'ServiceApplication', applicationId }, canOpenDetail: true,
  }).catch(() => {});
  return committed;
};

/** Create a pending_review application. Blocks duplicates and already-active services. */
const submitApplicationLegacy = async (workerUid: string, serviceId: number) => {
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
export const submitApplication = async (
  workerUid: string,
  serviceId: number,
  input: { clientRequestId: string; requirementsVersion: number },
) => {
  await ensureTable();
  const clientRequestId = input.clientRequestId?.trim();
  if (!clientRequestId || clientRequestId.length < 16 || clientRequestId.length > 128) {
    throw applicationError('clientRequestId must be between 16 and 128 characters.', 'INVALID_IDEMPOTENCY_KEY', 400);
  }
  const replay = await dbQuery.query(
    `SELECT ${APPLICATION_FIELDS} FROM ${dbSchema}.worker_service_applications
     WHERE worker_uid = $1 AND client_request_id = $2 LIMIT 1`,
    [workerUid, clientRequestId],
  );
  if (replay.rowCount) {
    if (Number(replay.rows[0].service_id) !== serviceId) {
      throw applicationError('This submission key was already used for a different service.', 'IDEMPOTENCY_KEY_REUSED', 409);
    }
    return replay.rows[0];
  }
  const eligibility = await evaluateApplicationEligibility(workerUid, serviceId);
  if (input.requirementsVersion !== eligibility.requirementsVersion) {
    throw applicationError('Service requirements changed. Review the current requirements before submitting.', 'SERVICE_REQUIREMENTS_VERSION_CONFLICT', 409, { eligibility });
  }
  if (!eligibility.eligible) {
    throw applicationError(eligibility.message, eligibility.code, 409, { eligibility });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`service-application:${workerUid}:${serviceId}`]);
    // Admin policy updates lock the offering row before changing policy.
    // This share lock keeps the final policy check stable through insertion.
    await client.query(
      `SELECT o.id FROM ${dbSchema}.provider_catalog_offerings o
       JOIN ${dbSchema}.provider_catalog_offering_mappings m ON m.offering_id = o.id
       WHERE m.service_id = $1 AND m.is_active = TRUE FOR SHARE OF o`,
      [serviceId],
    );
    const committedPolicy = await evaluateServicePolicy(
      workerUid,
      serviceId,
      (sql, params = []) => client.query(sql, params),
    );
    if (input.requirementsVersion !== committedPolicy.requirementsVersion) {
      throw applicationError('Service requirements changed. Review the current requirements before submitting.', 'SERVICE_REQUIREMENTS_VERSION_CONFLICT', 409);
    }
    if (!committedPolicy.eligible) {
      throw applicationError(committedPolicy.message, committedPolicy.code, 409, { requirements: committedPolicy.requirements });
    }

    const priorRequest = await client.query(
      `SELECT ${APPLICATION_FIELDS} FROM ${dbSchema}.worker_service_applications
       WHERE worker_uid = $1 AND client_request_id = $2 LIMIT 1`,
      [workerUid, clientRequestId],
    );
    if (priorRequest.rowCount) {
      const existing = priorRequest.rows[0];
      if (Number(existing.service_id) !== serviceId) {
        throw applicationError('This submission key was already used for a different service.', 'IDEMPOTENCY_KEY_REUSED', 409);
      }
      await client.query('COMMIT');
      return existing;
    }

    const activeCheck = await client.query(
      `SELECT 1 FROM ${dbSchema}.employee_services WHERE employee_uid = $1 AND service_id = $2 LIMIT 1`,
      [workerUid, serviceId],
    );
    if (activeCheck.rowCount) {
      throw applicationError('Provider is already approved for this service.', 'SERVICE_ALREADY_ACTIVE', 409);
    }
    const openCheck = await client.query(
      `SELECT ${APPLICATION_FIELDS} FROM ${dbSchema}.worker_service_applications
       WHERE worker_uid = $1 AND service_id = $2 AND status IN ('pending_review', 'action_required') LIMIT 1`,
      [workerUid, serviceId],
    );
    if (openCheck.rowCount) {
      throw applicationError('An application for this service is already under review.', 'SERVICE_APPLICATION_ALREADY_EXISTS', 409, { application: openCheck.rows[0] });
    }

    const res = await client.query(
      `INSERT INTO ${dbSchema}.worker_service_applications
         (worker_uid, service_id, status, submitted_at, updated_at, version,
          client_request_id, requirements_version, service_snapshot)
       VALUES ($1, $2, 'pending_review', NOW(), NOW(), 1, $3, $4, $5::jsonb)
       RETURNING ${APPLICATION_FIELDS}`,
      [workerUid, serviceId, clientRequestId, input.requirementsVersion, JSON.stringify(eligibility.service)],
    );
    const application = res.rows[0];
    await addTimelineEvent(
      (sql, params) => client.query(sql, params), application.id,
      `submitted:${clientRequestId}`, 'APPLICATION_SUBMITTED',
      'Application submitted', 'Your application was submitted for review.', 'provider',
    );
    await client.query('COMMIT');
    return application;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
};

const resubmitApplicationLegacy = async (applicationId: string, workerUid: string) => {
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
export const resubmitApplication = async (
  applicationId: string,
  workerUid: string,
  input: { clientRequestId: string; expectedVersion: number },
) => {
  await ensureTable();
  const requestId = input.clientRequestId?.trim();
  if (!requestId || requestId.length < 16 || requestId.length > 128) {
    throw applicationError('clientRequestId must be between 16 and 128 characters.', 'INVALID_IDEMPOTENCY_KEY', 400);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query(
      `SELECT * FROM ${dbSchema}.worker_service_applications
       WHERE id = $1 AND worker_uid = $2 FOR UPDATE`,
      [applicationId, workerUid],
    );
    if (!locked.rowCount) throw applicationError('Application not found.', 'SERVICE_APPLICATION_NOT_FOUND', 404);
    const current = locked.rows[0];
    const replay = await client.query(
      `SELECT 1 FROM ${dbSchema}.worker_service_application_timeline
       WHERE application_id = $1 AND event_key = $2 LIMIT 1`,
      [applicationId, `resubmitted:${requestId}`],
    );
    if (replay.rowCount) {
      await client.query('COMMIT');
      return current;
    }
    if (Number(current.version) !== input.expectedVersion) {
      throw applicationError('The application changed. Refresh before resubmitting.', 'SERVICE_APPLICATION_VERSION_CONFLICT', 409);
    }
    if (current.status !== 'action_required') {
      throw applicationError('Only applications requiring information can be resubmitted.', 'SERVICE_APPLICATION_STATE_CONFLICT', 409);
    }
    const updated = await client.query(
      `UPDATE ${dbSchema}.worker_service_applications
       SET status = 'pending_review', provider_reason_code = NULL,
           provider_reason_detail = NULL, updated_at = NOW(), version = version + 1
       WHERE id = $1 RETURNING ${APPLICATION_FIELDS}`,
      [applicationId],
    );
    await addTimelineEvent(
      (sql, params) => client.query(sql, params), applicationId,
      `resubmitted:${requestId}`, 'APPLICATION_RESUBMITTED',
      'Application resubmitted', 'Your updated information was sent for review.', 'provider',
    );
    await client.query('COMMIT');
    return updated.rows[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

export const approveApplication = async (applicationId: string, adminUid: string) => {
  await ensureTable();
  const appRes = await dbQuery.query(
    `SELECT wsa.id, wsa.worker_uid, wsa.service_id, wsa.status,
            wsa.submitted_at, wsa.updated_at, wsa.cancelled_at, wsa.approved_at,
            wsa.reviewed_at, wsa.review_reason, wsa.version,
            s.name AS service_name
     FROM ${dbSchema}.worker_service_applications wsa
     LEFT JOIN ${dbSchema}.service_families s ON s.id = wsa.service_id
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
      `SELECT name FROM ${dbSchema}.service_families WHERE id = $1 LIMIT 1`,
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
      `SELECT name FROM ${dbSchema}.service_families WHERE id = $1 LIMIT 1`,
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
     LEFT JOIN ${dbSchema}.service_families s ON s.id = wsa.service_id
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
