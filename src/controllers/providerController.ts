import { Request, Response } from "express";
import { db } from "../config";
import dbQuery from "../db/dbQuery";
import * as technicianService from "../services/technicianService";
import * as userService from "../services/user.service";
import mongoDb from "../db/mongodbQuery";
import { uploadFileToStorage } from "../helpers/firebaseStorageUploader";
import * as notificationService from "../services/notification.service";
import { updateFirebasePassword, revokeTokenInFirebase, getFirebaseUserByUid } from "../services/firebaseFunctions.service";
import * as serviceApplicationService from "../services/serviceApplicationService";
import * as onboardingService from "../services/providerOnboardingService";

const dbSchema = db.schema;

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
    return res.status(500).json({ status: "failed", message: error?.message || "Server error" });
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
    return res.status(500).json({ status: "failed", message: error?.message || "Server error" });
  }
};

export const goOnline = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    const { latitude = 0, longitude = 0 } = req.body;
    const now = new Date();

    const collection = (await mongoDb).collection("worker_locations");
    const existing = await collection.findOne({ uid }, { projection: { loc: 1 } });

    await collection.updateOne(
      { uid },
      {
        $set: {
          uid,
          is_online: true,
          loc: existing?.loc ?? { type: "Point", coordinates: [longitude, latitude] },
          updatedAt: now,
        },
      },
      { upsert: true }
    );

    return res.status(200).json({ status: "success", data: toOnlineStatusDto(true, now) });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: error?.message || "Server error" });
  }
};

export const goOffline = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    const now = new Date();

    const collection = (await mongoDb).collection("worker_locations");
    await collection.updateOne(
      { uid },
      { $set: { is_online: false, updatedAt: now } },
      { upsert: true }
    );

    return res.status(200).json({ status: "success", data: toOnlineStatusDto(false, now) });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: error?.message || "Server error" });
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
         ua.address_one, ua.post_town,
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

    const [activeJobRes, upcomingRes, todayStatsRes, locationDoc] = await Promise.all([
      dbQuery.query(jobSql("b.status = 'IN_PROGRESS'", 1), [uid]),
      dbQuery.query(jobSql("b.status IN ('WORKER_ASSIGNED', 'CONFIRMED')", 10), [uid]),
      dbQuery.query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'COMPLETED' AND schedule >= $2 AND schedule <= $3) AS completed_today,
           COALESCE(SUM(final_price) FILTER (WHERE status = 'COMPLETED' AND schedule >= $2 AND schedule <= $3), 0) AS today_earnings,
           COALESCE(SUM(final_price) FILTER (WHERE status = 'COMPLETED'), 0) AS total_earned
         FROM ${schema}.bookings
         WHERE worker_uid = $1`,
        [uid, todayStart, todayEnd]
      ),
      (async () => {
        const col = (await mongoDb).collection("worker_locations");
        return col.findOne({ uid }, { projection: { is_online: 1, updatedAt: 1 } });
      })(),
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
        rating: 0,
        unreadMessages: 0,
        requirementsAlerts: 0,
        currency: "PHP",
      },
    });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: error?.message || "Server error" });
  }
};

// ─── Earnings ─────────────────────────────────────────────────────────────────

export const getEarnings = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    const { startDate, endDate } = req.query;

    let dateFilter = "";
    const params: any[] = [uid];

    if (startDate && endDate) {
      params.push(startDate, endDate);
      dateFilter = `AND b.schedule >= $2 AND b.schedule <= $3`;
    }

    const result = await dbQuery.query(
      `SELECT b.id, b.status, b.schedule, b.final_price, b.payment_method,
              s.level_2 AS service_name,
              p.status AS payment_status
       FROM ${dbSchema}.bookings b
       LEFT JOIN ${dbSchema}.service_options so ON so.id = b.service_option_id
       LEFT JOIN ${dbSchema}.services s ON s.id = so.service_id
       LEFT JOIN ${dbSchema}.payments p ON p.booking_id = b.id
       WHERE b.worker_uid = $1 AND b.status = 'COMPLETED'
       ${dateFilter}
       ORDER BY b.schedule DESC`,
      params
    );

    const data = result.rows.map((r: any) => {
      const gross = Number(r.final_price || 0);
      return {
        id: String(r.id),
        bookingId: String(r.id),
        bookingCode: bookingCode(r.id),
        serviceName: r.service_name || "",
        completedAt: r.schedule,
        scheduledAt: r.schedule,
        bookingAmount: gross,
        providerShareAmount: Math.round(gross * 0.8 * 100) / 100,
        providerSharePercent: 80,
        clientPaymentStatus: r.payment_status ? r.payment_status.toLowerCase() : "pending",
        bookingStatus: "completed",
        providerPayoutStatus: "disbursed",
        paymentMethod: (r.payment_method || "cash").toLowerCase(),
        currency: "PHP",
      };
    });

    return res.status(200).json({ status: "success", data });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: error?.message || "Server error" });
  }
};

export const getEarningsSummary = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    const { startDate, endDate } = req.query;

    let dateFilter = "";
    const params: any[] = [uid];

    if (startDate && endDate) {
      params.push(startDate, endDate);
      dateFilter = `AND b.schedule >= $2 AND b.schedule <= $3`;
    }

    const result = await dbQuery.query(
      `SELECT
         COUNT(*) AS total_jobs,
         COALESCE(SUM(final_price), 0) AS total_earned
       FROM ${dbSchema}.bookings b
       WHERE b.worker_uid = $1 AND b.status = 'COMPLETED'
       ${dateFilter}`,
      params
    );

    const s = result.rows[0] || {};
    const gross = Number(s.total_earned ?? 0);
    const share = Math.round(gross * 0.8 * 100) / 100;

    return res.status(200).json({
      status: "success",
      data: {
        totalEarned: share,
        totalPaid: share,
        totalPending: 0,
        totalRefunded: 0,
        periodLabel: startDate ? "Custom range" : "All time",
        currency: "PHP",
        jobsCount: Number(s.total_jobs ?? 0),
      },
    });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: error?.message || "Server error" });
  }
};

export const getLedger = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;

    const result = await dbQuery.query(
      `SELECT b.id, b.schedule, b.final_price, b.payment_method, b.status,
              s.level_2 AS service_name
       FROM ${dbSchema}.bookings b
       LEFT JOIN ${dbSchema}.service_options so ON so.id = b.service_option_id
       LEFT JOIN ${dbSchema}.services s ON s.id = so.service_id
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
        amountMinor: Math.round(gross * 0.8 * 100),
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
    return res.status(500).json({ status: "failed", message: error?.message || "Server error" });
  }
};

export const getPayouts = async (req: Request, res: Response) => {
  // Payout disbursement records — not yet in DB schema, return empty
  return res.status(200).json({ status: "success", data: [] });
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
    return res.status(500).json({ status: "failed", message: error?.message || "Server error" });
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
    return res.status(500).json({ status: "failed", message: error?.message || "Server error" });
  }
};

// ─── Availability (MongoDB — worker_availability / worker_time_off) ───────────

const DEFAULT_DAYS = ['mon','tue','wed','thu','fri','sat','sun'];

export const getWorkerAvailability = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });
    const col = (await mongoDb).collection("worker_availability");
    const doc = await col.findOne({ uid }, { projection: { _id: 0, uid: 0 } });
    const schedule = doc?.schedule ?? DEFAULT_DAYS.map(day => ({ day, enabled: false, slots: [] }));
    return res.status(200).json({
      status: "success",
      data: { schedule, timezone: doc?.timezone ?? "Asia/Manila", updatedAt: doc?.updatedAt ?? null },
    });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: error?.message || "Server error" });
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
    const now = new Date();
    const col = (await mongoDb).collection("worker_availability");
    await col.updateOne(
      { uid },
      { $set: { uid, schedule, timezone: timezone ?? "Asia/Manila", updatedAt: now } },
      { upsert: true }
    );
    return res.status(200).json({ status: "success", data: { success: true, updatedAt: now.toISOString() } });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: error?.message || "Server error" });
  }
};

export const getWorkerTimeOff = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });
    const col = (await mongoDb).collection("worker_time_off");
    const docs = await col.find({ uid }, { projection: { _id: 0, uid: 0 } }).toArray();
    return res.status(200).json({ status: "success", data: { timeOff: docs } });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: error?.message || "Server error" });
  }
};

export const createWorkerTimeOff = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });
    const { startDate, endDate, allDay, startTime, endTime, reason, note } = req.body;
    if (!startDate || !endDate || !reason) {
      return res.status(400).json({ status: "failed", message: "startDate, endDate, and reason are required" });
    }
    const id = `toff-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const record = {
      uid, id, startDate, endDate,
      allDay: allDay ?? true,
      startTime: startTime ?? null,
      endTime: endTime ?? null,
      reason,
      note: note ?? null,
      createdAt: new Date().toISOString(),
    };
    const col = (await mongoDb).collection("worker_time_off");
    await col.insertOne(record);
    const { uid: _u, ...dto } = record;
    return res.status(201).json({ status: "success", data: dto });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: error?.message || "Server error" });
  }
};

export const deleteWorkerTimeOff = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });
    const { id } = req.params;
    if (!id) return res.status(400).json({ status: "failed", message: "id is required" });
    const col = (await mongoDb).collection("worker_time_off");
    const result = await col.deleteOne({ uid, id });
    if (!result.deletedCount) {
      return res.status(404).json({ status: "failed", message: "Time-off period not found or does not belong to this provider" });
    }
    return res.status(200).json({ status: "success", data: { success: true } });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: error?.message || "Server error" });
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
    return res.status(500).json({ status: "failed", message: error?.message || "Server error" });
  }
};

export const getWorkerRequirementsOwn = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });
    const requirements = await technicianService.getWorkerRequirements(uid);
    return res.status(200).json({ status: "success", data: requirements });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: error?.message || "Server error" });
  }
};

export const deleteWorkerRequirementOwn = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ status: "failed", message: "Invalid id" });
    await technicianService.deleteWorkerRequirement(uid, id);
    return res.status(200).json({ status: "success", data: { success: true } });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: error?.message || "Requirement not found" });
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
    return res.status(code ?? 500).json({ status: "failed", message: error?.message || "Server error" });
  }
};

export const submitOnboarding = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });
    const data = await onboardingService.submitOnboarding(uid);
    return res.status(200).json({ status: "success", data });
  } catch (error: any) {
    const code = (error as any).statusCode;
    return res.status(code ?? 500).json({ status: "failed", message: error?.message || "Server error" });
  }
};

export const saveOnboardingStep = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });
    const { step, ...payload } = req.body;
    if (!step) return res.status(400).json({ status: "failed", message: "step is required" });
    const data = await onboardingService.saveDraftStep(uid, step, payload);
    return res.status(200).json({ status: "success", data: { success: true, ...data } });
  } catch (error: any) {
    const code = (error as any).statusCode;
    return res.status(code ?? 500).json({ status: "failed", message: error?.message || "Server error" });
  }
};

export const getProviderReconciliationReport = async (req: Request, res: Response) => {
  try {
    const data = await onboardingService.getReconciliationReport();
    return res.status(200).json({ status: "success", data });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: error?.message || "Server error" });
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
    return res.status(500).json({ status: "failed", message: error?.message || "Server error" });
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
    return res.status(500).json({ status: "failed", message: error?.message || "Server error" });
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
    return res.status(500).json({ status: "failed", message: error?.message || "Server error" });
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
    return res.status(500).json({ status: "failed", message: error?.message || "Server error" });
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
    return res.status(500).json({ status: "failed", message: error?.message || "Server error" });
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
    return res.status(500).json({ status: "failed", message: error?.message || "Server error" });
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
    return res.status(500).json({ status: "failed", message: error?.message || "Server error" });
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
    return res.status(500).json({ status: "failed", message: error?.message || "Server error" });
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
    return res.status(500).json({ status: "failed", message: error?.message || "Server error" });
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
    return res.status(500).json({ status: "failed", message: error?.message || "Server error" });
  }
};

export const revokeAllProviderSessions = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });
    await revokeTokenInFirebase(uid);
    return res.status(200).json({ status: "success", data: null, message: "All other sessions revoked." });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: error?.message || "Server error" });
  }
};

// ─── Service Area (MongoDB — worker_service_areas) ────────────────────────────

const CITY_NAMES: Record<string, string> = {
  manila: 'City of Manila', quezon: 'Quezon City', makati: 'Makati City',
  taguig: 'Taguig City', pasig: 'Pasig City', mandaluyong: 'Mandaluyong City',
  marikina: 'Marikina City', caloocan: 'Caloocan City', malabon: 'Malabon City',
  navotas: 'Navotas City', valenzuela: 'Valenzuela City', 'las-pinas': 'Las Piñas City',
  muntinlupa: 'Muntinlupa City', paranaque: 'Parañaque City', pasay: 'Pasay City',
  pateros: 'Pateros', 'san-juan': 'San Juan City',
  bacoor: 'Bacoor City', imus: 'Imus City', antipolo: 'Antipolo City',
  'san-jose-del-monte': 'San Jose del Monte',
};

const VALID_CITY_IDS = new Set(Object.keys(CITY_NAMES));

function buildAreaLabel(cityIds: string[]): string {
  if (cityIds.length === 0) return '';
  const names = cityIds.slice(0, 3).map(id => CITY_NAMES[id] || id);
  const suffix = cityIds.length > 3 ? ` + ${cityIds.length - 3} more` : '';
  return names.join(', ') + suffix;
}

export const getWorkerServiceArea = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });
    const col = (await mongoDb).collection("worker_service_areas");
    const doc = await col.findOne({ uid }, { projection: { _id: 0, uid: 0 } });
    return res.status(200).json({
      status: "success",
      data: { cityIds: doc?.cityIds || [], label: doc?.label || '', updatedAt: doc?.updatedAt || null },
    });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: error?.message || "Server error" });
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
    const clean: string[] = cityIds
      .filter((id: any) => typeof id === 'string' && VALID_CITY_IDS.has(id))
      .slice(0, 21);
    const now = new Date().toISOString();
    const label = buildAreaLabel(clean);
    const col = (await mongoDb).collection("worker_service_areas");
    await col.updateOne({ uid }, { $set: { uid, cityIds: clean, label, updatedAt: now } }, { upsert: true });
    return res.status(200).json({ status: "success", data: { success: true, updatedAt: now, label } });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: error?.message || "Server error" });
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
    return res.status(500).json({ status: "failed", message: error?.message || "Server error" });
  }
};

// ─── Payout Settings (MongoDB — worker_payout_methods) ───────────────────────

const PAYOUT_TYPE_LABELS: Record<string, string> = {
  gcash: 'GCash', maya: 'Maya', bdo: 'BDO Unibank',
  bpi: 'Bank of the Philippine Islands', unionbank: 'UnionBank',
  landbank: 'Landbank of the Philippines', other: 'Other',
};
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
        hasPayoutMethod: true,
        type: doc.type,
        typeLabel: PAYOUT_TYPE_LABELS[doc.type] || doc.type,
        maskedIdentifier: doc.maskedIdentifier || null,
        status: doc.status || 'pending',
        statusLabel: PAYOUT_STATUS_LABELS[doc.status] || 'Pending review',
        lastUpdated: doc.updatedAt || null,
      },
    });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: error?.message || "Server error" });
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

    const { type, identifier } = req.body;
    const VALID_TYPES = ['gcash', 'maya', 'bdo', 'bpi', 'unionbank', 'landbank', 'other'];
    if (!type || !VALID_TYPES.includes(type)) {
      return res.status(400).json({ status: "failed", message: "Invalid payout type" });
    }
    if (!identifier || String(identifier).trim().length < 4) {
      return res.status(400).json({ status: "failed", message: "Account number must be at least 4 characters" });
    }

    const trimmed = String(identifier).trim();
    const maskedIdentifier = '•••• ' + trimmed.slice(-4);

    const col = (await mongoDb).collection("worker_payout_methods");
    await col.updateOne(
      { uid },
      { $set: { uid, type, maskedIdentifier, status: 'pending', updatedAt: new Date() } },
      { upsert: true }
    );

    return res.status(200).json({
      status: "success",
      data: {
        hasPayoutMethod: true,
        type,
        typeLabel: PAYOUT_TYPE_LABELS[type] || type,
        maskedIdentifier,
        status: 'pending',
        statusLabel: 'Pending review',
        lastUpdated: new Date().toISOString(),
      },
    });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: error?.message || "Server error" });
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
    return res.status(500).json({ status: "failed", message: error?.message || "Server error" });
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
    return res.status(500).json({ status: "failed", message: error?.message || "Server error" });
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
    return res.status(500).json({ status: "failed", message: error?.message || "Server error" });
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
    return res.status(500).json({ status: "failed", message: error?.message || "Server error" });
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
    return res.status(500).json({ status: "failed", message: error?.message || "Server error" });
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
    return res.status(500).json({ status: "failed", message: error?.message || "Server error" });
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
    return res.status(500).json({ status: "failed", message: error?.message || "Server error" });
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
    return res.status(500).json({ status: "failed", message: error?.message || "Server error" });
  }
};

export const getSupportUnreadCount = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });
    const count = await notificationService.countUnreadSupportReplies(uid);
    return res.status(200).json({ status: "success", data: { count } });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: error?.message || "Server error" });
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
    return res.status(500).json({ status: "failed", message: error?.message || "Server error" });
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
    return res.status(500).json({ success: false, message: error.message || "Failed to fetch applications" });
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

// ─── FCM Token ────────────────────────────────────────────────────────────────

export const saveProviderFcmToken = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });
    const { token } = req.body;
    if (!token || typeof token !== 'string' || token.trim().length < 10) {
      return res.status(400).json({ status: "failed", message: "token is required" });
    }
    await dbQuery.query(
      `UPDATE ${dbSchema}.user_credentials SET fcm_token = $1 WHERE uid = $2`,
      [token.trim(), uid]
    );
    return res.status(200).json({ status: "success", data: { saved: true } });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: error?.message || "Server error" });
  }
};
