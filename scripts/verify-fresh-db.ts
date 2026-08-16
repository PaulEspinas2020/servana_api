/**
 * The fresh-database gate (§158, §159, §161).
 *
 * Run: npm run db:verify                  — static replay. No dependencies.
 *      npm run db:verify -- --embedded    — EXECUTES the chain on PostgreSQL 18
 *                                            in-process (PGlite). No server.
 *      npm run db:verify -- --live=URL    — also applies the chain to a real,
 *                                            EMPTY, non-production database.
 *
 * ## Three modes, because they answer different questions
 *
 * The release gate is "a fresh database can reach current schema
 * automatically". Answering it properly means creating a database and running
 * the migrations.
 *
 * `--embedded` does exactly that, and is the authority. PGlite is PostgreSQL
 * compiled to WebAssembly, so the chain is parsed and planned by the real thing
 * without a server, a container or a credential.
 *
 * The default static mode replays against a modelled catalog
 * (`lib/schemaModel.ts`). It is strictly weaker and it is kept because it needs
 * no dependency at all — but it is no longer trusted on its own. It once
 * reported eleven missing tables and blamed migration 009; the engine proved
 * more tables and showed the chain dies on 001. `--embedded` now fails the build
 * if the model ever again reports less than the engine proves.
 *
 * `--live` is the same gate against a real server, for CI. It is not redundant
 * with `--embedded`: PGlite runs as a single bundled superuser, so ownership and
 * role separation — the defect that left 29 of 116 tables unusable in production
 * — are only checkable there. It refuses a non-empty schema and refuses
 * production, so it cannot be pointed at anything that matters.
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
    console.log('  are altered or read by a migration and created by none:\n');
    for (const requirement of requirements()) {
      const needed = requirement.alteredBy.length
        ? requirement.alteredBy.join(', ')
        : requirement.neededBy.join(', ') || 'a rename chain';
      console.log(`    ${requirement.table.padEnd(28)} needed by ${needed}`);
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

// ─── Embedded gate ────────────────────────────────────────────────────────────

/**
 * The same gate, executed by a real PostgreSQL running in-process.
 *
 * This is the mode that caught the static model under-reporting. It needs no
 * server, no container and no credentials, so unlike `--live` it can run
 * anywhere — including as part of `npm run verify`.
 *
 * Exits non-zero on two conditions: the chain not bootstrapping (expected while
 * no baseline exists), and the model failing to report something the engine
 * proved missing (never expected — that is the fail-open this mode exists to
 * catch).
 */
const runEmbedded = async (): Promise<boolean> => {
  const { runEmbeddedReplay, enumerateMissingRelations } = await import('./lib/embeddedEngine');
  const { replayMigrationsOnly } = await import('./lib/schemaBaseline');
  const { missingBaselineTables } = await import('./lib/schemaModel');

  const chain = migrationInputs();
  console.log('\nServana fresh-database gate — EMBEDDED PostgreSQL (PGlite, in-process)\n');

  const faithful = await runEmbeddedReplay(chain, { stopOnFirstFailure: true });
  console.log(`  runner-faithful replay   dies on ${faithful.firstFailure ?? 'nothing'}`);
  console.log(`  applied before that      ${faithful.applied}/${chain.length}`);

  const full = await runEmbeddedReplay(chain);
  console.log(`  continue-past-failure    ${full.applied}/${chain.length} applied`);

  const proven = await enumerateMissingRelations(chain);
  const catalog = replayMigrationsOnly();
  const createdSomewhere = new Set([...catalog.tables.values()].map((t) => t.name));
  const genuine = proven.relations.filter((r) => !createdSomewhere.has(r));
  console.log(`  engine-proven missing    ${genuine.length} (converged in ${proven.rounds} round(s))`);
  for (const relation of genuine) console.log(`    ${relation}`);

  // The anti-fail-open check. The model may legitimately report MORE than the
  // engine reaches, because the engine stops each file at its first error. It
  // must never report less.
  const modelled = new Set(missingBaselineTables(catalog));
  const unreported = genuine.filter((r) => !modelled.has(r));
  console.log(`\n  model agrees with engine ${unreported.length === 0 ? 'yes' : `NO — ${unreported.join(', ')}`}`);

  const bootstraps = faithful.applied === chain.length;
  const ok = bootstraps && unreported.length === 0;
  console.log(`\n  EMBEDDED RESULT: ${ok ? 'PASS' : 'FAIL'}`);
  if (!bootstraps) {
    console.log('  A fresh database cannot reach the current schema. This is the TAB 15 gap,');
    console.log('  now proven by execution rather than by a model.');
  }
  if (unreported.length) {
    console.log('  The static model is UNDER-REPORTING. Widen scripts/lib/schemaModel.ts.');
  }
  return ok;
};

if (require.main === module) {
  const staticOk = runStatic();
  if (args.includes('--embedded')) {
    runEmbedded()
      .then((embeddedOk) => {
        // Under-reporting is a defect in this repository and fails the gate.
        // Not bootstrapping is the documented gap and is already reported by
        // the static run, so the exit code is driven by the same condition.
        process.exitCode = staticOk && embeddedOk ? 0 : 1;
      })
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  } else if (!liveArg) {
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
