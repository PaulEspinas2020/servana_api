/**
 * Capture a sanitized, versioned baseline schema (§153).
 *
 * Run: npm run baseline:plan                  — print what it would do. Calls nothing.
 *      npm run baseline:capture -- --from=URL — capture, from a NON-PRODUCTION host.
 *
 * ## This has never been run, and it will not run against production
 *
 * Three independent refusals, because one is a thing somebody disables at 6pm
 * on a Friday:
 *
 *   1. the source host must be local, or `BASELINE_SOURCE_ACK` must equal the
 *      host exactly — the same shape `run-migrations.ts` and
 *      `production-smoke.ts` already use;
 *   2. it refuses outright if the source looks like the configured production
 *      database, comparing against `db.host`/`db.database` from `src/config`;
 *   3. it reads only `information_schema` and `pg_catalog`. There is no code
 *      path in this file that issues `SELECT` against an application table, so
 *      it cannot copy a row even by mistake.
 *
 * ## What it emits
 *
 * DDL only: tables, columns, defaults, not-null, primary keys, foreign keys,
 * unique constraints, check constraints, indexes, sequences and ownership,
 * normalised to the approved runtime role. No data, no roles, no grants to
 * named people, no comments carrying operational notes.
 *
 * Output passes through `sanitisationProblems()` before it is written, and the
 * process exits non-zero if anything forbidden survives — so a baseline that
 * captured an email address never reaches the working tree.
 *
 * ## Why capture rather than hand-write
 *
 * Eleven foundational tables predate this repository's migration chain and
 * their real shape is not in it. Inferring them would produce a plausible,
 * unverified baseline that CI would then treat as authoritative. See
 * `scripts/lib/schemaBaseline.ts`.
 */

import fs from 'fs';
import path from 'path';
import {
  APPROVED_OWNER_ROLES,
} from './lib/migrationSafety';
import {
  BASELINE_DIR,
  BASELINE_FILE,
  requirements,
  sanitisationProblems,
} from './lib/schemaBaseline';

const args = process.argv.slice(2);
const fromArg = args.find((a) => a.startsWith('--from='))?.slice('--from='.length) ?? '';
const planOnly = args.includes('--plan') || !fromArg;

export const SCHEMA = 'servana';

// ─── Refusals ─────────────────────────────────────────────────────────────────

export interface SourceCheck { allowed: boolean; reason: string }

/**
 * Decide whether a capture may proceed against this source.
 *
 * Exported and pure so `tests/schema-baseline.test.ts` can prove it refuses
 * production without anything having to connect anywhere.
 */
export const checkSource = (
  from: string,
  env: NodeJS.ProcessEnv,
  production: { host?: string; database?: string },
): SourceCheck => {
  let url: URL;
  try {
    url = new URL(from);
  } catch {
    return { allowed: false, reason: 'The --from value is not a URL.' };
  }

  const host = url.hostname.toLowerCase();
  const database = url.pathname.replace(/^\//, '').toLowerCase();

  const productionHost = String(production.host ?? '').toLowerCase();
  const productionDatabase = String(production.database ?? '').toLowerCase();

  if (productionHost && host === productionHost) {
    return {
      allowed: false,
      reason:
        `Refused: ${host} is the configured production host. This tool never captures from ` +
        'production. Restore a dump into a disposable instance and capture from that.',
    };
  }
  if (productionDatabase && database === productionDatabase && host !== 'localhost' && host !== '127.0.0.1') {
    return {
      allowed: false,
      reason: `Refused: database "${database}" on a remote host matches the configured production database.`,
    };
  }

  const local = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i.test(host);
  if (local) return { allowed: true, reason: 'local host' };

  const ack = `${host}${url.port ? `:${url.port}` : ''}`;
  if (env.BASELINE_SOURCE_ACK !== ack) {
    return {
      allowed: false,
      reason:
        `Refused: ${ack} is not local. Set BASELINE_SOURCE_ACK exactly to "${ack}" to confirm it ` +
        'is a disposable non-production instance.',
    };
  }
  return { allowed: true, reason: 'acknowledged non-production host' };
};

// ─── The catalog queries ──────────────────────────────────────────────────────

/**
 * Every query this tool issues. All read `information_schema` or `pg_catalog`.
 *
 * Declared as data, and asserted by the test suite, so "it cannot read an
 * application row" is checkable rather than a claim in a comment.
 */
export const CATALOG_QUERIES: ReadonlyArray<{ name: string; sql: string }> = Object.freeze([
  {
    name: 'tables',
    sql: `SELECT table_name FROM information_schema.tables
           WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name`,
  },
  {
    name: 'columns',
    sql: `SELECT table_name, column_name, data_type, character_maximum_length,
                 numeric_precision, numeric_scale, is_nullable, column_default, ordinal_position
            FROM information_schema.columns
           WHERE table_schema = $1 ORDER BY table_name, ordinal_position`,
  },
  {
    name: 'constraints',
    sql: `SELECT conrelid::regclass::text AS table_name, conname AS name,
                 pg_get_constraintdef(oid) AS definition, contype
            FROM pg_constraint
           WHERE connamespace = $1::regnamespace ORDER BY conrelid::regclass::text, conname`,
  },
  {
    name: 'indexes',
    sql: `SELECT tablename AS table_name, indexname AS name, indexdef AS definition
            FROM pg_indexes WHERE schemaname = $1 ORDER BY tablename, indexname`,
  },
  {
    name: 'sequences',
    sql: `SELECT sequencename AS name, start_value, increment_by, data_type
            FROM pg_sequences WHERE schemaname = $1 ORDER BY sequencename`,
  },
  {
    name: 'sequence_ownership',
    sql: `SELECT s.relname AS sequence_name, t.relname AS table_name, a.attname AS column_name
            FROM pg_class s
            JOIN pg_depend d ON d.objid = s.oid AND d.deptype = 'a'
            JOIN pg_class t ON t.oid = d.refobjid
            JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
           WHERE s.relkind = 'S' AND s.relnamespace = $1::regnamespace
           ORDER BY s.relname`,
  },
  {
    name: 'views',
    sql: `SELECT table_name, view_definition FROM information_schema.views
           WHERE table_schema = $1 ORDER BY table_name`,
  },
]);

/** No query may touch an application table. */
export const queriesAreCatalogOnly = (): boolean =>
  CATALOG_QUERIES.every(({ sql }) =>
    /\b(information_schema|pg_catalog|pg_constraint|pg_indexes|pg_sequences|pg_class|pg_depend|pg_attribute)\b/i.test(sql),
  );

// ─── Rendering ────────────────────────────────────────────────────────────────

export const BASELINE_HEADER = `-- ─── Servana baseline schema ────────────────────────────────────────────────
--
-- GENERATED by scripts/capture-schema-baseline.ts. Do not edit by hand.
--
-- WHAT THIS IS
--
-- The schema that predates this repository's migration chain. The chain alters
-- and reads eighteen foundational tables that no migration creates -- starting
-- with 001 -- so a fresh database cannot reach the current schema without this
-- file first.
--
-- WHAT IT CONTAINS
--
-- DDL only. No rows, no roles, no grants, no environment-specific owners: every
-- object is owned by the approved runtime role. It is checked against
-- FORBIDDEN_BASELINE_PATTERNS before being written, and the capture fails
-- rather than emitting anything that looks like a credential or a person.
--
-- HOW IT IS APPLIED
--
-- FIRST, before migration 001, and only to an EMPTY schema. The runner refuses
-- a non-empty target — applying a baseline over a live database would attempt
-- to recreate tables that already hold data.
--
-- WHEN A MIGRATION CHANGES THE SCHEMA
--
-- Nothing here is edited. The migration is the record of the change; this file
-- is re-captured only when the baseline is deliberately rebased forward, which
-- is a decision with its own procedure in DATABASE_BASELINE_CAPTURE.md.
`;

/** Ownership is normalised on the way out — never copied from the source. */
export const ownerStatement = (object: string, kind: 'TABLE' | 'SEQUENCE' | 'VIEW'): string =>
  `ALTER ${kind} ${SCHEMA}.${object} OWNER TO ${APPROVED_OWNER_ROLES[0]};`;

// ─── Plan ─────────────────────────────────────────────────────────────────────

const printPlan = () => {
  const needed = requirements();
  console.log('Servana baseline capture — PLAN ONLY. Nothing was connected to.\n');
  console.log(`  target file            ${path.relative(process.cwd(), BASELINE_FILE)}`);
  console.log(`  catalog queries        ${CATALOG_QUERIES.length} (information_schema / pg_catalog only)`);
  console.log(`  reads application rows no\n`);

  console.log(`Tables the migration chain proves must exist before it runs (${needed.length}):\n`);
  for (const requirement of needed) {
    console.log(`  ${requirement.table.padEnd(22)} ${requirement.provenColumns.length} proven column(s), altered by ${requirement.alteredBy.length} migration(s)`);
    if (requirement.provenColumns.length) {
      console.log(`      ${requirement.provenColumns.join(', ')}`);
    }
  }

  console.log('\nRefusals in force:');
  console.log('  • never the configured production host or database');
  console.log('  • non-local sources need BASELINE_SOURCE_ACK=<host:port>');
  console.log('  • output is scanned for secrets and personal data before it is written');
  console.log('\nTo capture: restore a production dump into a DISPOSABLE instance, then');
  console.log('  npm run baseline:capture -- --from=postgres://user@localhost:5432/servana_baseline');
};

// ─── Capture ──────────────────────────────────────────────────────────────────

const capture = async (from: string) => {
  // Imported lazily so `--plan` never constructs a pool.
  const { db } = await import('../src/config');
  const check = checkSource(from, process.env, { host: db.host as string, database: db.database as string });
  if (!check.allowed) throw new Error(check.reason);

  if (!queriesAreCatalogOnly()) {
    throw new Error('A catalog query was modified to read application data. Refusing to run.');
  }

  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: from });
  const client = await pool.connect();
  const results = new Map<string, any[]>();
  try {
    for (const query of CATALOG_QUERIES) {
      const { rows } = await client.query(query.sql, [SCHEMA]);
      results.set(query.name, rows);
    }
  } finally {
    client.release();
    await pool.end();
  }

  const sql = renderBaseline(results);
  const problems = sanitisationProblems(sql);
  if (problems.length) {
    throw new Error(`Refusing to write the baseline — it contains:\n  ${problems.join('\n  ')}`);
  }

  fs.mkdirSync(BASELINE_DIR, { recursive: true });
  fs.writeFileSync(BASELINE_FILE, sql, 'utf8');
  console.log(`wrote ${path.relative(process.cwd(), BASELINE_FILE)} (${sql.split('\n').length} lines)`);
  console.log('Now run: npm run db:verify  — it checks the baseline against the requirements.');
};

/**
 * Render catalog rows as DDL.
 *
 * Kept separate from the connection so it is testable with fixture rows, which
 * is how `tests/schema-baseline.test.ts` exercises it without a database.
 */
export const renderBaseline = (results: Map<string, any[]>): string => {
  const lines: string[] = [BASELINE_HEADER, ''];
  const columns = results.get('columns') ?? [];
  const constraints = results.get('constraints') ?? [];
  const indexes = results.get('indexes') ?? [];
  const sequences = results.get('sequences') ?? [];
  const ownership = results.get('sequence_ownership') ?? [];

  lines.push(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA};`, '');

  for (const sequence of sequences) {
    lines.push(
      `CREATE SEQUENCE IF NOT EXISTS ${SCHEMA}.${sequence.name}` +
        `${sequence.data_type && sequence.data_type !== 'bigint' ? ` AS ${sequence.data_type}` : ''}` +
        ` START ${sequence.start_value} INCREMENT ${sequence.increment_by};`,
    );
    lines.push(ownerStatement(sequence.name, 'SEQUENCE'));
  }
  if (sequences.length) lines.push('');

  const byTable = new Map<string, any[]>();
  for (const column of columns) {
    if (!byTable.has(column.table_name)) byTable.set(column.table_name, []);
    byTable.get(column.table_name)!.push(column);
  }

  for (const [table, tableColumns] of [...byTable.entries()].sort()) {
    lines.push(`CREATE TABLE IF NOT EXISTS ${SCHEMA}.${table} (`);
    const definitions = tableColumns.map((column) => {
      const type = renderType(column);
      const nullable = column.is_nullable === 'NO' ? ' NOT NULL' : '';
      const fallback = column.column_default ? ` DEFAULT ${column.column_default}` : '';
      return `  ${column.column_name} ${type}${fallback}${nullable}`;
    });
    lines.push(definitions.join(',\n'));
    lines.push(');');
    lines.push(ownerStatement(table, 'TABLE'));
    lines.push('');
  }

  // Constraints after every table, so a foreign key never precedes its target.
  for (const constraint of constraints) {
    const table = String(constraint.table_name).replace(`${SCHEMA}.`, '');
    if (constraint.contype === 'p' || constraint.contype === 'u' || constraint.contype === 'f' || constraint.contype === 'c') {
      lines.push(
        `ALTER TABLE ${SCHEMA}.${table} ADD CONSTRAINT ${constraint.name} ${constraint.definition};`,
      );
    }
  }
  if (constraints.length) lines.push('');

  for (const index of indexes) {
    // Constraint-backed indexes are already created by the constraint above.
    if (constraints.some((c) => c.name === index.name)) continue;
    lines.push(`${index.definition};`);
  }
  if (indexes.length) lines.push('');

  for (const owned of ownership) {
    lines.push(
      `ALTER SEQUENCE ${SCHEMA}.${owned.sequence_name} OWNED BY ${SCHEMA}.${owned.table_name}.${owned.column_name};`,
    );
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
};

export const renderType = (column: {
  data_type: string;
  character_maximum_length: number | null;
  numeric_precision: number | null;
  numeric_scale: number | null;
}): string => {
  const type = String(column.data_type).toUpperCase();
  if (column.character_maximum_length) return `${type}(${column.character_maximum_length})`;
  if (type === 'NUMERIC' && column.numeric_precision) {
    return column.numeric_scale
      ? `NUMERIC(${column.numeric_precision},${column.numeric_scale})`
      : `NUMERIC(${column.numeric_precision})`;
  }
  return type;
};

if (require.main === module) {
  if (planOnly) {
    printPlan();
  } else {
    capture(fromArg).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  }
}
