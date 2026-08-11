/**
 * Brute-force protection keyed on the ACCOUNT, not only on the address.
 *
 * ## The problem with the limiter this sits beside
 *
 * `signInLimiter` in `auth.route.ts` is ten attempts per fifteen minutes,
 * keyed by client IP, and shared by `/auth/signin` and `/auth/admin-signin`.
 * Twenty lines below it, `tokenExchangeLimiter`'s own docblock explains at
 * length why IP keying is wrong on this platform: *"Philippine carriers use
 * carrier-grade NAT, so a handful of unrelated customers behind one public
 * address could exhaust the budget between them."*
 *
 * That reasoning was applied to the token routes and not to the password ones,
 * which sit behind the same NAT and the same limiter. Two consequences, both
 * real:
 *
 *   - Ten password sign-ins per quarter-hour for everyone behind one carrier
 *     egress IP. The eleventh person is told they have made too many login
 *     attempts. They have made one.
 *   - `express-rate-limit` counts per limiter INSTANCE, and one instance serves
 *     both routes — so customer sign-in traffic and admin sign-in traffic share
 *     a budget. Enough customer logins from an office IP lock the admins out
 *     from that office.
 *
 * ## Why the docblock's objection does not apply here
 *
 * It says keying per account is impossible because "these routes run before
 * `verifyAuth`, so `req.user` is not populated, and keying on an unverified
 * token's subject would let a caller choose their own bucket".
 *
 * True for a token route, where the subject comes from the credential being
 * tested. Not true for a password route: the identifier arrives in the BODY and
 * naming a bucket is not a way out of it. An attacker who supplies a different
 * identifier is attacking a different account, which is exactly what should get
 * its own counter.
 *
 * ## Why both keys, not one
 *
 * Keyed on the identifier ALONE, an attacker spraying one password across
 * thousands of accounts from one host gets a fresh budget per account and is
 * never slowed. Keyed on IP alone, one NAT locks out a city. So: a tight
 * per-account counter to stop credential guessing, and a loose per-IP counter,
 * generous enough that a shared carrier address is unaffected, to stop a flood.
 * Both must pass.
 */

import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { rateLimitBody } from '../helpers/rateLimitBody';
import { normalizeEmail, toE164PhMobile, detectIdentifierType } from '../helpers/phoneIdentifier';

/**
 * A stable, non-reversible bucket name for whatever identifier was submitted.
 *
 * Normalised first, so `Paul@X.com`, `paul@x.com` and ` paul@x.com ` share one
 * counter — otherwise changing the case of a letter buys a fresh budget and the
 * limit protects nothing.
 *
 * Hashed, because rate-limit keys sit in memory and appear in diagnostics, and
 * an email address is personal data (§58). A non-cryptographic digest is
 * sufficient: this is a bucket name, not a secret, and a collision costs two
 * accounts a shared counter rather than any disclosure.
 */
export function identifierBucket(raw: unknown): string | null {
  const type = detectIdentifierType(raw);
  const normalized =
    type === 'email' ? normalizeEmail(raw) : type === 'mobile' ? toE164PhMobile(raw) : null;
  if (!normalized) return null;

  let h = 0;
  for (let i = 0; i < normalized.length; i++) {
    h = (h * 31 + normalized.charCodeAt(i)) | 0;
  }
  return `id:${Math.abs(h).toString(36)}`;
}

/** Reads the identifier from any of the spellings the clients send. */
const identifierOf = (req: any): unknown =>
  req?.body?.identifier ?? req?.body?.email ?? req?.body?.phone ?? req?.body?.phoneNumber;

/**
 * Tight, per-account. Ten wrong passwords for ONE account in fifteen minutes.
 *
 * `skipSuccessfulRequests` so somebody signing in correctly several times — a
 * provider switching devices, a test run — never approaches it. Only failures
 * count, which is the thing being limited.
 */
export const perAccountLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req: any) => identifierBucket(identifierOf(req)) ?? ipKeyGenerator(req),
  message: rateLimitBody('Too many sign-in attempts for this account. Please wait 15 minutes or reset your password.'),
});

/**
 * Loose, per-IP. A cost ceiling on a flood, not a credential control.
 *
 * Two hundred rather than ten: behind carrier-grade NAT this counter is shared
 * by unrelated people, so it has to be far above what any of them could
 * plausibly generate. The per-account limiter above is what actually stops
 * guessing.
 *
 * `ipKeyGenerator` rather than a bare `req.ip`, which does not normalise IPv6 —
 * an attacker with a /64 would otherwise have a practically unlimited number of
 * distinct keys.
 */
export const perIpLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req: any) => ipKeyGenerator(req),
  message: rateLimitBody('Too many requests from this network. Please try again shortly.'),
});

/** Registration, per-identifier. Stops one address being used to farm accounts. */
export const perAccountRegisterLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => identifierBucket(identifierOf(req)) ?? ipKeyGenerator(req),
  message: rateLimitBody('Too many registration attempts. Please try again in 1 hour.'),
});

/**
 * OTP submission, per-identifier.
 *
 * A six-digit code is one in a million per guess, which is only strong while
 * the number of guesses is bounded. Ten minutes of life and no attempt counter
 * would allow far more than a million attempts in the window.
 *
 * Successful verifications do not count: somebody verifying an email and then a
 * mobile in the same minute is not attacking anything.
 */
export const perAccountOtpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req: any) => identifierBucket(identifierOf(req)) ?? ipKeyGenerator(req),
  message: rateLimitBody('Too many incorrect codes. Please request a new one.'),
});

/** Recovery, per-identifier. Stops one address being mail-bombed via the reset form. */
export const perAccountRecoveryLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => identifierBucket(identifierOf(req)) ?? ipKeyGenerator(req),
  message: rateLimitBody('Too many recovery requests. Please try again in 1 hour.'),
});
