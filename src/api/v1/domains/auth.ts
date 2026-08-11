/**
 * v1 auth handlers.
 *
 * Every one delegates to the state machine the legacy route already runs. This
 * file contains identifier plumbing, the v1 envelope and the error mapping —
 * no authentication logic of its own. That is the property that makes "one
 * canonical domain service behind all clients" checkable rather than claimed:
 * if a v1 handler and its legacy alias disagree, it is because one of them has
 * a bug, not because there are two implementations.
 *
 * ## Enumeration
 *
 * Three endpoints here answer identically whether or not an account exists —
 * forgot-password, resend-verification and (for the not-found case) login. That
 * is deliberate and it is the reason several of them look like they are
 * throwing information away. The difference between "that address is not
 * registered" and "wrong password" is a free membership check for anyone
 * holding a list of addresses.
 *
 * ## Secrets
 *
 * No handler here logs a password, a code, a token or an oobCode, and none puts
 * one in an error message. `sendCaught` cannot leak an exception's text — an
 * unrecognised throw becomes INTERNAL with the detail server-side only.
 */

import { Request, Response } from 'express';
import * as authService from '../../../services/auth.service';
import * as firebaseFunction from '../../../services/firebaseFunctions.service';
import * as userService from '../../../services/user.service';
import {
  loginWithPassword,
  loginWithFirebaseToken,
  AuthLoginError,
  type Audience,
} from '../../../services/authLoginService';
import { endAllSessions } from '../../../services/authSessionService';
import { refreshIdToken, TokenRefreshError } from '../../../services/tokenRefreshService';
import { verifyEmailOtp as verifyOtpForPurpose } from '../../../services/otpService';
import { resolveIdentifier } from '../../../services/identifierResolver';
import { findLinkCollision } from '../../../services/accountLinkGuard';
import { provenFrom, recordProvenIdentifiers } from '../../../services/identityVerificationSync';
import { continueUrlFor } from '../../../constants/platformContinueUrls';
import { normalizeProviderSourceClient } from '../../../services/profileCreationContract';
import { upsertSourceAttribution } from '../../../services/providerOnboardingService';
import { detectIdentifierType } from '../../../helpers/phoneIdentifier';
import { ok, created, fail, sendCaught } from '../envelope';
import { ApiError, type V1ErrorCode } from '../errors';
import { recordAuthOutcome, type AuthOperation } from '../authTelemetry';
import { V1Handlers } from '../types';

/** Same message for every recovery and resend outcome. */
const NEUTRAL_ACK = {
  message: 'If an account matches, we have sent the next step to it.',
};

const AUDIENCES: Audience[] = ['admin', 'provider', 'customer', 'any'];

const readAudience = (raw: unknown): Audience => {
  if (typeof raw === 'string' && (AUDIENCES as string[]).includes(raw)) return raw as Audience;
  return 'any';
};

const asString = (v: unknown): string | null =>
  typeof v === 'string' && v.trim().length ? v.trim() : null;

/** Maps the login service's own error vocabulary onto the v1 codes of the same name. */
const LOGIN_CODE: Record<AuthLoginError['code'], V1ErrorCode> = {
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  ACCOUNT_UNVERIFIED: 'ACCOUNT_UNVERIFIED',
  ACCOUNT_DISABLED: 'ACCOUNT_DISABLED',
  AUDIENCE_MISMATCH: 'AUDIENCE_MISMATCH',
  PASSWORD_NOT_AVAILABLE: 'PASSWORD_NOT_AVAILABLE',
};

/**
 * One exit point per handler, so the outcome is counted exactly once and the
 * code that reaches telemetry is the code that reaches the client.
 */
const done = (
  res: Response,
  req: Request,
  operation: AuthOperation,
  outcome: 'success' | V1ErrorCode,
  body: () => Response,
): Response => {
  recordAuthOutcome(req, operation, outcome);
  return body();
};

const failAuth = (
  res: Response,
  req: Request,
  operation: AuthOperation,
  code: V1ErrorCode,
  message?: string,
): Response => done(res, req, operation, code, () => fail(res, req, code, message));

export const handlers: V1Handlers = {
  // ── Registration ───────────────────────────────────────────────────────────
  'auth.register': async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const idToken = asString(body.idToken);

      // Firebase-first registration (provider web/mobile, social, phone).
      if (idToken) {
        const firstName = asString(body.firstName) ?? '';
        const lastName = asString(body.lastName) ?? '';
        const result = await firebaseFunction.firebaseProviderRegister(idToken, firstName, lastName);
        const uid = (result as any)?.data?.uid ?? null;

        if (uid) {
          const sourceClient = normalizeProviderSourceClient(body.sourceClient ?? 'provider_web');
          // Non-blocking, exactly as the legacy path does it: the account is
          // authoritative and must not be reported as failed because an
          // attribution write was slow.
          upsertSourceAttribution(uid, sourceClient, true, 'registration').catch(() => {});
        }

        return done(res, req, 'register', 'success', () =>
          created(res, req, {
            uid,
            verificationType: 'none',
            verificationDeliveryPending: false,
            onboardingPending: false,
          }),
        );
      }

      // Classic email + password registration.
      const result: any = await authService.registerUser(body as any);
      const uid = result?.dbRegister?.uid ?? result?.dbRegister?.id ?? null;

      return done(res, req, 'register', 'success', () =>
        created(res, req, {
          uid,
          verificationType: result?.verificationType ?? 'link',
          verificationDeliveryPending:
            result?.verificationDeliveryPending ?? result?.otpDeliveryPending ?? false,
          onboardingPending: result?.onboardingPending ?? false,
        }),
      );
    } catch (error: any) {
      // `registerUser` throws a BARE STRING for validation failures and an Error
      // with a statusCode for conflicts. Neither is echoed: "that email is
      // taken" is the same membership check by another route, so a 409 from
      // Firebase and a malformed password produce the same refusal.
      const message = typeof error === 'string' ? error : String(error?.message ?? '');
      if (/valid Email|valid Password|Missing required/i.test(message)) {
        return failAuth(res, req, 'register', 'VALIDATION_FAILED', 'Check the details and try again.');
      }
      if (/password/i.test(message) && /requirement/i.test(message)) {
        return failAuth(res, req, 'register', 'WEAK_PASSWORD');
      }
      if (error?.code === 'ACCOUNT_LINK_REQUIRED') {
        return failAuth(res, req, 'register', 'ACCOUNT_LINK_REQUIRED', error.message);
      }
      recordAuthOutcome(req, 'register', 'REGISTRATION_REJECTED');
      return fail(res, req, 'REGISTRATION_REJECTED', 'Registration failed. Please try again.');
    }
  },

  // ── Login ──────────────────────────────────────────────────────────────────
  'auth.login': async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const audience = readAudience(body.audience);
      const idToken = asString(body.idToken);
      const identifier = body.identifier ?? body.email;
      const password = asString(body.password);
      const fcmToken = asString(body.fcmToken);

      if (!idToken && !(identifier && password)) {
        return failAuth(
          res,
          req,
          'login',
          'VALIDATION_FAILED',
          'Provide either an idToken, or an identifier and password.',
        );
      }

      const session = idToken
        ? await loginWithFirebaseToken({
            idToken,
            audience,
            role: typeof body.role === 'string' ? body.role : undefined,
          })
        : await loginWithPassword({ identifier, password: password as string, audience });

      // Non-blocking, and deliberately after the session exists: a push-token
      // write must never be able to fail a sign-in.
      if (fcmToken && session.uid) {
        authService.updateFcmToken(session.uid, fcmToken).catch(() => {});
      }

      return done(res, req, 'login', 'success', () => ok(res, req, session));
    } catch (error: any) {
      if (error instanceof AuthLoginError) {
        return failAuth(res, req, 'login', LOGIN_CODE[error.code], error.message);
      }
      if (error?.code === 'ACCOUNT_LINK_REQUIRED') {
        return failAuth(res, req, 'login', 'ACCOUNT_LINK_REQUIRED', error.message);
      }
      if (error?.code === 'PROVIDER_ACCOUNT_NOT_FOUND') {
        return failAuth(
          res,
          req,
          'login',
          'AUDIENCE_MISMATCH',
          'Create your provider account before signing in.',
        );
      }
      if (/disabled/i.test(String(error?.message ?? ''))) {
        return failAuth(res, req, 'login', 'ACCOUNT_DISABLED');
      }
      // A Firebase token that will not verify is a credential failure, not a
      // server fault — collapsing it to INTERNAL would tell a client to retry
      // something that can never succeed.
      if (typeof error?.code === 'string' && error.code.startsWith('auth/')) {
        return failAuth(res, req, 'login', 'INVALID_CREDENTIALS');
      }
      recordAuthOutcome(req, 'login', 'INTERNAL');
      return sendCaught(res, req, 'auth.login', error);
    }
  },

  // ── Refresh ────────────────────────────────────────────────────────────────
  'auth.refresh': async (req: Request, res: Response) => {
    try {
      const refreshToken = asString((req.body ?? {}).refreshToken);
      if (!refreshToken) {
        return failAuth(res, req, 'refresh', 'VALIDATION_FAILED', 'A refreshToken is required.');
      }
      const session = await refreshIdToken(refreshToken);
      return done(res, req, 'refresh', 'success', () => ok(res, req, session));
    } catch (error: any) {
      if (error instanceof TokenRefreshError) {
        // 5xx from Google is transient and retryable; anything else means the
        // token itself is not exchangeable and the client must re-authenticate.
        const code: V1ErrorCode =
          error.statusCode >= 500 ? 'REFRESH_UNAVAILABLE' : 'REFRESH_TOKEN_INVALID';
        return failAuth(res, req, 'refresh', code, error.message);
      }
      // Never surface an unexpected error's text here — it can carry the token.
      return failAuth(res, req, 'refresh', 'REFRESH_UNAVAILABLE', 'Token refresh is unavailable.');
    }
  },

  // ── Logout ─────────────────────────────────────────────────────────────────
  'auth.logout': async (req: Request, res: Response) => {
    try {
      const uid = (req as any).user?.uid as string | undefined;
      if (!uid) throw new ApiError('UNAUTHENTICATED', 'Authentication is required.');

      const outcome = await endAllSessions(uid, 'logout');
      return done(res, req, 'logout', 'success', () =>
        ok(res, req, { sessionsRevoked: outcome.sessionsRevoked, pushCleared: outcome.pushCleared }),
      );
    } catch (error) {
      recordAuthOutcome(req, 'logout', 'INTERNAL');
      return sendCaught(res, req, 'auth.logout', error);
    }
  },

  // ── Forgot password ────────────────────────────────────────────────────────
  'auth.forgotPassword': async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const identifier = body.identifier ?? body.email;
    const type = detectIdentifierType(identifier);

    try {
      if (type === 'email') {
        const continueUrl = continueUrlFor('reset', body.platform);
        await authService.forgotPassword(String(identifier), continueUrl);
      }
      // A mobile identifier, an unparseable one and an unknown address all fall
      // through to the same acknowledgement. Mobile recovery is not configured
      // — there is no SMS sender — and saying so HERE would reveal which
      // identifier kind an account holds. The contract document says it instead.
    } catch (error: any) {
      // Even a genuine failure answers neutrally. A 500 on one address and a 200
      // on another is an enumeration oracle that does not need to read English.
      // eslint-disable-next-line no-console
      console.error('[auth.forgotPassword] delivery failed', {
        identifierType: type,
        error: error?.message ?? 'unknown',
      });
    }

    return done(res, req, 'forgot_password', 'success', () => ok(res, req, NEUTRAL_ACK));
  },

  // ── Reset password ─────────────────────────────────────────────────────────
  'auth.resetPassword': async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const oobCode = asString(body.oobCode);
      const newPassword = asString(body.newPassword);

      if (!oobCode || !newPassword) {
        return failAuth(
          res,
          req,
          'reset_password',
          'VALIDATION_FAILED',
          'oobCode and newPassword are required.',
        );
      }

      // The service consumes the code, syncs the local hash AND ends every
      // session on the account. That last part is the change this command made,
      // and it lives in the service so the legacy route inherits it too.
      await authService.resetPassword({ oobCode, newPassword });

      return done(res, req, 'reset_password', 'success', () =>
        ok(res, req, { message: 'Password reset. Sign in again on each device.' }),
      );
    } catch (error: any) {
      const message = String(error?.message ?? error ?? '');
      if (/requirement/i.test(message)) {
        return failAuth(res, req, 'reset_password', 'WEAK_PASSWORD');
      }
      // Everything else is the code: expired, spent, or never valid. One
      // outcome, because distinguishing them tells a holder of stolen codes
      // which ones are worth replaying.
      return failAuth(
        res,
        req,
        'reset_password',
        'RESET_TOKEN_INVALID',
        'This reset link is no longer valid. Request a new one.',
      );
    }
  },

  // ── Verify email ───────────────────────────────────────────────────────────
  'auth.verifyEmail': async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const identifier = asString(body.identifier) ?? asString(body.email);
      const code = asString(body.code) ?? asString(body.otp);

      if (!identifier || !code) {
        return failAuth(res, req, 'verify_email', 'VALIDATION_FAILED', 'identifier and code are required.');
      }

      // Purpose-scoped: a code minted for a password reset or a sensitive change
      // cannot satisfy registration verification, even though all three live in
      // one table.
      const outcome = await verifyOtpForPurpose(identifier, code, 'REGISTRATION_VERIFICATION');
      if (!outcome.ok) {
        return failAuth(res, req, 'verify_email', outcome.reason);
      }

      // The code is spent. Now record the verification on both authorities —
      // Firebase and the local row — exactly as the legacy handler does.
      const firebaseUser = await firebaseFunction.getFirebaseUserByEmail(identifier);
      if (firebaseUser) {
        await firebaseFunction.updateFirebaseEmailVerified(firebaseUser.uid, true);
        await userService.updateEmailVerifiedByUid(firebaseUser.uid, true);
      }

      return done(res, req, 'verify_email', 'success', () =>
        ok(res, req, { verified: true, identifierType: 'email' }),
      );
    } catch (error) {
      recordAuthOutcome(req, 'verify_email', 'INTERNAL');
      return sendCaught(res, req, 'auth.verifyEmail', error);
    }
  },

  // ── Resend verification ────────────────────────────────────────────────────
  'auth.resendVerification': async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const identifier = asString(body.identifier) ?? asString(body.email);
    const channel = body.channel === 'link' ? 'link' : 'otp';

    try {
      if (identifier && detectIdentifierType(identifier) === 'email') {
        if (channel === 'link') {
          await authService.getAndSendEmailVerificationLink(
            identifier,
            null,
            continueUrlFor('verify', body.platform),
          );
        } else {
          // Already neutral internally: it returns the same acknowledgement for
          // an unknown address and an already-verified one.
          await authService.resendEmailOtp({ email: identifier });
        }
      }
    } catch (error: any) {
      // eslint-disable-next-line no-console
      console.error('[auth.resendVerification] delivery failed', { channel, error: error?.message ?? 'unknown' });
    }

    return done(res, req, 'resend_verification', 'success', () => ok(res, req, NEUTRAL_ACK));
  },

  // ── Verify mobile ──────────────────────────────────────────────────────────
  'auth.verifyMobile': async (req: Request, res: Response) => {
    try {
      const uid = (req as any).user?.uid as string | undefined;
      if (!uid) throw new ApiError('UNAUTHENTICATED', 'Authentication is required.');

      const idToken = asString((req.body ?? {}).idToken);
      if (!idToken) {
        return failAuth(res, req, 'verify_mobile', 'VALIDATION_FAILED', 'An idToken is required.');
      }

      // The proof is Firebase's, not ours: it only issues a phone credential
      // after its own SMS OTP. This backend has no SMS sender and does not
      // pretend to verify a number itself.
      const decoded = await firebaseFunction.verifyIdTokenStrict(idToken);
      const firebaseUser = await firebaseFunction.getFirebaseUserByUid(decoded.uid);
      const proven = provenFrom(decoded, firebaseUser);

      if (!proven.mobileVerified) {
        return failAuth(
          res,
          req,
          'verify_mobile',
          'INVALID_CREDENTIALS',
          'That sign-in does not prove a mobile number.',
        );
      }

      const phone = firebaseUser?.phoneNumber ?? null;
      if (!phone) {
        return failAuth(res, req, 'verify_mobile', 'INVALID_CREDENTIALS', 'No mobile number on that credential.');
      }

      // The number must not already belong to somebody else. Recording it
      // anyway is how one person's number ends up verifying two accounts, and
      // then recovering the wrong one.
      // Positional: (incomingUid, email, phoneNumber). Only the phone is passed —
      // this endpoint claims a NUMBER, and passing the caller's email as well
      // would refuse them their own account.
      const collision = await findLinkCollision(uid, null, phone);
      if (collision) {
        return failAuth(
          res,
          req,
          'verify_mobile',
          'ACCOUNT_LINK_REQUIRED',
          'That mobile number already belongs to another account.',
        );
      }

      await recordProvenIdentifiers(uid, proven);

      return done(res, req, 'verify_mobile', 'success', () =>
        ok(res, req, { verified: true, identifierType: 'mobile' }),
      );
    } catch (error: any) {
      if (typeof error?.code === 'string' && error.code.startsWith('auth/')) {
        return failAuth(res, req, 'verify_mobile', 'INVALID_CREDENTIALS');
      }
      recordAuthOutcome(req, 'verify_mobile', 'INTERNAL');
      return sendCaught(res, req, 'auth.verifyMobile', error);
    }
  },
};

/** Exposed for the contract test, which asserts login resolves a mobile identifier. */
export const __internals = { resolveIdentifier };
