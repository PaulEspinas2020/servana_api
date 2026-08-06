import { randomInt } from "crypto";

/**
 * Generates a six-digit verification code.
 *
 * Command 19 §13. This used `Math.random()`:
 *
 *   Math.floor(100000 + Math.random() * 900000).toString()
 *
 * `Math.random()` is a non-cryptographic PRNG (xorshift128+ in V8). It is
 * seeded per process, its internal state is recoverable from a modest number
 * of observed outputs, and every subsequent value is predictable after that.
 * It carries no unpredictability guarantee and must not back a secret.
 *
 * That matters more than the name "OTP" suggests, because this one function
 * backs all of:
 *
 *   - authentication OTPs        (auth.service — sign-in and verification)
 *   - booking OTPs               (bookingService)
 *   - the job-start worker code  (adminCreateBookingService, technicianService)
 *
 * So a single predictable stream guarded both account access and arrival
 * verification. `randomInt` draws from the OS CSPRNG and rejection-samples, so
 * the distribution stays uniform with no modulo bias.
 *
 * The output contract is unchanged — a six-character string of digits, 100000
 * through 999999 inclusive — so no caller needs a change.
 */
export const generateOTP = (): string => {
  // randomInt's upper bound is exclusive.
  return randomInt(100_000, 1_000_000).toString();
};
