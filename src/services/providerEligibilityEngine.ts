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
    notArchived:     boolean;
    hasActiveService: boolean;
    availabilityOk:  boolean;
    serviceAreaOk:   boolean;
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
            so.service_id
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
  const endAt   = new Date(new Date(startAt).getTime() + 2 * 60 * 60 * 1000).toISOString();

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
    notArchived:      false,
    hasActiveService: false,
    availabilityOk:   false,
    serviceAreaOk:    false,
  };

  // 1. Account status
  const accountRes = await dbQuery.query(
    `SELECT account_status, is_archive
     FROM ${s}.user_credentials
     WHERE uid = $1`,
    [providerUid]
  );

  if (!accountRes.rowCount) {
    reasons.push({ code: 'ACCOUNT_INACTIVE', severity: 'blocker', message: 'Provider account not found' });
    return { providerUid, eligible: false, score: 0, reasons, checks };
  }

  const account = accountRes.rows[0];

  if (account.account_status !== 'active') {
    reasons.push({ code: 'ACCOUNT_INACTIVE', severity: 'blocker', message: `Provider account status is "${account.account_status}"` });
  } else {
    checks.accountActive = true;
  }

  if (account.is_archive === true) {
    reasons.push({ code: 'ACCOUNT_ARCHIVED', severity: 'blocker', message: 'Provider account is archived' });
  } else {
    checks.notArchived = true;
  }

  // 2. Active service compatibility (if serviceId provided)
  if (slot.serviceId) {
    const serviceRes = await dbQuery.query(
      `SELECT 1 FROM ${s}.employee_services
       WHERE employee_uid = $1
         AND service_id = $2
       LIMIT 1`,
      [providerUid, slot.serviceId]
    );
    if (!serviceRes.rowCount) {
      reasons.push({
        code: 'NO_ACTIVE_SERVICE',
        severity: 'blocker',
        message: `Provider does not have service ${slot.serviceId} active`,
      });
    } else {
      checks.hasActiveService = true;
    }
  } else {
    checks.hasActiveService = true; // No service filter — not a blocker
    reasons.push({ code: 'NO_ACTIVE_SERVICE', severity: 'info', message: 'No service_id provided — service check skipped' });
  }

  // 3. Availability
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
    `SELECT b.id, b.schedule, b.branch_id, b.status, so.service_id
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
  const endAt   = new Date(new Date(startAt).getTime() + 2 * 60 * 60 * 1000).toISOString();

  // All active non-archived providers
  const providersRes = await dbQuery.query(
    `SELECT uc.uid, uc.first_name, uc.last_name, uc.email, uc.phone_number AS phone, uc.avatar_url
     FROM ${s}.user_credentials uc
     WHERE uc.account_status = 'active'
       AND uc.is_archive = false
       AND uc.role IN (2, 4)
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
