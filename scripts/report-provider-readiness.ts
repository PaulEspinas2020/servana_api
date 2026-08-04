/**
 * What is actually blocking every provider on the platform.
 *
 * Masterlist S-06. `account_status = 'pending'` is the column DEFAULT for every
 * account ever created — admins and customers carry it too — and
 * `requireActiveProvider` admits only `active`/`approved`. The result is that
 * the state machine correctly refuses very nearly every provider, and the
 * question "is `pending` the intended resting state?" cannot be answered from
 * the code. It needs numbers.
 *
 * This produces them. For every provider account it asks the SAME service the
 * app asks — `getProviderAccountState` — so the report is literally what each
 * provider's app would show them, not a second opinion that could disagree.
 *
 * ── Read-only, deliberately ────────────────────────────────────────────────
 * No UPDATE, no INSERT, no transition. The state read stopped persisting in
 * `bd6ba25` (`previewActivationEligibility` rather than `refresh…`), and this
 * script exists to inform a decision, not to take one. Running it against
 * production 70 times must leave production exactly as it found it.
 *
 *   npm run report:provider-readiness
 *   npm run report:provider-readiness -- --csv > readiness.csv
 */
import dbQuery from "../src/db/dbQuery";
import { db } from "../src/config";
import { getProviderAccountState } from "../src/services/providerAccountStateService";
import { PROVIDER_ROLES } from "../src/constants/providerRoles";

const schema = db.schema;
const asCsv = process.argv.includes("--csv");

type Row = {
  uid: string;
  role: string;
  accountStatus: string;
  nextStep: string;
  application: string;
  activation: string;
  completion: number;
  blockers: string[];
  bookings: number;
};

async function main() {
  const roles = [...PROVIDER_ROLES];
  const { rows: providers } = await dbQuery.query(
    `SELECT u.uid, u.role, u.account_status,
            (SELECT COUNT(*) FROM ${schema}.bookings b WHERE b.worker_uid = u.uid) AS bookings
       FROM ${schema}.user_credentials u
      WHERE u.role::text = ANY($1)
      ORDER BY bookings DESC, u.uid`,
    [roles]
  );

  const out: Row[] = [];
  for (const p of providers) {
    // Sequential on purpose: this is a report against production, and the
    // state call fans out to several queries each. Seventy of them in parallel
    // is a load spike for no benefit — nobody is waiting on this.
    const state = await getProviderAccountState(p.uid);
    out.push({
      uid: p.uid,
      role: String(p.role),
      accountStatus: String(p.account_status),
      nextStep: state.nextStep.code,
      application: state.application.status,
      activation: state.activation.status,
      completion: state.profile.completionPercent,
      blockers: state.checklist
        .filter((c: any) => c.blocking && !c.satisfied)
        .map((c: any) => c.code),
      bookings: Number(p.bookings),
    });
  }

  if (asCsv) {
    console.log("uid,role,account_status,next_step,application,activation,completion,bookings,blockers");
    for (const r of out) {
      console.log(
        [
          r.uid,
          r.role,
          r.accountStatus,
          r.nextStep,
          r.application,
          r.activation,
          r.completion,
          r.bookings,
          `"${r.blockers.join(" ")}"`,
        ].join(",")
      );
    }
    return;
  }

  const byStep = new Map<string, number>();
  const byBlocker = new Map<string, number>();
  for (const r of out) {
    byStep.set(r.nextStep, (byStep.get(r.nextStep) ?? 0) + 1);
    for (const b of r.blockers) byBlocker.set(b, (byBlocker.get(b) ?? 0) + 1);
  }

  const worked = out.filter((r) => r.bookings > 0);
  const operational = out.filter((r) => r.nextStep === "OPERATIONAL");

  console.log(`\nProviders: ${out.length}  (roles ${roles.join("/")})`);
  console.log(`Operational today: ${operational.length}`);
  console.log(`Have worked at least once: ${worked.length}`);

  // The number that decides the policy question. A provider who has completed
  // real bookings and is nonetheless blocked is not "awaiting approval" — they
  // are someone the platform already trusted, refused by a gate switched on
  // afterwards.
  const workedAndBlocked = worked.filter((r) => r.nextStep !== "OPERATIONAL");
  console.log(`Have worked AND are now blocked: ${workedAndBlocked.length}`);

  console.log("\nBlocked at:");
  for (const [step, n] of [...byStep].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${step}`);
  }

  console.log("\nBlocking checklist items:");
  if (byBlocker.size === 0) console.log("  (none reported)");
  for (const [code, n] of [...byBlocker].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${code}`);
  }

  console.log("\nProviders who have worked, and what now blocks them:");
  for (const r of worked) {
    console.log(
      `  ${r.uid.slice(0, 8)}…  bookings=${String(r.bookings).padStart(3)}  ` +
        `status=${r.accountStatus}  step=${r.nextStep}  ` +
        `blockers=${r.blockers.join(",") || "-"}`
    );
  }
  console.log();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
