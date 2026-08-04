import dbQuery from "../db/dbQuery";
import { db } from "../config";

const s = db.schema;

/**
 * Records what Firebase has already proven about an account's identifiers.
 *
 * Masterlist S-06. `is_mobile_verified` was added by `identityColumns.ts` with
 * `DEFAULT false`, is read in three places — the account-state endpoint, the
 * identifier resolver, the link guard — and was written by NOTHING. Not once,
 * anywhere in the codebase.
 *
 * The consequence only became visible when Command 6 shipped. The state
 * endpoint requires at least one verified identifier before anything else:
 *
 *   minimumRequirementMet = email === "VERIFIED" || mobile === "VERIFIED"
 *
 * and `IDENTIFIER_VERIFICATION_REQUIRED` sits second in the precedence, above
 * profile, documents, application and activation. So a provider who signs in by
 * OTP — proving possession of the number to Firebase every single time — was
 * held at a verification step they had just completed, permanently, because the
 * column recording it was never written.
 *
 * Measured on production 2026-08-04: 68 of 70 providers had NO verified
 * identifier of any kind, and 29 of them have no email at all, so OTP is the
 * only way they can ever authenticate. Every one of those was pinned at
 * IDENTIFIER_VERIFICATION_REQUIRED with no reachable way out.
 *
 * ── Only ever upwards ───────────────────────────────────────────────────────
 * This sets flags to true and never to false. A provider verified through the
 * older email-OTP flow carries `is_email_verified = true` in a Firebase record
 * that knows nothing about it; clearing that on a phone sign-in would revoke a
 * verification that genuinely happened. Absence of proof is not proof of
 * absence.
 */
export type ProvenIdentifiers = {
  /** Firebase reports the email address as verified. */
  emailVerified: boolean;
  /** A phone credential is linked, which Firebase only does after an OTP. */
  mobileVerified: boolean;
};

/**
 * Reads the proof out of a verified Firebase token and its user record.
 *
 * `sign_in_provider === "phone"` covers the OTP that just happened.
 * `providerData` covers a returning provider signing in another way with a
 * phone credential already linked — the number was proven once and stays
 * proven.
 *
 * A phone number attached by `accountLinking` via `updateUser` also lands in
 * `providerData`, and that is correct rather than a loophole: that write only
 * runs after the incoming uid completed an OTP for the number seconds earlier.
 */
export function provenFrom(decoded: any, firebaseUser: any): ProvenIdentifiers {
  const provider = decoded?.firebase?.sign_in_provider;
  const linked = Array.isArray(firebaseUser?.providerData)
    ? firebaseUser.providerData.some((p: any) => p?.providerId === "phone")
    : false;

  return {
    emailVerified: firebaseUser?.emailVerified === true,
    mobileVerified: provider === "phone" || linked,
  };
}

/**
 * Persists the proof, if it adds anything.
 *
 * The WHERE clause makes this a no-op for an account already marked, so a
 * returning provider's sign-in costs a lookup and no write. Returns whether a
 * row changed, which is what the backfill counts.
 */
export async function recordProvenIdentifiers(
  uid: string,
  proven: ProvenIdentifiers
): Promise<boolean> {
  if (!proven.emailVerified && !proven.mobileVerified) return false;

  const { rowCount } = await dbQuery.query(
    `UPDATE ${s}.user_credentials
        SET is_email_verified  = COALESCE(is_email_verified, false)  OR $2,
            is_mobile_verified = COALESCE(is_mobile_verified, false) OR $3
      WHERE uid = $1
        AND ( ($2 AND COALESCE(is_email_verified, false)  IS NOT TRUE)
           OR ($3 AND COALESCE(is_mobile_verified, false) IS NOT TRUE) )`,
    [uid, proven.emailVerified, proven.mobileVerified]
  );

  return (rowCount ?? 0) > 0;
}
