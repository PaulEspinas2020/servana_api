import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { pool } from '../src/db/dbQuery';
import { db } from '../src/config';

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

const stripTransaction = (sql: string) => sql
  .replace(/^\s*BEGIN\s*;\s*/i, '')
  .replace(/\s*COMMIT\s*;\s*$/i, '');

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
