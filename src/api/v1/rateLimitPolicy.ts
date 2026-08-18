/**
 * Which rate limiters guard which canonical auth endpoint, as data.
 *
 * ## Why this is a module and not a table in `register.ts`
 *
 * `AUTH_V1_CONTRACT.md` §8 said, for months, **"Every credential endpoint
 * carries two limiters and both must pass."** Six of the nine do. `refresh` and
 * `verify-mobile` carry the per-IP limiter alone — correctly, for the reason
 * `credentialLimiter`'s docblock already gives about token routes — and
 * `logout` carries none. The sentence was a fair summary of the five endpoints
 * that existed when it was written and became false as the domain grew.
 *
 * The test that looked like it enforced that sentence did not: it read
 * `register.ts` as TEXT and checked a hand-listed five ids, so an endpoint added
 * with one limiter, or none, passed without comment.
 *
 * So the mapping lives here, in one place, and `register.ts`, the generated §8
 * table and `tests/v1-auth-contract.test.ts` all read it. An endpoint with no
 * per-account bucket must say why in the declaration itself, which is the only
 * form of "documented" that cannot fall out of date: the reason and the wiring
 * are the same object.
 *
 * ## Why the budgets are here too
 *
 * Same argument, one level down. The documented budget and the configured
 * budget were two numbers that had to be kept equal by hand.
 * `credentialLimiter` builds its limiters from `BUCKETS`, and the document
 * renders from `BUCKETS`, so there is one number.
 *
 * This module deliberately imports nothing but the contract. It must stay
 * loadable by a documentation generator, which has no Express and no Firebase.
 */

import { V1_CONTRACT } from './contract';

/** A named counter. One `express-rate-limit` instance is built per bucket. */
export interface BucketSpec {
  /** What the counter is keyed on. `identifier` falls back to the IP when the body carries none. */
  key: 'identifier' | 'ip';
  windowMs: number;
  max: number;
  /** When true, only failed requests count against the budget. */
  skipSuccessfulRequests: boolean;
  /** Rendered into the documented table. */
  purpose: string;
}

export const BUCKETS = {
  perAccountLogin: {
    key: 'identifier',
    windowMs: 15 * 60 * 1000,
    max: 10,
    skipSuccessfulRequests: true,
    purpose: 'Password guessing against one account.',
  },
  perAccountRegister: {
    key: 'identifier',
    windowMs: 60 * 60 * 1000,
    max: 5,
    skipSuccessfulRequests: false,
    purpose: 'Farming accounts from one address.',
  },
  perAccountOtp: {
    key: 'identifier',
    windowMs: 10 * 60 * 1000,
    max: 8,
    skipSuccessfulRequests: true,
    purpose: 'Guessing a six-digit code before it expires.',
  },
  perAccountRecovery: {
    key: 'identifier',
    windowMs: 60 * 60 * 1000,
    max: 5,
    skipSuccessfulRequests: false,
    purpose: 'Mail-bombing one address through the reset form.',
  },
  perIp: {
    key: 'ip',
    windowMs: 15 * 60 * 1000,
    max: 200,
    skipSuccessfulRequests: true,
    purpose: 'A cost ceiling on a flood. Loose, because carrier NAT shares it.',
  },
} as const satisfies Record<string, BucketSpec>;

export type BucketName = keyof typeof BUCKETS;

export const ACCOUNT_BUCKETS = (Object.keys(BUCKETS) as BucketName[]).filter(
  (name) => BUCKETS[name].key === 'identifier',
);

export interface EndpointRateLimit {
  /** Applied in this order, before the handler and after the auth chain. */
  buckets: BucketName[];
  /**
   * Required when `buckets` contains no per-account bucket.
   *
   * Not decoration: an endpoint without an account counter is one an attacker
   * can hammer for a single account as hard as the IP budget allows, so the
   * reason it is safe has to be stated by whoever leaves it out.
   */
  noAccountBucket?: string;
}

/**
 * Every implemented `auth` endpoint. Exhaustiveness is asserted below, so a new
 * one cannot ship with its rate limiting simply unconsidered.
 */
export const V1_RATE_LIMITS: Record<string, EndpointRateLimit> = {
  'auth.login': { buckets: ['perAccountLogin', 'perIp'] },
  'auth.register': { buckets: ['perAccountRegister', 'perIp'] },
  'auth.verifyEmail': { buckets: ['perAccountOtp', 'perIp'] },
  'auth.forgotPassword': { buckets: ['perAccountRecovery', 'perIp'] },
  'auth.resetPassword': { buckets: ['perAccountRecovery', 'perIp'] },
  'auth.resendVerification': { buckets: ['perAccountRecovery', 'perIp'] },

  'auth.refresh': {
    buckets: ['perIp'],
    noAccountBucket:
      'The body carries a refresh token and no identifier, so there is nothing to key an ' +
      'account bucket on. Keying on the unverified token\'s subject would let a caller pick ' +
      'their own counter — the objection `tokenExchangeLimiter` raises, and the one case where ' +
      'it holds.',
  },
  'auth.verifyMobile': {
    buckets: ['perIp'],
    noAccountBucket:
      'Same shape: the proof is a Firebase ID token, not an identifier. It also runs behind ' +
      '`verifyAuth`, so an anonymous caller never reaches it, and Firebase has already rate ' +
      'limited the SMS OTP that issued the token.',
  },
  'auth.logout': {
    buckets: [],
    noAccountBucket:
      'Revokes the caller\'s own sessions behind `verifyAuth`. There is no secret to guess and ' +
      'nothing to enumerate: the worst a flood achieves is logging one account out repeatedly.',
  },
};

/**
 * Import-time checks, in the spirit of `register.ts`: a gap here is a security
 * gap, and a process that refuses to start naming the endpoint is better than
 * one that serves it unprotected.
 */
const authEndpointIds = V1_CONTRACT.filter(
  (e) => e.domain === 'auth' && e.status === 'implemented',
).map((e) => e.id);

const undeclared = authEndpointIds.filter((id) => !V1_RATE_LIMITS[id]);
if (undeclared.length) {
  throw new Error(
    `v1 rate limits: implemented auth endpoint(s) with no declared policy — ${undeclared.join(', ')}. ` +
      'Declare the buckets, or declare none and say why.',
  );
}

const stray = Object.keys(V1_RATE_LIMITS).filter((id) => !authEndpointIds.includes(id));
if (stray.length) {
  throw new Error(`v1 rate limits: policy declared for unimplemented endpoint(s) — ${stray.join(', ')}`);
}

for (const [id, policy] of Object.entries(V1_RATE_LIMITS)) {
  const hasAccountBucket = policy.buckets.some((b) => BUCKETS[b].key === 'identifier');
  if (!hasAccountBucket && !policy.noAccountBucket?.trim()) {
    throw new Error(
      `v1 rate limits: ${id} has no per-account bucket and no stated reason. ` +
        'An endpoint an attacker can hammer per-account needs one or the other.',
    );
  }
  if (hasAccountBucket && policy.noAccountBucket) {
    throw new Error(`v1 rate limits: ${id} declares an account bucket AND a reason for having none.`);
  }
}
