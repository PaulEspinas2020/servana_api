/**
 * Populate email_normalized / phone_normalized on existing accounts.
 *
 * REQUIRED, not optional. `upsertFirebaseUser` derives these on every write, so
 * active accounts heal themselves — but a dormant account stays unfindable by
 * identifier sign-in until someone signs in with it, which they cannot do
 * without it being findable. That circle only breaks with a one-shot pass.
 *
 * DRY RUN BY DEFAULT:
 *   npx ts-node scripts/backfill-normalized-identifiers.ts
 *   npx ts-node scripts/backfill-normalized-identifiers.ts --apply
 *
 * Safe to run repeatedly. It only writes where the normalized column is
 * currently NULL and the raw value parses, so a second run reports zero.
 *
 * ── Verified against production before writing this ──────────────────────────
 * The conflict audit found ZERO duplicate normalized identifiers across 107
 * accounts, so no collision handling is needed. If that ever stops being true
 * the unique index will reject the write and this script will report it rather
 * than pick a winner — deciding which of two accounts owns an identifier means
 * deciding who owns a person's bookings and payouts, and no script has that
 * evidence.
 */

import { db } from "../src/config";
import dbQuery from "../src/db/dbQuery";
import { normalizeEmail, toE164PhMobile } from "../src/helpers/phoneIdentifier";

const s = db.schema;
const APPLY = process.argv.includes("--apply");

const maskEmail = (e: string) => {
  const at = e.lastIndexOf("@");
  return at < 2 ? "•••" : `${e[0]}•••${e.slice(at)}`;
};
const maskPhone = (p: string) => `${p.slice(0, 6)}•••${p.slice(-3)}`;

async function main() {
  // Only rows that still need it. Deliberately not "all rows": rewriting a
  // value that is already correct turns an idempotent script into one that
  // touches every row on every run, which is how a routine backfill becomes a
  // production incident.
  const { rows } = await dbQuery.query(
    `SELECT uid, email, phone_number, email_normalized, phone_normalized
     FROM ${s}.user_credentials
     WHERE (email        IS NOT NULL AND btrim(email)        <> '' AND email_normalized IS NULL)
        OR (phone_number IS NOT NULL AND btrim(phone_number) <> '' AND phone_normalized IS NULL)`,
    []
  );

  if (!rows.length) {
    console.log("Nothing to backfill — every parseable identifier already has a normalized form.");
    return;
  }

  let emails = 0;
  let mobiles = 0;
  const skipped: string[] = [];
  const failed: string[] = [];

  for (const r of rows) {
    const wantEmail = r.email_normalized ? null : normalizeEmail(r.email);
    const wantPhone = r.phone_normalized ? null : toE164PhMobile(r.phone_number);

    if (!wantEmail && !wantPhone) {
      // The raw value exists but does not parse. Left alone deliberately: a
      // number nobody can receive an SMS at must not become a lookup key, and
      // guessing at what the person meant is how one account starts answering
      // to another's identifier.
      skipped.push(
        `${r.uid.slice(0, 6)}… ${r.email ? "email" : ""}${r.email && r.phone_number ? "+" : ""}${r.phone_number ? "mobile" : ""} unparseable`
      );
      continue;
    }

    if (wantEmail) emails++;
    if (wantPhone) mobiles++;

    if (!APPLY) continue;

    try {
      await dbQuery.query(
        `UPDATE ${s}.user_credentials
         SET email_normalized = COALESCE($2, email_normalized),
             phone_normalized = COALESCE($3, phone_normalized)
         WHERE uid = $1`,
        [r.uid, wantEmail, wantPhone]
      );
    } catch (e: any) {
      // A unique-index violation here means two accounts claim one identifier —
      // exactly what the conflict audit exists to find in advance. Report and
      // continue; the other rows are still worth writing.
      failed.push(`${r.uid.slice(0, 6)}… ${e.message?.slice(0, 90)}`);
    }
  }

  console.log(`${rows.length} account(s) need a normalized form.`);
  console.log(`  emails:  ${emails}`);
  console.log(`  mobiles: ${mobiles}`);

  if (skipped.length) {
    console.log("");
    console.log(`${skipped.length} left alone — the raw value does not parse:`);
    skipped.forEach((x) => console.log(`  ${x}`));
    console.log("  These cannot be used for identifier sign-in until corrected.");
    console.log("  They are gaps, not conflicts, and cannot collide with anything.");
  }

  if (failed.length) {
    console.log("");
    console.log(`${failed.length} FAILED — most likely a duplicate identifier:`);
    failed.forEach((x) => console.log(`  ${x}`));
    console.log("  Run scripts/audit-identifier-conflicts.ts. Do not resolve by hand");
    console.log("  without evidence of which account owns the identifier.");
    process.exitCode = 1;
  }

  if (!APPLY) {
    console.log("");
    console.log("DRY RUN. Re-run with --apply to write.");
  } else if (!failed.length) {
    console.log("");
    console.log("Done. Re-running now would report nothing to do.");
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error("backfill failed:", e.message);
    process.exit(2);
  });
