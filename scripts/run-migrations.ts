import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { pool } from '../src/db/dbQuery';
import { db } from '../src/config';
import {
  stripTransactionControl,
  declaresDestructive,
  destructiveAuthorised,
  DESTRUCTIVE_ACK_VAR,
} from './lib/migrationSafety';

const apply = process.argv.includes('--apply');
const migrationsDir = path.resolve(__dirname, 'migrations');

async function main() {
  const host = String(db.host ?? '');
  const database = String(db.database ?? '');
  if (!host || !database || !db.user || !db.password) throw new Error('Database configuration is incomplete; no migration was attempted.');
  const local = /^(localhost|127\.0\.0\.1|::1)$/i.test(host);
  if (apply && !local && process.env.MIGRATION_REMOTE_ACK !== `${host}/${database}`) {
    throw new Error(`Remote migration refused. Set MIGRATION_REMOTE_ACK exactly to ${host}/${database} after deployment approval.`);
  }
  const files = fs.readdirSync(migrationsDir).filter((name) => /^\d{3}-.+\.sql$/.test(name)).sort();
  const client = await pool.connect();
  let locked = false;
  try {
    if (apply) {
      await client.query(`SELECT pg_advisory_lock(hashtext('servana-controlled-migrations'))`);
      locked = true;
      await client.query(`CREATE TABLE IF NOT EXISTS servana.schema_migrations (
        migration_name TEXT PRIMARY KEY, checksum_sha256 TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    }
    const ledgerTable = await client.query("SELECT to_regclass('servana.schema_migrations') AS name");
    const existing = ledgerTable.rows[0]?.name
      ? await client.query('SELECT migration_name, checksum_sha256 FROM servana.schema_migrations')
      : { rows: [] as any[] };
    const ledger = new Map(existing.rows.map((row: any) => [row.migration_name, row.checksum_sha256]));
    const pending: Array<{ name: string; sql: string; checksum: string }> = [];
    for (const name of files) {
      const raw = fs.readFileSync(path.join(migrationsDir, name), 'utf8');
      const checksum = createHash('sha256').update(raw).digest('hex');
      const recorded = ledger.get(name);
      if (recorded && recorded !== checksum) throw new Error(`Applied migration checksum changed: ${name}`);
      if (!recorded) pending.push({ name, sql: stripTransaction(raw), checksum });
    }
    console.log(JSON.stringify({ mode: apply ? 'apply' : 'plan', target: `${host}/${database}`, applied: ledger.size, pending: pending.map((x) => x.name) }, null, 2));
    if (!apply) return;

    /**
     * A migration that declares itself destructive is refused unless this
     * deploy named it. Checked for ALL pending migrations before any of them
     * runs, so an unauthorised one cannot be discovered halfway through a batch
     * with earlier migrations already committed.
     */
    const unauthorised = pending.filter(
      (m) => declaresDestructive(m.sql) && !destructiveAuthorised(m.name),
    );
    if (unauthorised.length) {
      const names = unauthorised.map((m) => m.name).join(', ');
      throw new Error(
        'Refusing to apply destructive migration(s) without authorisation: ' +
          names +
          '. Set ' +
          DESTRUCTIVE_ACK_VAR +
          ' to the migration name(s), comma-separated, after an approved backup ' +
          'and change window.',
      );
    }

    for (const migration of pending) {
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO servana.schema_migrations(migration_name, checksum_sha256) VALUES ($1,$2)', [migration.name, migration.checksum]);
        await client.query('COMMIT');
        console.log(`applied ${migration.name}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    if (locked) await client.query(`SELECT pg_advisory_unlock(hashtext('servana-controlled-migrations'))`).catch(() => {});
    client.release();
    await pool.end();
  }
}

/**
 * The wrapper above owns the transaction, so the file's own must go.
 *
 * This used to be two anchored regexes — `/^\s*BEGIN\s*;/` and
 * `/COMMIT\s*;\s*$/` — which matched nothing in 16 of the 36 migrations,
 * because every file opens with a comment header and most close with a
 * verification note. A surviving `COMMIT;` commits the wrapper's transaction
 * mid-migration, so the ledger insert lands outside any transaction and the
 * wrapper's own COMMIT fails with "no transaction in progress".
 *
 * `stripTransactionControl` masks comments, string literals and `$$` bodies
 * first, so PL/pgSQL `BEGIN ... END` inside a `DO` block is left alone — eleven
 * migrations here would become syntax errors otherwise.
 *
 * The checksum above is taken from the RAW file, so this changes no checksum
 * and no migration file. `tests/migration-safety.test.ts` asserts the residue
 * is empty for every file in the directory.
 */
const stripTransaction = stripTransactionControl;

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
