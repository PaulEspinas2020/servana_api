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
  //
  // One code per LEVEL of the hierarchy, deliberately. A single
  // CATALOG_NOT_FOUND would leave a client unable to tell "that subcategory is
  // gone" from "that service is gone" — which are different screens and
  // different recoveries.
  CATALOG_SERVICE_NOT_FOUND: 404,
  CATALOG_CATEGORY_NOT_FOUND: 404,
  CATALOG_SUBCATEGORY_NOT_FOUND: 404,

  // ── Bookings ───────────────────────────────────────────────────────────────
  BOOKING_NOT_FOUND: 404,
  BOOKING_ACCESS_DENIED: 403,
  /** The booking moved since the caller read it. Reload and decide again. */
  BOOKING_STATE_CONFLICT: 409,
  /** The state machine has no such transition from where the booking is. */
  BOOKING_TRANSITION_INVALID: 409,
  /** Already completed, cancelled or expired. Distinguished from a plain
   *  invalid transition so a client can stop offering actions rather than
   *  suggesting the caller try something else. */
  BOOKING_TERMINAL: 409,
  /** The six-digit code the customer reads out did not match. */
  BOOKING_WORKER_CODE_INVALID: 403,
  /** The booking verification code the customer received did not match. */
  BOOKING_OTP_INVALID: 403,
  /** Verification already happened, or the booking has moved past it. */
  BOOKING_ALREADY_CONFIRMED: 409,

  /**
   * Policy refusals, each naming the rule that refused.
   *
   * Deliberately NOT collapsed into BOOKING_TRANSITION_INVALID. The transition
   * is perfectly valid; an operator policy declines it, and the client has to
   * be able to say which one so the provider knows whether to wait, contact
   * support, or pick a different action. `details.allowedUntil` carries the
   * deadline for the time-based rule so no client recomputes the window.
   */
  BOOKING_POLICY_REFUSED: 409,
  /** Inside the provider self-cancellation notice period. */
  BOOKING_PROVIDER_CANCEL_WINDOW_EXPIRED: 409,
  /** Cancellation attempted from a stage the policy does not allow. */
  BOOKING_PROVIDER_CANCEL_STAGE_INVALID: 409,
  /** No usable schedule, so the notice period cannot be proven. Fails closed. */
  BOOKING_PROVIDER_CANCEL_SCHEDULE_UNKNOWN: 409,
  /** Reason code outside the standardized list. */
  BOOKING_PROVIDER_CANCEL_REASON_INVALID: 422,

  // ── Notifications ──────────────────────────────────────────────────────────
  NOTIFICATION_NOT_FOUND: 404,
  NOTIFICATION_NOT_ACTIONABLE: 409,

  // ── Provider ───────────────────────────────────────────────────────────────
  PROVIDER_ROLE_REQUIRED: 403,

  // ── Auth and identity ──────────────────────────────────────────────────────
  //
  // These mirror `src/errors/authErrors.ts`, which the legacy routes emit and
  // which every client already branches on. The mapping is asserted by
  // `tests/v1-auth-contract.test.ts` so the two vocabularies cannot drift into
  // meaning different things under the same name — one vocabulary that is
  // slightly off-spec beats two that are each half-right.
  //
  /** Identifier or password did not match. Deliberately does NOT distinguish
   *  "no such account" from "wrong password" — that difference is a free
   *  membership check for anyone holding a list of addresses. */
  INVALID_CREDENTIALS: 401,
  /** The credential was CORRECT; the identifier is not yet verified. 403, not
   *  401 — sending this to a login screen makes people retype a password that
   *  was never the problem. */
  ACCOUNT_UNVERIFIED: 403,
  /** Authenticated, but the account may not sign in at all. */
  ACCOUNT_DISABLED: 403,
  /** Authenticated, but not on this surface. Asserted AFTER authentication so
   *  the admin login box is not an oracle for "is this address an admin". */
  AUDIENCE_MISMATCH: 403,
  /** The identifier belongs to an account reachable another way. Retrying the
   *  same way fails identically forever, which is why it is not a 401. */
  ACCOUNT_LINK_REQUIRED: 409,
  /** The account has no password credential — it signs in with a code. */
  PASSWORD_NOT_AVAILABLE: 409,
  /** Wrong, unknown, already used, or never issued. One outcome on purpose. */
  OTP_INVALID: 400,
  /** A code for this identifier and purpose existed and its window has passed. */
  OTP_EXPIRED: 410,
  /** The reset link is malformed, spent or past its life. */
  RESET_TOKEN_INVALID: 400,
  /** A refresh token that Google will not exchange. */
  REFRESH_TOKEN_INVALID: 401,
  /** Google's token endpoint could not be reached. Transient, retryable. */
  REFRESH_UNAVAILABLE: 502,
  /** The password does not meet the policy. */
  WEAK_PASSWORD: 400,
  /** Registration could not proceed. Deliberately does not say why — "that
   *  email is taken" is the same membership check by another route. */
  REGISTRATION_REJECTED: 400,
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
