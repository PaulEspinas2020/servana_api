import dbQuery from "../db/dbQuery";
import { db } from "../config";
import {
  normalizeEmail,
  toE164PhMobile,
  detectIdentifierType,
  type IdentifierType,
} from "../helpers/phoneIdentifier";

const s = db.schema;

/**
 * Resolve "email or mobile number" to one account (Command 5 §7, §8).
 *
 * Sign-in took an `email` field and looked it up directly, so a provider who
 * registered with a mobile number had no way in — and, because Firebase phone
 * auth was never enabled, no way to have registered with one either.
 *
 * One resolver, one lookup, whichever the provider typed.
 *
 * ── On enumeration ───────────────────────────────────────────────────────────
 * This returns null for "no such account" and for "malformed identifier"
 * alike, and callers must render the same message for both. §19 requires
 * equivalent responses because the difference between "that email is not
 * registered" and "wrong password" is a free membership check for anyone
 * holding a list of addresses.
 *
 * The lookup is a single indexed query in both cases, so the timing does not
 * separate them either — which matters more than the message, since an attacker
 * measuring response time does not read English.
 */

export type ResolvedAccount = {
  uid: string;
  email: string | null;
  emailNormalized: string | null;
  phoneNormalized: string | null;
  role: number | null;
  accountStatus: string | null;
  isEmailVerified: boolean;
  isMobileVerified: boolean;
};

export type Resolution = {
  type: IdentifierType;
  normalized: string | null;
  account: ResolvedAccount | null;
};

const SELECT_COLS = `
  uid,
  email,
  email_normalized,
  phone_normalized,
  role::int          AS role,
  account_status,
  COALESCE(is_email_verified,  false) AS is_email_verified,
  COALESCE(is_mobile_verified, false) AS is_mobile_verified
`;

const toAccount = (r: any): ResolvedAccount => ({
  uid: r.uid,
  email: r.email ?? null,
  emailNormalized: r.email_normalized ?? null,
  phoneNormalized: r.phone_normalized ?? null,
  role: r.role ?? null,
  accountStatus: r.account_status ?? null,
  isEmailVerified: r.is_email_verified === true,
  isMobileVerified: r.is_mobile_verified === true,
});

/**
 * Find the account for a typed identifier.
 *
 * Never throws on a malformed identifier — it resolves to `account: null`, so
 * the caller answers "invalid credentials" rather than "invalid email format",
 * which would confirm that the format check is the only thing standing between
 * the caller and an answer.
 */
export async function resolveIdentifier(raw: unknown): Promise<Resolution> {
  const type = detectIdentifierType(raw);

  if (type === "email") {
    const normalized = normalizeEmail(raw);
    if (!normalized) return { type, normalized: null, account: null };
    const { rows } = await dbQuery.query(
      `SELECT ${SELECT_COLS} FROM ${s}.user_credentials
       WHERE email_normalized = $1
       LIMIT 1`,
      [normalized]
    );
    // Fall back to the raw column for rows written before normalization
    // existed and not yet backfilled. Case-insensitive, because that is the
    // duplicate-account bug normalization exists to prevent and it must not
    // reappear in the fallback.
    if (!rows.length) {
      const legacy = await dbQuery.query(
        `SELECT ${SELECT_COLS} FROM ${s}.user_credentials
         WHERE LOWER(email) = $1
         LIMIT 1`,
        [normalized]
      );
      return {
        type,
        normalized,
        account: legacy.rows[0] ? toAccount(legacy.rows[0]) : null,
      };
    }
    return { type, normalized, account: toAccount(rows[0]) };
  }

  if (type === "mobile") {
    const normalized = toE164PhMobile(raw);
    if (!normalized) return { type, normalized: null, account: null };
    const { rows } = await dbQuery.query(
      `SELECT ${SELECT_COLS} FROM ${s}.user_credentials
       WHERE phone_normalized = $1
       LIMIT 1`,
      [normalized]
    );
    // No raw-column fallback for phone. `phone_number` holds whatever anyone
    // ever typed, in any format, so matching against it would either miss the
    // row or match the wrong one — and matching the wrong row on a SIGN-IN
    // lookup is how one provider ends up in another's account. A legacy row
    // with no normalized form simply cannot be used to sign in until the
    // backfill reaches it, which is the safe failure.
    return { type, normalized, account: rows[0] ? toAccount(rows[0]) : null };
  }

  return { type: "unknown", normalized: null, account: null };
}

/**
 * Is this identifier verified for the account it resolves to?
 *
 * §1: only verified identifiers may be used for sensitive recovery. Sign-in is
 * deliberately NOT gated on this — locking someone out of an account they can
 * prove they own, because they never clicked a link, creates a support ticket
 * rather than security. Recovery is where it matters, because that is where an
 * unverified identifier would let someone claim an account they merely typed.
 */
export function isIdentifierVerified(res: Resolution): boolean {
  if (!res.account) return false;
  if (res.type === "email") return res.account.isEmailVerified;
  if (res.type === "mobile") return res.account.isMobileVerified;
  return false;
}
