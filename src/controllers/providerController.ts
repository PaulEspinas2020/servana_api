import { Request, Response } from "express";
import { db } from "../config";
import dbQuery from "../db/dbQuery";
import * as technicianService from "../services/technicianService";
import * as userService from "../services/user.service";
import mongoDb from "../db/mongodbQuery";
import { uploadFileToStorage } from "../helpers/firebaseStorageUploader";
import * as notificationService from "../services/notification.service";

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

    const schema = dbSchema;
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
    const { file, name } = req.body;
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
    const fileUrl = await uploadFileToStorage("provider-requirements", `${uid}_${Date.now()}`, file);
    const inserted = await technicianService.addWorkerRequirements(uid, [{ fileUrl, fileName: sanitizedName }]);
    const row = inserted[0];
    return res.status(201).json({
      status: "success",
      data: { requirementId: String(row.id), status: "pending_review", uploadedAt: row.uploadedAt },
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

// ─── Onboarding (maps review-status + requirements to onboarding state) ───────

export const getOnboardingState = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });

    const [workerRes, reqRes] = await Promise.all([
      dbQuery.query(
        `SELECT is_email_verified, is_archive FROM ${dbSchema}.user_credentials WHERE uid = $1`,
        [uid]
      ),
      dbQuery.query(
        `SELECT COUNT(*) AS count FROM ${dbSchema}.worker_requirements WHERE worker_uid = $1`,
        [uid]
      ),
    ]);

    if (!workerRes.rowCount) return res.status(404).json({ status: "failed", message: "Provider not found" });

    const worker = workerRes.rows[0];
    const reqCount = Number(reqRes.rows[0].count);
    const emailVerified: boolean = worker.is_email_verified;
    const hasRequirements = reqCount > 0;

    const completedSteps: string[] = [];
    if (emailVerified) completedSteps.push("personal_info");
    if (hasRequirements) completedSteps.push("requirements");

    let status = "in_progress";
    let currentStep = emailVerified ? "requirements" : "personal_info";
    if (emailVerified && hasRequirements) { status = "pending_review"; currentStep = "submitted"; }

    return res.status(200).json({
      status: "success",
      data: { status, currentStep, completedSteps },
    });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: error?.message || "Server error" });
  }
};

export const submitOnboarding = async (req: Request, res: Response) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ status: "failed", message: "Unauthorized" });

    const reqRes = await dbQuery.query(
      `SELECT COUNT(*) AS count FROM ${dbSchema}.worker_requirements WHERE worker_uid = $1`,
      [uid]
    );
    if (Number(reqRes.rows[0].count) === 0) {
      return res.status(400).json({
        status: "failed",
        message: "Please upload at least one requirement document before submitting.",
      });
    }

    return res.status(200).json({
      status: "success",
      data: {
        status: "pending_review",
        currentStep: "submitted",
        completedSteps: ["personal_info", "requirements"],
        submittedAt: new Date().toISOString(),
      },
    });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: error?.message || "Server error" });
  }
};

export const saveOnboardingStep = async (req: Request, res: Response) => {
  // Scaffold — step data persisted via their respective dedicated endpoints.
  return res.status(200).json({ status: "success", data: { success: true } });
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

    const result = await dbQuery.query(
      `SELECT uc.uid, uc.email, uc.first_name, uc.last_name,
              uc.phone_number AS phone, uc.worker_code, uc.role, uc.is_email_verified,
              up.photo_url
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
        photo_url: r.photo_url || null,
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
    await notificationService.markNotificationReadByKey(uid, key);
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
    await notificationService.deleteNotificationByKey(uid, key);
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
    await notificationService.deleteAlertByKey(uid, key);
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
