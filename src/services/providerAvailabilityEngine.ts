/**
 * ProviderAvailabilityEngine — canonical availability management for Admin.
 *
 * Reads from and writes to the existing PostgreSQL tables (worker_availability,
 * worker_time_off) that the mobile app also uses, so changes made here are
 * immediately visible to mobile without any additional sync step.
 *
 * New capability columns (updated_by, version on availability; status,
 * created_by, cancelled_at, cancelled_by on time_off) are added via
 * ensureColumns() which uses ALTER TABLE … ADD COLUMN IF NOT EXISTS.
 *
 * MOBILE CONTRACT PROTECTION:
 *   - worker_availability:  PK = worker_uid, existing columns untouched
 *   - worker_time_off:      FK = worker_uid, existing columns untouched
 *   - New columns are nullable/defaulted so mobile reads zero impact
 *   - No provider.routes.ts / technician.routes.ts changes
 */

import dbQuery from '../db/dbQuery';
import { db } from '../config';

const s = db.schema;

// ── Schema bootstrap ──────────────────────────────────────────────────────────

const ensureAvailabilityColumns = async () => {
  await dbQuery.query(
    `CREATE TABLE IF NOT EXISTS ${s}.worker_availability (
       worker_uid TEXT PRIMARY KEY,
       schedule   JSONB NOT NULL DEFAULT '[]',
       timezone   TEXT NOT NULL DEFAULT 'Asia/Manila',
       updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    []
  );
  // Additive columns — safe for mobile (nullable / have defaults)
  await dbQuery.query(
    `ALTER TABLE ${s}.worker_availability
       ADD COLUMN IF NOT EXISTS updated_by TEXT,
       ADD COLUMN IF NOT EXISTS version    INTEGER NOT NULL DEFAULT 1`,
    []
  );
};

const ensureTimeOffColumns = async () => {
  await dbQuery.query(
    `CREATE TABLE IF NOT EXISTS ${s}.worker_time_off (
       id         SERIAL PRIMARY KEY,
       worker_uid TEXT NOT NULL,
       start_date DATE NOT NULL,
       end_date   DATE NOT NULL,
       reason     TEXT,
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    []
  );
  // Additive columns
  await dbQuery.query(
    `ALTER TABLE ${s}.worker_time_off
       ADD COLUMN IF NOT EXISTS created_by   TEXT,
       ADD COLUMN IF NOT EXISTS status       TEXT NOT NULL DEFAULT 'active',
       ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
       ADD COLUMN IF NOT EXISTS cancelled_by TEXT`,
    []
  );
};

// Bootstrap is called lazily on first use
let _bootstrapped = false;
const bootstrap = async () => {
  if (_bootstrapped) return;
  await Promise.all([ensureAvailabilityColumns(), ensureTimeOffColumns()]);
  _bootstrapped = true;
};

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WeeklyScheduleSlot {
  dayOfWeek: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  dayLabel: string;
  startTime: string;  // HH:mm
  endTime: string;    // HH:mm
  isAvailable: boolean;
  maxJobs?: number | null;
}

export interface ProviderTimeOff {
  id: number;
  startDate: string;    // YYYY-MM-DD (mobile-compatible field name)
  endDate: string;
  reason: string | null;
  status: 'active' | 'cancelled';
  createdAt: string;
  createdBy: string | null;
  cancelledAt: string | null;
  cancelledBy: string | null;
}

export interface ProviderAvailabilityProfile {
  providerUid: string;
  timezone: string;
  status: 'saved' | 'missing';
  weeklySchedule: WeeklyScheduleSlot[];
  /** Backward-compat alias for weeklySchedule */
  schedule: WeeklyScheduleSlot[];
  timeOff: ProviderTimeOff[];
  nextAvailableAt: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
  version: number;
  compatibility: {
    legacyWorkerAvailabilitySynced: boolean;
    source: 'canonical' | 'legacy' | 'missing';
  };
}

// ── Validation ────────────────────────────────────────────────────────────────

const TIME_RE = /^\d{2}:\d{2}$/;
const VALID_DOW = [0, 1, 2, 3, 4, 5, 6];
const DOW_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const validateWeeklySchedule = (slots: WeeklyScheduleSlot[]): string[] => {
  const errors: string[] = [];
  if (!Array.isArray(slots)) { errors.push('schedule must be an array'); return errors; }

  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    if (!VALID_DOW.includes(slot.dayOfWeek)) errors.push(`slot[${i}]: invalid dayOfWeek ${slot.dayOfWeek}`);
    if (!TIME_RE.test(slot.startTime))       errors.push(`slot[${i}]: startTime must be HH:mm`);
    if (!TIME_RE.test(slot.endTime))         errors.push(`slot[${i}]: endTime must be HH:mm`);
    if (slot.startTime >= slot.endTime)      errors.push(`slot[${i}]: startTime must be before endTime`);
    if (slot.maxJobs !== undefined && slot.maxJobs !== null && slot.maxJobs < 1)
                                             errors.push(`slot[${i}]: maxJobs must be >= 1`);
  }

  // Overlap check per day
  const byDay: Record<number, WeeklyScheduleSlot[]> = {};
  for (const slot of slots) {
    if (slot.isAvailable) {
      (byDay[slot.dayOfWeek] = byDay[slot.dayOfWeek] ?? []).push(slot);
    }
  }
  for (const [dow, daySlots] of Object.entries(byDay)) {
    const sorted = [...daySlots].sort((a, b) => a.startTime.localeCompare(b.startTime));
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].startTime < sorted[i - 1].endTime) {
        errors.push(`Day ${DOW_LABELS[Number(dow)]}: overlapping slots (${sorted[i - 1].startTime}–${sorted[i - 1].endTime} and ${sorted[i].startTime}–${sorted[i].endTime})`);
      }
    }
  }
  return errors;
};


// ── Read ──────────────────────────────────────────────────────────────────────

export const getAvailabilityProfile = async (providerUid: string): Promise<ProviderAvailabilityProfile> => {
  await bootstrap();

  const [availRes, timeOffRes] = await Promise.all([
    dbQuery.query(
      `SELECT worker_uid, schedule, timezone, updated_at, updated_by, version
       FROM ${s}.worker_availability WHERE worker_uid = $1`,
      [providerUid]
    ),
    dbQuery.query(
      `SELECT id, start_date, end_date, reason, created_at,
              COALESCE(status, 'active') AS status,
              created_by, cancelled_at, cancelled_by
       FROM ${s}.worker_time_off
       WHERE worker_uid = $1
       ORDER BY start_date ASC`,
      [providerUid]
    ),
  ]);

  const row = availRes.rows[0] ?? null;
  let rawSchedule = row?.schedule ?? null;

  // Normalize: legacy schedule stored as '{}' (JSONB object default) is not an array
  if (rawSchedule !== null && !Array.isArray(rawSchedule)) {
    rawSchedule = [];
  }
  const schedule: WeeklyScheduleSlot[] = (rawSchedule ?? []).map((sl: any) => ({
    dayOfWeek:   sl.dayOfWeek   ?? sl.day_of_week ?? 0,
    dayLabel:    sl.dayLabel    ?? sl.day_label   ?? DOW_LABELS[sl.dayOfWeek ?? 0] ?? '',
    startTime:   sl.startTime   ?? sl.start_time  ?? '09:00',
    endTime:     sl.endTime     ?? sl.end_time    ?? '17:00',
    isAvailable: sl.isAvailable ?? sl.is_available ?? false,
    maxJobs:     sl.maxJobs     ?? sl.max_jobs     ?? null,
  }));

  const timeOff: ProviderTimeOff[] = timeOffRes.rows.map((r: any) => ({
    id:          r.id,
    startDate:   r.start_date instanceof Date ? r.start_date.toISOString().slice(0, 10) : String(r.start_date).slice(0, 10),
    endDate:     r.end_date   instanceof Date ? r.end_date.toISOString().slice(0, 10)   : String(r.end_date).slice(0, 10),
    reason:      r.reason ?? null,
    status:      r.status ?? 'active',
    createdAt:   r.created_at,
    createdBy:   r.created_by   ?? null,
    cancelledAt: r.cancelled_at ?? null,
    cancelledBy: r.cancelled_by ?? null,
  }));

  const nextAvailableAt = computeNextAvailable(schedule, timeOff);

  return {
    providerUid,
    timezone:      row?.timezone   ?? 'Asia/Manila',
    status:        row            ? 'saved' : 'missing',
    weeklySchedule: schedule,
    schedule,       // backward-compat alias
    timeOff,
    nextAvailableAt,
    updatedAt:    row?.updated_at  ?? null,
    updatedBy:    row?.updated_by  ?? null,
    version:      Number(row?.version ?? 1),
    compatibility: {
      legacyWorkerAvailabilitySynced: true,
      source: row ? 'canonical' : 'missing',
    },
  };
};

// ── Save weekly schedule ──────────────────────────────────────────────────────

export const saveWeeklySchedule = async (
  providerUid: string,
  schedule: WeeklyScheduleSlot[],
  timezone: string,
  actorUid: string,
  expectedVersion?: number,
): Promise<{ version: number; updatedAt: string }> => {
  await bootstrap();

  const errors = validateWeeklySchedule(schedule);
  if (errors.length > 0) {
    const err: any = new Error(`Validation failed: ${errors.join('; ')}`);
    err.statusCode = 422;
    err.errors = errors;
    throw err;
  }

  if (!timezone) timezone = 'Asia/Manila';

  // Optimistic locking — if expectedVersion provided, enforce it
  if (expectedVersion !== undefined) {
    const currentRes = await dbQuery.query(
      `SELECT version FROM ${s}.worker_availability WHERE worker_uid = $1`,
      [providerUid]
    );
    const currentVersion = Number(currentRes.rows[0]?.version ?? 0);
    if (currentRes.rowCount && currentVersion !== expectedVersion) {
      const err: any = new Error(
        `Version conflict: expected ${expectedVersion} but backend has ${currentVersion}. Reload and try again.`
      );
      err.statusCode = 409;
      throw err;
    }
  }

  // Normalize slot shape to canonical before storing
  const normalized = schedule.map(sl => ({
    dayOfWeek:   sl.dayOfWeek,
    dayLabel:    DOW_LABELS[sl.dayOfWeek] ?? sl.dayLabel,
    startTime:   sl.startTime,
    endTime:     sl.endTime,
    isAvailable: sl.isAvailable,
    maxJobs:     sl.maxJobs ?? null,
  }));

  const res = await dbQuery.query(
    `INSERT INTO ${s}.worker_availability (worker_uid, schedule, timezone, updated_at, updated_by, version)
     VALUES ($1, $2, $3, NOW(), $4, 1)
     ON CONFLICT (worker_uid) DO UPDATE
       SET schedule   = EXCLUDED.schedule,
           timezone   = EXCLUDED.timezone,
           updated_at = NOW(),
           updated_by = $4,
           version    = ${s}.worker_availability.version + 1
     RETURNING updated_at, version`,
    [providerUid, JSON.stringify(normalized), timezone, actorUid]
  );

  return {
    version:   Number(res.rows[0].version),
    updatedAt: res.rows[0].updated_at,
  };
};

// ── Time-off CRUD ─────────────────────────────────────────────────────────────

export const listTimeOff = async (providerUid: string): Promise<ProviderTimeOff[]> => {
  await bootstrap();
  const res = await dbQuery.query(
    `SELECT id, start_date, end_date, reason, created_at,
            COALESCE(status, 'active') AS status,
            created_by, cancelled_at, cancelled_by
     FROM ${s}.worker_time_off
     WHERE worker_uid = $1
     ORDER BY start_date ASC`,
    [providerUid]
  );
  return res.rows.map((r: any) => ({
    id:          r.id,
    startDate:   r.start_date instanceof Date ? r.start_date.toISOString().slice(0, 10) : String(r.start_date).slice(0, 10),
    endDate:     r.end_date   instanceof Date ? r.end_date.toISOString().slice(0, 10)   : String(r.end_date).slice(0, 10),
    reason:      r.reason ?? null,
    status:      r.status ?? 'active',
    createdAt:   r.created_at,
    createdBy:   r.created_by   ?? null,
    cancelledAt: r.cancelled_at ?? null,
    cancelledBy: r.cancelled_by ?? null,
  }));
};

export const createTimeOff = async (
  providerUid: string,
  payload: { startDate: string; endDate: string; reason?: string },
  actorUid: string,
): Promise<ProviderTimeOff> => {
  await bootstrap();

  if (!payload.startDate || !payload.endDate) {
    const err: any = new Error('startDate and endDate are required');
    err.statusCode = 422;
    throw err;
  }
  if (payload.startDate > payload.endDate) {
    const err: any = new Error('endDate must be on or after startDate');
    err.statusCode = 422;
    throw err;
  }

  const res = await dbQuery.query(
    `INSERT INTO ${s}.worker_time_off (worker_uid, start_date, end_date, reason, created_by, status)
     VALUES ($1, $2, $3, $4, $5, 'active')
     RETURNING id, start_date, end_date, reason, created_at, created_by,
               COALESCE(status, 'active') AS status, cancelled_at, cancelled_by`,
    [providerUid, payload.startDate, payload.endDate, payload.reason ?? null, actorUid]
  );

  const r = res.rows[0];
  return {
    id:          r.id,
    startDate:   r.start_date instanceof Date ? r.start_date.toISOString().slice(0, 10) : String(r.start_date).slice(0, 10),
    endDate:     r.end_date   instanceof Date ? r.end_date.toISOString().slice(0, 10)   : String(r.end_date).slice(0, 10),
    reason:      r.reason ?? null,
    status:      'active',
    createdAt:   r.created_at,
    createdBy:   r.created_by ?? null,
    cancelledAt: null,
    cancelledBy: null,
  };
};

export const cancelTimeOff = async (
  providerUid: string,
  timeOffId: number,
  actorUid: string,
  reason?: string,
): Promise<ProviderTimeOff> => {
  await bootstrap();

  const res = await dbQuery.query(
    `UPDATE ${s}.worker_time_off
     SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = $3
     WHERE id = $1 AND worker_uid = $2 AND COALESCE(status, 'active') = 'active'
     RETURNING id, start_date, end_date, reason, created_at, created_by,
               status, cancelled_at, cancelled_by`,
    [timeOffId, providerUid, actorUid]
  );

  if (!res.rowCount) {
    const err: any = new Error('Time-off entry not found or already cancelled');
    err.statusCode = 404;
    throw err;
  }

  const r = res.rows[0];
  return {
    id:          r.id,
    startDate:   r.start_date instanceof Date ? r.start_date.toISOString().slice(0, 10) : String(r.start_date).slice(0, 10),
    endDate:     r.end_date   instanceof Date ? r.end_date.toISOString().slice(0, 10)   : String(r.end_date).slice(0, 10),
    reason:      reason ?? r.reason ?? null,
    status:      'cancelled',
    createdAt:   r.created_at,
    createdBy:   r.created_by   ?? null,
    cancelledAt: r.cancelled_at,
    cancelledBy: r.cancelled_by,
  };
};

// ── Availability check ────────────────────────────────────────────────────────

/**
 * Returns true if the provider's weekly schedule covers the given window
 * and no active time-off overlaps it.
 * startAt / endAt are ISO datetime strings.
 */
export const isProviderAvailableAt = async (
  providerUid: string,
  startAt: string,
  endAt: string,
): Promise<boolean> => {
  const explain = await explainAvailability(providerUid, startAt, endAt);
  return explain.available;
};

export interface AvailabilityExplanation {
  providerUid: string;
  startAt: string;
  endAt: string;
  available: boolean;
  reasons: Array<{ code: string; severity: 'info' | 'warning' | 'blocker'; message: string }>;
}

export const explainAvailability = async (
  providerUid: string,
  startAt: string,
  endAt: string,
): Promise<AvailabilityExplanation> => {
  await bootstrap();

  const reasons: AvailabilityExplanation['reasons'] = [];
  const bookingStart = new Date(startAt);
  const bookingEnd   = new Date(endAt);
  const dow = bookingStart.getDay() as 0 | 1 | 2 | 3 | 4 | 5 | 6;
  const bookingStartTime = `${String(bookingStart.getHours()).padStart(2, '0')}:${String(bookingStart.getMinutes()).padStart(2, '0')}`;
  const bookingEndTime   = `${String(bookingEnd.getHours()).padStart(2, '0')}:${String(bookingEnd.getMinutes()).padStart(2, '0')}`;

  const [availRes, timeOffRes, conflictRes] = await Promise.all([
    dbQuery.query(
      `SELECT schedule, timezone FROM ${s}.worker_availability WHERE worker_uid = $1`,
      [providerUid]
    ),
    dbQuery.query(
      `SELECT id, start_date, end_date FROM ${s}.worker_time_off
       WHERE worker_uid = $1
         AND COALESCE(status, 'active') = 'active'
         AND start_date <= $2::date AND end_date >= $3::date`,
      [providerUid, bookingStart.toISOString().slice(0, 10), bookingStart.toISOString().slice(0, 10)]
    ),
    // Booking conflict: active booking within ±2-hour window.
    // Admin-created bookings set worker_uid on the bookings row AND write a
    // booking_workers row — union both so admin bookings are caught too.
    dbQuery.query(
      `SELECT id FROM ${s}.bookings
       WHERE worker_uid = $1
         AND status NOT IN ('CANCELLED', 'COMPLETED')
         AND schedule BETWEEN $2::timestamptz - INTERVAL '2 hours'
                          AND $3::timestamptz + INTERVAL '2 hours'
       UNION
       SELECT b.id FROM ${s}.bookings b
       JOIN ${s}.booking_workers bw ON bw.booking_id = b.id
       WHERE bw.worker_uid = $1
         AND b.status NOT IN ('CANCELLED', 'COMPLETED')
         AND b.schedule BETWEEN $2::timestamptz - INTERVAL '2 hours'
                            AND $3::timestamptz + INTERVAL '2 hours'
       LIMIT 1`,
      [providerUid, startAt, startAt]
    ),
  ]);

  // 1. Time-off check
  if (timeOffRes.rowCount) {
    const to = timeOffRes.rows[0];
    reasons.push({
      code: 'TIME_OFF',
      severity: 'blocker',
      message: `Provider has time-off from ${to.start_date} to ${to.end_date}`,
    });
  }

  // 2. Booking conflict check
  if (conflictRes.rowCount) {
    reasons.push({
      code: 'BOOKING_CONFLICT',
      severity: 'blocker',
      message: `Provider has an existing booking within the ±2-hour window (booking #${conflictRes.rows[0].id})`,
    });
  }

  // 3. Weekly schedule check
  const rawSchedule = availRes.rows[0]?.schedule;
  if (!rawSchedule || !Array.isArray(rawSchedule) || rawSchedule.length === 0) {
    reasons.push({
      code: 'NO_AVAILABILITY_SET',
      severity: 'blocker',
      message: 'Provider has no weekly schedule configured — cannot confirm availability',
    });
  } else {
    const daySlots = (rawSchedule as any[]).filter(
      (sl: any) => sl.isAvailable && (sl.dayOfWeek ?? sl.day_of_week) === dow
    );
    if (daySlots.length === 0) {
      reasons.push({
        code: 'DAY_NOT_AVAILABLE',
        severity: 'blocker',
        message: `Provider is not available on ${DOW_LABELS[dow]}s`,
      });
    } else {
      const covered = daySlots.some((sl: any) => {
        const start = sl.startTime ?? sl.start_time;
        const end   = sl.endTime   ?? sl.end_time;
        return start <= bookingStartTime && end >= bookingEndTime;
      });
      if (!covered) {
        reasons.push({
          code: 'OUTSIDE_SCHEDULE_WINDOW',
          severity: 'blocker',
          message: `Booking time ${bookingStartTime}–${bookingEndTime} falls outside provider's ${DOW_LABELS[dow]} slots`,
        });
      }
    }
  }

  const blockers = reasons.filter(r => r.severity === 'blocker');
  return { providerUid, startAt, endAt, available: blockers.length === 0, reasons };
};

// ── Next available helper ─────────────────────────────────────────────────────

const computeNextAvailable = (
  schedule: WeeklyScheduleSlot[],
  timeOff: ProviderTimeOff[],
): string | null => {
  if (!schedule.some(s => s.isAvailable)) return null;

  const now = new Date();
  const activeTimeOff = timeOff.filter(t => t.status === 'active');

  for (let i = 0; i < 14; i++) {
    const candidate = new Date(now);
    candidate.setDate(now.getDate() + i);
    const dow = candidate.getDay();
    const dateStr = candidate.toISOString().slice(0, 10);

    // Check time-off
    const blocked = activeTimeOff.some(t => t.startDate <= dateStr && t.endDate >= dateStr);
    if (blocked) continue;

    // Check schedule
    const daySlots = schedule.filter(sl => sl.dayOfWeek === dow && sl.isAvailable);
    if (daySlots.length > 0) {
      const first = daySlots.sort((a, b) => a.startTime.localeCompare(b.startTime))[0];
      const [h, m] = first.startTime.split(':').map(Number);
      const result = new Date(candidate);
      result.setHours(h, m, 0, 0);
      if (result > now) return result.toISOString();
    }
  }
  return null;
};
