import { Request, Response } from "express";
import { successMessage, errorMessage, status } from "../helpers/status";
import * as serviceService from "../services/serviceService";
import { toCamel } from "../helpers/idGenerator";

export const listServices = async (req: Request, res: Response) => {
  try {
    console.log("Getting all services...");
    const dbResponse = await serviceService.getAllServices();
    successMessage.data = dbResponse;
    res.status(status.success).send(successMessage);
  } catch (error) {
    errorMessage.error = "" + error;
    res.status(status.error).send(errorMessage);
  }
};

export const listLevel2 = async (req: Request, res: Response) => {
  try {
    const { serviceId } = req.params;
    const level2 = await serviceService.getLevel2List(Number(serviceId));
    successMessage.data = level2;
    res.status(status.success).send(successMessage);
  } catch (error) {
    errorMessage.error = "" + error;
    res.status(status.error).send(errorMessage);
  }
};

export const listOptionsWithAddons = async (req: Request, res: Response) => {
  try {
    const { serviceId } = req.params;
    const options = await serviceService.getOptionsWithAddons(Number(serviceId));
    successMessage.data = options;
    res.status(status.success).send(successMessage);
  } catch (error) {
    errorMessage.error = "" + error;
    res.status(status.error).send(errorMessage);
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

    if (!date)
      return res.status(400).json({ success: false, message: "date is required" });

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

    res.json({ success: true, slot });
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


