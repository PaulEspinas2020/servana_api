/**
 * The one v1 response and error standard.
 *
 * ## The shape
 *
 *   success  2xx   { "data": <T>, "meta"?: { ... } }
 *   failure  4xx/5xx { "error": { "code", "message", "details"?, "requestId" } }
 *
 * ## Why a third envelope rather than reusing one of the two we have
 *
 * The backend already ships two and they contradict each other:
 *
 *   helpers/status.ts   { status: 'success', data }   /  { status: 'error', error: <string> }
 *   utils/apiResponse.ts { success: true, message, data }
 *
 * plus a long tail of hand-built `{ success: false, message }` objects. Both
 * existing envelopes are protected contracts — ServanaClient casts `error` to
 * String, ServanaWorker reads `message ?? error` — so neither can be changed
 * and neither can be extended without ambiguity for the clients already
 * reading it. v1 is a new namespace with no installed readers, which is the
 * only moment a third shape costs nothing.
 *
 * The success body carries no `status`/`success` flag on purpose. The HTTP
 * status already says whether it worked; a second, independently-settable
 * signal is how `{ success: true }` bodies end up on 500s.
 *
 * ## Errors never carry the exception
 *
 * `fail()` and `sendCaught()` are the only ways a v1 route answers a failure,
 * and neither can be handed a raw exception message. An unrecognised throw
 * becomes INTERNAL plus a request id, and the real error goes to the log. This
 * is §21 enforced by the type system rather than by review.
 */

import { Request, Response } from 'express';
import { ApiError, V1ErrorCode, V1_ERROR_STATUS } from './errors';

export interface PageMeta {
  limit: number;
  offset: number;
  /**
   * The exact size of the filtered set. NEVER null — decided, not defaulted.
   *
   * TAB 06 of the Admin API Master Command: *"What is not acceptable is leaving
   * it undecided: the portal is currently correct only by luck."* The contract
   * said `integer | null`, with the note "null when the total is not cheaply
   * knowable"; every client that used it declared plain `number`, and no client
   * rendered anything for null.
   *
   * Measured before deciding, rather than picking the convenient answer. Four
   * call sites exist and none of them can produce null:
   *
   *   bookings.listMine       rows.length
   *   notifications.list      all.length
   *   provider.jobs.list      jobs.length
   *   reviews.provider.list   listProviderReviews -> COUNT(*)::int
   *
   * The `::int` cast is what makes the last one safe: int4 parses to a JS
   * number, where a bare `COUNT(*)` is bigint and node-postgres would hand back
   * a STRING. Proven against PGlite — `COUNT(*)::int` yields `3`, and `0` on an
   * empty set, both `typeof number`.
   *
   * So the nullable half was never reachable. It was a hedge against a cost
   * nothing in this API actually pays, and it obliged every client to render an
   * empty state for a case that never occurs.
   *
   * ## If a total ever DOES become expensive
   *
   * Do not reintroduce null. Send a capped or estimated number and add a
   * sibling `totalIsEstimate: boolean` beside it, as the book suggests. That
   * field is deliberately NOT added now: a flag no producer ever sets is a
   * foundation without callers, and clients would branch on something that is
   * always false.
   */
  total: number;
  hasMore: boolean;
}

export interface V1Meta {
  page?: PageMeta;
  [key: string]: unknown;
}

export interface V1Success<T = unknown> {
  data: T;
  meta?: V1Meta;
}

export interface V1Failure {
  error: {
    code: V1ErrorCode;
    message: string;
    details?: unknown;
    requestId: string;
  };
}

/** What a caller sees when there is nothing safe and specific to say. */
export const GENERIC_V1_MESSAGE =
  'Something went wrong on our side. Please try again.';

/**
 * The correlation id stamped on every request in app.ts.
 *
 * It is generated before routing, so it is present even for a request that
 * fails in middleware. Returned in the body AND as `X-Request-Id`, because a
 * client that cannot parse the body (a proxy 502, say) can still read a header.
 */
export const requestIdOf = (req: Request): string =>
  String((req as any).id ?? 'unknown');

export function ok<T>(res: Response, req: Request, data: T, meta?: V1Meta): Response {
  res.set('X-Request-Id', requestIdOf(req));
  const body: V1Success<T> = meta === undefined ? { data } : { data, meta };
  return res.status(200).json(body);
}

export function created<T>(res: Response, req: Request, data: T, meta?: V1Meta): Response {
  res.set('X-Request-Id', requestIdOf(req));
  const body: V1Success<T> = meta === undefined ? { data } : { data, meta };
  return res.status(201).json(body);
}

export function fail(
  res: Response,
  req: Request,
  code: V1ErrorCode,
  message?: string,
  details?: unknown,
): Response {
  res.set('X-Request-Id', requestIdOf(req));
  const body: V1Failure = {
    error: {
      code,
      message: message ?? GENERIC_V1_MESSAGE,
      ...(details === undefined ? {} : { details }),
      requestId: requestIdOf(req),
    },
  };
  return res.status(V1_ERROR_STATUS[code]).json(body);
}

/**
 * The single catch site for every v1 handler.
 *
 * An ApiError is a failure somebody deliberately made client-visible, so its
 * code and message are used. Anything else is a bug or a driver error: it is
 * logged whole, server-side, against the request id, and the caller is told
 * INTERNAL and nothing more.
 */
export function sendCaught(
  res: Response,
  req: Request,
  context: string,
  error: unknown,
): Response {
  if (error instanceof ApiError) {
    return fail(res, req, error.code, error.message, error.details);
  }
  // eslint-disable-next-line no-console
  console.error(`[${requestIdOf(req)}] v1:${context}:`, error);
  return fail(res, req, 'INTERNAL');
}

// ─── Pagination ───────────────────────────────────────────────────────────────

export interface PageParams {
  limit: number;
  offset: number;
}

/**
 * One pagination convention for every v1 list.
 *
 * Clamped, never NaN, never negative — `?offset=-1` reaching pg is how the
 * public review list currently turns a typo into a 500. `max` is per-endpoint
 * because a catalog page and an audit page have different sane ceilings.
 */
export function readPage(req: Request, opts: { defaultLimit?: number; maxLimit?: number } = {}): PageParams {
  const defaultLimit = opts.defaultLimit ?? 20;
  const maxLimit = opts.maxLimit ?? 100;

  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(maxLimit, Math.max(1, Math.trunc(rawLimit)))
    : defaultLimit;

  const rawOffset = Number(req.query.offset);
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.trunc(rawOffset)) : 0;

  return { limit, offset };
}

export function pageMeta(page: PageParams, returned: number, total: number): PageMeta {
  return {
    limit: page.limit,
    offset: page.offset,
    total,
    // One expression, because there is one case. The previous version branched
    // on `total === null` and inferred `hasMore` from a full page — a heuristic
    // that is wrong for a set whose size is an exact multiple of the limit, and
    // which never ran, because no caller ever passed null.
    hasMore: page.offset + returned < total,
  };
}

// ─── Idempotency (§17) ────────────────────────────────────────────────────────

export const IDEMPOTENCY_HEADER = 'idempotency-key';

/**
 * Validates the idempotency key's SHAPE only.
 *
 * Storing and replaying results is per-domain work — `services/bookingIdempotency.ts`
 * already does it for bookings and a mutation added to v1 must reuse that, not
 * reinvent it. What belongs here is the part every domain shares: one header
 * name, one accepted format, one error code, so a client does not have to
 * discover per-endpoint that its key was ignored.
 *
 * Returns the key, or null when absent. Throws when present and malformed —
 * silently ignoring a bad key is worse than rejecting it, because the caller
 * believes it is protected against a retry and is not.
 */
export function readIdempotencyKey(req: Request, opts: { required?: boolean } = {}): string | null {
  const raw = req.get(IDEMPOTENCY_HEADER);
  if (raw === undefined || raw === '') {
    if (opts.required) {
      throw new ApiError('IDEMPOTENCY_KEY_INVALID', 'An Idempotency-Key header is required for this request.');
    }
    return null;
  }
  if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(raw)) {
    throw new ApiError(
      'IDEMPOTENCY_KEY_INVALID',
      'Idempotency-Key must be 8-128 characters of A-Z a-z 0-9 and _ . : -',
    );
  }
  return raw;
}
