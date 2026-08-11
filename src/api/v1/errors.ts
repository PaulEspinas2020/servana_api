/**
 * Canonical v1 error codes.
 *
 * ## Why a closed enum and not free-text messages
 *
 * The backend serves five clients. Today each one branches on a different
 * signal: ServanaClient reads `body['error'] as String`, ServanaWorker reads
 * `data['message'] ?? data['error']`, the customer web portal branches on
 * `error.recovery`, and the admin portal branches on HTTP status. A message is
 * not a contract — it is copy, and copy changes. A code is a contract.
 *
 * Every v1 failure carries a code from this list. Clients branch on the code;
 * the message is for humans and may be reworded without a client release.
 *
 * ## Adding a code
 *
 * Codes are append-only. Renaming one is a breaking change to every client that
 * branches on it, so it is treated exactly like renaming a route (§4). The
 * contract test in `tests/v1-contract.test.ts` asserts that every code declared
 * on a contract entry exists here, so a typo fails the gate rather than
 * reaching a client as an unhandled branch.
 */

/** HTTP status for each canonical code. One code, one status, always. */
export const V1_ERROR_STATUS = {
  // ── Authentication and authorization ───────────────────────────────────────
  UNAUTHENTICATED: 401,
  TOKEN_EXPIRED: 401,
  TOKEN_REVOKED: 401,
  FORBIDDEN: 403,
  ROLE_REQUIRED: 403,
  PERMISSION_REQUIRED: 403,

  // ── Request shape ──────────────────────────────────────────────────────────
  VALIDATION_FAILED: 400,
  UNSUPPORTED_MEDIA_TYPE: 415,

  // ── Idempotency and concurrency (§17, §18) ─────────────────────────────────
  IDEMPOTENCY_KEY_INVALID: 400,
  IDEMPOTENCY_KEY_REUSED: 409,
  STALE_STATE: 409,

  // ── Generic resource outcomes ──────────────────────────────────────────────
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,

  // ── Catalog ────────────────────────────────────────────────────────────────
  CATALOG_SERVICE_NOT_FOUND: 404,

  // ── Bookings ───────────────────────────────────────────────────────────────
  BOOKING_NOT_FOUND: 404,
  BOOKING_ACCESS_DENIED: 403,

  // ── Notifications ──────────────────────────────────────────────────────────
  NOTIFICATION_NOT_FOUND: 404,
  NOTIFICATION_NOT_ACTIONABLE: 409,

  // ── Provider ───────────────────────────────────────────────────────────────
  PROVIDER_ROLE_REQUIRED: 403,
} as const;

export type V1ErrorCode = keyof typeof V1_ERROR_STATUS;

export const V1_ERROR_CODES = Object.keys(V1_ERROR_STATUS) as V1ErrorCode[];

export const isV1ErrorCode = (value: string): value is V1ErrorCode =>
  Object.prototype.hasOwnProperty.call(V1_ERROR_STATUS, value);

/**
 * A failure a client is allowed to see.
 *
 * Anything thrown that is NOT an ApiError is treated as INTERNAL: the real
 * exception goes to the log with the request id and the caller gets a generic
 * sentence. That is the §21 rule made structural — a driver message can only
 * reach a client if somebody deliberately wraps it in an ApiError, which is
 * visible in review.
 */
export class ApiError extends Error {
  readonly code: V1ErrorCode;
  readonly httpStatus: number;
  readonly details?: unknown;

  constructor(code: V1ErrorCode, message?: string, details?: unknown) {
    super(message ?? code);
    this.name = 'ApiError';
    this.code = code;
    this.httpStatus = V1_ERROR_STATUS[code];
    this.details = details;
  }

  static notFound(code: V1ErrorCode = 'NOT_FOUND', message?: string): ApiError {
    return new ApiError(code, message);
  }

  static validation(message: string, details?: unknown): ApiError {
    return new ApiError('VALIDATION_FAILED', message, details);
  }
}
