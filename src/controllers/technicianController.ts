import { Request, Response } from "express";
import * as technician from "../services/technicianService";
import { toCamel } from "../helpers/idGenerator";
import { uploadFileToStorage } from "../helpers/firebaseStorageUploader";

export const listByRole = async (req: Request, res: Response) => {
  try {
    const role = Number(req.params.role);

    if (Number.isNaN(role)) {
      return res.status(400).json({
        success: false,
        message: "Invalid role",
      });
    }

    const workers = await technician.listWorkersByRole(role);
    const toCamelRows = (rows: any[]) => rows.map(toCamel);
    return res.json({
      success: true,
      workers: toCamelRows(workers),
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch workers",
    });
  }
};

export const list = async (req: Request, res: Response) => {
  try {
    const workers = await technician.allWorkers();
    const toCamelRows = (rows: any[]) => rows.map(toCamel);
    return res.json({
      success: true,
      workers: toCamelRows(workers),
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch workers",
    });
  }
};

export const getByUid = async (req: Request, res: Response) => {
  try {
    const { uid } = req.params as { uid: string };

    if (!uid) {
      return res.status(400).json({
        success: false,
        message: "uid is required",
      });
    }

    const worker = await technician.getWorkerByUid(uid);

    if (!worker) {
      return res.status(404).json({
        success: false,
        message: "Worker not found",
      });
    }

    const { addresses, services, ...rest } = worker;
    return res.json({
      success: true,
      worker: {
        ...toCamel(rest),
        addresses,
        services,
      },
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch worker",
    });
  }
};

export const updateLocation = async (req: Request, res: Response) => {
  try {
    const { uid, latitude, longitude, isOnline } = req.body;

    if (!uid) {
      return res.status(400).json({
        success: false,
        message: "uid is required",
      });
    }

    if (latitude === undefined || longitude === undefined) {
      return res.status(400).json({
        success: false,
        message: "latitude and longitude are required",
      });
    }

    if (isOnline === undefined) {
      return res.status(400).json({
        success: false,
        message: "is_online is required",
      });
    }

    const worker = await technician.getWorkerByUid(uid);

    if (!worker) {
      return res.status(404).json({
        success: false,
        message: "Worker not found",
      });
    }

    await technician.upsertWorkerLocation({
      uid,
      latitude: Number(latitude),
      longitude: Number(longitude),
      is_online: Boolean(isOnline),
    });

    return res.json({
      success: true,
      message: "Worker location updated successfully",
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to update worker location",
    });
  }
};

export const getLocation = async (req: Request, res: Response) => {
  try {
    const { uid } = req.params as { uid: string };

    if (!uid) {
      return res.status(400).json({
        success: false,
        message: "uid is required",
      });
    }

    const location = await technician.getWorkerLocation(uid);

    if (!location) {
      return res.status(404).json({
        success: false,
        message: "Worker location not found",
      });
    }

    return res.json({
      success: true,
      location: toCamel(location),
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch worker location",
    });
  }
};

export const workerSchedule = async (req: Request, res: Response) => {
  try {
    const workerId = req.params.workerId as string;

    if (!workerId) {
      return res.status(400).json({
        success: false,
        message: "Invalid workerId",
      });
    }

    const schedule = await technician.getWorkerSchedule(workerId);

    res.json({
      success: true,
      schedule,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch schedule",
    });
  }
};

export const getJobCards = async (req: Request, res: Response) => {
  try {
    const workerId = req.params.workerId as string;

    const jobs = await technician.getJobCardsByWorker(workerId);

    const formatted = await Promise.all(
      jobs.map(async (job: any) => {
        // const addons = await technician.getJobCardAddons(job.booking_id);

        return {
          bookingId: job.booking_id,
          status: job.status,
          scheduleAt: job.schedule,

          customer: {
            uid: job.customer_id,
            name: `${job.first_name} ${job.last_name}`,
            phone: job.phone_number,
          },

          address: {
            addressOne: job.address_one,
            addressTwo: job.address_two,
            city: job.post_town,
            zipCode: job.zip_code,
            country: job.country,
            label: job.label,
          },

          service: {
            name: job.service_name,
            type: job.service_type,
          },

          addOns: job.pricing_breakdown,
          workerStatus: job.worker_status,
          assignedAt: job.assigned_at,
          startedAt: job.started_at,
          completedAt: job.completed_at,
        };
      })
    );

    return res.json(formatted); // 👈 FLAT ARRAY RESPONSE
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch job cards",
    });
  }
};

export const getAvailableWorkers = async (req: Request, res: Response) => {
  try {
    const { date, time, serviceId, bookingId } = req.query as {
      date?: string;
      time?: string;
      serviceId?: string;
      bookingId?: string;
    };

    let resolvedServiceId: number | undefined = serviceId ? Number(serviceId) : undefined;
    let resolvedSchedule: string | undefined;

    // If bookingId is provided, derive schedule + serviceId directly from the booking
    if (bookingId) {
      const { default: dbQuery } = await import("../db/dbQuery");
      const { db } = await import("../config");
      const dbSchema = db.schema;

      const res2 = await dbQuery.query(
        `
        SELECT b.schedule, so.service_id
        FROM ${dbSchema}.bookings b
        JOIN ${dbSchema}.service_options so ON so.id = b.service_option_id
        WHERE b.id = $1
        `,
        [Number(bookingId)]
      );

      if (!res2.rowCount) {
        return res.status(404).json({ success: false, message: "Booking not found" });
      }

      const row = res2.rows[0];
      resolvedSchedule = new Date(row.schedule).toISOString().slice(0, 16).replace("T", "T");
      if (!resolvedServiceId) resolvedServiceId = Number(row.service_id);
    } else {
      if (!date || !time) {
        return res.status(400).json({
          success: false,
          message: "Provide either bookingId, or both date (YYYY-MM-DD) and time (HH:MM)",
        });
      }
      resolvedSchedule = `${date}T${time}:00`;
    }

    const workers = await technician.getAvailableWorkers(resolvedSchedule!, resolvedServiceId);

    return res.json({
      success: true,
      schedule: resolvedSchedule,
      serviceId: resolvedServiceId ?? null,
      count: workers.length,
      workers,
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch available workers",
    });
  }
};

export const assignEmployeeServices = async (req: Request, res: Response) => {
  try {
    const { uid } = req.params as { uid: string };
    const { serviceIds } = req.body as { serviceIds: number[] };

    if (!uid || !Array.isArray(serviceIds) || !serviceIds.length) {
      return res.status(400).json({ success: false, message: "uid and serviceIds[] are required" });
    }

    const result = await technician.assignServicesToEmployee(uid, serviceIds);
    return res.json({ success: true, assigned: result });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || "Failed to assign services" });
  }
};

export const removeEmployeeService = async (req: Request, res: Response) => {
  try {
    const { uid, serviceId } = req.params as { uid: string; serviceId: string };

    if (!uid || !serviceId) {
      return res.status(400).json({ success: false, message: "uid and serviceId are required" });
    }

    const result = await technician.removeServiceFromEmployee(uid, Number(serviceId));
    return res.json({ success: true, removed: toCamel(result) });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || "Failed to remove service" });
  }
};

export const getEmployeeServices = async (req: Request, res: Response) => {
  try {
    const { uid } = req.params as { uid: string };

    if (!uid) {
      return res.status(400).json({ success: false, message: "uid is required" });
    }

    const services = await technician.getServicesByEmployee(uid);
    return res.json({ success: true, services });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || "Failed to fetch services" });
  }
};

export const getWorkersByService = async (req: Request, res: Response) => {
  try {
    const serviceId = Number(req.params.serviceId);

    if (Number.isNaN(serviceId)) {
      return res.status(400).json({ success: false, message: "Invalid serviceId" });
    }

    const workers = await technician.getWorkersByService(serviceId);
    const toCamelRows = (rows: any[]) => rows.map(toCamel);
    return res.json({ success: true, workers: toCamelRows(workers) });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || "Failed to fetch workers" });
  }
};

// ---------------------------------------------------------------------------
// Worker Bank Account
// ---------------------------------------------------------------------------

/**
 * PUT /workers/:uid/bank-account
 * Register or update a worker's bank account for PayMongo payouts.
 * Body: { bankCode, accountNumber, accountName }
 */
export const upsertBankAccount = async (req: Request, res: Response) => {
  try {
    const { uid } = req.params as { uid: string };
    const { bankCode, accountNumber, accountName } = req.body;

    if (!bankCode || !accountNumber || !accountName) {
      return res.status(400).json({
        status: "failed",
        message: "bankCode, accountNumber, and accountName are required",
      });
    }

    const account = await technician.upsertWorkerBankAccount(uid, {
      bankCode,
      accountNumber,
      accountName,
    });

    return res.json({ status: "success", data: toCamel(account) });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: error.message });
  }
};

export const getBankAccount = async (req: Request, res: Response) => {
  try {
    const { uid } = req.params as { uid: string };
    const account = await technician.getWorkerBankAccount(uid);

    if (!account) {
      return res.status(404).json({ status: "failed", message: "No bank account registered" });
    }

    return res.json({ status: "success", data: toCamel(account) });
  } catch (error: any) {
    return res.status(500).json({ status: "failed", message: error.message });
  }
};

export const deleteBankAccount = async (req: Request, res: Response) => {
  try {
    const { uid } = req.params as { uid: string };
    const account = await technician.deleteWorkerBankAccount(uid);
    return res.json({ status: "success", data: toCamel(account) });
  } catch (error: any) {
    return res.status(400).json({ status: "failed", message: error.message });
  }
};

export const assignWorker = async (req: Request, res: Response) => {
  try {
    const bookingId = Number(req.params.bookingId);
    const workerUid = req.query.workerUid as string;

    if (!bookingId || !workerUid) {
      return res.status(400).json({
        success: false,
        message: "bookingId and workerUid are required",
      });
    }

    const result = await technician.assignWorker(
      bookingId,
      workerUid
    );

    return res.json({
      success: true,
      message: "Worker assigned successfully",
      data: result,
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to assign worker",
    });
  }
};

export const declineJob = async (req: Request, res: Response) => {
  try {
    const bookingId = Number(req.params.bookingId);
    const workerUid = req.query.workerUid as string;

    if (!bookingId || !workerUid) {
      return res.status(400).json({
        success: false,
        message: "bookingId and workerUid are required",
      });
    }

    const result = await technician.declineJob(bookingId, workerUid);

    return res.json({
      success: true,
      message: result.reassignment?.assigned
        ? "Job declined — a new worker has been assigned"
        : "Job declined — no available worker found, booking returned to queue",
      data: result,
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to decline job",
    });
  }
};

export const acceptJob = async (req: Request, res: Response) => {
  try {
    const bookingId = Number(req.params.bookingId);
   const workerUid = req.query.workerUid as string; // or from auth token

    if (!bookingId || !workerUid) {
      return res.status(400).json({
        success: false,
        message: "bookingId and workerUid are required",
      });
    }

    const result = await technician.acceptJob(bookingId, workerUid);

    return res.json({
      success: true,
      message: "Job accepted",
      data: result,
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to accept job",
    });
  }
};

export const startJob = async (req: Request, res: Response) => {
  try {
    const bookingId = Number(req.params.bookingId);
    const workerUid = req.query.workerUid as string;
    const workerCode = req.query.workerCode as string; // or from auth token

    if (!bookingId || !workerUid) {
      return res.status(400).json({
        success: false,
        message: "bookingId and workerUid are required",
      });
    }

    const result = await technician.startJob(bookingId, workerUid, workerCode);

    return res.json({
      success: true,
      message: "Job started",
      data: result,
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to start job",
    });
  }
};

export const completeJob = async (req: Request, res: Response) => {
  try {
    const bookingId = Number(req.params.bookingId);
    const workerUid = req.query.workerUid as string;

    if (!bookingId || !workerUid) {
      return res.status(400).json({
        success: false,
        message: "bookingId and workerUid are required",
      });
    }

    const result = await technician.completeJob(bookingId, workerUid);

    return res.json({
      success: true,
      message: "Job completed successfully",
      data: result,
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to complete job",
    });
  }
};

// ---------------------------------------------------------------------------
// Worker Archive / Deactivate
// ---------------------------------------------------------------------------

/**
 * PATCH /admin/workers/:uid/archive
 * Body: { isArchive: boolean }
 */
export const setArchiveStatus = async (req: Request, res: Response) => {
  try {
    const { uid } = req.params as { uid: string };
    const { isArchive } = req.body as { isArchive: boolean };

    if (!uid) {
      return res.status(400).json({ success: false, message: "uid is required" });
    }

    if (typeof isArchive !== "boolean") {
      return res.status(400).json({ success: false, message: "isArchive must be a boolean" });
    }

    const worker = await technician.setWorkerArchiveStatus(uid, isArchive);
    return res.json({
      success: true,
      message: isArchive ? "Worker deactivated" : "Worker reactivated",
      worker: toCamel(worker),
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || "Failed to update worker status" });
  }
};

// ---------------------------------------------------------------------------
// Worker Requirements
// ---------------------------------------------------------------------------

/**
 * POST /workers/:uid/requirements
 * Body: { files: [{ data: "<base64 data URI>", name: "<filename>" }] }
 */
export const uploadRequirements = async (req: Request, res: Response) => {
  try {
    const { uid } = req.params as { uid: string };
    const files: Array<{ data: string; name: string; requirementType?: string }> = req.body.files;

    if (!uid) {
      return res.status(400).json({ success: false, message: "uid is required" });
    }

    if (!Array.isArray(files) || !files.length) {
      return res.status(400).json({ success: false, message: "files must be a non-empty array" });
    }

    const worker = await technician.getWorkerByUid(uid);
    if (!worker) {
      return res.status(404).json({ success: false, message: "Worker not found" });
    }

    const uploaded: Array<{ fileUrl: string; fileName: string; requirementType?: string }> = [];
    for (const file of files) {
      if (!file.data || !file.name) {
        return res.status(400).json({ success: false, message: "Each file must have data and name" });
      }
      const fileUrl = await uploadFileToStorage(
        "employee-requirements",
        `${uid}_${Date.now()}`,
        file.data
      );
      uploaded.push({ fileUrl, fileName: file.name, requirementType: file.requirementType });
    }

    const requirements = await technician.addWorkerRequirements(uid, uploaded);

    return res.json({ success: true, requirements });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || "Failed to upload requirements" });
  }
};

/**
 * GET /workers/:uid/requirements
 */
export const getRequirements = async (req: Request, res: Response) => {
  try {
    const { uid } = req.params as { uid: string };

    if (!uid) {
      return res.status(400).json({ success: false, message: "uid is required" });
    }

    const requirements = await technician.getWorkerRequirements(uid);
    return res.json({ success: true, requirements });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || "Failed to fetch requirements" });
  }
};

/**
 * DELETE /workers/:uid/requirements/:id
 */
export const deleteRequirement = async (req: Request, res: Response) => {
  try {
    const { uid, id } = req.params as { uid: string; id: string };

    if (!uid || !id) {
      return res.status(400).json({ success: false, message: "uid and id are required" });
    }

    const deleted = await technician.deleteWorkerRequirement(uid, Number(id));
    return res.json({ success: true, deleted });
  } catch (error: any) {
    return res.status(400).json({ success: false, message: error.message || "Failed to delete requirement" });
  }
};

// ---------------------------------------------------------------------------
// Worker History & Earnings
// ---------------------------------------------------------------------------

export const getBookingHistory = async (req: Request, res: Response) => {
  try {
    const { uid } = req.params as { uid: string };
    const rows = await technician.getWorkerBookingHistory(uid);
    return res.json({ success: true, bookings: rows.map(toCamel) });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const getDisbursementHistory = async (req: Request, res: Response) => {
  try {
    const { uid } = req.params as { uid: string };
    const rows = await technician.getWorkerDisbursementHistory(uid);
    return res.json({ success: true, disbursements: rows.map(toCamel) });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const getEarningsHistory = async (req: Request, res: Response) => {
  try {
    const { uid } = req.params as { uid: string };
    const { summary, monthly } = await technician.getWorkerEarningsHistory(uid);
    return res.json({
      success: true,
      summary: toCamel(summary),
      monthly: monthly.map(toCamel),
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ---------------------------------------------------------------------------
// Online Status
// ---------------------------------------------------------------------------

export const getOnlineStatus = async (req: Request, res: Response) => {
  try {
    const { uid } = req.params as { uid: string };
    if (!uid) return res.status(400).json({ success: false, message: "uid is required" });
    const data = await technician.getWorkerOnlineStatus(uid);
    return res.json({ success: true, ...data });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || "Failed to get online status" });
  }
};

export const goOnline = async (req: Request, res: Response) => {
  try {
    const { uid } = req.params as { uid: string };
    if (!uid) return res.status(400).json({ success: false, message: "uid is required" });
    const data = await technician.setWorkerOnlineStatus(uid, true);
    return res.json({ success: true, ...data });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || "Failed to go online" });
  }
};

export const goOffline = async (req: Request, res: Response) => {
  try {
    const { uid } = req.params as { uid: string };
    if (!uid) return res.status(400).json({ success: false, message: "uid is required" });
    const data = await technician.setWorkerOnlineStatus(uid, false);
    return res.json({ success: true, ...data });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || "Failed to go offline" });
  }
};

// ---------------------------------------------------------------------------
// Availability & Time-Off
// ---------------------------------------------------------------------------

export const getAvailability = async (req: Request, res: Response) => {
  try {
    const { uid } = req.params as { uid: string };
    if (!uid) return res.status(400).json({ success: false, message: "uid is required" });
    const data = await technician.getWorkerAvailability(uid);
    return res.json({ success: true, data: toCamel(data) });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || "Failed to get availability" });
  }
};

export const saveAvailability = async (req: Request, res: Response) => {
  try {
    const { uid } = req.params as { uid: string };
    if (!uid) return res.status(400).json({ success: false, message: "uid is required" });
    const result = await technician.saveWorkerAvailability(uid, req.body);
    return res.json({ ...result, success: true });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || "Failed to save availability" });
  }
};

export const getTimeOff = async (req: Request, res: Response) => {
  try {
    const { uid } = req.params as { uid: string };
    if (!uid) return res.status(400).json({ success: false, message: "uid is required" });
    const rows = await technician.getWorkerTimeOff(uid);
    return res.json({ success: true, data: rows.map(toCamel) });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || "Failed to get time-off" });
  }
};

export const createTimeOff = async (req: Request, res: Response) => {
  try {
    const { uid } = req.params as { uid: string };
    if (!uid) return res.status(400).json({ success: false, message: "uid is required" });
    const row = await technician.createWorkerTimeOff(uid, req.body);
    return res.json({ success: true, data: toCamel(row) });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || "Failed to create time-off" });
  }
};

export const deleteTimeOff = async (req: Request, res: Response) => {
  try {
    const { uid } = req.params as { uid: string };
    const { id } = req.params as { id: string };
    if (!uid || !id) return res.status(400).json({ success: false, message: "uid and id are required" });
    await technician.deleteWorkerTimeOff(uid, id);
    return res.json({ success: true });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || "Failed to delete time-off" });
  }
};

// ---------------------------------------------------------------------------
// Service Area
// ---------------------------------------------------------------------------

export const getServiceArea = async (req: Request, res: Response) => {
  try {
    const { uid } = req.params as { uid: string };
    if (!uid) return res.status(400).json({ success: false, message: "uid is required" });
    const data = await technician.getWorkerServiceArea(uid);
    return res.json({ success: true, data: toCamel(data) });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || "Failed to get service area" });
  }
};

export const saveServiceArea = async (req: Request, res: Response) => {
  try {
    const { uid } = req.params as { uid: string };
    if (!uid) return res.status(400).json({ success: false, message: "uid is required" });
    const result = await technician.saveWorkerServiceArea(uid, req.body);
    return res.json({ ...result, success: true });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || "Failed to save service area" });
  }
};

// ---------------------------------------------------------------------------
// Profile Photo
// ---------------------------------------------------------------------------

export const uploadProfilePhoto = async (req: Request, res: Response) => {
  try {
    const { uid } = req.params as { uid: string };
    if (!uid) return res.status(400).json({ success: false, message: "uid is required" });
    const { data: dataUri, name } = req.body as { data: string; name: string };
    if (!dataUri) return res.status(400).json({ success: false, message: "data is required" });
    const match = dataUri.match(/^data:(image\/(jpeg|png|webp));base64,/);
    if (!match) return res.status(400).json({ success: false, message: "Invalid image format (jpeg/png/webp only)" });
    const photoUrl = await uploadFileToStorage(dataUri, name || `profile_${uid}.jpg`, "profile-photos");
    const result = await technician.updateWorkerPhotoUrl(uid, photoUrl);
    return res.json({ success: true, ...result });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || "Failed to upload photo" });
  }
};

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export const getDashboard = async (req: Request, res: Response) => {
  try {
    const { uid } = req.params as { uid: string };
    if (!uid) return res.status(400).json({ success: false, message: "uid is required" });
    const data = await technician.getWorkerDashboard(uid);
    return res.json({ success: true, data });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || "Failed to get dashboard" });
  }
};

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

export const getOnboarding = async (req: Request, res: Response) => {
  try {
    const { uid } = req.params as { uid: string };
    if (!uid) return res.status(400).json({ success: false, message: "uid is required" });
    const data = await technician.getWorkerOnboarding(uid);
    return res.json({ success: true, data: toCamel(data) });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || "Failed to get onboarding" });
  }
};

export const saveOnboardingStep = async (req: Request, res: Response) => {
  try {
    const { uid } = req.params as { uid: string };
    if (!uid) return res.status(400).json({ success: false, message: "uid is required" });
    const { stepKey, ...data } = req.body;
    if (!stepKey) return res.status(400).json({ success: false, message: "stepKey is required" });
    const result = await technician.saveWorkerOnboardingStep(uid, stepKey, data);
    return res.json({ ...result, success: true });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || "Failed to save onboarding step" });
  }
};

export const submitOnboarding = async (req: Request, res: Response) => {
  try {
    const { uid } = req.params as { uid: string };
    if (!uid) return res.status(400).json({ success: false, message: "uid is required" });
    const result = await technician.submitWorkerOnboarding(uid, req.body);
    return res.json({ success: true, ...result });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || "Failed to submit onboarding" });
  }
};

// ---------------------------------------------------------------------------
// Review Status
// ---------------------------------------------------------------------------

export const getReviewStatus = async (req: Request, res: Response) => {
  try {
    const { uid } = req.params as { uid: string };
    if (!uid) return res.status(400).json({ success: false, message: "uid is required" });
    const data = await technician.getWorkerReviewStatus(uid);
    return res.json({ success: true, data });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || "Failed to get review status" });
  }
};

export const submitForReview = async (req: Request, res: Response) => {
  try {
    const { uid } = req.params as { uid: string };
    if (!uid) return res.status(400).json({ success: false, message: "uid is required" });
    const result = await technician.submitWorkerForReview(uid);
    return res.json({ success: true, ...result });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || "Failed to submit for review" });
  }
};

// ---------------------------------------------------------------------------
// Notification Preferences
// ---------------------------------------------------------------------------

export const getNotificationPreferences = async (req: Request, res: Response) => {
  try {
    const { uid } = req.params as { uid: string };
    if (!uid) return res.status(400).json({ success: false, message: "uid is required" });
    const data = await technician.getWorkerNotificationPrefs(uid);
    return res.json({ success: true, data: toCamel(data) });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || "Failed to get notification preferences" });
  }
};

export const saveNotificationPreferences = async (req: Request, res: Response) => {
  try {
    const { uid } = req.params as { uid: string };
    if (!uid) return res.status(400).json({ success: false, message: "uid is required" });
    const result = await technician.saveWorkerNotificationPrefs(uid, req.body);
    return res.json({ ...result, success: true });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || "Failed to save notification preferences" });
  }
};