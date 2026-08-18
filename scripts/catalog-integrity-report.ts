/**
 * Hierarchy integrity report for Catalog V2.
 *
 *   npm run catalog:integrity           human-readable
 *   npm run catalog:integrity -- --json machine-readable
 *
 * Exits non-zero when any ERROR-severity finding exists, so it can gate a
 * deploy. Warnings do not fail: an active Service under a deactivated Category
 * is worth knowing about and is not a reason to refuse a release.
 *
 * READ-ONLY. Four SELECTs and nothing else — this is a report, and a checker
 * that repairs what it finds is a checker whose findings nobody can trust.
 *
 * The rules live in `src/services/catalogIntegrityService.ts` as pure functions
 * over rows, and are unit-tested against fixtures containing each defect. This
 * script is only the part that needs a database.
 */

import { fetchSnapshot, buildReport, type Finding } from '../src/services/catalogIntegrityService';
import { pool } from '../src/db/dbQuery';
import { db } from '../src/config';

const SEVERITY_ORDER: Record<Finding['severity'], number> = { error: 0, warning: 1 };

async function main() {
  const json = process.argv.includes('--json');
  const checkedAt = new Date().toISOString();

  const snapshot = await fetchSnapshot();
  const report = buildReport(snapshot, checkedAt);

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const { categories, subcategories, services } = report.counts;
    console.log(`Catalog integrity — ${db.host ?? 'unknown host'}/${db.database ?? '?'} @ ${checkedAt}`);
    console.log(`  categories ${categories} · subcategories ${subcategories} · services ${services}`);
    console.log('');

    if (!report.findings.length) {
      console.log('  No findings. Hierarchy is internally consistent.');
    } else {
      const sorted = [...report.findings].sort(
        (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.code.localeCompare(b.code),
      );
      for (const f of sorted) {
        console.log(`  [${f.severity.toUpperCase()}] ${f.code}  ${f.ref}`);
        console.log(`          ${f.detail}`);
      }
      console.log('');
      console.log(`  ${report.errors} error(s), ${report.warnings} warning(s)`);
    }
  }

  if (report.errors > 0) process.exitCode = 1;
}

/**
 * Exit deterministically, even when the pool never connected.
 *
 * `pool.end()` on a pool whose connections all failed does not settle, and pg
 * keeps a handle open, so the process hung rather than exiting — measured at 60
 * seconds and killed. A report that never returns cannot gate a deploy: CI
 * would sit there until the job timed out and report a red build with no
 * finding to show for it.
 *
 * So: end the pool if it can be ended, give it a bounded moment, then exit with
 * the code that was already decided. The exit code is the contract here, and it
 * is set before this runs.
 */
async function shutdown(code: number): Promise<never> {
  await Promise.race([
    pool.end().catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  process.exit(code);
}

main()
  .then(() => shutdown(process.exitCode === 1 ? 1 : 0))
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    // The local .env carries empty credentials by design; production is reached
    // over SSH with peer auth. Say which failure this is rather than printing a
    // SASL error and leaving the reader to guess.
    if (/client password must be a string|SASL/i.test(message)) {
      console.error(
        'Cannot reach the database. This script needs real DB_* credentials — the local .env ' +
          'ships empty ones. On the server: ssh root@<host> and run it from the deploy directory.',
      );
    } else {
      console.error(message);
    }
    return shutdown(1);
  });
