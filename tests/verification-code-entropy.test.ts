/**
 * Verification codes and temporary passwords must come from a CSPRNG.
 *
 * Command 19 §13. `generateOTP` used `Math.random()` — a non-cryptographic
 * PRNG whose internal state is recoverable from observed output, after which
 * every subsequent value is predictable.
 *
 * The reason that was serious is the blast radius. One function backed:
 *
 *   - authentication OTPs        (auth.service — sign-in and verification)
 *   - booking OTPs               (bookingService)
 *   - the job-start worker code  (adminCreateBookingService, technicianService)
 *
 * So a single predictable stream guarded account access AND arrival
 * verification. `generateTempPassword` had the same defect on a credential
 * handed to a real account.
 *
 * These tests pin the OUTPUT CONTRACT (so no caller breaks) and the SOURCE
 * (so nobody reintroduces Math.random by reflex).
 */
import * as fs from "fs";
import * as path from "path";
import { generateOTP } from "../src/helpers/otp";

const read = (rel: string) =>
  fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

/**
 * Strips comments before scanning for `Math.random`.
 *
 * Without this the check matches the doc comments that EXPLAIN the old
 * implementation, and reports the fix as the defect. That false-positive class
 * has bitten this repo before: a detector matched five of its own fix notes.
 */
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

describe("the OTP contract is unchanged", () => {
  it("is always six digits", () => {
    for (let i = 0; i < 500; i++) {
      expect(generateOTP()).toMatch(/^\d{6}$/);
    }
  });

  it("stays within 100000–999999 inclusive", () => {
    for (let i = 0; i < 500; i++) {
      const n = Number(generateOTP());
      expect(n).toBeGreaterThanOrEqual(100_000);
      expect(n).toBeLessThanOrEqual(999_999);
    }
  });

  it("never returns a leading zero, which would break six-digit entry", () => {
    for (let i = 0; i < 200; i++) {
      expect(generateOTP().startsWith("0")).toBe(false);
    }
  });
});

describe("output is not obviously degenerate", () => {
  // Not a randomness proof — that is what the CSPRNG is for. This catches a
  // catastrophic regression such as a constant or a tight cycle.
  it("produces many distinct values across a large sample", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) seen.add(generateOTP());
    expect(seen.size).toBeGreaterThan(1800);
  });

  it("spreads across the full range rather than clustering", () => {
    const buckets = new Array(9).fill(0);
    for (let i = 0; i < 4500; i++) {
      buckets[Math.floor(Number(generateOTP()) / 100_000) - 1]++;
    }
    // Uniform would be 500 per bucket; allow generous slack for sampling noise
    // while still failing a generator that ignores part of the range.
    for (const count of buckets) {
      expect(count).toBeGreaterThan(300);
      expect(count).toBeLessThan(750);
    }
  });
});

describe("Math.random cannot come back", () => {
  it("the OTP helper uses the crypto CSPRNG", () => {
    const src = code("src/helpers/otp.ts");
    expect(src).toMatch(/randomInt/);
    expect(src).not.toMatch(/Math\.random/);
  });

  it("the temporary-password generator uses it too", () => {
    const src = code("src/services/auth.service.ts");
    const fn = src.slice(
      src.indexOf("const generateTempPassword"),
      src.indexOf("const addEmployees")
    );
    expect(fn).toMatch(/randomInt/);
    expect(fn).not.toMatch(/Math\.random/);
  });

  it("the id generator uses it too", () => {
    const src = code("src/helpers/idGenerator.ts");
    const fn = src.slice(src.indexOf("const randomFixedInteger"));
    expect(fn.slice(0, 400)).not.toMatch(/Math\.random/);
  });

  it("no security-relevant helper still reaches for Math.random", () => {
    for (const f of ["src/helpers/otp.ts", "src/helpers/idGenerator.ts"]) {
      expect(code(f)).not.toMatch(/Math\.random/);
    }
  });
});
