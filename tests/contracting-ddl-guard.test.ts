/**
 * Contracting DDL must declare itself (TAB 05).
 *
 * ## What was missing
 *
 * `scanMigration` already understood destructive migrations — but only when a
 * file DECLARED `SERVANA:DESTRUCTIVE`. Nothing detected the undeclared case, so
 * a migration could rename a table the whole platform reads and pass every gate
 * in silence.
 *
 * It did. `024-catalog-v2-canonical-rename.sql` drops a view and renames two
 * tables, declares nothing, and its own docblock records that a previous attempt
 * caused an outage and names the reverse that restored service.
 *
 * ## Why a floor rather than a sweep
 *
 * An applied migration's checksum is recorded in `servana.schema_migrations`.
 * Editing a historical file to add a marker changes that checksum and the ledger
 * rejects it — converting a documentation gap into a failed deploy. So the rule
 * binds from `CONTRACT_DECLARATION_REQUIRED_FROM` onward and records the two
 * below it as advisory, exactly as `OWNERSHIP_REQUIRED_FROM` does.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  findContractingDdl,
  scanMigration,
  CONTRACT_DECLARATION_REQUIRED_FROM,
  DESTRUCTIVE_MARKER,
  migrationNumber,
} from '../scripts/lib/migrationSafety';

const DIR = path.join(__dirname, '..', 'scripts', 'migrations');
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();

describe('contracting DDL is detected', () => {
  it('finds a rename, a drop and a type change', () => {
    const sql = `
      ALTER TABLE servana.a RENAME TO b;
      DROP VIEW servana.v;
      ALTER TABLE servana.c DROP COLUMN d;
      ALTER TABLE servana.e ALTER COLUMN f TYPE text;
      ALTER TABLE servana.g ALTER COLUMN h SET NOT NULL;
    `;
    const found = findContractingDdl(sql).map((f) => f.statement);
    expect(found).toEqual(
      expect.arrayContaining(['RENAME TO', 'DROP VIEW', 'DROP COLUMN', 'SET NOT NULL']),
    );
  });

  it('does NOT report DDL that only appears in a comment', () => {
    // 024 quotes its own reverse procedure in prose. A scanner that reads
    // docblocks reports nine violations in a file that executes three, and a
    // gate that cries wolf gets switched off.
    const sql = `
      -- Reverse: ALTER TABLE servana.services RENAME TO catalog_services;
      /* DROP TABLE servana.old_thing; */
      CREATE TABLE servana.x (id int);
    `;
    expect(findContractingDdl(sql)).toHaveLength(0);
  });

  it('is not fooled by an additive migration', () => {
    const sql = `
      ALTER TABLE servana.a ADD COLUMN b text;
      CREATE TABLE IF NOT EXISTS servana.c (id int);
      CREATE INDEX CONCURRENTLY idx ON servana.a (b);
    `;
    expect(findContractingDdl(sql)).toHaveLength(0);
  });
});

describe('the declaration rule', () => {
  it('a filename outside the NNN- convention is its own violation', () => {
    // Worth pinning: the first draft of this suite generated `38-…sql` and got
    // ADVISORY, because migrationNumber() could not read a two-digit name and
    // the floor comparison silently fell through.
    const findings = scanMigration('38-a-rename.sql', 'ALTER TABLE servana.a RENAME TO b;');
    expect(findings.some((f) => f.rule === 'filename' && f.severity === 'BLOCKING')).toBe(true);
  });

  it('BLOCKS undeclared contracting DDL at or above the floor', () => {
    const findings = scanMigration(
      `${String(CONTRACT_DECLARATION_REQUIRED_FROM).padStart(3, '0')}-a-rename.sql`,
      'ALTER TABLE servana.a RENAME TO b;\nALTER TABLE servana.b OWNER TO admin;',
    ).filter((f) => f.rule === 'contracting-ddl');

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('BLOCKING');
    expect(findings[0].detail).toContain(DESTRUCTIVE_MARKER);
  });

  it('allows it when the file declares itself', () => {
    const findings = scanMigration(
      `${String(CONTRACT_DECLARATION_REQUIRED_FROM).padStart(3, '0')}-a-rename.sql`,
      `-- ${DESTRUCTIVE_MARKER}\nALTER TABLE servana.a RENAME TO b;\nALTER TABLE servana.b OWNER TO admin;`,
    ).filter((f) => f.rule === 'contracting-ddl');

    expect(findings).toHaveLength(0);
  });

  it('is advisory below the floor, so historical files are not rewritten', () => {
    // Editing an applied migration changes its checksum and the ledger rejects
    // it. The rule binds forward.
    const findings = scanMigration(
      '024-catalog-v2-canonical-rename.sql',
      'ALTER TABLE servana.a RENAME TO b;\nALTER TABLE servana.b OWNER TO admin;',
    ).filter((f) => f.rule === 'contracting-ddl');

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('ADVISORY');
  });
});

describe('the migrations on disk', () => {
  it('no migration at or above the floor contracts without declaring it', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const n = migrationNumber(f);
      if (n === null || n < CONTRACT_DECLARATION_REQUIRED_FROM) continue;
      const blocking = scanMigration(f, fs.readFileSync(path.join(DIR, f), 'utf8')).filter(
        (x) => x.rule === 'contracting-ddl' && x.severity === 'BLOCKING',
      );
      if (blocking.length) offenders.push(`${f}: ${blocking.map((b) => b.detail).join('; ')}`);
    }
    expect({ count: offenders.length, offenders }).toMatchObject({ count: 0 });
  });

  it('records the two historical offenders rather than ignoring them', () => {
    // If either ever declares itself, or the detector stops seeing them, this
    // fails and somebody looks — which is the point of pinning a known state.
    const advisory = files.filter((f) =>
      scanMigration(f, fs.readFileSync(path.join(DIR, f), 'utf8')).some(
        (x) => x.rule === 'contracting-ddl' && x.severity === 'ADVISORY',
      ),
    );
    expect(advisory).toEqual([
      '012-provider-reputation-quality.sql',
      '024-catalog-v2-canonical-rename.sql',
    ]);
  });

  it('there are migrations to scan at all', () => {
    // Guards the vacuous pass.
    expect(files.length).toBeGreaterThan(30);
  });
});
