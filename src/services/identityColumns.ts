import dbQuery from "../db/dbQuery";
import { db } from "../config";
import { toE164PhMobile, normalizeEmail } from "../helpers/phoneIdentifier";

const s = db.schema;

/**
 * Normalized identifier columns on `user_credentials` (Command 5 §3, §15).
 *
 * The platform already solved this — for guests. `guest_customers` carries
 * `phone_normalized` with a UNIQUE index, precisely so two spellings of one
 * number cannot become two guest records. `user_credentials` carried a raw
 * `phone_number` with no normalized form and no constraint at all, so the same
 * protection was absent for the accounts that can actually sign in.
 *
 * Additive and nullable. Nothing reads these yet; adding the columns and the
 * indexes first means the backfill and the sign-in work can land separately and
 * be reverted separately.
 *
 * ── Why the indexes are PARTIAL ──────────────────────────────────────────────
 * `WHERE ... IS NOT NULL`. Postgres treats NULLs as distinct in a unique index,
 * so plain unique indexes would already permit many NULL rows — but stating the
 * predicate makes the intent explicit and keeps the index small, since most
 * rows will carry one identifier and not the other.
 *
 * ── Why they are created CONCURRENTLY-safe rather than blindly ───────────────
 * A unique index over existing data FAILS if duplicates are already present.
 * That is the correct behaviour and must not be swallowed: a failure here means
 * two accounts already share an identifier, which is exactly the conflict §16
 * says to quarantine for manual review rather than resolve by guessing. The
 * error is logged with a count and no personal data, and the rest of the schema
 * work continues.
 */
export const ensureIdentityColumns = async (): Promise<void> => {
  await dbQuery.query(
    `ALTER TABLE ${s}.user_credentials
       ADD COLUMN IF NOT EXISTS email_normalized  VARCHAR(254),
       ADD COLUMN IF NOT EXISTS phone_normalized  VARCHAR(20),
       ADD COLUMN IF NOT EXISTS is_mobile_verified BOOLEAN NOT NULL DEFAULT false`,
    []
  );

  // Non-unique lookup indexes first: sign-in needs these regardless of whether
  // the uniqueness constraints can be applied yet.
  await dbQuery.query(
    `CREATE INDEX IF NOT EXISTS idx_uc_email_normalized
       ON ${s}.user_credentials (email_normalized)
       WHERE email_normalized IS NOT NULL`,
    []
  );
  await dbQuery.query(
    `CREATE INDEX IF NOT EXISTS idx_uc_phone_normalized
       ON ${s}.user_credentials (phone_normalized)
       WHERE phone_normalized IS NOT NULL`,
    []
  );

  for (const [name, column] of [
    ["idx_uc_email_normalized_unique", "email_normalized"],
    ["idx_uc_phone_normalized_unique", "phone_normalized"],
  ]) {
    try {
      await dbQuery.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${name}
           ON ${s}.user_credentials (${column})
           WHERE ${column} IS NOT NULL`,
        []
      );
    } catch (e: any) {
      // Do NOT swallow this into silence and do NOT resolve it automatically.
      // A duplicate here means two accounts already claim one identifier, and
      // §16 is explicit that ambiguous ownership is quarantined for review
      // rather than merged by a script.
      const { rows } = await dbQuery.query(
        `SELECT COUNT(*)::int AS n FROM (
           SELECT ${column} FROM ${s}.user_credentials
           WHERE ${column} IS NOT NULL
           GROUP BY ${column} HAVING COUNT(*) > 1
         ) d`,
        []
      ).catch(() => ({ rows: [{ n: -1 }] }));
      console.error(
        `[identity] UNIQUE index ${name} could not be created: ` +
          `${rows[0]?.n ?? "unknown"} duplicate value(s) exist. ` +
          `Run scripts/audit-identifier-conflicts.ts — do not resolve these by hand ` +
          `without evidence of ownership.`
      );
    }
  }
};

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
