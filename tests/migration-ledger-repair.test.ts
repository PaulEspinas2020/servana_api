/**
 * The ledger repair must be correct and, more importantly, must not be able to
 * lie about what has run.
 *
 * `run-migrations.ts` throws on the FIRST checksum mismatch, so 38 stale CRLF
 * rows mean no migration can ever apply. The repair corrects how APPLIED
 * migrations were recorded. The dangerous mistake available here is to also
 * INSERT rows for migrations that are merely missing — that would assert a
 * migration ran when it did not, and the ledger is the only record of that. A
 * future deploy would then skip SQL that never touched the database.
 *
 * So the property under test is not only "the hashes are right" but "the script
 * cannot mark an unapplied migration as applied".
 */

import fs from 'fs';
import path from 'path';
import { migrationChecksum } from '../scripts/lib/migrationChecksum';
import { buildRepairSql, ledgerRepairRows } from '../scripts/repair-migration-ledger';

const migrationsDir = path.resolve(__dirname, '..', 'scripts', 'migrations');
const migrationFiles = fs
  .readdirSync(migrationsDir)
  .filter((name) => /^\d{3}-.+\.sql$/.test(name))
  .sort();

describe('migration ledger repair', () => {
  it('covers every migration file exactly once, in apply order', () => {
    const rows = ledgerRepairRows();
    expect(rows.map((r) => r.name)).toEqual(migrationFiles);
  });

  it('uses the shared checksum rule rather than hashing by hand', () => {
    // Two call sites hashing slightly differently is the bug this repair exists
    // to clean up, wearing a different hat.
    for (const row of ledgerRepairRows()) {
      const raw = fs.readFileSync(path.join(migrationsDir, row.name), 'utf8');
      expect(row.checksum).toBe(migrationChecksum(raw));
    }
  });

  it('produces the checksum the deploy host already computed for 001', () => {
    // Recorded in d4b0150: the deploy host computed 272d57a5… from the LF bytes
    // while the ledger held 63809a45… from a Windows copy. Pinning the value the
    // host computes means this repair is verified against something outside this
    // repository's own arithmetic.
    const first = ledgerRepairRows().find((r) => r.name === '001-massage-services.sql');
    expect(first?.checksum).toBe('272d57a520c717593f7050f0fd0f4e98e5741137d7b845f01de1864350b6f9b3');
  });

  it('NEVER emits an INSERT — a missing row is pending, not damaged', () => {
    const sql = buildRepairSql(ledgerRepairRows());
    const statements = sql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'));
    expect(statements.join('\n')).not.toMatch(/\bINSERT\b/i);
  });

  it('guards every UPDATE so re-running it is a no-op', () => {
    const sql = buildRepairSql(ledgerRepairRows());
    const updates = sql.split('\n').filter((l) => l.startsWith('UPDATE '));
    expect(updates).toHaveLength(migrationFiles.length);
    // Each UPDATE's WHERE carries `checksum_sha256 <> <new>`, so a row already
    // correct is never rewritten and the repair can be run twice safely.
    const guards = sql.split('\n').filter((l) => /AND checksum_sha256 <> /.test(l));
    expect(guards).toHaveLength(migrationFiles.length);
  });

  it('wraps the whole repair in one transaction', () => {
    const sql = buildRepairSql(ledgerRepairRows());
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql).toMatch(/^COMMIT;$/m);
    // Partially-repaired is the one state worse than unrepaired: it would leave
    // the throw-on-first-mismatch scan failing at a different, later file.
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it('escapes the migration names it interpolates', () => {
    const sql = buildRepairSql([{ name: "weird'name.sql", checksum: 'abc' }]);
    expect(sql).toContain("'weird''name.sql'");
  });
});
