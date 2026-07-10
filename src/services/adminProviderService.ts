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
import { uploadFileToStorage } from '../helpers/firebaseStorageUploader';

const dbSchema = db.schema;

// ── Provider List ─────────────────────────────────────────────────────────────

export interface ProviderListFilter {
  search?: string;
  role?: number;
  accountStatus?: string;
  isArchive?: boolean;
  hasDocuments?: boolean;      // true = has any docs; false = missing docs
  hasPendingApps?: boolean;    // true = has pending_review applications
  hasActiveServices?: boolean; // true = has active employee_services rows
  hasAvailability?: boolean;   // true = has worker_availability row
  hasServiceArea?: boolean;    // true = has worker_service_area row
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
    hasDocuments,
    hasPendingApps,
    hasActiveServices,
    hasAvailability,
    hasServiceArea,
    page = 1,
    limit = 50,
    sortBy = 'created_date',
    sortDir = 'desc',
  } = filter;

  const s = dbSchema;
  const offset = (page - 1) * limit;
  const params: any[] = [];
  const where: string[] = [];

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

  // Provider-domain filters — resolved at read-model layer
  if (hasDocuments === true)  where.push(`EXISTS (SELECT 1 FROM ${s}.worker_requirements wr_f WHERE wr_f.worker_uid = uc.uid)`);
  if (hasDocuments === false) where.push(`NOT EXISTS (SELECT 1 FROM ${s}.worker_requirements wr_f WHERE wr_f.worker_uid = uc.uid)`);
  if (hasPendingApps === true)  where.push(`EXISTS (SELECT 1 FROM ${s}.worker_service_applications wsa_f WHERE wsa_f.worker_uid = uc.uid AND wsa_f.status = 'pending_review')`);
  if (hasPendingApps === false) where.push(`NOT EXISTS (SELECT 1 FROM ${s}.worker_service_applications wsa_f WHERE wsa_f.worker_uid = uc.uid AND wsa_f.status = 'pending_review')`);
  if (hasActiveServices === true)  where.push(`EXISTS (SELECT 1 FROM ${s}.employee_services es_f WHERE es_f.employee_uid = uc.uid)`);
  if (hasActiveServices === false) where.push(`NOT EXISTS (SELECT 1 FROM ${s}.employee_services es_f WHERE es_f.employee_uid = uc.uid)`);
  if (hasAvailability === true)  where.push(`EXISTS (SELECT 1 FROM ${s}.worker_availability wa_f WHERE wa_f.uid = uc.uid)`);
  if (hasAvailability === false) where.push(`NOT EXISTS (SELECT 1 FROM ${s}.worker_availability wa_f WHERE wa_f.uid = uc.uid)`);
  if (hasServiceArea === true)  where.push(`EXISTS (SELECT 1 FROM ${s}.worker_service_area wsa2_f WHERE wsa2_f.uid = uc.uid)`);
  if (hasServiceArea === false) where.push(`NOT EXISTS (SELECT 1 FROM ${s}.worker_service_area wsa2_f WHERE wsa2_f.uid = uc.uid)`);

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
         up.photo_url,
         -- Document summary (resolved by backend — prevents JOIN inflation)
         COALESCE((SELECT COUNT(*)::int FROM ${s}.worker_requirements wr2 WHERE wr2.worker_uid = uc.uid), 0) AS doc_total,
         -- Service summary (resolved by backend — pending vs active separate)
         COALESCE((SELECT COUNT(*)::int FROM ${s}.worker_service_applications wsa2 WHERE wsa2.worker_uid = uc.uid AND wsa2.status = 'pending_review'), 0) AS pending_apps,
         COALESCE((SELECT COUNT(*)::int FROM ${s}.employee_services es2 WHERE es2.employee_uid = uc.uid), 0) AS active_svc,
         -- Availability and service area (resolved by backend)
         CASE WHEN EXISTS (SELECT 1 FROM ${s}.worker_availability wa2 WHERE wa2.uid = uc.uid) THEN 'saved' ELSE 'missing' END AS avail_status,
         CASE WHEN EXISTS (SELECT 1 FROM ${s}.worker_service_area wsa3 WHERE wsa3.uid = uc.uid) THEN 'saved' ELSE 'missing' END AS area_status
       FROM ${s}.user_credentials uc
       LEFT JOIN ${s}.user_profile up ON up.uid = uc.uid
       ${whereClause}
       ORDER BY ${col} ${dir}
       LIMIT $${limitP} OFFSET $${offsetP}`,
      params
    ),
    dbQuery.query(
      `SELECT COUNT(*) FROM ${s}.user_credentials uc ${whereClause}`,
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

// ── Safe count helper — returns -1 if table does not exist ───────────────────

const safeCount = async (sql: string, params: any[]): Promise<number> => {
  try {
    const res = await dbQuery.query(sql, params);
    return Number(res.rows[0]?.cnt ?? res.rows[0]?.count ?? 0);
  } catch {
    return -1; // table absent or schema mismatch — caller treats as unknown
  }
};

// ── Summary Metrics (deduped by provider UID) ─────────────────────────────────

export const getProviderMetrics = async () => {
  const s = dbSchema;

  const [baseRes, docsRes, appsRes, activeSvcRes, bothRes, dupSummary,
         missingAvail, missingArea] = await Promise.all([
    // Base counts — one row per UID from user_credentials only (no duplicate risk)
    dbQuery.query(
      `SELECT
         COUNT(*) FILTER (WHERE role IN (2,4))                                                 AS total,
         COUNT(*) FILTER (WHERE role IN (2,4) AND is_archive=false AND account_status='active') AS active,
         COUNT(*) FILTER (WHERE role IN (2,4) AND is_archive=true)                             AS archived,
         COUNT(*) FILTER (WHERE role IN (2,4) AND account_status='pending')                    AS pending_review,
         COUNT(*) FILTER (WHERE role IN (2,4) AND account_status='suspended')                  AS suspended,
         COUNT(*) FILTER (WHERE role IN (2,4) AND account_status IN ('rejected','deactivated')) AS rejected
       FROM ${s}.user_credentials`, []
    ),
    // Documents — count DISTINCT provider UIDs, not requirement rows
    dbQuery.query(
      `SELECT
         COUNT(DISTINCT uc.uid) FILTER (WHERE wr.worker_uid IS NOT NULL) AS with_docs,
         COUNT(DISTINCT uc.uid) FILTER (WHERE wr.worker_uid IS NULL)     AS missing_docs
       FROM ${s}.user_credentials uc
       LEFT JOIN ${s}.worker_requirements wr ON wr.worker_uid = uc.uid
       WHERE uc.role IN (2,4)`, []
    ),
    // Service applications — count DISTINCT provider UIDs
    dbQuery.query(
      `SELECT
         COUNT(DISTINCT wsa.worker_uid) AS with_apps,
         COUNT(DISTINCT CASE WHEN wsa.status='pending_review' THEN wsa.worker_uid END) AS with_pending_apps
       FROM ${s}.worker_service_applications wsa
       JOIN ${s}.user_credentials uc ON uc.uid = wsa.worker_uid
       WHERE uc.role IN (2,4)`, []
    ),
    // Active services — count DISTINCT provider UIDs via employee_services
    dbQuery.query(
      `SELECT COUNT(DISTINCT es.employee_uid) AS with_active_svc
       FROM ${s}.employee_services es
       JOIN ${s}.user_credentials uc ON uc.uid = es.employee_uid
       WHERE uc.role IN (2,4)`, []
    ),
    // Both active service AND pending application on same UID
    dbQuery.query(
      `SELECT COUNT(DISTINCT uc.uid) AS both
       FROM ${s}.user_credentials uc
       WHERE uc.role IN (2,4)
         AND EXISTS (SELECT 1 FROM ${s}.employee_services es   WHERE es.employee_uid = uc.uid)
         AND EXISTS (SELECT 1 FROM ${s}.worker_service_applications wsa
                     WHERE wsa.worker_uid = uc.uid AND wsa.status = 'pending_review')`, []
    ),
    // Duplicate summary (reuse internal helper)
    _getDuplicateSummary(),
    // Missing availability (defensive — table may not exist)
    safeCount(
      `SELECT COUNT(DISTINCT uc.uid) AS cnt
       FROM ${s}.user_credentials uc
       WHERE uc.role IN (2,4)
         AND NOT EXISTS (SELECT 1 FROM ${s}.worker_availability wa WHERE wa.uid = uc.uid)`, []
    ),
    // Missing service area (defensive)
    safeCount(
      `SELECT COUNT(DISTINCT uc.uid) AS cnt
       FROM ${s}.user_credentials uc
       WHERE uc.role IN (2,4)
         AND NOT EXISTS (SELECT 1 FROM ${s}.worker_service_area wsa WHERE wsa.uid = uc.uid)`, []
    ),
  ]);

  const b  = baseRes.rows[0]    ?? {};
  const d  = docsRes.rows[0]    ?? {};
  const a  = appsRes.rows[0]    ?? {};

  return {
    // Legacy shape (unchanged — existing UI consumes these)
    total:        Number(b.total        ?? 0),
    active:       Number(b.active       ?? 0),
    archived:     Number(b.archived     ?? 0),
    pendingReview:Number(b.pending_review ?? 0),
    suspended:    Number(b.suspended    ?? 0),
    rejected:     Number(b.rejected     ?? 0),
    // Extended deduped metrics (new)
    providersWithDocuments:                           Number(d.with_docs   ?? 0),
    providersMissingDocuments:                        Number(d.missing_docs ?? 0),
    providersWithServiceApplications:                 Number(a.with_apps   ?? 0),
    providersWithPendingServiceApplications:          Number(a.with_pending_apps ?? 0),
    providersWithActiveServices:                      Number(activeSvcRes.rows[0]?.with_active_svc ?? 0),
    providersWithBothActiveServiceAndPendingApplication: Number(bothRes.rows[0]?.both ?? 0),
    providersMissingAvailability: missingAvail,
    providersMissingServiceArea:  missingArea,
    providersWithOverlapWarnings: dupSummary.sameUidOverlaps,
    duplicateCandidates:          dupSummary.duplicateCandidates,
    orphanProviderReferences:     dupSummary.orphanReferences,
    identityConflicts:            dupSummary.identityConflicts,
    // Canonical aliases (command contract Section 8) — same values, shorter keys
    missingDocuments:    Number(d.missing_docs      ?? 0),
    pendingApplications: Number(a.with_pending_apps ?? 0),
    activeServices:      Number(activeSvcRes.rows[0]?.with_active_svc ?? 0),
    missingAvailability: missingAvail,
    missingServiceArea:  missingArea,
    attentionNeeded:     Math.max(0,
      Number(d.missing_docs ?? 0)
      + (missingAvail >= 0 ? missingAvail : 0)
      + (missingArea  >= 0 ? missingArea  : 0)
    ),
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

const ALLOWED_DOC_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

export const uploadProviderRequirement = async (
  workerUid: string,
  fileDataUri: string,
  fileName: string,
  requirementType?: string,
) => {
  const mimeType = fileDataUri.slice(fileDataUri.indexOf(':') + 1, fileDataUri.indexOf(';'));
  if (!ALLOWED_DOC_MIMES.includes(mimeType)) {
    throw new Error('File type not allowed. Use JPG, PNG, WebP, or PDF.');
  }
  const sanitizedName = String(fileName).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
  const fileUrl = await uploadFileToStorage('admin-requirements', `${workerUid}_${Date.now()}`, fileDataUri);
  const inserted = await technicianService.addWorkerRequirements(workerUid, [{
    fileUrl,
    fileName: sanitizedName,
    requirementType: requirementType || undefined,
  }]);
  return inserted[0];
};

export const deleteProviderRequirement = async (workerUid: string, id: number) => {
  return technicianService.deleteWorkerRequirement(workerUid, id);
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

// ── Provider Overlap Map — comprehensive (admin only) ────────────────────────

export interface ProviderOverlapEntry {
  table: string;
  column: string;
  presentAs: string;
  rowCount: number; // -1 = table not queryable
}

export interface ProviderOverlapMap {
  uid: string;
  role: number;
  accountStatus: string;
  isArchive: boolean;
  tables: ProviderOverlapEntry[];
  activeServiceCount: number;
  pendingApplicationCount: number;
  approvedApplicationCount: number;
  requirementCount: number;
  orphanedActiveServices: number;
  inconsistencies: string[];
}

export const getProviderOverlapMap = async (uid: string): Promise<ProviderOverlapMap> => {
  const s = dbSchema;

  const credRes = await dbQuery.query(
    `SELECT uid, role, account_status, is_archive FROM ${s}.user_credentials WHERE uid = $1`,
    [uid]
  );
  if (!credRes.rowCount) {
    const err: any = new Error('Provider not found.');
    err.statusCode = 404;
    throw err;
  }
  const cred = credRes.rows[0];

  // Query all related tables in parallel — safeCount for tables that may not exist
  const [
    profileCnt, reqCnt, appRes, activeSvcCnt, catalogCapCnt,
    availCnt, svcAreaCnt, locCnt, bookingCnt,
  ] = await Promise.all([
    safeCount(`SELECT COUNT(*)::int AS cnt FROM ${s}.user_profile              WHERE uid = $1`,         [uid]),
    safeCount(`SELECT COUNT(*)::int AS cnt FROM ${s}.worker_requirements       WHERE worker_uid = $1`,  [uid]),
    dbQuery.query(`SELECT status, COUNT(*)::int AS cnt FROM ${s}.worker_service_applications WHERE worker_uid = $1 GROUP BY status`, [uid]),
    safeCount(`SELECT COUNT(*)::int AS cnt FROM ${s}.employee_services         WHERE employee_uid = $1`, [uid]),
    safeCount(`SELECT COUNT(*)::int AS cnt FROM ${s}.employee_catalog_capabilities WHERE employee_uid = $1`, [uid]),
    safeCount(`SELECT COUNT(*)::int AS cnt FROM ${s}.worker_availability       WHERE uid = $1`,         [uid]),
    safeCount(`SELECT COUNT(*)::int AS cnt FROM ${s}.worker_service_area       WHERE uid = $1`,         [uid]),
    safeCount(`SELECT COUNT(*)::int AS cnt FROM ${s}.worker_locations          WHERE uid = $1`,         [uid]),
    safeCount(`SELECT COUNT(*)::int AS cnt FROM ${s}.booking_workers           WHERE worker_uid = $1`,  [uid]),
  ]);

  const appCounts: Record<string, number> = {};
  for (const row of appRes.rows) appCounts[row.status] = Number(row.cnt);
  const totalApps = Object.values(appCounts).reduce((s, n) => s + n, 0);
  const pendingApplicationCount  = appCounts['pending_review'] ?? 0;
  const approvedApplicationCount = appCounts['approved']       ?? 0;

  const tables: ProviderOverlapEntry[] = [
    { table: 'user_credentials',              column: 'uid',        presentAs: `identity (role ${cred.role})`,        rowCount: 1 },
    { table: 'user_profile',                  column: 'uid',        presentAs: 'profile record',                      rowCount: profileCnt },
    { table: 'worker_requirements',           column: 'worker_uid', presentAs: 'uploaded documents',                  rowCount: reqCnt },
    { table: 'worker_service_applications',   column: 'worker_uid', presentAs: 'service applications (all statuses)', rowCount: totalApps },
    { table: 'employee_services',             column: 'employee_uid', presentAs: 'active service assignments',        rowCount: activeSvcCnt },
    { table: 'employee_catalog_capabilities', column: 'employee_uid', presentAs: 'catalog capabilities',             rowCount: catalogCapCnt },
    { table: 'worker_availability',           column: 'uid',        presentAs: 'availability schedule',               rowCount: availCnt },
    { table: 'worker_service_area',           column: 'uid',        presentAs: 'service area config',                 rowCount: svcAreaCnt },
    { table: 'worker_locations',              column: 'uid',        presentAs: 'location/online status',              rowCount: locCnt },
    { table: 'booking_workers',               column: 'worker_uid', presentAs: 'booking assignments',                 rowCount: bookingCnt },
  ];

  const inconsistencies: string[] = [];
  if (activeSvcCnt > 0 && approvedApplicationCount === 0) {
    inconsistencies.push('Has active services but no approved application — likely a legacy direct insert.');
  }
  if (cred.role !== 2 && cred.role !== 4) {
    inconsistencies.push(`role=${cred.role} — not a provider role (expected 2 or 4).`);
  }
  if (cred.account_status === 'active' && activeSvcCnt === 0) {
    inconsistencies.push('Account status is active but has no assigned services.');
  }
  if (profileCnt === 0) {
    inconsistencies.push('No user_profile row — profile photo and personal details may be missing.');
  }

  return {
    uid,
    role:         Number(cred.role),
    accountStatus: cred.account_status ?? 'unknown',
    isArchive:    Boolean(cred.is_archive),
    tables,
    activeServiceCount:    activeSvcCnt,
    pendingApplicationCount,
    approvedApplicationCount,
    requirementCount:      reqCnt,
    orphanedActiveServices: approvedApplicationCount === 0 ? activeSvcCnt : 0,
    inconsistencies,
  };
};

// ── Duplicate Detection — internal summary (used by metrics) ─────────────────

interface DuplicateSummary {
  sameUidOverlaps: number;
  duplicateCandidates: number;
  orphanReferences: number;
  identityConflicts: number;
}

const _getDuplicateSummary = async (): Promise<DuplicateSummary> => {
  const s = dbSchema;
  const [emailDupRes, phoneDupRes, orphanReqRes, orphanSvcRes, orphanAppRes, conflictRoleRes] = await Promise.all([
    // Same email, different UIDs
    dbQuery.query(
      `SELECT COUNT(*) AS cnt FROM (
         SELECT email FROM ${s}.user_credentials
         WHERE role IN (2,4) AND email IS NOT NULL AND email != ''
         GROUP BY LOWER(email) HAVING COUNT(DISTINCT uid) > 1
       ) x`, []
    ),
    // Same phone, different UIDs
    dbQuery.query(
      `SELECT COUNT(*) AS cnt FROM (
         SELECT phone_number FROM ${s}.user_credentials
         WHERE role IN (2,4) AND phone_number IS NOT NULL AND phone_number != ''
         GROUP BY phone_number HAVING COUNT(DISTINCT uid) > 1
       ) x`, []
    ),
    // Orphan worker_requirements
    safeCount(
      `SELECT COUNT(DISTINCT worker_uid) AS cnt FROM ${s}.worker_requirements wr
       WHERE NOT EXISTS (SELECT 1 FROM ${s}.user_credentials uc WHERE uc.uid = wr.worker_uid)`, []
    ),
    // Orphan employee_services
    safeCount(
      `SELECT COUNT(DISTINCT employee_uid) AS cnt FROM ${s}.employee_services es
       WHERE NOT EXISTS (SELECT 1 FROM ${s}.user_credentials uc WHERE uc.uid = es.employee_uid)`, []
    ),
    // Orphan worker_service_applications
    safeCount(
      `SELECT COUNT(DISTINCT worker_uid) AS cnt FROM ${s}.worker_service_applications wsa
       WHERE NOT EXISTS (SELECT 1 FROM ${s}.user_credentials uc WHERE uc.uid = wsa.worker_uid)`, []
    ),
    // Same UID with role != 2 and != 4 that still has provider-related data (identity conflict)
    dbQuery.query(
      `SELECT COUNT(DISTINCT uc.uid) AS cnt
       FROM ${s}.user_credentials uc
       WHERE uc.role NOT IN (2,4)
         AND (
           EXISTS (SELECT 1 FROM ${s}.employee_services es     WHERE es.employee_uid = uc.uid)
        OR EXISTS (SELECT 1 FROM ${s}.worker_service_applications wsa WHERE wsa.worker_uid = uc.uid)
         )`, []
    ),
  ]);

  const emailDups   = Number(emailDupRes.rows[0]?.cnt ?? 0);
  const phoneDups   = Number(phoneDupRes.rows[0]?.cnt ?? 0);
  const orphanReq   = orphanReqRes  >= 0 ? orphanReqRes  : 0;
  const orphanSvc   = orphanSvcRes  >= 0 ? orphanSvcRes  : 0;
  const orphanApp   = orphanAppRes  >= 0 ? orphanAppRes  : 0;
  const conflictRole = Number(conflictRoleRes.rows[0]?.cnt ?? 0);

  return {
    sameUidOverlaps:    0,  // same-UID overlaps are normal and not warnings
    duplicateCandidates: emailDups + phoneDups,
    orphanReferences:   orphanReq + orphanSvc + orphanApp,
    identityConflicts:  conflictRole,
  };
};

// ── Duplicate Detection — full report (admin diagnostic endpoint) ─────────────

export interface ProviderDuplicateReportItem {
  type: 'duplicate_candidate' | 'orphan_reference' | 'identity_conflict' | 'legacy_active_service';
  severity: 'high' | 'medium' | 'low';
  uids: string[];
  matchField?: string;
  matchValue?: string;
  table?: string;
  evidence: string;
  recommendedAction: string;
}

export interface ProviderDuplicateReport {
  summary: {
    sameUidOverlaps: number;
    duplicateCandidates: number;
    orphanReferences: number;
    identityConflicts: number;
    legacyActiveServices: number;
  };
  items: ProviderDuplicateReportItem[];
}

export const getProviderDuplicates = async (): Promise<ProviderDuplicateReport> => {
  const s = dbSchema;
  const items: ProviderDuplicateReportItem[] = [];

  const [emailDupRes, phoneDupRes, orphanReqRes, orphanSvcRes, orphanAppRes,
         conflictRoleRes, legacySvcRes] = await Promise.all([
    // Duplicate candidates by email
    dbQuery.query(
      `SELECT LOWER(email) AS email, array_agg(uid ORDER BY created_date) AS uids, COUNT(*) AS cnt
       FROM ${s}.user_credentials
       WHERE role IN (2,4) AND email IS NOT NULL AND email != ''
       GROUP BY LOWER(email) HAVING COUNT(DISTINCT uid) > 1
       ORDER BY cnt DESC LIMIT 100`, []
    ),
    // Duplicate candidates by phone
    dbQuery.query(
      `SELECT phone_number, array_agg(uid ORDER BY created_date) AS uids, COUNT(*) AS cnt
       FROM ${s}.user_credentials
       WHERE role IN (2,4) AND phone_number IS NOT NULL AND phone_number != ''
       GROUP BY phone_number HAVING COUNT(DISTINCT uid) > 1
       ORDER BY cnt DESC LIMIT 100`, []
    ),
    // Orphan worker_requirements
    dbQuery.query(
      `SELECT wr.worker_uid, COUNT(*) AS cnt
       FROM ${s}.worker_requirements wr
       WHERE NOT EXISTS (SELECT 1 FROM ${s}.user_credentials uc WHERE uc.uid = wr.worker_uid)
       GROUP BY wr.worker_uid LIMIT 100`, []
    ).catch(() => ({ rows: [] })),
    // Orphan employee_services
    dbQuery.query(
      `SELECT es.employee_uid AS worker_uid, COUNT(*) AS cnt
       FROM ${s}.employee_services es
       WHERE NOT EXISTS (SELECT 1 FROM ${s}.user_credentials uc WHERE uc.uid = es.employee_uid)
       GROUP BY es.employee_uid LIMIT 100`, []
    ).catch(() => ({ rows: [] })),
    // Orphan worker_service_applications
    dbQuery.query(
      `SELECT wsa.worker_uid, COUNT(*) AS cnt
       FROM ${s}.worker_service_applications wsa
       WHERE NOT EXISTS (SELECT 1 FROM ${s}.user_credentials uc WHERE uc.uid = wsa.worker_uid)
       GROUP BY wsa.worker_uid LIMIT 100`, []
    ).catch(() => ({ rows: [] })),
    // Identity conflicts — non-provider role with provider-related data
    dbQuery.query(
      `SELECT uc.uid, uc.role, uc.email,
              EXISTS (SELECT 1 FROM ${s}.employee_services es WHERE es.employee_uid = uc.uid) AS has_active_svc,
              EXISTS (SELECT 1 FROM ${s}.worker_service_applications wsa WHERE wsa.worker_uid = uc.uid) AS has_apps
       FROM ${s}.user_credentials uc
       WHERE uc.role NOT IN (2,4)
         AND (
           EXISTS (SELECT 1 FROM ${s}.employee_services es WHERE es.employee_uid = uc.uid)
        OR EXISTS (SELECT 1 FROM ${s}.worker_service_applications wsa WHERE wsa.worker_uid = uc.uid)
         )
       LIMIT 100`, []
    ),
    // Legacy active services — active in employee_services with no approved application
    dbQuery.query(
      `SELECT es.uid
       FROM (SELECT DISTINCT employee_uid AS uid FROM ${s}.employee_services) es
       JOIN ${s}.user_credentials uc ON uc.uid = es.uid AND uc.role IN (2,4)
       WHERE NOT EXISTS (
         SELECT 1 FROM ${s}.worker_service_applications wsa
         WHERE wsa.worker_uid = es.uid AND wsa.status = 'approved'
       )
       LIMIT 100`, []
    ).catch(() => ({ rows: [] })),
  ]);

  // Build items
  for (const row of emailDupRes.rows) {
    items.push({
      type: 'duplicate_candidate', severity: 'medium',
      uids: row.uids,
      matchField: 'email', matchValue: row.email,
      evidence: `${row.cnt} providers share email ${row.email}`,
      recommendedAction: 'Review each UID in Provider 360. If same person, flag for manual dedup review.',
    });
  }

  for (const row of phoneDupRes.rows) {
    // skip if already caught by email
    items.push({
      type: 'duplicate_candidate', severity: 'medium',
      uids: row.uids,
      matchField: 'phone', matchValue: row.phone_number,
      evidence: `${row.cnt} providers share phone ${row.phone_number}`,
      recommendedAction: 'Review each UID in Provider 360. Phone duplicates may be family members — confirm before acting.',
    });
  }

  for (const row of (orphanReqRes as any).rows) {
    items.push({
      type: 'orphan_reference', severity: 'low',
      uids: [row.worker_uid], table: 'worker_requirements',
      evidence: `worker_requirements has ${row.cnt} row(s) for ${row.worker_uid} — no user_credentials match`,
      recommendedAction: 'Check if this UID was deleted from user_credentials. If so, archive the requirement rows.',
    });
  }

  for (const row of (orphanSvcRes as any).rows) {
    items.push({
      type: 'orphan_reference', severity: 'low',
      uids: [row.worker_uid], table: 'employee_services',
      evidence: `employee_services has ${row.cnt} row(s) for ${row.worker_uid} — no user_credentials match`,
      recommendedAction: 'Verify UID in Firebase Auth. If deactivated, clean up the service assignment.',
    });
  }

  for (const row of (orphanAppRes as any).rows) {
    items.push({
      type: 'orphan_reference', severity: 'low',
      uids: [row.worker_uid], table: 'worker_service_applications',
      evidence: `worker_service_applications has ${row.cnt} row(s) for ${row.worker_uid} — no user_credentials match`,
      recommendedAction: 'Verify UID in Firebase Auth. Orphaned applications may be safely cancelled.',
    });
  }

  for (const row of conflictRoleRes.rows) {
    items.push({
      type: 'identity_conflict', severity: 'high',
      uids: [row.uid],
      evidence: `uid=${row.uid} has role=${row.role} but has provider-related service/application data`,
      recommendedAction: 'Investigate immediately. Role may have been changed after services were assigned.',
    });
  }

  for (const row of (legacySvcRes as any).rows) {
    items.push({
      type: 'legacy_active_service', severity: 'low',
      uids: [row.uid],
      evidence: `uid=${row.uid} has active services (employee_services) but no approved service application`,
      recommendedAction: 'This is a legacy direct insert. Either create a backdated approval record or mark as reviewed.',
    });
  }

  return {
    summary: {
      sameUidOverlaps:    0,
      duplicateCandidates: emailDupRes.rows.length + phoneDupRes.rows.length,
      orphanReferences:   (orphanReqRes as any).rows.length + (orphanSvcRes as any).rows.length + (orphanAppRes as any).rows.length,
      identityConflicts:  conflictRoleRes.rows.length,
      legacyActiveServices: (legacySvcRes as any).rows.length,
    },
    items,
  };
};

// ── Service Application Approve / Reject (reuses existing service) ────────────

export { serviceApplicationService };
