/**
 * Which origin a PayMongo checkout returns the payer to.
 *
 * One `PAYMONGO_RETURN_URL` cannot serve five clients. This resolves the return
 * origin PER REQUEST from the caller's `Origin` header, matched against a
 * server-side allowlist.
 *
 * Three properties, all deliberate:
 *
 * 1. **The caller's string is never used** — only the allowlist entry it
 *    matched. A forged `Origin` cannot send a payment return anywhere new, so
 *    this is not an open redirect. Never change this to echo the header.
 * 2. **No `Origin` header resolves to the configured default.** Native mobile
 *    sends none (verified: neither ServanaClient nor ServanaWorker sets one,
 *    and the Dart HTTP client does not add one), and the scheduler's payment
 *    retry job has no request at all. Both keep today's exact behaviour by
 *    construction, not by a value someone has to remember to set correctly.
 * 3. **An unrecognised origin resolves to the default too** — never a 4xx.
 *    Resolution failure must not be able to fail a checkout that works today.
 *
 * An origin belongs here only if it actually SERVES `/payment-success` and
 * `/payment-cancel`. The admin portal can start a checkout for support-assisted
 * recovery but hosts no return pages, so it is deliberately absent and falls to
 * the default.
 */

const PRODUCTION_RETURN_ORIGINS = [
  // Customer web portal — src/app/app.routes.ts declares both return routes.
  "https://client.servana.com.ph",
];

// Only honoured outside production, mirroring getReturnUrl's localhost carve-out.
const DEVELOPMENT_RETURN_ORIGINS = [
  "http://localhost:4200",
];

export const paymentReturnOriginAllowlist = (): string[] =>
  process.env.NODE_ENV === "production"
    ? [...PRODUCTION_RETURN_ORIGINS]
    : [...PRODUCTION_RETURN_ORIGINS, ...DEVELOPMENT_RETURN_ORIGINS];

/**
 * The allowlisted origin for this request, or `undefined` to mean "use the
 * configured default". Undefined is the safe answer and the common one.
 */
export const resolvePaymentReturnOrigin = (
  req?: { headers?: Record<string, unknown> } | null,
): string | undefined => {
  const header = req?.headers?.origin;
  if (typeof header !== "string" || !header) return undefined;

  // Normalise through the URL parser so "https://client.servana.com.ph:443/"
  // and a trailing slash cannot defeat the comparison, and so a malformed
  // header is rejected rather than string-matched.
  let candidate: string;
  try {
    candidate = new URL(header.trim()).origin;
  } catch {
    return undefined;
  }

  return paymentReturnOriginAllowlist().find((allowed) => {
    try {
      return new URL(allowed).origin === candidate;
    } catch {
      return false;
    }
  });
};
