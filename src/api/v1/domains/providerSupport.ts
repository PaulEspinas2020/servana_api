/**
 * v1 provider SUPPORT CASES and the REVIEW WRITE surface.
 *
 * ## Three things called "support cases", and they are three resources
 *
 * The Master Command warns that a shared noun must not drive a migration, and
 * this is the cluster where the warning earns its place. Measured here:
 *
 *   1. `POST /api/v1/bookings/{id}/support-cases` — already canonical, backed by
 *      `services/reviews/postServiceSupportService`. It is the CUSTOMER's
 *      post-service complaint about a booking.
 *   2. `/api/provider/support/cases` — `providerSupportCaseService`. The
 *      PROVIDER's own case with Servana. Different actor, different service,
 *      different audience, and not bound to a booking at all.
 *   3. `/api/provider/support/tickets` — `notificationService`. An older and
 *      much thinner surface: a subject and a message, no category, no thread,
 *      no attachment, no appeal. Superseded by (2), which is what the route file
 *      already says.
 *
 * Matching (2) onto (1) on the words "support cases" would file a provider's
 * complaint about Servana into a customer's complaint about a booking — under a
 * `bookingId` the provider may not even have. The client's own classifier
 * already made a near-miss of the same shape, matching
 * `support/cases/{id}/messages` onto `/v1/conversations/{id}/messages` on the
 * word "messages".
 *
 * A support case is NOT a customer conversation either. Different audience,
 * different retention, different authorization: a conversation is scoped by
 * membership of a booking, a case by ownership of the case.
 *
 * ## Everything here is the caller's own
 *
 * Every function takes the uid from the token and every query scopes on it.
 * `caseId`, `reviewId` and `attachmentId` are RESOURCES, not identities — a
 * resource belonging to somebody else is a 404, never a target.
 */

import { Request, Response } from 'express';
import * as support from '../../../services/providerSupportCaseService';
import * as reputation from '../../../services/providerReputationService';
import { ok, created, sendCaught } from '../envelope';
import { ApiError, V1ErrorCode } from '../errors';
import { V1Handlers } from '../types';

const uidOf = (req: Request): string => {
  const uid = (req as any).user?.uid as string | undefined;
  if (!uid) throw new ApiError('UNAUTHENTICATED', 'Authentication is required.');
  return uid;
};

const bodyOf = (req: Request): Record<string, unknown> =>
  (req.body ?? {}) as Record<string, unknown>;

/**
 * A resource id, bounded and character-classed before it reaches a query.
 *
 * A malformed id answers NOT_FOUND rather than VALIDATION_FAILED, matching the
 * ownership refusals below: the difference between the two would tell a caller
 * which ids are well-formed, which is half of knowing which ones exist.
 */
const idOf = (req: Request, name: string): string => {
  const raw = String(req.params[name] ?? '').trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(raw)) {
    throw new ApiError('NOT_FOUND', 'Not found.');
  }
  return raw;
};

const CODE: Record<string, V1ErrorCode> = {
  SUPPORT_CASE_NOT_FOUND: 'NOT_FOUND',
  SUPPORT_CASE_INVALID: 'VALIDATION_FAILED',
  SUPPORT_CASE_STATE_INVALID: 'CONFLICT',
  REVIEW_NOT_FOUND: 'NOT_FOUND',
  REVIEW_RESPONSE_EXISTS: 'CONFLICT',
  REVIEW_INVALID: 'VALIDATION_FAILED',
};

const STATUS_CODE: Record<number, V1ErrorCode> = {
  400: 'VALIDATION_FAILED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'VALIDATION_FAILED',
  429: 'RATE_LIMITED',
};

const asApiError = (error: unknown): unknown => {
  const candidate = error as { code?: string; message?: string; statusCode?: number } | null;
  if (candidate?.code && CODE[candidate.code]) {
    return new ApiError(CODE[candidate.code], candidate.message);
  }
  if (candidate?.statusCode && STATUS_CODE[candidate.statusCode]) {
    return new ApiError(STATUS_CODE[candidate.statusCode], candidate.message);
  }
  return error;
};

export const handlers: V1Handlers = {
  /** The case categories a provider may open a case under. Static per deployment. */
  'provider.support.categories': async (req: Request, res: Response) => {
    try {
      return ok(res, req, await support.listCategories());
    } catch (error) {
      return sendCaught(res, req, 'provider.support.categories', asApiError(error));
    }
  },

  /** The caller's own cases. Never another provider's. */
  'provider.support.cases.list': async (req: Request, res: Response) => {
    try {
      return ok(res, req, await support.listCases(uidOf(req), req.query as Record<string, unknown>));
    } catch (error) {
      return sendCaught(res, req, 'provider.support.cases.list', asApiError(error));
    }
  },

  /** One case, with its thread. Somebody else's id is a 404. */
  'provider.support.cases.get': async (req: Request, res: Response) => {
    try {
      return ok(res, req, await support.getCase(uidOf(req), idOf(req, 'caseId')));
    } catch (error) {
      return sendCaught(res, req, 'provider.support.cases.get', asApiError(error));
    }
  },

  /** Open a case with Servana. NOT a customer conversation and not a booking complaint. */
  'provider.support.cases.create': async (req: Request, res: Response) => {
    try {
      return created(res, req, await support.createCase(uidOf(req), bodyOf(req)));
    } catch (error) {
      return sendCaught(res, req, 'provider.support.cases.create', asApiError(error));
    }
  },

  /**
   * Add a message to the case thread.
   *
   * This is the operation the client's classifier nearly matched onto
   * `/v1/conversations/{id}/messages`. It is not that: a case thread is between
   * a provider and Servana, and a conversation is between a provider and a
   * customer about a booking. Same word, different audience, different
   * retention, different authorization.
   */
  'provider.support.cases.reply': async (req: Request, res: Response) => {
    try {
      return created(res, req, await support.addProviderMessage(
        uidOf(req), idOf(req, 'caseId'), bodyOf(req),
      ));
    } catch (error) {
      return sendCaught(res, req, 'provider.support.cases.reply', asApiError(error));
    }
  },

  /** Withdraw a case the provider no longer wants worked. */
  'provider.support.cases.withdraw': async (req: Request, res: Response) => {
    try {
      return ok(res, req, await support.withdrawCase(uidOf(req), idOf(req, 'caseId'), bodyOf(req)));
    } catch (error) {
      return sendCaught(res, req, 'provider.support.cases.withdraw', asApiError(error));
    }
  },

  /** Reopen a closed case rather than opening a second one about the same thing. */
  'provider.support.cases.reopen': async (req: Request, res: Response) => {
    try {
      return ok(res, req, await support.reopenCase(uidOf(req), idOf(req, 'caseId'), bodyOf(req)));
    } catch (error) {
      return sendCaught(res, req, 'provider.support.cases.reopen', asApiError(error));
    }
  },

  /** Appeal the outcome of a case. A second decision, not a second case. */
  'provider.support.cases.appeal': async (req: Request, res: Response) => {
    try {
      return created(res, req, await support.appealCase(uidOf(req), idOf(req, 'caseId'), bodyOf(req)));
    } catch (error) {
      return sendCaught(res, req, 'provider.support.cases.appeal', asApiError(error));
    }
  },

  /**
   * Attach a file to a case.
   *
   * A THIRD upload surface, and deliberately not merged with job evidence or
   * chat attachments. Case attachments have their own audience (Servana review),
   * their own retention and their own preview authorization — the preview
   * re-checks ownership and mints a short-lived URL rather than returning a
   * storage path.
   */
  'provider.support.cases.attach': async (req: Request, res: Response) => {
    try {
      return created(res, req, await support.uploadAttachment(
        uidOf(req), idOf(req, 'caseId'), bodyOf(req),
      ));
    } catch (error) {
      return sendCaught(res, req, 'provider.support.cases.attach', asApiError(error));
    }
  },

  /** A short-lived URL for one attachment, after re-authorizing the caller. */
  'provider.support.cases.attachmentPreview': async (req: Request, res: Response) => {
    try {
      return ok(res, req, await support.previewAttachment(
        uidOf(req), idOf(req, 'caseId'), idOf(req, 'attachmentId'),
      ));
    } catch (error) {
      return sendCaught(res, req, 'provider.support.cases.attachmentPreview', asApiError(error));
    }
  },

  // ── Reviews: the WRITE surface v1 was missing ──────────────────────────────

  /**
   * The caller's own reputation summary.
   *
   * NOT `/v1/provider/earnings/summary`, which the client's classifier matched
   * it against on the word "summary". One is a rating aggregate and the other is
   * money; they share nothing but a noun.
   */
  'provider.reputation.summary': async (req: Request, res: Response) => {
    try {
      return ok(res, req, await reputation.getProviderReputationSummary(uidOf(req)));
    } catch (error) {
      return sendCaught(res, req, 'provider.reputation.summary', asApiError(error));
    }
  },

  /** Reviews left about the caller. The provider's own view, with response state. */
  'provider.reviews.list': async (req: Request, res: Response) => {
    try {
      return ok(res, req, await reputation.listOwnedProviderReviews(
        uidOf(req), req.query as Record<string, unknown>,
      ));
    } catch (error) {
      return sendCaught(res, req, 'provider.reviews.list', asApiError(error));
    }
  },

  /** One review about the caller. */
  'provider.reviews.get': async (req: Request, res: Response) => {
    try {
      return ok(res, req, await reputation.getOwnedProviderReview(uidOf(req), idOf(req, 'reviewId')));
    } catch (error) {
      return sendCaught(res, req, 'provider.reviews.get', asApiError(error));
    }
  },

  /**
   * Respond to a review.
   *
   * PUBLIC-FACING TEXT, so the moderation that applies to it applies on day one
   * rather than being added later — `providerResponseNeedsModeration` runs on
   * the same body before it is published, which is why this is a delegation and
   * not a reimplementation.
   */
  'provider.reviews.respond': async (req: Request, res: Response) => {
    try {
      const body = bodyOf(req);
      return created(res, req, await reputation.submitProviderResponse(
        uidOf(req), idOf(req, 'reviewId'),
        { body: body.body, clientRequestId: body.clientRequestId },
      ));
    } catch (error) {
      return sendCaught(res, req, 'provider.reviews.respond', asApiError(error));
    }
  },

  /** Report a review as breaching policy. A request for review, not a removal. */
  'provider.reviews.report': async (req: Request, res: Response) => {
    try {
      const body = bodyOf(req);
      return created(res, req, await reputation.reportOwnedReview(
        uidOf(req), idOf(req, 'reviewId'),
        { reason: body.reason, details: body.details, clientRequestId: body.clientRequestId },
      ));
    } catch (error) {
      return sendCaught(res, req, 'provider.reviews.report', asApiError(error));
    }
  },

  /**
   * Appeal a moderation decision about a review.
   *
   * Keyed on the moderation CASE id, not the review id — the thing being
   * appealed is the decision, and a review can carry more than one over time.
   */
  'provider.reviews.appeal': async (req: Request, res: Response) => {
    try {
      const body = bodyOf(req);
      return created(res, req, await reputation.appealOwnedReview(
        uidOf(req), idOf(req, 'caseId'),
        { ground: body.ground, explanation: body.explanation, clientRequestId: body.clientRequestId },
      ));
    } catch (error) {
      return sendCaught(res, req, 'provider.reviews.appeal', asApiError(error));
    }
  },
};
