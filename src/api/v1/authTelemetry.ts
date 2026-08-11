/**
 * Auth outcome rates, by client and version.
 *
 * ## What it is for
 *
 * "Provider live sign-in remains healthy" is a release gate, and today there is
 * no way to answer it. A provider who cannot sign in produces a 401 that looks
 * exactly like every other 401 in the log — the same shape a customer gets from
 * a typo. When something breaks, the first question is always "is this one
 * person or everyone on version 2.4.1", and nothing in this backend can answer
 * it.
 *
 * One counter per (operation, outcome, client) per window answers it.
 *
 * ## What it must never record
 *
 * No password. No OTP. No token, ID or refresh. No oobCode. No email address,
 * no phone number, no uid. The outcome CODE and a coarse client label, nothing
 * else — an auth log that names who failed is a log that has to be protected
 * like the credential itself, and this one deliberately holds nothing worth
 * stealing.
 *
 * `tests/v1-auth-security.test.ts` feeds it real-looking secrets and asserts
 * none of them appear in the snapshot or the emitted line.
 */

import { clientLabel } from './legacyTelemetry';
import type { Request } from 'express';

export type AuthOperation =
  | 'login'
  | 'register'
  | 'refresh'
  | 'logout'
  | 'forgot_password'
  | 'reset_password'
  | 'verify_email'
  | 'verify_mobile'
  | 'resend_verification';

/** `success`, or the canonical error code. Never free text. */
export type AuthOutcome = string;

interface Bucket {
  total: number;
  outcomes: Map<AuthOutcome, number>;
  clients: Map<string, number>;
}

const WINDOW_MS = 60 * 60 * 1000;

let buckets = new Map<AuthOperation, Bucket>();
let windowStartedAt = Date.now();

const rollWindowIfDue = () => {
  if (Date.now() - windowStartedAt < WINDOW_MS) return;
  if (buckets.size) report();
  buckets = new Map();
  windowStartedAt = Date.now();
};

/**
 * One line per operation per window.
 *
 * Failure rate is stated rather than left to be computed from two numbers,
 * because the number somebody wants at 2am is "what fraction of provider
 * sign-ins are failing" and making them divide it is how it gets read wrong.
 */
export function report(): void {
  for (const [operation, bucket] of buckets) {
    const failures = [...bucket.outcomes.entries()]
      .filter(([code]) => code !== 'success')
      .sort((a, b) => b[1] - a[1]);
    const failed = failures.reduce((n, [, count]) => n + count, 0);
    const rate = bucket.total ? Math.round((failed / bucket.total) * 100) : 0;
    const clients = [...bucket.clients.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, n]) => `${name}=${n}`)
      .join(' ');
    const codes = failures.map(([code, n]) => `${code}=${n}`).join(' ');
    // eslint-disable-next-line no-console
    console.info(
      `[auth-telemetry] ${operation} total=${bucket.total} failed=${failed} rate=${rate}% ` +
        `codes=[${codes}] clients=[${clients}]`,
    );
  }
}

/**
 * Records one attempt.
 *
 * Never throws. This sits on the sign-in path for five clients; a bug in a
 * counter must not be able to stop anybody logging in.
 */
export function recordAuthOutcome(
  req: Request,
  operation: AuthOperation,
  outcome: AuthOutcome,
): void {
  try {
    rollWindowIfDue();
    const bucket = buckets.get(operation) ?? {
      total: 0,
      outcomes: new Map<AuthOutcome, number>(),
      clients: new Map<string, number>(),
    };
    bucket.total += 1;
    bucket.outcomes.set(outcome, (bucket.outcomes.get(outcome) ?? 0) + 1);
    // Reuses the legacy telemetry's labeller, which prefers an explicit
    // X-Servana-Client header and otherwise reports a coarse User-Agent FAMILY
    // — never the raw User-Agent, which carries device and OS build on mobile.
    const label = clientLabel(req);
    bucket.clients.set(label, (bucket.clients.get(label) ?? 0) + 1);
    buckets.set(operation, bucket);
  } catch {
    // Observability must never take the request down.
  }
}

export interface AuthSnapshot {
  windowStartedAt: number;
  operations: Array<{
    operation: AuthOperation;
    total: number;
    failed: number;
    failureRatePct: number;
    outcomes: Record<string, number>;
    clients: Record<string, number>;
  }>;
}

export function snapshot(): AuthSnapshot {
  return {
    windowStartedAt,
    operations: [...buckets.entries()].map(([operation, bucket]) => {
      const failed = [...bucket.outcomes.entries()]
        .filter(([code]) => code !== 'success')
        .reduce((n, [, count]) => n + count, 0);
      return {
        operation,
        total: bucket.total,
        failed,
        failureRatePct: bucket.total ? Math.round((failed / bucket.total) * 100) : 0,
        outcomes: Object.fromEntries(bucket.outcomes),
        clients: Object.fromEntries(bucket.clients),
      };
    }),
  };
}

/** Test seam. */
export function __resetAuthTelemetry(): void {
  buckets = new Map();
  windowStartedAt = Date.now();
}
