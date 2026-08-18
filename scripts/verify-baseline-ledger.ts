/**
 * Is it SAFE to mark each migration as already applied?
 *
 * ## The question this answers
 *
 * Production has no `servana.schema_migrations` ledger — it has never existed,
 * because `deploy.yml` never invokes the runner and migrations were applied by
 * hand. So `npm run migrations:apply` there would find all 36 pending and die on
 * 001.
 *
 * The fix is to mark production at its true baseline version. But "mark
 * everything applied" carries a specific, silent hazard: if any migration was
 * NEVER actually applied to production, recording it as applied skips it
 * permanently. The runner only ever runs what is absent from the ledger, so a
 * wrongly-marked migration is not retried — it is forgotten, and the column or
 * constraint it was supposed to add never arrives.
 *
 * ## How it is answered without touching production
 *
 * `scripts/baseline/000-baseline.sql` IS production's schema, captured. So each
 * migration's effects can be looked for in it:
 *
 *   present  — the objects and columns it adds are all in the baseline, so
 *              production already has what this migration does. Safe to mark.
 *   ABSENT   — something it adds is missing. Production never received it, or
 *              received only part of it. Marking it applied would lose it.
 *
 * This is evidence rather than assumption, and it needs no database.
 *
 * ## What it cannot tell you
 *
 * A migration whose entire effect is DML — backfilling rows, correcting data —
 * leaves no schema fingerprint, so its effects cannot be confirmed this way. It
 * is reported as `no-schema-effect` rather than quietly counted as safe.
 *
 * Run: npm run migrations:baseline:plan
 */

import { migrationInputs, baselineInput } from './lib/schemaBaseline';
import { replay, splitStatements, type SchemaCatalog } from './lib/schemaModel';

import { declaresDestructive } from './lib/migrationSafety';
type Verdict = 'present' | 'ABSENT' | 'no-schema-effect';

interface MigrationCheck {
  file: string;
  verdict: Verdict;
  /** What the migration adds, as `table.column` or `table`. */
  expects: string[];
  /** The subset the baseline does not have. */
  missing: string[];
}

/** Objects a migration creates or alters, read from its own statements. */
const effectsOf = (sql: string): string[] => {
  const effects = new Set<string>();
  for (const statement of splitStatements(sql)) {
    const code = statement.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();

    const created = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:servana\.)?"?(\w+)"?/i.exec(code);
    if (created) { effects.add(created[1].toLowerCase()); continue; }

    const altered = /^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:servana\.)?"?(\w+)"?([\s\S]*)$/i.exec(code);
    if (altered) {
      const table = altered[1].toLowerCase();
      for (const add of altered[2].matchAll(/ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?/gi)) {
        effects.add(`${table}.${add[1].toLowerCase()}`);
      }
      // A rename is an effect too, and the NEW name is what should be present.
      const renamed = /RENAME\s+TO\s+"?(\w+)"?/i.exec(altered[2]);
      if (renamed) effects.add(renamed[1].toLowerCase());
      continue;
    }
  }
  return [...effects].sort();
};

/**
 * Renames performed by LATER migrations, as `oldName -> newName`.
 *
 * Without this the check cries wolf on migration 020: it creates
 * `catalog_services`, migration 024 renames that to `services`, and the
 * baseline — a `pg_dump` of the current state — carries no rename history. So
 * 020's effect looks absent when production has had it all along.
 *
 * A checker that reports a deployed migration as missing is worse than no
 * checker, because the one real answer in the list stops being believed.
 */
const renameChain = (): Map<string, string> => {
  const renames = new Map<string, string>();
  for (const { sql } of migrationInputs()) {
    for (const statement of splitStatements(sql)) {
      const code = statement.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
      const m = /^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:servana\.)?"?(\w+)"?\s+RENAME\s+TO\s+"?(\w+)"?/i
        .exec(code);
      if (m) renames.set(m[1].toLowerCase(), m[2].toLowerCase());
    }
  }
  return renames;
};

/** Follow the rename chain to whatever the object is called today. */
const currentName = (renames: Map<string, string>, name: string): string => {
  let out = name;
  const seen = new Set<string>();
  while (renames.has(out) && !seen.has(out)) {
    seen.add(out);
    out = renames.get(out)!;
  }
  return out;
};

const has = (catalog: SchemaCatalog, renames: Map<string, string>, effect: string): boolean => {
  const [table, column] = effect.split('.');
  const found =
    catalog.tables.get(table) ?? catalog.tables.get(currentName(renames, table));
  if (!found) return false;
  return column ? found.columns.has(column) : true;
};

export const checkAll = (): MigrationCheck[] => {
  const baseline = baselineInput();
  if (!baseline) throw new Error('No baseline captured — nothing to check against.');
  const catalog = replay([baseline]);
  const renames = renameChain();

  return migrationInputs().map(({ file, sql }) => {
    const expects = effectsOf(sql);

    /**
     * A REMOVAL migration is invisible to a presence check, and treating it as
     * "no schema effect" marks it applied — so it never runs.
     *
     * `effectsOf` lists the objects a migration should CREATE, then asks whether
     * the baseline has them. A migration that only DROPS creates nothing, so the
     * list is empty and the old code concluded "no DDL, must have run". For 037
     * that is exactly backwards: the baseline carries all 39 stale
     * `notification_key` constraints it exists to remove, so a fresh database
     * would keep them AND skip the migration, permanently, with this gate
     * reporting PASS.
     *
     * That is the same defect the comment in `ledgerAtBaselineSql` describes for
     * 030-035, arriving from the other direction: there, present-but-unapplied;
     * here, absent-effect-mistaken-for-no-effect.
     *
     * Proving a removal needs the opposite question — is the dropped object GONE
     * — which this checker cannot ask, because `effectsOf` only parses creations.
     * So a declared-destructive migration is never auto-marked. It reports
     * ABSENT, which is the honest answer: its effect is not in the baseline.
     */
    if (declaresDestructive(sql)) {
      return { file, verdict: 'ABSENT' as Verdict, expects, missing: ['(removal — not provable from the baseline)'] };
    }

    if (!expects.length) {
      return { file, verdict: 'no-schema-effect' as Verdict, expects, missing: [] };
    }
    const missing = expects.filter((e) => !has(catalog, renames, e));
    return {
      file,
      verdict: (missing.length ? 'ABSENT' : 'present') as Verdict,
      expects,
      missing,
    };
  });
};

if (require.main === module) {
  const checks = checkAll();
  const byVerdict = (v: Verdict) => checks.filter((c) => c.verdict === v);

  console.log('Is production already at the state each migration produces?\n');
  console.log('Checked against scripts/baseline/000-baseline.sql — production\'s own schema.');
  console.log('No database was contacted.\n');

  for (const check of checks) {
    const mark =
      check.verdict === 'present' ? 'present ' :
      check.verdict === 'ABSENT' ? 'ABSENT  ' : 'no-ddl  ';
    console.log(`  ${mark} ${check.file}`);
    if (check.missing.length) {
      console.log(`             missing: ${check.missing.join(', ')}`);
    }
  }

  const absent = byVerdict('ABSENT');
  const noDdl = byVerdict('no-schema-effect');

  console.log(`\n  present          ${byVerdict('present').length}`);
  console.log(`  ABSENT           ${absent.length}`);
  console.log(`  no schema effect ${noDdl.length}`);

  if (absent.length) {
    console.log('\n  DO NOT mark these as applied — production does not have their effects:');
    for (const c of absent) console.log(`    ${c.file}`);
    console.log('\n  Marking them would skip them permanently: the runner only applies what is');
    console.log('  absent from the ledger, so a wrongly-marked migration is never retried.');
  } else {
    console.log('\n  Every migration with a schema effect is already reflected in production.');
  }

  if (noDdl.length) {
    console.log('\n  These change data rather than schema, so the baseline cannot confirm them.');
    console.log('  They need a human judgement, not a green tick:');
    for (const c of noDdl) console.log(`    ${c.file}`);
  }

  process.exitCode = absent.length ? 1 : 0;
}
