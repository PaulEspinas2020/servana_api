import { toE164PhMobile, normalizeEmail } from "../helpers/phoneIdentifier";

/**
 * Normalized identifier columns on `user_credentials` (Command 5 §3, §15).
 *
 * ── Schema (TAB 02) ──────────────────────────────────────────────────────────
 *
 * `ensureIdentityColumns` used to add `email_normalized`, `phone_normalized` and
 * `is_mobile_verified`, then create four indexes. It is gone. All of it comes
 * from `scripts/baseline/000-baseline.sql`, which carries the three columns and
 * ALL FOUR indexes — including the two UNIQUE ones this code could only attempt.
 *
 * That is the load-bearing detail. The removed function tried
 * `CREATE UNIQUE INDEX` inside a try/catch because a unique index over existing
 * data FAILS when duplicates are already present, and §16 says ambiguous
 * ownership is quarantined for review rather than merged by a script. The
 * baseline HAS `idx_uc_email_normalized_unique` and
 * `idx_uc_phone_normalized_unique`, so in production that attempt already
 * succeeded: no duplicate identifiers exist there. The diagnostic is not lost,
 * it is answered.
 *
 * The partial predicate on every one of them is `WHERE … IS NOT NULL`. Postgres
 * treats NULLs as distinct in a unique index anyway, but the predicate keeps the
 * index small, since most rows carry one identifier and not the other.
 *
 * ── Why this function existing at all was a hazard ───────────────────────────
 *
 * It was written, added to no boot path, and every Firebase sign-in failed with
 * 42703 until somebody noticed — the incident `providerActivationService` cites.
 * Sign-in resolves an account through these columns, so their absence tells a
 * caller their credentials are wrong when they are not. Deleting the bootstrap
 * removes that failure mode rather than re-arming it: the columns no longer
 * depend on any application code having run, and `npm run schema:authority`
 * fails if a future change reintroduces a runtime-only object.
 *
 * If you need the duplicate audit, it still exists:
 * `scripts/audit-identifier-conflicts.ts`.
 */

/**
 * Derive the normalized forms for one account.
 *
 * Returns nulls rather than throwing: a legacy row with an unparseable phone
 * number must not block a sign-in. It simply has no normalized form, and so
 * cannot be used as a lookup key until it is corrected — which is the safe
 * failure, because the alternative is inventing a key for a number nobody can
 * receive an SMS at.
 */
export const deriveNormalized = (
  email: string | null | undefined,
  phone: string | null | undefined
): { emailNormalized: string | null; phoneNormalized: string | null } => ({
  emailNormalized: normalizeEmail(email),
  phoneNormalized: toE164PhMobile(phone),
});
