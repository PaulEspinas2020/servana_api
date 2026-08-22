/**
 * v1 provider PRESENCE, LOCATION and SAFETY.
 *
 * The routes that matter when something goes wrong on a doorstep, and the ones
 * that decide whether a provider is offered work at all.
 *
 * ## Presence is bound to the PROVIDER, not to a session, a device or a job
 *
 * The mandate asks this explicitly, so it is answered here and in the contract
 * rather than left to be inferred. Operational availability is a persistent
 * property of the ACCOUNT. §27 lists what must never change it: a closed
 * browser, a closed app, a logout, an expired token, a dropped socket, a lost
 * network, a restarted device, a restarted backend, a missed heartbeat, a stale
 * location, a schedule ending, a booking completing. One provider has one
 * availability, and only an explicit act changes it.
 *
 * A second device therefore does not get a second presence, and signing out
 * does not go offline. That is deliberate: a provider who closed their app on
 * the bus is still available for the job they are travelling to.
 *
 * ## The location ping carries COORDINATES ONLY
 *
 * The legacy `/api/worker/location` accepts `isOnline` in its body and writes it
 * straight through, so a transport ping can flip presence as a side effect.
 * §27 forbids precisely that, and the canonical route declines to carry the
 * field.
 *
 * This is NOT a change to presence semantics — the legacy route is untouched and
 * still behaves exactly as it did. It is a refusal to carry the hazard forward.
 * A client on v1 changes presence through the presence operations, which is the
 * model §27 describes, and its location pings can no longer take it offline by
 * accident.
 *
 * ## Going OFFLINE survives every restriction
 *
 * `go-online` is mounted behind `requireActiveProvider` and `go-offline` is
 * NOT, and the asymmetry is load-bearing: `DENY_ALL` in the account-state
 * machine sets `canGoOffline: true` even for a denied account, because a
 * provider must never be trapped online. The contract entries mirror the legacy
 * chain exactly — `activeProvider: true` on online, absent on offline. Adding it
 * to offline would be a stricter successor that strands somebody.
 */

import { Request, Response } from 'express';
import * as availability from '../../../services/providerOperationalAvailabilityService';
import * as technicianService from '../../../services/technicianService';
import * as safety from '../../../services/providerSafetyService';
import { ok, created, sendCaught } from '../envelope';
import { ApiError, V1ErrorCode } from '../errors';
import { V1Handlers } from '../types';

const uidOf = (req: Request): string => {
  const uid = (req as any).user?.uid as string | undefined;
  if (!uid) throw new ApiError('UNAUTHENTICATED', 'Authentication is required.');
  return uid;
};

const bodyOf = (req: Request): Record<string, unknown> =>
  (req.body ?? {}) as Record<string, unknown>;

const CODE: Record<string, V1ErrorCode> = {
  SAFETY_FIELD_REQUIRED: 'VALIDATION_FAILED',
  SAFETY_FIELD_INVALID: 'VALIDATION_FAILED',
  SAFETY_STAGE_INVALID: 'VALIDATION_FAILED',
};

const asApiError = (error: unknown): unknown => {
  const candidate = error as { code?: string; message?: string; status?: number } | null;
  if (candidate?.code && CODE[candidate.code]) {
    return new ApiError(CODE[candidate.code], candidate.message);
  }
  return error;
};

/**
 * A coordinate pair, validated before it reaches storage.
 *
 * Out-of-range values are refused rather than stored: §39 forbids fabricating a
 * location, and a latitude of 999 written to a geospatial index is a location
 * nobody can correct later because nobody can tell it from a real one.
 */
const coordsOf = (body: Record<string, unknown>): { latitude: number; longitude: number } => {
  const latitude = Number(body.latitude);
  const longitude = Number(body.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw ApiError.validation('latitude and longitude are required and must be numbers.');
  }
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw ApiError.validation('latitude must be within -90..90 and longitude within -180..180.');
  }
  return { latitude, longitude };
};

export const handlers: V1Handlers = {
  /** Whether the caller is currently available, and when that was last set. */
  'provider.presence.get': async (req: Request, res: Response) => {
    try {
      const uid = uidOf(req);
      const state = await availability.getStatus(uid);
      return ok(res, req, {
        isOnline: state.availabilityStatus === 'online',
        availabilityStatus: state.availabilityStatus,
        availabilitySource: state.availabilitySource,
        changedAt: state.changedAt,
        reason: state.reason,
        version: state.version,
        updatedAt: state.updatedAt,
      });
    } catch (error) {
      return sendCaught(res, req, 'provider.presence.get', asApiError(error));
    }
  },

  /**
   * Become available for work.
   *
   * Coordinates are OPTIONAL. `setOnline` preserves an existing location and
   * only applies these when none is stored, so going online does not overwrite
   * a fresher fix with a stale one.
   */
  'provider.presence.goOnline': async (req: Request, res: Response) => {
    try {
      const uid = uidOf(req);
      const body = bodyOf(req);
      const hasCoords = body.latitude !== undefined && body.longitude !== undefined;
      await availability.setOnline(
        uid,
        'provider_explicit',
        uid,
        'provider',
        null,
        hasCoords ? coordsOf(body) : null,
      );
      return ok(res, req, { isOnline: true, source: 'provider_explicit' });
    } catch (error) {
      return sendCaught(res, req, 'provider.presence.goOnline', asApiError(error));
    }
  },

  /**
   * Stop being offered work.
   *
   * NOT behind `requireActiveProvider`, matching the legacy chain. A suspended,
   * unapproved or restricted provider must still be able to go offline — being
   * trapped online is the one presence failure with no workaround.
   */
  'provider.presence.goOffline': async (req: Request, res: Response) => {
    try {
      const uid = uidOf(req);
      await availability.setOffline(uid, 'provider_explicit', uid, 'provider', null);
      return ok(res, req, { isOnline: false, source: 'provider_explicit' });
    } catch (error) {
      return sendCaught(res, req, 'provider.presence.goOffline', asApiError(error));
    }
  },

  /**
   * Report where the provider is.
   *
   * TRANSPORT ONLY. There is no `isOnline` field, deliberately — see the module
   * header. A ping tells the platform where somebody is; it does not decide
   * whether they are working.
   */
  'provider.location.report': async (req: Request, res: Response) => {
    try {
      const uid = uidOf(req);
      const { latitude, longitude } = coordsOf(bodyOf(req));

      // Read the CURRENT presence and write it back unchanged. The storage
      // layer takes `is_online` as a required field, so passing a literal here
      // would let a location ping decide availability — the exact coupling this
      // route exists to break.
      const current = await availability.getStatus(uid);
      const isOnline = current.availabilityStatus === 'online';
      await technicianService.upsertWorkerLocation({ uid, latitude, longitude, is_online: isOnline });

      return ok(res, req, { latitude, longitude, isOnline });
    } catch (error) {
      return sendCaught(res, req, 'provider.location.report', asApiError(error));
    }
  },

  /** The emergency numbers and guidance for this market. Static, no account data. */
  'provider.safety.emergencyConfig': async (req: Request, res: Response) => {
    try {
      return ok(res, req, safety.PROVIDER_EMERGENCY_CONFIG);
    } catch (error) {
      return sendCaught(res, req, 'provider.safety.emergencyConfig', asApiError(error));
    }
  },

  /**
   * Record that the provider is safe at a stage of a job.
   *
   * Append-only and NOT deduplicated: two check-ins at one stage are two facts
   * about two moments, and the later one is the more recent evidence that
   * somebody is still safe. `none-accepted`, as a decision.
   */
  'provider.safety.checkIn': async (req: Request, res: Response) => {
    try {
      const uid = uidOf(req);
      const body = bodyOf(req);
      return created(res, req, await safety.recordCheckIn(uid, {
        bookingId: body.bookingId,
        stage: body.stage,
      }));
    } catch (error) {
      return sendCaught(res, req, 'provider.safety.checkIn', asApiError(error));
    }
  },

  /** The caller's own incidents, newest first. Never another provider's. */
  'provider.safety.incidents.list': async (req: Request, res: Response) => {
    try {
      const uid = uidOf(req);
      const raw = Number(req.query.limit);
      const limit = Number.isFinite(raw) ? Math.max(1, Math.min(100, Math.trunc(raw))) : 50;
      const incidents = await safety.listIncidents(uid, limit);
      return ok(res, req, incidents.map((doc: any) => ({
        incidentId: doc.incidentId,
        providerSafeReference: doc.providerSafeReference,
        bookingId: doc.bookingId ?? null,
        category: doc.category,
        severity: doc.severity,
        state: doc.state,
        immediateDanger: doc.immediateDanger === true,
        workStopped: doc.workStopped === true,
        reportedAt: doc.reportedAt,
        updatedAt: doc.updatedAt,
        hasUnreadUpdate: doc.hasUnreadUpdate === true,
      })));
    } catch (error) {
      return sendCaught(res, req, 'provider.safety.incidents.list', asApiError(error));
    }
  },

  /**
   * File a safety incident.
   *
   * REPLAY-SAFE, and that is the difference from the legacy route rather than an
   * accident. A repeat carrying the same `clientIncidentId` returns the ORIGINAL
   * incident with 200 instead of the legacy 409.
   *
   * The reasoning is specific to this operation: a provider whose first attempt
   * committed and then timed out on a doorstep will retry, and a 409 rendered as
   * a failure tells them their incident was never filed — on the one report
   * where believing that is most dangerous. The legacy route keeps its 409
   * because five clients read it and §4 does not permit changing that.
   */
  'provider.safety.incidents.create': async (req: Request, res: Response) => {
    try {
      const uid = uidOf(req);
      const body = bodyOf(req);
      const result = await safety.submitIncident(uid, {
        clientIncidentId: String(body.clientIncidentId ?? ''),
        category: String(body.category ?? ''),
        severity: String(body.severity ?? ''),
        description: String(body.description ?? ''),
        bookingId: body.bookingId == null ? null : String(body.bookingId),
        immediateDanger: body.immediateDanger === true,
        providerSafe: body.providerSafe === undefined ? null : body.providerSafe === true,
        workStopped: body.workStopped === true,
        emergencyServicesContacted:
          body.emergencyServicesContacted === undefined ? null : body.emergencyServicesContacted === true,
      });

      const payload = {
        incidentId: result.incidentId,
        providerSafeReference: result.providerSafeReference,
        state: result.state,
        replayed: result.replayed,
      };
      // 201 for a new report, 200 for a replay — so a client can tell them apart
      // without either being an error.
      return result.replayed ? ok(res, req, payload) : created(res, req, payload);
    } catch (error) {
      return sendCaught(res, req, 'provider.safety.incidents.create', asApiError(error));
    }
  },
};
