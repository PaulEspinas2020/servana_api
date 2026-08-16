/**
 * The fresh-database gate (§158, §159, §161).
 *
 * Run: npm run db:verify                  — static replay. No engine needed.
 *      npm run db:verify -- --live=URL    — also applies the chain to a real,
 *                                            EMPTY, non-production database.
 *
 * ## Why the default is static
 *
 * The release gate is "a fresh database can reach current schema
 * automatically". Answering it properly means creating a database and running
 * the migrations, and no PostgreSQL engine is reachable here — no `psql`, no
 * `pg_dump`, no Docker. The only database this repository has credentials for
 * is production.
 *
 * So the default mode replays the chain against a modelled catalog
 * (`lib/schemaModel.ts`) and reports exactly what a real run would hit. It is
 * strictly weaker than executing, and it catches the defect this command exists
 * to find — a migration that references a table nothing creates — which is
 * currently true of eleven tables.
 *
 * `--live` is the same gate with the engine attached, for CI. It refuses a
 * non-empty schema and refuses production, so it cannot be pointed at anything
 * that matters.
 *
 * ## Exit codes
 *
 * 0 — a fresh database reaches the current schema, and every semantic rule holds.
 * 1 — it does not. The output names what is missing.
 *
 * A non-zero exit here is the honest state of the repository today. It is meant
 * to go green when a baseline is captured, not to be silenced.
 */

import {
  baselineGap,
  checkCanonicalSemantics,
  migrationInputs,
  baselineInput,
  replayWithBaseline,
  requirements,
  verifyBaseline,
} from './lib/schemaBaseline';
import { residualTransactionControl } from './lib/migrationSafety';

const args = process.argv.slice(2);
const liveArg = args.find((a) => a.startsWith('--live='))?.slice('--live='.length) ?? '';

// ─── Static gate ──────────────────────────────────────────────────────────────

const runStatic = (): boolean => {
  const gap = baselineGap();
  const catalog = replayWithBaseline();
  const semantics = checkCanonicalSemantics(catalog);
  const failing = semantics.filter((f) => !f.ok);
  const unparsed = catalog.problems.filter((p) => p.kind === 'unparsed');

  console.log('Servana fresh-database gate — STATIC replay (no engine required)\n');
  console.log(`  baseline captured        ${gap.baselineCaptured ? 'yes' : 'NO'}`);
  console.log(`  migrations replayed      ${migrationInputs().length}`);
  console.log(`  statements parsed        ${catalog.statementsSeen} (${unparsed.length} unparsed)`);
  console.log(`  tables reached           ${catalog.tables.size}`);
  console.log(`  bootstraps from zero     ${gap.bootstrapsFromZero ? 'YES' : 'NO'}\n`);

  if (!gap.bootstrapsFromZero) {
    console.log(`  A fresh database CANNOT reach the current schema. ${gap.missingTables.length} table(s)`);
    console.log('  are altered by a migration and created by none:\n');
    for (const requirement of requirements()) {
      console.log(
        `    ${requirement.table.padEnd(22)} needed by ${requirement.alteredBy.join(', ') || 'a rename chain'}`,
      );
      if (requirement.provenColumns.length) {
        console.log(`      proven columns: ${requirement.provenColumns.join(', ')}`);
      }
    }
    console.log('\n  Capture a baseline: npm run baseline:plan\n');
  }

  console.log('  Canonical semantics (§155-§157):');
  for (const finding of semantics) {
    console.log(`    ${finding.ok ? 'pass' : 'FAIL'}  ${finding.rule.padEnd(34)} ${finding.detail}`);
  }

  // Transaction safety, shared with the TAB 14 guard: a migration whose own
  // COMMIT survives stripping would break the wrapper's atomicity on the very
  // first fresh-database run.
  const leaking = migrationInputs().filter((m) => residualTransactionControl(m.sql).length > 0);
  console.log(`\n  Migrations leaking transaction control: ${leaking.length}`);
  for (const migration of leaking) console.log(`    ${migration.file}`);

  if (unparsed.length) {
    console.log(`\n  Statements the model could not read (${unparsed.length}) — the gate is only`);
    console.log('  as strong as this number is small:');
    for (const problem of unparsed.slice(0, 10)) {
      console.log(`    ${problem.file}: ${problem.statement}`);
    }
  }

  const verdict = verifyBaseline();
  if (verdict.captured) {
    console.log(`\n  Baseline sanitisation problems: ${verdict.sanitisationProblems.length}`);
    for (const problem of verdict.sanitisationProblems) console.log(`    ${problem}`);
    console.log(`  Unmet requirements: ${verdict.unmetRequirements.length}`);
    for (const unmet of verdict.unmetRequirements.slice(0, 20)) console.log(`    ${unmet}`);
  }

  const ok =
    gap.bootstrapsFromZero &&
    failing.length === 0 &&
    leaking.length === 0 &&
    verdict.sanitisationProblems.length === 0 &&
    verdict.unmetRequirements.length === 0;

  console.log(`\n  RESULT: ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok && !gap.baselineCaptured) {
    console.log('  Expected while no baseline exists. This is the gap TAB 15 documents.');
  }
  return ok;
};

// ─── Live gate ────────────────────────────────────────────────────────────────

/** Refuses production and refuses a non-empty schema. Pure, so it is testable. */
export const checkLiveTarget = (
  target: string,
  env: NodeJS.ProcessEnv,
  production: { host?: string; database?: string },
): { allowed: boolean; reason: string } => {
  let url: URL;
  try { url = new URL(target); } catch { return { allowed: false, reason: 'not a URL' }; }
  const host = url.hostname.toLowerCase();
  if (String(production.host ?? '').toLowerCase() === host) {
    return { allowed: false, reason: `Refused: ${host} is the configured production host.` };
  }
  const local = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i.test(host);
  if (local) return { allowed: true, reason: 'local' };
  const ack = `${host}${url.port ? `:${url.port}` : ''}`;
  if (env.FRESH_DB_ACK !== ack) {
    return { allowed: false, reason: `Refused: set FRESH_DB_ACK exactly to "${ack}" for a non-local target.` };
  }
  return { allowed: true, reason: 'acknowledged non-production host' };
};

const runLive = async (target: string): Promise<boolean> => {
  const { db } = await import('../src/config');
  const check = checkLiveTarget(target, process.env, {
    host: db.host as string, database: db.database as string,
  });
  if (!check.allowed) throw new Error(check.reason);

  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: target });
  const client = await pool.connect();
  try {
    const existing = await client.query(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'servana'`,
    );
    if (Number(existing.rows[0]?.n ?? 0) > 0) {
      throw new Error(
        `Refused: the servana schema already has ${existing.rows[0].n} table(s). ` +
          'The fresh-database gate only runs against an EMPTY schema.',
      );
    }

    const baseline = baselineInput();
    const chain = baseline ? [baseline, ...migrationInputs()] : migrationInputs();
    console.log(`Applying ${chain.length} file(s) to ${new URL(target).hostname}…`);

    for (const file of chain) {
      await client.query('BEGIN');
      try {
        const { stripTransactionControl } = await import('./lib/migrationSafety');
        await client.query(stripTransactionControl(file.sql));
        await client.query('COMMIT');
        console.log(`  applied ${file.file}`);
      } catch (error) {
        await client.query('ROLLBACK');
        console.error(`  FAILED  ${file.file}: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    }

    // §159: replay a second time. Every migration is IF NOT EXISTS or guarded,
    // so a re-run must be a no-op rather than an error.
    console.log('\nReplaying the chain a second time (idempotence)…');
    for (const file of chain) {
      try {
        const { stripTransactionControl } = await import('./lib/migrationSafety');
        await client.query('BEGIN');
        await client.query(stripTransactionControl(file.sql));
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        console.error(`  NOT IDEMPOTENT: ${file.file} — ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    }
    console.log('  the chain is replayable.');
    return true;
  } finally {
    client.release();
    await pool.end();
  }
};

if (require.main === module) {
  const staticOk = runStatic();
  if (!liveArg) {
    process.exitCode = staticOk ? 0 : 1;
  } else {
    runLive(liveArg)
      .then((liveOk) => { process.exitCode = staticOk && liveOk ? 0 : 1; })
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  }
}
