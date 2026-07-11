/**
 * ProviderAutoOnlineEngine — Command 14
 *
 * Automatically activates providers as online + bookable when they satisfy
 * all three readiness criteria:
 *   1. Complete details (name, contact, valid role, account not blocked)
 *   2. Required documents submitted (typed or legacy count ≥ 3)
 *   3. Catalog/service association (employee_services OR pending/approved application)
 *
 * Document approval is NOT required — pending_review counts as submitted.
 * Service application approval is NOT required — pending_review counts as associated.
 *
 * MOBILE CONTRACT PROTECTION:
 *   - MongoDB worker_locations is updated additively (is_online + auto_online flags)
 *   - All mobile and provider web routes are untouched
 *   - All new tables created via CREATE TABLE IF NOT EXISTS
 */

import dbQuery from '../db/dbQuery';
import { db } from '../config';
import mongoDb from '../db/mongodbQuery';
import * as availEngine from './providerAvailabilityEngine';
import * as areaEngine from './providerServiceAreaEngine';

const s = db.schema;

// ── Constants ──────────────────────────────────────────────────────────────────

export const ALL_CITY_IDS = [
  'manila', 'quezon', 'makati', 'taguig', 'pasig', 'mandaluyong', 'marikina',
  'caloocan', 'malabon', 'navotas', 'valenzuela', 'las-pinas', 'muntinlupa',
  'paranaque', 'pasay', 'pateros', 'san-juan', 'bacoor', 'imus', 'antipolo',
  'san-jose-del-monte',
];

const DOW_LABELS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

const ALL_TIME_SCHEDULE: availEngine.WeeklyScheduleSlot[] = [0,1,2,3,4,5,6].map(dow => ({
  dayOfWeek: dow as 0|1|2|3|4|5|6,
  dayLabel: DOW_LABELS[dow],
  startTime: '00:00',
  endTime: '23:59',
  isAvailable: true,
  maxJobs: null,
}));

const VALID_ID_TYPES = ['valid_id', 'government_id', 'national_id', 'passport', 'drivers_license', 'philsys'];
const CLEARANCE_TYPES = ['nbi_clearance', 'nbi', 'police_clearance', 'police_record', 'clearance', 'barangay_clearance'];
const WORK_RECORD_TYPES = ['service_record', 'cv', 'resume', 'work_record', 'certificate', 'tor', 'diploma'];

const BLOCKED_STATUSES = ['suspended', 'blocked', 'rejected', 'deactivated', 'deleted'];
const VALID_PROVIDER_ROLES = [2, 4];

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ProviderAutoOnlineReadiness {
  providerUid: string;
  source: {
    registrationSource: 'provider_web' | 'provider_mobile' | 'admin_created' | 'inferred_mobile' | 'inferred_web' | 'unknown';
    sourceConfidence: 'explicit' | 'inferred' | 'unknown';
    firstSeenAt: string | null;
    lastSeenAt: string | null;
  };
  details: {
    complete: boolean;
    missingFields: string[];
    firstName: boolean;
    lastName: boolean;
    hasEmail: boolean;
    hasPhone: boolean;
    roleValid: boolean;
    accountAllowed: boolean;
  };
  documents: {
    complete: boolean;
    requiredTotal: 3;
    submittedRequired: number;
    approvedRequired: number;
    pendingReviewRequired: number;
    missingRequiredTypes: string[];
    classification: 'typed' | 'legacy_inferred' | 'incomplete' | 'unknown';
  };
  serviceAssociation: {
    complete: boolean;
    associatedServiceIds: number[];
    associatedOfferingIds: number[];
    associatedCatalogKeys: string[];
    source: 'employee_services' | 'service_applications' | 'catalog_capabilities' | 'mixed' | 'none';
  };
  autoOnline: {
    eligible: boolean;
    active: boolean;
    bookable: boolean;
    onlineStatus: 'online' | 'offline';
    availabilityMode: 'all_time' | 'custom' | 'missing';
    serviceAreaMode: 'all' | 'custom' | 'missing';
    activatedAt: string | null;
    lastEvaluatedAt: string;
    reasonCodes: string[];
    blockers: string[];
    warnings: string[];
  };
}

// ── Bootstrap (lazy) ─────────────────────────────────────────────────────────

let _bootstrapped = false;

export const bootstrap = async (): Promise<void> => {
  if (_bootstrapped) return;

  await dbQuery.query(`
    CREATE TABLE IF NOT EXISTS ${s}.provider_auto_online_state (
      provider_uid        TEXT PRIMARY KEY,
      is_auto_online      BOOLEAN NOT NULL DEFAULT FALSE,
      is_bookable         BOOLEAN NOT NULL DEFAULT FALSE,
      activation_mode     TEXT NOT NULL DEFAULT 'none',
      activation_reason   TEXT,
      eligibility_snapshot JSONB NOT NULL DEFAULT '{}',
      activated_at        TIMESTAMPTZ,
      deactivated_at      TIMESTAMPTZ,
      last_evaluated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      version             INTEGER NOT NULL DEFAULT 1
    )
  `, []);

  await dbQuery.query(`
    CREATE TABLE IF NOT EXISTS ${s}.provider_provisional_bookable_services (
      provider_uid TEXT NOT NULL,
      service_id   INTEGER NOT NULL,
      source       TEXT NOT NULL,
      source_id    TEXT,
      status       TEXT NOT NULL DEFAULT 'active',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (provider_uid, service_id)
    )
  `, []);

  await dbQuery.query(`
    CREATE TABLE IF NOT EXISTS ${s}.provider_auto_online_events (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      provider_uid TEXT NOT NULL,
      event_type   TEXT NOT NULL,
      before       JSONB,
      after        JSONB,
      reason       TEXT,
      actor_type   TEXT NOT NULL DEFAULT 'system',
      actor_uid    TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `, []);

  // Index for backfill queries
  await dbQuery.query(`
    CREATE INDEX IF NOT EXISTS idx_paoe_provider_uid
    ON ${s}.provider_auto_online_events (provider_uid)
  `, []);
  await dbQuery.query(`
    CREATE INDEX IF NOT EXISTS idx_ppbs_provider_uid
    ON ${s}.provider_provisional_bookable_services (provider_uid)
    WHERE status = 'active'
  `, []);

  _bootstrapped = true;
};

// ── Readiness checks ─────────────────────────────────────────────────────────

const checkDetails = async (providerUid: string): Promise<ProviderAutoOnlineReadiness['details']> => {
  const res = await dbQuery.query(
    `SELECT uid, first_name, last_name, email, phone_number, role, is_archive, account_status
     FROM ${s}.user_credentials WHERE uid = $1`,
    [providerUid]
  );

  if (!res.rows[0]) {
    return { complete: false, missingFields: ['providerNotFound'], firstName: false, lastName: false, hasEmail: false, hasPhone: false, roleValid: false, accountAllowed: false };
  }

  const row = res.rows[0];
  const missing: string[] = [];
  const firstName  = !!(row.first_name?.trim());
  const lastName   = !!(row.last_name?.trim());
  const hasEmail   = !!(row.email?.trim());
  const hasPhone   = !!(row.phone_number?.trim());
  const roleValid  = VALID_PROVIDER_ROLES.includes(Number(row.role));
  const accountAllowed = !row.is_archive && !BLOCKED_STATUSES.includes(row.account_status);

  if (!firstName)     missing.push('firstName');
  if (!lastName)      missing.push('lastName');
  if (!hasEmail && !hasPhone) missing.push('contactInfo');
  if (!roleValid)     missing.push('role');
  if (row.is_archive) missing.push('accountArchived');
  if (BLOCKED_STATUSES.includes(row.account_status)) missing.push(`accountStatus_${row.account_status}`);

  return { complete: missing.length === 0, missingFields: missing, firstName, lastName, hasEmail, hasPhone, roleValid, accountAllowed };
};

const checkDocuments = async (providerUid: string): Promise<ProviderAutoOnlineReadiness['documents']> => {
  const res = await dbQuery.query(
    `SELECT id, requirement_type FROM ${s}.worker_requirements WHERE worker_uid = $1`,
    [providerUid]
  );
  const docs = res.rows;
  const missingTypes: string[] = [];

  if (!docs.length) {
    return { complete: false, requiredTotal: 3, submittedRequired: 0, approvedRequired: 0, pendingReviewRequired: 0, missingRequiredTypes: ['valid_id', 'clearance', 'work_record'], classification: 'incomplete' };
  }

  const typedDocs = docs.filter((d: any) => d.requirement_type);
  const allUntyped = typedDocs.length === 0;

  // Legacy fallback: if no types present and count >= 3, infer complete
  if (allUntyped) {
    const complete = docs.length >= 3;
    return {
      complete,
      requiredTotal: 3,
      submittedRequired: Math.min(docs.length, 3),
      approvedRequired: Math.min(docs.length, 3),
      pendingReviewRequired: 0,
      missingRequiredTypes: complete ? [] : ['valid_id', 'clearance', 'work_record'],
      classification: complete ? 'legacy_inferred' : 'incomplete',
    };
  }

  const types: string[] = typedDocs.map((d: any) => (d.requirement_type as string).toLowerCase());
  const hasValidId   = types.some((t: string) => VALID_ID_TYPES.some((v: string) => t.includes(v)));
  const hasClearance = types.some((t: string) => CLEARANCE_TYPES.some((v: string) => t.includes(v)));
  const hasWorkRecord = types.some((t: string) => WORK_RECORD_TYPES.some((v: string) => t.includes(v)));

  if (!hasValidId)    missingTypes.push('valid_id');
  if (!hasClearance)  missingTypes.push('clearance');
  if (!hasWorkRecord) missingTypes.push('work_record');

  const submittedRequired = [hasValidId, hasClearance, hasWorkRecord].filter(Boolean).length;

  return {
    complete: submittedRequired === 3,
    requiredTotal: 3,
    submittedRequired,
    approvedRequired: submittedRequired,
    pendingReviewRequired: 0,
    missingRequiredTypes: missingTypes,
    classification: submittedRequired === 3 ? 'typed' : 'incomplete',
  };
};

const checkServiceAssociation = async (providerUid: string): Promise<ProviderAutoOnlineReadiness['serviceAssociation']> => {
  const [svcRes, appRes] = await Promise.all([
    dbQuery.query(
      `SELECT service_id FROM ${s}.employee_services WHERE employee_uid = $1`,
      [providerUid]
    ),
    dbQuery.query(
      `SELECT service_id, status FROM ${s}.worker_service_applications
       WHERE worker_uid = $1 AND status IN ('pending_review', 'action_required', 'approved')`,
      [providerUid]
    ),
  ]);

  const activeServiceIds = svcRes.rows.map((r: any) => Number(r.service_id));
  const appServiceIds    = appRes.rows.map((r: any) => Number(r.service_id));
  const allIds = [...new Set([...activeServiceIds, ...appServiceIds])];

  const fromEmployeeServices = activeServiceIds.length > 0;
  const fromApps = appServiceIds.length > 0;
  const source: ProviderAutoOnlineReadiness['serviceAssociation']['source'] =
    fromEmployeeServices && fromApps ? 'mixed' :
    fromEmployeeServices             ? 'employee_services' :
    fromApps                         ? 'service_applications' : 'none';

  return {
    complete: allIds.length > 0,
    associatedServiceIds: allIds,
    associatedOfferingIds: [],
    associatedCatalogKeys: [],
    source,
  };
};

const getSource = async (providerUid: string): Promise<ProviderAutoOnlineReadiness['source']> => {
  // Source attribution table may not exist — fail gracefully
  try {
    const res = await dbQuery.query(
      `SELECT registration_source, source_confidence, first_seen_at, last_seen_at
       FROM ${s}.provider_source_attribution WHERE provider_uid = $1`,
      [providerUid]
    );
    if (res.rows[0]) {
      return {
        registrationSource: res.rows[0].registration_source ?? 'unknown',
        sourceConfidence: res.rows[0].source_confidence ?? 'unknown',
        firstSeenAt: res.rows[0].first_seen_at ?? null,
        lastSeenAt: res.rows[0].last_seen_at ?? null,
      };
    }
  } catch { /* table may not exist */ }
  return { registrationSource: 'unknown', sourceConfidence: 'unknown', firstSeenAt: null, lastSeenAt: null };
};

const getCurrentAutoOnlineState = async (providerUid: string) => {
  await bootstrap();
  const res = await dbQuery.query(
    `SELECT * FROM ${s}.provider_auto_online_state WHERE provider_uid = $1`,
    [providerUid]
  );
  return res.rows[0] ?? null;
};

// ── Evaluate ─────────────────────────────────────────────────────────────────

export const evaluateProvider = async (
  providerUid: string,
  actorType: 'system' | 'admin' = 'system',
  actorUid: string | null = null,
): Promise<ProviderAutoOnlineReadiness> => {
  await bootstrap();

  const [details, documents, serviceAssociation, source, currentState] = await Promise.all([
    checkDetails(providerUid),
    checkDocuments(providerUid),
    checkServiceAssociation(providerUid),
    getSource(providerUid),
    getCurrentAutoOnlineState(providerUid),
  ]);

  const isAdminDisabled = currentState?.activation_mode === 'manual_admin_disabled';
  const eligible = details.complete && documents.complete && serviceAssociation.complete && !isAdminDisabled;

  const blockers: string[] = [];
  const warnings: string[] = [];
  const reasonCodes: string[] = [];

  if (!details.complete)        blockers.push(...details.missingFields.map(f => `missing_${f}`));
  if (!documents.complete)      blockers.push(...documents.missingRequiredTypes.map(t => `missing_doc_${t}`));
  if (!serviceAssociation.complete) blockers.push('no_service_association');
  if (isAdminDisabled)          blockers.push('admin_disabled');

  if (documents.classification === 'legacy_inferred') warnings.push('documents_legacy_inferred');
  if (serviceAssociation.source === 'service_applications') warnings.push('bookable_while_application_under_review');

  if (eligible) reasonCodes.push('details_complete', 'documents_submitted', 'service_associated');

  let activationResult: { activatedAt: string | null; active: boolean } = {
    activatedAt: currentState?.activated_at ?? null,
    active: currentState?.is_auto_online ?? false,
  };

  // Apply or revoke based on eligibility change
  if (eligible && !currentState?.is_auto_online) {
    await applyAutoOnline(providerUid, 'auto_evaluated', actorType, actorUid);
    activationResult = { active: true, activatedAt: new Date().toISOString() };
  } else if (!eligible && currentState?.is_auto_online && !isAdminDisabled) {
    await revokeAutoOnline(providerUid, blockers.join('; '), actorType, actorUid);
    activationResult = { active: false, activatedAt: null };
  }

  // Get availability/service-area mode
  let availabilityMode: 'all_time' | 'custom' | 'missing' = 'missing';
  let serviceAreaMode: 'all' | 'custom' | 'missing' = 'missing';
  try {
    const avail = await availEngine.getAvailabilityProfile(providerUid);
    if (avail.status === 'saved') {
      availabilityMode = avail.weeklySchedule.some(sl => sl.startTime === '00:00') ? 'all_time' : 'custom';
    }
  } catch { /* best-effort */ }
  try {
    const area = await areaEngine.getServiceAreaProfile(providerUid);
    if (area.status === 'saved') {
      serviceAreaMode = area.cityIds.length >= ALL_CITY_IDS.length ? 'all' : 'custom';
    }
  } catch { /* best-effort */ }

  // Check online status in MongoDB
  let onlineStatus: 'online' | 'offline' = 'offline';
  try {
    const col = (await mongoDb).collection('worker_locations');
    const loc = await col.findOne({ uid: providerUid }, { projection: { is_online: 1 } });
    if (loc?.is_online) onlineStatus = 'online';
  } catch { /* best-effort */ }

  const readiness: ProviderAutoOnlineReadiness = {
    providerUid,
    source,
    details,
    documents,
    serviceAssociation,
    autoOnline: {
      eligible,
      active: activationResult.active,
      bookable: activationResult.active,
      onlineStatus,
      availabilityMode,
      serviceAreaMode,
      activatedAt: activationResult.activatedAt,
      lastEvaluatedAt: new Date().toISOString(),
      reasonCodes,
      blockers,
      warnings,
    },
  };

  // Persist snapshot
  await dbQuery.query(
    `INSERT INTO ${s}.provider_auto_online_state
       (provider_uid, is_auto_online, is_bookable, activation_mode, eligibility_snapshot, last_evaluated_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
     ON CONFLICT (provider_uid) DO UPDATE
       SET is_auto_online       = EXCLUDED.is_auto_online,
           is_bookable          = EXCLUDED.is_bookable,
           activation_mode      = CASE
             WHEN ${s}.provider_auto_online_state.activation_mode = 'manual_admin_disabled' THEN 'manual_admin_disabled'
             ELSE EXCLUDED.activation_mode END,
           eligibility_snapshot = EXCLUDED.eligibility_snapshot,
           last_evaluated_at    = NOW(),
           updated_at           = NOW(),
           version              = ${s}.provider_auto_online_state.version + 1`,
    [
      providerUid,
      activationResult.active,
      activationResult.active,
      activationResult.active ? 'auto_online_all_time_all_area' : 'none',
      JSON.stringify(readiness),
    ]
  );

  await writeAuditEvent(providerUid, 'provider_auto_online_evaluated', null, { eligible, blockers }, 'auto_evaluate', actorType, actorUid);

  return readiness;
};

// ── Apply auto-online ─────────────────────────────────────────────────────────

export const applyAutoOnline = async (
  providerUid: string,
  reason: string,
  actorType: 'system' | 'admin' = 'system',
  actorUid: string | null = null,
): Promise<void> => {
  await Promise.all([
    syncOnlineStatus(providerUid, true),
    syncAllTimeAvailability(providerUid),
    syncAllAreaServiceArea(providerUid),
  ]);
  await syncProvisionalBookableServices(providerUid);

  // Set account status to active if it's in a neutral pre-active state
  await dbQuery.query(
    `UPDATE ${s}.user_credentials
     SET account_status = 'active', updated_at = NOW()
     WHERE uid = $1
       AND account_status NOT IN ('suspended', 'blocked', 'rejected', 'deactivated', 'deleted')
       AND account_status IS DISTINCT FROM 'active'`,
    [providerUid]
  );

  await writeAuditEvent(providerUid, 'provider_auto_online_activated', null, { reason, actorType }, reason, actorType, actorUid);
};

// ── Revoke auto-online ────────────────────────────────────────────────────────

export const revokeAutoOnline = async (
  providerUid: string,
  reason: string,
  actorType: 'system' | 'admin' = 'system',
  actorUid: string | null = null,
): Promise<void> => {
  await bootstrap();

  await dbQuery.query(
    `UPDATE ${s}.provider_auto_online_state
     SET is_auto_online = FALSE, is_bookable = FALSE, activation_mode = 'none',
         activation_reason = $2, deactivated_at = NOW(), updated_at = NOW(), version = version + 1
     WHERE provider_uid = $1`,
    [providerUid, reason]
  );

  await dbQuery.query(
    `UPDATE ${s}.provider_provisional_bookable_services
     SET status = 'inactive', updated_at = NOW()
     WHERE provider_uid = $1 AND status = 'active'`,
    [providerUid]
  );

  // Clear MongoDB online flag so the provider is no longer dispatched
  await syncOnlineStatus(providerUid, false);

  await writeAuditEvent(providerUid, 'provider_auto_online_revoked', null, { reason }, reason, actorType, actorUid);
};

// ── Disable / enable override (admin actions) ─────────────────────────────────

export const disableAutoOnline = async (
  providerUid: string,
  reason: string,
  adminUid: string,
): Promise<void> => {
  await bootstrap();

  await dbQuery.query(
    `INSERT INTO ${s}.provider_auto_online_state
       (provider_uid, is_auto_online, is_bookable, activation_mode, activation_reason, deactivated_at, last_evaluated_at, updated_at)
     VALUES ($1, FALSE, FALSE, 'manual_admin_disabled', $2, NOW(), NOW(), NOW())
     ON CONFLICT (provider_uid) DO UPDATE
       SET is_auto_online    = FALSE,
           is_bookable       = FALSE,
           activation_mode   = 'manual_admin_disabled',
           activation_reason = $2,
           deactivated_at    = NOW(),
           updated_at        = NOW(),
           version           = ${s}.provider_auto_online_state.version + 1`,
    [providerUid, reason]
  );

  await dbQuery.query(
    `UPDATE ${s}.provider_provisional_bookable_services
     SET status = 'inactive', updated_at = NOW()
     WHERE provider_uid = $1 AND status = 'active'`,
    [providerUid]
  );

  // Clear MongoDB online flag so the provider is no longer dispatched
  await syncOnlineStatus(providerUid, false);

  await writeAuditEvent(providerUid, 'provider_auto_online_disabled_by_admin', null, { reason }, reason, 'admin', adminUid);
};

export const enableAutoOnlineOverride = async (
  providerUid: string,
  reason: string,
  adminUid: string,
): Promise<void> => {
  await bootstrap();

  await dbQuery.query(
    `UPDATE ${s}.provider_auto_online_state
     SET activation_mode = 'manual_admin_override', activation_reason = $2, updated_at = NOW(), version = version + 1
     WHERE provider_uid = $1`,
    [providerUid, reason]
  );

  await writeAuditEvent(providerUid, 'provider_auto_online_override_enabled', null, { reason }, reason, 'admin', adminUid);
  // Re-evaluate to apply
  await evaluateProvider(providerUid, 'admin', adminUid);
};

// ── Sync online status (MongoDB) ──────────────────────────────────────────────

export const syncOnlineStatus = async (providerUid: string, online: boolean): Promise<void> => {
  const col = (await mongoDb).collection('worker_locations');
  if (online) {
    await col.updateOne(
      { uid: providerUid },
      {
        $set: {
          uid: providerUid,
          is_online: true,
          auto_online: true,
          auto_online_reason: 'auto_online_all_time_all_area',
          updatedAt: new Date(),
        },
        $setOnInsert: {
          // Use Manila center as default location — preserved if real coords exist
          loc: { type: 'Point', coordinates: [120.9842195, 14.5994643] },
          location_confidence: 'auto_online_default',
        },
      },
      { upsert: true }
    );
  } else {
    await col.updateOne(
      { uid: providerUid },
      { $set: { auto_online: false, updatedAt: new Date() } }
    );
  }
};

// ── Sync all-time availability ────────────────────────────────────────────────

export const syncAllTimeAvailability = async (providerUid: string): Promise<void> => {
  await availEngine.saveWeeklySchedule(providerUid, ALL_TIME_SCHEDULE, 'Asia/Manila', 'system_auto_online');
  await writeAuditEvent(providerUid, 'provider_all_time_availability_generated', null, { schedule: '7-day 00:00-23:59' }, 'auto_online_apply', 'system', null);
};

// ── Sync all-area service area ────────────────────────────────────────────────

export const syncAllAreaServiceArea = async (providerUid: string): Promise<void> => {
  await areaEngine.saveServiceArea(
    providerUid,
    { coverageMode: 'city', cityIds: ALL_CITY_IDS, label: 'All service areas' },
    'system_auto_online',
  );
  await writeAuditEvent(providerUid, 'provider_all_area_service_area_generated', null, { cityCount: ALL_CITY_IDS.length }, 'auto_online_apply', 'system', null);
};

// ── Sync provisional bookable services ───────────────────────────────────────

export const syncProvisionalBookableServices = async (providerUid: string): Promise<void> => {
  await bootstrap();

  const [svcRes, appRes] = await Promise.all([
    dbQuery.query(
      `SELECT service_id FROM ${s}.employee_services WHERE employee_uid = $1`,
      [providerUid]
    ),
    dbQuery.query(
      `SELECT id, service_id, status FROM ${s}.worker_service_applications
       WHERE worker_uid = $1 AND status IN ('pending_review', 'action_required', 'approved')`,
      [providerUid]
    ),
  ]);

  // Build a deduped map: service_id → {source, source_id}
  const services = new Map<number, { source: string; sourceId: string }>();
  for (const r of svcRes.rows) {
    services.set(Number(r.service_id), { source: 'employee_services', sourceId: String(r.service_id) });
  }
  for (const r of appRes.rows) {
    const id = Number(r.service_id);
    if (!services.has(id)) {
      services.set(id, { source: 'worker_service_applications', sourceId: String(r.id) });
    }
  }

  if (services.size === 0) return;

  for (const [serviceId, { source, sourceId }] of services) {
    await dbQuery.query(
      `INSERT INTO ${s}.provider_provisional_bookable_services
         (provider_uid, service_id, source, source_id, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'active', NOW(), NOW())
       ON CONFLICT (provider_uid, service_id) DO UPDATE
         SET status = 'active', source = EXCLUDED.source, source_id = EXCLUDED.source_id, updated_at = NOW()`,
      [providerUid, serviceId, source, sourceId]
    );
    await writeAuditEvent(providerUid, 'provider_provisional_bookable_service_created', null, { serviceId, source }, 'auto_online_apply', 'system', null);
  }

  // Deactivate any provisionals no longer in the current service set (e.g. cancelled/rejected applications)
  const currentIds = [...services.keys()];
  await dbQuery.query(
    `UPDATE ${s}.provider_provisional_bookable_services
     SET status = 'inactive', updated_at = NOW()
     WHERE provider_uid = $1 AND service_id != ALL($2::int[]) AND status = 'active'`,
    [providerUid, currentIds]
  );
};

// ── Audit ─────────────────────────────────────────────────────────────────────

export const writeAuditEvent = async (
  providerUid: string,
  eventType: string,
  before: any,
  after: any,
  reason: string | null,
  actorType: 'system' | 'admin',
  actorUid: string | null,
): Promise<void> => {
  try {
    await bootstrap();
    await dbQuery.query(
      `INSERT INTO ${s}.provider_auto_online_events
         (provider_uid, event_type, before, after, reason, actor_type, actor_uid)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [providerUid, eventType, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, reason, actorType, actorUid]
    );
  } catch { /* best-effort audit — never fail the main operation */ }
};

// ── Evaluate all providers (for backfill) ────────────────────────────────────

export const evaluateAllProviders = async (
  applyChanges: boolean,
  actorUid: string,
): Promise<{
  scanned: number;
  eligible: number;
  alreadyAutoOnline: number;
  newlyActivated: number;
  blocked: number;
  rows: Array<{ providerUid: string; displayName: string; source: string; eligible: boolean; blockers: string[]; actionsWouldApply: string[] }>;
}> => {
  await bootstrap();

  const providersRes = await dbQuery.query(
    `SELECT uid, first_name, last_name FROM ${s}.user_credentials WHERE role IN (2, 4) AND is_archive = FALSE ORDER BY created_date ASC`,
    []
  );

  const rows: any[] = [];
  let eligible = 0, alreadyAutoOnline = 0, newlyActivated = 0, blocked = 0;

  for (const row of providersRes.rows) {
    const uid = row.uid;
    const displayName = [row.first_name, row.last_name].filter(Boolean).join(' ') || uid;

    const [details, docs, svc, src, state] = await Promise.all([
      checkDetails(uid),
      checkDocuments(uid),
      checkServiceAssociation(uid),
      getSource(uid),
      getCurrentAutoOnlineState(uid),
    ]);

    const isEligible = details.complete && docs.complete && svc.complete && state?.activation_mode !== 'manual_admin_disabled';
    const blockers: string[] = [
      ...(!details.complete ? details.missingFields.map(f => `missing_${f}`) : []),
      ...(!docs.complete ? docs.missingRequiredTypes.map(t => `missing_doc_${t}`) : []),
      ...(!svc.complete ? ['no_service_association'] : []),
      ...(state?.activation_mode === 'manual_admin_disabled' ? ['admin_disabled'] : []),
    ];
    const actionsWouldApply: string[] = [];

    if (isEligible) {
      eligible++;
      if (state?.is_auto_online) {
        alreadyAutoOnline++;
      } else {
        actionsWouldApply.push('set_auto_online', 'generate_all_time_availability', 'generate_all_area_service_area', 'set_provisional_bookable_services');
        if (applyChanges) {
          await applyAutoOnline(uid, 'backfill', 'admin', actorUid);
          await evaluateProvider(uid, 'admin', actorUid);
          newlyActivated++;
        }
      }
    } else {
      blocked++;
    }

    rows.push({
      providerUid: uid,
      displayName,
      source: src.registrationSource,
      eligible: isEligible,
      blockers,
      actionsWouldApply,
    });
  }

  await writeAuditEvent(
    'system',
    applyChanges ? 'provider_auto_online_backfill_applied' : 'provider_auto_online_backfill_previewed',
    null,
    { scanned: providersRes.rows.length, eligible, newlyActivated },
    applyChanges ? 'backfill_apply' : 'backfill_preview',
    'admin',
    actorUid,
  );

  return { scanned: providersRes.rows.length, eligible, alreadyAutoOnline, newlyActivated, blocked, rows };
};

// ── Get auto-bookable provider UIDs for assignment ────────────────────────────

export const getAutoBookableProviderUids = async (serviceId?: number): Promise<string[]> => {
  await bootstrap();
  if (serviceId) {
    const res = await dbQuery.query(
      `SELECT DISTINCT p.provider_uid
       FROM ${s}.provider_auto_online_state p
       JOIN ${s}.provider_provisional_bookable_services pb ON pb.provider_uid = p.provider_uid
       WHERE p.is_auto_online = TRUE AND pb.status = 'active' AND pb.service_id = $1`,
      [serviceId]
    );
    return res.rows.map((r: any) => r.provider_uid);
  }

  const res = await dbQuery.query(
    `SELECT provider_uid FROM ${s}.provider_auto_online_state WHERE is_auto_online = TRUE`,
    []
  );
  return res.rows.map((r: any) => r.provider_uid);
};

// ── Get summary for Admin ─────────────────────────────────────────────────────

export const getAutoOnlineSummary = async () => {
  await bootstrap();
  const res = await dbQuery.query(
    `SELECT
       COUNT(*) FILTER (WHERE is_auto_online = TRUE)  AS auto_online_count,
       COUNT(*) FILTER (WHERE is_bookable = TRUE)     AS bookable_count,
       COUNT(*) FILTER (WHERE is_auto_online = FALSE) AS offline_count,
       COUNT(*) AS total
     FROM ${s}.provider_auto_online_state`,
    []
  );
  return res.rows[0] ?? { auto_online_count: 0, bookable_count: 0, offline_count: 0, total: 0 };
};

export const getAutoOnlineBlockers = async (page = 1, limit = 50) => {
  await bootstrap();
  const offset = (page - 1) * limit;
  const res = await dbQuery.query(
    `SELECT uc.uid, uc.first_name, uc.last_name, uc.email,
            p.activation_mode, p.last_evaluated_at,
            p.eligibility_snapshot->>'autoOnline' AS auto_online_snapshot
     FROM ${s}.user_credentials uc
     LEFT JOIN ${s}.provider_auto_online_state p ON p.provider_uid = uc.uid
     WHERE uc.role IN (2,4) AND uc.is_archive = FALSE
       AND (p.is_auto_online IS NULL OR p.is_auto_online = FALSE)
     ORDER BY uc.created_date DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return res.rows;
};
