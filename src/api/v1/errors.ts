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
  /** Too late for the customer to self-cancel; the provider is already on the way. */
  BOOKING_NOT_CANCELLABLE_AT_THIS_STAGE: 409,

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

  // ── Booking experiences (TAB 06) ───────────────────────────────────────────
  //
  // One code per distinguishable refusal, for the same reason the cancellation
  // family has four rather than one: "you cannot do that" without saying which
  // rule refused leaves a client unable to tell the caller whether to wait, ask
  // for a new code, pick a different time, or contact support.
  //
  // The booking codes. `purpose` is part of every one of them, because a code
  // that is wrong FOR THIS PURPOSE and a code that is wrong are different facts.
  /** No such purpose. The vocabulary is closed and append-only. */
  BOOKING_OTP_PURPOSE_INVALID: 400,
  /** The booking is not at a stage where a code of this purpose is used. */
  BOOKING_OTP_NOT_APPLICABLE: 409,
  /** This actor may not request, or may not present, a code of this purpose. */
  BOOKING_OTP_ACTOR_NOT_PERMITTED: 403,
  /** A code was issued too recently. `details.retryAfterSeconds` says when. */
  BOOKING_OTP_RESEND_COOLDOWN: 429,
  /** The per-booking issue ceiling is spent. Support, not a retry. */
  BOOKING_OTP_RESEND_LIMIT: 429,
  /** The current code is past its window. 410, matching `OTP_EXPIRED`. */
  BOOKING_OTP_EXPIRED: 410,
  /** Too many wrong answers against the current code. Request another. */
  BOOKING_OTP_ATTEMPTS_EXHAUSTED: 429,
  /** No code has ever been issued for this booking and purpose. */
  BOOKING_OTP_NOT_ISSUED: 409,

  // Reschedule.
  /** The booking is in a state that may not be moved. */
  BOOKING_NOT_RESCHEDULABLE: 409,
  /** Unparseable, in the past, or beyond the lead bound. */
  BOOKING_SCHEDULE_INVALID: 400,
  /** A customer inside their notice window. An admin is exempt. */
  BOOKING_RESCHEDULE_NOTICE_REQUIRED: 409,
  /** Reason code outside the standardized list. */
  BOOKING_RESCHEDULE_REASON_INVALID: 422,
  /** The assigned provider already has work across the proposed span. */
  BOOKING_RESCHEDULE_PROVIDER_CONFLICT: 409,
  /** The booking moved between the caller's read and their write. */
  BOOKING_SCHEDULE_CHANGED: 409,

  // Disputes.
  /** An unresolved escalation already exists. Never two open at once (§66). */
  BOOKING_DISPUTE_ALREADY_OPEN: 409,
  /** Too early in the lifecycle for a dispute to mean anything. */
  BOOKING_DISPUTE_NOT_ACTIONABLE: 409,
  /** Category outside the standardized list. */
  BOOKING_DISPUTE_CATEGORY_INVALID: 422,

  // Additional work.
  /** The change order's items or amounts did not validate. */
  BOOKING_ADDITIONAL_WORK_INVALID: 400,
  /** Only the provider working the job may raise additional work on it. */
  BOOKING_ADDITIONAL_WORK_NOT_IN_PROGRESS: 409,

  // ── Payments, earnings, payouts and refunds ────────────────────────────────
  //
  // One code per REFUSAL, not one per failure. A client that can only be told
  // "payment failed" has to guess whether to offer a retry, a different method,
  // or nothing at all — and the three are different screens.
  /** The booking exists and has no payment row at all. */
  PAYMENT_NOT_FOUND: 404,
  /** The caller's seat on this booking may not perform this money operation.
   *  A provider is never a party to the customer's charge. */
  PAYMENT_ACTOR_NOT_PERMITTED: 403,
  /** Already paid, refunding, or a booking too far along to start a charge on. */
  PAYMENT_STATE_CONFLICT: 409,
  /** The processor is unreachable or misconfigured. Transient; retry is correct.
   *  Deliberately does NOT reflect the processor's own message, which can carry
   *  fraud and risk signals that must not reach the payer. */
  PAYMENT_PROCESSOR_UNAVAILABLE: 502,
  /** Only a captured payment can be refunded. */
  REFUND_PAYMENT_NOT_CAPTURED: 409,
  /** This payment has already been returned in full. */
  REFUND_ALREADY_SETTLED: 409,
  /** A refund is claimed and its outcome is not yet known. Blocks a second one. */
  REFUND_IN_PROGRESS: 409,
  /** More than was captured, once anything already returned is counted. */
  REFUND_EXCEEDS_CAPTURED: 422,
  /** Refund reason outside the standardized list. */
  REFUND_TRIGGER_INVALID: 422,
  /** The booking outcome does not entitle this actor to cite that reason. */
  REFUND_OUTCOME_NOT_REFUNDABLE: 409,
  /** startDate and endDate must be supplied together and must parse. */
  EARNINGS_RANGE_INVALID: 400,

  // ── Messaging (TAB 08) ─────────────────────────────────────────────────────
  //
  // One code per distinguishable refusal, for the same reason the booking and
  // refund families have several rather than one: a client told only "you
  // cannot send that" has to guess whether to offer a retry, hide the composer,
  // drop the attachment or send the person to support, and those are four
  // different screens.
  /** This id does not resolve to a conversation the caller may read.
   *
   *  ONE code for "no such conversation" and "not yours", deliberately.
   *  Conversation ids are sequential integers, so an endpoint that answered 404
   *  for an unknown id and 403 for a real one would let anyone count the
   *  platform's conversations by walking them. Distinct from
   *  BOOKING_ACCESS_DENIED so a client showing a chat screen knows it was the
   *  THREAD that was refused. */
  CONVERSATION_ACCESS_DENIED: 403,
  /** Cancelled, read-only or archived. The transcript is readable; this write
   *  is not accepted. `details.reason` names which. */
  CONVERSATION_NOT_WRITABLE: 409,
  /** The booking has no conversation yet and this caller may not open one — a
   *  booking conversation opens when a provider is confirmed. */
  CONVERSATION_NOT_AVAILABLE: 409,
  /** No such message, or it belongs to another conversation. One code on
   *  purpose: distinguishing the two would confirm a message id exists. */
  MESSAGE_NOT_FOUND: 404,
  /** Body, type or content failed validation. */
  MESSAGE_INVALID: 422,
  /** The required clientMsgId is missing or malformed. NOT optional — without
   *  one a retried send cannot be recognised as the same message. */
  MESSAGE_IDEMPOTENCY_KEY_INVALID: 422,
  /** The caller's assignment carries no usable start, so the backend cannot
   *  tell where their history begins. Fails closed. */
  MESSAGE_HISTORY_UNAVAILABLE: 403,
  /** The attachment reference, type, size or count was refused. */
  MESSAGE_ATTACHMENT_REJECTED: 422,
  /** Not the caller's message, a system message, or already deleted. */
  MESSAGE_NOT_EDITABLE: 409,
  /** The read pointer did not name a visible message in this conversation. */
  READ_POINTER_INVALID: 422,

  // ── Account, profile and addresses (TAB 10) ────────────────────────────────
  //
  // One code per distinguishable refusal, for the same reason every other domain
  // family has several: "you cannot do that" without saying which rule refused
  // leaves a client unable to tell the caller whether to edit a different field,
  // delete something first, or go somewhere else entirely.
  /** The field exists and is not writable at this endpoint. Deliberately NOT
   *  silent: dropping `email` from a PATCH leaves the caller believing they
   *  changed a verified identifier. `details` names where it IS changed. */
  ACCOUNT_FIELD_NOT_WRITABLE: 422,
  /** This id does not resolve to an address the caller owns.
   *
   *  ONE code for "no such address" and "not yours". Address ids are short
   *  generated strings, so an endpoint that distinguished the two would let a
   *  caller confirm which ids exist — and these are people's homes. */
  ADDRESS_NOT_FOUND: 404,
  /** The account is at its address ceiling. */
  ADDRESS_LIMIT_REACHED: 409,

  // ── Reviews and post-service support (TAB 12) ──────────────────────────────
  //
  // One code per distinguishable refusal. A client told only "you cannot review
  // this" has to guess whether to wait for the job to finish, tell the customer
  // the window closed for good, or open the review they already wrote — and
  // those are three different screens.
  /** The booking is not this caller's, or does not resolve for them.
   *
   *  Deliberately the SAME answer as a booking that does not exist. A caller who
   *  could tell the two apart could enumerate booking ids, and a booking id is a
   *  small integer. */
  REVIEW_FORBIDDEN: 403,
  /** The booking exists and is not reviewable yet, or no longer is.
   *  `details` names which rule refused. */
  REVIEW_NOT_ELIGIBLE: 422,
  /** This booking already carries a review. One booking, one active review. */
  REVIEW_ALREADY_EXISTS: 409,
  /** No such review for this caller. */
  REVIEW_NOT_FOUND: 404,
  /** The booking has not concluded, so a post-service case is not the right
   *  path — cancellation and rescheduling have their own. */
  SUPPORT_BOOKING_NOT_ELIGIBLE: 422,
  /** The booking is at its open-case ceiling. */
  SUPPORT_CASE_LIMIT_REACHED: 409,

  // ── Notifications ──────────────────────────────────────────────────────────
  NOTIFICATION_NOT_FOUND: 404,
  NOTIFICATION_NOT_ACTIONABLE: 409,

  // ── Provider ───────────────────────────────────────────────────────────────
  PROVIDER_ROLE_REQUIRED: 403,

  /**
   * Provider ACCOUNT STATE denials, emitted by `requireCapability`.
   *
   * Four codes rather than one, and that is the whole point. A suspended
   * provider and an unapproved one both fail `canViewEarnings` and need
   * different screens: one is temporary and has a status to watch, the other is
   * a step to complete. `middleware/requireCapability.ts` already chooses
   * between them in `denialFor`, and collapsing them onto `FORBIDDEN` here would
   * throw that away at the last step — which is how a client ends up telling
   * someone whose account is on hold that their session expired.
   *
   * They exist here because the v1 capability rung had no v1 vocabulary for what
   * it denies with. `LEGACY_TO_V1_CODE` found no mapping, so the wrapper fell
   * through to `originalJson` and answered in the LEGACY envelope — the exact
   * defect removed from the other 85 non-public routes. Codes are append-only,
   * so naming them is the additive fix rather than a breaking one.
   */
  PROVIDER_NOT_APPROVED: 403,
  PROVIDER_SUSPENDED: 403,
  PROVIDER_REJECTED: 403,
  PROVIDER_DISABLED: 403,

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
