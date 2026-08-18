/**
 * Migration safety (§147).
 *
 * ## The defect this suite pins
 *
 * `run-migrations.ts` wraps each migration in its own `BEGIN`/`COMMIT` so the
 * schema change and the `schema_migrations` ledger row land together. It
 * stripped the file's own transaction control with two anchored regexes, and
 * those regexes matched **nothing in 16 of the 36 migrations** — every file
 * opens with a comment header, so `BEGIN;` is never at offset 0, and most close
 * with a verification note, so `COMMIT;` is never at the end.
 *
 * A surviving `COMMIT;` commits the wrapper's transaction mid-migration. The
 * ledger insert then runs outside any transaction and the wrapper's own COMMIT
 * fails with "no transaction in progress" — so a failure in that window leaves
 * the schema changed, the ledger empty, and the next deploy replaying a
 * migration that has already half-run.
 *
 * The fix is in the STRIPPER, not in the files: twenty of them are applied in
 * production and the runner refuses a checksum change, so editing them would
 * break the deploy permanently. This suite asserts the stripper is now
 * sufficient for every file that actually exists.
 */

import fs from 'fs';
import path from 'path';
import {
  APPROVED_OWNER_ROLES,
  OWNERSHIP_REQUIRED_FROM,
  findTransactionControl,
  findUnownedTables,
  maskNonCode,
  migrationNumber,
  residualTransactionControl,
  scanMigration,
  stripTransactionControl,
} from '../scripts/lib/migrationSafety';

const MIGRATIONS = path.resolve(__dirname, '..', 'scripts', 'migrations');
const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
const read = (name: string) => fs.readFileSync(path.join(MIGRATIONS, name), 'utf8');

// ─── The gate ─────────────────────────────────────────────────────────────────

describe('the wrapper owns the transaction, and nothing else does', () => {
  it('finds every migration in the directory', () => {
    // A suite that silently scanned zero files would pass forever.
    expect(files.length).toBeGreaterThan(30);
  });

  it.each(files)('%s leaves no transaction control after stripping', (name) => {
    /**
     * THE assertion. Not "the file has no BEGIN" — twenty of these are frozen —
     * but "the stripper can remove whatever this file has".
     */
    expect(residualTransactionControl(read(name))).toEqual([]);
  });

  it('would have failed against the old anchored stripper', () => {
    // Proof the check can fail, so a green run means something. This is the
    // exact pair of regexes that shipped, run over the real files.
    const old = (sql: string) =>
      sql.replace(/^\s*BEGIN\s*;\s*/i, '').replace(/\s*COMMIT\s*;\s*$/i, '');

    const leaked = files.filter((name) => findTransactionControl(old(read(name))).length > 0);
    expect(leaked.length).toBeGreaterThan(10);
    // ...and the new one leaks nothing.
    expect(files.filter((name) => residualTransactionControl(read(name)).length > 0)).toEqual([]);
  });

  it('strips a header-preceded BEGIN, which the old one could not reach', () => {
    const sql = '-- a comment header\n-- another line\n\nBEGIN;\nCREATE TABLE x();\nCOMMIT;\n\n-- a trailing note\n';
    expect(residualTransactionControl(sql)).toEqual([]);
    expect(stripTransactionControl(sql)).toContain('CREATE TABLE x();');
  });
});

// ─── PL/pgSQL must survive ────────────────────────────────────────────────────

describe('PL/pgSQL blocks are not transaction control', () => {
  it('leaves a DO $$ ... BEGIN ... END $$ body intact', () => {
    /**
     * The way a naive fix breaks the deploy. `BEGIN` and `END` are also block
     * delimiters, and eleven migrations here use them inside `DO $$`. Stripping
     * those turns a working migration into a syntax error.
     */
    const sql = `DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT 1 LOOP
    RAISE NOTICE 'x';
  END LOOP;
END $$;`;
    expect(stripTransactionControl(sql)).toBe(sql);
    expect(findTransactionControl(sql)).toEqual([]);
  });

  it('leaves a tagged dollar-quote alone', () => {
    const sql = "DO $body$ BEGIN PERFORM 1; END $body$;";
    expect(stripTransactionControl(sql)).toBe(sql);
  });

  it('every DO block in the real migrations survives untouched', () => {
    for (const name of files) {
      const raw = read(name);
      if (!raw.includes('DO $$')) continue;
      const stripped = stripTransactionControl(raw);
      // Same number of block openers and closers before and after.
      expect((stripped.match(/DO \$\$/g) ?? []).length).toBe((raw.match(/DO \$\$/g) ?? []).length);
      expect((stripped.match(/END \$\$/g) ?? []).length).toBe((raw.match(/END \$\$/g) ?? []).length);
    }
  });

  it('ignores the words inside a comment', () => {
    const sql = '-- we used to COMMIT; here\nSELECT 1;\n';
    expect(findTransactionControl(sql)).toEqual([]);
  });

  it('ignores the words inside a string literal', () => {
    // A COMMENT ON ... IS 'we ran COMMIT; by hand' is not transaction control.
    const sql = "COMMENT ON TABLE t IS 'somebody ran COMMIT; by hand';\n";
    expect(findTransactionControl(sql)).toEqual([]);
  });

  it('masks without moving anything, so a line number still points at the file', () => {
    const sql = 'line one\n-- comment\nBEGIN;\n';
    const masked = maskNonCode(sql);
    expect(masked.length).toBe(sql.length);
    expect(masked.split('\n').length).toBe(sql.split('\n').length);
    expect(findTransactionControl(sql)[0].line).toBe(3);
  });

  it('stripping preserves length, so a syntax error reports the real position', () => {
    for (const name of files) {
      const raw = read(name);
      expect(stripTransactionControl(raw).length).toBe(raw.length);
    }
  });
});

// ─── Ownership ────────────────────────────────────────────────────────────────

describe('objects a migration creates are owned by an approved role', () => {
  it('requires an explicit owner from migration 029 onward', () => {
    /**
     * Why this rule exists, from the repository's own history: on 2026-08-10
     * provider document upload returned a bare 500 for every provider. 29 of
     * 116 tables were owned by `postgres` rather than `admin` because some
     * migrations had been applied by hand as `sudo -u postgres psql`, and the
     * app had no privileges on them. An explicit OWNER makes a migration
     * correct regardless of who runs it.
     */
    const recent = files.filter((f) => (migrationNumber(f) ?? 0) >= OWNERSHIP_REQUIRED_FROM);
    expect(recent.length).toBeGreaterThan(0);

    const blocking = recent.flatMap((name) =>
      scanMigration(name, read(name)).filter(
        (f) => f.rule === 'object-ownership' && f.severity === 'BLOCKING',
      ),
    );
    expect(blocking.map((f) => `${f.file}: ${f.detail}`)).toEqual([]);
  });

  it('reports older migrations as advisory rather than demanding a frozen file change', () => {
    // The runner rejects a checksum change on an applied migration, so a
    // BLOCKING finding on migration 012 would be an instruction to break the
    // deploy. The live remedy is `npm run check:db-ownership`.
    const old = files.filter((f) => (migrationNumber(f) ?? 999) < OWNERSHIP_REQUIRED_FROM);
    const findings = old.flatMap((name) => scanMigration(name, read(name)));
    for (const finding of findings) {
      expect(finding.severity).toBe('ADVISORY');
    }
  });

  it('accepts only an approved runtime role', () => {
    expect(findUnownedTables('CREATE TABLE servana.x(); ALTER TABLE servana.x OWNER TO admin;')).toEqual([]);
    const wrong = findUnownedTables('CREATE TABLE servana.x(); ALTER TABLE servana.x OWNER TO postgres;');
    expect(wrong).toHaveLength(1);
    expect(wrong[0].reason).toContain('not an approved runtime role');
    expect(APPROVED_OWNER_ROLES).toContain('admin');
  });

  it('does not mistake the words in a comment for a CREATE TABLE', () => {
    // An earlier draft of this scanner reported a table called "whose" from
    // prose in migration 024.
    expect(findUnownedTables('-- CREATE TABLE whose owner is unclear\nSELECT 1;')).toEqual([]);
  });

  it('sees a table created with IF NOT EXISTS', () => {
    const findings = findUnownedTables('CREATE TABLE IF NOT EXISTS servana.y(a int);');
    expect(findings).toHaveLength(1);
    expect(findings[0].table).toBe('servana.y');
  });
});

// ─── Naming ───────────────────────────────────────────────────────────────────

describe('the runner can see every migration', () => {
  it('every file matches the NNN-description.sql form the runner globs for', () => {
    // A file the runner does not pick up is a schema change that silently never
    // applies, and nothing else in the system would notice.
    for (const name of files) {
      expect(name).toMatch(/^\d{3}-.+\.sql$/);
      expect(migrationNumber(name)).not.toBeNull();
    }
  });

  it('the whole directory has no blocking finding', () => {
    const blocking = files.flatMap((name) =>
      scanMigration(name, read(name)).filter((f) => f.severity === 'BLOCKING'),
    );
    expect(blocking.map((f) => `${f.file} [${f.rule}] ${f.detail}`)).toEqual([]);
  });

  it('the runner still refuses a remote apply without an explicit acknowledgement', () => {
    // Unchanged by this tab, and asserted so it stays that way.
    const source = fs.readFileSync(path.resolve(__dirname, '..', 'scripts', 'run-migrations.ts'), 'utf8');
    expect(source).toContain('MIGRATION_REMOTE_ACK');
    expect(source).toContain('Applied migration checksum changed');
    /**
     * The checksum is still taken from the RAW file — stripping transaction
     * control does not move it — but it is no longer hashed here.
     *
     * This asserted the literal `createHash('sha256').update(raw)`, and that
     * idiom was the defect: it hashes bytes, so a Windows checkout (CRLF) and
     * a Linux one (LF) produced different values for identical SQL. Every
     * migration mismatched on the deploy host and no deploy could apply
     * anything.
     *
     * `migrationChecksum` normalises line endings first, so the hash answers
     * "has the CONTENT changed" rather than "which OS wrote this file".
     */
    expect(source).toContain('migrationChecksum(raw)');
    expect(source).not.toMatch(/createHash\('sha256'\)\.update\(raw\)/);
    expect(source).toMatch(/stripTransaction\(raw\)/);
  });
});
