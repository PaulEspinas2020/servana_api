/**
 * Find accounts that already share a normalized identifier (Command 5 §16).
 *
 * MUST RUN BEFORE the unique indexes on email_normalized / phone_normalized go
 * live. A unique index over existing data fails if duplicates are present, and
 * that failure is the correct behaviour — it means two accounts already claim
 * one identifier, which §16 says to quarantine for manual review rather than
 * resolve by guessing.
 *
 * This is READ ONLY. It never merges, deletes or reassigns anything. Picking a
 * winner between two accounts that both claim an email address is a decision
 * about who owns a person's work history, and no script has the evidence to
 * make it.
 *
 *   npx ts-node scripts/audit-identifier-conflicts.ts
 *   npx ts-node scripts/audit-identifier-conflicts.ts --json > conflicts.json
 *
 * OUTPUT IS REDACTED. §16 requires the conflict report to carry no personal
 * data, so identifiers are masked and uids truncated. The point is to size the
 * problem and locate the rows, not to publish a list of people's email
 * addresses into a file that ends up in a ticket.
 */

import { db } from "../src/config";
import dbQuery from "../src/db/dbQuery";
import { toE164PhMobile, normalizeEmail } from "../src/helpers/phoneIdentifier";

const s = db.schema;
const JSON_OUT = process.argv.includes("--json");

/** `juan@gmail.com` → `j••n@gmail.com`. Enough to recognise, not to reuse. */
const maskEmail = (e: string): string => {
  const at = e.lastIndexOf("@");
  if (at < 1) return "•••";
  const local = e.slice(0, at);
  const domain = e.slice(at);
  if (local.length <= 2) return `${local[0]}•${domain}`;
  return `${local[0]}${"•".repeat(Math.min(local.length - 2, 4))}${local.slice(-1)}${domain}`;
};

/** `+639171234567` → `0917 •••• 567`. */
const maskPhone = (p: string): string => {
  const n = toE164PhMobile(p);
  if (!n) return "•••";
  const d = n.slice(3);
  return `0${d.slice(0, 3)} •••• ${d.slice(7)}`;
};

const shortUid = (u: string) => `${u.slice(0, 6)}…${u.slice(-4)}`;

type Conflict = {
  kind: "email" | "mobile";
  masked: string;
  accounts: { uid: string; role: number | null; status: string | null; created: string }[];
};

async function main() {
  const conflicts: Conflict[] = [];
  const unparseable = { email: 0, phone: 0 };

  // Normalize in TypeScript rather than SQL: the rules live in
  // helpers/phoneIdentifier, and reimplementing them in SQL would give the
  // audit a different definition of "duplicate" than the constraint it is
  // meant to predict — which is the one thing this script must not get wrong.
  const { rows } = await dbQuery.query(
    `SELECT uid, email, phone_number, role::int AS role, account_status, created_date
     FROM ${s}.user_credentials`,
    []
  );

  const byEmail = new Map<string, typeof rows>();
  const byPhone = new Map<string, typeof rows>();

  for (const r of rows) {
    const e = normalizeEmail(r.email);
    if (e) {
      byEmail.set(e, [...(byEmail.get(e) ?? []), r]);
    } else if (r.email) {
      unparseable.email++;
    }

    const p = toE164PhMobile(r.phone_number);
    if (p) {
      byPhone.set(p, [...(byPhone.get(p) ?? []), r]);
    } else if (r.phone_number) {
      unparseable.phone++;
    }
  }

  for (const [value, group] of byEmail) {
    if (group.length > 1) {
      conflicts.push({
        kind: "email",
        masked: maskEmail(value),
        accounts: group.map((g: any) => ({
          uid: shortUid(g.uid),
          role: g.role ?? null,
          status: g.account_status ?? null,
          created: g.created_date ? String(g.created_date).slice(0, 10) : "?",
        })),
      });
    }
  }
  for (const [value, group] of byPhone) {
    if (group.length > 1) {
      conflicts.push({
        kind: "mobile",
        masked: maskPhone(value),
        accounts: group.map((g: any) => ({
          uid: shortUid(g.uid),
          role: g.role ?? null,
          status: g.account_status ?? null,
          created: g.created_date ? String(g.created_date).slice(0, 10) : "?",
        })),
      });
    }
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ scanned: rows.length, unparseable, conflicts }, null, 2));
    return;
  }

  console.log(`Scanned ${rows.length} account(s).\n`);

  if (unparseable.email || unparseable.phone) {
    console.log(
      `${unparseable.email} email(s) and ${unparseable.phone} phone number(s) do not ` +
        `parse and therefore have NO normalized form.`
    );
    console.log(
      `Those rows cannot be found by identifier sign-in until corrected, and cannot ` +
        `collide with anything. They are not conflicts — they are gaps.\n`
    );
  }

  if (!conflicts.length) {
    console.log("No conflicts. The unique indexes can be created safely.");
    return;
  }

  console.log(`${conflicts.length} CONFLICT(S) — the unique indexes will FAIL until these are resolved.\n`);
  for (const c of conflicts) {
    console.log(`  ${c.kind.toUpperCase()}  ${c.masked}`);
    for (const a of c.accounts) {
      console.log(`     uid ${a.uid}  role ${a.role ?? "?"}  ${a.status ?? "?"}  created ${a.created}`);
    }
    console.log("");
  }

  console.log("Each of these is two accounts claiming one identifier.");
  console.log("Resolving it means deciding which one owns that person's history —");
  console.log("bookings, earnings and payouts follow the uid, not the email address.");
  console.log("That is a support decision with evidence, not a migration step.");

  // Non-zero exit so CI or a deploy step can gate on this rather than a human
  // remembering to read the output.
  process.exitCode = 1;
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error("conflict audit failed:", e.message);
    process.exit(2);
  });
