import { Request, Response } from "express";
import { db } from "../config";
import { providerShareOf, PROVIDER_SHARE_RATE, PROVIDER_SHARE_PERCENT } from '../services/revenueSplit';
import {
  canonicalPayoutStatus,
  earningsPayoutDialect,
  payoutsPayoutDialect,
  ledgerPayoutDialect,
} from '../services/payoutStatus';
import dbQuery from "../db/dbQuery";
import { paidAdditionalWorkSql, earningsGross } from "../services/earningsBasis";
import { PROVIDER_RELEASE_HOURS } from "../services/payoutStatus";
import * as technicianService from "../services/technicianService";
import * as userService from "../services/user.service";
import mongoDb from "../db/mongodbQuery";
import { uploadFileToStorage } from "../helpers/firebaseStorageUploader";
import * as notificationService from "../services/notification.service";
import { getProviderAggregate } from "../services/customerReviewService";
import { BookingResponseConflict } from "../services/bookingResponseConflict";
import { buildBookingTimeline, currentTimelineStep, mergeStoredEvents } from "./bookingTimeline";
import { buildDisputeSummary } from "./bookingDisputeView";
import { evaluateCancellation, CANCELLATION_NOTICE_HOURS } from "./bookingCancellationPolicy";
import { updateFirebasePassword, revokeTokenInFirebase, getFirebaseUserByUid } from "../services/firebaseFunctions.service";
import * as serviceApplicationService from "../services/serviceApplicationService";
import * as onboardingService from "../services/providerOnboardingService";
import * as disbursementService from "../services/disbursement.service";
import * as availEngine from "../services/providerAvailabilityEngine";
import * as areaEngine from "../services/providerServiceAreaEngine";
import * as autoOnlineEngine from "../services/providerAutoOnlineEngine";
import * as availabilityService from "../services/providerOperationalAvailabilityService";
import { touchProviderActivity } from "../services/adminProviderService";
import { getProviderPerformance } from "../services/providerPerformanceService";
import { randomUUID } from 'crypto';
import { submitProfilePhoto } from '../services/providerProfileMediaService';
import { deriveEffectiveBookingStatus } from '../services/bookingStatusProjection';

const dbSchema = db.schema;

// ── Availability bridge: Provider Web ↔ canonical engine shapes ───────────────

const DAY_TO_DOW: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const DOW_TO_DAY: Record<number, string> = { 0: 'sun', 1: 'mon', 2: 'tue', 3: 'wed', 4: 'thu', 5: 'fri', 6: 'sat' };
const WEB_ALL_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const ENGINE_DOW_LABELS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function bridgeToEngineSlots(schedule: any[]): availEngine.WeeklyScheduleSlot[] {
  const invalid = (message: string): never => {
    const error: any = new Error(message);
    error.statusCode = 422;
    throw error;
  };
  if (schedule.length > WEB_ALL_DAYS.length) {
    invalid('schedule must contain at most one entry for each day');
  }
  const slots: availEngine.WeeklyScheduleSlot[] = [];
  const seenDays = new Set<string>();
  for (const day of schedule) {
    if (!day || typeof day !== 'object') invalid('each schedule day must be an object');
    const dayKey = typeof day.day === 'string' ? day.day.toLowerCase() : '';
    const dow = DAY_TO_DOW[dayKey] ?? -1;
    if (dow === -1) invalid(`invalid schedule day: ${String(day.day ?? '')}`);
    if (seenDays.has(dayKey)) invalid(`schedule contains duplicate day: ${dayKey}`);
    seenDays.add(dayKey);
    if (typeof day.enabled !== 'boolean') invalid(`${dayKey}.enabled must be boolean`);
    if (!Array.isArray(day.slots)) invalid(`${dayKey}.slots must be an array`);
    if (!day.enabled && day.slots.length > 0) {
      invalid(`${dayKey} cannot contain slots while disabled`);
    }
    if (day.enabled && day.slots.length === 0) {
      invalid(`${dayKey} must contain at least one slot while enabled`);
    }
    const dayLabel = ENGINE_DOW_LABELS[dow] ?? '';
    if (!day.enabled) {
      // Represent disabled day as an unavailable placeholder so the day is tracked
      slots.push({ dayOfWeek: dow as 0|1|2|3|4|5|6, dayLabel, startTime: '09:00', endTime: '17:00', isAvailable: false, maxJobs: null });
    } else {
      for (const s of day.slots) {
        if (!s || typeof s !== 'object' || typeof s.startTime !== 'string' || typeof s.endTime !== 'string') {
          invalid(`${dayKey} contains a malformed slot`);
        }
        slots.push({ dayOfWeek: dow as 0|1|2|3|4|5|6, dayLabel, startTime: s.startTime, endTime: s.endTime, isAvailable: true, maxJobs: null });
      }
    }
  }
  return slots;
}

function bridgeToWebSchedule(engineSlots: availEngine.WeeklyScheduleSlot[]): any[] {
  const byDay: Record<string, { id: string; startTime: string; endTime: string }[]> = {};
  for (const sl of engineSlots) {
    if (!sl.isAvailable) continue;
    const dayKey = DOW_TO_DAY[sl.dayOfWeek];
    if (!dayKey) continue;
    if (!byDay[dayKey]) byDay[dayKey] = [];
    byDay[dayKey].push({ id: `slot-${dayKey}-${sl.startTime.replace(':', '')}`, startTime: sl.startTime, endTime: sl.endTime });
  }
  return WEB_ALL_DAYS.map(day => ({ day, enabled: (byDay[day]?.length ?? 0) > 0, slots: byDay[day] ?? [] }));
}

function bridgeToWebTimeOff(timeOff: availEngine.ProviderTimeOff[]): any[] {
  return timeOff
    .filter(t => t.status === 'active')
    .map(t => ({
      id:        String(t.id),
      startDate: t.startDate,
      endDate:   t.endDate,
      allDay:    t.allDay,
      startTime: t.startTime,
      endTime:   t.endTime,
      reason:    t.reason ?? 'other',
      note:      t.note,
      createdAt: t.createdAt,
    }));
}

// ─── Auth/Me ──────────────────────────────────────────────────────────────────

export const getMe = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });

    const result = await dbQuery.query(
      `SELECT uid, email, first_name, last_name, role, is_email_verified, phone_number
       FROM ${dbSchema}.user_credentials WHERE uid = $1 LIMIT 1`,
      [uid]
    );

    if (!result.rows.length) {
      return res.status(404).json({ status: "failed", message: "User not found" });
    }

    const row = result.rows[0];
    const user = {
      id: row.uid,
      uid: row.uid,
      email: row.email,
      firstName: row.first_name,
      lastName: row.last_name,
      role: row.role,
      isEmailVerified: row.is_email_verified,
      phoneNumber: row.phone_number,
    };

    return res.status(200).json({ status: "success", data: user });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: "Server error" });
  }
};

// ─── Location / Online Status ─────────────────────────────────────────────────

const toOnlineStatusDto = (isOnline: boolean, updatedAt?: Date) => ({
  status: isOnline ? "online" : "offline",
  updatedAt: (updatedAt ?? new Date()).toISOString(),
});

export const getLocationStatus = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    const collection = (await mongoDb).collection("worker_locations");
    const doc = await collection.findOne({ uid }, { projection: { is_online: 1, updatedAt: 1 } });
    return res.status(200).json({ status: "success", data: toOnlineStatusDto(doc?.is_online ?? false, doc?.updatedAt) });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: "Server error" });
  }
};

export const goOnline = async (req: Request, res: Response) => {
  try {
    const uid = req.user && req.user.uid ? req.user.uid : null;
    if (!uid) { return res.status(401).json({ status: "failed", message: "Unauthorized" }); }

    const lat = req.body && req.body.latitude !== undefined ? Number(req.body.latitude) : 0;
    const lng = req.body && req.body.longitude !== undefined ? Number(req.body.longitude) : 0;

    await availabilityService.setOnline(
      uid,
      'provider_explicit',
      uid,
      'provider',
      null,
      lat !== 0 || lng !== 0 ? { latitude: lat, longitude: lng } : null,
    );

    return res.status(200).json({ status: "success", data: toOnlineStatusDto(true, new Date()) });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: "Server error" });
  }
};

export const goOffline = async (req: Request, res: Response) => {
  try {
    const uid = req.user && req.user.uid ? req.user.uid : null;
    if (!uid) { return res.status(401).json({ status: "failed", message: "Unauthorized" }); }

    await availabilityService.setOffline(uid, 'provider_explicit', uid, 'provider', null);

    return res.status(200).json({ status: "success", data: toOnlineStatusDto(false, new Date()) });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: "Server error" });
  }
};

// ─── Shared helpers ───────────────────────────────────────────────────────────

const bookingCode = (id: any) => `SVN-${String(id).padStart(6, "0")}`;

const toJobDto = (r: any) => {
  const workerStatus = String(r.worker_status ?? "").toUpperCase();
  const effectiveStatus = workerStatus === "ASSIGNED"
    ? "ASSIGNED"
    : deriveEffectiveBookingStatus(r.status, workerStatus);
  const fullDisclosure = new Set([
    "ACCEPTED", "EN_ROUTE", "ARRIVED", "IN_PROGRESS", "COMPLETED",
  ]).has(workerStatus);
  const relinquished = new Set(["DECLINED", "CANCELED", "CANCELLED"]).has(workerStatus);
  const first = relinquished ? "" : String(r.customer_first ?? "").trim();
  const last = relinquished ? "" : String(r.customer_last ?? "").trim();

  return {
    id: String(r.id),
    bookingId: String(r.id),
    bookingCode: bookingCode(r.id),
    serviceName: r.service_name || "",
    categoryName: r.category_name || "",
    customerDisplayName: last ? `${first} ${last.charAt(0).toUpperCase()}.`.trim() : first,
    customerInitials: `${first.charAt(0)}${last.charAt(0)}`.toUpperCase(),
    // Match mobile job-card disclosure: area before acceptance, street only
    // after the provider accepts the relationship.
    addressLine: fullDisclosure ? (r.address_one || "") : "",
    city: relinquished ? "" : (r.post_town || ""),
    scheduledAt: r.schedule,
    status: effectiveStatus.toLowerCase(),
    workerStatus: workerStatus.toLowerCase(),
    clientPaymentStatus: r.payment_status ? r.payment_status.toLowerCase() : "pending",
    paymentMethod: (r.payment_method || "cash").toLowerCase(),
    bookingAmount: Number(r.final_price || 0),
    currency: "PHP",
    hasUnreadChat: false,
    hasAdditionalWork: false,
  };
};

const JOB_SELECT = (statusFilter: string) => `
  SELECT b.id, b.status, b.schedule, b.final_price, b.payment_method,
         COALESCE(ua.address_one, b.service_address->>'addressLine') AS address_one,
         COALESCE(ua.post_town,   b.service_address->>'city')        AS post_town,
         s.level_1 AS category_name, s.level_2 AS service_name,
         u.first_name AS customer_first, u.last_name AS customer_last,
         p.status AS payment_status,
         bw.worker_status
  FROM {SCHEMA}.bookings b
  LEFT JOIN {SCHEMA}.user_address ua ON ua.address_id = b.user_address_id
  LEFT JOIN {SCHEMA}.service_options so ON so.id = b.service_option_id
  LEFT JOIN {SCHEMA}.services s ON s.id = so.service_id
  LEFT JOIN {SCHEMA}.user_credentials u ON u.uid = b.user_id
  LEFT JOIN LATERAL (
    SELECT p1.status
    FROM {SCHEMA}.payments p1
    WHERE p1.booking_id = b.id
    ORDER BY p1.id DESC
    LIMIT 1
  ) p ON TRUE
  JOIN LATERAL (
    SELECT bw1.status AS worker_status
    FROM {SCHEMA}.booking_workers bw1
    WHERE bw1.booking_id = b.id AND bw1.worker_uid = $1
    ORDER BY bw1.assigned_at DESC NULLS LAST, bw1.id DESC
    LIMIT 1
  ) bw ON TRUE
  WHERE b.worker_uid = $1 AND ${statusFilter}
  ORDER BY b.schedule ASC
`;

// ─── Dashboard ────────────────────────────────────────────────────────────────

export const getDashboard = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const schema = dbSchema || "";
    const jobSql = (filter: string, limit?: number) =>
      JOB_SELECT(filter).replace(/\{SCHEMA\}/g, schema) + (limit ? ` LIMIT ${limit}` : "");

    const [activeJobRes, upcomingRes, todayStatsRes, locationDoc, ratingAgg] = await Promise.all([
      // `bookings.status` is NEVER written 'IN_PROGRESS' — startJob writes that to
      // booking_workers only (technicianService.ts:1139). This filter therefore
      // matched nothing, and the dashboard reported no active job while the
      // provider was standing in the customer's house doing the work.
      //
      // EXISTS rather than a JOIN so JOB_SELECT keeps its single-row-per-booking
      // shape for the three other callers.
      dbQuery.query(
        jobSql(
          `EXISTS (
             SELECT 1 FROM ${schema}.booking_workers bw
             WHERE bw.booking_id = b.id
               AND bw.worker_uid = $1
               AND bw.status = 'IN_PROGRESS'
           )`,
          1
        ),
        [uid]
      ),
      dbQuery.query(
        jobSql("bw.worker_status IN ('ASSIGNED','ACCEPTED','EN_ROUTE','ARRIVED')", 10),
        [uid],
      ),
      dbQuery.query(
        // Earnings come from disbursements.worker_share — the authoritative
        // 80% figure computed at completion — NOT from bookings.final_price,
        // which is the gross the CUSTOMER paid. Summing final_price here
        // reported the provider's take as 125% of what they are actually paid,
        // the same defect the Worker app has in earnings_view.dart.
        //
        // LEFT JOIN so a completed booking with no disbursement row yet counts
        // toward completed_today but contributes 0 to earnings, rather than
        // dropping the job from the count entirely.
        `SELECT
           COUNT(*) FILTER (WHERE b.status = 'COMPLETED' AND b.schedule >= $2 AND b.schedule <= $3) AS completed_today,
           COALESCE(SUM(d.worker_share) FILTER (WHERE b.status = 'COMPLETED' AND b.schedule >= $2 AND b.schedule <= $3), 0) AS today_earnings,
           COALESCE(SUM(d.worker_share) FILTER (WHERE b.status = 'COMPLETED'), 0) AS total_earned
         FROM ${schema}.bookings b
         LEFT JOIN ${schema}.disbursements d
                ON d.booking_id = b.id AND d.worker_uid = b.worker_uid
         WHERE b.worker_uid = $1`,
        [uid, todayStart, todayEnd]
      ),
      (async () => {
        const col = (await mongoDb).collection("worker_locations");
        return col.findOne({ uid }, { projection: { is_online: 1, updatedAt: 1 } });
      })(),
      // `rating` was a hardcoded 0 while `provider_rating_aggregates` held the
      // real figure, recomputed on every review create/update/delete. Every
      // consumer of this endpoint — the provider web portal's dashboard facade
      // among them — was being told each provider had a zero rating.
      //
      // Additive by construction: same key, same type, real value. No consumer
      // needs a change, and one that renders `rating` starts being correct.
      //
      // Failure is non-fatal: a rating is not worth failing a whole dashboard
      // over, so an error here degrades to the previous behaviour.
      uid
        ? getProviderAggregate(uid).catch(() => null)
        : Promise.resolve(null),
    ]);

    const stats = todayStatsRes.rows[0] || {};
    const upcomingJobs = upcomingRes.rows;

    return res.status(200).json({
      status: "success",
      data: {
        onlineStatus: locationDoc?.is_online ? "online" : "offline",
        activeJob: activeJobRes.rows[0] ? toJobDto(activeJobRes.rows[0]) : null,
        upcomingJobs: upcomingJobs.map(toJobDto),
        scheduledJobsToday: upcomingJobs.length,
        completedJobsToday: Number(stats.completed_today ?? 0),
        todayEarnings: Number(stats.today_earnings ?? 0),
        pendingPayout: Number(stats.total_earned ?? 0),
        rating: ratingAgg?.averageRating ?? 0,
        // Still hardcoded, and deliberately so — there is no chat/messages
        // system in this API, and no requirements-expiry source. Inventing a
        // number for either would be worse than a zero. Recorded as C17-01.
        unreadMessages: 0,
        requirementsAlerts: 0,
        currency: "PHP",
      },
    });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: "Server error" });
  }
};

// ─── Earnings ─────────────────────────────────────────────────────────────────

// C20 F-03. This was one of three hand-written mappings over the same column,
// each answering a different word. It now derives from `payoutStatus.ts`, which
// emits exactly what this function always emitted — the point is that the three
// dialects can no longer drift apart, not that any value changed.
const normalizePayoutStatus = earningsPayoutDialect;

export const getEarnings = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    const { startDate, endDate } = req.query;

    let dateFilter = "";
    const params: any[] = [uid];

    if (startDate && endDate) {
      if (isNaN(Date.parse(startDate as string)) || isNaN(Date.parse(endDate as string))) {
        return res.status(400).json({ status: "failed", message: "Invalid date range" });
      }
      params.push(startDate, endDate);
      dateFilter = `AND b.schedule >= $2 AND b.schedule <= $3`;
    }

    const result = await dbQuery.query(
      // bw.completed_at is when the provider actually finished. It is joined
      // because completedAt below used to be populated from b.schedule — the
      // time the job was BOOKED for. On any job that ran late, started early or
      // was rescheduled, the earnings history showed a completion time that
      // never happened, and it silently agreed with scheduledAt on every row.
      `SELECT b.id, b.status, b.schedule, b.final_price, b.payment_method,
              so.level_2 AS service_name,
              p.status   AS payment_status,
              d.status   AS payout_status,
              d.released_at,
              d.worker_share,
              bw.completed_at,
              -- The same expression the release scheduler uses, from the same
              -- constant, so a date shown to a provider cannot disagree with the
              -- job that actually moves the money. Clients previously had to
              -- recompute it, and Provider Web recomputed it with a 48-hour
              -- window against a 72-hour scheduler.
              bw.completed_at + INTERVAL '${PROVIDER_RELEASE_HOURS} hours' AS release_after,
              ${paidAdditionalWorkSql(dbSchema)} AS additional_paid
       FROM ${dbSchema}.bookings b
       LEFT JOIN ${dbSchema}.service_options so ON so.id = b.service_option_id
       LEFT JOIN ${dbSchema}.payments p ON p.booking_id = b.id
         AND p.additional_request_id IS NULL
       LEFT JOIN ${dbSchema}.disbursements d ON d.booking_id = b.id AND d.worker_uid = $1
       LEFT JOIN ${dbSchema}.booking_workers bw
              ON bw.booking_id = b.id AND bw.worker_uid = $1
       WHERE b.worker_uid = $1 AND b.status = 'COMPLETED'
       ${dateFilter}
       ORDER BY b.schedule DESC`,
      params
    );

    const data = result.rows.map((r: any) => {
      // `final_price` alone is NOT the gross the provider's share comes from —
      // paid on-site additional work is charged separately and never written
      // back to it. `createDisbursement` has always included it, so showing
      // `final_price` here put a booking amount on screen that the provider
      // share was visibly not 80% of. See `earningsBasis.ts`.
      const gross = earningsGross(r.final_price, r.additional_paid);
      const workerShare = r.worker_share != null
        ? Math.round(Number(r.worker_share) * 100) / 100
        : providerShareOf(gross);
      return {
        id: String(r.id),
        bookingId: String(r.id),
        bookingCode: bookingCode(r.id),
        serviceName: r.service_name || "",
        // Falls back to the schedule only when the assignment row carries no
        // completion time, so the field degrades to its old value rather than
        // to null for any historical row written before completed_at was set.
        completedAt: r.completed_at ?? r.schedule,
        scheduledAt: r.schedule,
        bookingAmount: gross,
        providerShareAmount: workerShare,
        providerSharePercent: PROVIDER_SHARE_PERCENT,
        clientPaymentStatus: r.payment_status ? r.payment_status.toLowerCase() : "pending",
        bookingStatus: r.status ? r.status.toLowerCase() : "completed",
        providerPayoutStatus: normalizePayoutStatus(r.payout_status),
        // Additive (C20 F-03). Keeps PROCESSING distinct from PENDING, which
        // the dialect above cannot express and §1 requires.
        payoutStatusCanonical: canonicalPayoutStatus(r.payout_status),
        disbursedAt: r.released_at || null,
        // Backend-computed release date (§3). Additive — existing consumers
        // ignore it. `disbursedAt` takes precedence for display: this is when
        // the money BECOMES eligible, not proof it moved.
        expectedArrivalAt: r.release_after ? new Date(r.release_after).toISOString() : null,
        paymentMethod: (r.payment_method || "cash").toLowerCase(),
        currency: "PHP",
      };
    });

    return res.status(200).json({ status: "success", data });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: "Server error" });
  }
};

export const getEarningById = async (req: Request, res: Response) => {
  try {
    const uid  = req.user?.uid;
    const id   = Number(req.params.id);
    if (!uid || !Number.isFinite(id)) {
      return res.status(400).json({ status: "failed", message: "Invalid request" });
    }
    const result = await dbQuery.query(
      `SELECT b.id, b.status, b.schedule, b.final_price, b.payment_method,
              so.level_2 AS service_name,
              p.status   AS payment_status,
              d.status   AS payout_status,
              d.released_at,
              d.worker_share,
              bw.completed_at,
              bw.completed_at + INTERVAL '${PROVIDER_RELEASE_HOURS} hours' AS release_after,
              ${paidAdditionalWorkSql(dbSchema)} AS additional_paid
       FROM ${dbSchema}.bookings b
       LEFT JOIN ${dbSchema}.service_options so ON so.id = b.service_option_id
       -- additional_request_id IS NULL matches the list query. Without it a
       -- booking carrying BOTH a base payment and an additional-work payment
       -- fans out to several rows, and only rows[0] is read — so the detail
       -- screen could report the additional charge's status as the booking's
       -- payment status, and disagree with the list for the same booking.
       LEFT JOIN ${dbSchema}.payments        p  ON p.booking_id = b.id
         AND p.additional_request_id IS NULL
       LEFT JOIN ${dbSchema}.disbursements   d  ON d.booking_id = b.id AND d.worker_uid = $1
       LEFT JOIN ${dbSchema}.booking_workers bw ON bw.booking_id = b.id AND bw.worker_uid = $1
       WHERE b.id = $2 AND b.worker_uid = $1`,
      [uid, id]
    );
    if (!result.rowCount) {
      return res.status(404).json({ status: "failed", message: "Earning not found" });
    }
    const r = result.rows[0];
    // Same basis as the list endpoint — see earningsBasis.ts.
    const gross = earningsGross(r.final_price, r.additional_paid);
    const workerShareDetail = r.worker_share != null
      ? Math.round(Number(r.worker_share) * 100) / 100
      : providerShareOf(gross);
    const data = {
      id:                  String(r.id),
      bookingId:           String(r.id),
      bookingCode:         bookingCode(r.id),
      serviceName:         r.service_name || "",
      completedAt:         r.completed_at ?? r.schedule,
      scheduledAt:         r.schedule,
      bookingAmount:       gross,
      providerShareAmount: workerShareDetail,
      providerSharePercent: PROVIDER_SHARE_PERCENT,
      clientPaymentStatus: r.payment_status ? r.payment_status.toLowerCase() : "pending",
      bookingStatus:       r.status ? r.status.toLowerCase() : "completed",
      providerPayoutStatus: normalizePayoutStatus(r.payout_status),
      // Additive (C20 F-03). Keeps PROCESSING distinct from PENDING.
      payoutStatusCanonical: canonicalPayoutStatus(r.payout_status),
      disbursedAt:         r.released_at || null,
      expectedArrivalAt:   r.release_after ? new Date(r.release_after).toISOString() : null,
      paymentMethod:       (r.payment_method || "cash").toLowerCase(),
      currency:            "PHP",
    };
    return res.status(200).json({ status: "success", data });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: "Server error" });
  }
};

export const getEarningsSummary = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    const { startDate, endDate } = req.query;

    let dateFilter = "";
    const params: any[] = [uid];

    if (startDate && endDate) {
      if (isNaN(Date.parse(startDate as string)) || isNaN(Date.parse(endDate as string))) {
        return res.status(400).json({ status: "failed", message: "Invalid date range" });
      }
      params.push(startDate, endDate);
      dateFilter = `AND b.schedule >= $2 AND b.schedule <= $3`;
    }

    // C20 F-04. This query had three defects, all of the same shape: it
    // recomputed money that had already been calculated authoritatively.
    //
    //   1. `final_price * RATE` DROPPED ON-SITE UPSELL REVENUE. Disbursements
    //      are computed from `final_price + additional_paid` (see
    //      createDisbursement, whose own comment records fixing exactly this
    //      bug at the writer). The fix never reached this reader, so a provider
    //      who did approved additional work saw a total that omitted it.
    //   2. `PROCESSING` WAS COUNTED NOWHERE. `total_paid` took RELEASED only
    //      and `total_pending` took PENDING/FAILED/no-row, so money in flight
    //      vanished from both — it left "pending" without arriving in "paid".
    //   3. `FAILED` WAS COUNTED AS PENDING. That is the C20 F-01 defect in a
    //      second endpoint: a payout that will not arrive without intervention,
    //      presented as one that is on its way.
    //
    // The authoritative `d.worker_share` is now preferred wherever a
    // disbursement row exists. The `final_price` fallback survives only for a
    // completed booking that has no row yet — which is a genuine ESTIMATE, and
    // is reported as one rather than sitting unlabelled beside settled fact.
    const result = await dbQuery.query(
      `SELECT
         COUNT(*) AS total_jobs,
         COALESCE(SUM(b.final_price + ${paidAdditionalWorkSql(dbSchema)}), 0) AS total_gross,
         COALESCE(SUM(CASE WHEN d.status = 'RELEASED' THEN d.worker_share ELSE 0 END), 0) AS total_paid,
         COALESCE(SUM(CASE WHEN d.status IN ('PENDING','PROCESSING') THEN d.worker_share ELSE 0 END), 0) AS pending_recorded,
         -- The estimate fallback carried defect (1) too. It was the only branch
         -- still multiplying final_price, so a completed booking with approved
         -- extra work and no disbursement row yet was under-estimated by 80% of
         -- that work — the same omission the comment above says was fixed, in
         -- the one place the fix had not reached.
         COALESCE(SUM(CASE WHEN d.id IS NULL
                           THEN (b.final_price + ${paidAdditionalWorkSql(dbSchema)}) * ${PROVIDER_SHARE_RATE}
                           ELSE 0 END), 0) AS pending_estimated,
         COALESCE(SUM(CASE WHEN d.status = 'FAILED' THEN d.worker_share ELSE 0 END), 0) AS total_failed,
         COUNT(*) FILTER (WHERE d.id IS NULL) AS estimated_jobs
       FROM ${dbSchema}.bookings b
       LEFT JOIN ${dbSchema}.disbursements d ON d.booking_id = b.id AND d.worker_uid = $1
       WHERE b.worker_uid = $1 AND b.status = 'COMPLETED'
       ${dateFilter}`,
      params
    );

    const s = result.rows[0] || {};
    const money = (v: any) => Math.round(Number(v ?? 0) * 100) / 100;

    const totalPaid        = money(s.total_paid);
    const pendingRecorded  = money(s.pending_recorded);
    const pendingEstimated = money(s.pending_estimated);
    const totalFailed      = money(s.total_failed);
    const estimatedJobs    = Number(s.estimated_jobs ?? 0);

    // Rounded after summing, not before: rounding each part and adding would
    // let the displayed total drift from the parts by a centavo.
    const totalPending = money(Number(s.pending_recorded ?? 0) + Number(s.pending_estimated ?? 0));

    return res.status(200).json({
      status: "success",
      data: {
        // Every peso of provider share for completed bookings, authoritative
        // where a disbursement exists. The old value was
        // `providerShareOf(total_gross)`, which carried defect (1) above.
        totalEarned:  money(totalPaid + totalPending + totalFailed),
        totalPaid,
        totalPending,
        totalRefunded: 0,
        periodLabel: startDate ? "Custom range" : "All time",
        currency: "PHP",
        jobsCount: Number(s.total_jobs ?? 0),

        // ── Additive: existing consumers ignore these ────────────────────
        // Money owed whose payout FAILED. Split out of totalPending because a
        // failed payout needs intervention rather than patience, and folding
        // it into "pending" tells the provider it is coming.
        totalFailed,
        // The portion of totalPending that is a real recorded amount, and the
        // portion still estimated from final_price because no disbursement
        // row exists yet. §9 requires estimates to be labelled as estimates.
        pendingRecordedAmount:  pendingRecorded,
        pendingEstimatedAmount: pendingEstimated,
        pendingIsEstimate:      estimatedJobs > 0,
        estimatedJobsCount:     estimatedJobs,
      },
    });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: "Server error" });
  }
};

export const getLedger = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;

    const result = await dbQuery.query(
      `SELECT b.id, b.schedule, b.final_price, b.payment_method, b.status,
              so.level_2   AS service_name,
              d.status     AS payout_status,
              d.worker_share,
              d.released_at
       FROM ${dbSchema}.bookings b
       LEFT JOIN ${dbSchema}.service_options so ON so.id = b.service_option_id
       LEFT JOIN ${dbSchema}.disbursements d
              ON d.booking_id = b.id AND d.worker_uid = $1
       WHERE b.worker_uid = $1 AND b.status = 'COMPLETED'
       ORDER BY b.schedule DESC
       LIMIT 50`,
      [uid]
    );

    const data = result.rows.map((r: any) => {
      const gross = Number(r.final_price || 0);
      const code = bookingCode(r.id);

      // C20 F-01. This used to hardcode `status: "settled"` for every completed
      // booking and recompute the amount from final_price, without joining
      // `disbursements` at all — so a payout that had FAILED, or had not been
      // calculated yet, was reported to the provider as settled money.
      //
      // /provider/earnings/summary reads the same figures correctly, which meant
      // two endpoints disagreed about one booking. §1 requires pending,
      // available, held, processing, paid and reversed to stay distinct; one
      // word for all of them is the opposite.
      // C20 F-03. The third dialect, and the one this command introduced: the
      // F-01 fix had to stop hardcoding `settled`, and added `settled` as a
      // value in doing so. Derived from the same canonical source now.
      const status = ledgerPayoutDialect(r.payout_status);
      const payoutCanonical = canonicalPayoutStatus(r.payout_status);

      // Prefer the authoritative disbursed amount. final_price × rate is only
      // an ESTIMATE, used where no disbursement row exists yet, and it is
      // labelled as one rather than presented as a settled figure.
      const hasDisbursement = r.worker_share != null;
      const amountMinor = hasDisbursement
        ? Math.round(Number(r.worker_share) * 100)
        : Math.round(providerShareOf(gross) * 100);

      return {
        id: `led-${r.id}`,
        type: "booking_earning",
        direction: "credit",
        status,
        payoutStatusCanonical: payoutCanonical,
        isEstimate: !hasDisbursement,
        amountMinor,
        currency: "PHP",
        description: `${r.service_name || "Service"} · ${code}`,
        bookingId: String(r.id),
        bookingCode: code,
        additionalWorkRequestId: null,
        payoutId: null,
        reference: code,
        occurredAt: r.schedule,
        availableAt: null,
        // Only a RELEASED disbursement has actually settled, and it settled
        // when it was released — not when the booking was scheduled.
        settledAt: payoutCanonical === "paid" ? (r.released_at ?? null) : null,
      };
    });

    return res.status(200).json({ status: "success", data });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: "Server error" });
  }
};

// C20 F-03. Same column, second dialect — now derived rather than rewritten.
// Note it still collapses PROCESSING into "pending", which §1 says must stay
// distinct; that is preserved because consumers branch on these literals, and
// the distinction is carried by `payoutStatusCanonical` alongside it.
const _mapPayoutStatus = payoutsPayoutDialect;

export const getPayouts = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    const rows = await disbursementService.listDisbursements({ workerUid: uid });
    // Map to ProviderPayoutDto shape; exclude internal fields (servana_share, payout_error)
    const data = rows.map((r: any) => ({
      id:                String(r.id),
      amountMinor:       Math.round(Number(r.worker_share || 0) * 100),
      currency:          "PHP",
      status:            _mapPayoutStatus(r.status),
      payoutStatusCanonical: canonicalPayoutStatus(r.status),
      payoutMethodSummary: null,
      initiatedAt:       r.created_at    ? new Date(r.created_at).toISOString()    : null,
      expectedArrivalAt: r.release_after ? new Date(r.release_after).toISOString() : null,
      completedAt:       r.released_at   ? new Date(r.released_at).toISOString()   : null,
      failedAt:          null,
      failureMessage:    null,
      transactionCount:  1,
      // Processor identifiers are internal reconciliation data. Providers get
      // a stable Servana reference that support can safely discuss instead.
      reference:         `SVP-${String(r.id).padStart(6, "0")}`,
      events:            [],
      includedTransactionSummaries: [],
    }));
    return res.status(200).json({ status: "success", data });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: "Server error" });
  }
};

// ─── Review Status ────────────────────────────────────────────────────────────

export const getReviewStatus = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;

    const [workerRes, reqRes] = await Promise.all([
      dbQuery.query(
        `SELECT uid, first_name, last_name, email, is_email_verified, is_archive
         FROM ${dbSchema}.user_credentials WHERE uid = $1`,
        [uid]
      ),
      dbQuery.query(
        `SELECT id, file_url, file_name, uploaded_at
         FROM ${dbSchema}.worker_requirements WHERE worker_uid = $1`,
        [uid]
      ),
    ]);

    if (!workerRes.rowCount) {
      return res.status(404).json({ status: "failed", message: "Worker not found" });
    }

    const worker = workerRes.rows[0];
    const requirements = reqRes.rows;

    const hasRequirements = requirements.length > 0;
    const isVerified = worker.is_email_verified && hasRequirements;

    return res.status(200).json({
      status: "success",
      data: {
        reviewStatus: isVerified ? "approved" : hasRequirements ? "under_review" : "incomplete",
        isEmailVerified: worker.is_email_verified,
        requirementsUploaded: requirements.length,
        requirements: requirements.map((r: any) => ({
          id: r.id,
          fileName: r.file_name,
          fileUrl: r.file_url,
          uploadedAt: r.uploaded_at,
        })),
      },
    });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: "Server error" });
  }
};

export const submitForReview = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;

    const reqRes = await dbQuery.query(
      `SELECT COUNT(*) AS count FROM ${dbSchema}.worker_requirements WHERE worker_uid = $1`,
      [uid]
    );

    if (Number(reqRes.rows[0].count) === 0) {
      return res.status(400).json({
        status: "failed",
        message: "Please upload at least one requirement before submitting for review.",
      });
    }

    return res.status(200).json({
      status: "success",
      data: { reviewStatus: "under_review", message: "Submitted for review." },
    });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: "Server error" });
  }
};

// ─── Availability (canonical PostgreSQL engine — shared with mobile + admin) ──

export const getWorkerAvailability = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });
    const profile = await availEngine.getAvailabilityProfile(uid);
    const schedule = bridgeToWebSchedule(profile.weeklySchedule);
    return res.status(200).json({
      status: "success",
      data: { schedule, timezone: profile.timezone, updatedAt: profile.updatedAt, version: profile.version },
    });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: "Server error" });
  }
};

export const saveWorkerAvailability = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });
    const { schedule, timezone, expectedVersion } = req.body;
    if (!Array.isArray(schedule)) {
      return res.status(400).json({ status: "failed", message: "schedule must be an array" });
    }
    const submittedDays = schedule.map((day: any) => day?.day);
    const hasCanonicalWeek = schedule.length === WEB_ALL_DAYS.length
      && new Set(submittedDays).size === WEB_ALL_DAYS.length
      && WEB_ALL_DAYS.every(day => submittedDays.includes(day));
    const hasInvalidShape = schedule.some((day: any) =>
      typeof day?.enabled !== 'boolean' || !Array.isArray(day?.slots));
    if (!hasCanonicalWeek || hasInvalidShape) {
      return res.status(422).json({
        status: "failed",
        message: "schedule must contain each weekday exactly once with enabled and slots fields",
      });
    }
    const engineSlots = bridgeToEngineSlots(schedule);
    const result = await availEngine.saveWeeklySchedule(uid, engineSlots, timezone ?? "Asia/Manila", uid, expectedVersion);
    return res.status(200).json({ status: "success", data: { success: true, updatedAt: result.updatedAt, version: result.version } });
  } catch (error: any) {
    const code = error?.statusCode ?? 500;
    const message = [400, 409, 422].includes(code)
      ? (error?.message ?? "Invalid request")
      : "Server error";
    return res.status(code).json({ status: "failed", message });
  }
};

export const getWorkerTimeOff = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });
    const timeOff = await availEngine.listTimeOff(uid);
    return res.status(200).json({ status: "success", data: { timeOff: bridgeToWebTimeOff(timeOff) } });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: "Server error" });
  }
};

export const createWorkerTimeOff = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });
    const { startDate, endDate, reason, allDay, startTime, endTime, note } = req.body;
    if (!startDate || !endDate || !reason) {
      return res.status(400).json({ status: "failed", message: "startDate, endDate, and reason are required" });
    }
    // C22 §17. These four fields were destructured above and then dropped:
    // only startDate, endDate and reason were passed on. The provider web
    // portal has shipped a partial-day form the whole time, so a provider
    // asking for two hours off lost the entire day and the response told them
    // it was all-day.
    const record = await availEngine.createTimeOff(
      uid,
      { startDate, endDate, reason, allDay, startTime, endTime, note },
      uid,
    );
    // Report what was STORED, not what was asked for. Echoing the request
    // makes the response agree with the client by construction, which is
    // exactly how the original defect stayed invisible: the portal sent
    // partial-day fields, nothing persisted them, and the reply said allDay.
    const dto = {
      id:        String(record.id),
      startDate: record.startDate,
      endDate:   record.endDate,
      allDay:    record.allDay,
      startTime: record.startTime,
      endTime:   record.endTime,
      reason:    record.reason ?? reason,
      note:      record.note,
      createdAt: record.createdAt,

      // C22 §18. Confirmed bookings this time off collides with. The time off
      // WAS created — a provider who is ill must be able to say so — but the
      // work is still theirs, and the client is required to say that rather
      // than let them assume leave cancels it.
      bookingConflicts: record.bookingConflicts,
      conflictNotice: record.bookingConflicts.length > 0
        ? "Your time off is saved, but these bookings are still assigned to " +
          "you. Creating time off does not cancel accepted work — open each " +
          "booking to cancel or request a reschedule."
        : null,
    };
    return res.status(201).json({ status: "success", data: dto });
  } catch (error: any) {
    const code = error?.statusCode ?? 500;
    // A 422 carries an actionable reason ("endTime must be later than
    // startTime"). Flattening every status to "Server error" would hide the
    // validation this endpoint just gained and leave the provider guessing.
    const message = code === 422 || code === 400 || code === 404 || code === 409
      ? (error?.message ?? "Invalid request")
      : "Server error";
    return res.status(code).json({ status: "failed", message });
  }
};

export const deleteWorkerTimeOff = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });
    const { id } = req.params;
    if (!id) return res.status(400).json({ status: "failed", message: "id is required" });
    const numericId = Number(id);
    if (!Number.isInteger(numericId) || numericId <= 0) {
      return res.status(404).json({ status: "failed", message: "Time-off period not found" });
    }
    await availEngine.cancelTimeOff(uid, numericId, uid);
    return res.status(200).json({ status: "success", data: { success: true } });
  } catch (error: any) {
    const code = error?.statusCode ?? 500;
    const message = code === 404 ? (error?.message ?? "Time-off period not found") : "Server error";
    return res.status(code).json({ status: "failed", message });
  }
};

// ─── Requirements (Firebase Storage, scoped to authenticated worker) ──────────

export const uploadWorkerRequirement = async (req: Request, res: Response) => {
  void req;
  return res.status(410).json({
    status: "failed",
    code: "LEGACY_DOCUMENT_ENDPOINT_RETIRED",
    message: "Use POST /provider/documents for private document submission",
  });
};

export const getWorkerRequirementsOwn = async (req: Request, res: Response) => {
  void req;
  return res.status(410).json({
    status: "failed",
    code: "LEGACY_DOCUMENT_ENDPOINT_RETIRED",
    message: "Use GET /provider/documents for private document metadata",
  });
};

export const deleteWorkerRequirementOwn = async (req: Request, res: Response) => {
  void req;
  return res.status(410).json({
    status: "failed",
    code: "LEGACY_DOCUMENT_ENDPOINT_RETIRED",
    message: "Use DELETE /provider/documents/:documentId",
  });
};

// ─── Onboarding ───────────────────────────────────────────────────────────────

export const getOnboardingState = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });
    const data = await onboardingService.getOnboardingAggregate(uid);
    return res.status(200).json({ status: "success", data });
  } catch (error: any) {
    const code = (error as any).statusCode;
    return res.status(code ?? 500).json({ status: "failed", message: "Server error" });
  }
};

export const submitOnboarding = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });
    const data = await onboardingService.submitOnboarding(uid);
    autoOnlineEngine.evaluateProvider(uid, 'system', uid).catch(() => {});
    return res.status(200).json({ status: "success", data });
  } catch (error: any) {
    const code = (error as any).statusCode;

    /**
     * A refused submit must say WHAT is outstanding.
     *
     * submitOnboarding throws 422 with a `blockers` array — each entry carrying
     * the label a person needs ("No documents uploaded") — and this handler
     * collapsed all of it to "Server error". A provider was told only that
     * something was wrong with a form showing every field filled in, with no
     * way to discover which condition had failed. The labels are authored copy,
     * not exception text, so they are safe to return (§21).
     *
     * Anything that is not a 422 keeps the generic message: those are genuine
     * faults and their detail is not fit for a client.
     */
    const blockers = (error as any).blockers;
    if (code === 422 && Array.isArray(blockers)) {
      return res.status(422).json({
        status: "failed",
        message: "Some information still needs to be completed.",
        blockers,
      });
    }
    return res.status(code ?? 500).json({ status: "failed", message: "Server error" });
  }
};

export const saveOnboardingStep = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });
    /**
     * `stepKey` is accepted as well as `step`, and this is not tidiness.
     *
     * The provider portal has been sending `stepKey` (provider-onboarding-api
     * .service.ts) against a handler that only ever read `step`, so EVERY save
     * returned 400 "step is required" and the server-side draft was never
     * written. Submit then failed on incomplete-draft blockers, which made
     * provider signup impossible to complete — the toast a provider saw on
     * every step of the wizard.
     *
     * Accepting both here fixes browsers already holding the old bundle, which
     * a frontend deploy alone cannot reach. The portal now sends `step`; this
     * alias stays because removing it would re-break exactly those clients.
     */
    const { step, stepKey, ...payload } = req.body;
    const stepName = step ?? stepKey;
    if (!stepName) return res.status(400).json({ status: "failed", message: "step is required" });
    const data = await onboardingService.saveDraftStep(uid, stepName, payload);
    return res.status(200).json({ status: "success", data: { success: true, ...data } });
  } catch (error: any) {
    const code = (error as any).statusCode;
    return res.status(code ?? 500).json({ status: "failed", message: "Server error" });
  }
};

export const getProviderReconciliationReport = async (req: Request, res: Response) => {
  try {
    const data = await onboardingService.getReconciliationReport();
    return res.status(200).json({ status: "success", data });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: "Server error" });
  }
};

// ─── Additional work — provider-specific actions ───────────────────────────────

export const workerAdditionalDecision = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ status: "failed", message: "Invalid id" });
    const { decision } = req.body;
    if (!["ACCEPT", "REJECT"].includes(decision)) {
      return res.status(400).json({ status: "failed", message: "decision must be ACCEPT or REJECT" });
    }

    const ownership = await dbQuery.query(
      `SELECT bar.id, bar.status FROM ${dbSchema}.booking_additional_requests bar
       WHERE bar.id = $1 AND EXISTS (
         SELECT 1 FROM ${dbSchema}.booking_workers bw
         WHERE bw.booking_id = bar.booking_id AND bw.worker_uid = $2
           AND bw.status IN ('ASSIGNED','ACCEPTED','IN_PROGRESS','COMPLETED')
       )`,
      [id, uid]
    );
    if (!ownership.rowCount) {
      return res.status(404).json({ status: "failed", message: "Request not found or not assigned to you" });
    }
    if (ownership.rows[0].status !== "WAITING_WORKER_APPROVAL") {
      return res.status(409).json({ status: "failed", message: "Request is no longer awaiting your decision" });
    }

    const { additionalService } = await import("../services/additional.service");
    const data = await additionalService.workerDecision(id, decision as "ACCEPT" | "REJECT");

    return res.status(200).json({ status: "success", success: true, data });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: "Server error" });
  }
};

export const withdrawAdditionalWork = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ status: "failed", message: "Invalid id" });

    const result = await dbQuery.query(
      `UPDATE ${dbSchema}.booking_additional_requests bar
       SET status = 'CANCELLED', decided_at = NOW()
       WHERE bar.id = $1
         AND bar.status IN ('PENDING_ADMIN_APPROVAL','WAITING_WORKER_APPROVAL')
         AND bar.booking_id IN (
           SELECT booking_id FROM ${dbSchema}.booking_workers
           WHERE worker_uid = $2
             AND status IN ('ASSIGNED','ACCEPTED','IN_PROGRESS','COMPLETED')
         )
       RETURNING bar.*`,
      [id, uid]
    );

    if (!result.rowCount) {
      return res.status(404).json({ status: "failed", message: "Request not found, already decided, or not assigned to you" });
    }
    return res.status(200).json({ status: "success", success: true, data: result.rows[0] });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: "Server error" });
  }
};

export const confirmProceedAdditionalWork = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ status: "failed", message: "Invalid id" });

    // Ownership check: request must belong to a booking assigned to this worker
    const ownership = await dbQuery.query(
      `SELECT bar.id, bar.status FROM ${dbSchema}.booking_additional_requests bar
       WHERE bar.id = $1 AND EXISTS (
         SELECT 1 FROM ${dbSchema}.booking_workers bw
         WHERE bw.booking_id = bar.booking_id AND bw.worker_uid = $2
           AND bw.status IN ('ASSIGNED','ACCEPTED','IN_PROGRESS','COMPLETED')
       )`,
      [id, uid]
    );
    if (!ownership.rowCount) {
      return res.status(404).json({ status: "failed", message: "Request not found or not assigned to you" });
    }
    if (ownership.rows[0].status !== "ACCEPTED") {
      return res.status(409).json({ status: "failed", message: "Request must be in ACCEPTED state before confirming proceed" });
    }

    // Mark as in progress — worker has acknowledged and will perform the work.
    // IN_PROGRESS is the canonical value used by additional.service; reads stay
    // tolerant of historical PROCEEDING rows in the provider adapter.
    const result = await dbQuery.query(
      `UPDATE ${dbSchema}.booking_additional_requests
       SET status = 'IN_PROGRESS', updated_at = NOW()
       WHERE id = $1 AND status = 'ACCEPTED'
       RETURNING *, total_amount AS approved_amount`,
      [id]
    );

    if (!result.rowCount) {
      return res.status(409).json({ status: "failed", message: "Request state changed; refresh and try again" });
    }
    return res.status(200).json({ status: "success", success: true, data: result.rows[0] });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: "Server error" });
  }
};

// ─── Provider Profile (provider-portal specific) ─────────────────────────────

export const getProviderProfile = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });

    await ensureProfileTable();

    const result = await dbQuery.query(
      `SELECT uc.uid, uc.email, uc.first_name, uc.last_name,
              uc.phone_number AS phone, uc.worker_code, uc.role, uc.is_email_verified,
              uc.account_status,
              up.photo_url, up.service_preference
       FROM ${dbSchema}.user_credentials uc
       LEFT JOIN ${dbSchema}.user_profile up ON uc.uid = up.uid
       WHERE uc.uid = $1 LIMIT 1`,
      [uid]
    );

    if (!result.rows.length) {
      return res.status(404).json({ status: "failed", message: "Provider not found" });
    }

    const r = result.rows[0];
    return res.status(200).json({
      status: "success",
      data: {
        uid: r.uid,
        email: r.email,
        first_name: r.first_name,
        last_name: r.last_name,
        phone: r.phone,
        worker_code: r.worker_code || null,
        role: r.role,
        is_email_verified: r.is_email_verified,
        account_status: r.account_status || 'pending',
        photo_url: r.photo_url || null,
        service_category: r.service_preference || null,
      },
    });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: "Server error" });
  }
};

export const saveServicePreference = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });

    const { category } = req.body;
    if (!category || typeof category !== 'string' || !category.trim()) {
      return res.status(422).json({ status: "failed", message: "category is required" });
    }

    await ensureProfileTable();
    const safeCategory = category.trim().slice(0, 100);
    await dbQuery.query(
      `INSERT INTO ${dbSchema}.user_profile (uid, service_preference)
       VALUES ($1, $2)
       ON CONFLICT (uid) DO UPDATE SET service_preference = EXCLUDED.service_preference`,
      [uid, safeCategory]
    );

    return res.status(200).json({ status: "success", data: { service_category: safeCategory } });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: "Server error" });
  }
};

// ─── Security ────────────────────────────────────────────────────────────────

export const getProviderSecurity = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });

    const firebaseUser = await getFirebaseUserByUid(uid);
    const hasPassword = firebaseUser.providerData.some((p: any) => p.providerId === 'password');

    return res.status(200).json({
      status: 'success',
      data: {
        emailVerified: firebaseUser.emailVerified,
        email: firebaseUser.email || '',
        phoneVerified: !!firebaseUser.phoneNumber,
        phone: firebaseUser.phoneNumber || '',
        hasPassword,
        sessionCount: 1,
        lastPasswordChange: null,
        sessions: [],
      },
    });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: "Server error" });
  }
};

// ─── Notifications ────────────────────────────────────────────────────────────

export const getProviderNotifications = async (req: Request, res: Response) => {
  try {
    const uid: string = (req as any).user?.uid;
    const filter = req.query['filter'] as string | undefined;
    const data = await notificationService.listNotifications(uid, filter);
    return res.status(200).json({ status: "success", data });
  } catch (e: any) {
    return res.status(500).json({ status: "failed", message: e.message });
  }
};

export const getNotificationsUnreadCount = async (req: Request, res: Response) => {
  try {
    const uid: string = (req as any).user?.uid;
    const count = await notificationService.countUnreadNotifications(uid);
    return res.status(200).json({ status: "success", data: { count } });
  } catch (e: any) {
    return res.status(500).json({ status: "failed", message: e.message });
  }
};

export const getProviderAlerts = async (req: Request, res: Response) => {
  try {
    const uid: string = (req as any).user?.uid;
    const data = await notificationService.listAlerts(uid);
    return res.status(200).json({ status: "success", data });
  } catch (e: any) {
    return res.status(500).json({ status: "failed", message: e.message });
  }
};

export const markNotificationRead = async (req: Request, res: Response) => {
  try {
    const { key } = req.params;
    if (!notificationService.isSafeNotificationKey(key)) {
      return res.status(400).json({ status: "failed", message: "Invalid notification key" });
    }
    const uid: string = (req as any).user?.uid;
    const result = await notificationService.markNotificationReadByKey(uid, key);
    if (!result.found) return res.status(404).json({ status: "failed", message: "Notification not found" });
    if (!result.allowed) return res.status(409).json({ status: "failed", message: "Notification cannot be marked read" });
    return res.status(200).json({ status: "success", data: { success: true, changed: result.changed } });
  } catch (e: any) {
    return res.status(500).json({ status: "failed", message: e.message });
  }
};

export const markAllNotificationsRead = async (req: Request, res: Response) => {
  try {
    const uid: string = (req as any).user?.uid;
    await notificationService.markAllNotificationsReadForWorker(uid);
    return res.status(200).json({ status: "success", data: { success: true } });
  } catch (e: any) {
    return res.status(500).json({ status: "failed", message: e.message });
  }
};

export const dismissNotification = async (req: Request, res: Response) => {
  try {
    const { key } = req.params;
    if (!notificationService.isSafeNotificationKey(key)) {
      return res.status(400).json({ status: "failed", message: "Invalid notification key" });
    }
    const uid: string = (req as any).user?.uid;
    const result = await notificationService.deleteNotificationByKey(uid, key);
    if (!result.found) return res.status(404).json({ status: "failed", message: "Notification not found" });
    if (!result.allowed) return res.status(409).json({ status: "failed", message: "Notification cannot be dismissed" });
    return res.status(200).json({ status: "success", data: { success: true } });
  } catch (e: any) {
    return res.status(500).json({ status: "failed", message: e.message });
  }
};

export const dismissAlert = async (req: Request, res: Response) => {
  try {
    const { key } = req.params;
    if (!notificationService.isSafeNotificationKey(key)) {
      return res.status(400).json({ status: "failed", message: "Invalid alert key" });
    }
    const uid: string = (req as any).user?.uid;
    const result = await notificationService.deleteAlertByKey(uid, key);
    if (!result.found) return res.status(404).json({ status: "failed", message: "Alert not found" });
    if (!result.allowed) return res.status(409).json({ status: "failed", message: "Alert cannot be dismissed" });
    return res.status(200).json({ status: "success", data: { success: true } });
  } catch (e: any) {
    return res.status(500).json({ status: "failed", message: e.message });
  }
};

// ─── Support Tickets ──────────────────────────────────────────────────────────

export const getSupportTickets = async (req: Request, res: Response) => {
  try {
    const uid: string = (req as any).user?.uid;
    const data = await notificationService.listSupportTickets(uid);
    return res.status(200).json({ status: "success", data });
  } catch (e: any) {
    return res.status(500).json({ status: "failed", message: e.message });
  }
};

export const createSupportTicket = async (req: Request, res: Response) => {
  try {
    const { subject, message, category } = req.body;
    if (!subject || !message) {
      return res.status(400).json({ status: "failed", message: "subject and message are required" });
    }
    const uid: string = (req as any).user?.uid;
    const ticket = await notificationService.createSupportTicketRecord(
      uid,
      String(subject).substring(0, 100),
      String(message).substring(0, 1000),
      category || 'other',
    );
    return res.status(201).json({ status: "success", data: ticket });
  } catch (e: any) {
    return res.status(500).json({ status: "failed", message: e.message });
  }
};

// ─── Notification Preferences ─────────────────────────────────────────────────

export const getNotificationPreferences = async (req: Request, res: Response) => {
  try {
    const uid: string = (req as any).user?.uid;
    const data = await notificationService.getNotificationPrefs(uid);
    return res.status(200).json({ status: "success", data });
  } catch (e: any) {
    return res.status(500).json({ status: "failed", message: e.message });
  }
};

export const updateNotificationPreferences = async (req: Request, res: Response) => {
  try {
    const uid: string = (req as any).user?.uid;
    const data = await notificationService.saveNotificationPrefs(uid, req.body);
    return res.status(200).json({ status: "success", data });
  } catch (e: any) {
    return res.status(500).json({ status: "failed", message: e.message });
  }
};

// ─── Safety Incidents (MongoDB — provider_safety_incidents) ───────────────────

const SAFETY_STATE_LABELS: Record<string, string> = {
  draft: 'Draft', submitting: 'Submitting…', submitted: 'Submitted',
  received: 'Received', triage_pending: 'Triage Pending',
  provider_action_req: 'Action Required', under_review: 'Under Review',
  escalated: 'Escalated', booking_action_pending: 'Booking Action Pending',
  resolved: 'Resolved', closed: 'Closed', reopened: 'Reopened',
};

const SAFETY_STATE_TONES: Record<string, string> = {
  draft: 'muted', submitting: 'info', submitted: 'info', received: 'info',
  triage_pending: 'warning', provider_action_req: 'warning', under_review: 'info',
  escalated: 'danger', booking_action_pending: 'warning',
  resolved: 'success', closed: 'muted', reopened: 'warning',
};

const SAFETY_CATEGORY_LABELS: Record<string, string> = {
  harassment: 'Harassment or Abusive Behavior',
  physical_threat: 'Physical Threat or Assault',
  sexual_harassment: 'Sexual Harassment',
  unsafe_environment: 'Unsafe Environment or Hazard',
  animal_hazard: 'Animal Hazard',
  unsafe_request: 'Unsafe or Illegal Service Request',
  access_problem: 'Access Problem',
  customer_no_show: 'Customer No-Show',
  injury: 'Injury',
  property_damage: 'Property Damage',
  medical_event: 'Medical Emergency',
  near_miss: 'Near Miss or Close Call',
  weather_hazard: 'Weather or Natural Disaster',
  transport_incident: 'Transport or Travel Incident',
  other: 'Other Safety Concern',
};

const SAFETY_SEVERITY_LABELS: Record<string, string> = {
  level_0: 'General Safety Information',
  level_1: 'Low-Risk Concern',
  level_2: 'Operational Safety Issue',
  level_3: 'Serious Incident',
  level_4: 'Immediate Danger / Emergency',
};

const SAFETY_SEVERITY_ICONS: Record<string, string> = {
  level_0: 'bi-info-circle',
  level_1: 'bi-exclamation-circle',
  level_2: 'bi-exclamation-triangle-fill',
  level_3: 'bi-shield-exclamation',
  level_4: 'bi-shield-fill-exclamation',
};

const PHILIPPINES_EMERGENCY_CONFIG = {
  locale: 'en-PH',
  country: 'Philippines',
  lines: [
    { label: 'National Emergency Hotline', number: 'tel:911', dialLabel: '911', description: 'Fire, medical emergency, police' },
    { label: 'Philippine National Police', number: 'tel:117', dialLabel: '117', description: 'Police assistance' },
    { label: 'Bureau of Fire Protection', number: 'tel:160', dialLabel: '160', description: 'Fire and rescue' },
  ],
  disclaimer: 'Tapping a number opens your device dialer. Servana cannot dispatch emergency services on your behalf.',
};

function toSafetyCaseSummary(doc: any) {
  const state: string = doc.state || 'submitted';
  const category: string = doc.category || 'other';
  const severity: string = doc.severity || 'level_0';
  const isOpen = !['resolved', 'closed'].includes(state);
  const requiresAction = state === 'provider_action_req';
  return {
    caseKey:               doc.incidentId,
    providerSafeReference: doc.providerSafeReference,
    category,
    categoryLabel:         SAFETY_CATEGORY_LABELS[category] || category,
    severity,
    severityLabel:         SAFETY_SEVERITY_LABELS[severity] || severity,
    severityIcon:          SAFETY_SEVERITY_ICONS[severity] || 'bi-info-circle',
    state,
    stateLabel:            SAFETY_STATE_LABELS[state] || state,
    stateTone:             SAFETY_STATE_TONES[state] || 'muted',
    isOpen,
    requiresAction,
    bookingId:             doc.bookingId || null,
    reportedAt:            doc.reportedAt || null,
    updatedAt:             doc.updatedAt || null,
    hasUnreadUpdate:       doc.hasUnreadUpdate || false,
  };
}

export const submitSafetyIncident = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });

    const {
      clientIncidentId, bookingId, category, severity,
      immediateDanger, providerSafe, workStopped,
      emergencyServicesContacted, description,
    } = req.body;

    if (!clientIncidentId || !category || !severity || !description) {
      return res.status(400).json({ status: "failed", message: "clientIncidentId, category, severity, and description are required" });
    }
    if (String(description).trim().length < 10) {
      return res.status(400).json({ status: "failed", message: "description must be at least 10 characters" });
    }

    const col = (await mongoDb).collection("provider_safety_incidents");

    const existing = await col.findOne({ uid, clientIncidentId }, { projection: { incidentId: 1 } });
    if (existing) {
      return res.status(409).json({ status: "failed", message: "This incident has already been submitted" });
    }

    const year = new Date().getFullYear();
    const ref = `SAF-${year}-${Date.now().toString(36).slice(-5).toUpperCase()}`;
    const incidentId = `inc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const now = new Date().toISOString();

    const doc = {
      uid,
      incidentId,
      clientIncidentId: String(clientIncidentId).slice(0, 128),
      providerSafeReference: ref,
      bookingId:                    bookingId || null,
      category:                     String(category).slice(0, 64),
      severity:                     String(severity).slice(0, 32),
      state:                        'submitted',
      immediateDanger:              !!immediateDanger,
      providerSafe:                 providerSafe !== undefined ? providerSafe : null,
      workStopped:                  !!workStopped,
      emergencyServicesContacted:   emergencyServicesContacted !== undefined ? emergencyServicesContacted : null,
      description:                  String(description).trim().slice(0, 2000),
      reportedAt:                   now,
      updatedAt:                    now,
      hasUnreadUpdate:              false,
    };

    await col.insertOne(doc);

    return res.status(201).json({
      status: "success",
      data: { caseKey: incidentId, providerSafeReference: ref, state: 'submitted' },
    });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: "Server error" });
  }
};

export const getSafetyIncidents = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });
    const col = (await mongoDb).collection("provider_safety_incidents");
    const docs = await col
      .find({ uid }, { projection: { _id: 0, uid: 0, clientIncidentId: 0 } })
      .sort({ reportedAt: -1 })
      .limit(50)
      .toArray();
    return res.status(200).json({ status: "success", data: docs.map(toSafetyCaseSummary) });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: "Server error" });
  }
};

export const getEmergencyConfig = async (_req: Request, res: Response) => {
  return res.status(200).json({ status: "success", data: PHILIPPINES_EMERGENCY_CONFIG });
};

// ─── Security — password + session revocation (Firebase Admin) ────────────────

export const changeProviderPassword = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });
    const { newPassword } = req.body;
    if (!newPassword || String(newPassword).length < 6) {
      return res.status(400).json({ status: "failed", message: "newPassword must be at least 6 characters" });
    }
    await updateFirebasePassword(uid, String(newPassword));
    await revokeTokenInFirebase(uid);
    return res.status(200).json({ status: "success", data: null, message: "Password updated. Please sign in again." });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: "Server error" });
  }
};

export const revokeProviderSession = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });
    // Firebase revokeRefreshTokens revokes all tokens — per-session revocation is not supported
    await revokeTokenInFirebase(uid);
    return res.status(200).json({ status: "success", data: null, message: "Session revoked." });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: "Server error" });
  }
};

export const revokeAllProviderSessions = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });
    await revokeTokenInFirebase(uid);
    return res.status(200).json({ status: "success", data: null, message: "All other sessions revoked." });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: "Server error" });
  }
};

// ─── Service Area (canonical PostgreSQL engine — shared with mobile + admin) ──

export const getWorkerServiceArea = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });
    const profile = await areaEngine.getServiceAreaProfile(uid);
    return res.status(200).json({
      status: "success",
      data: { cityIds: profile.cityIds, label: profile.label ?? '', updatedAt: profile.updatedAt },
    });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: "Server error" });
  }
};

/**
 * GET /provider/performance
 *
 * Scoped to the caller's own uid from the verified token — there is no :uid
 * parameter, so one provider cannot read another's performance by guessing an
 * identifier (§11, §12).
 */
export const getProviderPerformanceMetrics = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });
    const data = await getProviderPerformance(uid);
    return res.status(200).json({ status: "success", data });
  } catch (error: any) {
    console.error("[providerController] getProviderPerformanceMetrics error:", error?.message ?? error);
    return res.status(500).json({ status: "failed", message: "Server error" });
  }
};

export const saveWorkerServiceArea = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });
    const { cityIds } = req.body;
    if (!Array.isArray(cityIds)) {
      return res.status(400).json({ status: "failed", message: "cityIds must be an array" });
    }
    const result = await areaEngine.saveServiceArea(uid, { coverageMode: 'city', cityIds }, uid);
    return res.status(200).json({ status: "success", data: { success: true, updatedAt: result.updatedAt } });
  } catch (error: any) {
    const code = error?.statusCode ?? 500;
    return res.status(code).json({ status: "failed", message: "Server error" });
  }
};

// ─── Profile Photo (Firebase Storage + user_profile table) ───────────────────

let _profileTableReady: Promise<void> | null = null;
function ensureProfileTable(): Promise<void> {
  if (!_profileTableReady) {
    _profileTableReady = (async () => {
      await dbQuery.query(`
        CREATE TABLE IF NOT EXISTS ${dbSchema}.user_profile (
          uid       VARCHAR(128) PRIMARY KEY,
          photo_url TEXT
        )
      `);
      // Add updated_at if the table pre-existed without it
      await dbQuery.query(`
        ALTER TABLE ${dbSchema}.user_profile
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()
      `);
      // Add service_preference for popup category selection persistence
      await dbQuery.query(`
        ALTER TABLE ${dbSchema}.user_profile
        ADD COLUMN IF NOT EXISTS service_preference VARCHAR(100)
      `);
    })().catch(err => {
      // Reset so the next request retries instead of using the cached rejection.
      _profileTableReady = null;
      throw err;
    });
  }
  return _profileTableReady;
}

const ALLOWED_PHOTO_MIMES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];

export const uploadWorkerProfilePhoto = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });
    const { file } = req.body;
    if (!file) {
      return res.status(400).json({ status: "failed", message: "file (data URI) is required" });
    }
    const submission = await submitProfilePhoto(uid, {
      file: String(file),
      clientRequestId: String(req.body?.clientRequestId ?? `legacy-photo-${randomUUID()}`),
    });
    // Compatibility: legacy web clients expect safeUrl. A pending submission
    // never replaces the currently approved public URL.
    const current = await dbQuery.query(`SELECT photo_url FROM ${dbSchema}.user_profile WHERE uid = $1 LIMIT 1`, [uid]);
    return res.status(202).json({ status: "success", data: {
      safeUrl: current.rows[0]?.photo_url ?? '',
      uploadedAt: submission.submittedAt,
      submissionId: submission.submissionId,
      reviewState: submission.state,
    } });
  } catch (error: any) {
    const status = Number(error?.statusCode ?? 500);
    if (status === 500) console.error("[uploadWorkerProfilePhoto] 500:", error?.message ?? error);
    return res.status(status).json({ status: "failed", code: error?.code ?? 'PROFILE_PHOTO_SUBMISSION_FAILED', message: status === 500 ? "Server error" : error.message });
  }
};

export const deleteWorkerProfilePhoto = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });
    await ensureProfileTable();
    // Read current URL so we can delete the file from Firebase Storage.
    const existing = await dbQuery.query(
      `SELECT photo_url FROM ${dbSchema}.user_profile WHERE uid = $1 LIMIT 1`,
      [uid]
    );
    const photoUrl: string | null = existing.rows[0]?.photo_url ?? null;
    // Clear the DB record first — UI can update immediately.
    await dbQuery.query(
      `INSERT INTO ${dbSchema}.user_profile (uid, photo_url, updated_at)
       VALUES ($1, NULL, NOW())
       ON CONFLICT (uid) DO UPDATE SET photo_url = NULL, updated_at = NOW()`,
      [uid]
    );
    // Best-effort: delete the object from Firebase Storage.
    if (photoUrl && photoUrl.includes('firebasestorage.googleapis.com')) {
      try {
        const match = photoUrl.match(/\/o\/([^?]+)/);
        if (match) {
          const filePath = decodeURIComponent(match[1]);
          const bucket = (await import('../middleware/firebaseApp')).firebaseAdmin.storage().bucket();
          await bucket.file(filePath).delete().catch(() => {/* file may not exist */});
        }
      } catch {
        /* non-fatal — DB record is already cleared */
      }
    }
    return res.status(200).json({ status: "success", data: null });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: "Server error" });
  }
};

// ─── Payout Settings (MongoDB — worker_payout_methods) ───────────────────────

// PayMongo bank_code → display label mapping (all supported channels)
const PAYOUT_TYPE_LABELS: Record<string, string> = {
  gcash:         'GCash',
  maya:          'Maya (PayMaya)',
  bdo:           'BDO Unibank',
  bpi:           'BPI',
  unionbank:     'UnionBank',
  landbank:      'Landbank of the Philippines',
  metrobank:     'Metrobank',
  pnb:           'Philippine National Bank',
  rcbc:          'RCBC',
  china_bank:    'China Banking Corporation',
  security_bank: 'Security Bank',
  maybank:       'Maybank Philippines',
  ew_bank:       'EastWest Bank',
  ps_bank:       'PSBank',
};

// Map FE type key → PayMongo bank_code for Disbursements API
const PAYMONGO_BANK_CODE: Record<string, string> = {
  gcash:         'GCASH',
  maya:          'PAYMAYA',
  bdo:           'BDO',
  bpi:           'BPI',
  unionbank:     'UNIONBANK',
  landbank:      'LANDBANK',
  metrobank:     'METROBANK',
  pnb:           'PNB',
  rcbc:          'RCBC',
  china_bank:    'CHINA_BANK',
  security_bank: 'SECURITY_BANK',
  maybank:       'MAYBANK',
  ew_bank:       'EW_BANK',
  ps_bank:       'PS_BANK',
};

const EWALLET_TYPES  = new Set<string>(['gcash', 'maya']);
const PH_MOBILE_RE   = /^(09\d{9}|(\+63)9\d{9})$/;
const BANK_ACCT_RE   = /^\d{8,16}$/;
const ACCT_NAME_RE   = /^[A-Za-zÀ-ÖØ-öø-ÿ .'\-]{2,100}$/;
const PAYOUT_STATUS_LABELS: Record<string, string> = {
  verified: 'Verified', unverified: 'Unverified', pending: 'Pending review',
  failed: 'Verification failed', missing: 'Not set up',
};

export const getProviderPayoutSummary = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });
    const col = (await mongoDb).collection("worker_payout_methods");
    const doc = await col.findOne({ uid }, { projection: { _id: 0, uid: 0 } });
    if (!doc) {
      return res.status(200).json({
        status: "success",
        data: {
          hasPayoutMethod: false, type: null, typeLabel: 'Not set up',
          maskedIdentifier: null, status: 'missing', statusLabel: 'Not set up', lastUpdated: null,
        },
      });
    }
    return res.status(200).json({
      status: "success",
      data: {
        hasPayoutMethod:  true,
        type:             doc.type,
        typeLabel:        PAYOUT_TYPE_LABELS[doc.type] || doc.type,
        accountName:      doc.accountName || null,
        maskedIdentifier: doc.maskedIdentifier || null,
        status:           doc.status || 'pending',
        statusLabel:      PAYOUT_STATUS_LABELS[doc.status] || 'Pending review',
        lastUpdated:      doc.updatedAt || null,
      },
    });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: "Server error" });
  }
};

export const requestProviderPayoutUpdate = async (_req: Request, res: Response) => {
  // No external payment processor redirect — returns the in-app payout update route.
  return res.status(200).json({
    status: "success",
    data: { sessionUrl: '/settings/payout/update' },
  });
};

export const registerProviderPayout = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });

    const { type, accountNumber, accountName } = req.body;

    if (!type || !PAYMONGO_BANK_CODE[type]) {
      return res.status(400).json({ status: "failed", message: "Invalid payout type. Choose a supported bank or e-wallet." });
    }

    const trimmedName   = String(accountName   ?? '').trim();
    const trimmedNumber = String(accountNumber ?? '').trim();

    if (!ACCT_NAME_RE.test(trimmedName)) {
      return res.status(400).json({ status: "failed", message: "Account name must be 2–100 characters (letters and spaces only)." });
    }

    const isEwallet = EWALLET_TYPES.has(type);
    if (isEwallet) {
      if (!PH_MOBILE_RE.test(trimmedNumber)) {
        return res.status(400).json({ status: "failed", message: "Enter a valid Philippine mobile number (e.g. 09171234567)." });
      }
    } else {
      if (!BANK_ACCT_RE.test(trimmedNumber)) {
        return res.status(400).json({ status: "failed", message: "Account number must be 8–16 digits." });
      }
    }

    // Normalize mobile: +639XXXXXXXXX → 09XXXXXXXXX for consistent storage
    const normalizedNumber = trimmedNumber.startsWith('+63')
      ? '0' + trimmedNumber.slice(3)
      : trimmedNumber;

    const bankCode = PAYMONGO_BANK_CODE[type];
    const maskedIdentifier = '•••• ' + normalizedNumber.slice(-4);

    // Store full PayMongo-ready details in PostgreSQL (used by disbursement engine)
    await technicianService.upsertWorkerBankAccount(uid, {
      bankCode,
      accountNumber: normalizedNumber,
      accountName:   trimmedName,
    });

    // Store display record in MongoDB (masked, for provider UI).
    // If MongoDB write fails, best-effort rollback of the PG record to avoid split state.
    try {
      const col = (await mongoDb).collection("worker_payout_methods");
      await col.updateOne(
        { uid },
        { $set: { uid, type, accountName: trimmedName, maskedIdentifier, status: 'pending', updatedAt: new Date() } },
        { upsert: true }
      );
    } catch (mongoErr: any) {
      await technicianService.deleteWorkerBankAccount(uid).catch(() => {});
      throw mongoErr;
    }

    return res.status(200).json({
      status: "success",
      data: {
        hasPayoutMethod: true,
        type,
        typeLabel:        PAYOUT_TYPE_LABELS[type] || type,
        accountName:      trimmedName,
        maskedIdentifier,
        status:           'pending',
        statusLabel:      'Pending review',
        lastUpdated:      new Date().toISOString(),
      },
    });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: "Server error" });
  }
};

// ─── Privacy / Account Actions (MongoDB — worker_account_requests) ────────────

export const getProviderPrivacy = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });

    const [requestDoc, bookingsRes] = await Promise.all([
      (await mongoDb).collection("worker_account_requests").findOne({ uid }, { projection: { _id: 0, uid: 0 } }),
      dbQuery.query(
        `SELECT COUNT(*) AS cnt FROM ${dbSchema}.bookings
         WHERE worker_uid = $1 AND status NOT IN ('COMPLETED', 'CANCELLED', 'REJECTED')`,
        [uid]
      ),
    ]);

    const r: any = requestDoc || {};
    return res.status(200).json({
      status: "success",
      data: {
        dataExportStatus:      r.exportStatus       || 'none',
        dataExportRequestedAt: r.exportRequestedAt  || null,
        deactivationStatus:    r.deactivationStatus || 'none',
        deletionStatus:        r.deletionStatus     || 'none',
        hasActiveBookings:     Number(bookingsRes.rows[0]?.cnt ?? 0) > 0,
        hasUnsettledPayouts:   false, // TODO: query payout pipeline when available
        hasOpenDisputes:       false, // TODO: query disputes table when available
      },
    });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: "Server error" });
  }
};

export const requestProviderDataExport = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });
    const now = new Date().toISOString();
    const col = (await mongoDb).collection("worker_account_requests");
    await col.updateOne(
      { uid },
      { $set: { uid, exportStatus: 'pending', exportRequestedAt: now, updatedAt: now } },
      { upsert: true }
    );
    return res.status(200).json({
      status: "success",
      data: { status: 'pending' },
      message: "Export request submitted. You will be notified when your data is ready.",
    });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: "Server error" });
  }
};

export const requestProviderDeactivation = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });
    const { reason } = req.body;
    const now = new Date().toISOString();
    const col = (await mongoDb).collection("worker_account_requests");
    await col.updateOne(
      { uid },
      { $set: { uid, deactivationStatus: 'requested', deactivationReason: reason || null, deactivationRequestedAt: now, updatedAt: now } },
      { upsert: true }
    );
    return res.status(200).json({
      status: "success",
      data: null,
      message: "Deactivation request submitted. Our team will review and contact you.",
    });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: "Server error" });
  }
};

export const requestProviderDeletion = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });
    const { reason } = req.body;

    const bookingsRes = await dbQuery.query(
      `SELECT COUNT(*) AS cnt FROM ${dbSchema}.bookings
       WHERE worker_uid = $1 AND status NOT IN ('COMPLETED', 'CANCELLED', 'REJECTED')`,
      [uid]
    );
    if (Number(bookingsRes.rows[0]?.cnt ?? 0) > 0) {
      return res.status(409).json({
        status: "failed",
        message: "You have active bookings. Please complete or cancel them before requesting account deletion.",
      });
    }

    const now = new Date().toISOString();
    const col = (await mongoDb).collection("worker_account_requests");
    await col.updateOne(
      { uid },
      { $set: { uid, deletionStatus: 'requested', deletionReason: reason || null, deletionRequestedAt: now, updatedAt: now } },
      { upsert: true }
    );
    return res.status(200).json({
      status: "success",
      data: null,
      message: "Deletion request submitted. Your account will be permanently deleted within 30 days.",
    });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: "Server error" });
  }
};

// ─── Support Ticket Follow-ons ────────────────────────────────────────────────

export const getSupportTicketDetail = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });
    const ticketKey = String(req.params.ticketKey);
    const ticket = await notificationService.getSupportTicketDetail(uid, ticketKey);
    if (!ticket) return res.status(404).json({ status: "failed", message: "Ticket not found" });
    return res.status(200).json({ status: "success", data: ticket });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: "Server error" });
  }
};

export const addSupportTicketReply = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });
    const ticketKey = String(req.params.ticketKey);
    const { message } = req.body;
    if (!message || String(message).trim().length < 2) {
      return res.status(400).json({ status: "failed", message: "message is required" });
    }
    const result = await notificationService.addSupportTicketReply(uid, ticketKey, String(message).trim());
    if (!result) return res.status(404).json({ status: "failed", message: "Ticket not found" });
    if ((result as any).error) {
      return res.status(409).json({ status: "failed", message: (result as any).error });
    }
    return res.status(200).json({ status: "success", data: result });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: "Server error" });
  }
};

export const closeSupportTicket = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });
    const ticketKey = String(req.params.ticketKey);
    const result = await notificationService.closeSupportTicket(uid, ticketKey);
    if (!result) return res.status(404).json({ status: "failed", message: "Ticket not found or cannot be closed in its current state" });
    return res.status(200).json({ status: "success", data: result });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: "Server error" });
  }
};

export const reopenSupportTicket = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });
    const ticketKey = String(req.params.ticketKey);
    const result = await notificationService.reopenSupportTicket(uid, ticketKey);
    if (!result) return res.status(404).json({ status: "failed", message: "Ticket not found or not eligible for reopen" });
    return res.status(200).json({ status: "success", data: result });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: "Server error" });
  }
};

export const getSupportUnreadCount = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });
    const count = await notificationService.countUnreadSupportReplies(uid);
    return res.status(200).json({ status: "success", data: { count } });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: "Server error" });
  }
};

// ─── Safety Check-In Timestamps (MongoDB — worker_safety_checkins) ────────────

const VALID_CHECKIN_STAGES = new Set(['en_route', 'arrived', 'started', 'completed']);

export const recordSafetyCheckIn = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });
    const { bookingId, stage } = req.body;
    if (!bookingId || !stage) {
      return res.status(400).json({ status: "failed", message: "bookingId and stage are required" });
    }
    if (!VALID_CHECKIN_STAGES.has(String(stage))) {
      return res.status(400).json({
        status: "failed",
        message: "stage must be one of: en_route, arrived, started, completed",
      });
    }
    const checkedInAt = new Date().toISOString();
    const col = (await mongoDb).collection("worker_safety_checkins");
    await col.insertOne({ uid, bookingId: String(bookingId), stage: String(stage), checkedInAt });
    return res.status(201).json({ status: "success", data: { success: true, stage, checkedInAt } });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: "Server error" });
  }
};


// ─── Service Applications ─────────────────────────────────────────────────────

const toApplicationDto = (app: any) => ({
  id: app.id,
  serviceId: Number(app.service_id),
  serviceName: app.service_name ?? app.service_snapshot?.name ?? null,
  serviceCategory: app.service_category ?? app.service_snapshot?.category ?? null,
  status: app.status,
  submittedAt: app.submitted_at,
  updatedAt: app.updated_at,
  cancelledAt: app.cancelled_at ?? null,
  approvedAt: app.approved_at ?? null,
  providerReasonCode: app.provider_reason_code ?? null,
  providerReasonDetail: app.provider_reason_detail ?? null,
  requirementsVersion: Number(app.requirements_version ?? 1),
  version: Number(app.version),
  ...(Array.isArray(app.timeline) ? {
    timeline: app.timeline.map((event: any) => ({
      code: event.event_code,
      label: event.provider_label,
      explanation: event.provider_explanation ?? null,
      actorCategory: event.actor_category,
      createdAt: event.created_at,
    })),
  } : {}),
});

export const getServiceApplications = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ success: false, message: "Unauthorized" });

    const applications = await serviceApplicationService.getApplicationsByWorker(uid);
    return res.json({ success: true, applications: applications.map(toApplicationDto) });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

export const submitServiceApplication = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ success: false, message: "Unauthorized" });

    const serviceId = Number(req.body?.serviceId);
    if (!Number.isInteger(serviceId) || serviceId <= 0) {
      return res.status(400).json({ success: false, message: "serviceId (positive integer) is required" });
    }

    const clientRequestId = typeof req.body?.clientRequestId === 'string'
      ? req.body.clientRequestId.trim()
      : '';
    const requirementsVersion = Number(req.body?.requirementsVersion);
    if (clientRequestId.length < 16 || clientRequestId.length > 128) {
      return res.status(400).json({ success: false, code: 'INVALID_IDEMPOTENCY_KEY', message: 'clientRequestId must be between 16 and 128 characters' });
    }
    if (!Number.isInteger(requirementsVersion) || requirementsVersion <= 0) {
      return res.status(400).json({ success: false, code: 'INVALID_REQUIREMENTS_VERSION', message: 'requirementsVersion (positive integer) is required' });
    }

    const app = await serviceApplicationService.submitApplication(uid, serviceId, { clientRequestId, requirementsVersion });
    autoOnlineEngine.evaluateProvider(uid, 'system', uid).catch(() => {});
    return res.status(201).json({ success: true, application: toApplicationDto(app) });
  } catch (error: any) {
    const status = error.statusCode ?? 500;
    return res.status(status).json({
      success: false,
      code: error.code ?? "INTERNAL_ERROR",
      message: error.message || "Failed to submit application",
      ...(error.application ? { application: toApplicationDto(error.application) } : {}),
    });
  }
};

export const getServiceApplicationDetail = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const applicationId = String(req.params.applicationId ?? '').trim();
    if (!applicationId) return res.status(400).json({ success: false, message: 'applicationId is required' });
    const app = await serviceApplicationService.getApplicationByWorker(applicationId, uid);
    return res.json({ success: true, application: toApplicationDto(app) });
  } catch (error: any) {
    return res.status(error.statusCode ?? 500).json({ success: false, code: error.code ?? 'INTERNAL_ERROR', message: error.message || 'Failed to load application' });
  }
};

export const getServiceApplicationEligibility = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const serviceId = Number(req.params.serviceId);
    if (!Number.isInteger(serviceId) || serviceId <= 0) {
      return res.status(400).json({ success: false, message: 'serviceId must be a positive integer' });
    }
    const eligibility = await serviceApplicationService.evaluateApplicationEligibility(uid, serviceId);
    return res.json({ success: true, eligibility });
  } catch (error: any) {
    return res.status(error.statusCode ?? 500).json({ success: false, code: error.code ?? 'INTERNAL_ERROR', message: 'Failed to evaluate service eligibility' });
  }
};

export const getProviderServicesOverview = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const overview = await serviceApplicationService.getProviderServicesOverview(uid);
    return res.json({
      success: true,
      services: overview.services,
      applications: overview.applications.map(toApplicationDto),
    });
  } catch {
    return res.status(500).json({ success: false, message: 'Failed to load provider services' });
  }
};

export const cancelServiceApplication = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ success: false, message: "Unauthorized" });

    const { applicationId } = req.params as { applicationId: string };
    if (!applicationId) return res.status(400).json({ success: false, message: "applicationId is required" });

    const app = await serviceApplicationService.cancelApplication(applicationId, uid);
    autoOnlineEngine.evaluateProvider(uid, 'system', uid).catch(() => {});
    return res.json({ success: true, application: toApplicationDto(app) });
  } catch (error: any) {
    const status = error.statusCode ?? 500;
    return res.status(status).json({
      success: false,
      code: error.code ?? "INTERNAL_ERROR",
      message: error.message || "Failed to cancel application",
    });
  }
};

export const resubmitServiceApplication = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ success: false, message: "Unauthorized" });

    const { applicationId } = req.params as { applicationId: string };
    if (!applicationId) return res.status(400).json({ success: false, message: "applicationId is required" });

    const clientRequestId = typeof req.body?.clientRequestId === 'string' ? req.body.clientRequestId.trim() : '';
    const expectedVersion = Number(req.body?.expectedVersion);
    if (clientRequestId.length < 16 || clientRequestId.length > 128 || !Number.isInteger(expectedVersion)) {
      return res.status(400).json({ success: false, code: 'INVALID_RESUBMISSION', message: 'clientRequestId and expectedVersion are required' });
    }
    const app = await serviceApplicationService.resubmitApplication(applicationId, uid, { clientRequestId, expectedVersion });
    return res.json({ success: true, application: toApplicationDto(app) });
  } catch (error: any) {
    const status = error.statusCode ?? 500;
    return res.status(status).json({
      success: false,
      code: error.code ?? "INTERNAL_ERROR",
      message: error.message || "Failed to resubmit application",
    });
  }
};

export const pauseWorkerService = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ success: false, message: "Unauthorized" });

    const serviceId = Number(req.params.serviceId);
    if (!Number.isInteger(serviceId) || serviceId <= 0) {
      return res.status(400).json({ success: false, message: "serviceId must be a positive integer" });
    }
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() || undefined : undefined;

    const row = await technicianService.pauseService(uid, serviceId, reason);
    autoOnlineEngine.evaluateProvider(uid, 'system', uid).catch(() => {});
    return res.json({ success: true, service: { serviceId: Number(row.service_id), status: row.status, pauseReason: row.pause_reason ?? null } });
  } catch (error: any) {
    const status = error.statusCode ?? 500;
    return res.status(status).json({ success: false, code: error.code ?? "INTERNAL_ERROR", message: error.message || "Failed to pause service" });
  }
};

export const reactivateWorkerService = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ success: false, message: "Unauthorized" });

    const serviceId = Number(req.params.serviceId);
    if (!Number.isInteger(serviceId) || serviceId <= 0) {
      return res.status(400).json({ success: false, message: "serviceId must be a positive integer" });
    }

    const row = await technicianService.reactivateService(uid, serviceId);
    autoOnlineEngine.evaluateProvider(uid, 'system', uid).catch(() => {});
    return res.json({ success: true, service: { serviceId: Number(row.service_id), status: row.status, pauseReason: null } });
  } catch (error: any) {
    const status = error.statusCode ?? 500;
    return res.status(status).json({ success: false, code: error.code ?? "INTERNAL_ERROR", message: error.message || "Failed to reactivate service" });
  }
};

// ─── FCM Token ────────────────────────────────────────────────────────────────

/**
 * DELETE /api/provider/fcm-token — release this device on sign-out.
 *
 * Without this, signing out leaves the handset addressable as the provider who
 * just left. The next push carries their booking details to a phone they have
 * handed back, put down, or sold.
 *
 * Scoped to the caller AND to the token they present, so one device signing out
 * cannot silently unsubscribe the same provider's other devices.
 *
 * Idempotent: releasing a token that is already gone is a success, because a
 * sign-out must never be blocked by the state of a push registration.
 */
export const deleteProviderFcmToken = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });

    const { token } = req.body ?? {};
    await notificationService.releaseProviderDeviceToken(uid, token);
    return res.status(200).json({ status: "success", data: { released: true } });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: "Server error" });
  }
};

export const saveProviderFcmToken = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });
    const { token } = req.body;
    if (!token || typeof token !== 'string' || token.trim().length < 10) {
      return res.status(400).json({ status: "failed", message: "token is required" });
    }
    const saved = await notificationService.registerProviderDeviceToken(uid, token);
    if (!saved) return res.status(400).json({ status: "failed", message: "Invalid token" });
    return res.status(200).json({ status: "success", data: { saved: true } });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: "Server error" });
  }
};

// ─── Job cards — web portal (UID from Firebase token, not URL param) ──────────

// Shared formatter to avoid duplication between list and single-card endpoints
import { formatJobCard } from "./jobCardView";
import { validateDataUri, AllowedUploadMime } from "../helpers/fileSignature";
import { stripImageMetadata } from "../helpers/stripImageMetadata";
import * as evidenceService from "../services/bookingEvidenceService";
import { actionsForWorkerStatus } from "./bookingActions";

/**
 * GET /api/provider/bookings/:bookingId/timeline
 *
 * C18 §21. Provider-scoped by construction: the worker uid comes from the
 * token and is a bound parameter of the query, so there is no way to ask about
 * another provider's booking. An unrelated booking id returns 404 rather than
 * an empty timeline, so the endpoint cannot be used to probe which booking ids
 * exist (§46, ID enumeration).
 */
export const getBookingTimeline = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ success: false, message: "Unauthorized" });
    const bookingId = Number(req.params.bookingId);
    if (!bookingId || isNaN(bookingId)) {
      return res.status(400).json({ success: false, message: "Invalid bookingId" });
    }

    const schema = dbSchema || "";
    const result = await dbQuery.query(
      `SELECT b.created_at,
              b.status                AS booking_status,
              bw.status               AS worker_status,
              bw.assigned_at,
              bw.started_at,
              bw.completed_at,
              to_jsonb(bw) ->> 'accepted_at' AS accepted_at,
              to_jsonb(bw) ->> 'declined_at' AS declined_at,
              to_jsonb(bw) ->> 'en_route_at' AS en_route_at,
              to_jsonb(bw) ->> 'arrived_at'  AS arrived_at,
              -- C18-04. The reassignment gate: admin-side events cross only
              -- while the caller still holds the booking.
              (b.worker_uid = $2) AS is_current_assignee
         FROM ${schema}.bookings b
         JOIN ${schema}.booking_workers bw
           ON bw.booking_id = b.id
        WHERE b.id = $1 AND bw.worker_uid = $2
        ORDER BY bw.id DESC
        LIMIT 1`,
      [bookingId, uid]
    );

    if (!result.rowCount) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }

    const row = result.rows[0];

    // C18-04. Stored admin-side history — reschedules, cancellations, disputes.
    // Only the event type and timestamp are selected: `title`, `description`
    // and `metadata` are admin-authored and never cross (§21/§22).
    const stored = await dbQuery.query(
      `SELECT event_type, created_at
         FROM ${schema}.booking_timeline_events
        WHERE booking_id = $1
        ORDER BY created_at ASC`,
      [bookingId]
    ).catch(() => null);

    const events = mergeStoredEvents(
      buildBookingTimeline(row),
      stored?.rows ?? [],
      row.is_current_assignee === true
    );

    return res.json({
      status: "success",
      data: {
        bookingId,
        events,
        currentStep: currentTimelineStep(events),
      },
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

/**
 * GET /api/provider/bookings/:bookingId/dispute-status
 *
 * C18 §29 — the safe entry point and status summary only. Opening a dispute is
 * a later command; this tells the client whether to offer the entry at all.
 *
 * Reads `booking_escalations`, the table the admin portal already derives
 * `hasDispute` from, so admin and provider cannot disagree about whether a
 * booking is disputed.
 *
 * The escalation row is an ADMIN record: `reason` is free text an admin typed,
 * `assigned_team` is internal routing, `severity` is internal triage and
 * `actor_uid` names a person. None are selected here.
 */
export const getBookingDisputeStatus = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ success: false, message: "Unauthorized" });
    const bookingId = Number(req.params.bookingId);
    if (!bookingId || isNaN(bookingId)) {
      return res.status(400).json({ success: false, message: "Invalid bookingId" });
    }

    const schema = dbSchema || "";

    // Assignment check first: an unrelated booking must 404 rather than reveal
    // whether it exists or is disputed (§46, ID enumeration).
    const assignment = await dbQuery.query(
      `SELECT status FROM ${schema}.booking_workers
        WHERE booking_id = $1 AND worker_uid = $2
        ORDER BY id DESC LIMIT 1`,
      [bookingId, uid]
    );
    if (!assignment.rowCount) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }

    const esc = await dbQuery.query(
      `SELECT actor_uid, resolved_at, created_at
         FROM ${schema}.booking_escalations
        WHERE booking_id = $1
        ORDER BY id DESC LIMIT 1`,
      [bookingId]
    ).catch(() => null);

    return res.json({
      status: "success",
      data: {
        bookingId,
        ...buildDisputeSummary({
          workerStatus: assignment.rows[0]?.status,
          callerUid: uid,
          escalation: esc?.rows?.[0] ?? null,
        }),
      },
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

/**
 * GET  /api/provider/bookings/:bookingId/cancellation-eligibility
 * POST /api/provider/bookings/:bookingId/cancel
 *
 * C18 §26. Operator policy: 48 hours notice, RECORD ONLY (no penalty), auto
 * reassign, admin notified. Nothing here computes a consequence — §26 says
 * "Do not invent penalties", and none were specified.
 *
 * The window is evaluated against SERVER time, never a client timestamp.
 */
const loadCancellationContext = async (bookingId: number, uid: string) => {
  const schema = dbSchema || "";
  const res = await dbQuery.query(
    `SELECT bw.status AS worker_status, b.schedule
       FROM ${schema}.booking_workers bw
       JOIN ${schema}.bookings b ON b.id = bw.booking_id
      WHERE bw.booking_id = $1 AND bw.worker_uid = $2
      ORDER BY bw.id DESC LIMIT 1`,
    [bookingId, uid]
  );
  return res.rowCount ? res.rows[0] : null;
};

export const getCancellationEligibility = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ success: false, message: "Unauthorized" });
    const bookingId = Number(req.params.bookingId);
    if (!bookingId || isNaN(bookingId)) {
      return res.status(400).json({ success: false, message: "Invalid bookingId" });
    }

    const ctx = await loadCancellationContext(bookingId, uid);
    if (!ctx) return res.status(404).json({ success: false, message: "Booking not found" });

    return res.json({
      status: "success",
      data: {
        bookingId,
        ...evaluateCancellation({
          workerStatus: ctx.worker_status,
          schedule: ctx.schedule,
          now: new Date(),
        }),
      },
    });
  } catch {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

export const cancelAcceptedBooking = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ success: false, message: "Unauthorized" });
    const bookingId = Number(req.params.bookingId);
    if (!bookingId || isNaN(bookingId)) {
      return res.status(400).json({ success: false, message: "Invalid bookingId" });
    }
    const reasonCode = String(req.body?.reasonCode ?? "");
    const note = req.body?.note ? String(req.body.note).slice(0, 1000) : null;

    const ctx = await loadCancellationContext(bookingId, uid);
    if (!ctx) return res.status(404).json({ success: false, message: "Booking not found" });

    // Re-evaluated at mutation time (§1), not trusted from whatever the client
    // was shown when it rendered the button.
    const eligibility = evaluateCancellation({
      workerStatus: ctx.worker_status,
      schedule: ctx.schedule,
      now: new Date(),
      reasonCode,
    });

    if (!eligibility.canCancel) {
      return res.status(409).json({
        success: false,
        code: eligibility.blockCode,
        message: CANCELLATION_BLOCK_MESSAGES[eligibility.blockCode!] ?? "Cancellation is not available.",
        data: eligibility,
      });
    }

    const result = await technicianService.cancelAcceptedJob(bookingId, uid, reasonCode, note);
    return res.json({ success: true, message: "Booking cancelled", data: result });
  } catch (error: any) {
    return sendBookingResponseOutcome(res, error, "Booking cancelled");
  }
};

const CANCELLATION_BLOCK_MESSAGES: Record<string, string> = {
  INSIDE_NOTICE_WINDOW: `Cancellation closes ${CANCELLATION_NOTICE_HOURS} hours before the booking. Contact support if you cannot attend.`,
  NOT_CANCELLABLE_AT_THIS_STAGE: "This booking can no longer be cancelled from here.",
  SCHEDULE_UNKNOWN: "This booking has no confirmed schedule yet. Contact support.",
  INVALID_REASON: "Choose a reason for cancelling.",
};

/**
 * Job evidence (C19 §17–§19).
 *
 *   GET    /api/provider/bookings/:bookingId/evidence
 *   POST   /api/provider/bookings/:bookingId/evidence
 *   DELETE /api/provider/bookings/:bookingId/evidence/:evidenceId
 *
 * Every route resolves the provider from the token and proves the booking is
 * theirs before touching evidence, so a guessed booking id 404s rather than
 * revealing that it exists (§54, enumeration).
 */
const assertOwnBooking = async (bookingId: number, uid: string) => {
  const schema = dbSchema || "";
  const res = await dbQuery.query(
    `SELECT status FROM ${schema}.booking_workers
      WHERE booking_id = $1 AND worker_uid = $2
      ORDER BY id DESC LIMIT 1`,
    [bookingId, uid]
  );
  return res.rowCount ? String(res.rows[0].status ?? "") : null;
};

export const getBookingEvidence = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ success: false, message: "Unauthorized" });
    const bookingId = Number(req.params.bookingId);
    if (!bookingId || isNaN(bookingId)) {
      return res.status(400).json({ success: false, message: "Invalid bookingId" });
    }
    if (!(await assertOwnBooking(bookingId, uid))) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }

    const items = await evidenceService.listEvidence(bookingId, uid);
    const requirements = evidenceService.requirementsForBooking().map((r) => ({
      ...r,
      satisfied: evidenceService.isRequirementSatisfied(r, items),
      uploadedCount: evidenceService.countFor(r.code, items),
    }));

    return res.json({
      status: "success",
      data: {
        bookingId,
        requirements,
        items,
        // §34: completion readiness comes from the backend, not a local
        // checklist. Uploaded-but-rejected never counts as satisfied.
        blocking: {
          BEFORE_SERVICE: evidenceService.blockingRequirements("BEFORE_SERVICE", items),
          AFTER_SERVICE: evidenceService.blockingRequirements("AFTER_SERVICE", items),
        },
      },
    });
  } catch {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

export const uploadBookingEvidence = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ success: false, message: "Unauthorized" });
    const bookingId = Number(req.params.bookingId);
    if (!bookingId || isNaN(bookingId)) {
      return res.status(400).json({ success: false, message: "Invalid bookingId" });
    }
    const workerStatus = await assertOwnBooking(bookingId, uid);
    if (!workerStatus) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }
    // Evidence belongs to a visit in progress. A booking that is finished,
    // declined or cancelled must not accept new files.
    if (!["ACCEPTED", "EN_ROUTE", "ARRIVED", "IN_PROGRESS"].includes(workerStatus.toUpperCase())) {
      return res.status(409).json({
        success: false,
        code: "NOT_ACCEPTING_EVIDENCE",
        message: "This booking is not accepting evidence.",
      });
    }

    const { file, requirementCode } = req.body ?? {};
    const requirement = evidenceService.findRequirement(String(requirementCode ?? ""));
    if (!requirement) {
      return res.status(422).json({
        success: false,
        code: "UNKNOWN_REQUIREMENT",
        message: "Unknown evidence requirement.",
      });
    }

    const existing = await evidenceService.listEvidence(bookingId, uid);
    if (evidenceService.countFor(requirement.code, existing) >= requirement.maxCount) {
      return res.status(409).json({
        success: false,
        code: "TOO_MANY_FILES",
        message: `You can attach at most ${requirement.maxCount} for this requirement. Remove one first.`,
      });
    }

    // Content-based validation (LJ-08). The declared type must be allowed AND
    // match the actual bytes.
    const validation = validateDataUri(file, {
      allowed: requirement.acceptedMimeTypes as readonly AllowedUploadMime[],
      maxBytes: requirement.maxBytes,
    });
    if (!validation.ok) {
      return res.status(422).json({
        success: false,
        code: validation.code,
        message: validation.message,
      });
    }

    // §18. A photo taken at a customer address carries GPS in EXIF by default;
    // storing it would attach a precise home location to every file.
    const cleaned = stripImageMetadata(validation.buffer, validation.mime);
    const dataUri = `data:${validation.mime};base64,${cleaned.toString("base64")}`;

    const fileUrl = await uploadFileToStorage(
      `booking-evidence/${bookingId}`,
      `${uid}_${requirement.code}_${Date.now()}`,
      dataUri
    );

    const item = await evidenceService.attachEvidence({
      bookingId,
      workerUid: uid,
      requirement,
      fileUrl,
      mimeType: validation.mime,
      bytes: cleaned.length,
    });

    // §19: attached is not approved. The client must not read 201 as accepted.
    return res.status(201).json({
      status: "success",
      data: { ...item, approved: false },
    });
  } catch {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

export const deleteBookingEvidence = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ success: false, message: "Unauthorized" });
    const bookingId = Number(req.params.bookingId);
    const evidenceId = Number(req.params.evidenceId);
    if (!bookingId || isNaN(bookingId) || !evidenceId || isNaN(evidenceId)) {
      return res.status(400).json({ success: false, message: "Invalid id" });
    }
    if (!(await assertOwnBooking(bookingId, uid))) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }
    const removed = await evidenceService.removeEvidence(bookingId, uid, evidenceId);
    if (!removed) {
      return res.status(404).json({ success: false, message: "Evidence not found" });
    }
    return res.json({ status: "success", data: { evidenceId: String(evidenceId) } });
  } catch {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

export const getWorkerJobCards = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ success: false, message: "Unauthorized" });
    const jobs = await technicianService.getJobCardsByWorker(uid);
    return res.json(jobs.map(formatJobCard));
  } catch (error: any) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// ─── Single job card by bookingId (AR-P1-02) ─────────────────────────────────
// Avoids full-list client-side filter in the live-job screen.
export const getWorkerJobCard = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ success: false, message: "Unauthorized" });
    const bookingId = Number(req.params.bookingId);
    if (!bookingId || isNaN(bookingId)) {
      return res.status(400).json({ success: false, message: "Invalid bookingId" });
    }
    const job = await technicianService.getJobCardByWorker(uid, bookingId);
    if (!job) return res.status(404).json({ success: false, message: "Job not found" });
    return res.json(formatJobCard(job));
  } catch (error: any) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// ─── Booking lifecycle — web portal (UID from Firebase token; BOLA enforced in service via SQL WHERE) ──

/**
 * Turns an assignment-response failure into a result the provider can act on.
 *
 * C18 §12/§52. Acceptance and decline must be idempotent, so a repeat of the
 * caller's own response is a 200 success carrying `idempotent: true` — not an
 * error the UI has to apologise for. A genuine conflict is a 409 with a code
 * the client can branch on. Anything else stays a 500.
 *
 * `success` and `message` keep their existing shape and meaning, so no client
 * needs a change to keep working; the new fields are additive.
 */
function sendBookingResponseOutcome(res: Response, error: any, successMessage: string) {
  if (error instanceof BookingResponseConflict) {
    return res.status(error.httpStatus).json({
      success: error.isAlreadySatisfied,
      message: error.isAlreadySatisfied ? successMessage : error.providerMessage,
      idempotent: error.isAlreadySatisfied || undefined,
      conflict: {
        code: error.code,
        currentStatus: error.currentStatus,
        providerMessage: error.providerMessage,
      },
    });
  }
  return res.status(500).json({ success: false, message: "Server error" });
}

export const acceptBooking = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ success: false, message: "Unauthorized" });
    const bookingId = Number(req.params.bookingId);
    if (!Number.isSafeInteger(bookingId) || bookingId <= 0) {
      return res.status(400).json({ success: false, message: "bookingId must be a positive integer" });
    }
    const result = await technicianService.acceptJob(bookingId, uid);
    touchProviderActivity(uid).catch(() => {});
    return res.json({ success: true, message: "Job accepted", data: result });
  } catch (error: any) {
    return sendBookingResponseOutcome(res, error, "Job accepted");
  }
};

export const declineBooking = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ success: false, message: "Unauthorized" });
    const bookingId = Number(req.params.bookingId);
    if (!bookingId) return res.status(400).json({ success: false, message: "bookingId is required" });
    const result = await technicianService.declineJob(bookingId, uid);
    return res.json({
      success: true,
      message: result.reassignment?.assigned
        ? "Job declined — a new worker has been assigned"
        : "Job declined — no available worker found, booking returned to queue",
      data: result,
    });
  } catch (error: any) {
    return sendBookingResponseOutcome(res, error, "Job declined");
  }
};

/**
 * PUT /api/worker/bookings/:bookingId/en-route
 * PUT /api/worker/bookings/:bookingId/arrived
 *
 * The two arrival stages. Both are OPTIONAL — a provider who never taps either
 * can still start the job, and an older app build is unaffected.
 *
 * Provider comes from the token, never from the request, like every other route
 * in this family.
 */
const arrivalHandler = (
  advance: (bookingId: number, uid: string) => Promise<any>,
  successMessage: string
) => async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ success: false, message: "Unauthorized" });
    const bookingId = Number(req.params.bookingId);
    if (!bookingId) return res.status(400).json({ success: false, message: "bookingId is required" });

    const result = await advance(bookingId, uid);
    touchProviderActivity(uid).catch(() => {});

    // C19 §11/§12 (LJ-07). Servana verifies at START, not at arrival: there is
    // no ARRIVAL_VERIFICATION_REQUIRED state, and §3 forbids inventing one.
    //
    // What was missing is not a state but an ANSWER — after marking arrived the
    // provider had no way to learn that a customer code is still needed before
    // work can begin, short of trying and failing. Returning the new action set
    // makes the requirement explicit at the moment it becomes relevant:
    // START_JOB carries requiresCode, so the client can prompt for the code
    // instead of surfacing a refusal.
    //
    // Additive: `success`, `message` and `data` are unchanged.
    return res.json({
      success: true,
      message: successMessage,
      data: result,
      availableActions: actionsForWorkerStatus(result?.status),
    });
  } catch (error: any) {
    // The guard rejects an out-of-order call by matching no row, which is a
    // client-state problem rather than a server fault — 409, not 500, so the
    // client can refetch instead of retrying blindly.
    if (/cannot move to/i.test(error?.message || "")) {
      return res.status(409).json({
        success: false,
        code: "INVALID_TRANSITION",
        message: error.message,
      });
    }
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

export const markBookingEnRoute = arrivalHandler(
  technicianService.markEnRoute,
  "Marked on the way"
);

export const markBookingArrived = arrivalHandler(
  technicianService.markArrived,
  "Marked arrived"
);

export const startBooking = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ success: false, message: "Unauthorized" });
    const bookingId = Number(req.params.bookingId);
    if (!bookingId) return res.status(400).json({ success: false, message: "bookingId is required" });
    // Body first, query as a fallback — same reasoning as confirmOtp.
    //
    // The worker code is the short secret the CUSTOMER holds and reads out to
    // the technician to prove the right person is at the right job. It
    // authorises the job to start, so it is a credential, and a query string is
    // written to the nginx access log on every request. Every job start was
    // depositing one into a plaintext log that is rotated, backed up and
    // readable by anyone with host access.
    //
    // The route is PUT, so the body was always available and simply unused.
    // Reading both keeps the shipped ServanaWorker builds working while they
    // move the value into the body.
    const workerCode = (req.body?.workerCode ?? req.query.workerCode) as
      | string
      | undefined;
    const result = await technicianService.startJob(bookingId, uid, workerCode);
    return res.json({ success: true, message: "Job started", data: result });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

export const completeBooking = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ success: false, message: "Unauthorized" });
    const bookingId = Number(req.params.bookingId);
    if (!bookingId) return res.status(400).json({ success: false, message: "bookingId is required" });
    const result = await technicianService.completeJob(bookingId, uid);
    touchProviderActivity(uid).catch(() => {});
    return res.json({ success: true, message: "Job completed successfully", data: result });
  } catch (error: any) {
    if (error instanceof technicianService.UnpaidCashBookingError) {
      return res.status(409).json({
        success: false,
        code: error.code,
        message: error.message,
      });
    }
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// ─── Location update (auth-scoped; uid from Firebase token, not request body) ─
// Web-portal equivalent of the unauthenticated POST /workers/location mobile route.
// Mobile route remains unchanged — this additive endpoint enforces token-based identity.
export const updateWorkerLocation = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ success: false, message: "Unauthorized" });
    const { latitude, longitude, isOnline } = req.body;
    if (latitude === undefined || longitude === undefined) {
      return res.status(400).json({ success: false, message: "latitude and longitude are required" });
    }
    if (isOnline === undefined) {
      return res.status(400).json({ success: false, message: "isOnline is required" });
    }
    const worker = await technicianService.getWorkerByUid(uid);
    if (!worker) return res.status(404).json({ success: false, message: "Worker not found" });
    await technicianService.upsertWorkerLocation({ uid, latitude: Number(latitude), longitude: Number(longitude), is_online: Boolean(isOnline) });
    return res.json({ success: true, message: "Worker location updated successfully" });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// ─── Worker services (auth-scoped; BOLA enforced; uid from Firebase token) ────
// Web-portal equivalents of the unauthenticated /workers/:uid/services mobile routes.
export const getWorkerServices = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ success: false, message: "Unauthorized" });
    const services = await technicianService.getServicesByEmployee(uid);
    return res.json({ success: true, services });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

export const removeWorkerService = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ success: false, message: "Unauthorized" });
    const serviceId = Number(req.params.serviceId);
    if (!serviceId) return res.status(400).json({ success: false, message: "serviceId is required" });
    const result = await technicianService.removeServiceFromEmployee(uid, serviceId);
    autoOnlineEngine.evaluateProvider(uid, 'system', null).catch(() => {});
    return res.json({ success: true, removed: result });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// ─── Authenticated booking detail — LEAK-BE-P0-01 web-portal equivalent ────────
// Web portal uses Firebase JWT; uid from token enforces BOLA ownership.
// Mobile uses GET /bookings/:id (no auth) — that route is a protected contract, left unchanged.
export const getProviderBookingDetail = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });
    const bookingId = Number(req.params.id);
    if (!bookingId || isNaN(bookingId)) {
      return res.status(400).json({ status: "failed", message: "Invalid booking ID" });
    }
    const result = await dbQuery.query(
      `SELECT b.id, b.user_id, b.user_address_id, b.service_option_id,
              b.schedule, b.payment_method, b.status,
              b.quoted_price, b.final_price, b.pricing_breakdown,
              b.worker_uid, b.service_address, b.created_at,
              p.status AS payment_status, p.method AS payment_method_used,
              COALESCE(ua.address_one, b.service_address->>'addressLine') AS address,
              COALESCE(ua.post_town, b.service_address->>'city') AS post_town,
              ua.country, ua.zip_code,
              bw.status AS worker_status,
              bw.assigned_at, bw.started_at, bw.completed_at
       FROM ${dbSchema}.bookings b
       LEFT JOIN ${dbSchema}.payments p ON p.booking_id = b.id
         AND p.additional_request_id IS NULL
       LEFT JOIN ${dbSchema}.user_address ua ON ua.address_id = b.user_address_id
       JOIN ${dbSchema}.booking_workers bw ON bw.booking_id = b.id
         AND bw.worker_uid = $2
         AND bw.status IN ('ASSIGNED','ACCEPTED','EN_ROUTE','ARRIVED','IN_PROGRESS','COMPLETED')
       WHERE b.id = $1`,
      [bookingId, uid]
    );
    if (!result.rows.length) {
      return res.status(404).json({ status: "failed", message: "Booking not found" });
    }
    const addons = await dbQuery.query(
      `SELECT ba.id, ba.addon_option_id, ba.qty, ba.unit_price, so.level_3 AS addon_name
       FROM ${dbSchema}.booking_addons ba
       JOIN ${dbSchema}.service_options so ON so.id = ba.addon_option_id
       WHERE ba.booking_id = $1 ORDER BY ba.id ASC`,
      [bookingId]
    );
    const row = result.rows[0];
    const workerStatus = String(row.worker_status ?? "").toUpperCase();

    // Same staged disclosure as `jobCardView.formatJobCard`, for the same
    // reason (Command 17 §11): before a provider accepts, they need enough to
    // decide — service, schedule, AREA — and not the customer's street address.
    // This route was spreading the raw row, so an ASSIGNED provider who had not
    // accepted anything could read `address`, the whole `service_address` JSON
    // and the zip code by calling it directly. Hiding a screen is not
    // authorization (§12), and this route has no UI at all.
    //
    // Keys are emptied, never removed, so no consumer's shape changes.
    const operational = ["ACCEPTED", "EN_ROUTE", "ARRIVED", "IN_PROGRESS", "COMPLETED"].includes(workerStatus);

    const serviceAddress = row.service_address && typeof row.service_address === "object"
      ? { ...row.service_address }
      : row.service_address;
    if (!operational && serviceAddress && typeof serviceAddress === "object") {
      // The JSON blob carries the street under its own key, so emptying the
      // flattened `address` column alone would have leaked it right back.
      delete (serviceAddress as Record<string, unknown>).addressLine;
      delete (serviceAddress as Record<string, unknown>).addressTwo;
    }

    return res.status(200).json({
      success: true,
      data: {
        ...row,
        address: operational ? row.address : null,
        zip_code: operational ? row.zip_code : null,
        service_address: serviceAddress,
        // post_town (the area) stays at every status — it is what a travel
        // decision needs and matches the job-card contract.
        //
        // Additive: the three job-list endpoints emit `clientPaymentStatus`
        // lower-cased, and Provider Web's `mapClientPaymentStatus` is
        // case-sensitive. This route emitted only raw UPPERCASE
        // `payment_status`, which that mapper renders as "unknown". Raw key
        // kept for compatibility.
        clientPaymentStatus: row.payment_status ? String(row.payment_status).toLowerCase() : "pending",
        addons: addons.rows,
      },
    });
  } catch {
    // §21 — no driver text, no constraint names. Both Flutter apps render this
    // field straight to the user.
    return res.status(500).json({ status: "failed", message: "Failed to fetch booking" });
  }
};

// ─── Authenticated booking tracking — LEAK-BE-P0-05 web-portal equivalent ───────
// Web portal uses Firebase JWT; uid from token enforces BOLA ownership.
// Mobile uses GET /bookings/:id/tracking (no auth) — that route is a protected contract, left unchanged.
export const getProviderBookingTracking = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });
    const bookingId = Number(req.params.id);
    if (!bookingId || isNaN(bookingId)) {
      return res.status(400).json({ status: "failed", message: "Invalid booking ID" });
    }
    const ownerCheck = await dbQuery.query(
      `SELECT booking_id FROM ${dbSchema}.booking_workers
       WHERE booking_id = $1 AND worker_uid = $2
         AND status IN ('ASSIGNED','ACCEPTED','EN_ROUTE','ARRIVED','IN_PROGRESS','COMPLETED')`,
      [bookingId, uid]
    );
    if (!ownerCheck.rowCount) {
      return res.status(404).json({ status: "failed", message: "Booking not found" });
    }
    const tracking = await dbQuery.query(
      `SELECT status, note, created_at
       FROM ${dbSchema}.booking_tracking
       WHERE booking_id = $1
       ORDER BY created_at ASC`,
      [bookingId]
    );
    return res.status(200).json({ success: true, data: tracking.rows });
  } catch {
    // §21 — see getProviderBookingDetail.
    return res.status(500).json({ status: "failed", message: "Failed to fetch tracking" });
  }
};

// ─── Additional requests for authenticated worker — ST-P1-01 ──────────────────
// Returns all additional work requests across all bookings assigned to this provider.
// Shape matches BackendAdditionalWork so adaptAdditionalWorkList() works client-side.
export const getAdditionalRequests = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });
    const result = await dbQuery.query(
      `SELECT bar.id, bar.booking_id, bar.status,
              bar.total_amount AS amount,
              CASE WHEN bar.status IN (
                'WAITING_FOR_PAYMENT','WAITING_WORKER_APPROVAL','ACCEPTED',
                'IN_PROGRESS','PROCEEDING','COMPLETED'
              ) THEN bar.total_amount ELSE NULL END AS approved_amount,
              bar.created_at, bar.updated_at, bar.decided_at
       FROM ${dbSchema}.booking_additional_requests bar
       WHERE EXISTS (
         SELECT 1 FROM ${dbSchema}.booking_workers bw
         WHERE bw.booking_id = bar.booking_id AND bw.worker_uid = $1
           AND bw.status IN ('ASSIGNED','ACCEPTED','IN_PROGRESS','COMPLETED')
       )
       ORDER BY bar.created_at DESC
       LIMIT 50`,
      [uid]
    );
    // Additive: the split rate travels with the data instead of each client
    // restating it. Provider Web held its own `PROVIDER_SHARE_PERCENT = 0.80`
    // here, a second hardcode of a number only the backend actually decides —
    // and the earnings endpoints already send it.
    const data = result.rows.map((r: any) => ({
      ...r,
      providerSharePercent: PROVIDER_SHARE_PERCENT,
    }));
    return res.status(200).json({ success: true, data });
  } catch {
    // §21 — no driver text; both Flutter apps render this straight to the user.
    return res.status(500).json({ status: "failed", message: "Failed to fetch additional requests" });
  }
};
