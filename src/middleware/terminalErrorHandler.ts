/**
 * The final Express error middleware (TAB 09).
 *
 * ## What was actually missing
 *
 * Everything else in TAB 09 was already built: `req.id` is stamped in app.ts,
 * `correlationMiddleware` adopts a caller-supplied id, `requestLog` emits
 * `http_requests_total` and `auth_failures_total`, and `observabilityPolicy`
 * supplies `redact()`, `routeTemplate()` and `statusClass()`. What did not exist
 * was a four-argument handler at the end of the chain, so ANY error that escaped
 * a route — a thrown TypeError, a rejected pg query, a JSON body that failed to
 * parse — fell through to Express's built-in handler.
 *
 * That default is the leak TAB 09 names: it replies with the error's `message`
 * and, when NODE_ENV is not 'production', the full stack. A pg error message
 * carries the SQL, the table, and the constraint name. Those are precisely the
 * four things the acceptance criterion forbids in a 5xx.
 *
 * ## Why this does not change any response shape
 *
 * The STOP condition is explicit: preserve legacy response fields until their
 * consumers migrate; improve internals without inventing a breaking envelope.
 *
 * So this handler only ever runs where NOTHING has replied. If a route already
 * sent its own error — every v1 handler does, via `sendCaught`, and the legacy
 * controllers have their own shapes — this is never reached. It cannot reshape
 * a response that has already gone out.
 *
 * It also does not invent a new envelope. A request under `/api/v1` gets the v1
 * failure envelope it already documents; anything else gets the minimal
 * `{ message, requestId }` that legacy clients already tolerate from a 500.
 *
 * ## Headers already sent
 *
 * If a handler streamed part of a response and then threw, the status and
 * headers are gone and there is no safe way to append an error body. Express's
 * own guidance is to delegate to the default handler, which closes the socket.
 * Writing JSON into a half-sent response would corrupt it instead.
 */

import type { ErrorRequestHandler, Request } from 'express';
import { GENERIC_V1_MESSAGE } from '../api/v1/envelope';
import { routeTemplate } from '../observability/observabilityPolicy';
import { incr } from '../observability/metrics';

/** The id stamped in app.ts, possibly replaced by a caller's correlation id. */
const requestIdOf = (req: Request): string => String((req as any).id ?? 'unknown');

/**
 * Status carried by an error that deliberately set one.
 *
 * Several services throw `Object.assign(new Error(msg), { statusCode, code })` —
 * `paymentService` does exactly this for its 503. Honouring that is what keeps a
 * deliberate 4xx from being reported as a server fault, which matters because
 * the alert policy pages on 5xx and not on 4xx.
 */
const intendedStatus = (err: any): number | null => {
  const raw = Number(err?.statusCode ?? err?.status);
  return Number.isInteger(raw) && raw >= 400 && raw <= 599 ? raw : null;
};

/**
 * Body-parser failures are the one class worth distinguishing.
 *
 * express.json() throws with `type: 'entity.parse.failed'` (or
 * 'entity.too.large'). Reporting malformed client JSON as a 500 both misleads
 * the caller and pages an operator for something no operator can fix.
 */
const isBodyParserError = (err: any): boolean =>
  typeof err?.type === 'string' && err.type.startsWith('entity.');

/**
 * Whether an error's own message may be shown to a caller.
 *
 * ONLY for errors that deliberately declared a status — i.e. the application
 * wrote that message for a caller. Anything else is a leak risk: a pg error's
 * message contains SQL and constraint names, and an axios error's can contain a
 * provider payload. Those get the generic text.
 */
const safeMessage = (err: any, status: number): string => {
  if (status >= 500) return GENERIC_V1_MESSAGE;
  const msg = err?.message;
  return typeof msg === 'string' && msg.length > 0 && msg.length <= 300
    ? msg
    : GENERIC_V1_MESSAGE;
};

export const terminalErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  // Half-sent response: hand back to Express, which destroys the socket. Any
  // JSON written here would be appended to a partial body.
  if (res.headersSent) return next(err);

  const requestId = requestIdOf(req as Request);
  const declared = intendedStatus(err);
  const status = declared ?? (isBodyParserError(err) ? 400 : 500);

  // Logged in full, server-side only. The stack never reaches the caller, but
  // losing it entirely would make a 500 undiagnosable.
  const route = routeTemplate((req as Request).path ?? '');
  if (status >= 500) {
    console.error(
      `[error] ${(req as Request).method} ${route} → ${status} requestId=${requestId}`,
      err,
    );
  } else {
    console.warn(
      `[error] ${(req as Request).method} ${route} → ${status} requestId=${requestId}: ${
        err?.message ?? 'unknown'
      }`,
    );
  }

  // Counted so an unhandled-error regression is visible per route, not just in
  // a log nobody reads. Wrapped: a metrics failure must not replace the reply.
  try {
    incr('http_requests_total', {
      route,
      method: String((req as Request).method ?? 'UNKNOWN'),
      status: String(status),
      unhandled: 'true',
    });
  } catch {
    /* metrics are best-effort */
  }

  res.set('X-Request-Id', requestId);

  const message = safeMessage(err, status);

  /**
   * v1 requests get the envelope v1 already documents. `INTERNAL` and
   * `VALIDATION_FAILED` are existing codes — this introduces none.
   */
  if (((req as Request).originalUrl ?? '').startsWith('/api/v1')) {
    res.status(status).json({
      error: {
        code: status >= 500 ? 'INTERNAL' : 'VALIDATION_FAILED',
        message,
        requestId,
      },
    });
    return;
  }

  // Legacy surface: the minimal shape these clients already receive from a 500.
  // Deliberately not the v1 envelope — that would be the breaking change the
  // STOP condition forbids.
  res.status(status).json({ message, requestId });
};
