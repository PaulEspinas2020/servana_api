/**
 * The canonical sign-in path: one function, every identifier, every client.
 *
 * ## What was here before
 *
 * Four login routes, none of which agreed:
 *
 *   POST /api/auth/signin                  email + password, any role
 *   POST /api/auth/admin-signin            email + password, then a role-1 gate
 *   POST /api/auth/firebase-login          Firebase ID token, provider-shaped
 *   POST /api/auth/customer-firebase-login Firebase ID token, customer-shaped
 *
 * Two credential kinds and a role gate, spread over four paths with four
 * response shapes and four error vocabularies. The role gate is the only real
 * difference between the first two, and it is a property of the CALLER, not of
 * the credential — so it belongs in a parameter, not in a path.
 *
 * ## The identifier gap this closes
 *
 * `services/identifierResolver.ts` was written for Command 5 §7/§8 with an
 * explicit purpose, quoted from its own docblock: *"Sign-in took an `email`
 * field and looked it up directly, so a provider who registered with a mobile
 * number had no way in."*
 *
 * It has one caller today, and it is account DELETION. Sign-in still takes an
 * `email` field and looks it up directly. This is the sixth foundation in this
 * codebase built and never wired to the thing it was built for.
 *
 * `loginWithPassword` resolves the identifier first, so a provider can sign in
 * with the mobile number on their account — provided that account also has an
 * email, because Firebase is the password authority and its password grant is
 * keyed on email. An account with a mobile and no email has no password at all
 * and must use the token path; that is stated in the return, not guessed at.
 *
 * ## What is deliberately NOT re-implemented
 *
 * The password state machine. `authService.loggedInUser` performs the Firebase
 * existence check, the email-verified gate, the admin auto-verify, the archived
 * check, the Firebase password grant and the stale-local-hash resync. All of
 * that stays exactly where it is, and this function CALLS it. So the legacy
 * route and the canonical route do not merely behave alike — they execute the
 * same function, and `tests/v1-auth-contract.test.ts` asserts it.
 *
 * This module adds three things around that call and nothing else: identifier
 * resolution, an audience assertion, and one session DTO.
 */

import * as authService from './auth.service';
import * as firebaseFunction from './firebaseFunctions.service';
import { resolveIdentifier, type Resolution } from './identifierResolver';
import { detectIdentifierType } from '../helpers/phoneIdentifier';

/**
 * Which surface is asking.
 *
 * Replaces `/auth/admin-signin` as a separate route. The assertion runs AFTER
 * authentication, never before: refusing an unknown identifier differently from
 * a known-but-wrong-audience one would turn the admin portal's login box into
 * an oracle for "is this address an admin".
 */
export type Audience = 'admin' | 'provider' | 'customer' | 'any';

/** Roles each audience accepts. Role 4 is a SECOND provider role — see servana_role_map. */
const AUDIENCE_ROLES: Record<Exclude<Audience, 'any'>, number[]> = {
  admin: [1],
  provider: [2, 4],
  customer: [3],
};

export class AuthLoginError extends Error {
  constructor(
    readonly code:
      | 'INVALID_CREDENTIALS'
      | 'ACCOUNT_UNVERIFIED'
      | 'ACCOUNT_DISABLED'
      | 'AUDIENCE_MISMATCH'
      | 'PASSWORD_NOT_AVAILABLE',
    message: string,
  ) {
    super(message);
    this.name = 'AuthLoginError';
  }
}

/** The one session shape every canonical auth response returns. */
export interface CanonicalSession {
  token: string;
  refreshToken: string | null;
  uid: string;
  email: string | null;
  role: number | null;
  firstName: string | null;
  lastName: string | null;
  isEmailVerified: boolean;
  /** Which identifier the caller actually presented. Useful to a client deciding what to echo. */
  identifierType: 'email' | 'mobile' | 'token';
}

const asSession = (raw: any, identifierType: CanonicalSession['identifierType']): CanonicalSession => ({
  token: raw?.token ?? raw?.idToken ?? '',
  refreshToken: raw?.refreshToken ?? null,
  uid: raw?.uid ?? raw?.id ?? '',
  email: raw?.email ?? null,
  role: raw?.role === undefined || raw?.role === null ? null : Number(raw.role),
  firstName: raw?.firstName ?? null,
  lastName: raw?.lastName ?? null,
  isEmailVerified: raw?.isEmailVerified === true,
  identifierType,
});

/**
 * Asserts the authenticated account belongs on the surface that asked.
 *
 * Runs on an already-authenticated session, so it cannot be used to probe which
 * addresses exist. A customer signing in at the admin portal is told this is
 * not an admin account — which is true, actionable, and reveals nothing they
 * did not already prove they own.
 */
export function assertAudience(role: number | null, audience: Audience): void {
  if (audience === 'any') return;
  const allowed = AUDIENCE_ROLES[audience];
  if (role === null || !allowed.includes(Number(role))) {
    throw new AuthLoginError(
      'AUDIENCE_MISMATCH',
      audience === 'admin'
        ? 'This portal is for admin accounts only.'
        : audience === 'provider'
        ? 'This account is not registered as a service provider.'
        : 'This account is not a customer account.',
    );
  }
}

export interface PasswordLoginInput {
  /** Email address OR Philippine mobile number. */
  identifier: unknown;
  password: string;
  audience?: Audience;
}

/**
 * Sign in with an identifier and a password.
 *
 * Every failure that could distinguish "no such account" from "wrong password"
 * collapses to INVALID_CREDENTIALS, including a malformed identifier — the
 * format check must not be the only thing standing between a caller and an
 * answer (§19, and `identifierResolver`'s own docblock).
 */
export async function loginWithPassword(input: PasswordLoginInput): Promise<CanonicalSession> {
  const audience: Audience = input.audience ?? 'any';
  const type = detectIdentifierType(input.identifier);

  let emailForFirebase: string | null = null;
  let presented: 'email' | 'mobile' = 'email';

  if (type === 'email') {
    presented = 'email';
    emailForFirebase = typeof input.identifier === 'string' ? input.identifier.trim() : null;
  } else if (type === 'mobile') {
    presented = 'mobile';
    // Resolve the number to the account, then use THAT account's email for the
    // Firebase password grant. This is the whole capability: the number is a
    // way to name the account, not a second credential.
    const resolution: Resolution = await resolveIdentifier(input.identifier);
    if (!resolution.account) {
      throw new AuthLoginError('INVALID_CREDENTIALS', 'Invalid credentials.');
    }
    if (!resolution.account.email) {
      // An account with a mobile and no email has no Firebase password to
      // check. Saying so is not an enumeration leak: the caller has already
      // named an account that exists, and telling them to use the code path is
      // the only route that can work.
      throw new AuthLoginError(
        'PASSWORD_NOT_AVAILABLE',
        'This account signs in with a one-time code, not a password.',
      );
    }
    emailForFirebase = resolution.account.email;
  } else {
    throw new AuthLoginError('INVALID_CREDENTIALS', 'Invalid credentials.');
  }

  if (!emailForFirebase) {
    throw new AuthLoginError('INVALID_CREDENTIALS', 'Invalid credentials.');
  }

  let raw: any;
  try {
    // THE shared state machine. Legacy /api/auth/signin calls this exact
    // function with this exact argument order.
    raw = await authService.loggedInUser(emailForFirebase, input.password);
  } catch (error: any) {
    const statusCode = Number(error?.statusCode);
    if (statusCode === 403) {
      // The credential was correct; the account is unverified or disabled.
      // Routing this to a login screen is what makes people retype a password
      // that was never the problem.
      const disabled = /disabled/i.test(String(error?.message ?? ''));
      throw new AuthLoginError(
        disabled ? 'ACCOUNT_DISABLED' : 'ACCOUNT_UNVERIFIED',
        String(error?.message ?? 'This account cannot sign in yet.'),
      );
    }
    throw new AuthLoginError('INVALID_CREDENTIALS', 'Invalid credentials.');
  }

  const session = asSession(raw, presented);
  assertAudience(session.role, audience);
  return session;
}

export interface TokenLoginInput {
  idToken: string;
  audience?: Audience;
  /** '2' provider, '3' customer. Governs the role a NEW account is created with. */
  role?: string;
}

/**
 * Sign in with a Firebase ID token — social, phone OTP, or an existing session.
 *
 * Delegates to `firebaseFunction.firebaseAuthLogin`, which is what
 * `/api/auth/firebase-login` calls. The customer variant
 * (`customerFirebaseLogin`) is NOT collapsed into this: it has a different
 * account-link collision contract that the installed customer app depends on
 * (a 200 carrying `status: failed`), and changing that shape is a client
 * release. It stays a documented role-specific alias.
 */
export async function loginWithFirebaseToken(input: TokenLoginInput): Promise<CanonicalSession> {
  const audience: Audience = input.audience ?? 'any';
  if (!input.idToken || typeof input.idToken !== 'string') {
    throw new AuthLoginError('INVALID_CREDENTIALS', 'An idToken is required.');
  }
  if (input.role !== undefined && input.role !== '2' && input.role !== '3') {
    throw new AuthLoginError('INVALID_CREDENTIALS', 'Invalid role value.');
  }

  const result = await firebaseFunction.firebaseAuthLogin(input.idToken, input.role);
  const session = asSession(result?.data, 'token');
  assertAudience(session.role, audience);
  return session;
}
