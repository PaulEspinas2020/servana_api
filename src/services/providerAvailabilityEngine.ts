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
import { pool } from '../db/dbQuery';
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
       ADD COLUMN IF NOT EXISTS cancelled_by TEXT,
       -- C22 §17. The provider web portal has shipped a partial-day time-off
       -- form since before this table existed: an "All day" checkbox that,
       -- when cleared, collects a start and end time. The route destructured
       -- those fields and passed only the dates on, and there were no columns
       -- to hold them — so a provider asking for two hours off lost the whole
       -- day, silently, and the response echoed allDay: true.
       ADD COLUMN IF NOT EXISTS all_day    BOOLEAN NOT NULL DEFAULT TRUE,
       ADD COLUMN IF NOT EXISTS start_time TIME,
       ADD COLUMN IF NOT EXISTS end_time   TIME,
       ADD COLUMN IF NOT EXISTS note       TEXT`,
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

import { zonedParts, zonedDateTimeToUtc, operationalDate, OPERATIONAL_TIMEZONE } from './operationalTimezone';

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
  /** False only for a single-day window with explicit start and end times. */
  allDay: boolean;
  startTime: string | null;  // HH:mm, null when allDay
  endTime: string | null;    // HH:mm, null when allDay
  note: string | null;
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
  if (slots.length > 100) { errors.push('schedule cannot contain more than 100 slots'); return errors; }

  const validTime = (value: unknown): value is string => {
    if (typeof value !== 'string' || !TIME_RE.test(value)) return false;
    const [hour, minute] = value.split(':').map(Number);
    return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
  };

  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    if (!slot || typeof slot !== 'object') { errors.push(`slot[${i}]: must be an object`); continue; }
    if (!Number.isInteger(slot.dayOfWeek) || !VALID_DOW.includes(slot.dayOfWeek))
      errors.push(`slot[${i}]: invalid dayOfWeek ${slot.dayOfWeek}`);
    const startValid = validTime(slot.startTime);
    const endValid = validTime(slot.endTime);
    if (!startValid) errors.push(`slot[${i}]: startTime must be a real HH:mm time`);
    if (!endValid)   errors.push(`slot[${i}]: endTime must be a real HH:mm time`);
    if (startValid && endValid && slot.startTime >= slot.endTime)
      errors.push(`slot[${i}]: startTime must be before endTime`);
    if (typeof slot.isAvailable !== 'boolean')
      errors.push(`slot[${i}]: isAvailable must be boolean`);
    if (slot.maxJobs !== undefined && slot.maxJobs !== null &&
        (!Number.isInteger(slot.maxJobs) || slot.maxJobs < 1 || slot.maxJobs > 100))
      errors.push(`slot[${i}]: maxJobs must be an integer from 1 to 100`);
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
              COALESCE(all_day, TRUE) AS all_day,
              to_char(start_time, 'HH24:MI') AS start_time,
              to_char(end_time,   'HH24:MI') AS end_time,
              note,
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
    allDay:      r.all_day !== false,
    startTime:   r.start_time ?? null,
    endTime:     r.end_time ?? null,
    note:        r.note ?? null,
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
    // Version zero is the compare-and-set token for a record that does not
    // exist yet. Returning one here made a provider's very first save look
    // stale as soon as clients began sending expectedVersion.
    version:      row ? Number(row.version ?? 1) : 0,
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

  if (!timezone) timezone = OPERATIONAL_TIMEZONE;
  if (timezone !== OPERATIONAL_TIMEZONE) {
    const err: any = new Error(`timezone must be ${OPERATIONAL_TIMEZONE}`);
    err.statusCode = 422;
    throw err;
  }

  // Optimistic locking — if expectedVersion provided, enforce it
  if (expectedVersion !== undefined &&
      (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0)) {
    const err: any = new Error('expectedVersion must be a non-negative integer');
    err.statusCode = 422;
    throw err;
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
     SELECT $1, $2::jsonb, $3, NOW(), $4, 1
      WHERE $5::integer IS NULL
         OR $5::integer = 0
         OR EXISTS (
              SELECT 1 FROM ${s}.worker_availability current
               WHERE current.worker_uid = $1
                 AND current.version = $5::integer
            )
     ON CONFLICT (worker_uid) DO UPDATE
       SET schedule   = EXCLUDED.schedule,
           timezone   = EXCLUDED.timezone,
           updated_at = NOW(),
           updated_by = $4,
           version    = ${s}.worker_availability.version + 1
       WHERE $5::integer IS NULL
          OR ${s}.worker_availability.version = $5::integer
     RETURNING updated_at, version`,
    [providerUid, JSON.stringify(normalized), timezone, actorUid, expectedVersion ?? null]
  );

  if (!res.rowCount) {
    const err: any = new Error('This schedule changed on another device. Reload it and try again.');
    err.statusCode = 409;
    throw err;
  }

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
              COALESCE(all_day, TRUE) AS all_day,
              to_char(start_time, 'HH24:MI') AS start_time,
              to_char(end_time,   'HH24:MI') AS end_time,
              note,
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
    allDay:      r.all_day !== false,
    startTime:   r.start_time ?? null,
    endTime:     r.end_time ?? null,
    note:        r.note ?? null,
    reason:      r.reason ?? null,
    status:      r.status ?? 'active',
    createdAt:   r.created_at,
    createdBy:   r.created_by   ?? null,
    cancelledAt: r.cancelled_at ?? null,
    cancelledBy: r.cancelled_by ?? null,
  }));
};

/** `HH:mm` or `HH:mm:ss` in, `HH:mm` out; anything else is null. */
const normaliseHhMm = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  const m = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(raw.trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${m[1]}:${m[2]}`;
};

/**
 * §34 keeps time-off detail private, so the note is bounded rather than
 * unlimited free text — a field with no ceiling invites medical detail nobody
 * asked for and nothing redacts.
 */
const NOTE_MAX = 500;
const normaliseNote = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  return t === '' ? null : t;
};

const isCalendarDate = (raw: unknown): raw is string => {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const [year, month, day] = raw.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
};


/** A confirmed commitment that overlaps a time-off window. §18. */
export interface TimeOffBookingConflict {
  bookingId: string;
  serviceName: string | null;
  /** Operational-timezone rendering, for copy the provider can act on. */
  startsAt: string;
  localDate: string;
  localTime: string;
  durationMins: number;
  status: string;
}

/**
 * Confirmed bookings a proposed time-off window would collide with.
 *
 * C22 §18. Creating time off must never quietly free a provider who has
 * accepted work — but it must also never be BLOCKED, because a provider who is
 * ill has to be able to record it. So this reports; the caller decides.
 *
 * The date and time comparisons happen in the operational timezone via
 * `AT TIME ZONE`, using Postgres's own IANA database, so this agrees with
 * `operationalTimezone.ts` rather than being a second opinion.
 *
 * Booking end comes from `service_options.duration_mins` (default 120), the
 * same source admin booking creation uses for its conflict window — so a
 * booking that STARTS before a partial window but runs into it is caught.
 *
 * The UNION is not redundant: admin-created bookings set `worker_uid` on the
 * booking row AND write a `booking_workers` row, and older rows may have only
 * one. Querying either alone silently misses assignments.
 */
export const findTimeOffBookingConflicts = async (
  providerUid: string,
  window: {
    startDate: string;
    endDate: string;
    allDay: boolean;
    startTime?: string | null;
    endTime?: string | null;
  },
): Promise<TimeOffBookingConflict[]> => {
  const tz = OPERATIONAL_TIMEZONE;
  // An all-day window is the whole calendar day, expressed as times so one
  // query serves both cases.
  const from = window.allDay ? '00:00' : (window.startTime ?? '00:00');
  const to   = window.allDay ? '24:00' : (window.endTime   ?? '24:00');

  const res = await dbQuery.query(
    `WITH assigned AS (
       SELECT b.id, b.schedule, b.status, b.service_option_id
         FROM ${s}.bookings b
        WHERE b.worker_uid = $1 AND b.status NOT IN ('CANCELLED', 'COMPLETED')
       UNION
       SELECT b.id, b.schedule, b.status, b.service_option_id
         FROM ${s}.bookings b
         JOIN ${s}.booking_workers bw ON bw.booking_id = b.id
        WHERE bw.worker_uid = $1 AND b.status NOT IN ('CANCELLED', 'COMPLETED')
     )
     SELECT a.id, a.schedule, a.status,
            sv.name AS service_name,
            COALESCE(so.duration_mins, 120) AS duration_mins,
            to_char(a.schedule AT TIME ZONE $5, 'YYYY-MM-DD') AS local_date,
            to_char(a.schedule AT TIME ZONE $5, 'HH24:MI')    AS local_time
       FROM assigned a
       LEFT JOIN ${s}.service_options so ON so.id = a.service_option_id
       LEFT JOIN ${s}.services sv        ON sv.id = so.service_id
      WHERE (a.schedule AT TIME ZONE $5)::date BETWEEN $2::date AND $3::date
        AND (
          $4::boolean = TRUE
          OR (
            -- Half-open overlap against the booking's real span, so time off
            -- ending at 12:00 does not collide with a booking starting at 12:00.
            (a.schedule AT TIME ZONE $5)::time < $7::time
            AND ((a.schedule AT TIME ZONE $5)
                 + (COALESCE(so.duration_mins, 120) || ' minutes')::interval)::time > $6::time
          )
        )
      ORDER BY a.schedule ASC
      LIMIT 50`,
    [providerUid, window.startDate, window.endDate, window.allDay, tz, from, to],
  );

  return (res.rows as any[]).map((r) => ({
    bookingId:    String(r.id),
    serviceName:  r.service_name ?? null,
    startsAt:     r.schedule,
    localDate:    r.local_date,
    localTime:    r.local_time,
    durationMins: Number(r.duration_mins ?? 120),
    status:       String(r.status),
  }));
};

export const createTimeOff = async (
  providerUid: string,
  payload: {
    startDate: string;
    endDate: string;
    reason?: string;
    allDay?: boolean;
    startTime?: string | null;
    endTime?: string | null;
    note?: string | null;
  },
  actorUid: string,
): Promise<ProviderTimeOff & { bookingConflicts: TimeOffBookingConflict[] }> => {
  await bootstrap();

  if (!isCalendarDate(payload.startDate) || !isCalendarDate(payload.endDate)) {
    const err: any = new Error('startDate and endDate must be real dates in YYYY-MM-DD format');
    err.statusCode = 422;
    throw err;
  }

  const reason = typeof payload.reason === 'string' ? payload.reason.trim() : '';
  if (reason.length > 80 || /[\u0000-\u001F\u007F]/.test(reason)) {
    const err: any = new Error('reason must be at most 80 characters and contain no control characters');
    err.statusCode = 422;
    throw err;
  }
  const note = normaliseNote(payload.note);
  if (note !== null && note.length > NOTE_MAX) {
    const err: any = new Error(`note must be at most ${NOTE_MAX} characters`);
    err.statusCode = 422;
    throw err;
  }
  if (payload.startDate > payload.endDate) {
    const err: any = new Error('endDate must be on or after startDate');
    err.statusCode = 422;
    throw err;
  }

  // C22 §17. Partial-day time off is single-day only. A multi-day range with
  // times has no agreed meaning — "09:00 to 12:00" across three days could be
  // those hours each day or one continuous window — and inventing one silently
  // is how the original defect worked. Refusing with a reason is honest;
  // guessing is not.
  const allDay = payload.allDay !== false;
  let startTime: string | null = null;
  let endTime: string | null = null;

  if (!allDay) {
    if (payload.startDate !== payload.endDate) {
      const err: any = new Error('Partial-day time off must start and end on the same date');
      err.statusCode = 422;
      throw err;
    }
    startTime = normaliseHhMm(payload.startTime);
    endTime = normaliseHhMm(payload.endTime);
    if (!startTime || !endTime) {
      const err: any = new Error('startTime and endTime are required when allDay is false');
      err.statusCode = 422;
      throw err;
    }
    if (startTime >= endTime) {
      const err: any = new Error('endTime must be later than startTime');
      err.statusCode = 422;
      throw err;
    }
  }

  // C22 §18. Looked up BEFORE the insert so the answer describes the state the
  // provider is deciding about, and so a failure here cannot leave time off
  // recorded with conflicts nobody was told about.
  //
  // Deliberately NOT a blocker. Time off is a statement of fact — a provider
  // who is ill must be able to record it — and refusing would leave them with
  // no way to say so. §18's "explicit resolution" is the CALLER's job: the
  // conflicts come back with the record so the client must show them, and the
  // provider is told plainly that the booking is still theirs.
  const bookingConflicts = await findTimeOffBookingConflicts(providerUid, {
    startDate: payload.startDate,
    endDate: payload.endDate,
    allDay,
    startTime,
    endTime,
  });

  const client = await pool.connect();
  let res: any;
  try {
    await client.query('BEGIN');
    // Serialise time-off writes per provider. Without this, two simultaneous
    // tabs can both pass an overlap check and create duplicate/contradictory
    // periods.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`worker-time-off:${providerUid}`]);
    const overlap = await client.query(
      `SELECT id FROM ${s}.worker_time_off
        WHERE worker_uid = $1
          AND COALESCE(status, 'active') = 'active'
          AND start_date <= $3::date AND end_date >= $2::date
          AND (
            COALESCE(all_day, TRUE) = TRUE OR $4::boolean = TRUE
            OR (start_time < $6::time AND end_time > $5::time)
          )
        LIMIT 1`,
      [providerUid, payload.startDate, payload.endDate, allDay, startTime, endTime],
    );
    if (overlap.rowCount) {
      const err: any = new Error('Time off overlaps an existing active period.');
      err.statusCode = 409;
      throw err;
    }
    res = await client.query(
      `INSERT INTO ${s}.worker_time_off
         (worker_uid, start_date, end_date, reason, created_by, status,
          all_day, start_time, end_time, note)
       VALUES ($1, $2, $3, $4, $5, 'active', $6, $7::time, $8::time, $9)
       RETURNING id, start_date, end_date, reason, created_at, created_by,
                 COALESCE(status, 'active') AS status, cancelled_at, cancelled_by,
                 COALESCE(all_day, TRUE) AS all_day,
                 to_char(start_time, 'HH24:MI') AS start_time,
                 to_char(end_time,   'HH24:MI') AS end_time,
                 note`,
      [providerUid, payload.startDate, payload.endDate, reason || null, actorUid,
       allDay, startTime, endTime, note],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  const r = res.rows[0];
  return {
    id:          r.id,
    startDate:   r.start_date instanceof Date ? r.start_date.toISOString().slice(0, 10) : String(r.start_date).slice(0, 10),
    endDate:     r.end_date   instanceof Date ? r.end_date.toISOString().slice(0, 10)   : String(r.end_date).slice(0, 10),
    bookingConflicts,
    allDay:      r.all_day !== false,
    startTime:   r.start_time ?? null,
    endTime:     r.end_time ?? null,
    note:        r.note ?? null,
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
               status, cancelled_at, cancelled_by,
               COALESCE(all_day, TRUE) AS all_day,
               to_char(start_time, 'HH24:MI') AS start_time,
               to_char(end_time,   'HH24:MI') AS end_time,
               note`,
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
    allDay:      r.all_day !== false,
    startTime:   r.start_time ?? null,
    endTime:     r.end_time ?? null,
    note:        r.note ?? null,
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

/**
 * Does a stored weekly schedule cover this day + time window?
 *
 * Extracted so explainAvailability (one provider, full reasons) and
 * filterUidsAvailableAt (many providers, set-based) decide identically. §10
 * requires one canonical implementation of a domain rule — two copies of slot
 * matching would drift and let auto-assignment and the Admin explanation
 * disagree about the same provider.
 *
 * Returns a discriminated result rather than a bare boolean because callers
 * need to distinguish "no schedule configured" (which auto-assignment must not
 * treat as a blocker) from "explicitly not available then" (which it must).
 */
export type ScheduleCoverage = 'covered' | 'no_schedule' | 'day_unavailable' | 'outside_window';

export const scheduleCoversWindow = (
  rawSchedule: unknown,
  dow: number,
  startTime: string,
  endTime: string,
): ScheduleCoverage => {
  if (!rawSchedule || !Array.isArray(rawSchedule) || rawSchedule.length === 0) {
    return 'no_schedule';
  }
  const daySlots = (rawSchedule as any[]).filter(
    (sl: any) => sl.isAvailable && (sl.dayOfWeek ?? sl.day_of_week) === dow
  );
  if (daySlots.length === 0) { return 'day_unavailable'; }
  const covered = daySlots.some((sl: any) => {
    const start = sl.startTime ?? sl.start_time;
    const end   = sl.endTime   ?? sl.end_time;
    return start <= startTime && end >= endTime;
  });
  return covered ? 'covered' : 'outside_window';
};

/**
 * Weekday + HH:mm pair for a booking window, matching explainAvailability.
 *
 * C22 §5. This used `Date.getDay()` and `Date.getHours()`, which are
 * SERVER-LOCAL — and production runs Etc/UTC with TZ unset (measured on the
 * host). Providers enter schedules in Manila time, so every booking was read
 * eight hours early: 09:00 Manila became 01:00 and fell outside an 08:00–17:00
 * rule, while 19:00 Manila became 11:00 and fell inside it. Wrong in both
 * directions, which is why it never looked like an off-by-one.
 */
export const windowParts = (startAt: string, endAt: string) => {
  const start = zonedParts(startAt);
  const end   = zonedParts(endAt);
  return { dow: start.dayOfWeek, startTime: start.hhmm, endTime: end.hhmm };
};

/**
 * Set-based availability filter for auto-assignment.
 *
 * `missingScheduleIsAvailable` exists because the two callers need opposite
 * answers for the same state. Admin's explainAvailability calls an unconfigured
 * schedule a blocker — correct when a human is asking "can I confirm this
 * provider is free?". Auto-assignment must NOT: most providers have never saved
 * a schedule, and treating that as unavailable would silently stop assigning
 * anyone. Missing configuration is not a declaration of unavailability (§28).
 *
 * One query per concern for the whole candidate set, not per provider (§56).
 */
export const filterUidsAvailableAt = async (
  uids: string[],
  startAt: string,
  endAt: string,
  opts: { missingScheduleIsAvailable: boolean },
): Promise<{ eligible: string[]; excluded: Array<{ uid: string; reason: string }> }> => {
  if (!uids.length) { return { eligible: [], excluded: [] }; }
  await bootstrap();

  const { dow, startTime, endTime } = windowParts(startAt, endAt);
  // C22 §5. Was toISOString().slice(0, 10) — the UTC date, which in Manila is
  // a day early for anything before 08:00. Time off booked for the right day
  // did not block the booking, and the previous day's did.
  const day = operationalDate(startAt);

  const [availRes, timeOffRes] = await Promise.all([
    dbQuery.query(
      `SELECT worker_uid, schedule FROM ${s}.worker_availability WHERE worker_uid = ANY($1::text[])`,
      [uids]
    ),
    dbQuery.query(
      // C22 §17. Was date-only, so ANY time-off row blocked the whole day —
      // which is what turned a two-hour partial day into a lost day of work.
      // A partial day now blocks only where it actually overlaps the booking.
      // Half-open comparison: time off ending at 12:00 does not block a
      // booking starting at 12:00.
      `SELECT DISTINCT worker_uid FROM ${s}.worker_time_off
        WHERE worker_uid = ANY($1::text[])
          AND COALESCE(status, 'active') = 'active'
          AND start_date <= $2::date AND end_date >= $2::date
          AND (
            COALESCE(all_day, TRUE) = TRUE
            OR start_time IS NULL OR end_time IS NULL
            OR (start_time < $4::time AND end_time > $3::time)
          )`,
      [uids, day, startTime, endTime]
    ),
  ]);

  const scheduleByUid = new Map<string, unknown>();
  for (const row of availRes.rows as any[]) { scheduleByUid.set(row.worker_uid, row.schedule); }
  const onTimeOff = new Set((timeOffRes.rows as any[]).map(r => r.worker_uid));

  const eligible: string[] = [];
  const excluded: Array<{ uid: string; reason: string }> = [];

  for (const uid of uids) {
    if (onTimeOff.has(uid)) { excluded.push({ uid, reason: 'TIME_OFF' }); continue; }
    const coverage = scheduleCoversWindow(scheduleByUid.get(uid), dow, startTime, endTime);
    if (coverage === 'covered') { eligible.push(uid); continue; }
    if (coverage === 'no_schedule') {
      if (opts.missingScheduleIsAvailable) { eligible.push(uid); }
      else { excluded.push({ uid, reason: 'NO_AVAILABILITY_SET' }); }
      continue;
    }
    excluded.push({ uid, reason: coverage === 'day_unavailable' ? 'DAY_NOT_AVAILABLE' : 'OUTSIDE_SCHEDULE_WINDOW' });
  }

  return { eligible, excluded };
};

export const explainAvailability = async (
  providerUid: string,
  startAt: string,
  endAt: string,
): Promise<AvailabilityExplanation> => {
  await bootstrap();

  const reasons: AvailabilityExplanation['reasons'] = [];
  const bookingStart = new Date(startAt);
  const bookingEnd   = new Date(endAt);
  // C22 §5. A second, independent copy of the windowParts bug — the admin
  // "can I confirm this provider is free?" answer was computed in UTC too.
  const startParts = zonedParts(startAt);
  const endParts   = zonedParts(endAt);
  const dow = startParts.dayOfWeek as 0 | 1 | 2 | 3 | 4 | 5 | 6;
  const bookingStartTime = startParts.hhmm;
  const bookingEndTime   = endParts.hhmm;

  const [availRes, timeOffRes, conflictRes] = await Promise.all([
    dbQuery.query(
      `SELECT schedule, timezone FROM ${s}.worker_availability WHERE worker_uid = $1`,
      [providerUid]
    ),
    dbQuery.query(
      // C22 §17. Same partial-day overlap rule as filterUidsAvailableAt — the
      // admin answer and the assignment answer must agree about one provider.
      `SELECT id, start_date, end_date FROM ${s}.worker_time_off
       WHERE worker_uid = $1
         AND COALESCE(status, 'active') = 'active'
         AND start_date <= $2::date AND end_date >= $2::date
         AND (
           COALESCE(all_day, TRUE) = TRUE
           OR start_time IS NULL OR end_time IS NULL
           OR (start_time < $4::time AND end_time > $3::time)
         )`,
      [providerUid, operationalDate(startAt), zonedParts(startAt).hhmm, zonedParts(endAt).hhmm]
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

  // 3. Weekly schedule check — shared with filterUidsAvailableAt so the Admin
  //    explanation and auto-assignment can never disagree about a provider.
  const rawSchedule = availRes.rows[0]?.schedule;
  switch (scheduleCoversWindow(rawSchedule, dow, bookingStartTime, bookingEndTime)) {
    case 'no_schedule':
      reasons.push({
        code: 'NO_AVAILABILITY_SET',
        severity: 'blocker',
        message: 'Provider has no weekly schedule configured — cannot confirm availability',
      });
      break;
    case 'day_unavailable':
      reasons.push({
        code: 'DAY_NOT_AVAILABLE',
        severity: 'blocker',
        message: `Provider is not available on ${DOW_LABELS[dow]}s`,
      });
      break;
    case 'outside_window':
      reasons.push({
        code: 'OUTSIDE_SCHEDULE_WINDOW',
        severity: 'blocker',
        message: `Booking time ${bookingStartTime}–${bookingEndTime} falls outside provider's ${DOW_LABELS[dow]} slots`,
      });
      break;
    case 'covered':
      break;
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
  const operationalToday = zonedParts(now).ymd;
  const dayZero = Date.parse(`${operationalToday}T00:00:00.000Z`);

  for (let i = 0; i < 14; i++) {
    // C22 §5. Walking days with the host clock put the boundary at UTC
    // midnight — 08:00 Manila — so for eight hours every morning this
    // reported the previous day's availability as "next".
    const dateStr = new Date(dayZero + i * 86_400_000).toISOString().slice(0, 10);
    const dow = new Date(`${dateStr}T00:00:00.000Z`).getUTCDay();

    // Check time-off
    const daySlots = schedule
      .filter(sl => sl.dayOfWeek === dow && sl.isAvailable)
      .sort((a, b) => a.startTime.localeCompare(b.startTime));
    for (const slot of daySlots) {
      const blocked = activeTimeOff.some((entry) => {
        if (entry.startDate > dateStr || entry.endDate < dateStr) return false;
        if (entry.allDay || !entry.startTime || !entry.endTime) return true;
        return entry.startTime < slot.endTime && entry.endTime > slot.startTime;
      });
      if (blocked) continue;

      const result = zonedDateTimeToUtc(dateStr, slot.startTime);
      if (result > now) return result.toISOString();
    }
  }
  return null;
};
