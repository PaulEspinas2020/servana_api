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

// ── Admin API throttling (TAB 05, F-07) ──────────────────────────────────────

/**
 * The admin tiers.
 *
 * ## Why they live in this module and not a new one
 *
 * §10: one policy, not two. This file is already "which limiter guards what, as
 * data", and a second module answering the same question for a different route
 * tree is how the two drift. It is also why they are a SEPARATE exported object
 * rather than more entries in `BUCKETS`: `BUCKETS` renders into
 * `AUTH_V1_CONTRACT.md` §8, which is a table about credential endpoints.
 * An admin-throttle row there would be a true fact in a misleading place.
 *
 * ## Why the key is the actor and not the IP
 *
 * Every admin reaches this API through the same nginx hop on the same host, so
 * an IP-keyed budget puts the entire operations team in one bucket: the busiest
 * admin throttles everyone else, and the limit reads as an outage rather than
 * as a limit. Keying on the authenticated uid gives each admin their own budget
 * and makes the counter mean something — "this account is behaving oddly"
 * rather than "the office is busy".
 *
 * Unauthenticated requests fall back to the IP. They are about to be refused by
 * `verifyAuth` anyway; the fallback exists so an unauthenticated flood is still
 * bounded rather than uncounted.
 *
 * ## Why three tiers and not one
 *
 * A single budget has to be loose enough for the busiest read screen, which
 * makes it far too loose for a payout. The numbers below are deliberately
 * generous for reads — an admin paging a list is normal traffic and a limit
 * that fires on legitimate operations work gets removed wholesale rather than
 * tuned, which leaves nothing.
 *
 * These are STARTING values chosen from the shape of the work, not from
 * measured production traffic, because this environment cannot read production
 * traffic. They must be re-derived from measured p99 before they are trusted —
 * `docs/MASTER_TODO_MANUAL_TASKS.md` 05.2 — and shipped in log-only mode first.
 */
export const ADMIN_BUCKETS = {
  adminRead: {
    key: 'actor',
    windowMs: 60 * 1000,
    max: 300,
    skipSuccessfulRequests: false,
    purpose:
      'A ceiling on read volume from one admin account. Generous: paging a list is normal work.',
  },
  adminMutation: {
    key: 'actor',
    windowMs: 60 * 1000,
    max: 60,
    skipSuccessfulRequests: false,
    purpose:
      'Writes from one admin account. A person clicking cannot approach this; a script can.',
  },
  adminSensitive: {
    key: 'actor',
    windowMs: 60 * 1000,
    max: 10,
    skipSuccessfulRequests: false,
    purpose:
      'Money and permission mutations: payouts, refunds, disbursements, permission grants, admin bootstrap. Ten a minute is more than an operator does deliberately and far less than a loop does accidentally.',
  },
} as const satisfies Record<string, Omit<BucketSpec, 'key'> & { key: 'actor' }>;

export type AdminBucketName = keyof typeof ADMIN_BUCKETS;

/**
 * Path prefixes that get `adminSensitive` regardless of method.
 *
 * Matched by prefix rather than listed route by route, so a NEW payout or
 * permission route is throttled on the day it is added rather than on the day
 * somebody remembers to add it here. Deny-by-default applied to throttling:
 * the question a new route has to answer is "why is this NOT sensitive".
 */
export const ADMIN_SENSITIVE_PREFIXES = [
  '/api/admin/finance',
  '/api/admin/disbursements',
  '/api/admin/permissions',
  '/api/admin/users',
  /**
   * Admin identity itself. `/admin/admin-users/bootstrap-super-admin` grants
   * SUPER ADMIN to its first caller, and `/admin/admin-users/:uid` edits who is
   * an administrator at all. A permission grant is a money action one step
   * removed, and creating the person who can grant it is one step further back
   * — the tier has to cover the whole chain or it covers none of it.
   *
   * Note the path really is `admin-users`, not `users`: they are different
   * prefixes and matching only the latter left the bootstrap route on the
   * ordinary mutation tier. Found by the coverage test, not by reading.
   */
  '/api/admin/admin-users',
] as const;

/** Which tier a given admin request falls into. */
export const adminTierFor = (method: string, path: string): AdminBucketName => {
  if (ADMIN_SENSITIVE_PREFIXES.some((p) => path.startsWith(p))) return 'adminSensitive';
  const verb = method.toUpperCase();
  if (verb === 'GET' || verb === 'HEAD' || verb === 'OPTIONS') return 'adminRead';
  return 'adminMutation';
};
