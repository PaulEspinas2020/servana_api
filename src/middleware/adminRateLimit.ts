/**
 * Rate limiting for the admin API (TAB 05, F-07).
 *
 * ## The gap
 *
 * Limiters existed for auth, pricing and account deletion, and the v1 layer has
 * a rate-limit policy. The 251 admin routes had none — including payout, refund
 * and permission mutations. The most consequential surface on the platform was
 * the only unthrottled one.
 *
 * ## Why this is mounted once by prefix, not added to fifteen route files
 *
 * Fifteen edits is fifteen chances to miss one, and the sixteenth admin route
 * file somebody adds next month inherits nothing. Mounting on `/api/admin`
 * means a new admin route is throttled on the day it is created, without anybody
 * remembering. That is the same reason `ADMIN_SENSITIVE_PREFIXES` matches by
 * prefix: the question a new payout route has to answer is "why is this NOT
 * sensitive", which is the deny-by-default direction.
 *
 * ## Why a limiter must never be the reason a request fails
 *
 * `express-rate-limit` throws if its key generator throws. A throttle that 500s
 * on a malformed request has turned a safety control into an outage, so the key
 * resolution below cannot throw: it falls back to the IP, and the IP helper is
 * the library's own so IPv6 is bucketed the way the library expects rather than
 * the way a hand-rolled `req.ip` would.
 */

import { NextFunction, Request, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import {
  ADMIN_BUCKETS,
  adminTierFor,
  type AdminBucketName,
} from '../api/v1/rateLimitPolicy';
import { rateLimitBody } from '../helpers/rateLimitBody';

/**
 * Set to `true` to count and log without refusing anything.
 *
 * The rollback discipline for a rate limit is not "revert the commit" — it is
 * "watch it for a business day first". A limit that fires on legitimate
 * operations work gets removed wholesale rather than tuned, and then there is
 * no limit at all. Log-only is how the numbers get corrected before they are
 * enforced, and the flag is read at construction so production can be switched
 * back without a code change.
 */
export const ADMIN_RATE_LIMIT_LOG_ONLY =
  String(process.env.ADMIN_RATE_LIMIT_LOG_ONLY ?? '').toLowerCase() === 'true';

/** The authenticated admin, or the IP when there is not one yet. */
export const adminRateKey = (req: Request): string => {
  try {
    const uid = (req as any).user?.uid;
    if (typeof uid === 'string' && uid.length > 0) return `uid:${uid}`;
  } catch {
    // Fall through to the IP. A throttle must not be the thing that 500s.
  }
  return `ip:${ipKeyGenerator((req as any).ip ?? '')}`;
};

const RETRY_AFTER_SECONDS = (windowMs: number): number => Math.ceil(windowMs / 1000);

const build = (name: AdminBucketName) => {
  const spec = ADMIN_BUCKETS[name];
  return rateLimit({
    windowMs: spec.windowMs,
    max: spec.max,
    // RFC 9331 `RateLimit-*`. The legacy `X-RateLimit-*` set is off: two
    // spellings of one budget is a client asking which to believe.
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: adminRateKey,
    skipSuccessfulRequests: spec.skipSuccessfulRequests,
    // Counting continues in log-only mode; only the refusal is suppressed, so
    // the measurement the mode exists for is real.
    skip: () => ADMIN_RATE_LIMIT_LOG_ONLY,
    handler: (req: Request, res: Response) => {
      const retryAfter = RETRY_AFTER_SECONDS(spec.windowMs);
      res.setHeader('Retry-After', String(retryAfter));
      /**
       * A safe domain error, never the limiter's own prose (§21).
       *
       * The message names no budget, no window and no bucket. "You have made
       * 61 of 60 requests in this 60s window" tells an attacker exactly how
       * hard to push and how long to wait, and tells a legitimate admin
       * nothing they can act on beyond "wait".
       */
      res
        .status(429)
        .json(rateLimitBody('Too many requests. Please wait a moment and try again.'));
    },
  });
};

const LIMITERS: Record<AdminBucketName, ReturnType<typeof build>> = {
  adminRead: build('adminRead'),
  adminMutation: build('adminMutation'),
  adminSensitive: build('adminSensitive'),
};

/**
 * Chooses the tier per request and delegates.
 *
 * One mounted middleware rather than three, because the tier depends on the
 * path and the method, which are only known per request. The limiter instances
 * themselves are built once at module load — building one per request would
 * give every request a fresh, empty counter, which is a rate limiter that
 * limits nothing while looking like it works.
 */
export const adminRateLimit = (req: Request, res: Response, next: NextFunction): void => {
  const tier = adminTierFor(req.method, req.baseUrl ? `${req.baseUrl}${req.path}` : req.path);
  LIMITERS[tier](req, res, next);
};
