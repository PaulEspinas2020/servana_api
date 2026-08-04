/**
 * Records verifications that already happened but were never written down.
 *
 * Masterlist S-06. `is_mobile_verified` had no writer at all, so every provider
 * who signed in by OTP proved their number to Firebase and had it recorded
 * nowhere. `firebaseFunctions.service.ts` now writes it on sign-in — but that
 * only helps at the NEXT sign-in, and until then the account-state endpoint
 * holds them at IDENTIFIER_VERIFICATION_REQUIRED, which the worker app renders
 * as a verification screen they cannot clear.
 *
 * Firebase already holds the proof for these accounts. This reads it back and
 * writes down what was true all along. It invents nothing: an account whose
 * Firebase record has no phone credential and no verified email is left exactly
 * as it is.
 *
 *   npm run backfill:verified-identifiers              # dry run, writes nothing
 *   npm run backfill:verified-identifiers -- --apply   # writes
 *
 * Dry run is the default deliberately. This touches identity columns that gate
 * account recovery, and the shape of the mistake — a script that ran when
 * somebody meant to preview it — is not one worth risking for the sake of four
 * fewer characters.
 */
import { getAuth as getAuthAdmin } from "firebase-admin/auth";
import { firebaseAdmin } from "../src/middleware/firebaseApp";
import dbQuery from "../src/db/dbQuery";
import { db } from "../src/config";
import {
  provenFrom,
  recordProvenIdentifiers,
} from "../src/services/identityVerificationSync";

const schema = db.schema;
const apply = process.argv.includes("--apply");
const auth = () => getAuthAdmin(firebaseAdmin);

type Outcome = {
  uid: string;
  role: string;
  before: { email: boolean; mobile: boolean };
  proven: { email: boolean; mobile: boolean };
  action: "would-set" | "set" | "nothing-to-add" | "no-firebase-record" | "error";
  detail?: string;
};

async function main() {
  const { rows } = await dbQuery.query(
    `SELECT uid, role,
            COALESCE(is_email_verified,  false) AS email_verified,
            COALESCE(is_mobile_verified, false) AS mobile_verified
       FROM ${schema}.user_credentials
      ORDER BY role, uid`
  );

  console.log(
    `${apply ? "APPLYING" : "DRY RUN"} — ${rows.length} accounts to examine\n`
  );

  const outcomes: Outcome[] = [];

  for (const r of rows) {
    const before = { email: r.email_verified === true, mobile: r.mobile_verified === true };
    let fbUser: any;
    try {
      fbUser = await auth().getUser(r.uid);
    } catch (err: any) {
      // A DB row whose uid no longer exists in Firebase is a real condition —
      // deleted auth users, or rows created by an import. Not an error to fix
      // here, but it must be counted rather than swallowed.
      outcomes.push({
        uid: r.uid,
        role: String(r.role),
        before,
        proven: { email: false, mobile: false },
        action: err?.code === "auth/user-not-found" ? "no-firebase-record" : "error",
        detail: err?.code ?? String(err?.message ?? err),
      });
      continue;
    }

    // The decoded-token argument is absent here: there is no sign-in happening,
    // so the only evidence is what the Firebase user record itself carries.
    const proven = provenFrom(undefined, fbUser);
    const adds =
      (proven.emailVerified && !before.email) ||
      (proven.mobileVerified && !before.mobile);

    if (!adds) {
      outcomes.push({
        uid: r.uid,
        role: String(r.role),
        before,
        proven: { email: proven.emailVerified, mobile: proven.mobileVerified },
        action: "nothing-to-add",
      });
      continue;
    }

    if (apply) {
      await recordProvenIdentifiers(r.uid, proven);
    }
    outcomes.push({
      uid: r.uid,
      role: String(r.role),
      before,
      proven: { email: proven.emailVerified, mobile: proven.mobileVerified },
      action: apply ? "set" : "would-set",
    });
  }

  const count = (a: Outcome["action"]) => outcomes.filter((o) => o.action === a).length;
  const changed = outcomes.filter(
    (o) => o.action === "set" || o.action === "would-set"
  );

  console.log(`Accounts examined:        ${outcomes.length}`);
  console.log(`${apply ? "Updated" : "Would update"}:${apply ? "                  " : "             "}${changed.length}`);
  console.log(`  gaining email verified: ${changed.filter((o) => o.proven.email && !o.before.email).length}`);
  console.log(`  gaining mobile verified:${changed.filter((o) => o.proven.mobile && !o.before.mobile).length}`);
  console.log(`Already correct:          ${count("nothing-to-add")}`);
  console.log(`No Firebase record:       ${count("no-firebase-record")}`);
  console.log(`Errors:                   ${count("error")}`);

  const byRole = new Map<string, number>();
  for (const o of changed) byRole.set(o.role, (byRole.get(o.role) ?? 0) + 1);
  if (byRole.size) {
    console.log("\nBy role:");
    for (const [role, n] of [...byRole].sort()) {
      console.log(`  role ${role}: ${n}`);
    }
  }

  const errors = outcomes.filter((o) => o.action === "error");
  if (errors.length) {
    console.log("\nErrors:");
    for (const e of errors.slice(0, 20)) {
      console.log(`  ${e.uid.slice(0, 8)}…  ${e.detail}`);
    }
  }

  if (!apply && changed.length) {
    console.log("\nNothing was written. Re-run with --apply to record these.");
  }
  console.log();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
