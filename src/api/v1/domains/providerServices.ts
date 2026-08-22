/**
 * v1 provider SERVICES and SERVICE APPLICATIONS.
 *
 * The surface a provider uses to manage their own eligibility to earn: what
 * they are approved for, what they have applied for, and whether a service is
 * currently offered to them.
 *
 * ## Why this is a module of its own
 *
 * `GET /api/v1/provider/services` already lived in the account domain, because
 * a service list looked like part of a profile. It is not. Everything that
 * CHANGES the list — applying, resubmitting, withdrawing, pausing,
 * reactivating — is a decision about matching, and matching is what these
 * routes feed. Keeping the reads next to the writes is what makes it obvious
 * that a pause and an approval act on the same row.
 *
 * ## The identity, and the one that is NOT here
 *
 * Every operation takes the provider uid from the token. `serviceId` and
 * `applicationId` are resources, not identities: each service call scopes on
 * `employee_uid = $1` inside the SQL and each application call on
 * `worker_uid = $2`, so a resource belonging to somebody else is a 404 rather
 * than a target. No route accepts a provider uid from a path, query or body.
 *
 * ## `employee_services.service_id` is a FAMILY id
 *
 * Worth stating where the reads are, because two other readers got it wrong.
 * Migration 024 renamed the coarse families to `service_families` and the 95
 * canonical bookable services to `services`; `employee_services.service_id` was
 * never remapped. Anything resolving a name for one of these rows joins
 * `service_families`, and migration 029 is the authority — it joins
 * `services s ON s.legacy_service_family_id = es.service_id`, not on `s.id`.
 */

import { Request, Response } from 'express';
import * as applications from '../../../services/serviceApplicationService';
import * as technicianService from '../../../services/technicianService';
import { ok, sendCaught } from '../envelope';
import { ApiError } from '../errors';
import { V1ErrorCode } from '../errors';
import { V1Handlers } from '../types';

const uidOf = (req: Request): string => {
  const uid = (req as any).user?.uid as string | undefined;
  if (!uid) throw new ApiError('UNAUTHENTICATED', 'Authentication is required.');
  return uid;
};

/**
 * A positive integer service id.
 *
 * Refused BEFORE the query rather than passed through as NaN, which Postgres
 * would reject with a type error that §21 forbids putting on the wire.
 */
const serviceIdOf = (req: Request): number => {
  const id = Number(req.params.serviceId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw ApiError.validation('serviceId must be a positive integer.');
  }
  return id;
};

const applicationIdOf = (req: Request): string => {
  const raw = String(req.params.applicationId ?? '').trim();
  // Bounded and character-classed before it reaches a query. Ids are uuid-ish;
  // anything outside this shape is a probe rather than a typo.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(raw)) {
    throw new ApiError('NOT_FOUND', 'Application not found.');
  }
  return raw;
};

const bodyOf = (req: Request): Record<string, unknown> =>
  (req.body ?? {}) as Record<string, unknown>;

/**
 * Domain refusal → canonical code. Renaming only; no policy is re-decided here.
 *
 * The two service-state codes are kept DISTINCT from a bare CONFLICT on
 * purpose. The commonest way to reach `SERVICE_ALREADY_PAUSED` is a retry after
 * a request that committed and then timed out, and a client that cannot tell
 * that from a real conflict shows an error for an operation that worked.
 */
const CODE: Record<string, V1ErrorCode> = {
  SERVICE_NOT_FOUND: 'NOT_FOUND',
  SERVICE_ALREADY_PAUSED: 'PROVIDER_SERVICE_ALREADY_PAUSED',
  SERVICE_NOT_PAUSED: 'PROVIDER_SERVICE_NOT_PAUSED',
  SERVICE_APPLICATION_NOT_FOUND: 'NOT_FOUND',
  INVALID_IDEMPOTENCY_KEY: 'VALIDATION_FAILED',
  // The application carries a `version`; a resubmit naming a stale one is a
  // concurrency refusal, not a validation error, and STALE_STATE is the code a
  // client already reloads on.
  VERSION_CONFLICT: 'STALE_STATE',
  APPLICATION_VERSION_CONFLICT: 'STALE_STATE',
};

/** Statuses for services that throw a status and no code. */
const STATUS_CODE: Record<number, V1ErrorCode> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'VALIDATION_FAILED',
  429: 'RATE_LIMITED',
};

const asApiError = (error: unknown): unknown => {
  const candidate = error as { code?: string; message?: string; statusCode?: number } | null;
  if (candidate?.code && CODE[candidate.code]) {
    return new ApiError(CODE[candidate.code], candidate.message);
  }
  if (candidate?.statusCode && STATUS_CODE[candidate.statusCode]) {
    return new ApiError(STATUS_CODE[candidate.statusCode], candidate.message);
  }
  return error;
};

export const handlers: V1Handlers = {
  /**
   * Everything about the caller's services in one read: what they hold, its
   * operational state, why it is or is not offered, and every application.
   *
   * NOT subsumed by `provider.services.list`, which returns four fields per row
   * from a different table. This one carries the readiness verdict and its
   * reasons, the pause reason, the actions the server will honour, and the
   * applications — the whole screen. Both are published because a client
   * rendering a chip does not need the fan-out, and a client rendering the
   * management screen cannot build it from four fields.
   */
  'provider.services.overview': async (req: Request, res: Response) => {
    try {
      return ok(res, req, await applications.getProviderServicesOverview(uidOf(req)));
    } catch (error) {
      return sendCaught(res, req, 'provider.services.overview', asApiError(error));
    }
  },

  /**
   * May this provider apply for this service, and if not, why?
   *
   * Read before offering the button, so the refusal names a reason instead of
   * arriving as a bare failure after the provider has committed to the action.
   */
  'provider.services.eligibility': async (req: Request, res: Response) => {
    try {
      return ok(res, req, await applications.evaluateApplicationEligibility(uidOf(req), serviceIdOf(req)));
    } catch (error) {
      return sendCaught(res, req, 'provider.services.eligibility', asApiError(error));
    }
  },

  /**
   * Step back from a service without giving it up.
   *
   * The canonical capability table is updated alongside `employee_services`,
   * because matching reads the canonical one — a pause that touched only the
   * legacy table would leave a provider still being offered work they have
   * explicitly stepped back from.
   */
  'provider.services.pause': async (req: Request, res: Response) => {
    try {
      const raw = bodyOf(req).reason;
      const reason = typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
      return ok(res, req, await technicianService.pauseService(uidOf(req), serviceIdOf(req), reason));
    } catch (error) {
      return sendCaught(res, req, 'provider.services.pause', asApiError(error));
    }
  },

  /** Resume being offered work for a service that was paused. */
  'provider.services.reactivate': async (req: Request, res: Response) => {
    try {
      return ok(res, req, await technicianService.reactivateService(uidOf(req), serviceIdOf(req)));
    } catch (error) {
      return sendCaught(res, req, 'provider.services.reactivate', asApiError(error));
    }
  },

  /** Every application this provider has made, newest first. */
  'provider.serviceApplications.list': async (req: Request, res: Response) => {
    try {
      return ok(res, req, await applications.getApplicationsByWorker(uidOf(req)));
    } catch (error) {
      return sendCaught(res, req, 'provider.serviceApplications.list', asApiError(error));
    }
  },

  /** One application, scoped to the caller. Somebody else's id is a 404. */
  'provider.serviceApplications.get': async (req: Request, res: Response) => {
    try {
      return ok(res, req, await applications.getApplicationByWorker(applicationIdOf(req), uidOf(req)));
    } catch (error) {
      return sendCaught(res, req, 'provider.serviceApplications.get', asApiError(error));
    }
  },

  /**
   * Apply for a service.
   *
   * `requirementsVersion` is the version the provider was SHOWN. It travels so
   * the server can tell an application made against the current requirements
   * from one made against a set that has since changed — which is the
   * difference between approving and asking for more.
   */
  'provider.serviceApplications.create': async (req: Request, res: Response) => {
    try {
      const body = bodyOf(req);
      const serviceId = Number(body.serviceId);
      if (!Number.isSafeInteger(serviceId) || serviceId <= 0) {
        throw ApiError.validation('serviceId must be a positive integer.');
      }
      return ok(res, req, await applications.submitApplication(uidOf(req), serviceId, {
        clientRequestId: String(body.clientRequestId ?? ''),
        requirementsVersion: Number(body.requirementsVersion ?? 0),
      }));
    } catch (error) {
      return sendCaught(res, req, 'provider.serviceApplications.create', asApiError(error));
    }
  },

  /**
   * Resubmit an application that came back needing more.
   *
   * `expectedVersion` is REQUIRED and is optimistic concurrency, not decoration
   * (§18): between loading the application and resubmitting it, a reviewer may
   * have decided. Without the check a provider's resubmission would silently
   * overwrite a decision they never saw.
   */
  'provider.serviceApplications.resubmit': async (req: Request, res: Response) => {
    try {
      const body = bodyOf(req);
      const expectedVersion = Number(body.expectedVersion);
      if (!Number.isFinite(expectedVersion)) {
        throw ApiError.validation('expectedVersion is required and must be a number.');
      }
      return ok(res, req, await applications.resubmitApplication(applicationIdOf(req), uidOf(req), {
        clientRequestId: String(body.clientRequestId ?? ''),
        expectedVersion,
      }));
    } catch (error) {
      return sendCaught(res, req, 'provider.serviceApplications.resubmit', asApiError(error));
    }
  },

  /**
   * Withdraw an application.
   *
   * The eighth operation in this cluster, and one the Master Command's list of
   * seven PATHS does not mention — `service-applications/:id` carries GET and
   * DELETE on one path. A provider who can apply and cannot withdraw is stuck
   * waiting on a review they no longer want.
   */
  'provider.serviceApplications.withdraw': async (req: Request, res: Response) => {
    try {
      return ok(res, req, await applications.cancelApplication(applicationIdOf(req), uidOf(req)));
    } catch (error) {
      return sendCaught(res, req, 'provider.serviceApplications.withdraw', asApiError(error));
    }
  },
};
