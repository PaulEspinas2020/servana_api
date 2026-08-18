/**
 * The canonical post-service trust endpoints: review a booking, read that
 * review, and raise a support case about it.
 *
 * ## Every write is grounded in a booking
 *
 * `bookingId` comes from the path and the author from the token. Nothing in a
 * body names a provider, an author or a rating subject — §122 is not a
 * validation rule here, it is the absence of a field. `createReview` resolves
 * the provider from the COMPLETED assignment, so a payload that named one would
 * have nothing to attach it to.
 *
 * ## Authorization is not repeated here
 *
 * `customerReviewService` resolves ownership, eligibility, the window and the
 * one-review rule inside a transaction with an advisory lock. These handlers do
 * not re-check any of it; a transport layer that could reach a different
 * conclusion from its domain service is a second implementation of the rule.
 *
 * ## The reviews the PUBLIC list already serves
 *
 * `reviews.provider.list` and `reviews.provider.rating` exist from TAB 01 and
 * are unchanged. They are the canonical routes the command names as
 * `/providers/:providerId/reviews` and `/rating-summary` — reused rather than
 * duplicated under a second path.
 */

import { Request, Response } from 'express';
import * as reviewService from '../../../services/customerReviewService';
import * as support from '../../../services/reviews/postServiceSupportService';
import { ok, created, sendCaught, readPage, pageMeta } from '../envelope';
import { ApiError, type V1ErrorCode } from '../errors';
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

// ─── Error translation ────────────────────────────────────────────────────────

/**
 * Domain refusal → canonical code. Pure renaming.
 *
 * The review service raises `code` on its thrown errors already; this maps them
 * into the v1 enum without re-deciding which rule refused.
 */
const CODE: Record<string, V1ErrorCode> = {
  REVIEW_FORBIDDEN: 'REVIEW_FORBIDDEN',
  REVIEW_NOT_ELIGIBLE: 'REVIEW_NOT_ELIGIBLE',
  REVIEW_DUPLICATE_REQUEST: 'REVIEW_ALREADY_EXISTS',
  REVIEW_CONTENT_INVALID: 'VALIDATION_FAILED',
  REVIEW_NOT_FOUND: 'REVIEW_NOT_FOUND',
  REVIEW_SCHEMA_NOT_DEPLOYED: 'INTERNAL',
  SUPPORT_BOOKING_NOT_ELIGIBLE: 'SUPPORT_BOOKING_NOT_ELIGIBLE',
  SUPPORT_CATEGORY_INVALID: 'VALIDATION_FAILED',
  SUPPORT_CONTENT_INVALID: 'VALIDATION_FAILED',
  SUPPORT_CASE_LIMIT_REACHED: 'SUPPORT_CASE_LIMIT_REACHED',
};

const asApiError = (error: unknown): unknown => {
  const candidate = error as { code?: string; message?: string; status?: number } | null;
  if (candidate?.code && CODE[candidate.code]) {
    return new ApiError(CODE[candidate.code], candidate.message);
  }
  return error;
};

// ─── Handlers ─────────────────────────────────────────────────────────────────

/**
 * A Firebase uid is 28 URL-safe characters, but Servana also holds uids minted
 * by other paths, so this checks a permissive SHAPE rather than a length: it
 * exists to keep control characters and path fragments out of a query, not to
 * authenticate anything.
 */
const readProviderUid = (req: Request): string => {
  const uid = String(req.params.providerUid ?? '');
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(uid)) {
    throw ApiError.validation('providerUid is not a valid identifier.');
  }
  return uid;
};

export const handlers: V1Handlers = {
  /**
   * A provider's PUBLISHED reviews. Unchanged from TAB 01.
   *
   * The projection is already right: rating, comment and provider response
   * only - no customer identity, and visibility, publication state and
   * moderation state are all filtered server-side.
   */
  'reviews.provider.list': async (req: Request, res: Response) => {
    try {
      const providerUid = readProviderUid(req);
      const page = readPage(req, { defaultLimit: 20, maxLimit: 50 });

      const result = await reviewService.listProviderReviews(providerUid, page.limit, page.offset);
      const reviews = result?.reviews ?? [];
      const total = typeof result?.total === 'number' ? result.total : null;

      return ok(res, req, { reviews }, { page: pageMeta(page, reviews.length, total) });
    } catch (error) {
      return sendCaught(res, req, 'reviews.provider.list', error);
    }
  },

  /**
   * The rating summary. Unchanged from TAB 01, and the reason the command's
   * `/providers/:providerId/rating-summary` needed no new route: this IS it,
   * backend-derived by `ratingAggregationService`, and every seat reads it.
   */
  'reviews.provider.rating': async (req: Request, res: Response) => {
    try {
      const providerUid = readProviderUid(req);
      const aggregate = await reviewService.getProviderAggregate(providerUid);
      return ok(res, req, aggregate);
    } catch (error) {
      return sendCaught(res, req, 'reviews.provider.rating', error);
    }
  },

  /**
   * Review a completed booking.
   *
   * The provider is resolved from the booking's COMPLETED assignment inside the
   * domain service. There is no provider field in the request, so §122 holds by
   * construction rather than by validation.
   *
   * A `clientRequestId` replays the original review rather than creating a
   * second — the service takes an advisory lock on (customer, booking) and
   * checks for an existing review inside the same transaction, so two devices
   * submitting at once produce one review.
   */
  'bookings.review.create': async (req: Request, res: Response) => {
    try {
      const customerUid = uidOf(req);
      const bookingId = bookingIdOf(req);
      const body = bodyOf(req);

      const review = await reviewService.createReview({
        bookingId: String(bookingId),
        customerUid,
        overallRating: Number(body.overallRating),
        dimensions: (body.dimensions ?? {}) as Record<string, number>,
        publicComment: typeof body.publicComment === 'string' ? body.publicComment : null,
        privateFeedback: typeof body.privateFeedback === 'string' ? body.privateFeedback : null,
        visibility: typeof body.visibility === 'string' ? body.visibility : 'PUBLIC',
        clientRequestId: typeof body.clientRequestId === 'string' ? body.clientRequestId : null,
      });

      return created(res, req, review);
    } catch (error) {
      return sendCaught(res, req, 'bookings.review.create', asApiError(error));
    }
  },

  /**
   * The review this caller wrote for this booking, plus the eligibility verdict
   * when there is none.
   *
   * Returning eligibility on the same read is deliberate: a client rendering a
   * "leave a review" screen needs to know whether it may, and asking twice means
   * a screen that offers a form the next call refuses. When a review exists it
   * carries the private feedback — which the provider and public projections
   * never do, and which is the reason this is a separate read rather than a
   * filter over the provider list.
   */
  'bookings.review.get': async (req: Request, res: Response) => {
    try {
      const customerUid = uidOf(req);
      const bookingId = bookingIdOf(req);

      const review = await reviewService.getReviewByBooking(String(bookingId), customerUid);
      if (review) return ok(res, req, { review, eligibility: null });

      const eligibility = await reviewService.getReviewEligibility(
        String(bookingId),
        customerUid,
      );
      return ok(res, req, { review: null, eligibility });
    } catch (error) {
      return sendCaught(res, req, 'bookings.review.get', asApiError(error));
    }
  },

  /**
   * Raise a support case about a concluded booking.
   *
   * A BILLING category is accepted and ROUTED to the finance domain: the
   * response carries `routedTo: 'finance'` and names the endpoint that actually
   * issues refunds. Handling it here would fork the refund rules into a second,
   * weaker path beside the one reconciliation checks.
   */
  'bookings.supportCases.create': async (req: Request, res: Response) => {
    try {
      const customerUid = uidOf(req);
      const bookingId = bookingIdOf(req);
      const body = bodyOf(req);

      const supportCase = await support.createSupportCase({
        bookingId,
        customerUid,
        category: String(body.category ?? ''),
        summary: String(body.summary ?? ''),
        detail: typeof body.detail === 'string' ? body.detail : null,
        clientRequestId: typeof body.clientRequestId === 'string' ? body.clientRequestId : null,
      });

      return created(res, req, supportCase);
    } catch (error) {
      return sendCaught(res, req, 'bookings.supportCases.create', asApiError(error));
    }
  },

  /** The cases this caller raised on this booking. Owner-scoped in SQL. */
  'bookings.supportCases.list': async (req: Request, res: Response) => {
    try {
      const customerUid = uidOf(req);
      const bookingId = bookingIdOf(req);
      return ok(res, req, await support.listSupportCases(bookingId, customerUid));
    } catch (error) {
      return sendCaught(res, req, 'bookings.supportCases.list', asApiError(error));
    }
  },
};
