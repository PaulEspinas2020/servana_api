import { firebaseConfig } from "../config";

/**
 * Exchanges a Firebase refresh token for a fresh ID token.
 *
 * ## Why this exists
 *
 * `verifyAuth` validates the bearer header with `admin.auth().verifyIdToken()`,
 * so the credential every client carries is a Firebase **ID token, valid for one
 * hour**. Sign-in obtains one server-side (firebaseFunctions.service.ts) along
 * with a refresh token, but the response whitelist dropped the refresh token and
 * no endpoint existed to redeem one.
 *
 * The consequence was invisible for as long as only rarely used routes required
 * auth. Once the customer booking flow and the worker's job list moved behind
 * `verifyAuth`, it became: every mobile session dies after an hour, mid-journey,
 * and the app signs the user out because a 401 is indistinguishable from a
 * revoked session.
 *
 * Google's secure-token endpoint is the documented exchange and the same one the
 * Firebase client SDKs call internally. Doing it here rather than shipping the
 * Firebase Auth SDK into ServanaWorker keeps one definition of what a session is
 * — the app never talks to Firebase directly, which is already true of every
 * other call it makes.
 */

const SECURE_TOKEN_URL = "https://securetoken.googleapis.com/v1/token";

export class TokenRefreshError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 401 | 502,
    readonly code: "REFRESH_TOKEN_REQUIRED" | "REFRESH_TOKEN_INVALID" | "REFRESH_UNAVAILABLE",
  ) {
    super(message);
    this.name = "TokenRefreshError";
  }
}

export interface RefreshedSession {
  token: string;
  refreshToken: string;
  /** Seconds until `token` expires, as reported by Google. */
  expiresIn: number;
}

/**
 * Google answers `400 { error: { message: "TOKEN_EXPIRED" } }` for a refresh
 * token that is expired, revoked, or belongs to a disabled/deleted user. All of
 * those mean the same thing to a client — sign in again — so they collapse to a
 * single 401 rather than leaking which case applied (§21).
 */
const UNRECOVERABLE = new Set([
  "TOKEN_EXPIRED",
  "USER_DISABLED",
  "USER_NOT_FOUND",
  "INVALID_REFRESH_TOKEN",
  "INVALID_GRANT_TYPE",
  "MISSING_REFRESH_TOKEN",
]);

export const refreshIdToken = async (
  refreshToken: string | undefined | null,
): Promise<RefreshedSession> => {
  if (!refreshToken || typeof refreshToken !== "string" || !refreshToken.trim()) {
    throw new TokenRefreshError(
      "A refresh token is required",
      400,
      "REFRESH_TOKEN_REQUIRED",
    );
  }

  const apiKey = firebaseConfig.apiKey;
  if (!apiKey) {
    // Misconfiguration, not a client error. Answering 401 here would tell every
    // app in the field to sign its user out because of a missing env var.
    throw new TokenRefreshError(
      "Token refresh is unavailable",
      502,
      "REFRESH_UNAVAILABLE",
    );
  }

  let response: Response;
  try {
    response = await fetch(`${SECURE_TOKEN_URL}?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }).toString(),
    });
  } catch {
    // Network failure reaching Google. Transient — the client should retry with
    // the same refresh token, not discard the session.
    throw new TokenRefreshError(
      "Token refresh is unavailable",
      502,
      "REFRESH_UNAVAILABLE",
    );
  }

  const body: any = await response.json().catch(() => ({}));

  if (!response.ok) {
    const reason = String(body?.error?.message ?? "").toUpperCase();
    if (UNRECOVERABLE.has(reason) || response.status === 400) {
      throw new TokenRefreshError(
        "Session expired. Please log in again.",
        401,
        "REFRESH_TOKEN_INVALID",
      );
    }
    throw new TokenRefreshError(
      "Token refresh is unavailable",
      502,
      "REFRESH_UNAVAILABLE",
    );
  }

  const token = body?.id_token;
  const rotated = body?.refresh_token;
  if (typeof token !== "string" || !token) {
    throw new TokenRefreshError(
      "Token refresh is unavailable",
      502,
      "REFRESH_UNAVAILABLE",
    );
  }

  return {
    token,
    // Google may rotate the refresh token. Returning whichever is current — and
    // having the client store it — is what stops a long-lived session from
    // pinning a token that has since been replaced.
    refreshToken: typeof rotated === "string" && rotated ? rotated : refreshToken,
    expiresIn: Number(body?.expires_in) || 3600,
  };
};
