import { Request, Response } from "express";
import { status, buildSuccess, sendFailure } from "../helpers/status";
import * as serviceService from "../services/serviceService";
import { toCamel } from "../helpers/idGenerator";
import { transformServiceCatalog } from "../services/serviceService";

export const listServices = async (req: Request, res: Response) => {
  try {
    const dbResponse = await serviceService.getAllServices();
    res.status(status.success).send(buildSuccess(dbResponse));
  } catch (error) {
    sendFailure(res, 'serviceController.handler', error);
  }
};

export const listLevel2 = async (req: Request, res: Response) => {
  try {
    const { serviceId } = req.params;
    const level2 = await serviceService.getLevel2List(Number(serviceId));
    res.status(status.success).send(buildSuccess(level2));
  } catch (error) {
    sendFailure(res, 'serviceController.handler', error);
  }
};

export const listOptionsWithAddons = async (req: Request, res: Response) => {
  try {
    const { serviceId } = req.params;
    const options = await serviceService.getOptionsWithAddons(Number(serviceId));
    res.status(status.success).send(buildSuccess(options));
  } catch (error) {
    sendFailure(res, 'serviceController.handler', error);
  }
};

export const listBranches = async (req: Request, res: Response) => {
  try {
    const serviceId = Number(req.params.serviceId);
    const branches = await serviceService.getBranchesByService(serviceId);

    res.json({ success: true, branches });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const listAvailableSlots = async (req: Request, res: Response) => {
  try {
    const branchId = Number(req.params.branchId);
    const date = req.query.date?.toString();

    if (!Number.isSafeInteger(branchId) || branchId <= 0)
      return res.status(400).json({ success: false, message: "A valid branch is required" });
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date))
      return res.status(400).json({ success: false, message: "date must use YYYY-MM-DD" });
    const [year, month, day] = date.split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day)
      return res.status(400).json({ success: false, message: "date must be a real calendar date" });

    const slots = await serviceService.getAvailableSlots(branchId, date);
    const toCamelRows = (rows: any[]) => rows.map(toCamel);
    res.json({ success: true, slots: toCamelRows(slots) });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const createSlot = async (req: Request, res: Response) => {
  try {
    const { branchId, slotTime, maxCapacity } = req.body;

    const slot = await serviceService.createSlot(
      branchId,
      slotTime,
      maxCapacity
    );

    res.json({ success: true, slot: toCamel(slot) });
  } catch (err: any) {
    res.status(400).json({ success: false, message: err.message });
  }
};

export const create = async (req: Request, res: Response) => {
  try {
    const serviceId = Number(req.params.serviceId);
    const { centerLat, centerLon, radiusKm, isActive } = req.body;

    if (centerLat == null || centerLon == null || radiusKm == null) {
      return res.status(400).json({ success: false, message: "centerLat, centerLon, radiusKm required" });
    }

    const row = await serviceService.createCoverageGeo({
      service_id: serviceId,
      center_lat: Number(centerLat),
      center_lon: Number(centerLon),
      radius_km: Number(radiusKm),
      is_active: isActive == null ? true : Boolean(isActive),
    });

    res.json({ success: true, coverage: toCamel(row) });
  } catch (e: any) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const list = async (req: Request, res: Response) => {
  try {
    const serviceId = Number(req.params.serviceId);
    const rows = await serviceService.listCoverageGeoByService(serviceId);
    const toCamelRows = (rows: any[]) => rows.map(toCamel);
    res.json({ success: true, coverage: toCamelRows(rows) });
  } catch (e: any) {
    res.status(500).json({ success: false, message: e.message });
  }
};

export const check = async (req: Request, res: Response) => {
  try {
    const serviceId = Number(req.params.serviceId);
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);

    if (Number.isNaN(lat) || Number.isNaN(lon)) {
      return res.status(400).json({ success: false, message: "lat and lon required" });
    }

    const result = await serviceService.checkCoverageGeo(serviceId, lat, lon);
    res.json({ success: true, ...result });
  } catch (e: any) {
    res.status(500).json({ success: false, message: e.message });
  }
};

export const createService = async (req: Request, res: Response) => {
  try {
    const result = await serviceService.createFullService(req.body);
    res.status(201).json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to create service",
    });
  }
};

export const updateService = async (req: Request, res: Response) => {
  try {
    const serviceId = Number(req.params.serviceId);

    const result = await serviceService.updateFullService(serviceId, req.body);

    res.json(result);
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to update service",
    });
  }
};

export const forceDeleteService = async (req: Request, res: Response) => {
  try {
    const serviceId = Number(req.params.serviceId);

    const result = await serviceService.hardDeleteService(serviceId);

    res.json(result);
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to delete service",
    });
  }
};


export const listServicesSimple = async (_req: Request, res: Response) => {
  try {
    const services = await serviceService.getServicesSimpleList();
    res.status(status.success).send(buildSuccess(services));
  } catch (error) {
    sendFailure(res, 'serviceController.handler', error);
  }
};

export const getFullServiceCatalog = async (req: Request, res: Response) => {
  try {
    const result = await serviceService.getFullServiceCatalog();
    res.json({ success: true, services: transformServiceCatalog(result) });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to list services",
    });
  }
}
