/**
 * v1 provider EVIDENCE, CANCELLATION ELIGIBILITY and CASH COLLECTION.
 *
 * The job lifecycle is otherwise fully canonical. These are the parts of it
 * that carry PROOF and MONEY, which is why they were left until their
 * guarantees could be stated rather than assumed.
 *
 * ## Evidence is what a dispute is decided on
 *
 * So a retried upload must not become a second photo, and a retry that already
 * succeeded must not read as a failure. `clientRequestId` is REQUIRED here —
 * unlike on the legacy route, where demanding one would break five shipped
 * clients — and the shared service collapses the retry onto the original file
 * through a partial unique index (migration 043).
 *
 * ## Cash collection is authorized per BOOKING, not per role
 *
 * `auth: 'authenticated'` looks loose and is exactly right. The legacy route is
 * mounted on `verifyAuth` alone and does its authorization in the handler:
 * `assertBookingAccess` resolves the caller's relationship to this booking, and
 * settlement then refuses the CUSTOMER — because a customer declaring their own
 * cash payment is not evidence of anything. Provider or admin, and admin only
 * for support-assisted recovery.
 *
 * Declaring `provider` instead would have looked stricter and would have locked
 * admin out of that recovery path. The rung that matters is not a role, it is
 * membership of the booking, and that is enforced in the service where it can
 * see which booking is being asked about.
 */

import { Request, Response } from 'express';
import * as evidenceService from '../../../services/bookingEvidenceService';
import * as paymentService from '../../../services/paymentService';
import { assertBookingAccess, BookingAccessError } from '../../../services/bookingAccessService';
import { evaluateCancellation } from '../../../services/booking/bookingPolicies';
import { assertOwnBooking, loadCancellationContext } from '../../../services/booking/providerBookingOwnership';
import { ok, created, sendCaught } from '../envelope';
import { ApiError, V1ErrorCode } from '../errors';
import { V1Handlers } from '../types';

const uidOf = (req: Request): string => {
  const uid = (req as any).user?.uid as string | undefined;
  if (!uid) throw new ApiError('UNAUTHENTICATED', 'Authentication is required.');
  return uid;
};

const bookingIdOf = (req: Request): number => {
  const id = Number(req.params.bookingId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw ApiError.validation('bookingId must be a positive integer.');
  }
  return id;
};

const bodyOf = (req: Request): Record<string, unknown> =>
  (req.body ?? {}) as Record<string, unknown>;

const CODE: Record<string, V1ErrorCode> = {
  NOT_ACCEPTING_EVIDENCE: 'BOOKING_STATE_CONFLICT',
  UNKNOWN_REQUIREMENT: 'VALIDATION_FAILED',
  TOO_MANY_FILES: 'CONFLICT',
  EVIDENCE_FILE_INVALID: 'VALIDATION_FAILED',
  BOOKING_ACCESS_DENIED: 'BOOKING_ACCESS_DENIED',
};

const asApiError = (error: unknown): unknown => {
  const candidate = error as { code?: string; message?: string; status?: number; statusCode?: number } | null;
  if (candidate?.code && CODE[candidate.code]) {
    return new ApiError(CODE[candidate.code], candidate.message);
  }
  if (error instanceof BookingAccessError) {
    return new ApiError('BOOKING_ACCESS_DENIED', error.message);
  }
  return error;
};

/**
 * The caller's worker status on this booking, or a 404.
 *
 * Deliberately NOT distinguishing "not yours" from "not there": the difference
 * enumerates which booking ids exist and which providers hold them.
 */
const ownWorkerStatus = async (bookingId: number, uid: string): Promise<string> => {
  const status = await assertOwnBooking(bookingId, uid);
  if (!status) throw new ApiError('NOT_FOUND', 'Booking not found.');
  return status;
};

export const handlers: V1Handlers = {
  /** Every live piece of evidence on this booking, with the requirements it answers. */
  'provider.jobs.evidence.list': async (req: Request, res: Response) => {
    try {
      const uid = uidOf(req);
      const bookingId = bookingIdOf(req);
      await ownWorkerStatus(bookingId, uid);
      const items = await evidenceService.listEvidence(bookingId, uid);
      return ok(res, req, {
        requirements: evidenceService.requirementsForBooking(),
        items,
        blocking: {
          BEFORE_SERVICE: evidenceService.blockingRequirements('BEFORE_SERVICE', items),
          AFTER_SERVICE: evidenceService.blockingRequirements('AFTER_SERVICE', items),
        },
      });
    } catch (error) {
      return sendCaught(res, req, 'provider.jobs.evidence.list', asApiError(error));
    }
  },

  /**
   * Attach evidence.
   *
   * `clientRequestId` is REQUIRED on this route. Evidence is what a dispute is
   * decided on, and a doorstep upload happens on the worst link in the product;
   * a write that cannot be retried safely is not one to publish canonically.
   */
  'provider.jobs.evidence.create': async (req: Request, res: Response) => {
    try {
      const uid = uidOf(req);
      const bookingId = bookingIdOf(req);
      const body = bodyOf(req);
      const clientRequestId = String(body.clientRequestId ?? '').trim();
      if (clientRequestId.length < 16 || clientRequestId.length > 128) {
        throw ApiError.validation(
          'clientRequestId of 16-128 characters is required so a retried upload returns the ' +
          'original file rather than attaching a second one.',
        );
      }
      const workerStatus = await ownWorkerStatus(bookingId, uid);

      const item = await evidenceService.submitEvidence({
        bookingId,
        workerUid: uid,
        workerStatus,
        requirementCode: String(body.requirementCode ?? ''),
        file: body.file,
        clientRequestId,
      });

      const { replayed, ...evidence } = item;
      // §19 — attached is NOT approved, and the client must not read a 201 as
      // acceptance. `approved` is stated rather than left to be inferred.
      const payload = { ...evidence, approved: false, replayed };
      // 200 for a replay, 201 for a new file. Neither is an error.
      return replayed ? ok(res, req, payload) : created(res, req, payload);
    } catch (error) {
      return sendCaught(res, req, 'provider.jobs.evidence.create', asApiError(error));
    }
  },

  /**
   * Remove a piece of evidence.
   *
   * SOFT, and scoped by worker uid inside the UPDATE, so one provider cannot
   * remove another's file even with a guessed id and the audit trail survives a
   * provider replacing a photo.
   */
  'provider.jobs.evidence.delete': async (req: Request, res: Response) => {
    try {
      const uid = uidOf(req);
      const bookingId = bookingIdOf(req);
      const evidenceId = Number(req.params.evidenceId);
      if (!Number.isSafeInteger(evidenceId) || evidenceId <= 0) {
        throw new ApiError('NOT_FOUND', 'Evidence not found.');
      }
      await ownWorkerStatus(bookingId, uid);
      const removed = await evidenceService.removeEvidence(bookingId, uid, evidenceId);
      if (!removed) throw new ApiError('NOT_FOUND', 'Evidence not found.');
      return ok(res, req, { evidenceId: String(evidenceId), removed: true });
    } catch (error) {
      return sendCaught(res, req, 'provider.jobs.evidence.delete', asApiError(error));
    }
  },

  /**
   * May this provider cancel, and if not, why?
   *
   * Read BEFORE offering the action, so a refusal names a reason instead of
   * arriving as a bare error after the provider has committed to it. The verdict
   * comes from `evaluateCancellation` — the SAME function the transition itself
   * calls — so the button and the POST behind it cannot disagree about the
   * window. A race between loading this and tapping is still possible and still
   * fine: the POST stays authoritative.
   */
  'provider.jobs.cancellationEligibility': async (req: Request, res: Response) => {
    try {
      const uid = uidOf(req);
      const bookingId = bookingIdOf(req);
      const ctx = await loadCancellationContext(bookingId, uid);
      if (!ctx) throw new ApiError('NOT_FOUND', 'Booking not found.');

      return ok(res, req, {
        bookingId,
        ...evaluateCancellation({
          workerStatus: ctx.worker_status,
          schedule: ctx.schedule,
          now: new Date(),
        }),
      });
    } catch (error) {
      return sendCaught(res, req, 'provider.jobs.cancellationEligibility', asApiError(error));
    }
  },

  /**
   * Record that cash was collected for this booking.
   *
   * Idempotent by construction: the UPDATE sets `paid_at = COALESCE(paid_at,
   * NOW())`, so a second call reaches the same end state without moving the
   * moment money changed hands, and the ledger event is keyed on the payment id
   * so it is written once.
   *
   * Authorization is per BOOKING and refuses the CUSTOMER — a customer
   * declaring their own cash payment is not evidence of anything.
   */
  'bookings.payments.cashCollected': async (req: Request, res: Response) => {
    try {
      const uid = uidOf(req);
      const bookingId = bookingIdOf(req);

      const role = await assertBookingAccess(bookingId, uid);
      if (role === 'customer') {
        throw new ApiError(
          'BOOKING_ACCESS_DENIED',
          'Payment settlement is recorded by the provider or Servana, not by the customer.',
        );
      }

      const payment = await paymentService.markCashPaid(bookingId);
      return ok(res, req, {
        bookingId,
        status: payment.status,
        method: payment.method,
        paidAt: payment.paid_at ?? null,
      });
    } catch (error) {
      return sendCaught(res, req, 'bookings.payments.cashCollected', asApiError(error));
    }
  },
};
