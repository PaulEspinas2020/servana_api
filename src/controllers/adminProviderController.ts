import { Request, Response } from 'express';
import * as svc from '../services/adminProviderService';
import * as appSvc from '../services/serviceApplicationService';

// ── Helpers ───────────────────────────────────────────────────────────────────

const ok = (res: Response, data: any, meta?: any) =>
  res.status(200).json({ status: 'success', data, ...(meta ? { meta } : {}) });

const fail = (res: Response, status: number, message: string) =>
  res.status(status).json({ status: 'failed', message });

const parseIntQ = (val: any, fallback: number) => {
  const n = parseInt(val, 10);
  return isNaN(n) ? fallback : n;
};

const adminUid = (req: Request): string => req.user?.uid ?? '';

// ── Provider List ─────────────────────────────────────────────────────────────

export const listProviders = async (req: Request, res: Response) => {
  try {
    const { search, role, account_status, is_archive, sort_by, sort_dir } = req.query;
    const page = parseIntQ(req.query.page, 1);
    const limit = Math.min(parseIntQ(req.query.limit, 50), 200);

    const result = await svc.listProviders({
      search: search as string | undefined,
      role: role !== undefined ? Number(role) : undefined,
      accountStatus: account_status as string | undefined,
      isArchive: is_archive !== undefined ? is_archive === 'true' : undefined,
      page,
      limit,
      sortBy: (sort_by as any) ?? 'created_date',
      sortDir: (sort_dir as any) ?? 'desc',
    });

    return ok(res, result.rows, {
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: Math.ceil(result.total / result.limit),
    });
  } catch (err: any) {
    return fail(res, 500, err?.message ?? 'Failed to fetch providers');
  }
};

// ── Summary Metrics ───────────────────────────────────────────────────────────

export const getProviderMetrics = async (_req: Request, res: Response) => {
  try {
    const metrics = await svc.getProviderMetrics();
    return ok(res, metrics);
  } catch (err: any) {
    return fail(res, 500, err?.message ?? 'Failed to fetch metrics');
  }
};

// ── Provider Identity ─────────────────────────────────────────────────────────

export const getProvider = async (req: Request, res: Response) => {
  try {
    const uid = String(req.params.uid);
    const provider = await svc.getProviderIdentity(uid);
    if (!provider) return fail(res, 404, 'Provider not found');
    return ok(res, provider);
  } catch (err: any) {
    return fail(res, 500, err?.message ?? 'Failed to fetch provider');
  }
};

// ── Active Services ───────────────────────────────────────────────────────────

export const getProviderServices = async (req: Request, res: Response) => {
  try {
    const uid = String(req.params.uid);
    const services = await svc.getProviderActiveServices(uid);
    return ok(res, services);
  } catch (err: any) {
    return fail(res, 500, err?.message ?? 'Failed to fetch services');
  }
};

// ── Service Applications ──────────────────────────────────────────────────────

export const getProviderServiceApplications = async (req: Request, res: Response) => {
  try {
    const uid = String(req.params.uid);
    const applications = await svc.getProviderServiceApplications(uid);
    return ok(res, applications);
  } catch (err: any) {
    return fail(res, 500, err?.message ?? 'Failed to fetch service applications');
  }
};

// ── All Service Applications (global, paginated) ──────────────────────────────

export const listAllServiceApplications = async (req: Request, res: Response) => {
  try {
    const { status } = req.query;
    const page = parseIntQ(req.query.page, 1);
    const limit = Math.min(parseIntQ(req.query.limit, 50), 200);
    const offset = (page - 1) * limit;

    const params: any[] = [];
    const where: string[] = [];

    if (status) {
      params.push(status);
      where.push(`wsa.status = $${params.length}`);
    }

    const { default: dbQuery } = await import('../db/dbQuery');
    const { db } = await import('../config');
    const schema = db.schema;
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    params.push(limit, offset);
    const limitP = params.length - 1;
    const offsetP = params.length;

    const [rowsRes, countRes] = await Promise.all([
      dbQuery.query(
        `SELECT wsa.id, wsa.worker_uid, wsa.service_id, wsa.status,
                wsa.submitted_at, wsa.reviewed_at, wsa.reviewed_by, wsa.review_reason, wsa.version,
                s.level_1 AS category, s.level_2 AS service_name,
                uc.first_name, uc.last_name, uc.email
         FROM ${schema}.worker_service_applications wsa
         LEFT JOIN ${schema}.services s ON s.id = wsa.service_id
         LEFT JOIN ${schema}.user_credentials uc ON uc.uid = wsa.worker_uid
         ${whereClause}
         ORDER BY wsa.submitted_at DESC
         LIMIT $${limitP} OFFSET $${offsetP}`,
        params
      ),
      dbQuery.query(
        `SELECT COUNT(*) FROM ${schema}.worker_service_applications wsa ${whereClause}`,
        params.slice(0, -2)
      ),
    ]);

    const rows = rowsRes.rows.map((r: any) => ({
      id: r.id,
      workerUid: r.worker_uid,
      workerName: `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || r.email,
      serviceId: r.service_id,
      category: r.category ?? '',
      serviceName: r.service_name ?? '',
      status: r.status,
      submittedAt: r.submitted_at,
      reviewedAt: r.reviewed_at ?? null,
      reviewedBy: r.reviewed_by ?? null,
      reviewReason: r.review_reason ?? null,
      version: r.version,
    }));

    return ok(res, rows, {
      total: Number(countRes.rows[0]?.count ?? 0),
      page,
      limit,
    });
  } catch (err: any) {
    return fail(res, 500, err?.message ?? 'Failed to fetch service applications');
  }
};

// ── Approve / Reject Application ──────────────────────────────────────────────

export const approveServiceApplication = async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const { expectedVersion, reason } = req.body ?? {};
    const admin = adminUid(req);

    if (typeof expectedVersion !== 'number') {
      return fail(res, 400, 'expectedVersion (number) is required');
    }

    const { default: dbQuery } = await import('../db/dbQuery');
    const { db } = await import('../config');
    const schema = db.schema;

    const appRes = await dbQuery.query(
      `SELECT * FROM ${schema}.worker_service_applications WHERE id = $1 LIMIT 1`,
      [id]
    );
    if (!appRes.rowCount) return fail(res, 404, 'Application not found');

    const app = appRes.rows[0];
    if (app.version !== expectedVersion) {
      return fail(res, 409, `Version conflict: expected ${expectedVersion}, got ${app.version}`);
    }
    if (app.status !== 'pending_review' && app.status !== 'action_required') {
      return fail(res, 409, `Cannot approve an application with status '${app.status}'`);
    }

    await dbQuery.query('BEGIN');
    try {
      await dbQuery.query(
        `UPDATE ${schema}.worker_service_applications
         SET status = 'approved', approved_at = NOW(), reviewed_at = NOW(),
             reviewed_by = $1, review_reason = $2, updated_at = NOW(), version = version + 1
         WHERE id = $3`,
        [admin, reason ?? null, id]
      );

      await dbQuery.query(
        `INSERT INTO ${schema}.employee_services (employee_uid, service_id, created_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT DO NOTHING`,
        [app.worker_uid, app.service_id]
      );

      await dbQuery.query('COMMIT');
    } catch (txErr) {
      await dbQuery.query('ROLLBACK');
      throw txErr;
    }

    return ok(res, { id, status: 'approved' });
  } catch (err: any) {
    const code = err?.statusCode ?? 500;
    return fail(res, code, err?.message ?? 'Failed to approve application');
  }
};

export const rejectServiceApplication = async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const { expectedVersion, reason } = req.body ?? {};
    const admin = adminUid(req);

    if (typeof expectedVersion !== 'number') {
      return fail(res, 400, 'expectedVersion (number) is required');
    }

    const { default: dbQuery } = await import('../db/dbQuery');
    const { db } = await import('../config');
    const schema = db.schema;

    const appRes = await dbQuery.query(
      `SELECT * FROM ${schema}.worker_service_applications WHERE id = $1 LIMIT 1`,
      [id]
    );
    if (!appRes.rowCount) return fail(res, 404, 'Application not found');

    const app = appRes.rows[0];
    if (app.version !== expectedVersion) {
      return fail(res, 409, `Version conflict: expected ${expectedVersion}, got ${app.version}`);
    }
    if (app.status !== 'pending_review' && app.status !== 'action_required') {
      return fail(res, 409, `Cannot reject an application with status '${app.status}'`);
    }

    await dbQuery.query(
      `UPDATE ${schema}.worker_service_applications
       SET status = 'rejected', reviewed_at = NOW(), reviewed_by = $1,
           review_reason = $2, updated_at = NOW(), version = version + 1
       WHERE id = $3`,
      [admin, reason ?? null, id]
    );

    return ok(res, { id, status: 'rejected' });
  } catch (err: any) {
    const code = err?.statusCode ?? 500;
    return fail(res, code, err?.message ?? 'Failed to reject application');
  }
};

// ── Catalog Capabilities ──────────────────────────────────────────────────────

export const getProviderCatalogCapabilities = async (req: Request, res: Response) => {
  try {
    const uid = String(req.params.uid);
    const caps = await svc.getProviderCatalogCapabilities(uid);
    return ok(res, caps);
  } catch (err: any) {
    return fail(res, 500, err?.message ?? 'Failed to fetch catalog capabilities');
  }
};

// ── Requirements ──────────────────────────────────────────────────────────────

export const getProviderRequirements = async (req: Request, res: Response) => {
  try {
    const uid = String(req.params.uid);
    const docs = await svc.getProviderRequirements(uid);
    return ok(res, docs);
  } catch (err: any) {
    return fail(res, 500, err?.message ?? 'Failed to fetch requirements');
  }
};

export const uploadProviderRequirement = async (req: Request, res: Response) => {
  try {
    const uid = String(req.params.uid);
    const { file, name, requirementType } = req.body;
    if (!file || !name) return fail(res, 400, 'file (data URI) and name are required');
    if (!String(file).startsWith('data:')) return fail(res, 422, 'file must be a data URI');
    const doc = await svc.uploadProviderRequirement(uid, String(file), String(name), requirementType ? String(requirementType) : undefined);
    return ok(res, doc);
  } catch (err: any) {
    const status = err.message?.includes('not allowed') ? 422 : 500;
    return fail(res, status, err?.message ?? 'Failed to upload requirement');
  }
};

export const deleteProviderRequirement = async (req: Request, res: Response) => {
  try {
    const uid = String(req.params.uid);
    const id = Number(req.params.id);
    if (!id) return fail(res, 400, 'Invalid requirement id');
    const deleted = await svc.deleteProviderRequirement(uid, id);
    return ok(res, deleted);
  } catch (err: any) {
    return fail(res, 404, err?.message ?? 'Requirement not found');
  }
};

// ── Jobs ──────────────────────────────────────────────────────────────────────

export const getProviderJobs = async (req: Request, res: Response) => {
  try {
    const uid = String(req.params.uid);
    const { status } = req.query;
    const page = parseIntQ(req.query.page, 1);
    const limit = Math.min(parseIntQ(req.query.limit, 30), 100);
    const result = await svc.getProviderJobs(uid, { status: status as string, page, limit });
    return ok(res, result.rows, {
      total: result.total,
      page: result.page,
      limit: result.limit,
    });
  } catch (err: any) {
    return fail(res, 500, err?.message ?? 'Failed to fetch jobs');
  }
};

// ── Performance ───────────────────────────────────────────────────────────────

export const getProviderPerformance = async (req: Request, res: Response) => {
  try {
    const uid = String(req.params.uid);
    const perf = await svc.getProviderPerformance(uid);
    return ok(res, perf);
  } catch (err: any) {
    return fail(res, 500, err?.message ?? 'Failed to fetch performance');
  }
};

// ── Earnings ──────────────────────────────────────────────────────────────────

export const getProviderEarnings = async (req: Request, res: Response) => {
  try {
    const uid = String(req.params.uid);
    const earnings = await svc.getProviderEarningsSummary(uid);
    return ok(res, earnings);
  } catch (err: any) {
    return fail(res, 500, err?.message ?? 'Failed to fetch earnings');
  }
};

// ── Availability ──────────────────────────────────────────────────────────────

export const getProviderAvailability = async (req: Request, res: Response) => {
  try {
    const uid = String(req.params.uid);
    const avail = await svc.getProviderAvailability(uid);
    return ok(res, avail);
  } catch (err: any) {
    return fail(res, 500, err?.message ?? 'Failed to fetch availability');
  }
};

// ── Service Area ──────────────────────────────────────────────────────────────

export const getProviderServiceArea = async (req: Request, res: Response) => {
  try {
    const uid = String(req.params.uid);
    const area = await svc.getProviderServiceArea(uid);
    return ok(res, area);
  } catch (err: any) {
    return fail(res, 500, err?.message ?? 'Failed to fetch service area');
  }
};

// ── Account Status Mutation ───────────────────────────────────────────────────

export const updateProviderAccountStatus = async (req: Request, res: Response) => {
  try {
    const uid = String(req.params.uid);
    const { accountStatus, reason } = req.body ?? {};

    if (!accountStatus) return fail(res, 400, 'accountStatus is required');

    const updated = await svc.updateProviderAccountStatus(uid, accountStatus, adminUid(req), reason);
    return ok(res, { uid: updated.uid, accountStatus: updated.account_status });
  } catch (err: any) {
    const code = err?.statusCode ?? 500;
    return fail(res, code, err?.message ?? 'Failed to update account status');
  }
};

// ── Archive / Restore ─────────────────────────────────────────────────────────

export const setProviderArchive = async (req: Request, res: Response) => {
  try {
    const uid = String(req.params.uid);
    const { isArchive } = req.body ?? {};

    if (typeof isArchive !== 'boolean') {
      return fail(res, 400, 'isArchive (boolean) is required');
    }

    const updated = await svc.setProviderArchive(uid, isArchive);
    return ok(res, { uid: updated.uid, isArchive: updated.is_archive });
  } catch (err: any) {
    const code = err?.statusCode ?? 500;
    return fail(res, code, err?.message ?? 'Failed to update archive status');
  }
};
