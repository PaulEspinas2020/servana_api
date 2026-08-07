/**
 * Job-start attempts are worker-code guesses, and must be throttled.
 *
 * Command 19 §13 (LJ-02). The worker code is a six-digit secret the customer
 * reads out to the provider, and matching it is the only gate on starting a
 * chargeable job. Validation happens inside the compare-and-swap — correct —
 * but a miss returned "Job cannot be started" with no attempt counter, no
 * lockout and nothing throttling retries. 900,000 possibilities with unlimited
 * tries is tractable.
 *
 * The property that matters most here is that BOTH start routes share ONE
 * limiter instance. `rateLimit()` keeps counters in per-instance memory, so a
 * limiter built separately in each route file would hand an attacker two
 * independent budgets.
 */
import * as fs from "fs";
import * as path from "path";

const read = (rel: string) =>
  fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

/** Comments stripped, so prose describing the fix cannot satisfy a check. */
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

const PROVIDER_ROUTES = "src/routes/provider.routes.ts";
const LEGACY_ROUTES = "src/routes/technician.routes.ts";
const LIMITER = "src/middleware/workerCodeLimiter.ts";

describe("every route that validates the worker code is limited", () => {
  it("the canonical start route applies the limiter", () => {
    const line = code(PROVIDER_ROUTES)
      .split("\n")
      .find((l) => l.includes('"/worker/bookings/:bookingId/start"'));
    expect(line).toBeDefined();
    expect(line).toContain("workerCodeLimiter");
  });

  it("the legacy start route applies it too", () => {
    // Limiting only one route leaves the other as a bypass.
    const line = code(LEGACY_ROUTES)
      .split("\n")
      .find((l) => l.includes('"/workers/bookings/:bookingId/start"'));
    expect(line).toBeDefined();
    expect(line).toContain("workerCodeLimiter");
  });

  it("both import the SAME instance rather than building their own", () => {
    // Two rateLimit() calls means two counters means two budgets.
    for (const f of [PROVIDER_ROUTES, LEGACY_ROUTES]) {
      const src = code(f);
      expect(src).toContain("middleware/workerCodeLimiter");
      expect(src).not.toMatch(/rateLimit\(\{/);
    }
  });

  it("the limiter is defined exactly once in the codebase", () => {
    const src = code(LIMITER);
    expect((src.match(/rateLimit\(\{/g) ?? []).length).toBe(1);
  });
});

describe("the limiter is configured for this threat", () => {
  const src = code(LIMITER);

  it("keys on the authenticated provider, not the IP", () => {
    // The caller must already be the assigned provider, so the provider is the
    // identity worth limiting — and IP keying punishes everyone behind one
    // mobile carrier NAT.
    expect(src).toMatch(/keyGenerator/);
    expect(src).toMatch(/req\.user\?\.uid/);
  });

  it("falls back to the IPv6-safe key generator, not a bare req.ip", () => {
    expect(src).toMatch(/ipKeyGenerator/);
    expect(src).not.toMatch(/=>\s*req\.ip\b/);
  });

  it("does not count successful starts against the budget", () => {
    // A provider legitimately starting several jobs in a shift is not a
    // brute-force attempt; only failures are guesses.
    expect(src).toMatch(/skipSuccessfulRequests:\s*true/);
  });

  it("bounds attempts well below the six-digit search space", () => {
    const max = Number(/max:\s*(\d+)/.exec(src)?.[1]);
    expect(max).toBeGreaterThan(3); // a mistyped code must not lock a provider out
    expect(max).toBeLessThan(60); // and must not leave brute force viable
  });

  it("uses a window measured in minutes, not seconds", () => {
    const src2 = code(LIMITER);
    expect(src2).toMatch(/windowMs:\s*\d+\s*\*\s*60\s*\*\s*1000/);
  });

  it("returns the dual-layout rate-limit body so a 429 cannot crash a client", () => {
    // rateLimitBody emits both the flat and nested error shapes; a client that
    // throws while parsing a 429 turns "slow down" into a retry storm.
    expect(src).toMatch(/rateLimitBody/);
  });
});
