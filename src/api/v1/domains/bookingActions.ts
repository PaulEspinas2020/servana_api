/**
 * Phase A — the canonical booking lifecycle actions.
 *
 * Every handler here does the same three things and nothing else:
 *
 *   1. resolve the actor from the TOKEN,
 *   2. call `transitionBooking`,
 *   3. translate the outcome into the v1 envelope.
 *
 * No handler writes a status column, reads an actor id out of a body, or
 * decides what a transition means. That is all the executor's, which is the
 * point of building these before migrating any legacy write: the executor gets
 * exercised by the canonical path first, so it is proven infrastructure by the
 * time the field's traffic moves onto it.
 *
 * ## Downstream effects are deliberately NOT here
 *
 * Notifications, push, websocket emission and earnings all happen after a
 * committed transition and are owned by their existing code. §45: a
 * notification failure must not roll back a booking that already moved. When
 * the legacy families migrate, their existing hooks stay where they are and
 * simply fire after the executor returns.
 */

import { Request, Response } from 'express';
import {
  transitionBooking,
  getBookingTimeline,
  getAvailableActions,
  TransitionError,
  type BookingAction,
  type TransitionErrorCode,
} from '../../../services/booking/transitionExecutor';
import { assertBookingAccess, BookingAccessError } from '../../../services/bookingAccessService';
import { deriveCanonicalState, type BookingState } from '../../../services/booking/canonicalState';
import { toCustomerProjection, toProviderProjection } from '../../../services/booking/projections';
import { ok, sendCaught, readIdempotencyKey } from '../envelope';
import { ApiError, isV1ErrorCode, type V1ErrorCode } from '../errors';
import { isProviderRole } from '../../../constants/providerRoles';
import { V1Handlers } from '../types';

/** Executor failures → the v1 vocabulary. One code per distinguishable outcome. */
const TRANSITION_CODE: Record<TransitionErrorCode, V1ErrorCode> = {
  BOOKING_NOT_FOUND: 'BOOKING_NOT_FOUND',
  NOT_AUTHORIZED: 'BOOKING_ACCESS_DENIED',
  INVALID_TRANSITION: 'BOOKING_TRANSITION_INVALID',
  TERMINAL_STATE: 'BOOKING_TERMINAL',
  BOOKING_STATE_CONFLICT: 'BOOKING_STATE_CONFLICT',
  GUARD_FAILED: 'VALIDATION_FAILED',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  WORKER_CODE_INVALID: 'BOOKING_WORKER_CODE_INVALID',
  // The fallback. A guard that names its own reason overrides this below —
  // collapsing every policy refusal into one code would tell a provider that
  // something is not allowed without telling them which rule said so.
  POLICY_REFUSED: 'BOOKING_POLICY_REFUSED',
};

const asApiError = (error: unknown): unknown => {
  if (error instanceof TransitionError) {
    // A policy guard names the specific rule. Prefer it, but only when it is a
    // registered v1 code: an unrecognised string would produce an ApiError with
    // no HTTP status mapping, so an unknown reason degrades to the family code
    // rather than to a 500.
    const named = error.detail?.reasonCode;
    const code =
      error.code === 'POLICY_REFUSED' && typeof named === 'string' && isV1ErrorCode(named)
        ? named
        : TRANSITION_CODE[error.code];
    return new ApiError(code, error.message, error.detail);
  }
  if (error instanceof BookingAccessError) {
    return new ApiError(
      error.code === 'BOOKING_NOT_FOUND' ? 'BOOKING_NOT_FOUND' : 'BOOKING_ACCESS_DENIED',
      error.message,
    );
  }
  return error;
};

const readBookingId = (req: Request): number => {
  const id = Number(req.params.bookingId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw ApiError.validation('bookingId must be a positive integer.');
  }
  return id;
};

const actorUidOf = (req: Request): string => {
  const uid = (req as any).user?.uid as string | undefined;
  if (!uid) throw new ApiError('UNAUTHENTICATED', 'Authentication is required.');
  return uid;
};

/**
 * `expectedState`, when the client sends one.
 *
 * Optional on purpose. A client that has just read the booking should send it
 * and get a clean 409 instead of silently acting on a stale view; one that has
 * not cannot be forced to invent a value.
 */
const readExpectedState = (body: Record<string, unknown>): BookingState | undefined => {
  const raw = body.expectedState;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') throw ApiError.validation('expectedState must be a string.');
  return raw.toUpperCase() as BookingState;
};

/** One shape for every action handler. */
const runAction = (
  action: BookingAction,
  actorRole: 'customer' | 'assigned_provider',
  context: string,
) => async (req: Request, res: Response) => {
  try {
    const bookingId = readBookingId(req);
    const body = (req.body ?? {}) as Record<string, unknown>;

    const result = await transitionBooking({
      bookingId,
      action,
      actorUid: actorUidOf(req),
      actorRole,
      expectedState: readExpectedState(body),
      idempotencyKey: readIdempotencyKey(req),
      // Only fields the guards read. The actor is NEVER taken from here.
      metadata: {
        ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
        ...(typeof body.workerCode === 'string' ? { workerCode: body.workerCode } : {}),
        // Read by the cancellation policy guard, which validates it against the
        // standardized list rather than accepting free text.
        ...(typeof body.reasonCode === 'string' ? { reasonCode: body.reasonCode } : {}),
      },
      correlationId: String((req as any).id ?? ''),
    });

    // The projection the CALLER reads, so a client never has to derive state.
    const projection =
      actorRole === 'customer'
        ? toCustomerProjection(result.toState)
        : toProviderProjection(result.toState);

    return ok(res, req, { ...result, state: projection });
  } catch (error) {
    return sendCaught(res, req, context, asApiError(error));
  }
};

export const handlers: V1Handlers = {
  'bookings.cancel': runAction('CUSTOMER_CANCEL', 'customer', 'bookings.cancel'),

  'provider.jobs.accept': runAction('PROVIDER_ACCEPT', 'assigned_provider', 'provider.jobs.accept'),
  'provider.jobs.decline': runAction('PROVIDER_DECLINE', 'assigned_provider', 'provider.jobs.decline'),
  'provider.jobs.enroute': runAction('PROVIDER_EN_ROUTE', 'assigned_provider', 'provider.jobs.enroute'),
  'provider.jobs.arrived': runAction('PROVIDER_ARRIVED', 'assigned_provider', 'provider.jobs.arrived'),
  'provider.jobs.start': runAction('PROVIDER_START', 'assigned_provider', 'provider.jobs.start'),
  'provider.jobs.complete': runAction('PROVIDER_COMPLETE', 'assigned_provider', 'provider.jobs.complete'),

  /**
   * The canonical event log.
   *
   * Access goes through `assertBookingAccess` — the same function every other
   * booking read uses — so a customer, the actively assigned provider and an
   * admin can each read it, and nobody else can. Every one of them sees the
   * SAME events, which is the property the whole command exists to establish.
   */
  'bookings.transitions': async (req: Request, res: Response) => {
    try {
      const bookingId = readBookingId(req);
      await assertBookingAccess(bookingId, actorUidOf(req));

      const events = await getBookingTimeline(bookingId);
      const currentState = events.length
        ? events[events.length - 1].toState
        : deriveCanonicalState({ bookingStatus: null, workerStatus: null });

      /**
       * What this caller may do next, from the SAME guards the executor runs.
       *
       * This is the half that stops UI/executor drift: the button the app
       * draws and the action the executor authorizes are now the same
       * decision, evaluated by one implementation. A refused action carries
       * its reason code and, for the time-based rule, `allowedUntil` — so no
       * client reimplements a policy window.
       */
      const actorUid = actorUidOf(req);
      // Roles 2 AND 4 are both providers. A `role === 2` check here would have
      // silently shown a role-4 provider an empty action list, which is the
      // exact mistake `constants/providerRoles` exists to prevent.
      const actorRole: 'customer' | 'assigned_provider' =
        isProviderRole((req as any).user?.role) ? 'assigned_provider' : 'customer';
      const availableActions = await getAvailableActions(bookingId, actorUid, actorRole);

      return ok(res, req, { bookingId, currentState, events, availableActions });
    } catch (error) {
      return sendCaught(res, req, 'bookings.transitions', asApiError(error));
    }
  },
};
