import { Request, Response } from "express";
import * as technician from "../services/technicianService";


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

    return res.json({
      success: true,
      workers,
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
      worker,
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
    const { uid, latitude, longitude, is_online } = req.body;

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

    if (is_online === undefined) {
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
      is_online: Boolean(is_online),
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
      location,
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch worker location",
    });
  }
};
