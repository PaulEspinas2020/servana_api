/**
 * Admin Provider Service — read model for the Provider 360 admin workspace.
 *
 * All queries are additive read-only projections. No existing table is modified
 * by this module. Financial figures are gross booking amounts — disbursement
 * breakdowns are shown to role=1 admins only.
 */

import dbQuery from '../db/dbQuery';
import { db } from '../config';
import mongoDb from '../db/mongodbQuery';
import * as serviceApplicationService from './serviceApplicationService';
import * as technicianService from './technicianService';

const dbSchema = db.schema;

// ── Provider List ─────────────────────────────────────────────────────────────

export interface ProviderListFilter {
  search?: string;
  role?: number;
  accountStatus?: string;
  isArchive?: boolean;
  page?: number;
  limit?: number;
  sortBy?: 'name' | 'created_date' | 'account_status';
  sortDir?: 'asc' | 'desc';
}

export const listProviders = async (filter: ProviderListFilter = {}) => {
  const {
    search,
    role,
    accountStatus,
    isArchive,
    page = 1,
    limit = 50,
    sortBy = 'created_date',
    sortDir = 'desc',
  } = filter;

  const offset = (page - 1) * limit;
  const params: any[] = [];
  const where: string[] = [];

  // Exclude role=1 (admins) and role=3 (customers) from provider list
  where.push(`uc.role IN (2, 4)`);

  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    const p = params.length;
    where.push(
      `(LOWER(uc.first_name || ' ' || uc.last_name) LIKE $${p} OR LOWER(uc.email) LIKE $${p} OR uc.phone_number LIKE $${p})`
    );
  }

  if (role !== undefined && role !== null) {
    params.push(role);
    where.push(`uc.role = $${params.length}`);
  }

  if (accountStatus) {
    params.push(accountStatus);
    where.push(`uc.account_status = $${params.length}`);
  }

  if (isArchive !== undefined) {
    params.push(isArchive);
    where.push(`uc.is_archive = $${params.length}`);
  }

  const sortColumn: Record<string, string> = {
    name: `uc.first_name`,
    created_date: `uc.created_date`,
    account_status: `uc.account_status`,
  };
  const col = sortColumn[sortBy] ?? `uc.created_date`;
  const dir = sortDir === 'asc' ? 'ASC' : 'DESC';

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  params.push(limit, offset);
  const limitP = params.length - 1;
  const offsetP = params.length;

  const [rowsRes, countRes] = await Promise.all([
    dbQuery.query(
      `SELECT
         uc.uid,
         uc.first_name,
         uc.last_name,
         uc.email,
         uc.phone_number,
         uc.role,
         uc.account_status,
         uc.is_archive,
         uc.is_email_verified,
         uc.created_date,
         up.photo_url
       FROM ${dbSchema}.user_credentials uc
       LEFT JOIN ${dbSchema}.user_profile up ON up.uid = uc.uid
       ${whereClause}
       ORDER BY ${col} ${dir}
       LIMIT $${limitP} OFFSET $${offsetP}`,
      params
    ),
    dbQuery.query(
      `SELECT COUNT(*) FROM ${dbSchema}.user_credentials uc ${whereClause}`,
      params.slice(0, -2)
    ),
  ]);

  return {
    rows: rowsRes.rows,
    total: Number(countRes.rows[0]?.count ?? 0),
    page,
    limit,
  };
};

// ── Summary Metrics ───────────────────────────────────────────────────────────

export const getProviderMetrics = async () => {
  const res = await dbQuery.query(
    `SELECT
       COUNT(*) FILTER (WHERE role IN (2,4)) AS total,
       COUNT(*) FILTER (WHERE role IN (2,4) AND is_archive = false AND account_status = 'active') AS active,
       COUNT(*) FILTER (WHERE role IN (2,4) AND is_archive = true) AS archived,
       COUNT(*) FILTER (WHERE role IN (2,4) AND account_status = 'pending') AS pending_review,
       COUNT(*) FILTER (WHERE role IN (2,4) AND account_status = 'suspended') AS suspended,
       COUNT(*) FILTER (WHERE role IN (2,4) AND account_status IN ('rejected','deactivated')) AS rejected
     FROM ${dbSchema}.user_credentials`,
    []
  );
  const r = res.rows[0] ?? {};
  return {
    total: Number(r.total ?? 0),
    active: Number(r.active ?? 0),
    archived: Number(r.archived ?? 0),
    pendingReview: Number(r.pending_review ?? 0),
    suspended: Number(r.suspended ?? 0),
    rejected: Number(r.rejected ?? 0),
  };
};

// ── Provider 360 Detail ───────────────────────────────────────────────────────

export const getProviderIdentity = async (uid: string) => {
  const [credRes, profileRes, addrRes, locationDoc] = await Promise.all([
    dbQuery.query(
      `SELECT uid, email, first_name, last_name, phone_number, role,
              account_status, is_archive, is_email_verified, created_date
       FROM ${dbSchema}.user_credentials WHERE uid = $1 LIMIT 1`,
      [uid]
    ),
    dbQuery.query(
      `SELECT photo_url, birthdate, gender FROM ${dbSchema}.user_profile WHERE uid = $1 LIMIT 1`,
      [uid]
    ),
    dbQuery.query(
      `SELECT address_one, address_two, zip_code, post_town, country, label, is_primary
       FROM ${dbSchema}.user_address WHERE uid = $1 ORDER BY is_primary DESC LIMIT 1`,
      [uid]
    ),
    (async () => {
      try {
        const col = (await mongoDb).collection('worker_locations');
        return col.findOne({ uid }, { projection: { is_online: 1, updatedAt: 1 } });
      } catch {
        return null;
      }
    })(),
  ]);

  if (!credRes.rowCount) return null;

  const cred = credRes.rows[0];
  const profile = profileRes.rows[0] ?? {};
  const addr = addrRes.rows[0] ?? {};

  return {
    uid: cred.uid,
    email: cred.email,
    firstName: cred.first_name,
    lastName: cred.last_name,
    fullName: `${cred.first_name ?? ''} ${cred.last_name ?? ''}`.trim() || cred.email,
    phoneNumber: cred.phone_number,
    role: cred.role,
    accountStatus: cred.account_status ?? 'pending',
    isArchive: cred.is_archive,
    isEmailVerified: cred.is_email_verified,
    createdDate: cred.created_date,
    photoUrl: profile.photo_url ?? null,
    birthdate: profile.birthdate ?? null,
    gender: profile.gender ?? null,
    address: addr.address_one
      ? {
          addressOne: addr.address_one,
          addressTwo: addr.address_two ?? null,
          zipCode: addr.zip_code ?? null,
          city: addr.post_town ?? null,
          country: addr.country ?? 'PH',
          label: addr.label ?? null,
        }
      : null,
    onlineStatus: locationDoc?.is_online ? 'online' : 'offline',
    lastSeenAt: locationDoc?.updatedAt ?? null,
  };
};

// ── Active Services (employee_services) ───────────────────────────────────────

export const getProviderActiveServices = async (uid: string) => {
  const res = await dbQuery.query(
    `SELECT es.service_id, es.created_at,
            s.level_1 AS category, s.level_2 AS service_name
     FROM ${dbSchema}.employee_services es
     LEFT JOIN ${dbSchema}.services s ON s.id = es.service_id
     WHERE es.employee_uid = $1
     ORDER BY es.created_at DESC`,
    [uid]
  );
  return res.rows.map((r: any) => ({
    serviceId: r.service_id,
    category: r.category ?? '',
    serviceName: r.service_name ?? '',
    assignedAt: r.created_at,
  }));
};

// ── Service Applications ──────────────────────────────────────────────────────

export const getProviderServiceApplications = async (uid: string) => {
  const res = await dbQuery.query(
    `SELECT wsa.id, wsa.service_id, wsa.status, wsa.submitted_at, wsa.updated_at,
            wsa.reviewed_at, wsa.reviewed_by, wsa.review_reason, wsa.version,
            wsa.approved_at, wsa.cancelled_at,
            s.level_1 AS category, s.level_2 AS service_name,
            rev.first_name AS reviewer_first, rev.last_name AS reviewer_last
     FROM ${dbSchema}.worker_service_applications wsa
     LEFT JOIN ${dbSchema}.services s ON s.id = wsa.service_id
     LEFT JOIN ${dbSchema}.user_credentials rev ON rev.uid = wsa.reviewed_by
     WHERE wsa.worker_uid = $1
     ORDER BY wsa.submitted_at DESC`,
    [uid]
  );
  return res.rows.map((r: any) => ({
    id: r.id,
    serviceId: r.service_id,
    category: r.category ?? '',
    serviceName: r.service_name ?? '',
    status: r.status,
    submittedAt: r.submitted_at,
    updatedAt: r.updated_at,
    reviewedAt: r.reviewed_at ?? null,
    reviewedBy: r.reviewed_by ?? null,
    reviewedByName: r.reviewer_first
      ? `${r.reviewer_first} ${r.reviewer_last ?? ''}`.trim()
      : null,
    reviewReason: r.review_reason ?? null,
    approvedAt: r.approved_at ?? null,
    cancelledAt: r.cancelled_at ?? null,
    version: r.version,
  }));
};

// ── Catalog Capabilities (employee_catalog_capabilities) ──────────────────────

export const getProviderCatalogCapabilities = async (uid: string) => {
  const res = await dbQuery.query(
    `SELECT ecc.id, ecc.offering_id, ecc.service_id, ecc.status,
            ecc.approved_at, ecc.suspended_at, ecc.application_id,
            pco.name AS offering_name, pco.catalog_key,
            s.level_1 AS category, s.level_2 AS service_name
     FROM ${dbSchema}.employee_catalog_capabilities ecc
     LEFT JOIN ${dbSchema}.provider_catalog_offerings pco ON pco.id = ecc.offering_id
     LEFT JOIN ${dbSchema}.services s ON s.id = ecc.service_id
     WHERE ecc.employee_uid = $1
     ORDER BY ecc.approved_at DESC NULLS LAST`,
    [uid]
  );
  return res.rows.map((r: any) => ({
    id: r.id,
    offeringId: r.offering_id,
    serviceId: r.service_id,
    offeringName: r.offering_name ?? '',
    catalogKey: r.catalog_key ?? '',
    category: r.category ?? '',
    serviceName: r.service_name ?? '',
    status: r.status,
    approvedAt: r.approved_at ?? null,
    suspendedAt: r.suspended_at ?? null,
    applicationId: r.application_id ?? null,
  }));
};

// ── Requirements / Documents ──────────────────────────────────────────────────

export const getProviderRequirements = async (uid: string) => {
  const res = await dbQuery.query(
    `SELECT id, file_url, file_name, uploaded_at, requirement_type
     FROM ${dbSchema}.worker_requirements
     WHERE worker_uid = $1
     ORDER BY uploaded_at DESC`,
    [uid]
  );
  return res.rows.map((r: any) => ({
    id: r.id,
    fileName: r.file_name,
    fileUrl: r.file_url,
    uploadedAt: r.uploaded_at,
    requirementType: r.requirement_type ?? 'document',
  }));
};

// ── Jobs / Bookings ───────────────────────────────────────────────────────────

export interface ProviderJobsFilter {
  status?: string;
  page?: number;
  limit?: number;
}

export const getProviderJobs = async (uid: string, filter: ProviderJobsFilter = {}) => {
  const { status, page = 1, limit = 30 } = filter;
  const offset = (page - 1) * limit;
  const params: any[] = [uid];
  const where: string[] = ['b.worker_uid = $1'];

  if (status) {
    params.push(status.toUpperCase());
    where.push(`b.status = $${params.length}`);
  }

  params.push(limit, offset);
  const limitP = params.length - 1;
  const offsetP = params.length;

  const [rowsRes, countRes] = await Promise.all([
    dbQuery.query(
      `SELECT b.id, b.status, b.schedule, b.final_price, b.payment_method,
              b.transpo_fee, b.quoted_price, b.created_at,
              so.level_2 AS service_name,
              s.level_1 AS category_name,
              ua.address_one, ua.post_town,
              uc.first_name AS customer_first, uc.last_name AS customer_last
       FROM ${dbSchema}.bookings b
       LEFT JOIN ${dbSchema}.service_options so ON so.id = b.service_option_id
       LEFT JOIN ${dbSchema}.services s ON s.id = so.service_id
       LEFT JOIN ${dbSchema}.user_address ua ON ua.address_id = b.user_address_id
       LEFT JOIN ${dbSchema}.user_credentials uc ON uc.uid = b.user_id
       WHERE ${where.join(' AND ')}
       ORDER BY b.schedule DESC
       LIMIT $${limitP} OFFSET $${offsetP}`,
      params
    ),
    dbQuery.query(
      `SELECT COUNT(*) FROM ${dbSchema}.bookings b WHERE ${where.join(' AND ')}`,
      params.slice(0, -2)
    ),
  ]);

  const rows = rowsRes.rows.map((r: any) => ({
    id: String(r.id),
    bookingCode: `SVN-${String(r.id).padStart(6, '0')}`,
    status: r.status ?? '',
    serviceName: r.service_name ?? '',
    categoryName: r.category_name ?? '',
    customerName: `${r.customer_first ?? ''} ${(r.customer_last ?? '').charAt(0)}.`.trim(),
    addressLine: r.address_one ?? '',
    city: r.post_town ?? '',
    scheduledAt: r.schedule,
    createdAt: r.created_at,
    bookingAmount: Number(r.final_price ?? 0),
    quotedPrice: Number(r.quoted_price ?? 0),
    transpoFee: Number(r.transpo_fee ?? 0),
    paymentMethod: (r.payment_method ?? 'cash').toLowerCase(),
    currency: 'PHP',
  }));

  return { rows, total: Number(countRes.rows[0]?.count ?? 0), page, limit };
};

// ── Performance Metrics ───────────────────────────────────────────────────────

export const getProviderPerformance = async (uid: string) => {
  const res = await dbQuery.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'COMPLETED') AS completed,
       COUNT(*) FILTER (WHERE status = 'CANCELLED') AS cancelled,
       COUNT(*) FILTER (WHERE status IN ('WORKER_ASSIGNED','CONFIRMED','IN_PROGRESS','ACCEPTED')) AS in_progress,
       COUNT(*) AS total,
       COALESCE(SUM(final_price) FILTER (WHERE status = 'COMPLETED'), 0) AS total_gross
     FROM ${dbSchema}.bookings
     WHERE worker_uid = $1`,
    [uid]
  );
  const r = res.rows[0] ?? {};
  const completed = Number(r.completed ?? 0);
  const total = Number(r.total ?? 0);
  return {
    totalJobs: total,
    completedJobs: completed,
    cancelledJobs: Number(r.cancelled ?? 0),
    activeJobs: Number(r.in_progress ?? 0),
    completionRate: total > 0 ? Math.round((completed / total) * 100) : 0,
    totalGross: Number(r.total_gross ?? 0),
    currency: 'PHP',
  };
};

// ── Earnings Summary (admin view — shows gross amounts) ───────────────────────

export const getProviderEarningsSummary = async (uid: string) => {
  const res = await dbQuery.query(
    `SELECT
       COUNT(*) AS total_jobs,
       COALESCE(SUM(final_price), 0) AS total_gross,
       COALESCE(SUM(final_price) FILTER (WHERE DATE_TRUNC('month', schedule) = DATE_TRUNC('month', NOW())), 0) AS this_month_gross
     FROM ${dbSchema}.bookings
     WHERE worker_uid = $1 AND status = 'COMPLETED'`,
    [uid]
  );
  const s = res.rows[0] ?? {};
  const gross = Number(s.total_gross ?? 0);
  const monthGross = Number(s.this_month_gross ?? 0);
  return {
    totalJobs: Number(s.total_jobs ?? 0),
    totalGrossAmount: gross,
    totalProviderShare: Math.round(gross * 0.8 * 100) / 100,
    thisMonthGross: monthGross,
    thisMonthProviderShare: Math.round(monthGross * 0.8 * 100) / 100,
    providerSharePercent: 80,
    currency: 'PHP',
  };
};

// ── Availability ──────────────────────────────────────────────────────────────

export const getProviderAvailability = async (uid: string) => {
  const [avail, timeOff] = await Promise.all([
    technicianService.getWorkerAvailability(uid),
    technicianService.getWorkerTimeOff(uid),
  ]);
  return {
    schedule: avail.schedule ?? [],
    timezone: avail.timezone ?? 'Asia/Manila',
    updatedAt: avail.updated_at ?? null,
    timeOff: timeOff.map((t: any) => ({
      id: t.id,
      startDate: t.start_date,
      endDate: t.end_date,
      reason: t.reason ?? null,
      createdAt: t.created_at,
    })),
  };
};

// ── Service Area ──────────────────────────────────────────────────────────────

export const getProviderServiceArea = async (uid: string) => {
  const area = await technicianService.getWorkerServiceArea(uid);
  return {
    cityIds: area.city_ids ?? [],
    label: area.label ?? null,
    updatedAt: area.updated_at ?? null,
  };
};

// ── Account Status Mutation ───────────────────────────────────────────────────

const VALID_STATUSES = ['active', 'pending', 'suspended', 'rejected', 'deactivated', 'under_review'];

export const updateProviderAccountStatus = async (
  uid: string,
  newStatus: string,
  adminUid: string,
  reason?: string
) => {
  if (!VALID_STATUSES.includes(newStatus)) {
    const err: any = new Error(`Invalid account status: ${newStatus}`);
    err.statusCode = 400;
    throw err;
  }

  const res = await dbQuery.query(
    `UPDATE ${dbSchema}.user_credentials
     SET account_status = $1, updated_at = NOW()
     WHERE uid = $2 AND role IN (2,4)
     RETURNING uid, account_status, role`,
    [newStatus, uid]
  );

  if (!res.rowCount) {
    const err: any = new Error('Provider not found or not a provider role.');
    err.statusCode = 404;
    throw err;
  }

  return res.rows[0];
};

// ── Archive / Restore ─────────────────────────────────────────────────────────

export const setProviderArchive = async (uid: string, isArchive: boolean) => {
  const res = await dbQuery.query(
    `UPDATE ${dbSchema}.user_credentials
     SET is_archive = $1, updated_at = NOW()
     WHERE uid = $2 AND role IN (2,4)
     RETURNING uid, is_archive, role`,
    [isArchive, uid]
  );

  if (!res.rowCount) {
    const err: any = new Error('Provider not found or not a provider role.');
    err.statusCode = 404;
    throw err;
  }

  return res.rows[0];
};

// ── Service Application Approve / Reject (reuses existing service) ────────────

export { serviceApplicationService };
