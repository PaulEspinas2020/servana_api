/**
 * Detects a sign-in that is about to create a SECOND account for someone who
 * already has one.
 *
 * Firebase issues a uid per identifier. A provider who registered with an email
 * and then signs in with their mobile number arrives as a completely different
 * uid, and upsertFirebaseUser keys on uid — so it happily creates a new row.
 * The person signs in successfully and lands in an empty account: no jobs, no
 * earnings, no history. Nothing errors, which is what makes it bad. They are
 * liable to conclude their data is gone and re-enter it, and now the platform
 * has two half-populated accounts for one provider.
 *
 * This does NOT merge accounts and does not sign anyone in as somebody else.
 * Merging means issuing a session for uid A because Firebase authenticated
 * uid B, and while possession of a verified number is decent evidence, "decent
 * evidence" is not the bar for handing over an account holding someone's
 * earnings. That step needs a deliberate decision and a linking flow, not a
 * silent inference at the login endpoint.
 *
 * What it does is refuse to make the mess quietly: it reports the collision so
 * the caller can tell the person to sign in the way they registered.
 */

import dbQuery from "../db/dbQuery";
import { db } from "../config";
import { toE164PhMobile, normalizeEmail } from "../helpers/phoneIdentifier";

const s = db.schema;

export type Collision = {
  existingUid: string;
  /** Which identifier already belongs to another account. */
  via: "mobile" | "email";
};

/**
 * The last-10-digits form of a PH mobile, for comparing against rows whose
 * phone_normalized has not been backfilled yet.
 *
 * Deliberately mirrors toE164PhMobile's acceptance rule rather than being
 * merely "close": strip non-digits, take the last ten, require a leading 9. A
 * looser rule here would match rows the strict normalizer would not, which is
 * how a lookup starts returning somebody else's account.
 */
function subscriberDigits(e164: string): string | null {
  const digits = e164.replace(/[^0-9]/g, "");
  const last10 = digits.slice(-10);
  return /^9[0-9]{9}$/.test(last10) ? last10 : null;
}

/**
 * Does this identifier already belong to a DIFFERENT account?
 *
 * `incomingUid` is excluded so a returning user matching their own row is not
 * reported as a collision.
 *
 * The raw-column fallback exists because the normalized columns are only
 * populated for rows that have been written since they were added, or by the
 * backfill. Without it this guard would be inert on exactly the legacy accounts
 * it needs to protect — which is the whole population that can hit this today.
 */
export async function findLinkCollision(
  incomingUid: string,
  email: string | null,
  phoneNumber: string | null
): Promise<Collision | null> {
  const e164 = toE164PhMobile(phoneNumber);
  if (e164) {
    const sub = subscriberDigits(e164);
    const { rows } = await dbQuery.query(
      `SELECT uid FROM ${s}.user_credentials
        WHERE uid <> $1
          AND (
            phone_normalized = $2
            OR (phone_normalized IS NULL
                AND phone_number IS NOT NULL
                AND right(regexp_replace(phone_number, '[^0-9]', '', 'g'), 10) = $3)
          )
        LIMIT 1`,
      [incomingUid, e164, sub]
    );
    if (rows[0]?.uid) return { existingUid: rows[0].uid, via: "mobile" };
  }

  const normalizedEmail = normalizeEmail(email);
  if (normalizedEmail) {
    const { rows } = await dbQuery.query(
      `SELECT uid FROM ${s}.user_credentials
        WHERE uid <> $1
          AND (email_normalized = $2
               OR (email_normalized IS NULL AND lower(btrim(email)) = $2))
        LIMIT 1`,
      [incomingUid, normalizedEmail]
    );
    if (rows[0]?.uid) return { existingUid: rows[0].uid, via: "email" };
  }

  return null;
}

/** Thrown by the login path; the controller turns this into a 409. */
export class AccountLinkRequiredError extends Error {
  readonly code = "ACCOUNT_LINK_REQUIRED";
  readonly via: Collision["via"];
  constructor(via: Collision["via"]) {
    super(
      via === "mobile"
        ? "This mobile number is already registered to an account. Sign in with the email address you registered with."
        : "This email address is already registered to an account. Sign in with the mobile number you registered with."
    );
    this.via = via;
  }
}
