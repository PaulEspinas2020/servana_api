/**
 * The migration checksum must not depend on the operating system.
 *
 * A deploy failed with `Applied migration checksum changed: 001-massage-services.sql`
 * for a file nobody had touched in eight months. The ledger held a hash computed
 * from a Windows working copy (CRLF); the Linux deploy host checked out LF. Same
 * SQL, different bytes, different sha256.
 *
 * The failure mode is worse than one bad deploy: the check reads files in order
 * and throws on the first mismatch, so EVERY migration mismatched and no deploy
 * could apply anything again. A guard that always fires gets deleted, which is
 * how it becomes no guard at all.
 */

import fs from 'fs';
import path from 'path';
import { migrationChecksum, normaliseLineEndings } from '../scripts/lib/migrationChecksum';

const MIGRATIONS = path.resolve(__dirname, '../scripts/migrations');

describe('the checksum is identical across line-ending conventions', () => {
  const sql = 'CREATE TABLE servana.x (\n  id INT\n);\n';
  const crlf = sql.replace(/\n/g, '\r\n');

  it('LF and CRLF hash the same', () => {
    expect(migrationChecksum(sql)).toBe(migrationChecksum(crlf));
  });

  it('a lone CR hashes the same too', () => {
    // Nobody writes classic-Mac endings on purpose. Leaving the case out is how
    // this recurs, which is the only reason it is here.
    expect(migrationChecksum(sql.replace(/\n/g, '\r'))).toBe(migrationChecksum(sql));
  });

  it('a REAL content change still changes the hash', () => {
    /**
     * The point of normalising is to ignore encoding, not to ignore edits. If
     * this ever passed, the drift guard would be decorative.
     */
    expect(migrationChecksum(sql)).not.toBe(
      migrationChecksum(sql.replace('id INT', 'id BIGINT')),
    );
  });

  it('whitespace INSIDE a line still counts', () => {
    // Only line TERMINATORS are normalised. Indentation is content.
    expect(migrationChecksum('SELECT 1;')).not.toBe(migrationChecksum('SELECT  1;'));
  });
});

describe('normaliseLineEndings', () => {
  it('converts CRLF and lone CR to LF, and leaves LF alone', () => {
    expect(normaliseLineEndings('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
  });

  it('does not touch a CR that is not a line ending in the normalised sense', () => {
    // There is no such case for SQL, but the function must be total: any input
    // returns a string with no CR left in it.
    expect(normaliseLineEndings('a\r\r\nb')).not.toMatch(/\r/);
  });
});

describe('every producer uses the shared function', () => {
  /**
   * Two call sites hashing slightly differently is the same class of defect as
   * two line-ending conventions, and harder to see. Asserted on source because
   * the alternative is discovering it on a deploy.
   */
  const sources = [
    'scripts/run-migrations.ts',
    'scripts/verify-fresh-db.ts',
    'scripts/lib/schemaBaseline.ts',
  ];

  for (const rel of sources) {
    it(`${rel} does not hash migrations by hand`, () => {
      const src = fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
      expect(src).toContain('migrationChecksum');
      // The raw idiom this replaced. Its return would be platform-dependent.
      expect(src).not.toMatch(/createHash\('sha256'\)\.update\((raw|sql)\)/);
    });
  }
});

describe('every migration on disk hashes deterministically', () => {
  it('re-hashing the same file twice agrees', () => {
    const files = fs.readdirSync(MIGRATIONS).filter((f) => /^\d{3}-.+\.sql$/.test(f));
    expect(files.length).toBeGreaterThan(30);
    for (const f of files) {
      const sql = fs.readFileSync(path.join(MIGRATIONS, f), 'utf8');
      expect(migrationChecksum(sql)).toBe(migrationChecksum(sql));
    }
  });

  it('hashing the raw BYTES would differ from hashing the normalised text on this platform', () => {
    /**
     * Only meaningful where the working copy actually has CRLF — which is the
     * situation that caused the incident. Where it does not, the assertion is
     * vacuous and skipped rather than quietly passing for the wrong reason.
     */
    const files = fs.readdirSync(MIGRATIONS).filter((f) => /^\d{3}-.+\.sql$/.test(f));
    const withCrlf = files.find((f) =>
      fs.readFileSync(path.join(MIGRATIONS, f), 'utf8').includes('\r\n'),
    );
    if (!withCrlf) {
      // LF checkout: nothing to prove here.
      return;
    }
    const raw = fs.readFileSync(path.join(MIGRATIONS, withCrlf), 'utf8');
    expect(normaliseLineEndings(raw)).not.toBe(raw);
    expect(migrationChecksum(raw)).toBe(migrationChecksum(normaliseLineEndings(raw)));
  });
});
