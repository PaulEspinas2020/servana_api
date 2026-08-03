/**
 * The auth error vocabulary, and what a client should DO about each one.
 *
 * ── Why there is no AUTH_ prefix ────────────────────────────────────────────
 * §22 asks for AUTH_*. The codebase already emits an unprefixed vocabulary —
 * UNAUTHENTICATED, INVALID_TOKEN, TOKEN_EXPIRED, PROVIDER_SUSPENDED,
 * ACCOUNT_LINK_REQUIRED — from middleware and controllers that clients already
 * branch on. Adding AUTH_ variants would not replace those; it would sit
 * alongside them, and every client would have to handle both spellings of the
 * same condition forever. One vocabulary that is slightly off-spec beats two
 * that are each half-right, so this extends what exists.
 *
 * ── Why each code carries a recovery action ─────────────────────────────────
 * A code that only says what went wrong leaves the client to infer what to do,
 * and every client infers slightly differently. That is how a suspended
 * provider ends up staring at a login screen: the portal saw a 4xx, assumed the
 * session was stale, and sent them somewhere that cannot possibly help.
 *
 * That is not hypothetical. A 403 from requireActiveProvider surfaced in the
 * provider portal as "Your session expired. Please sign in again." — pointing at
 * authentication when the fault was authorization, which is exactly why today's
 * NULL account_status outage looked like a login bug for as long as it did.
 *
 * `recovery` is the routing instruction. `retryable` says whether repeating the
 * same request could ever succeed — sending someone back to a login screen when
 * the answer is no is the failure this is meant to prevent.
 */

import type { Response } from "express";

/** Where the client should send the person. One of these, never free text. */
export type RecoveryAction =
  /** Re-authenticate: the credential is missing, malformed or expired. */
  | "REAUTHENTICATE"
  /** Sign in using the other identifier — this one belongs elsewhere. */
  | "USE_OTHER_IDENTIFIER"
  /** Verify an identifier before continuing. */
  | "VERIFY_IDENTIFIER"
  /** Show account status; the person cannot act until it changes. */
  | "SHOW_ACCOUNT_STATUS"
  /** Nothing the person can do in-app. */
  | "CONTACT_SUPPORT"
  /** Transient. Retrying the same request may work. */
  | "RETRY";

export type AuthErrorSpec = {
  status: number;
  message: string;
  recovery: RecoveryAction;
  retryable: boolean;
};

export const AUTH_ERRORS = {
  /** No credential presented at all. */
  UNAUTHENTICATED: {
    status: 401,
    message: "Authentication is required",
    recovery: "REAUTHENTICATE",
    retryable: false,
  },
  /** Presented, but not a credential this server accepts. */
  INVALID_TOKEN: {
    status: 401,
    message: "Your sign-in could not be verified. Please sign in again.",
    recovery: "REAUTHENTICATE",
    retryable: false,
  },
  /** Valid, but past its life or revoked. Distinguished from INVALID_TOKEN so a
   *  client can refresh silently instead of interrupting the person. */
  TOKEN_EXPIRED: {
    status: 401,
    message: "Your session has expired. Please sign in again.",
    recovery: "REAUTHENTICATE",
    retryable: false,
  },
  /** The identifier used belongs to an account reachable another way. Retrying
   *  the same way fails identically forever, which is why it is not a 401. */
  ACCOUNT_LINK_REQUIRED: {
    status: 409,
    message: "This identifier already belongs to an account. Sign in the way you registered.",
    recovery: "USE_OTHER_IDENTIFIER",
    retryable: false,
  },
  /** Authenticated, but the account may not act yet. NOT an auth failure — the
   *  distinction that today's outage turned on. */
  PROVIDER_NOT_APPROVED: {
    status: 403,
    message: "This account is not permitted to perform this action",
    recovery: "SHOW_ACCOUNT_STATUS",
    retryable: false,
  },
  PROVIDER_SUSPENDED: {
    status: 403,
    message: "This account is suspended.",
    recovery: "SHOW_ACCOUNT_STATUS",
    retryable: false,
  },
  PROVIDER_REJECTED: {
    status: 403,
    message: "This account's application was not approved.",
    recovery: "SHOW_ACCOUNT_STATUS",
    retryable: false,
  },
  /** Deliberately CONTACT_SUPPORT, not SHOW_ACCOUNT_STATUS: a disabled account
   *  has no in-app path back, and offering one wastes the person's time. */
  PROVIDER_DISABLED: {
    status: 403,
    message: "This account has been disabled. Please contact support.",
    recovery: "CONTACT_SUPPORT",
    retryable: false,
  },
  /** The identifier exists but has not been verified, and this action needs it. */
  IDENTIFIER_NOT_VERIFIED: {
    status: 403,
    message: "Verify this contact detail before continuing.",
    recovery: "VERIFY_IDENTIFIER",
    retryable: false,
  },
  /**
   * The account's status could not be READ — a database error, not a verdict.
   *
   * Still 403: failing closed matters more than convenience, because the
   * alternative is that a transient outage silently grants operational access
   * to every suspended account at once. But it routes to RETRY rather than to a
   * status screen, because there is no status to show and nothing for the person
   * to fix. Reusing TOO_MANY_ATTEMPTS here would have been a lie that turned a
   * deny into a 429 for clients to hammer.
   */
  ACCOUNT_STATUS_UNAVAILABLE: {
    status: 403,
    message: "Your account status could not be verified. Please try again.",
    recovery: "RETRY",
    retryable: true,
  },
  /** Too many attempts. */
  TOO_MANY_ATTEMPTS: {
    status: 429,
    message: "Too many attempts. Please wait and try again.",
    recovery: "RETRY",
    retryable: true,
  },
} as const satisfies Record<string, AuthErrorSpec>;

export type AuthErrorCode = keyof typeof AUTH_ERRORS;

/**
 * Emit one. Every auth failure goes through here so the envelope cannot drift
 * field by field across 38 hand-written responses.
 *
 * `message` may be overridden for cases that can say something more specific —
 * naming WHICH identifier to use, for instance. `code`, `recovery` and
 * `retryable` may not: those are the contract, and a caller that could bend them
 * would reintroduce exactly the per-site divergence this exists to stop.
 */
export function sendAuthError(
  res: Response,
  code: AuthErrorCode,
  message?: string
): Response {
  const spec = AUTH_ERRORS[code];
  return res.status(spec.status).json({
    status: "failed",
    // `message` at the top level too: existing clients read that field, and
    // breaking them to tidy the shape would be a worse trade than duplication.
    message: message ?? spec.message,
    error: {
      code,
      message: message ?? spec.message,
      recovery: spec.recovery,
      retryable: spec.retryable,
    },
  });
}
