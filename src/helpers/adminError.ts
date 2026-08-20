import { Response } from 'express';
import { randomUUID } from 'crypto';

export type AdminErrorCode =
  | 'SERVER_ERROR'
  | 'NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'CONFLICT'
  | 'BUSINESS_RULE'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'RATE_LIMITED';

export interface AdminErrorEnvelope {
  status: 'error';
  error: {
    code: AdminErrorCode;
    message: string;
    kind: string;
    requestId: string;
    fieldErrors?: Record<string, string[]>;
  };
}

function codeToKind(code: AdminErrorCode): string {
  const map: Record<AdminErrorCode, string> = {
    SERVER_ERROR:     'server',
    NOT_FOUND:        'not_found',
    VALIDATION_ERROR: 'validation',
    CONFLICT:         'conflict',
    BUSINESS_RULE:    'business_rule',
    UNAUTHORIZED:     'unauthenticated',
    FORBIDDEN:        'forbidden',
    RATE_LIMITED:     'rate_limited',
  };
  return map[code] ?? 'unknown';
}

/**
 * The id an admin error reports, and why it is not a fresh one.
 *
 * This helper used to do `randomUUID()` unconditionally. It has no `req` — the
 * signature takes only `res` — so minting one looked like the only option.
 *
 * It was worse than no id at all. `correlationMiddleware` runs `app.use`d ahead
 * of every router and stamps the real correlation id on the response; the
 * structured request log emits THAT id, `auditFire` records THAT id in
 * `admin_audit_events.request_id`, and this function overwrote it a moment
 * before the body was sent. So an operator reading an id off a failed admin
 * screen and searching for it found nothing — not because the log was missing,
 * but because they were given a number that appears nowhere else in the system.
 *
 * TAB 09 calls the request id "a token with no lock". On the admin tree it was
 * a token with a lock that could never open, and nothing said so.
 *
 * The id is therefore read back off the response, where the middleware already
 * put it. No call site changes — and there are a great many of them across 251
 * admin operations, which is exactly why the fix had to not need them.
 *
 * `randomUUID()` survives as the fallback for a response that somehow never met
 * the middleware. That is not reachable through the mounted app; it is reachable
 * from a unit test constructing a bare `res`, and returning `undefined` there
 * would put the string "undefined" in an error envelope.
 */
function correlationIdOf(res: Response): string {
  /**
   * Defensive about `getHeader` existing, and that is not a test
   * accommodation.
   *
   * The first version called `res.getHeader(...)` directly and threw
   * `TypeError: res.getHeader is not a function` against a response double that
   * only implemented `setHeader`. The consequence is the point: this function
   * runs while BUILDING AN ERROR RESPONSE, so throwing here does not produce a
   * worse error message — it replaces a clean 403 with an unhandled exception.
   * `tests/authz-negative` turned 148 assertions from `403` into `0`.
   *
   * A formatter on the failure path must not be able to fail. Reading a header
   * is never worth a crash, so an absent accessor falls through to the same
   * branch as an absent header.
   */
  try {
    const stamped =
      typeof (res as { getHeader?: unknown }).getHeader === 'function'
        ? res.getHeader('x-request-id')
        : undefined;
    if (typeof stamped === 'string' && stamped.length > 0 && stamped !== 'unknown') {
      return stamped;
    }
  } catch {
    // Same answer as "no header": mint one below.
  }
  return randomUUID();
}

export function adminError(
  res: Response,
  httpStatus: number,
  code: AdminErrorCode,
  message: string,
  fieldErrors?: Record<string, string[]>,
): Response {
  const requestId = correlationIdOf(res);
  res.setHeader('x-request-id', requestId);

  const body: AdminErrorEnvelope = {
    status: 'error',
    error: { code, message, kind: codeToKind(code), requestId },
  };
  if (fieldErrors) body.error.fieldErrors = fieldErrors;

  return res.status(httpStatus).json(body);
}

export function adminServerError(res: Response, err: unknown): Response {
  const message = (err as any)?.message ?? 'An unexpected error occurred';
  console.error('[Admin] Server error:', err);
  return adminError(res, 500, 'SERVER_ERROR', message);
}

export function adminNotFound(res: Response, entity: string): Response {
  return adminError(res, 404, 'NOT_FOUND', `${entity} not found`);
}

/**
 * A refusal on policy grounds, not on identity grounds.
 *
 * 403, not 401: the caller is authenticated and holds the permission. What they
 * may not do is this particular act on this particular object — approving a
 * refund they themselves requested, for instance. Reporting that as 500 would
 * file a working control as an outage, and reporting it as 400 would invite a
 * retry with different arguments.
 */
export function adminForbidden(res: Response, message: string): Response {
  return adminError(res, 403, 'FORBIDDEN', message);
}

export function adminConflict(res: Response, message: string): Response {
  return adminError(res, 409, 'CONFLICT', message);
}

export function adminValidationError(res: Response, message: string, fieldErrors?: Record<string, string[]>): Response {
  return adminError(res, 422, 'VALIDATION_ERROR', message, fieldErrors);
}

export function adminBadRequest(res: Response, message: string): Response {
  return adminError(res, 400, 'BUSINESS_RULE', message);
}
