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

export function adminError(
  res: Response,
  httpStatus: number,
  code: AdminErrorCode,
  message: string,
  fieldErrors?: Record<string, string[]>,
): Response {
  const requestId = randomUUID();
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
