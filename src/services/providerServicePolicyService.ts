import dbQuery from '../db/dbQuery';
import { db } from '../config';

const s = db.schema;

type QueryRunner = (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }>;

export type ServicePolicyCode =
  | 'POLICY_NOT_CONFIGURED'
  | 'SERVICE_POLICY_INCOMPLETE'
  | 'PROVIDER_TYPE_NOT_SUPPORTED'
  | 'BRANCH_NOT_SUPPORTED'
  | 'SERVICE_AREA_NOT_SUPPORTED'
  | 'QUALIFICATION_REQUIRED'
  | 'POLICY_SATISFIED';

export interface ServicePolicyRequirement {
  id: string;
  type: string;
  required: boolean;
  state: 'verified' | 'pending' | 'action_required' | 'missing';
  description: string;
}

export interface ServicePolicyEvaluation {
  eligible: boolean;
  code: ServicePolicyCode;
  message: string;
  requirementsVersion: number;
  requirements: ServicePolicyRequirement[];
}

const strings = (value: unknown): string[] => Array.isArray(value)
  ? [...new Set(value.map((item) => String(item).trim()).filter(Boolean))]
  : [];

const overlaps = (left: string[], right: string[]) => left.some((value) => right.includes(value));

export async function evaluateServicePolicy(
  providerUid: string,
  serviceId: number,
  runner: QueryRunner = (sql, params = []) => dbQuery.query(sql, params),
): Promise<ServicePolicyEvaluation> {
  const offeringResult = await runner(
    `SELECT DISTINCT o.id, o.version AS offering_version,
            p.enforcement_state, p.allowed_provider_types,
            p.allowed_branch_ids, p.allowed_city_ids
     FROM ${s}.provider_catalog_offering_mappings m
     JOIN ${s}.provider_catalog_offerings o ON o.id = m.offering_id
     LEFT JOIN ${s}.provider_catalog_offering_policies p ON p.offering_id = o.id
     WHERE m.service_id = $1 AND m.is_active = TRUE
       AND o.status = 'active' AND o.provider_web_visible = TRUE
     ORDER BY o.id`,
    [serviceId],
  );
  const offerings = offeringResult.rows;
  const requirementsVersion = Math.max(1, ...offerings.map((row) => Number(row.offering_version ?? 1)));
  const enforced = offerings.filter((row) => row.enforcement_state === 'enforced');

  // Additive rollout compatibility: old services remain open until an admin
  // deliberately enforces policy. Once any mapping is enforced, every active
  // mapping must be enforced so a draft mapping cannot bypass the policy.
  if (!enforced.length) {
    return { eligible: true, code: 'POLICY_NOT_CONFIGURED', message: 'No service-specific policy is enforced.', requirementsVersion, requirements: [] };
  }
  if (enforced.length !== offerings.length) {
    return {
      eligible: false,
      code: 'SERVICE_POLICY_INCOMPLETE',
      message: 'This service is temporarily unavailable while eligibility rules are updated.',
      requirementsVersion,
      requirements: [],
    };
  }

  const providerResult = await runner(
    `SELECT uc.role, wsa.coverage_mode,
            COALESCE(wsa.city_ids, '[]'::jsonb) AS city_ids,
            COALESCE(wsa.branch_ids, '[]'::jsonb) AS branch_ids
     FROM ${s}.user_credentials uc
     LEFT JOIN ${s}.worker_service_areas wsa ON wsa.worker_uid = uc.uid
     WHERE uc.uid = $1 AND uc.role::int IN (2,4) LIMIT 1`,
    [providerUid],
  );
  const provider = providerResult.rows[0];
  const providerType = Number(provider?.role) === 4 ? 'organization_provider' : 'individual_provider';
  const providerCities = strings(provider?.city_ids);
  const providerBranches = strings(provider?.branch_ids);
  const coverageMode = String(provider?.coverage_mode ?? '');

  const requirementResult = await runner(
    `SELECT r.offering_id, r.requirement_key, r.document_type_id,
            r.provider_label, r.provider_description, r.is_required, dt.expiry_policy,
            d.id AS document_id, d.lifecycle_state, d.scan_status,
            d.expires_at, d.review_state
     FROM ${s}.provider_catalog_offering_requirements r
     JOIN ${s}.provider_document_types dt ON dt.document_type_id = r.document_type_id
     LEFT JOIN LATERAL (
       SELECT candidate.id, candidate.lifecycle_state, candidate.scan_status,
              candidate.expires_at, candidate.review_state
       FROM (
         SELECT wr.id, wr.lifecycle_state, wr.scan_status, wr.expires_at, wr.uploaded_at,
                COALESCE((
                SELECT prd.decision FROM ${s}.provider_requirement_decisions prd
                WHERE prd.worker_requirement_id = wr.id AND NOT prd.is_superseded
                ORDER BY prd.decided_at DESC LIMIT 1
                ), 'pending_review') AS review_state
         FROM ${s}.worker_requirements wr
         WHERE wr.worker_uid = $1 AND wr.requirement_type = r.document_type_id
           AND COALESCE(wr.lifecycle_state, '') NOT IN ('replaced','revoked')
       ) candidate
       ORDER BY (
         candidate.review_state = 'approved' AND candidate.scan_status = 'clean'
         AND (candidate.expires_at IS NULL OR candidate.expires_at > NOW())
       ) DESC, candidate.uploaded_at DESC LIMIT 1
     ) d ON TRUE
     WHERE r.offering_id = ANY($2) AND r.is_active = TRUE
     ORDER BY r.offering_id, r.display_order, r.id`,
    [providerUid, enforced.map((row) => Number(row.id))],
  );
  const byOffering = new Map<number, any[]>();
  for (const requirement of requirementResult.rows) {
    const id = Number(requirement.offering_id);
    byOffering.set(id, [...(byOffering.get(id) ?? []), requirement]);
  }

  let mostActionable: ServicePolicyEvaluation | null = null;
  for (const offering of enforced) {
    const allowedTypes = strings(offering.allowed_provider_types);
    if (allowedTypes.length && !allowedTypes.includes(providerType)) {
      mostActionable ??= blocked('PROVIDER_TYPE_NOT_SUPPORTED', 'This service is not available for your provider type.', requirementsVersion);
      continue;
    }
    const allowedBranches = strings(offering.allowed_branch_ids);
    if (allowedBranches.length && !overlaps(allowedBranches, providerBranches)) {
      mostActionable ??= blocked('BRANCH_NOT_SUPPORTED', 'Your configured branch coverage is not enabled for this service.', requirementsVersion);
      continue;
    }
    const allowedCities = strings(offering.allowed_city_ids);
    if (allowedCities.length && !['all', 'all_cities'].includes(coverageMode) && !overlaps(allowedCities, providerCities)) {
      mostActionable ??= blocked('SERVICE_AREA_NOT_SUPPORTED', 'This service is not enabled for your configured service area.', requirementsVersion);
      continue;
    }

    const requirements = (byOffering.get(Number(offering.id)) ?? []).map(presentRequirement);
    const missing = requirements.some((requirement) => requirement.required && requirement.state !== 'verified');
    if (missing) {
      mostActionable = {
        eligible: false,
        code: 'QUALIFICATION_REQUIRED',
        message: 'Complete the required verified qualifications before applying for this service.',
        requirementsVersion,
        requirements,
      };
      continue;
    }
    return {
      eligible: true,
      code: 'POLICY_SATISFIED',
      message: 'Provider meets the service-specific policy.',
      requirementsVersion,
      requirements,
    };
  }
  return mostActionable ?? blocked('SERVICE_POLICY_INCOMPLETE', 'This service is temporarily unavailable while eligibility rules are updated.', requirementsVersion);
}

const blocked = (code: ServicePolicyCode, message: string, requirementsVersion: number): ServicePolicyEvaluation => ({
  eligible: false, code, message, requirementsVersion, requirements: [],
});

const presentRequirement = (row: any): ServicePolicyRequirement => {
  const expired = row.expires_at && new Date(row.expires_at).getTime() <= Date.now();
  const requiredExpiryMissing = row.expiry_policy === 'required' && !row.expires_at;
  const verified = row.document_id && row.review_state === 'approved' && row.scan_status === 'clean' && !expired && !requiredExpiryMissing;
  const rejected = ['rejected', 'needs_resubmission'].includes(String(row.review_state));
  return {
    id: String(row.requirement_key),
    type: String(row.document_type_id),
    required: Boolean(row.is_required),
    state: verified ? 'verified' : rejected || expired ? 'action_required' : row.document_id ? 'pending' : 'missing',
    description: String(row.provider_description || row.provider_label),
  };
};
