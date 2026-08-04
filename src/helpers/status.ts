/**
 * Legacy response envelope helpers.
 *
 * The shape here — `{ status: 'success', data }` / `{ status: 'error', error }`
 * — is a protected contract. Both Flutter apps read it directly:
 *   ServanaWorker  servana_api.dart:107   data['message'] ?? data['error']
 *   ServanaClient  http_backend.dart:100  body['error'] as String?
 * so `error` must stay a STRING (ServanaClient casts it) and the keys must not
 * move. Do not "modernise" this into the `{ success, message, data }` envelope
 * in utils/apiResponse.ts — that is a different, newer contract, and swapping
 * them would break both apps (§4, §63).
 *
 * ── Why these are functions and not the two shared objects they replace ──────
 * This module used to export two mutable module-level singletons:
 *
 *     const successMessage = { status: 'success' };   // then: successMessage.data = x
 *     const errorMessage   = { status: 'error'   };   // then: errorMessage.error = y
 *
 * Every handler mutated the same object and sent it. Nothing was interleaving
 * today — each site assigned and sent in one synchronous block — but the value
 * SURVIVED the response, so any future path that sent without assigning first
 * would have shipped the previous request's `data` or `error` to whoever asked
 * next. That is a cross-user disclosure waiting for one careless edit (§11), and
 * it costs nothing to remove: build a fresh object per response.
 *
 * ── Why `error` no longer carries the exception ─────────────────────────────
 * The old code did `errorMessage.error = "ERROR: " + error`, which put driver
 * and SQL text — constraint names, column names, occasionally row values — into
 * a field both mobile apps render as the user-facing message. A customer whose
 * address failed to save was shown the Postgres unique-violation text. §21
 * forbids exactly this. The real exception now goes to the server log with a
 * request id; the client gets a safe sentence and that id.
 */

const status = {
    success: 200,
    error: 500,
    notfound: 404,
    unauthorized: 401,
    conflict: 409,
    created: 201,
    bad: 400,
    nocontent: 204
};

export interface LegacySuccessEnvelope { status: 'success'; data?: unknown; }
export interface LegacyErrorEnvelope { status: 'error'; error: string; requestId?: string; }

/** What a caller sees when we have nothing safe and specific to tell them. */
export const GENERIC_FAILURE_MESSAGE =
    'Something went wrong on our side. Please try again.';

/** Fresh success envelope. Never reuse one across requests. */
export function buildSuccess(data?: unknown): LegacySuccessEnvelope {
    return data === undefined ? { status: 'success' } : { status: 'success', data };
}

/**
 * Fresh error envelope carrying a safe message only.
 *
 * `safeMessage` must be something we are willing to show a customer. Pass a
 * domain message when one exists ("This address is already saved"); omit it and
 * the caller gets the generic sentence.
 */
export function buildError(safeMessage?: string, requestId?: string): LegacyErrorEnvelope {
    const envelope: LegacyErrorEnvelope = {
        status: 'error',
        error: safeMessage || GENERIC_FAILURE_MESSAGE,
    };
    if (requestId) { envelope.requestId = requestId; }
    return envelope;
}

let failureCounter = 0;

/**
 * Records the real exception server-side and returns a correlation id.
 *
 * The id is the only part of the failure that reaches the client, which is what
 * makes it useful: support can find the log line without the user having to
 * relay a stack trace they should never have seen.
 */
export function logFailure(context: string, error: unknown): string {
    failureCounter = (failureCounter + 1) % 1_000_000;
    const requestId = `req_${Date.now().toString(36)}_${failureCounter.toString(36)}`;
    // eslint-disable-next-line no-console
    console.error(`[${requestId}] ${context}:`, error);
    return requestId;
}

/**
 * Log the exception, then send the legacy error envelope with a safe message.
 * One call replaces the old two-line `errorMessage.error = ...; res.send(...)`.
 */
export function sendFailure(
    res: { status: (code: number) => { send: (body: unknown) => unknown } },
    context: string,
    error: unknown,
    opts: { httpStatus?: number; safeMessage?: string } = {},
): unknown {
    const requestId = logFailure(context, error);
    return res
        .status(opts.httpStatus ?? status.error)
        .send(buildError(opts.safeMessage, requestId));
}

export {
    status
};
