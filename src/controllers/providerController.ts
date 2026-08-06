import { Request, Response } from "express";
import { db } from "../config";
import { providerShareOf, PROVIDER_SHARE_RATE, PROVIDER_SHARE_PERCENT } from '../services/revenueSplit';
import dbQuery from "../db/dbQuery";
import * as technicianService from "../services/technicianService";
import * as userService from "../services/user.service";
import mongoDb from "../db/mongodbQuery";
import { uploadFileToStorage } from "../helpers/firebaseStorageUploader";
import * as notificationService from "../services/notification.service";
import { getProviderAggregate } from "../services/customerReviewService";
import { BookingResponseConflict } from "../services/bookingResponseConflict";
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

const dbSchema = db.schema;

// ── Availability bridge: Provider Web ↔ canonical engine shapes ───────────────

const DAY_TO_DOW: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const DOW_TO_DAY: Record<number, string> = { 0: 'sun', 1: 'mon', 2: 'tue', 3: 'wed', 4: 'thu', 5: 'fri', 6: 'sat' };
const WEB_ALL_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const ENGINE_DOW_LABELS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function bridgeToEngineSlots(schedule: any[]): availEngine.WeeklyScheduleSlot[] {
  const slots: availEngine.WeeklyScheduleSlot[] = [];
  for (const day of schedule) {
    const dow = DAY_TO_DOW[day.day] ?? -1;
    if (dow === -1) continue;
    const dayLabel = ENGINE_DOW_LABELS[dow] ?? '';
    if (!day.enabled || !Array.isArray(day.slots) || day.slots.length === 0) {
      // Represent disabled day as an unavailable placeholder so the day is tracked
      slots.push({ dayOfWeek: dow as 0|1|2|3|4|5|6, dayLabel, startTime: '09:00', endTime: '17:00', isAvailable: false, maxJobs: null });
    } else {
      for (const s of day.slots) {
        if (s.startTime && s.endTime) {
          slots.push({ dayOfWeek: dow as 0|1|2|3|4|5|6, dayLabel, startTime: s.startTime, endTime: s.endTime, isAvailable: true, maxJobs: null });
        }
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
      allDay:    true,
      startTime: null,
      endTime:   null,
      reason:    t.reason ?? 'other',
      note:      null,
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

const toJobDto = (r: any) => ({
  id: String(r.id),
  bookingId: String(r.id),
  bookingCode: bookingCode(r.id),
  serviceName: r.service_name || "",
  categoryName: r.category_name || "",
  customerDisplayName: `${r.customer_first || ""} ${(r.customer_last || "").charAt(0)}.`.trim(),
  customerInitials: `${(r.customer_first || " ").charAt(0)}${(r.customer_last || " ").charAt(0)}`.toUpperCase(),
  addressLine: r.address_one || "",
  city: r.post_town || "",
  scheduledAt: r.schedule,
  status: (r.status || "").toLowerCase(),
  clientPaymentStatus: r.payment_status ? r.payment_status.toLowerCase() : "pending",
  paymentMethod: (r.payment_method || "cash").toLowerCase(),
  bookingAmount: Number(r.final_price || 0),
  currency: "PHP",
  hasUnreadChat: false,
  hasAdditionalWork: false,
});

const JOB_SELECT = (statusFilter: string) => `
  SELECT b.id, b.status, b.schedule, b.final_price, b.payment_method,
         COALESCE(ua.address_one, b.service_address->>'addressLine') AS address_one,
         COALESCE(ua.post_town,   b.service_address->>'city')        AS post_town,
         s.level_1 AS category_name, s.level_2 AS service_name,
         u.first_name AS customer_first, u.last_name AS customer_last,
         p.status AS payment_status
  FROM {SCHEMA}.bookings b
  LEFT JOIN {SCHEMA}.user_address ua ON ua.address_id = b.user_address_id
  LEFT JOIN {SCHEMA}.service_options so ON so.id = b.service_option_id
  LEFT JOIN {SCHEMA}.services s ON s.id = so.service_id
  LEFT JOIN {SCHEMA}.user_credentials u ON u.uid = b.user_id
  LEFT JOIN {SCHEMA}.payments p ON p.booking_id = b.id
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
      dbQuery.query(jobSql("b.status IN ('WORKER_ASSIGNED', 'CONFIRMED')", 10), [uid]),
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

const normalizePayoutStatus = (raw: string | null | undefined): string => {
  if (!raw) return "pending";
  const s = raw.toLowerCase();
  if (s === "released") return "disbursed";
  if (s === "failed")   return "failed_or_on_hold";
  return s;
};

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
              bw.completed_at
       FROM ${dbSchema}.bookings b
       LEFT JOIN ${dbSchema}.service_options so ON so.id = b.service_option_id
       LEFT JOIN ${dbSchema}.payments p ON p.booking_id = b.id
       LEFT JOIN ${dbSchema}.disbursements d ON d.booking_id = b.id AND d.worker_uid = $1
       LEFT JOIN ${dbSchema}.booking_workers bw
              ON bw.booking_id = b.id AND bw.worker_uid = $1
       WHERE b.worker_uid = $1 AND b.status = 'COMPLETED'
       ${dateFilter}
       ORDER BY b.schedule DESC`,
      params
    );

    const data = result.rows.map((r: any) => {
      const gross = Number(r.final_price || 0);
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
        disbursedAt: r.released_at || null,
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
              bw.completed_at
       FROM ${dbSchema}.bookings b
       LEFT JOIN ${dbSchema}.service_options so ON so.id = b.service_option_id
       LEFT JOIN ${dbSchema}.payments        p  ON p.booking_id = b.id
       LEFT JOIN ${dbSchema}.disbursements   d  ON d.booking_id = b.id AND d.worker_uid = $1
       LEFT JOIN ${dbSchema}.booking_workers bw ON bw.booking_id = b.id AND bw.worker_uid = $1
       WHERE b.id = $2 AND b.worker_uid = $1`,
      [uid, id]
    );
    if (!result.rowCount) {
      return res.status(404).json({ status: "failed", message: "Earning not found" });
    }
    const r = result.rows[0];
    const gross = Number(r.final_price || 0);
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
      disbursedAt:         r.released_at || null,
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

    const result = await dbQuery.query(
      `SELECT
         COUNT(*) AS total_jobs,
         COALESCE(SUM(b.final_price), 0) AS total_gross,
         COALESCE(SUM(CASE WHEN d.status = 'RELEASED' THEN d.worker_share ELSE 0 END), 0) AS total_paid,
         COALESCE(SUM(CASE WHEN d.status IN ('PENDING','FAILED') OR d.id IS NULL
                           THEN b.final_price * ${PROVIDER_SHARE_RATE} ELSE 0 END), 0) AS total_pending
       FROM ${dbSchema}.bookings b
       LEFT JOIN ${dbSchema}.disbursements d ON d.booking_id = b.id AND d.worker_uid = $1
       WHERE b.worker_uid = $1 AND b.status = 'COMPLETED'
       ${dateFilter}`,
      params
    );

    const s = result.rows[0] || {};
    const totalPaid    = Math.round(Number(s.total_paid    ?? 0) * 100) / 100;
    const totalPending = Math.round(Number(s.total_pending ?? 0) * 100) / 100;

    return res.status(200).json({
      status: "success",
      data: {
        totalEarned:  providerShareOf(Number(s.total_gross ?? 0)),
        totalPaid,
        totalPending,
        totalRefunded: 0,
        periodLabel: startDate ? "Custom range" : "All time",
        currency: "PHP",
        jobsCount: Number(s.total_jobs ?? 0),
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
              so.level_2 AS service_name
       FROM ${dbSchema}.bookings b
       LEFT JOIN ${dbSchema}.service_options so ON so.id = b.service_option_id
       WHERE b.worker_uid = $1 AND b.status = 'COMPLETED'
       ORDER BY b.schedule DESC
       LIMIT 50`,
      [uid]
    );

    const data = result.rows.map((r: any) => {
      const gross = Number(r.final_price || 0);
      const code = bookingCode(r.id);
      return {
        id: `led-${r.id}`,
        type: "booking_earning",
        direction: "credit",
        status: "settled",
        amountMinor: Math.round(providerShareOf(gross) * 100),
        currency: "PHP",
        description: `${r.service_name || "Service"} · ${code}`,
        bookingId: String(r.id),
        bookingCode: code,
        additionalWorkRequestId: null,
        payoutId: null,
        reference: code,
        occurredAt: r.schedule,
        availableAt: null,
        settledAt: r.schedule,
      };
    });

    return res.status(200).json({ status: "success", data });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: "Server error" });
  }
};

const _mapPayoutStatus = (raw: string): string => {
  const s = (raw || "").toUpperCase();
  if (s === "RELEASED")   return "paid";
  if (s === "FAILED")     return "failed";
  if (s === "PROCESSING") return "pending";
  return "pending";
};

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
      payoutMethodSummary: null,
      initiatedAt:       r.created_at    ? new Date(r.created_at).toISOString()    : null,
      expectedArrivalAt: r.release_after ? new Date(r.release_after).toISOString() : null,
      completedAt:       r.released_at   ? new Date(r.released_at).toISOString()   : null,
      failedAt:          null,
      failureMessage:    null,
      transactionCount:  1,
      reference:         r.paymongo_payout_id ?? null,
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
      data: { schedule, timezone: profile.timezone, updatedAt: profile.updatedAt },
    });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: "Server error" });
  }
};

export const saveWorkerAvailability = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });
    const { schedule, timezone } = req.body;
    if (!Array.isArray(schedule)) {
      return res.status(400).json({ status: "failed", message: "schedule must be an array" });
    }
    const engineSlots = bridgeToEngineSlots(schedule);
    const result = await availEngine.saveWeeklySchedule(uid, engineSlots, timezone ?? "Asia/Manila", uid);
    return res.status(200).json({ status: "success", data: { success: true, updatedAt: result.updatedAt } });
  } catch (error: any) {
    const code = error?.statusCode ?? 500;
    return res.status(code).json({ status: "failed", message: "Server error" });
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
    const record = await availEngine.createTimeOff(uid, { startDate, endDate, reason }, uid);
    const dto = {
      id:        String(record.id),
      startDate: record.startDate,
      endDate:   record.endDate,
      allDay:    allDay ?? true,
      startTime: startTime ?? null,
      endTime:   endTime ?? null,
      reason:    record.reason ?? reason,
      note:      note ?? null,
      createdAt: record.createdAt,
    };
    return res.status(201).json({ status: "success", data: dto });
  } catch (error: any) {
    const code = error?.statusCode ?? 500;
    return res.status(code).json({ status: "failed", message: "Server error" });
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
    return res.status(code).json({ status: "failed", message: "Server error" });
  }
};

// ─── Requirements (Firebase Storage, scoped to authenticated worker) ──────────

const ALLOWED_REQUIREMENT_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

export const uploadWorkerRequirement = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });
    const { file, name, requirementType } = req.body;
    if (!file || !name) {
      return res.status(400).json({ status: "failed", message: "file (data URI) and name are required" });
    }
    if (!file.startsWith("data:")) {
      return res.status(422).json({ status: "failed", message: "file must be a data URI" });
    }
    const mimeType = file.slice(file.indexOf(":") + 1, file.indexOf(";"));
    if (!ALLOWED_REQUIREMENT_MIMES.includes(mimeType)) {
      return res.status(422).json({ status: "failed", message: "File type not allowed. Use JPG, PNG, WebP, or PDF." });
    }
    const sanitizedName = String(name).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
    const sanitizedType = requirementType ? String(requirementType).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 50) : undefined;
    const fileUrl = await uploadFileToStorage("provider-requirements", `${uid}_${Date.now()}`, file);
    const inserted = await technicianService.addWorkerRequirements(uid, [{ fileUrl, fileName: sanitizedName, requirementType: sanitizedType }]);
    const row = inserted[0];
    autoOnlineEngine.evaluateProvider(uid, 'system', uid).catch(() => {});
    return res.status(201).json({
      status: "success",
      data: {
        requirementId: String(row.id),
        status: "pending_review",
        uploadedAt: row.uploadedAt,
        requirementType: sanitizedType ?? null,
      },
    });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: "Server error" });
  }
};

export const getWorkerRequirementsOwn = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });
    const requirements = await technicianService.getWorkerRequirements(uid);
    return res.status(200).json({ status: "success", data: requirements });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: "Server error" });
  }
};

export const deleteWorkerRequirementOwn = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ status: "failed", message: "Invalid id" });
    await technicianService.deleteWorkerRequirement(uid, id);
    autoOnlineEngine.evaluateProvider(uid, 'system', uid).catch(() => {});
    return res.status(200).json({ status: "success", data: { success: true } });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: "Server error" });
  }
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
       JOIN ${dbSchema}.bookings b ON b.id = bar.booking_id
       WHERE bar.id = $1 AND b.worker_uid = $2`,
      [id, uid]
    );
    if (!ownership.rowCount) {
      return res.status(404).json({ status: "failed", message: "Request not found or not assigned to you" });
    }
    if (ownership.rows[0].status !== "WAITING_WORKER_APPROVAL") {
      return res.status(409).json({ status: "failed", message: "Request is no longer awaiting your decision" });
    }

    const { additionalService } = await import("../services/additional.service");
    await additionalService.workerDecision(id, decision as "ACCEPT" | "REJECT");

    return res.status(200).json({ status: "success", data: { success: true, decision } });
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
         AND bar.status = 'WAITING_WORKER_APPROVAL'
         AND bar.booking_id IN (
           SELECT id FROM ${dbSchema}.bookings WHERE worker_uid = $2
         )
       RETURNING bar.id, bar.status, bar.decided_at`,
      [id, uid]
    );

    if (!result.rowCount) {
      return res.status(404).json({ status: "failed", message: "Request not found, already decided, or not assigned to you" });
    }
    return res.status(200).json({ status: "success", data: { success: true, status: result.rows[0].status } });
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
       JOIN ${dbSchema}.bookings b ON b.id = bar.booking_id
       WHERE bar.id = $1 AND b.worker_uid = $2`,
      [id, uid]
    );
    if (!ownership.rowCount) {
      return res.status(404).json({ status: "failed", message: "Request not found or not assigned to you" });
    }
    if (ownership.rows[0].status !== "ACCEPTED") {
      return res.status(409).json({ status: "failed", message: "Request must be in ACCEPTED state before confirming proceed" });
    }

    // Mark as proceeding — worker has acknowledged and will perform the additional work
    const result = await dbQuery.query(
      `UPDATE ${dbSchema}.booking_additional_requests
       SET status = 'PROCEEDING'
       WHERE id = $1
       RETURNING id, status`,
      [id]
    );

    return res.status(200).json({ status: "success", data: { success: true, status: result.rows[0].status } });
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
    if (!key) return res.status(400).json({ status: "failed", message: "key is required" });
    const uid: string = (req as any).user?.uid;
    await notificationService.markNotificationReadByKey(uid, key as string);
    return res.status(200).json({ status: "success", data: { success: true } });
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
    if (!key) return res.status(400).json({ status: "failed", message: "key is required" });
    const uid: string = (req as any).user?.uid;
    await notificationService.deleteNotificationByKey(uid, key as string);
    return res.status(200).json({ status: "success", data: { success: true } });
  } catch (e: any) {
    return res.status(500).json({ status: "failed", message: e.message });
  }
};

export const dismissAlert = async (req: Request, res: Response) => {
  try {
    const { key } = req.params;
    if (!key) return res.status(400).json({ status: "failed", message: "key is required" });
    const uid: string = (req as any).user?.uid;
    await notificationService.deleteAlertByKey(uid, key as string);
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
    if (!String(file).startsWith("data:")) {
      return res.status(422).json({ status: "failed", message: "file must be a data URI" });
    }
    const mimeType = String(file).slice(file.indexOf(":") + 1, file.indexOf(";"));
    if (!ALLOWED_PHOTO_MIMES.includes(mimeType)) {
      return res.status(422).json({ status: "failed", message: "File type not allowed. Use JPG, PNG, or WebP." });
    }
    await ensureProfileTable();
    const safeUrl = await uploadFileToStorage("provider-profile-photos", `${uid}_photo`, file);
    const uploadedAt = new Date().toISOString();
    await dbQuery.query(
      `INSERT INTO ${dbSchema}.user_profile (uid, photo_url, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (uid) DO UPDATE SET photo_url = EXCLUDED.photo_url, updated_at = NOW()`,
      [uid, safeUrl]
    );
    return res.status(200).json({ status: "success", data: { safeUrl, uploadedAt } });
  } catch (error: any) {
    console.error("[uploadWorkerProfilePhoto] 500:", error?.message ?? error);
    return res.status(500).json({ status: "failed", message: "Server error" });
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
  status: app.status,
  submittedAt: app.submitted_at,
  updatedAt: app.updated_at,
  cancelledAt: app.cancelled_at ?? null,
  approvedAt: app.approved_at ?? null,
  reviewReason: app.review_reason ?? null,
  version: Number(app.version),
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

    const app = await serviceApplicationService.submitApplication(uid, serviceId);
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

    const app = await serviceApplicationService.resubmitApplication(applicationId, uid);
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
    if (token && typeof token === "string" && token.trim().length >= 10) {
      await dbQuery.query(
        `UPDATE ${dbSchema}.user_credentials
         SET fcm_token = NULL
         WHERE uid = $1 AND fcm_token = $2`,
        [uid, token.trim()]
      );
    } else {
      // No token supplied — the client lost it, or never had one. Release
      // whatever this provider currently holds rather than refusing: a
      // sign-out that leaves a live registration behind is the worse outcome.
      await dbQuery.query(
        `UPDATE ${dbSchema}.user_credentials SET fcm_token = NULL WHERE uid = $1`,
        [uid]
      );
    }
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
    const value = token.trim();

    // A push token identifies a DEVICE, not a person, and providers share
    // devices. Binding it to the caller without releasing it from whoever held
    // it before leaves the previous provider still addressable at a handset
    // someone else is now carrying — so a booking notification meant for A
    // arrives on the phone B is holding, with A's customer's name in it.
    //
    // One token, one owner. Released first, in the same statement chain, so
    // there is no window where two rows claim the same device.
    await dbQuery.query(
      `UPDATE ${dbSchema}.user_credentials
       SET fcm_token = NULL
       WHERE fcm_token = $1 AND uid <> $2`,
      [value, uid]
    );

    await dbQuery.query(
      `UPDATE ${dbSchema}.user_credentials SET fcm_token = $1 WHERE uid = $2`,
      [value, uid]
    );
    return res.status(200).json({ status: "success", data: { saved: true } });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: "Server error" });
  }
};

// ─── Job cards — web portal (UID from Firebase token, not URL param) ──────────

// Shared formatter to avoid duplication between list and single-card endpoints
import { formatJobCard } from "./jobCardView";

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
    const jobs = await technicianService.getJobCardsByWorker(uid);
    const job = jobs.find((j: any) => j.booking_id === bookingId);
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
    if (!bookingId) return res.status(400).json({ success: false, message: "bookingId is required" });
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
    return res.json({ success: true, message: successMessage, data: result });
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
      `SELECT b.*, p.status AS payment_status, p.method AS payment_method_used,
              p.reference_no, p.proof_url,
              COALESCE(ua.address_one, b.service_address->>'addressLine') AS address,
              COALESCE(ua.post_town, b.service_address->>'city') AS post_town,
              ua.country, ua.zip_code,
              bw.status AS worker_status,
              bw.assigned_at, bw.started_at, bw.completed_at
       FROM ${dbSchema}.bookings b
       LEFT JOIN ${dbSchema}.payments p ON p.booking_id = b.id
       LEFT JOIN ${dbSchema}.user_address ua ON ua.address_id = b.user_address_id
       LEFT JOIN ${dbSchema}.booking_workers bw ON bw.booking_id = b.id
         AND bw.status IN ('ASSIGNED','ACCEPTED','IN_PROGRESS','COMPLETED','CANCELED','CANCELLED','DECLINED')
       WHERE b.id = $1 AND b.worker_uid = $2`,
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
    return res.status(200).json({ success: true, data: { ...result.rows[0], addons: addons.rows } });
  } catch (err: any) {
    return res.status(500).json({ status: "failed", message: err?.message || "Failed to fetch booking" });
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
      `SELECT id FROM ${dbSchema}.bookings WHERE id = $1 AND worker_uid = $2`,
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
  } catch (err: any) {
    return res.status(500).json({ status: "failed", message: err?.message || "Failed to fetch tracking" });
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
              bar.created_at, bar.updated_at, bar.decided_at
       FROM ${dbSchema}.booking_additional_requests bar
       JOIN ${dbSchema}.bookings b ON b.id = bar.booking_id
       WHERE b.worker_uid = $1
       ORDER BY bar.created_at DESC
       LIMIT 50`,
      [uid]
    );
    return res.status(200).json({ success: true, data: result.rows });
  } catch (err: any) {
    return res.status(500).json({ status: "failed", message: err?.message || "Failed to fetch additional requests" });
  }
};
