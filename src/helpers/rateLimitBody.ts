/**
 * The body every rate limiter returns.
 *
 * `express-rate-limit` was configured with `{status:'error', message}` — the
 * message flat, no `error` object, no code. `adminError()` emits
 * `{status:'error', error:{code, message, kind, requestId}}` — the message
 * nested. Same discriminator, two incompatible layouts.
 *
 * So a client that branches on `status === 'error'` and then reads
 * `body.error.code` throws on every 429. That is the worst possible moment for
 * an unhandled exception: the client is already retrying, and a parse failure
 * there turns "slow down" into a crash loop that generates more requests.
 *
 * This emits BOTH layouts at once. `error.code` is there for a client following
 * the canonical contract; the flat `message` stays exactly where it was for the
 * clients already shipped and in the field. Neither can throw on the other.
 *
 * See SERVANA_PROVIDER_ERROR_CODES.md.
 */
export const rateLimitBody = (message: string) => ({
  status: 'error' as const,
  // Retained verbatim for already-installed clients that read the flat field.
  // Removing it is step 5 of the error migration, not step 2.
  message,
  error: {
    code: 'RATE_LIMITED' as const,
    message,
    fieldErrors: {},
    // The one canonical code that is genuinely retryable. A client that backs
    // off and retries is behaving correctly here, unlike on a 4xx.
    retryable: true,
  },
});
