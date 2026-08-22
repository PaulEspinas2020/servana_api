/**
 * v1 provider REMAINDER (TAB 10) — alerts, calendar, performance, photo,
 * schedule, catalog offerings, the earnings transaction detail, and account
 * deletion.
 *
 * ## Why these were left until last, and what measuring them found
 *
 * The Master Command groups them as "individually small", with one exception it
 * calls the important one: the chat attachment upload, which it says keeps the
 * whole messaging surface on legacy. Measured at this HEAD that route already
 * has a canonical successor — `conversations.attachments.create` — so messaging
 * could already migrate in full, and the item the book ranks first was done.
 *
 * The gap it did NOT name is `GET /api/provider/earnings/:id`. The book records
 * `/api/provider/earnings` — the LIST — as the missing per-booking ledger, but
 * that path already delegates to the same canonical service the v1 list uses.
 * The single-transaction DETAIL is what had no successor.
 *
 * ## Account deletion records an INTENTION
 *
 * `POST /provider/account/deletion-request`, and the name is the finding. The
 * legacy path is `/account/delete`, which reads as an erasure and is not one:
 * it writes a status, a reason and a timestamp, refuses while the provider
 * holds live work, and erases nothing. Publishing it under a name that promised
 * more than it does would have been the least honest thing in this programme.
 */

import { Request, Response } from 'express';
import { ok, created, sendCaught } from '../envelope';
import { ApiError, V1ErrorCode } from '../errors';
import { V1Handlers } from '../types';
import * as provider from '../../../controllers/providerController';
import * as locationAccess from '../../../controllers/providerLocationAccessController';
import * as providerCatalog from '../../../controllers/providerCatalogController';
import { getCalendar as providerCalendar_getCalendar } from '../../../controllers/providerCalendarController';
import * as earnings from '../../../services/finance/providerEarningsService';

const uidOf = (req: Request): string => {
  const uid = (req as any).user?.uid as string | undefined;
  if (!uid) throw new ApiError('UNAUTHENTICATED', 'Authentication is required.');
  return uid;
};

const bodyOf = (req: Request): Record<string, unknown> =>
  (req.body ?? {}) as Record<string, unknown>;

const CODE: Record<string, V1ErrorCode> = {
  EARNINGS_NOT_FOUND: 'NOT_FOUND',
  ALERT_NOT_FOUND: 'NOT_FOUND',
  PHOTO_INVALID: 'VALIDATION_FAILED',
  ACCOUNT_HAS_ACTIVE_BOOKINGS: 'CONFLICT',
};

const STATUS_CODE: Record<number, V1ErrorCode> = {
  400: 'VALIDATION_FAILED', 403: 'FORBIDDEN', 404: 'NOT_FOUND',
  409: 'CONFLICT', 415: 'UNSUPPORTED_MEDIA_TYPE', 422: 'VALIDATION_FAILED',
};

const asApiError = (error: unknown): unknown => {
  const c = error as { code?: string; message?: string; statusCode?: number } | null;
  if (c?.code && CODE[c.code]) return new ApiError(CODE[c.code], c.message);
  if (c?.statusCode && STATUS_CODE[c.statusCode]) return new ApiError(STATUS_CODE[c.statusCode], c.message);
  return error;
};

/**
 * Runs a legacy Express controller and republishes its body in the v1 envelope.
 *
 * ## Why an adapter and not a rewrite
 *
 * Six of these operations are thin reads whose whole content is a query and a
 * projection that already exist inside a controller. Lifting each into a service
 * would be the right shape and would also be six opportunities to change a
 * projection by accident, on routes whose only requirement is that the canonical
 * answer equals the legacy one.
 *
 * So the controller RUNS, and this captures what it sent. The projection is
 * therefore identical by construction rather than by review — the same argument
 * TAB 02 made about the job card, where the executed comparison proved what
 * reading the imports could not.
 *
 * The legacy body is `{ status, data }`; only `data` is republished, because the
 * v1 envelope carries its own success signal and a second, independently
 * settable one is how `{ success: true }` ends up on a 500.
 */
const runLegacy = async (
  controller: (req: Request, res: Response) => Promise<unknown> | unknown,
  req: Request,
  res: Response,
): Promise<{ status: number; data: unknown; message?: string }> => {
  const captured: { status: number; body: any } = { status: 200, body: undefined };
  const shim: any = {
    status(code: number) { captured.status = code; return shim; },
    json(body: any) { captured.body = body; return shim; },
    send(body: any) { captured.body = body; return shim; },
    set() { return shim; },
    setHeader() { return shim; },
    getHeader() { return undefined; },
    headersSent: false,
  };
  await controller(req, shim as Response);

  const body = captured.body ?? {};
  if (captured.status >= 400) {
    throw Object.assign(new Error(String(body.message ?? 'Request failed.')), {
      statusCode: captured.status,
      code: body.code,
    });
  }
  return { status: captured.status, data: body.data ?? body, message: body.message };
};

const passthrough = (
  id: string,
  controller: (req: Request, res: Response) => Promise<unknown> | unknown,
  opts: { created?: boolean } = {},
) => async (req: Request, res: Response) => {
  try {
    uidOf(req);
    const result = await runLegacy(controller, req, res);
    return opts.created
      ? created(res, req, result.data)
      : ok(res, req, result.data);
  } catch (error) {
    return sendCaught(res, req, id, asApiError(error));
  }
};

export const handlers: V1Handlers = {
  /**
   * One earning transaction in full.
   *
   * THE gap this TAB actually found. `capability: 'canViewEarnings'` is declared
   * on the contract entry because the legacy chain carries it — a provider whose
   * application is not approved holds the role and must not read earnings.
   */
  'provider.earnings.transaction': async (req: Request, res: Response) => {
    try {
      const uid = uidOf(req);
      const id = Number(req.params.transactionId);
      if (!Number.isSafeInteger(id) || id <= 0) {
        throw ApiError.validation('transactionId must be a positive integer.');
      }
      const transaction = await earnings.getEarningTransaction(uid, id);
      if (!transaction) throw new ApiError('NOT_FOUND', 'Earning not found.');
      return ok(res, req, transaction);
    } catch (error) {
      return sendCaught(res, req, 'provider.earnings.transaction', asApiError(error));
    }
  },

  'provider.alerts.list': passthrough('provider.alerts.list', provider.getProviderAlerts),

  /**
   * Dismiss one alert.
   *
   * The legacy parameter is `:key` and the canonical one is `:alertKey`; the
   * value is identical, so the request is forwarded with both names present
   * rather than the controller being edited to know about a second one.
   */
  'provider.alerts.dismiss': async (req: Request, res: Response) => {
    try {
      uidOf(req);
      const alertKey = String(req.params.alertKey ?? '').trim();
      if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(alertKey)) {
        throw new ApiError('NOT_FOUND', 'Alert not found.');
      }
      const forwarded = { ...req, params: { ...req.params, key: alertKey } } as unknown as Request;
      const result = await runLegacy(provider.dismissAlert, forwarded, res);
      return ok(res, req, result.data ?? { alertKey, dismissed: true });
    } catch (error) {
      return sendCaught(res, req, 'provider.alerts.dismiss', asApiError(error));
    }
  },

  /**
   * Bookings and time off as a calendar. A READ that must stay a read.
   *
   * Routed through the adapter rather than calling `getProviderCalendar`
   * directly, because the controller owns the query PARSING — the start, end and
   * eventTypes validation — and reimplementing that here would be a second
   * parser to keep in step with the first.
   */
  'provider.calendar.get': passthrough('provider.calendar.get', providerCalendar_getCalendar),

  'provider.performance.get': passthrough(
    'provider.performance.get', provider.getProviderPerformanceMetrics,
  ),

  'provider.profilePhoto.upload': passthrough(
    'provider.profilePhoto.upload', provider.uploadWorkerProfilePhoto, { created: true },
  ),

  'provider.profilePhoto.delete': passthrough(
    'provider.profilePhoto.delete', provider.deleteWorkerProfilePhoto,
  ),

  'provider.schedule.get': passthrough('provider.schedule.get', locationAccess.getMySchedule),

  'provider.catalog.offerings': passthrough(
    'provider.catalog.offerings', providerCatalog.getOfferingsForProvider,
  ),

  /**
   * Request permanent deletion of the account.
   *
   * Records an INTENTION. Nothing is erased by this call, which is why the
   * canonical path is `deletion-request` rather than `delete` — a name that
   * promised erasure would be the least honest thing in this contract.
   *
   * Refused while the provider holds live work: a provider cannot delete their
   * way out of a booking a customer is waiting for.
   */
  'provider.account.requestDeletion': async (req: Request, res: Response) => {
    try {
      uidOf(req);
      const body = bodyOf(req);
      const forwarded = {
        ...req, body: { reason: body.reason ?? null },
      } as unknown as Request;
      const result = await runLegacy(provider.requestProviderDeletion, forwarded, res);
      return ok(res, req, {
        status: 'requested',
        // Republished from the service rather than restated here, so the two
        // cannot come to describe different timelines.
        message: result.message ?? null,
      });
    } catch (error) {
      return sendCaught(res, req, 'provider.account.requestDeletion', asApiError(error));
    }
  },
};
