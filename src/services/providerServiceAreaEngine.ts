/**
 * ProviderServiceAreaEngine — canonical service-area management for Admin.
 *
 * Reads from and writes to the existing PostgreSQL worker_service_areas table
 * (PK = worker_uid) that the mobile app also uses.
 *
 * Additive columns (coverage_mode, branch_ids, radius_km, updated_by, version)
 * are added via ALTER TABLE … ADD COLUMN IF NOT EXISTS — zero impact on mobile.
 *
 * MOBILE CONTRACT PROTECTION:
 *   - worker_service_areas: PK = worker_uid, existing city_ids / label untouched
 *   - New columns are nullable/defaulted
 *   - No provider.routes.ts / technician.routes.ts changes
 */

import dbQuery from '../db/dbQuery';
import { db } from '../config';

const s = db.schema;

// -- Schema (TAB 02) ----------------------------------------------------------
//
// `worker_service_areas` was created here at runtime, behind a memoised
// `bootstrap()` awaited at the top of three operations. It now comes from
// `scripts/baseline/000-baseline.sql`, which carries every column and default
// this code declared -- including coverage_mode, branch_ids, radius_km,
// updated_by and version, which were added by a follow-up ALTER.
//
// `technicianService` also created this table. Removing this definition leaves
// one runtime creator; `npm run schema:authority` tracks the remaining contested
// objects and fails if a losing definition names a column the repository lacks.

// ── Types ─────────────────────────────────────────────────────────────────────

export type CoverageMode = 'city' | 'branch' | 'radius' | 'all_cities';

export type ServiceAreaIntent =
  | 'unconfigured'
  | 'all_cities'
  | 'restricted_city'
  | 'restricted_branch'
  | 'restricted_radius'
  | 'invalid';

export interface ProviderServiceAreaProfile {
  providerUid: string;
  status: 'saved' | 'missing';
  coverageMode: CoverageMode;
  cityIds: string[];
  branchIds: string[];
  radiusKm: number | null;
  label: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
  version: number;
  compatibility: {
    legacyWorkerServiceAreasSynced: boolean;
    source: 'canonical' | 'legacy' | 'missing';
  };
}

export interface ServiceAreaSavePayload {
  coverageMode: CoverageMode;
  cityIds?: string[];
  branchIds?: string[];
  radiusKm?: number | null;
  label?: string | null;
}

// ── Validation ────────────────────────────────────────────────────────────────

const VALID_MODES: CoverageMode[] = ['city', 'branch', 'radius', 'all_cities'];

export const validateServiceArea = (payload: ServiceAreaSavePayload): string[] => {
  const errors: string[] = [];

  if (!VALID_MODES.includes(payload.coverageMode)) {
    errors.push(`coverageMode must be one of: ${VALID_MODES.join(', ')}`);
  }

  if (payload.coverageMode === 'city') {
    if (!Array.isArray(payload.cityIds) || payload.cityIds.length === 0) {
      errors.push('cityIds must be a non-empty array when coverageMode is "city"');
    }
  }

  if (payload.coverageMode === 'branch') {
    if (!Array.isArray(payload.branchIds) || payload.branchIds.length === 0) {
      errors.push('branchIds must be a non-empty array when coverageMode is "branch"');
    }
  }

  if (payload.coverageMode === 'radius') {
    if (typeof payload.radiusKm !== 'number' || payload.radiusKm <= 0) {
      errors.push('radiusKm must be a positive number when coverageMode is "radius"');
    }
  }

  return errors;
};

// ── Read ──────────────────────────────────────────────────────────────────────

export const getServiceAreaProfile = async (providerUid: string): Promise<ProviderServiceAreaProfile> => {

  const res = await dbQuery.query(
    `SELECT worker_uid, city_ids, label, updated_at,
            COALESCE(coverage_mode, 'city') AS coverage_mode,
            COALESCE(branch_ids, '[]'::jsonb) AS branch_ids,
            radius_km, updated_by, COALESCE(version, 1) AS version
     FROM ${s}.worker_service_areas
     WHERE worker_uid = $1`,
    [providerUid]
  );

  const row = res.rows[0] ?? null;

  if (!row) {
    return {
      providerUid,
      status: 'missing',
      coverageMode: 'city',
      cityIds: [],
      branchIds: [],
      radiusKm: null,
      label: null,
      updatedAt: null,
      updatedBy: null,
      version: 1,
      compatibility: { legacyWorkerServiceAreasSynced: true, source: 'missing' },
    };
  }

  const cityIds   = Array.isArray(row.city_ids)   ? row.city_ids   : [];
  const branchIds = Array.isArray(row.branch_ids) ? row.branch_ids : [];

  return {
    providerUid,
    status: 'saved',
    coverageMode: row.coverage_mode as CoverageMode,
    cityIds,
    branchIds,
    radiusKm: row.radius_km !== null && row.radius_km !== undefined ? Number(row.radius_km) : null,
    label: row.label ?? null,
    updatedAt: row.updated_at ?? null,
    updatedBy: row.updated_by ?? null,
    version: Number(row.version),
    compatibility: { legacyWorkerServiceAreasSynced: true, source: 'canonical' },
  };
};

// ── Save ──────────────────────────────────────────────────────────────────────

export const saveServiceArea = async (
  providerUid: string,
  payload: ServiceAreaSavePayload,
  actorUid: string,
  expectedVersion?: number,
): Promise<{ version: number; updatedAt: string }> => {

  const errors = validateServiceArea(payload);
  if (errors.length > 0) {
    const err: any = new Error(`Validation failed: ${errors.join('; ')}`);
    err.statusCode = 422;
    err.errors = errors;
    throw err;
  }

  if (expectedVersion !== undefined) {
    const cur = await dbQuery.query(
      `SELECT version FROM ${s}.worker_service_areas WHERE worker_uid = $1`,
      [providerUid]
    );
    const currentVersion = Number(cur.rows[0]?.version ?? 0);
    if (cur.rowCount && currentVersion !== expectedVersion) {
      const err: any = new Error(
        `Version conflict: expected ${expectedVersion} but backend has ${currentVersion}. Reload and try again.`
      );
      err.statusCode = 409;
      throw err;
    }
  }

  const cityIds   = payload.cityIds   ?? [];
  const branchIds = payload.branchIds ?? [];
  const radiusKm  = payload.radiusKm  ?? null;
  const label     = payload.label     ?? null;

  const res = await dbQuery.query(
    `INSERT INTO ${s}.worker_service_areas
       (worker_uid, city_ids, label, updated_at, coverage_mode, branch_ids, radius_km, updated_by, version)
     VALUES ($1, $2, $3, NOW(), $4, $5, $6, $7, 1)
     ON CONFLICT (worker_uid) DO UPDATE
       SET city_ids      = EXCLUDED.city_ids,
           label         = EXCLUDED.label,
           updated_at    = NOW(),
           coverage_mode = EXCLUDED.coverage_mode,
           branch_ids    = EXCLUDED.branch_ids,
           radius_km     = EXCLUDED.radius_km,
           updated_by    = $7,
           version       = ${s}.worker_service_areas.version + 1
     RETURNING updated_at, version`,
    [providerUid, JSON.stringify(cityIds), label, payload.coverageMode, JSON.stringify(branchIds), radiusKm, actorUid]
  );

  return {
    version:   Number(res.rows[0].version),
    updatedAt: res.rows[0].updated_at,
  };
};

// ── Coverage check ────────────────────────────────────────────────────────────

export interface CoverageExplanation {
  providerUid: string;
  queryCityId: string | null;
  queryBranchId: string | null;
  covered: boolean;
  reasons: Array<{ code: string; severity: 'info' | 'warning' | 'blocker'; message: string }>;
}

export const isProviderInCoverage = async (
  providerUid: string,
  queryCityId: string | null,
  queryBranchId?: string | null,
): Promise<boolean> => {
  const result = await explainCoverage(providerUid, queryCityId, queryBranchId ?? null);
  return result.covered;
};

export const explainCoverage = async (
  providerUid: string,
  queryCityId: string | null,
  queryBranchId: string | null = null,
): Promise<CoverageExplanation> => {

  const reasons: CoverageExplanation['reasons'] = [];
  const profile = await getServiceAreaProfile(providerUid);

  if (profile.status === 'missing') {
    reasons.push({
      code: 'DEFAULT_ALL_CITIES',
      severity: 'info',
      message: 'Provider has no explicit service area — defaults to all Servana-supported cities',
    });
    return { providerUid, queryCityId, queryBranchId, covered: true, reasons };
  }

  switch (profile.coverageMode) {
    case 'all_cities':
      reasons.push({ code: 'ALL_CITIES_EXPLICIT', severity: 'info', message: 'Provider explicitly covers all Servana-supported cities' });
      return { providerUid, queryCityId, queryBranchId, covered: true, reasons };

    case 'city':
      if (!queryCityId) {
        reasons.push({ code: 'NO_CITY_QUERY', severity: 'warning', message: 'No city_id provided to check against city-mode coverage' });
        return { providerUid, queryCityId, queryBranchId, covered: false, reasons };
      }
      if (profile.cityIds.includes(queryCityId)) {
        reasons.push({ code: 'CITY_MATCH', severity: 'info', message: `City ${queryCityId} is in provider's covered cities` });
      } else {
        reasons.push({ code: 'CITY_NOT_IN_AREA', severity: 'blocker', message: `City ${queryCityId} is not in provider's service area` });
      }
      break;

    case 'branch':
      if (!queryBranchId) {
        reasons.push({ code: 'NO_BRANCH_QUERY', severity: 'warning', message: 'No branch_id provided to check against branch-mode coverage' });
        return { providerUid, queryCityId, queryBranchId, covered: false, reasons };
      }
      if (profile.branchIds.includes(queryBranchId)) {
        reasons.push({ code: 'BRANCH_MATCH', severity: 'info', message: `Branch ${queryBranchId} is in provider's covered branches` });
      } else {
        reasons.push({ code: 'BRANCH_NOT_IN_AREA', severity: 'blocker', message: `Branch ${queryBranchId} is not in provider's service branches` });
      }
      break;

    case 'radius':
      // Radius-mode coverage requires a geo lookup; return covered=true
      // with an info reason so callers handle appropriately
      reasons.push({
        code: 'RADIUS_MODE_GEO_REQUIRED',
        severity: 'info',
        message: `Provider uses radius mode (${profile.radiusKm} km) — geo-distance lookup required to confirm`,
      });
      return { providerUid, queryCityId, queryBranchId, covered: true, reasons };
  }

  const blockers = reasons.filter(r => r.severity === 'blocker');
  return { providerUid, queryCityId, queryBranchId, covered: blockers.length === 0, reasons };
};

// ── Intent classifier ─────────────────────────────────────────────────────────

export const resolveServiceAreaIntent = (profile: ProviderServiceAreaProfile): ServiceAreaIntent => {
  if (profile.status === 'missing') return 'unconfigured';
  if (profile.coverageMode === 'all_cities') return 'all_cities';
  if (profile.coverageMode === 'city') {
    return profile.cityIds.length > 0 ? 'restricted_city' : 'invalid';
  }
  if (profile.coverageMode === 'branch') {
    return profile.branchIds.length > 0 ? 'restricted_branch' : 'invalid';
  }
  if (profile.coverageMode === 'radius') {
    return profile.radiusKm !== null && profile.radiusKm > 0 ? 'restricted_radius' : 'invalid';
  }
  return 'invalid';
};

// ── Effective service area resolver ──────────────────────────────────────────

export interface EffectiveServiceArea {
  providerUid: string;
  intent: ServiceAreaIntent;
  coverageMode: CoverageMode | 'system_default';
  cityIds: string[];
  branchIds: string[];
  radiusKm: number | null;
  source: 'explicit' | 'system_default';
}

export const getEffectiveServiceArea = async (providerUid: string): Promise<EffectiveServiceArea> => {
  const profile = await getServiceAreaProfile(providerUid);
  const intent  = resolveServiceAreaIntent(profile);

  if (intent === 'unconfigured') {
    return {
      providerUid,
      intent,
      coverageMode: 'system_default',
      cityIds:   [],
      branchIds: [],
      radiusKm:  null,
      source: 'system_default',
    };
  }

  return {
    providerUid,
    intent,
    coverageMode: profile.coverageMode,
    cityIds:   profile.cityIds,
    branchIds: profile.branchIds,
    radiusKm:  profile.radiusKm,
    source: 'explicit',
  };
};
