/**
 * The canonical booking-experience endpoints: tracking, OTP, reschedule,
 * additional work and disputes.
 *
 * ## The one thing every handler here does
 *
 * It resolves the ACTOR from the booking relationship, not from the body and
 * not from the token's role claim:
 *
 *     const actor = await actorFor(bookingId, uidFromToken)
 *
 * `assertBookingAccess` already answers "customer, provider, or admin" for a
 * given uid and booking, and it is the same function every other booking route
 * uses. Taking the actor from it means a customer cannot claim to be an admin, a
 * provider who was reassigned away is no longer this booking's provider, and no
 * endpoint needs its own idea of who is calling.
 *
 * That is also why these are NOT role-split endpoints. One path serves all five
 * clients; the policy modules decide what each actor may do, from one
 * declaration, so Customer Web and Provider Mobile cannot end up with different
 * answers to the same question.
 *
 * ## Errors are translated, never re-decided
 *
 * Each domain service raises its own refusal enum. The maps below are pure
 * renaming into the v1 vocabulary — no handler re-evaluates a policy to decide
 * which code to send, because a transport layer that can disagree with its
 * domain service is a second implementation of the rule.
 */

import { Request, Response } from 'express';
import {
  assertBookingAccess,
  BookingAccessError,
  type BookingActorRole,
} from '../../../services/bookingAccessService';
import {
  requestBookingOtp,
  verifyBookingOtp,
  readCredentialState,
  parsePurpose,
  BookingOtpError,
  type BookingOtpRefusalCode,
} from '../../../services/booking/bookingOtpService';
import { getBookingTracking } from '../../../services/booking/bookingTrackingService';
import {
  rescheduleBooking,
  listRescheduleRequests,
  RescheduleError,
} from '../../../services/booking/bookingRescheduleService';
import {
  openDispute,
  listDisputes,
  DisputeError,
} from '../../../services/booking/bookingDisputeService';
import { additionalService } from '../../../services/additional.service';
import { emitExperienceEvent } from '../../../services/booking/experienceEvents';
import {
  BOOKING_OTP_PURPOSES,
  DISPUTE_CATEGORIES,
  RESCHEDULE_REASONS,
  canRequestOtp,
  canVerifyOtp,
  type ExperienceActor,
} from '../../../services/booking/experiencePolicy';
import { TransitionError } from '../../../services/booking/transitionExecutor';
import { toCustomerProjection, toProviderProjection } from '../../../services/booking/projections';
import { ok, created, sendCaught, readIdempotencyKey } from '../envelope';
import { ApiError, isV1ErrorCode, type V1ErrorCode } from '../errors';
import type { BookingState } from '../../../services/booking/canonicalState';
import { V1Handlers } from '../types';

// ─── Shared request plumbing ──────────────────────────────────────────────────

const readBookingId = (req: Request): number => {
  const id = Number(req.params.bookingId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw ApiError.validation('bookingId must be a positive integer.');
  }
  return id;
};

const uidOf = (req: Request): string => {
  const uid = (req as any).user?.uid as string | undefined;
  if (!uid) throw new ApiError('UNAUTHENTICATED', 'Authentication is required.');
  return uid;
};

const bodyOf = (req: Request): Record<string, unknown> =>
  (req.body ?? {}) as Record<string, unknown>;

/** `bookingAccessService`'s vocabulary is one word away from the policy's. */
const AS_EXPERIENCE_ACTOR: Record<BookingActorRole, ExperienceActor> = {
  customer: 'customer',
  provider: 'assigned_provider',
  admin: 'admin',
};

/**
 * Who is calling, decided by their relationship to THIS booking.
 *
 * Throws 403/404 for a caller with no relationship, so authorization and actor
 * resolution are the same step and a handler cannot accidentally do one without
 * the other.
 */
const actorFor = async (
  bookingId: number,
  uid: string,
): Promise<ExperienceActor> => AS_EXPERIENCE_ACTOR[await assertBookingAccess(bookingId, uid)];

const readExpectedState = (body: Record<string, unknown>): BookingState | undefined => {
  const raw = body.expectedState;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') throw ApiError.validation('expectedState must be a string.');
  return raw.toUpperCase() as BookingState;
};

const requiredString = (body: Record<string, unknown>, field: string): string => {
  const raw = body[field];
  if (typeof raw !== 'string' || !raw.trim()) {
    throw ApiError.validation(`${field} is required.`);
  }
  return raw.trim();
};

const optionalString = (body: Record<string, unknown>, field: string): string | null => {
  const raw = body[field];
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') throw ApiError.validation(`${field} must be a string.`);
  return raw;
};

// ─── Error translation ────────────────────────────────────────────────────────

const OTP_CODE: Record<BookingOtpRefusalCode, V1ErrorCode> = {
  BOOKING_NOT_FOUND: 'BOOKING_NOT_FOUND',
  OTP_ACTOR_NOT_PERMITTED: 'BOOKING_OTP_ACTOR_NOT_PERMITTED',
  OTP_PURPOSE_NOT_APPLICABLE: 'BOOKING_OTP_NOT_APPLICABLE',
  OTP_RESEND_COOLDOWN: 'BOOKING_OTP_RESEND_COOLDOWN',
  OTP_RESEND_LIMIT: 'BOOKING_OTP_RESEND_LIMIT',
  OTP_EXPIRED: 'BOOKING_OTP_EXPIRED',
  OTP_ATTEMPTS_EXHAUSTED: 'BOOKING_OTP_ATTEMPTS_EXHAUSTED',
  OTP_NOT_ISSUED: 'BOOKING_OTP_NOT_ISSUED',
};

const RESCHEDULE_CODE: Record<string, V1ErrorCode> = {
  BOOKING_NOT_FOUND: 'BOOKING_NOT_FOUND',
  STATE_NOT_RESCHEDULABLE: 'BOOKING_NOT_RESCHEDULABLE',
  SCHEDULE_INVALID: 'BOOKING_SCHEDULE_INVALID',
  INSIDE_NOTICE_WINDOW: 'BOOKING_RESCHEDULE_NOTICE_REQUIRED',
  REASON_INVALID: 'BOOKING_RESCHEDULE_REASON_INVALID',
  PROVIDER_CONFLICT: 'BOOKING_RESCHEDULE_PROVIDER_CONFLICT',
  SCHEDULE_CHANGED: 'BOOKING_SCHEDULE_CHANGED',
};

const DISPUTE_CODE: Record<string, V1ErrorCode> = {
  BOOKING_NOT_FOUND: 'BOOKING_NOT_FOUND',
  ALREADY_OPEN: 'BOOKING_DISPUTE_ALREADY_OPEN',
  NOT_YET_ACTIONABLE: 'BOOKING_DISPUTE_NOT_ACTIONABLE',
  CATEGORY_INVALID: 'BOOKING_DISPUTE_CATEGORY_INVALID',
  REASON_REQUIRED: 'VALIDATION_FAILED',
};

/**
 * The executor's vocabulary, for the OTP verify path.
 *
 * Duplicated in shape with `domains/bookingActions.ts` and NOT extracted into a
 * shared helper: that module's map is exhaustive over `TransitionErrorCode` and
 * is checked by the compiler, and a shared partial map would lose that. Two
 * short maps that each fail to compile when the enum grows beat one that
 * silently falls through.
 */
const asApiError = (error: unknown): unknown => {
  if (error instanceof BookingOtpError) {
    return new ApiError(OTP_CODE[error.code], error.message, error.detail);
  }
  if (error instanceof RescheduleError) {
    return new ApiError(
      RESCHEDULE_CODE[error.code] ?? 'CONFLICT',
      error.message,
      error.detail,
    );
  }
  if (error instanceof DisputeError) {
    return new ApiError(DISPUTE_CODE[error.code] ?? 'CONFLICT', error.message, error.detail);
  }
  if (error instanceof TransitionError) {
    const named = error.detail?.reasonCode;
    const code: V1ErrorCode =
      typeof named === 'string' && isV1ErrorCode(named)
        ? named
        : error.code === 'BOOKING_NOT_FOUND'
          ? 'BOOKING_NOT_FOUND'
          : error.code === 'NOT_AUTHORIZED'
            ? 'BOOKING_ACCESS_DENIED'
            : error.code === 'TERMINAL_STATE'
              ? 'BOOKING_TERMINAL'
              : error.code === 'BOOKING_STATE_CONFLICT'
                ? 'BOOKING_STATE_CONFLICT'
                : error.code === 'IDEMPOTENCY_KEY_REUSED'
                  ? 'IDEMPOTENCY_KEY_REUSED'
                  : error.code === 'BOOKING_OTP_INVALID'
                    ? 'BOOKING_OTP_INVALID'
                    : error.code === 'WORKER_CODE_INVALID'
                      ? 'BOOKING_WORKER_CODE_INVALID'
                      : 'BOOKING_TRANSITION_INVALID';
    return new ApiError(code, error.message, error.detail);
  }
  if (error instanceof BookingAccessError) {
    return new ApiError(
      error.code === 'BOOKING_NOT_FOUND' ? 'BOOKING_NOT_FOUND' : 'BOOKING_ACCESS_DENIED',
      error.message,
    );
  }
  // The additional-work service raises `{ statusCode, code }` objects rather
  // than a typed error. Translated by CODE, never by message.
  const tagged = error as { code?: string; message?: string };
  if (tagged?.code === 'ADDITIONAL_WORK_BOOKING_NOT_IN_PROGRESS') {
    return new ApiError('BOOKING_ADDITIONAL_WORK_NOT_IN_PROGRESS', String(tagged.message));
  }
  if (tagged?.code === 'ADDITIONAL_WORK_INVALID' || tagged?.code === 'UNAUTHENTICATED') {
    return new ApiError('BOOKING_ADDITIONAL_WORK_INVALID', String(tagged.message));
  }
  return error;
};

// ─── Handlers ─────────────────────────────────────────────────────────────────

export const handlers: V1Handlers = {
  /**
   * The whole tracking picture: history, state, and the provider's position when
   * — and only when — the visibility rule permits it.
   *
   * A withheld position is a 200 with `visibility.reason`, not a 403. The caller
   * IS entitled to this booking; they are simply not entitled to a live location
   * for a job that has not started, which is a different sentence and a
   * different screen.
   */
  'bookings.tracking': async (req: Request, res: Response) => {
    try {
      const bookingId = readBookingId(req);
      await assertBookingAccess(bookingId, uidOf(req));
      return ok(res, req, await getBookingTracking(bookingId));
    } catch (error) {
      return sendCaught(res, req, 'bookings.tracking', asApiError(error));
    }
  },

  /**
   * Mint a code. The response says how it will arrive and never what it is.
   */
  'bookings.otp.request': async (req: Request, res: Response) => {
    try {
      const bookingId = readBookingId(req);
      const uid = uidOf(req);
      const actor = await actorFor(bookingId, uid);
      const body = bodyOf(req);
      const purpose = parsePurpose(body.purpose);

      const result = await requestBookingOtp({
        bookingId,
        purpose,
        actor,
        actorUid: uid,
        deliver: deliveryFor(purpose),
      });
      return ok(res, req, result);
    } catch (error) {
      return sendCaught(res, req, 'bookings.otp.request', asApiError(error));
    }
  },

  /**
   * Present a code. Success is a state transition, so the response carries the
   * same `BookingTransitionResult` shape every other lifecycle action returns —
   * a client that already handles accept/start does not learn a second shape.
   */
  'bookings.otp.verify': async (req: Request, res: Response) => {
    try {
      const bookingId = readBookingId(req);
      const uid = uidOf(req);
      const actor = await actorFor(bookingId, uid);
      const body = bodyOf(req);
      const purpose = parsePurpose(body.purpose);

      // The code may arrive as `code` or `otp`. Both are accepted because the
      // shipped customer app sends `otp` and the provider portal sends neither
      // name consistently; the field is normalised here rather than in the
      // service, which takes one argument called what it is.
      const raw = body.code ?? body.otp ?? body.workerCode;
      if (typeof raw !== 'string' || !raw.trim()) {
        throw ApiError.validation('code is required.');
      }

      const result = await verifyBookingOtp({
        bookingId,
        purpose,
        code: raw.trim(),
        actor,
        actorUid: uid,
        expectedState: readExpectedState(body),
        idempotencyKey: readIdempotencyKey(req),
        correlationId: String((req as any).id ?? ''),
      });

      const projection =
        actor === 'assigned_provider'
          ? toProviderProjection(result.transition.toState)
          : toCustomerProjection(result.transition.toState);

      return ok(res, req, {
        ...result.transition,
        purpose: result.purpose,
        state: projection,
      });
    } catch (error) {
      return sendCaught(res, req, 'bookings.otp.verify', asApiError(error));
    }
  },

  /** What the caller may do with codes right now, without spending an attempt. */
  'bookings.otp.status': async (req: Request, res: Response) => {
    try {
      const bookingId = readBookingId(req);
      const uid = uidOf(req);
      const actor = await actorFor(bookingId, uid);
      const purpose = parsePurpose(req.query.purpose);
      const spec = BOOKING_OTP_PURPOSES[purpose];

      const state = await readCredentialState(bookingId, purpose);

      /**
       * `present` is the only field withheld by role.
       *
       * Whether a code EXISTS is a fact about the credential, and the provider
       * is the party who must be told it by the customer. Telling a provider
       * that a service-start code is on the booking is harmless; telling them
       * anything more would begin to substitute for the customer reading it out.
       */
      return ok(res, req, {
        bookingId,
        purpose,
        issuedAt: state.issuedAt?.toISOString() ?? null,
        expiresAt: state.expiresAt?.toISOString() ?? null,
        expired: state.expired,
        present: state.present,
        attemptsRemaining: state.attemptsRemaining,
        issuesRemaining: Math.max(0, spec.maxIssues - state.issueCount),
        resendAvailableInSeconds: state.cooldownRemainingSeconds,
        policy: {
          expiryMinutes: spec.expiryMinutes,
          resendCooldownSeconds: spec.resendCooldownSeconds,
          maxVerifyAttempts: spec.maxVerifyAttempts,
          maxIssues: spec.maxIssues,
          recipient: spec.recipient,
          delivery: spec.delivery,
          canRequest: canRequestOtp(purpose, actor),
          canVerify: canVerifyOtp(purpose, actor),
        },
      });
    } catch (error) {
      return sendCaught(res, req, 'bookings.otp.status', asApiError(error));
    }
  },

  /**
   * Move a booking. One endpoint for the customer and the admin; the notice
   * window is the only difference, and the policy applies it from the actor.
   */
  'bookings.reschedule': async (req: Request, res: Response) => {
    try {
      const bookingId = readBookingId(req);
      const uid = uidOf(req);
      const actor = await actorFor(bookingId, uid);
      const body = bodyOf(req);

      // A provider is not a party to rescheduling (C18 §14/§24). Refused here
      // rather than in the policy so the message names the seat, not the rule.
      if (actor === 'assigned_provider') {
        throw new ApiError(
          'BOOKING_ACCESS_DENIED',
          'A provider cannot move a booking. Contact the customer or support.',
        );
      }

      const result = await rescheduleBooking({
        bookingId,
        scheduledAt: requiredString(body, 'scheduledAt'),
        actor,
        actorUid: uid,
        reasonCode: optionalString(body, 'reasonCode'),
        reason: optionalString(body, 'reason'),
        expectedSchedule: optionalString(body, 'expectedSchedule'),
      });
      return ok(res, req, { ...result, reasons: RESCHEDULE_REASONS });
    } catch (error) {
      return sendCaught(res, req, 'bookings.reschedule', asApiError(error));
    }
  },

  /** Every attempt to move this booking, accepted or refused. */
  'bookings.reschedule.history': async (req: Request, res: Response) => {
    try {
      const bookingId = readBookingId(req);
      await assertBookingAccess(bookingId, uidOf(req));
      return ok(res, req, { bookingId, requests: await listRescheduleRequests(bookingId) });
    } catch (error) {
      return sendCaught(res, req, 'bookings.reschedule.history', asApiError(error));
    }
  },

  /**
   * Raise a change order against the booking.
   *
   * Provider-only, and the check is the booking RELATIONSHIP rather than the
   * token's role: `auth: 'provider'` on the contract proves the caller holds a
   * provider role somewhere, and this proves they hold THIS job.
   */
  'bookings.additionalWork.create': async (req: Request, res: Response) => {
    try {
      const bookingId = readBookingId(req);
      const uid = uidOf(req);
      const actor = await actorFor(bookingId, uid);
      if (actor !== 'assigned_provider') {
        throw new ApiError(
          'BOOKING_ACCESS_DENIED',
          'Only the provider working this booking can raise additional work on it.',
        );
      }

      const body = bodyOf(req);
      if (!Array.isArray(body.items)) {
        throw ApiError.validation('items must be an array of additional work lines.');
      }

      const request = await additionalService.createRequest(bookingId, body.items, uid);

      await emitExperienceEvent({
        bookingId,
        event: 'additionalWork.requested',
        actor,
        actorUid: uid,
        title: 'Additional work requested',
        description: 'Awaiting admin approval.',
        detail: { requestId: request.id, totalAmount: request.total_amount },
      });

      return created(res, req, { bookingId, request });
    } catch (error) {
      return sendCaught(res, req, 'bookings.additionalWork.create', asApiError(error));
    }
  },

  /** The change orders on this booking, for anyone entitled to the booking. */
  'bookings.additionalWork.list': async (req: Request, res: Response) => {
    try {
      const bookingId = readBookingId(req);
      await assertBookingAccess(bookingId, uidOf(req));
      return ok(res, req, {
        bookingId,
        requests: await additionalService.getByBooking(bookingId),
      });
    } catch (error) {
      return sendCaught(res, req, 'bookings.additionalWork.list', asApiError(error));
    }
  },

  /** Open a dispute. One record, whichever seat raised it. */
  'bookings.disputes.open': async (req: Request, res: Response) => {
    try {
      const bookingId = readBookingId(req);
      const uid = uidOf(req);
      const actor = await actorFor(bookingId, uid);
      const body = bodyOf(req);

      const record = await openDispute({
        bookingId,
        category: requiredString(body, 'category'),
        reason: requiredString(body, 'reason'),
        severity: optionalString(body, 'severity') ?? undefined,
        actor,
        actorUid: uid,
        evidence: body.evidence,
      });

      return created(res, req, { dispute: record, categories: DISPUTE_CATEGORIES });
    } catch (error) {
      return sendCaught(res, req, 'bookings.disputes.open', asApiError(error));
    }
  },

  /** The disputes on this booking. */
  'bookings.disputes.list': async (req: Request, res: Response) => {
    try {
      const bookingId = readBookingId(req);
      const uid = uidOf(req);
      await assertBookingAccess(bookingId, uid);
      return ok(res, req, {
        bookingId,
        disputes: await listDisputes(bookingId, uid),
        categories: DISPUTE_CATEGORIES,
      });
    } catch (error) {
      return sendCaught(res, req, 'bookings.disputes.list', asApiError(error));
    }
  },
};

// ─── Delivery ─────────────────────────────────────────────────────────────────

/**
 * How a freshly issued code reaches its recipient.
 *
 * Only BOOKING_CONFIRMATION is delivered out of band. The service-start code is
 * `delivery: 'booking_detail'` — it is already on the customer's booking screen,
 * and mailing it would put a credential the provider is about to ask for into a
 * channel the provider might also be able to see.
 *
 * Imported lazily so this module stays loadable without a mail transport, which
 * is what lets the contract tests import the handler map.
 */
const deliveryFor = (purpose: keyof typeof BOOKING_OTP_PURPOSES) => {
  if (purpose !== 'BOOKING_CONFIRMATION') return undefined;
  return async (bookingId: number, code: string, row: { user_id: string | null }) => {
    const { send } = await import('../../../helpers/mailer');
    const { getEmailById, getNameByEmail } = await import('../../../services/user.service');
    const email = await getEmailById(row.user_id as string);
    const firstName = await getNameByEmail(email);
    send(email, 'verify_booking_otp', {
      first_name: firstName,
      otp_code: code,
      booking_id: bookingId,
    });
  };
};
