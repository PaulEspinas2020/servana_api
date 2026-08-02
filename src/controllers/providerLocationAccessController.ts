import { Request, Response } from "express";
import * as technician from "../services/technicianService";
import {
  assertBookingAccess,
  sendBookingAccessError,
} from "../services/bookingAccessService";

/**
 * Authenticated successors to the unauthenticated legacy worker-lookup routes.
 *
 * The legacy family (`technician.routes.ts`) carries no authentication and takes
 * the subject from the URL, so today anyone can call
 * `GET /api/workers/location/:uid` and follow any provider's live position, or
 * `GET /api/workers/:workerId/schedule` and read their whole week.
 *
 * These replacements do not take a subject from the caller at all:
 *
 *  - Provider schedule is *self*-scoped — you get your own, derived from the token.
 *  - Provider location is *booking*-scoped — a customer asks "where is the
 *    provider on MY booking", and `assertBookingAccess` decides. There is no way
 *    to phrase a request for an arbitrary provider's whereabouts.
 *
 * That last shape matters: the customer genuinely needs live tracking, so the
 * answer could not be "deny customers". Re-framing the question around a booking
 * the caller already owns gives them exactly what they need and nothing else.
 *
 * The legacy routes remain untouched so the live mobile apps keep working
 * (§2 — no unnecessary protected release). See docs/WORKER_ROUTE_MIGRATION.md
 * for the retirement plan.
 */

/** GET /api/worker/schedule — the authenticated provider's own schedule. */
export const getMySchedule = async (req: Request, res: Response) => {
  try {
    const uid = (req as any).user?.uid as string | undefined;
    if (!uid) {
      return res.status(401).json({
        success: false,
        code: "UNAUTHENTICATED",
        message: "Authentication is required",
      });
    }

    const schedule = await technician.getWorkerSchedule(uid);
    return res.json({ success: true, schedule });
  } catch (e: any) {
    return res.status(500).json({
      success: false,
      message: e.message || "Failed to fetch schedule",
    });
  }
};

/**
 * GET /api/booking/:bookingId/provider-location
 *
 * Live position of the provider assigned to this booking, for a caller who is
 * entitled to the booking (its customer, its active provider, or an admin).
 */
export const getBookingProviderLocation = async (req: Request, res: Response) => {
  try {
    const bookingId = Number(req.params.bookingId);
    if (!Number.isInteger(bookingId) || bookingId <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid booking id" });
    }

    await assertBookingAccess(bookingId, (req as any).user?.uid);

    const workerUid = await technician.getAssignedWorkerUid(bookingId);
    if (!workerUid) {
      // No provider assigned yet. Not an error — the customer is watching a
      // booking that has not been matched, which is a normal state.
      return res.json({ success: true, assigned: false, location: null });
    }

    const location = await technician.getWorkerLocation(workerUid);
    if (!location) {
      // Assigned, but the provider has not reported a position. Distinguished
      // from "not assigned" so the client can say something truthful.
      return res.json({ success: true, assigned: true, location: null });
    }

    // `location` is the documented field. `data` is an additive alias carrying
    // the SAME document, because the shipped ServanaClient only unwraps a GPS
    // payload from the root or from `data`
    // (geo_position_snapshot.dart fromApiMap: `map['loc'] != null ? map :
    // map['data'] ?? map`). It never looks under `location`, so fromApiMap
    // returned null and live tracking never plotted the provider — the customer
    // watched an empty map for the whole journey.
    //
    // Aliasing here fixes the shipped app with no release. The client is being
    // taught to read `location` too, so this alias can be dropped once that
    // build is out; until then removing it silently breaks tracking again.
    return res.json({ success: true, assigned: true, location, data: location });
  } catch (e: any) {
    if (sendBookingAccessError(res, e)) return;
    return res.status(500).json({
      success: false,
      message: e.message || "Failed to fetch provider location",
    });
  }
};
