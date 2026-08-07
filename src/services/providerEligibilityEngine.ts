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

const s = db.schema;

// ── Types ─────────────────────────────────────────────────────────────────────

export type EligibilityCheckCode =
  | 'ACCOUNT_INACTIVE'
  | 'ACCOUNT_ARCHIVED'
  | 'NO_ACTIVE_SERVICE'
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
  // Fetch booking details — service_id is on service_options, not bookings directly
  const bookingRes = await dbQuery.query(
    `SELECT b.id, b.schedule, b.branch_id, b.worker_uid, b.status,
            so.service_id, COALESCE(so.duration_mins, 120) AS duration_mins
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
    serviceId:  booking.service_id  ? String(booking.service_id)  : null,
    cityId:     null,   // bookings do not have a city_id column; area check skipped
    branchId:   booking.branch_id   ? String(booking.branch_id)   : null,
  });
};

interface BookingSlot {
  startAt: string;
  endAt: string;
  serviceId: string | null;
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
     WHERE uc.uid = $1 AND uc.role::int IN (2, 4)`,
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

  // 2. Active service compatibility (if serviceId provided)
  if (slot.serviceId) {
    const serviceRes = await dbQuery.query(
      `SELECT 1 FROM ${s}.employee_services
       WHERE employee_uid = $1
         AND service_id = $2
         AND COALESCE(status, 'active') = 'active'
       LIMIT 1`,
      [providerUid, slot.serviceId]
    );
    if (!serviceRes.rows.length) {
      // Check application status so admin gets an actionable reason
      const appRes = await dbQuery.query(
        `SELECT status FROM ${s}.worker_service_applications
         WHERE worker_uid = $1 AND service_id = $2
         ORDER BY submitted_at DESC LIMIT 1`,
        [providerUid, slot.serviceId]
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

export const listAssignmentCandidates = async (
  bookingId: string,
): Promise<AssignmentCandidate[]> => {
  // Fetch booking
  const bookingRes = await dbQuery.query(
    `SELECT b.id, b.schedule, b.branch_id, b.status, so.service_id,
            COALESCE(so.duration_mins, 120) AS duration_mins
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
       AND uc.role::int IN (2, 4)
     ORDER BY uc.first_name, uc.last_name`,
    []
  );

  // Evaluate all in parallel (bounded to 20 max to avoid DB flood)
  const providerRows = providersRes.rows.slice(0, 20);

  const slot: BookingSlot = {
    startAt,
    endAt,
    serviceId: booking.service_id ? String(booking.service_id) : null,
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
  return results.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    return b.score - a.score;
  });
};
