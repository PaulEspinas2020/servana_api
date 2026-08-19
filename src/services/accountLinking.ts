/**
 * One provider, one account, reachable by email OR mobile.
 *
 * Firebase issues a uid per identifier, so a provider who registered by email
 * and signs in by mobile arrives as a different uid. Rather than keep two
 * accounts and translate between them forever, the second uid is folded into
 * the first at the Firebase level so only ONE uid ever exists.
 *
 * That choice matters. The alternative — an alias table mapping uid B to uid A,
 * resolved in auth middleware — leaves every query, foreign key and report in
 * the codebase working on a uid that may or may not be canonical, and one
 * forgotten call site silently reads the wrong provider's data. Attaching the
 * phone to the existing Firebase user means the rest of the system never learns
 * that any of this happened.
 *
 * ── The safety bar ──────────────────────────────────────────────────────────
 * Merging grants full access to an account holding someone's earnings, so it
 * requires ALL of:
 *
 *   1. The incoming sign-in was PHONE auth. Possession of the number must be
 *      proven by the flow that is being linked — an email sign-in that happens
 *      to mention a phone number proves nothing about that number.
 *   2. The number parses as a real PH mobile under the strict normalizer.
 *   3. The incoming uid is BRAND NEW — no user_credentials row. If it has one,
 *      merging is a data migration rather than an auth step, and it stops.
 *   4. Exactly ONE existing account claims that number.
 *   5. That account is not archived.
 *
 * Any of these failing means no merge, and the caller falls back to telling the
 * person which identifier to use.
 *
 * ── The residual risk, stated plainly ───────────────────────────────────────
 * A provider whose recorded mobile number is STALE or MISTYPED can be claimed
 * by whoever now holds that number. This is the same exposure as SMS account
 * recovery anywhere, and it is the direct consequence of treating a mobile as
 * an identifier. `is_mobile_verified` exists to tighten this later; it is not
 * gated on today because nothing sets it yet, and gating on it would mean
 * nobody can ever link.
 */

import { getAuth as getAuthAdmin } from "firebase-admin/auth";
import { getFirebaseAdmin } from "../middleware/firebaseApp";
import dbQuery from "../db/dbQuery";
import { db } from "../config";
import { toE164PhMobile } from "../helpers/phoneIdentifier";

const s = db.schema;
const auth = () => getAuthAdmin(getFirebaseAdmin());

export type MergeOutcome =
  | { merged: true; canonicalUid: string; customToken: string }
  | { merged: false; reason: string };

/** Firebase records phone sign-in as this provider id on the decoded token. */
export const PHONE_PROVIDER = "phone";

/**
 * Fold `incomingUid` into the account that already owns this mobile number.
 *
 * Returns a custom token for the canonical account so the client can complete
 * sign-in immediately. Without it the person would have to request a second
 * OTP, having already proven possession of the number seconds earlier — an
 * extra step whose only function is to make the merge visible.
 */
export async function mergePhoneIntoExistingAccount(opts: {
  incomingUid: string;
  signInProvider: string | undefined;
  phoneNumber: string | null;
  canonicalUid: string;
}): Promise<MergeOutcome> {
  const { incomingUid, signInProvider, phoneNumber, canonicalUid } = opts;

  // (1) The number must have been proven by THIS sign-in.
  if (signInProvider !== PHONE_PROVIDER) {
    return { merged: false, reason: "sign-in was not phone auth" };
  }

  // (2) Strict parse. A number nobody can receive an SMS at must never become
  // the key that hands over an account.
  const e164 = toE164PhMobile(phoneNumber);
  if (!e164) return { merged: false, reason: "not a valid PH mobile" };

  if (incomingUid === canonicalUid) return { merged: false, reason: "already the same account" };

  // (3) The incoming uid must own nothing. A row here means this account has a
  // history of its own, and moving that history is a data migration decision,
  // not something a login endpoint should take.
  const { rows: own } = await dbQuery.query(
    `SELECT 1 FROM ${s}.user_credentials WHERE uid = $1 LIMIT 1`,
    [incomingUid]
  );
  if (own.length > 0) return { merged: false, reason: "incoming account already has data" };

  // (4) and (5). Exactly one claimant, and it must be usable. Two claimants
  // means ambiguous ownership, which is quarantined for review rather than
  // resolved by picking one.
  // The COLUMN is `is_archive`. The response-shape name is `isArchived`, and
  // `src/utils/fieldParity.ts:79` records both spellings as aliases of one
  // concept — which is exactly how `is_archived` ended up in this query.
  // It is not a column, so this threw 42703 and took the whole merge with it:
  // the guard detected the collision, the merge died before condition (4), and
  // the caller got a 500 instead of either a merge or the 409 below. The alias
  // is kept so the row shape reaching `claimants[0].is_archived` is unchanged.
  const { rows: claimants } = await dbQuery.query(
    `SELECT uid, COALESCE(is_archive, FALSE) AS is_archived
       FROM ${s}.user_credentials
      WHERE uid <> $1
        AND (
          phone_normalized = $2
          OR (phone_normalized IS NULL
              AND phone_number IS NOT NULL
              AND right(regexp_replace(phone_number, '[^0-9]', '', 'g'), 10) = $3)
        )`,
    [incomingUid, e164, e164.slice(-10)]
  );
  if (claimants.length !== 1) {
    return { merged: false, reason: `${claimants.length} accounts claim this number` };
  }
  if (claimants[0].uid !== canonicalUid) {
    return { merged: false, reason: "claimant disagrees with the resolved account" };
  }
  if (claimants[0].is_archived) return { merged: false, reason: "account is archived" };

  /**
   * Order matters and is not interchangeable.
   *
   * Firebase refuses to attach a phone number that another user already holds,
   * so the orphan must go first. If the delete succeeds and the attach then
   * fails, the person can still sign in by email and simply cannot link yet —
   * recoverable. Doing it the other way round cannot even be attempted.
   */
  await auth().deleteUser(incomingUid);
  await auth().updateUser(canonicalUid, { phoneNumber: e164 });

  // Record the number on the canonical row. COALESCE so a phone already stored
  // there is not overwritten by a differently-formatted spelling of itself.
  await dbQuery.query(
    `UPDATE ${s}.user_credentials
        SET phone_number     = COALESCE(phone_number, $2),
            phone_normalized = COALESCE(phone_normalized, $2)
      WHERE uid = $1`,
    [canonicalUid, e164]
  );

  const customToken = await auth().createCustomToken(canonicalUid);
  return { merged: true, canonicalUid, customToken };
}
