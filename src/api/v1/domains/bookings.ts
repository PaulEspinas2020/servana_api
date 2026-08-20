/**
 * v1 booking read handlers.
 *
 * Access goes through `bookingAccessService.assertBookingAccess`, the same
 * function every legacy booking route uses. Its two error codes —
 * BOOKING_NOT_FOUND and BOOKING_ACCESS_DENIED — are already exactly the v1
 * codes, so the translation below is a re-envelope and not a re-decision.
 *
 * A booking that exists but is not yours is 403, not 404. Booking ids are
 * sequential, so 404-on-forbidden would leak existence by omission anyway while
 * making genuine "deleted booking" bugs impossible to tell apart. That choice
 * belongs to the access service and v1 inherits it rather than re-litigating it.
 *
 * Mutations are NOT here. Creating, cancelling and confirming a booking are
 * state-machine transitions with idempotency, notification and audit
 * obligations; adding a second path to them in a foundation command is how a
 * booking ends up with two lifecycles. They are sequenced with the bookings
 * domain command.
 */

import { Request, Response } from 'express';
import * as bookingService from '../../../services/bookingService';
import {
  assertBookingAccess,
  BookingAccessError,
} from '../../../services/bookingAccessService';
import { ok, sendCaught, readPage, pageMeta } from '../envelope';
import { ApiError } from '../errors';
import { V1Handlers } from '../types';

/** Maps the access service's own error type onto the v1 code of the same name. */
const asApiError = (error: unknown): unknown => {
  if (error instanceof BookingAccessError) {
    return new ApiError(error.code, error.message);
  }
  return error;
};

const readBookingId = (req: Request): number => {
  const bookingId = Number(req.params.bookingId);
  if (!Number.isSafeInteger(bookingId) || bookingId <= 0) {
    throw ApiError.validation('bookingId must be a positive integer.');
  }
  return bookingId;
};

const actorOf = (req: Request): string => {
  const uid = (req as any).user?.uid as string | undefined;
  if (!uid) throw new ApiError('UNAUTHENTICATED', 'Authentication is required.');
  return uid;
};

export const handlers: V1Handlers = {
  'bookings.listMine': async (req: Request, res: Response) => {
    try {
      const uid = actorOf(req);
      const page = readPage(req, { defaultLimit: 20, maxLimit: 100 });

      const rows = await bookingService.getBookingsByUserId(uid);
      const total = rows.length;
      const window = rows.slice(page.offset, page.offset + page.limit);

      // NOTE: the service returns the whole set and this slices it. That bounds
      // the RESPONSE, not the query. It is an honest improvement on the legacy
      // route, which bounds neither — and it is recorded in the migration matrix
      // as work for the bookings domain command rather than hidden here.
      return ok(
        res,
        req,
        {
          // Self-scoped: getBookingsByUserId filters on the CUSTOMER column, so
          // every row belongs to the caller as its customer and the one-time
          // codes are theirs. A provider's assigned jobs are not in this set.
          bookings: bookingService.formatBookings(window, { includeCredentials: true }),
        },
        { page: pageMeta(page, window.length, total) },
      );
    } catch (error) {
      return sendCaught(res, req, 'bookings.listMine', asApiError(error));
    }
  },

  'bookings.get': async (req: Request, res: Response) => {
    try {
      const bookingId = readBookingId(req);
      // The ROLE, not just the fact of access. It decides whether the one-time
      // codes on this booking may be disclosed, and it was already being
      // computed and thrown away.
      const role = await assertBookingAccess(bookingId, actorOf(req));

      const booking = await bookingService.getBookingById(bookingId);
      if (!booking) throw new ApiError('BOOKING_NOT_FOUND', 'No booking with that id.');

      /**
       * `worker_code` is the SERVICE_START credential and this response is its
       * declared delivery channel — BOOKING_OTP_PURPOSES sets
       * `delivery: 'booking_detail'`, so the customer reads it here and says it
       * out loud on the doorstep. The provider TYPES IT IN; giving it to them
       * over the API defeats the proof of presence entirely, and
       * resolveBookingAccess grants `provider` from ASSIGNED onward — every
       * state before the start it gates.
       *
       * So: customer and admin see it, the assigned provider does not. An admin
       * is included because BOOKING_OTP_PURPOSES lists admin among the
       * verifiers, and an operator on a support call is the fallback when the
       * customer cannot read their own booking.
       */
      const includeCredentials = role === 'customer' || role === 'admin';

      return ok(res, req, bookingService.formatBooking(booking, { includeCredentials }));
    } catch (error) {
      return sendCaught(res, req, 'bookings.get', asApiError(error));
    }
  },

  'bookings.timeline': async (req: Request, res: Response) => {
    try {
      const bookingId = readBookingId(req);
      await assertBookingAccess(bookingId, actorOf(req));

      const timeline = await bookingService.getCustomerBookingTimeline(bookingId);
      return ok(res, req, { timeline });
    } catch (error) {
      return sendCaught(res, req, 'bookings.timeline', asApiError(error));
    }
  },
};
