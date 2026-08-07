import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import { rateLimitBody } from "../helpers/rateLimitBody";

/**
 * Throttles job-start attempts, which are worker-code guesses.
 *
 * Command 19 §13 (LJ-02). The job-start worker code is a six-digit secret the
 * customer reads out to the provider, and matching it is the only gate on
 * starting a chargeable job. Validation happens inside the compare-and-swap,
 * which is correct — but a miss simply returned "Job cannot be started" with no
 * attempt counter, no lockout and nothing throttling retries.
 *
 * Six digits is 900,000 possibilities. Unlimited attempts makes that tractable,
 * which would let an assigned provider start a job they never attended — the
 * exact fraud the code exists to prevent.
 *
 * ── Why this lives in its own module ──────────────────────────────────────
 * TWO routes validate the worker code: `/worker/bookings/:id/start` and the
 * legacy `/workers/bookings/:id/start`. `rateLimit()` keeps its counters in
 * per-instance memory, so building one limiter per route file would give an
 * attacker two independent budgets and halve the protection for free. Both
 * routes import THIS instance so they share one counter.
 *
 * ── Keying ────────────────────────────────────────────────────────────────
 * Keyed by the authenticated provider, not by IP. The caller must already be
 * the assigned provider for the route to do anything, so the provider is the
 * identity worth limiting — and IP keying would punish every provider behind
 * one mobile carrier NAT. `ipKeyGenerator` is the fallback for the
 * should-never-happen case of an unauthenticated request reaching here; it
 * normalises IPv6 correctly, which a bare `req.ip` does not.
 *
 * Generous enough that a provider mistyping a code read out over a noisy
 * driveway is unaffected; tight enough that brute force is not.
 */
export const workerCodeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => req.user?.uid ?? ipKeyGenerator(req),
  // A correct code must not consume the budget: a provider legitimately
  // starting several jobs in one shift is not a brute-force attempt.
  skipSuccessfulRequests: true,
  message: rateLimitBody(
    "Too many incorrect job codes. Please wait a few minutes, or contact support if the customer cannot provide the code."
  ),
});

export default workerCodeLimiter;
