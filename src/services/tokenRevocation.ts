import { getAuth as getAuthAdmin } from "firebase-admin/auth";
import { firebaseAdmin } from "../middleware/firebaseApp";

const auth = () => getAuthAdmin(firebaseAdmin);

/**
 * Rejects ID tokens issued before a revocation.
 *
 * Command 7 §20. `revokeAllProviderSessions` and every password-reset path call
 * `revokeRefreshTokens`, which stops Firebase minting NEW id tokens — and does
 * nothing about the ones already out there. `verifyAuth` called
 * `verifyIdToken(idToken)` with no revocation check, so a device that had just
 * been signed out of every session kept full access to every protected route
 * until its current token expired.
 *
 * Firebase id tokens live one hour. So "sign out all devices", the control a
 * provider reaches for when they think their account is compromised, did not
 * take effect for up to an hour on the very device they were trying to remove.
 *
 * ── Why not simply pass checkRevoked: true ─────────────────────────────────
 * `verifyIdToken(token, true)` fetches the whole user record from Firebase on
 * EVERY request. Signature verification is local (public keys are cached); the
 * revocation check is a network round trip. Putting one in front of every
 * protected call is how a security fix becomes a latency incident and gets
 * reverted.
 *
 * This does the same comparison against a cached `tokensValidAfterTime`:
 *
 *   token.auth_time < tokensValidAfterTime  →  revoked
 *
 * The cache is the honest part of the design. It bounds how stale the answer
 * can be, and the bound is documented rather than accidental:
 *
 *   - A revocation performed by THIS process invalidates the entry
 *     immediately, so the common case — provider taps "sign out all devices" —
 *     takes effect on the next request.
 *   - A revocation performed elsewhere (another instance, the Firebase
 *     console, a support tool) takes effect within REVOCATION_TTL_MS.
 *
 * Production runs a single PM2 instance today, so the second case is the
 * console and support tooling. If the API is ever scaled horizontally, this
 * window becomes the norm rather than the exception — see
 * docs/SESSION_THREAT_MODEL.md.
 */

/** How long a `tokensValidAfterTime` reading may be reused. */
export const REVOCATION_TTL_MS = 60_000;

type Entry = { validAfterMs: number; readAt: number };

const cache = new Map<string, Entry>();

/**
 * Marks a uid's revocation state as unknown, forcing the next check to re-read.
 *
 * Called by whatever performs a revocation. Without this the process that just
 * revoked would keep honouring its own stale cache entry for a further minute —
 * the one case where the delay is both avoidable and least excusable.
 */
export function noteRevoked(uid: string): void {
  cache.delete(uid);
}

/** Test seam. The cache is module-global and would leak between tests. */
export function __clearRevocationCache(): void {
  cache.clear();
}

async function validAfterMs(uid: string, now: number): Promise<number> {
  const hit = cache.get(uid);
  if (hit && now - hit.readAt < REVOCATION_TTL_MS) return hit.validAfterMs;

  const user = await auth().getUser(uid);
  // Absent for an account that has never been revoked, which is most of them.
  const parsed = user.tokensValidAfterTime
    ? Date.parse(user.tokensValidAfterTime)
    : 0;
  const validAfter = Number.isFinite(parsed) ? parsed : 0;

  cache.set(uid, { validAfterMs: validAfter, readAt: now });

  // Bounded so a long-running process cannot accumulate an entry per account
  // that has ever authenticated. Swept rather than cleared, so a burst does not
  // evict entries that are still warm.
  if (cache.size > 5_000) {
    for (const [k, v] of cache) {
      if (now - v.readAt >= REVOCATION_TTL_MS) cache.delete(k);
    }
  }

  return validAfter;
}

/**
 * Whether this decoded token was issued before its account was revoked.
 *
 * Fails CLOSED on a lookup error. A revocation check that cannot run is not
 * evidence the session is fine — and the alternative, admitting every request
 * during a Firebase blip, is precisely the hole this closes.
 */
export async function isRevoked(decoded: {
  uid: string;
  auth_time?: number;
}): Promise<boolean> {
  const now = Date.now();

  // `auth_time` is seconds since epoch, and is the moment the user actually
  // authenticated — NOT `iat`, which moves on every silent refresh. Comparing
  // iat would make a revoked session un-revoke itself the moment the client
  // refreshed, which is the exact behaviour being fixed.
  const authTime = typeof decoded.auth_time === "number" ? decoded.auth_time : null;

  try {
    const validAfter = await validAfterMs(decoded.uid, now);
    if (validAfter <= 0) return false;
    // A token with no auth_time cannot be shown to predate the revocation, and
    // an unprovable token is not a valid one once a revocation exists.
    if (authTime === null) return true;
    return authTime * 1000 < validAfter;
  } catch {
    return true;
  }
}
