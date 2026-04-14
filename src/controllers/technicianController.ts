import { Request, Response } from "express";
import * as technician from "../services/technicianService";
import { toCamel } from "../helpers/idGenerator";

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

    return res.json({
      success: true,
      worker: toCamel(worker) ,
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

    if (!bookingId || !workerUid) {
      return res.status(400).json({
        success: false,
        message: "bookingId and workerUid are required",
      });
    }

    const result = await technician.startJob(bookingId, workerUid);

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