/**
 * Admin Provider Service — read model for the Provider 360 admin workspace.
 *
 * All queries are additive read-only projections. No existing table is modified
 * by this module. Financial figures are gross booking amounts — disbursement
 * breakdowns are shown to role=1 admins only.
 */

import { createHash, randomUUID } from 'crypto';
import dbQuery, { pool } from '../db/dbQuery';
import { providerShareOf, PROVIDER_SHARE_PERCENT } from './revenueSplit';
import { db } from '../config';
import mongoDb from '../db/mongodbQuery';
import * as serviceApplicationService from './serviceApplicationService';
import * as technicianService from './technicianService';
import * as onboardingService from './adminOnboardingService';
import { validateDataUri } from '../helpers/fileSignature';
import { stripImageMetadata } from '../helpers/stripImageMetadata';
import { assertCleanScan, scanProviderFile } from './providerManagedFileScanner';

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
  hasAutoOnline?: boolean;     // true = auto-online active
  hasBookable?: boolean;       // true = bookable via auto-online
  page?: number;
  limit?: number;
  sortBy?: 'name' | 'created_date' | 'account_status' | 'last_active_at';
  sortDir?: 'asc' | 'desc';
}

// ── Provider activity tracking ────────────────────────────────────────────────

// `user_credentials.last_activity_at` used to be added here at runtime by
// `ensureLastActivityColumn`, awaited by both operations below. It comes from
// `scripts/baseline/000-baseline.sql` now (TAB 02). Nullable with no default: a
// provider who has never been seen reads as NULL rather than as active, which is
// what `listProviders` sorts on.

export const touchProviderActivity = async (workerUid: string): Promise<void> => {
  if (!workerUid) return;
  try {
    await dbQuery.query(
      `UPDATE ${db.schema}.user_credentials SET last_activity_at = NOW() WHERE uid = $1`,
      [workerUid]
    );
  } catch {
    // Non-blocking — swallow silently so callers never throw
  }
};

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
    hasAutoOnline,
    hasBookable,
    page = 1,
    limit = 50,
    sortBy = 'created_date',
    sortDir = 'desc',
  } = filter;

  const s = dbSchema;
  const offset = (page - 1) * limit;
  const params: any[] = [];
  const where: string[] = [];

  where.push(`uc.role::int IN (2, 4)`);

  if (search) {
    // Escape SQL LIKE wildcards so user input is treated as literal text
    const safe = search.toLowerCase().replace(/[%_]/g, '\\$&');
    params.push(`%${safe}%`);
    const p = params.length;
    where.push(
      `(LOWER(COALESCE(uc.first_name,'') || ' ' || COALESCE(uc.last_name,'')) LIKE $${p} ESCAPE '\\' ` +
      `OR LOWER(COALESCE(uc.email,'')) LIKE $${p} ESCAPE '\\' ` +
      `OR COALESCE(uc.phone_number,'') LIKE $${p} ESCAPE '\\' ` +
      `OR LOWER(uc.uid) LIKE $${p} ESCAPE '\\')`
    );
  }

  if (role !== undefined && role !== null) {
    params.push(role);
    where.push(`uc.role::int = $${params.length}`);
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
  if (hasAvailability === true)  where.push(`EXISTS (SELECT 1 FROM ${s}.worker_availability wa_f WHERE wa_f.worker_uid = uc.uid)`);
  if (hasAvailability === false) where.push(`NOT EXISTS (SELECT 1 FROM ${s}.worker_availability wa_f WHERE wa_f.worker_uid = uc.uid)`);
  if (hasServiceArea === true)  where.push(`EXISTS (SELECT 1 FROM ${s}.worker_service_areas wsa2_f WHERE wsa2_f.worker_uid = uc.uid)`);
  // false = provider has an explicitly saved but broken city-mode config (empty city_ids)
  // No row = all-cities default = valid, NOT flagged as missing
  if (hasServiceArea === false) where.push(`EXISTS (SELECT 1 FROM ${s}.worker_service_areas wsa2_f WHERE wsa2_f.worker_uid = uc.uid AND wsa2_f.coverage_mode = 'city' AND (wsa2_f.city_ids IS NULL OR wsa2_f.city_ids = '[]'::jsonb))`);
  if (hasAutoOnline === true)  where.push(`EXISTS (SELECT 1 FROM ${s}.provider_auto_online_state paos_f WHERE paos_f.provider_uid = uc.uid AND paos_f.is_auto_online = TRUE)`);
  if (hasAutoOnline === false) where.push(`(NOT EXISTS (SELECT 1 FROM ${s}.provider_auto_online_state paos_f WHERE paos_f.provider_uid = uc.uid) OR EXISTS (SELECT 1 FROM ${s}.provider_auto_online_state paos_f2 WHERE paos_f2.provider_uid = uc.uid AND paos_f2.is_auto_online = FALSE))`);
  if (hasBookable === true)  where.push(`EXISTS (SELECT 1 FROM ${s}.provider_auto_online_state paos_b WHERE paos_b.provider_uid = uc.uid AND paos_b.is_bookable = TRUE)`);
  if (hasBookable === false) where.push(`(NOT EXISTS (SELECT 1 FROM ${s}.provider_auto_online_state paos_b WHERE paos_b.provider_uid = uc.uid) OR EXISTS (SELECT 1 FROM ${s}.provider_auto_online_state paos_b2 WHERE paos_b2.provider_uid = uc.uid AND paos_b2.is_bookable = FALSE))`);

  const sortColumn: Record<string, string> = {
    name: `uc.first_name`,
    created_date: `uc.created_date`,
    account_status: `uc.account_status`,
    last_active_at: `uc.last_activity_at`,
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
         uc.last_activity_at,
         up.photo_url,
         -- Document summary (resolved by backend)
         COALESCE((SELECT COUNT(*)::int FROM ${s}.worker_requirements wr2 WHERE wr2.worker_uid = uc.uid), 0) AS doc_total,
         -- Service summary (resolved by backend — keeps pending vs active separate)
         COALESCE((SELECT COUNT(*)::int FROM ${s}.worker_service_applications wsa2 WHERE wsa2.worker_uid = uc.uid AND wsa2.status = 'pending_review'), 0) AS pending_apps,
         COALESCE((SELECT COUNT(*)::int FROM ${s}.employee_services es2 WHERE es2.employee_uid = uc.uid), 0) AS active_svc,
         -- Availability and service area (resolved by backend)
         CASE WHEN EXISTS (SELECT 1 FROM ${s}.worker_availability wa2 WHERE wa2.worker_uid = uc.uid) THEN 'saved' ELSE 'missing' END AS avail_status,
         CASE WHEN EXISTS (SELECT 1 FROM ${s}.worker_service_areas wsa3 WHERE wsa3.worker_uid = uc.uid) THEN 'saved' ELSE 'default_all' END AS area_status,
         -- Auto-Online Engine fields
         COALESCE(paos.is_auto_online, FALSE) AS is_auto_online,
         COALESCE(paos.is_bookable, FALSE) AS is_bookable,
         paos.activation_mode
       FROM ${s}.user_credentials uc
       LEFT JOIN ${s}.user_profile up ON up.uid = uc.uid
       LEFT JOIN ${s}.provider_auto_online_state paos ON paos.provider_uid = uc.uid
       ${whereClause}
       ORDER BY ${col} ${dir} NULLS LAST, uc.uid ASC
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

  const [baseRes, docsRes, appsRes, activeSvcRes, bothRes,
         missingAvail, missingArea] = await Promise.all([
    // Base counts — distinct UIDs from user_credentials only
    dbQuery.query(
      `SELECT
         COUNT(*) FILTER (WHERE role::int IN (2,4))                                                 AS total,
         COUNT(*) FILTER (WHERE role::int IN (2,4) AND is_archive=false AND account_status='active') AS active,
         COUNT(*) FILTER (WHERE role::int IN (2,4) AND is_archive=true)                             AS archived,
         COUNT(*) FILTER (WHERE role::int IN (2,4) AND account_status='pending')                    AS pending_review,
         COUNT(*) FILTER (WHERE role::int IN (2,4) AND account_status='suspended')                  AS suspended,
         COUNT(*) FILTER (WHERE role::int IN (2,4) AND account_status IN ('rejected','deactivated')) AS rejected
       FROM ${s}.user_credentials`, []
    ),
    // Documents — count DISTINCT provider UIDs, not requirement rows
    dbQuery.query(
      `SELECT
         COUNT(DISTINCT uc.uid) FILTER (WHERE wr.worker_uid IS NOT NULL) AS with_docs,
         COUNT(DISTINCT uc.uid) FILTER (WHERE wr.worker_uid IS NULL)     AS missing_docs
       FROM ${s}.user_credentials uc
       LEFT JOIN ${s}.worker_requirements wr ON wr.worker_uid = uc.uid
       WHERE uc.role::int IN (2,4)`, []
    ),
    // Service applications — count DISTINCT provider UIDs
    dbQuery.query(
      `SELECT
         COUNT(DISTINCT wsa.worker_uid) AS with_apps,
         COUNT(DISTINCT CASE WHEN wsa.status='pending_review' THEN wsa.worker_uid END) AS with_pending_apps
       FROM ${s}.worker_service_applications wsa
       JOIN ${s}.user_credentials uc ON uc.uid = wsa.worker_uid
       WHERE uc.role::int IN (2,4)`, []
    ),
    // Active services — count DISTINCT provider UIDs via employee_services
    dbQuery.query(
      `SELECT COUNT(DISTINCT es.employee_uid) AS with_active_svc
       FROM ${s}.employee_services es
       JOIN ${s}.user_credentials uc ON uc.uid = es.employee_uid
       WHERE uc.role::int IN (2,4)`, []
    ),
    // Both active service AND pending application on same UID
    dbQuery.query(
      `SELECT COUNT(DISTINCT uc.uid) AS both
       FROM ${s}.user_credentials uc
       WHERE uc.role::int IN (2,4)
         AND EXISTS (SELECT 1 FROM ${s}.employee_services es   WHERE es.employee_uid = uc.uid)
         AND EXISTS (SELECT 1 FROM ${s}.worker_service_applications wsa
                     WHERE wsa.worker_uid = uc.uid AND wsa.status = 'pending_review')`, []
    ),
    // Missing availability (defensive — table may not exist)
    safeCount(
      `SELECT COUNT(DISTINCT uc.uid) AS cnt
       FROM ${s}.user_credentials uc
       WHERE uc.role::int IN (2,4)
         AND NOT EXISTS (SELECT 1 FROM ${s}.worker_availability wa WHERE wa.worker_uid = uc.uid)`, []
    ),
    // Missing service area (defensive)
    safeCount(
      `SELECT COUNT(DISTINCT uc.uid) AS cnt
       FROM ${s}.user_credentials uc
       WHERE uc.role::int IN (2,4)
         AND EXISTS (
           SELECT 1 FROM ${s}.worker_service_areas wsa
           WHERE wsa.worker_uid = uc.uid
             AND wsa.coverage_mode = 'city'
             AND (wsa.city_ids IS NULL OR wsa.city_ids = '[]'::jsonb)
         )`, []
    ),
  ]);

  const b  = baseRes.rows[0]    ?? {};
  const d  = docsRes.rows[0]    ?? {};
  const a  = appsRes.rows[0]    ?? {};

  return {
    total:        Number(b.total          ?? 0),
    active:       Number(b.active         ?? 0),
    archived:     Number(b.archived       ?? 0),
    pendingReview:Number(b.pending_review ?? 0),
    suspended:    Number(b.suspended      ?? 0),
    rejected:     Number(b.rejected       ?? 0),
    // Extended deduped metrics
    providersWithDocuments:                              Number(d.with_docs        ?? 0),
    providersMissingDocuments:                           Number(d.missing_docs     ?? 0),
    providersWithServiceApplications:                    Number(a.with_apps        ?? 0),
    providersWithPendingServiceApplications:             Number(a.with_pending_apps ?? 0),
    providersWithActiveServices:                         Number(activeSvcRes.rows[0]?.with_active_svc ?? 0),
    providersWithBothActiveServiceAndPendingApplication: Number(bothRes.rows[0]?.both ?? 0),
    providersMissingAvailability: missingAvail,
    providersMissingServiceArea:  missingArea,
  };
};

// ── Provider 360 Detail ───────────────────────────────────────────────────────

export const getProviderIdentity = async (uid: string) => {
  const [credRes, profileRes, addrRes, locationDoc, availPgRes] = await Promise.all([
    dbQuery.query(
      `SELECT uid, email, first_name, last_name, phone_number, role,
              account_status, is_archive, is_email_verified, created_date
       FROM ${dbSchema}.user_credentials WHERE uid = $1 AND role::int IN (2,4) LIMIT 1`,
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
    dbQuery.query(
      `SELECT availability_source, changed_by_uid, changed_by_role, changed_at, reason
       FROM ${dbSchema}.provider_operational_availability
       WHERE provider_uid = $1`,
      [uid]
    ).catch(() => ({ rows: [] as any[] })),
  ]);

  if (!credRes.rowCount) return null;

  const cred = credRes.rows[0];
  const profile = profileRes.rows[0] ?? {};
  const addr = addrRes.rows[0] ?? {};
  const avail = availPgRes.rows.length > 0 ? availPgRes.rows[0] : null;

  return {
    uid: cred.uid,
    email: cred.email,
    firstName: cred.first_name,
    lastName: cred.last_name,
    fullName: `${cred.first_name ?? ''} ${cred.last_name ?? ''}`.trim() || cred.email,
    phoneNumber: cred.phone_number,
    role: Number(cred.role),
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
    availabilitySource: avail ? avail.availability_source : null,
    availabilityChangedAt: avail ? avail.changed_at : null,
    availabilityChangedByUid: avail ? avail.changed_by_uid : null,
    availabilityChangedByRole: avail ? avail.changed_by_role : null,
    availabilityReason: avail ? avail.reason : null,
  };
};

// ── Active Services (employee_services) ───────────────────────────────────────

export const getProviderActiveServices = async (uid: string) => {
  const res = await dbQuery.query(
    `SELECT es.service_id, es.created_at,
            '' AS category, s.name AS service_name
     FROM ${dbSchema}.employee_services es
     LEFT JOIN ${dbSchema}.service_families s ON s.id = es.service_id
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
            '' AS category, s.name AS service_name,
            rev.first_name AS reviewer_first, rev.last_name AS reviewer_last
     FROM ${dbSchema}.worker_service_applications wsa
     LEFT JOIN ${dbSchema}.service_families s ON s.id = wsa.service_id
     LEFT JOIN ${dbSchema}.user_credentials rev ON rev.uid = wsa.reviewed_by
     WHERE wsa.worker_uid = $1
     ORDER BY wsa.submitted_at DESC`,
    [uid]
  );
  return res.rows.map((r: any) => ({
    id: String(r.id),
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
            s.name AS category, ecc.level_2 AS service_name
     FROM ${dbSchema}.employee_catalog_capabilities ecc
     LEFT JOIN ${dbSchema}.provider_catalog_offerings pco ON pco.id = ecc.offering_id
     LEFT JOIN ${dbSchema}.service_families s ON s.id = ecc.service_id
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
    `SELECT wr.id, wr.file_url, wr.storage_path, wr.file_name, wr.uploaded_at, wr.requirement_type,
            wr.mime_type, wr.byte_size, wr.lifecycle_state, wr.scan_status,
            wr.issue_date, wr.expires_at, wr.identifier_mask, wr.version,
            COALESCE(ld.decision, 'pending_review')          AS current_decision,
            ld.reason_code,
            ld.provider_message,
            ld.internal_rationale                             AS internal_note,
            ld.reviewer_uid,
            ld.decided_at                                     AS reviewed_at,
            ld.id                                             AS decision_id
     FROM ${dbSchema}.worker_requirements wr
     LEFT JOIN LATERAL (
       SELECT decision, reason_code, provider_message, internal_rationale,
              reviewer_uid, decided_at, id
       FROM ${dbSchema}.provider_requirement_decisions
       WHERE worker_requirement_id = wr.id AND NOT is_superseded
       ORDER BY decided_at DESC LIMIT 1
     ) ld ON true
     WHERE wr.worker_uid = $1
     ORDER BY wr.uploaded_at DESC`,
    [uid]
  ).catch((err: any) => {
    if (err?.code !== '42P01' && err?.code !== '42703') throw err;
    return dbQuery.query(
      `SELECT id, file_url, file_name, uploaded_at, requirement_type FROM ${dbSchema}.worker_requirements WHERE worker_uid = $1 ORDER BY uploaded_at DESC`,
      [uid]
    );
  });
  return res.rows.map((r: any) => ({
    id: r.id,
    fileName: r.file_name,
    // Canonical private rows never leak signed URLs through list responses.
    // Legacy rows keep their compatibility URL until the controlled backfill.
    fileUrl: r.storage_path ? null : r.file_url,
    previewExpiresAt: null,
    previewAvailable: Boolean(r.storage_path || r.file_url),
    legacyStorage: !r.storage_path,
    uploadedAt: r.uploaded_at,
    requirementType: r.requirement_type ?? null,
    mimeType: r.mime_type ?? null,
    byteSize: r.byte_size == null ? null : Number(r.byte_size),
    lifecycleState: r.lifecycle_state ?? 'legacy_review_required',
    scanState: r.scan_status ?? 'legacy_review_required',
    issueDate: r.issue_date ?? null,
    expiresAt: r.expires_at ?? null,
    identifierMask: r.identifier_mask ?? null,
    version: Number(r.version ?? 1),
    currentDecision: r.current_decision ?? 'pending_review',
    reasonCode: r.reason_code ?? null,
    providerMessage: r.provider_message ?? null,
    internalNote: r.internal_note ?? null,
    reviewerUid: r.reviewer_uid ?? null,
    reviewedAt: r.reviewed_at ?? null,
    decisionId: r.decision_id ?? null,
  }));
};

export const getProviderRequirementPreview = async (uid: string, id: number) => {
  const found = await dbQuery.query(
    `SELECT id, storage_path, file_url, file_name, mime_type
     FROM ${dbSchema}.worker_requirements
     WHERE id = $1 AND worker_uid = $2 LIMIT 1`,
    [id, uid],
  );
  if (!found.rowCount) {
    throw Object.assign(new Error('Provider document not found'), { statusCode: 404 });
  }
  const row = found.rows[0];
  if (row.storage_path) {
    const { createPrivatePreviewUrl } = await import('../helpers/firebaseStorageUploader');
    return {
      documentId: String(row.id),
      fileName: row.file_name,
      mimeType: row.mime_type ?? null,
      legacyStorage: false,
      ...(await createPrivatePreviewUrl(row.storage_path, 300)),
    };
  }
  if (!String(row.file_url ?? '').startsWith('https://')) {
    throw Object.assign(new Error('This legacy document must be re-uploaded before preview is available'), {
      statusCode: 409,
      code: 'LEGACY_DOCUMENT_REUPLOAD_REQUIRED',
    });
  }
  return {
    documentId: String(row.id),
    fileName: row.file_name,
    mimeType: row.mime_type ?? null,
    legacyStorage: true,
    url: row.file_url,
    expiresAt: null,
  };
};

const ALLOWED_DOC_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

export const uploadProviderRequirement = async (
  workerUid: string,
  fileDataUri: string,
  fileName: string,
  requirementType?: string,
) => {
  const validation = validateDataUri(fileDataUri, {
    allowed: ALLOWED_DOC_MIMES as any,
    maxBytes: 10 * 1024 * 1024,
  });
  if (!validation.ok) throw Object.assign(new Error(validation.message), { statusCode: 422, code: validation.code });
  const sanitizedName = String(fileName).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
  const sanitizedType = String(requirementType ?? 'admin_supplied').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
  const scan = await scanProviderFile({ buffer: validation.buffer, mimeType: validation.mime, fileName: sanitizedName });
  assertCleanScan(scan);
  // §58, same as the provider self-upload path: strip EXIF/GPS before the file
  // is persisted. An admin uploading on behalf of a provider is handling a
  // photograph the provider took, so it carries the same location metadata.
  const persistenceBuffer = stripImageMetadata(scan.sanitizedBuffer ?? validation.buffer, validation.mime);
  const persistenceDataUri = `data:${validation.mime};base64,${persistenceBuffer.toString('base64')}`;
  const requestId = `admin-document-${randomUUID()}`;
  const storage = await import('../helpers/firebaseStorageUploader');
  const stored = await storage.uploadPrivateFileToStorage(`provider-compliance/${workerUid}`, requestId, persistenceDataUri);
  let client;
  try {
    client = await pool.connect();
  } catch (error) {
    await storage.deletePrivateStoredFile(stored.storagePath).catch(() => {});
    throw error;
  }
  let commitAttempted = false;
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO ${dbSchema}.worker_requirements
         (worker_uid, file_url, file_name, requirement_type, storage_path,
          mime_type, byte_size, content_sha256, scanner_engine, client_request_id,
          lifecycle_state, scan_status, version, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'under_review','clean',1,NOW())
       RETURNING id, file_name, uploaded_at, requirement_type`,
      [workerUid, `private://${stored.storagePath}`, sanitizedName, sanitizedType,
        stored.storagePath, stored.mimeType, stored.byteSize,
        createHash('sha256').update(persistenceBuffer).digest('hex'), scan.engine, requestId],
    );
    const id = Number(inserted.rows[0].id);
    await client.query(
      `INSERT INTO ${dbSchema}.provider_verification_events
         (provider_uid, domain, source_type, source_id, event_type, event_key, internal_metadata)
       VALUES ($1,'document','worker_requirement',$2,'document_submitted',$3,$4::jsonb)
       ON CONFLICT (provider_uid, event_key) DO NOTHING`,
      [workerUid, String(id), `document-submitted:${id}:v1`, JSON.stringify({ source: 'admin' })],
    );
    commitAttempted = true;
    await client.query('COMMIT');
    return {
      id,
      fileName: inserted.rows[0].file_name,
      fileUrl: null,
      uploadedAt: inserted.rows[0].uploaded_at,
      requirementType: inserted.rows[0].requirement_type,
      currentDecision: 'pending_review',
      previewAvailable: true,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (!commitAttempted) {
      await storage.deletePrivateStoredFile(stored.storagePath).catch(() => {});
    }
    throw error;
  } finally {
    client.release();
  }
};

export const deleteProviderRequirement = async (workerUid: string, id: number) => {
  return technicianService.deleteWorkerRequirement(workerUid, id);
};

export const verifyProviderRequirement = async (
  requirementId: number,
  actorUid: string,
  workerUid: string,
  internalNote?: string,
) => {
  const owned = await dbQuery.query(
    `SELECT id FROM ${dbSchema}.worker_requirements WHERE id = $1 AND worker_uid = $2 LIMIT 1`,
    [requirementId, workerUid]
  );
  if (!owned.rowCount) {
    throw Object.assign(new Error('Requirement not found for this provider'), { statusCode: 404 });
  }
  return onboardingService.decideRequirement(requirementId, 'approved', actorUid, {
    internalRationale: internalNote,
  });
};

export const rejectProviderRequirement = async (
  requirementId: number,
  actorUid: string,
  workerUid: string,
  reasonCode: string,
  providerMessage: string,
  internalNote?: string,
) => {
  if (!providerMessage || !providerMessage.trim()) {
    throw Object.assign(new Error('providerMessage is required to reject a document'), { statusCode: 400 });
  }
  const owned = await dbQuery.query(
    `SELECT id FROM ${dbSchema}.worker_requirements WHERE id = $1 AND worker_uid = $2 LIMIT 1`,
    [requirementId, workerUid]
  );
  if (!owned.rowCount) {
    throw Object.assign(new Error('Requirement not found for this provider'), { statusCode: 404 });
  }
  return onboardingService.decideRequirement(requirementId, 'rejected', actorUid, {
    reasonCode,
    providerMessage: providerMessage.trim(),
    internalRationale: internalNote,
  });
};

export const needsResubmissionProviderRequirement = async (
  requirementId: number,
  actorUid: string,
  workerUid: string,
  reasonCode: string,
  providerMessage: string,
  internalNote?: string,
) => {
  if (!providerMessage || !providerMessage.trim()) {
    throw Object.assign(new Error('providerMessage is required when requesting resubmission'), { statusCode: 400 });
  }
  const owned = await dbQuery.query(
    `SELECT id FROM ${dbSchema}.worker_requirements WHERE id = $1 AND worker_uid = $2 LIMIT 1`,
    [requirementId, workerUid]
  );
  if (!owned.rowCount) {
    throw Object.assign(new Error('Requirement not found for this provider'), { statusCode: 404 });
  }
  return onboardingService.decideRequirement(requirementId, 'needs_resubmission', actorUid, {
    reasonCode,
    providerMessage: providerMessage.trim(),
    internalRationale: internalNote,
  });
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
              s.name AS category_name,
              COALESCE(ua.address_one, b.service_address->>'addressLine') AS address_one,
              COALESCE(ua.post_town,   b.service_address->>'city')        AS post_town,
              uc.first_name AS customer_first, uc.last_name AS customer_last
       FROM ${dbSchema}.bookings b
       LEFT JOIN ${dbSchema}.service_options so ON so.id = b.service_option_id
       LEFT JOIN ${dbSchema}.service_families s ON s.id = so.service_id
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
    bookingId: String(r.id),
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
       COALESCE(SUM(final_price) FILTER (WHERE schedule IS NOT NULL AND schedule::text <> '' AND DATE_TRUNC('month', schedule::text::timestamptz) = DATE_TRUNC('month', NOW())), 0) AS this_month_gross
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
    totalProviderShare: providerShareOf(gross),
    thisMonthGross: monthGross,
    thisMonthProviderShare: providerShareOf(monthGross),
    providerSharePercent: PROVIDER_SHARE_PERCENT,
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
     SET account_status = $1
     WHERE uid = $2 AND role::int IN (2,4)
     RETURNING uid, account_status, role`,
    [newStatus, uid]
  );

  if (!res.rowCount) {
    const err: any = new Error('Provider not found or not a provider role.');
    err.statusCode = 404;
    throw err;
  }

  /**
   * This is an admin OVERRIDE and is deliberately still allowed — support needs
   * a way to correct an account without walking the whole review flow.
   *
   * But it writes the field requireActiveProvider reads, so without this the
   * activation dimension and the operational status could silently disagree:
   * account_status = 'active' while activation says NOT_ELIGIBLE. The
   * account-state endpoint would then have to arbitrate between two sources
   * each claiming authority, which is the conflation Command 6 exists to remove.
   *
   * Syncing keeps one story and leaves an audit row naming the admin. Non-fatal
   * on purpose: the override has already committed, and throwing here would
   * report a completed change as a failure.
   */
  try {
    const { getActivation, transitionActivation } = await import(
      './providerActivationService'
    );
    const target =
      newStatus === 'active'
        ? 'ACTIVE'
        : newStatus === 'suspended'
          ? 'TEMPORARILY_RESTRICTED'
          : 'NOT_ELIGIBLE';

    const current = await getActivation(uid);
    if (current.status !== target) {
      await transitionActivation({
        providerUid: uid,
        to: target as any,
        expectedVersion: current.version,
        actorType: 'admin',
        actorUid: adminUid,
        reason: `admin_override:${newStatus}${reason ? ` (${reason})` : ''}`,
      });
    }
  } catch (e) {
    console.warn('[admin-override] activation sync failed for', uid, e);
  }

  return res.rows[0];
};

// ── Archive / Restore ─────────────────────────────────────────────────────────

export const setProviderArchive = async (uid: string, isArchive: boolean) => {
  const res = await dbQuery.query(
    `UPDATE ${dbSchema}.user_credentials
     SET is_archive = $1
     WHERE uid = $2 AND role::int IN (2,4)
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
    safeCount(`SELECT COUNT(*)::int AS cnt FROM ${s}.employee_services         WHERE uid = $1`,         [uid]),
    safeCount(`SELECT COUNT(*)::int AS cnt FROM ${s}.employee_catalog_capabilities WHERE uid = $1`,     [uid]),
    safeCount(`SELECT COUNT(*)::int AS cnt FROM ${s}.worker_availability       WHERE worker_uid = $1`,  [uid]),
    safeCount(`SELECT COUNT(*)::int AS cnt FROM ${s}.worker_service_areas      WHERE worker_uid = $1`,  [uid]),
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
    { table: 'employee_services',             column: 'uid',        presentAs: 'active service assignments',          rowCount: activeSvcCnt },
    { table: 'employee_catalog_capabilities', column: 'uid',        presentAs: 'catalog capabilities',                rowCount: catalogCapCnt },
    { table: 'worker_availability',           column: 'worker_uid', presentAs: 'availability schedule',               rowCount: availCnt },
    { table: 'worker_service_areas',          column: 'worker_uid', presentAs: 'service area config',                 rowCount: svcAreaCnt },
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
         WHERE role::int IN (2,4) AND email IS NOT NULL AND email != ''
         GROUP BY LOWER(email) HAVING COUNT(DISTINCT uid) > 1
       ) x`, []
    ),
    // Same phone, different UIDs
    dbQuery.query(
      `SELECT COUNT(*) AS cnt FROM (
         SELECT phone_number FROM ${s}.user_credentials
         WHERE role::int IN (2,4) AND phone_number IS NOT NULL AND phone_number != ''
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
       WHERE uc.role::int NOT IN (2,4)
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
       WHERE role::int IN (2,4) AND email IS NOT NULL AND email != ''
       GROUP BY LOWER(email) HAVING COUNT(DISTINCT uid) > 1
       ORDER BY cnt DESC LIMIT 100`, []
    ),
    // Duplicate candidates by phone
    dbQuery.query(
      `SELECT phone_number, array_agg(uid ORDER BY created_date) AS uids, COUNT(*) AS cnt
       FROM ${s}.user_credentials
       WHERE role::int IN (2,4) AND phone_number IS NOT NULL AND phone_number != ''
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
       WHERE uc.role::int NOT IN (2,4)
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
       JOIN ${s}.user_credentials uc ON uc.uid = es.uid AND uc.role::int IN (2,4)
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

// ── Canonical Required Document Definitions ───────────────────────────────────
// Policy-level registry — the 3 documents every Servana provider must submit.
// Frontend derives "missing" slots from this list vs uploaded docs.

export const REQUIREMENT_DEFINITIONS = [
  {
    requirementKey: 'government_id',
    displayName: 'Valid Government ID',
    description: 'Any Philippine government-issued photo ID (passport, SSS, GSIS, PhilHealth, driver\'s license, voter\'s ID, PRC, NBI)',
    isRequired: true,
    displayOrder: 1,
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
    maximumFileSizeMb: 10,
    expiryRequired: false,
  },
  {
    requirementKey: 'nbi_clearance',
    displayName: 'NBI Clearance',
    description: 'National Bureau of Investigation clearance — must be issued within the past 12 months',
    isRequired: true,
    displayOrder: 2,
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
    maximumFileSizeMb: 10,
    expiryRequired: true,
  },
  {
    requirementKey: 'proof_of_address',
    displayName: 'Proof of Address',
    description: 'Recent utility bill, bank statement, or government mail showing current address (issued within 3 months)',
    isRequired: true,
    displayOrder: 3,
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
    maximumFileSizeMb: 10,
    expiryRequired: false,
  },
];

export const getRequirementDefinitions = () => REQUIREMENT_DEFINITIONS;

// ── Provider Profile Update (Admin-on-behalf) ─────────────────────────────────

const PHONE_RE = /^\+639\d{9}$|^09\d{9}$/;
const VALID_GENDERS = ['male', 'female', 'non_binary', 'prefer_not_to_say'];

export const updateProviderProfile = async (
  uid: string,
  fields: {
    firstName?: string;
    lastName?: string;
    phoneNumber?: string | null;
    birthdate?: string | null;
    gender?: string | null;
  },
  adminActorUid: string,
) => {
  const current = await getProviderIdentity(uid);
  if (!current) throw Object.assign(new Error('Provider not found'), { statusCode: 404 });

  const credCols: string[] = [];
  const credVals: any[] = [];

  if (fields.firstName !== undefined) {
    const v = String(fields.firstName || '').trim();
    if (!v) throw Object.assign(new Error('firstName cannot be empty'), { statusCode: 422 });
    credCols.push('first_name = $' + (credVals.push(v)));
  }
  if (fields.lastName !== undefined) {
    const v = String(fields.lastName || '').trim();
    if (!v) throw Object.assign(new Error('lastName cannot be empty'), { statusCode: 422 });
    credCols.push('last_name = $' + (credVals.push(v)));
  }
  if (fields.phoneNumber !== undefined) {
    const p = fields.phoneNumber ? String(fields.phoneNumber).trim() : null;
    if (p && !PHONE_RE.test(p)) {
      throw Object.assign(new Error('Invalid Philippine phone number. Use 09XXXXXXXXX or +639XXXXXXXXX format'), { statusCode: 422 });
    }
    credCols.push('phone_number = $' + (credVals.push(p)));
  }

  const profCols: string[] = [];
  const profVals: any[] = [];

  if (fields.birthdate !== undefined) {
    profCols.push('birthdate = $' + (profVals.push(fields.birthdate || null)));
  }
  if (fields.gender !== undefined) {
    const g = fields.gender;
    if (g !== null && !VALID_GENDERS.includes(g)) {
      throw Object.assign(new Error('Invalid gender value'), { statusCode: 422 });
    }
    profCols.push('gender = $' + (profVals.push(g)));
  }

  if (credCols.length === 0 && profCols.length === 0) {
    throw Object.assign(new Error('No editable fields provided'), { statusCode: 400 });
  }

  if (credCols.length > 0) {
    credVals.push(uid);
    await dbQuery.query(
      'UPDATE ' + dbSchema + '.user_credentials SET ' + credCols.join(', ') + ' WHERE uid = $' + credVals.length,
      credVals
    );
  }

  if (profCols.length > 0) {
    // Ensure row exists, then update
    await dbQuery.query(
      'INSERT INTO ' + dbSchema + '.user_profile (uid) VALUES ($1) ON CONFLICT (uid) DO NOTHING',
      [uid]
    ).catch(function() {}); // safe if table schema differs
    profVals.push(uid);
    await dbQuery.query(
      'UPDATE ' + dbSchema + '.user_profile SET ' + profCols.join(', ') + ' WHERE uid = $' + profVals.length,
      profVals
    ).catch(function() {});
  }

  return getProviderIdentity(uid);
};

// ── Remove Provider Service Association ───────────────────────────────────────
// Removes the provider's employee_services row and archives related catalog
// capabilities. Does NOT delete the global Service Catalog entry.
// Blocks if active/upcoming bookings exist for this provider+service.

export const removeProviderService = async (
  providerUid: string,
  serviceId: number,
  adminActorUid: string,
  reason: string,
) => {
  if (!reason || !String(reason).trim()) {
    throw Object.assign(new Error('reason is required to remove a provider service'), { statusCode: 400 });
  }

  // Verify the association exists
  const svcRes = await dbQuery.query(
    'SELECT es.service_id, s.name AS service_name' +
    ' FROM ' + dbSchema + '.employee_services es' +
    ' LEFT JOIN ' + dbSchema + '.services s ON s.id = es.service_id' +
    ' WHERE es.employee_uid = $1 AND es.service_id = $2 LIMIT 1',
    [providerUid, serviceId]
  );
  if (!svcRes.rowCount) {
    throw Object.assign(new Error('Provider service association not found'), { statusCode: 404 });
  }
  const svc = svcRes.rows[0];

  // Check for active bookings — block if any exist
  const bookingCheck = await dbQuery.query(
    'SELECT COUNT(*)::int AS cnt' +
    ' FROM ' + dbSchema + '.bookings b' +
    ' JOIN ' + dbSchema + '.booking_workers bw ON bw.booking_id = b.id' +
    ' WHERE bw.worker_uid = $1' +
    '   AND b.service_option_id IN (SELECT id FROM ' + dbSchema + '.service_options WHERE service_id = $2)' +
    '   AND b.status IN (\'CONFIRMED\', \'IN_PROGRESS\', \'WORKER_ASSIGNED\')',
    [providerUid, serviceId]
  ).catch(function() { return { rows: [{ cnt: 0 }] }; });

  const activeCount = Number((bookingCheck.rows[0] && bookingCheck.rows[0].cnt) || 0);
  if (activeCount > 0) {
    const err: any = new Error('SERVICE_HAS_ACTIVE_BOOKINGS: This provider has ' + activeCount + ' active or upcoming booking(s) for this service. Reassign or complete them before removing.');
    err.statusCode = 409;
    err.code = 'SERVICE_HAS_ACTIVE_BOOKINGS';
    err.activeBookings = activeCount;
    throw err;
  }

  // Remove from employee_services (provider no longer has this service)
  await dbQuery.query(
    'DELETE FROM ' + dbSchema + '.employee_services WHERE employee_uid = $1 AND service_id = $2',
    [providerUid, serviceId]
  );

  // Archive related catalog capabilities (soft-deactivate, global catalog intact)
  await dbQuery.query(
    'UPDATE ' + dbSchema + '.employee_catalog_capabilities' +
    ' SET status = \'archived\', suspended_at = NOW()' +
    ' WHERE employee_uid = $1 AND service_id = $2 AND status != \'archived\'',
    [providerUid, serviceId]
  ).catch(function() {});

  return {
    providerUid,
    serviceId,
    serviceName: (svc.service_name) || '',
    removed: true,
    reason: String(reason).trim(),
  };
};
