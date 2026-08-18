/**
 * ProviderEligibilityEngine — determines whether a provider can be assigned
 * to a booking, and ranks a pool of candidates.
 *
 * All checks are read-only against existing tables. No writes. No new tables.
 * Never called from provider.routes.ts or mobile routes — Admin-only.
 */

import dbQuery from '../db/dbQuery';
import { db } from '../config';
import { explainAvailability, AvailabilityExplanation } from './providerAvailabilityEngine';
import { explainCoverage,    CoverageExplanation    } from './providerServiceAreaEngine';
import { calculateCompliance } from './providerProfileComplianceService';
import { evaluateServicePolicy } from './providerServicePolicyService';
import {
  PROVIDER_CAPABILITY_SQL,
  CAPABLE_PROVIDER_COUNT_SQL,
  bookingCanonicalServiceSql,
  serviceDurationMinsSql,
} from './booking/eligibilityPipeline';
import {
  classifyCapabilityRows,
  recordCapabilityDecision,
} from './booking/capabilitySource';
import {
  summariseCandidatePool,
  type CandidatePoolDiagnostics,
} from './booking/candidateDiagnostics';
import { providerRoleSqlPredicate } from '../constants/providerRoles';

const s = db.schema;

/**
 * How many providers are evaluated per candidate request.
 *
 * A bound is necessary — each provider costs several queries — but a bound
 * applied to a name-ordered list is a filter nobody declared, and for most of
 * this system's life it was applied silently. It is named here and REPORTED in
 * the diagnostics, so "no providers available" can never again mean "the ones
 * who could do it sort after the twentieth first name".
 */
export const CANDIDATE_POOL_CAP = 20;

// ── Types ─────────────────────────────────────────────────────────────────────

export type EligibilityCheckCode =
  | 'ACCOUNT_INACTIVE'
  | 'ACCOUNT_ARCHIVED'
  | 'NO_ACTIVE_SERVICE'
  | 'SERVICE_GRANT_INACTIVE'
  | 'TIME_OFF'
  | 'BOOKING_CONFLICT'
  | 'NO_AVAILABILITY_SET'
  | 'DAY_NOT_AVAILABLE'
  | 'OUTSIDE_SCHEDULE_WINDOW'
  | 'NO_SERVICE_AREA'
  | 'CITY_NOT_IN_AREA'
  | 'BRANCH_NOT_IN_AREA'
  | 'DEFAULT_ALL_CITIES'
  | 'ELIGIBLE';

export interface EligibilityReason {
  code: EligibilityCheckCode | string;
  severity: 'info' | 'warning' | 'blocker';
  message: string;
}

export interface ProviderEligibilityResult {
  providerUid: string;
  eligible: boolean;
  score: number;        // 0–100, higher = better candidate
  reasons: EligibilityReason[];
  checks: {
    accountActive:   boolean;
    activationActive: boolean;
    notArchived:     boolean;
    hasActiveService: boolean;
    servicePolicyOk: boolean;
    availabilityOk:  boolean;
    serviceAreaOk:   boolean;
    complianceOk:    boolean;
  };
}

export interface AssignmentCandidate extends ProviderEligibilityResult {
  provider: {
    uid: string;
    name: string;
    email: string;
    phone: string | null;
    avatarUrl: string | null;
    activeServices: string[];
  };
}

// ── Single-provider evaluation ────────────────────────────────────────────────

export const evaluateProviderForBooking = async (
  providerUid: string,
  bookingId: string,
): Promise<ProviderEligibilityResult> => {
  // TWO service ids. `so.service_id` is the legacy FAMILY the old grant tables
  // key on; the canonical `services.id` is what catalog_provider_services keys
  // on. Asking for only the family makes the canonical source unaskable.
  const bookingRes = await dbQuery.query(
    `SELECT b.id, b.schedule, b.branch_id, b.worker_uid, b.status,
            so.service_id AS legacy_family_id,
            ${bookingCanonicalServiceSql(s)} AS canonical_service_id,
            ${serviceDurationMinsSql('so')} AS duration_mins
     FROM ${s}.bookings b
     LEFT JOIN ${s}.service_options so ON so.id = b.service_option_id
     WHERE b.id = $1`,
    [bookingId]
  );

  if (!bookingRes.rowCount) {
    const err: any = new Error(`Booking ${bookingId} not found`);
    err.statusCode = 404;
    throw err;
  }

  const booking = bookingRes.rows[0];
  const startAt = booking.schedule;
  const endAt   = new Date(new Date(startAt).getTime() + Number(booking.duration_mins) * 60 * 1000).toISOString();

  return evaluateProviderForSlot(providerUid, {
    startAt,
    endAt,
    serviceId:      booking.canonical_service_id ? String(booking.canonical_service_id) : null,
    legacyFamilyId: booking.legacy_family_id     ? String(booking.legacy_family_id)     : null,
    cityId:     null,   // bookings do not have a city_id column; area check skipped
    branchId:   booking.branch_id   ? String(booking.branch_id)   : null,
  });
};

interface BookingSlot {
  startAt: string;
  endAt: string;
  /** Canonical `services.id`. What `catalog_provider_services` keys on. */
  serviceId: string | null;
  /**
   * Legacy `service_families.id`, for the instrumented fallback.
   *
   * Optional: a caller that only knows the canonical id passes nothing and gets
   * a canonical-only answer, which is the end state. While the fallback lives,
   * omitting it NARROWS the result, so the booking paths pass both.
   */
  legacyFamilyId?: string | null;
  cityId: string | null;
  branchId: string | null;
}

export const evaluateProviderForSlot = async (
  providerUid: string,
  slot: BookingSlot,
): Promise<ProviderEligibilityResult> => {
  const reasons: EligibilityReason[] = [];
  const checks = {
    accountActive:    false,
    activationActive: false,
    notArchived:      false,
    hasActiveService: false,
    servicePolicyOk:  false,
    availabilityOk:   false,
    serviceAreaOk:    false,
    complianceOk:     false,
  };

  // 1. Account status
  const accountRes = await dbQuery.query(
    `SELECT uc.account_status, uc.is_archive, pa.activation_status
     FROM ${s}.user_credentials uc
     LEFT JOIN ${s}.provider_activation pa ON pa.provider_uid = uc.uid
     WHERE uc.uid = $1 AND ${providerRoleSqlPredicate('uc.role')}`,
    [providerUid]
  );

  if (!accountRes.rows.length) {
    reasons.push({ code: 'ACCOUNT_INACTIVE', severity: 'blocker', message: 'Provider account not found or UID does not belong to a provider role' });
    return { providerUid, eligible: false, score: 0, reasons, checks };
  }

  const account = accountRes.rows[0];

  if (account.account_status !== 'active') {
    const displayStatus = account.account_status ?? 'not yet activated';
    reasons.push({ code: 'ACCOUNT_INACTIVE', severity: 'blocker', message: `Provider account status is "${displayStatus}"` });
  } else {
    checks.accountActive = true;
  }

  if (account.is_archive === true) {
    reasons.push({ code: 'ACCOUNT_ARCHIVED', severity: 'blocker', message: 'Provider account is archived' });
  } else {
    checks.notArchived = true;
  }

  if (account.activation_status !== 'ACTIVE') {
    reasons.push({ code: 'PROVIDER_ACTIVATION_NOT_ACTIVE', severity: 'blocker', message: 'Provider activation is not active' });
  } else {
    checks.activationActive = true;
  }

  // 2. Canonical service capability (if serviceId provided)
  //
  // ── The preview moves to meet the committer ──────────────────────────────
  //
  // This used to ask a THIRD question: employee_services with an active status,
  // and nothing else. The executor — the predicate that decides real
  // assignments — accepts an employee_services row at ANY status OR an approved
  // worker_service_application. So this list was strictly NARROWER than what
  // the assign call would accept, and a narrower candidate list does not fail
  // safe: it hides providers who are in fact assignable, with no message.
  //
  // It now runs `PROVIDER_CAPABILITY_SQL` itself, so preview and commit cannot
  // answer differently about the same provider. Tightening BOTH — filtering
  // employee_services.status everywhere — is a separate declared change, and is
  // blocked on the lazy-DDL hazard recorded in `eligibilityPipeline.ts`.
  if (slot.serviceId || slot.legacyFamilyId) {
    const serviceRes = await dbQuery.query(
      PROVIDER_CAPABILITY_SQL(s),
      [providerUid, slot.serviceId ?? null, slot.legacyFamilyId ?? null]
    );
    const decision = classifyCapabilityRows(serviceRes.rows);
    recordCapabilityDecision(decision, {
      canonicalServiceId: slot.serviceId,
      legacyFamilyId: slot.legacyFamilyId,
    });

    if (!decision.qualified) {
      // Check application status so admin gets an actionable reason. Keyed on
      // the FAMILY, because that is the grain a provider applies in.
      const appRes = await dbQuery.query(
        `SELECT status FROM ${s}.worker_service_applications
         WHERE worker_uid = $1 AND service_id = $2
         ORDER BY submitted_at DESC LIMIT 1`,
        [providerUid, slot.legacyFamilyId ?? slot.serviceId]
      );
      const appStatus: string | null = appRes.rows[0]?.status ?? null;
      const msg = appStatus === 'pending_review'
        ? `Provider's application for service ${slot.serviceId} is pending review`
        : appStatus === 'action_required'
        ? `Provider's application for service ${slot.serviceId} requires action before approval`
        : appStatus === 'rejected'
        ? `Provider's application for service ${slot.serviceId} was rejected`
        : `Provider has not applied for service ${slot.serviceId}`;
      reasons.push({ code: 'NO_ACTIVE_SERVICE', severity: 'blocker', message: msg });
    } else {
      checks.hasActiveService = true;

      /**
       * Qualified only by the LEGACY family grant.
       *
       * Not a blocker — the executor accepts it, and refusing here would hide
       * an assignable provider. It is a warning because it is a missing
       * `catalog_provider_services` row: the canonical table should have
       * answered and did not, and the operator seeing this candidate ranked
       * lower is the visible edge of an adoption gap the reconciler closes.
       */
      if (decision.legacyOnly) {
        reasons.push({
          code: 'CAPABILITY_LEGACY_FALLBACK',
          severity: 'warning',
          message: 'Qualified through the legacy family grant only — no canonical capability row',
        });
      }

      // Qualified — but say so when the ONLY grant is a non-active
      // employee_services row. The executor would commit this provider, so it
      // must not be hidden; an operator picking between candidates should still
      // see it, and the warning costs the candidate rank rather than eligibility.
      //
      // Probed separately and defensively: `employee_services.status` is created
      // by lazy DDL, so on a path where that bootstrap has not run the column is
      // absent. A failure here means "cannot tell", which is not a finding.
      try {
        const grantRes = await dbQuery.query(
          `SELECT
             EXISTS (SELECT 1 FROM ${s}.employee_services
                      WHERE employee_uid = $1 AND service_id = $2
                        AND COALESCE(status, 'active') = 'active') AS active_grant,
             EXISTS (SELECT 1 FROM ${s}.worker_service_applications
                      WHERE worker_uid = $1 AND service_id = $2
                        AND status = 'approved') AS approved_application,
             EXISTS (SELECT 1 FROM ${s}.catalog_provider_services
                      WHERE provider_uid = $1 AND service_id = $3
                        AND status = 'active') AS canonical_grant`,
          [providerUid, slot.legacyFamilyId ?? slot.serviceId, slot.serviceId ?? null]
        );
        const grant = grantRes.rows[0];
        // The canonical row settles it: a provider with one is qualified at the
        // bookable grain regardless of what the legacy family row's status says.
        if (grant && grant.canonical_grant === false
            && grant.active_grant === false && grant.approved_application === false) {
          reasons.push({
            code: 'SERVICE_GRANT_INACTIVE',
            severity: 'warning',
            message: `Provider qualifies for service ${slot.serviceId} only through an inactive service grant`,
          });
        }
      } catch { /* column absent — cannot tell, so claim nothing */ }
    }
  } else {
    checks.hasActiveService = true; // No service filter — not a blocker
    reasons.push({ code: 'NO_ACTIVE_SERVICE', severity: 'info', message: 'No service_id provided — service check skipped' });
  }

  if (!slot.serviceId) checks.servicePolicyOk = true;
  if (slot.serviceId) {
    try {
      const policy = await evaluateServicePolicy(providerUid, Number(slot.serviceId));
      if (policy.eligible) {
        checks.servicePolicyOk = true;
      } else {
        reasons.push({ code: policy.code, severity: 'blocker', message: policy.message });
      }
    } catch {
      reasons.push({ code: 'SERVICE_POLICY_UNAVAILABLE', severity: 'blocker', message: 'Service policy could not be verified' });
    }
  }

  // 4. Compliance and availability
  // Command 24 compliance. Unknown/unavailable state is not permission.
  try {
    const compliance = await calculateCompliance(providerUid);
    if (compliance.state === 'compliant' || compliance.state === 'expiring_soon') {
      checks.complianceOk = true;
    } else {
      reasons.push({
        code: 'PROVIDER_COMPLIANCE_BLOCKED',
        severity: 'blocker',
        message: 'Provider compliance requirements are not current',
      });
    }
  } catch {
    reasons.push({
      code: 'PROVIDER_COMPLIANCE_UNAVAILABLE',
      severity: 'blocker',
      message: 'Provider compliance could not be verified',
    });
  }

  let availExplain: AvailabilityExplanation | null = null;
  try {
    availExplain = await explainAvailability(providerUid, slot.startAt, slot.endAt);
    if (availExplain.available) {
      checks.availabilityOk = true;
    } else {
      for (const r of availExplain.reasons) {
        reasons.push({ code: r.code, severity: r.severity, message: r.message });
      }
    }
  } catch {
    reasons.push({ code: 'NO_AVAILABILITY_SET', severity: 'warning', message: 'Could not evaluate availability' });
  }

  // 4. Service area
  let coverExplain: CoverageExplanation | null = null;
  try {
    coverExplain = await explainCoverage(providerUid, slot.cityId, slot.branchId);
    if (coverExplain.covered) {
      checks.serviceAreaOk = true;
    } else {
      for (const r of coverExplain.reasons) {
        reasons.push({ code: r.code, severity: r.severity, message: r.message });
      }
    }
  } catch {
    reasons.push({ code: 'NO_SERVICE_AREA', severity: 'warning', message: 'Could not evaluate service area' });
  }

  const blockers  = reasons.filter(r => r.severity === 'blocker');
  const eligible  = blockers.length === 0;

  // Score: 100 base, −20 per warning (info doesn't count against)
  const warnings = reasons.filter(r => r.severity === 'warning');
  const score    = eligible ? Math.max(0, 100 - warnings.length * 20) : 0;

  if (eligible) {
    reasons.push({ code: 'ELIGIBLE', severity: 'info', message: 'Provider meets all eligibility criteria' });
  }

  return { providerUid, eligible, score, reasons, checks };
};

// ── Assignment candidates ─────────────────────────────────────────────────────

export interface AssignmentCandidatePool {
  candidates: AssignmentCandidate[];
  diagnostics: CandidatePoolDiagnostics;
}

/**
 * The candidate pool WITH its diagnosis.
 *
 * `listAssignmentCandidates` remains the array-returning entry point for
 * existing callers; this is the one that also answers "and why is it this
 * size?". Both run the same evaluation — there is no second pool.
 */
export const listAssignmentCandidatePool = async (
  bookingId: string,
): Promise<AssignmentCandidatePool> => {
  // Fetch booking
  const bookingRes = await dbQuery.query(
    `SELECT b.id, b.schedule, b.branch_id, b.status,
            so.service_id AS legacy_family_id,
            ${bookingCanonicalServiceSql(s)} AS canonical_service_id,
            ${serviceDurationMinsSql('so')} AS duration_mins
     FROM ${s}.bookings b
     LEFT JOIN ${s}.service_options so ON so.id = b.service_option_id
     WHERE b.id = $1`,
    [bookingId]
  );
  if (!bookingRes.rowCount) {
    const err: any = new Error(`Booking ${bookingId} not found`);
    err.statusCode = 404;
    throw err;
  }
  const booking = bookingRes.rows[0];
  const startAt = booking.schedule;
  const endAt   = new Date(new Date(startAt).getTime() + Number(booking.duration_mins) * 60 * 1000).toISOString();

  // All active non-archived providers
  const providersRes = await dbQuery.query(
    `SELECT uc.uid, uc.first_name, uc.last_name, uc.email, uc.phone_number AS phone, uc.avatar_url
     FROM ${s}.user_credentials uc
     WHERE uc.account_status = 'active'
       AND uc.is_archive = false
       AND ${providerRoleSqlPredicate('uc.role')}
     ORDER BY uc.first_name, uc.last_name`,
    []
  );

  // Evaluate in parallel, bounded to avoid a DB flood. The bound is reported —
  // see CANDIDATE_POOL_CAP.
  const population   = providersRes.rows.length;
  const providerRows = providersRes.rows.slice(0, CANDIDATE_POOL_CAP);

  /**
   * The denominator. Counted independently of the population above, because
   * that query is already filtered by account state — asking it how many
   * providers HOLD the service would answer "none" for a service whose only
   * providers are deactivated, which is the exact confusion this resolves.
   *
   * A failure is reported as unmeasured (`null`), never as zero: a broken
   * count that reads as "nobody holds this service" would manufacture the
   * outage it exists to detect.
   */
  let capable: number | null = null;
  let capableCanonical: number | null = null;
  let capableLegacyOnly: number | null = null;
  if (booking.canonical_service_id || booking.legacy_family_id) {
    try {
      const capRes = await dbQuery.query(CAPABLE_PROVIDER_COUNT_SQL(s), [
        booking.canonical_service_id ?? null,
        booking.legacy_family_id ?? null,
      ]);
      capable          = Number(capRes.rows[0]?.capable ?? 0);
      capableCanonical = Number(capRes.rows[0]?.canonical ?? 0);
      // The adoption gap for THIS service: providers the fallback is carrying.
      capableLegacyOnly = Number(capRes.rows[0]?.legacy_only ?? 0);
    } catch { capable = null; capableCanonical = null; capableLegacyOnly = null; }
  }

  const slot: BookingSlot = {
    startAt,
    endAt,
    serviceId:      booking.canonical_service_id ? String(booking.canonical_service_id) : null,
    legacyFamilyId: booking.legacy_family_id     ? String(booking.legacy_family_id)     : null,
    cityId:    null,
    branchId:  booking.branch_id  ? String(booking.branch_id)  : null,
  };

  const results = await Promise.all(
    providerRows.map(async (row: any) => {
      const eligibility = await evaluateProviderForSlot(row.uid, slot);

      // Fetch active services for display
      let activeServices: string[] = [];
      try {
        const svcRes = await dbQuery.query(
          `SELECT service_id FROM ${s}.employee_services WHERE employee_uid = $1`,
          [row.uid]
        );
        activeServices = svcRes.rows.map((r: any) => String(r.service_id));
      } catch { /* ignore */ }

      const candidate: AssignmentCandidate = {
        ...eligibility,
        provider: {
          uid:            row.uid,
          name:           `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim(),
          email:          row.email,
          phone:          row.phone ?? null,
          avatarUrl:      row.avatar_url ?? null,
          activeServices,
        },
      };
      return candidate;
    })
  );

  // Sort: eligible first, then by score desc
  const candidates = results.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    return b.score - a.score;
  });

  return {
    candidates,
    diagnostics: summariseCandidatePool({
      capability: {
        canonicalServiceId: booking.canonical_service_id ?? null,
        legacyFamilyId: booking.legacy_family_id ?? null,
        capableCanonical,
        capableLegacyOnly,
      },
      serviceId: booking.canonical_service_id ?? booking.legacy_family_id ?? null,
      population,
      cap: CANDIDATE_POOL_CAP,
      capable,
      candidates,
    }),
  };
};

/**
 * The pool as a plain list.
 *
 * Kept because live Admin callers consume an array; it delegates rather than
 * evaluating separately, so the list and the diagnosis can never describe
 * different pools.
 */
export const listAssignmentCandidates = async (
  bookingId: string,
): Promise<AssignmentCandidate[]> => (await listAssignmentCandidatePool(bookingId)).candidates;
