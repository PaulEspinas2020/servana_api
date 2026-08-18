/**
 * Session lifecycle: end one, end all, and end them when a credential changes.
 *
 * ## Why this is a module and not three call sites
 *
 * Four places already revoke sessions — logout, the provider password change,
 * "sign out all devices", and admin security actions — and each does its own
 * combination of `revokeTokenInFirebase` plus whatever else it remembered.
 * `clearFcmToken` is in one of them. That is how a device keeps receiving push
 * notifications for an account it was just signed out of.
 *
 * One function per intent, so the set of side effects is decided once.
 *
 * ## What revocation can and cannot do
 *
 * Firebase has no per-session revocation: `revokeRefreshTokens` invalidates
 * every session for the uid. Ending "this device only" is not available and
 * pretending otherwise would be worse than saying so.
 *
 * Revocation stops Firebase minting NEW ID tokens and moves
 * `tokensValidAfterTime`. Tokens already issued stay cryptographically valid
 * for up to an hour — `middleware/verifyAuth` closes that window by comparing
 * `auth_time` against the cached `tokensValidAfterTime` on every request. So
 * revocation here is effective on the next request, not merely at the next
 * refresh, and that is only true because `tokenRevocation` exists.
 */

import * as firebaseFunction from './firebaseFunctions.service';
import { clearFcmToken } from './notification.service';
import { evictUserEverywhere } from '../chat/chat.realtime';

export type RevocationReason =
  | 'logout'
  | 'password_reset'
  | 'password_change'
  | 'identifier_change'
  | 'admin_action'
  | 'user_revoke_all';

export interface RevocationOutcome {
  uid: string;
  reason: RevocationReason;
  sessionsRevoked: boolean;
  pushCleared: boolean;
  /** Live chat sockets closed for this uid. See the note in `endAllSessions`. */
  realtimeSocketsClosed: number;
}

/**
 * Ends every session for an account.
 *
 * `Promise.allSettled`, deliberately: a failure to clear the FCM token must not
 * leave the sessions live. The two are independent and the security-relevant
 * one is the revocation.
 *
 * Never throws. A caller that has just reset a password cannot undo it, so
 * turning a revocation failure into a 500 would report the reset as failed when
 * it succeeded — and the person would try again with a code that is now spent.
 * The outcome is returned so the caller can log it.
 */
export async function endAllSessions(
  uid: string,
  reason: RevocationReason,
): Promise<RevocationOutcome> {
  const [revoke, push] = await Promise.allSettled([
    firebaseFunction.revokeTokenInFirebase(uid),
    clearFcmToken(uid),
  ]);

  /**
   * The chat socket outlives the token, and that is the gap this closes (§86).
   *
   * Revoking refresh tokens stops the NEXT request. A Socket.IO connection
   * authenticated at handshake is already open: it stays in its conversation
   * rooms and keeps receiving that account's messages after the person signed
   * out or switched accounts — which is precisely the state in which a cached
   * transcript gets rendered under somebody else's identity.
   *
   * Synchronous and in-process, so it cannot fail the revocation. Its counterpart
   * is `SESSION_HYGIENE` in the messaging policy: the server evicts and says why,
   * and the client drops its account-scoped chat state when told.
   */
  let realtimeSocketsClosed = 0;
  try {
    realtimeSocketsClosed = evictUserEverywhere(uid, reason);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[auth-session] chat socket eviction failed:', (error as Error)?.message);
  }

  const outcome: RevocationOutcome = {
    uid,
    reason,
    sessionsRevoked: revoke.status === 'fulfilled',
    pushCleared: push.status === 'fulfilled',
    realtimeSocketsClosed,
  };

  if (!outcome.sessionsRevoked) {
    // eslint-disable-next-line no-console
    console.error(`[auth-session] revoke failed uid=${uid.slice(0, 6)}*** reason=${reason}`);
  }

  return outcome;
}

/**
 * Ends every session because the credential changed.
 *
 * ## Why this exists as its own name
 *
 * `authService.resetPassword` did not revoke anything. Firebase's own
 * `confirmPasswordReset` is widely believed to revoke refresh tokens, and it
 * may well do so — but "widely believed" is not a control, and the behaviour
 * was never verified against this project's Firebase configuration. A password
 * reset is the single action a person takes when they think someone else is in
 * their account, and the one where an inherited assumption is least acceptable.
 *
 * Calling it explicitly costs one request on a rare path and removes the
 * dependency on unverified third-party behaviour. It is idempotent: if Firebase
 * already revoked, this revokes again and `tokensValidAfterTime` simply moves
 * forward.
 */
export async function endSessionsOnCredentialChange(
  uid: string,
  reason: Extract<RevocationReason, 'password_reset' | 'password_change' | 'identifier_change'>,
): Promise<RevocationOutcome> {
  return endAllSessions(uid, reason);
}
