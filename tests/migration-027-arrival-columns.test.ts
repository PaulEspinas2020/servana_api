/**
 * Migration 027 — the arrival timestamp columns.
 *
 * DEPLOYMENT-CRITICAL. The canonical executor writes `accepted_at`,
 * `en_route_at` and `arrived_at`, and deliberately performs no schema repair
 * of its own. Until 027 has applied, `technicianService.ensureArrivalColumns()`
 * is the only thing creating them — and the `/api/v1` provider endpoints never
 * call it, because they go straight to the executor.
 *
 * The release sequence is therefore NOT the usual one. See
 * docs/TAB04_OPEN_GAPS.md; the short form is that 027 must apply BEFORE the
 * application restarts onto code that depends on it, or there is a window in
 * which a v1 accept or arrival hits a missing column.
 *
 * These are the gates that can be checked without a database. The ones that
 * cannot — actual application against the current production schema, and
 * ownership of the altered table — are listed in the gaps document as manual
 * release steps rather than implied to be covered here.
 */

import fs from 'fs';
import path from 'path';

const FILE = path.resolve(__dirname, '../scripts/migrations/027-booking-lifecycle-timestamps.sql');
const sql = fs.readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n');

/** SQL with comments removed — a comment naming BEGIN is not a BEGIN. */
const statements = sql
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

describe('027 is safe to apply', () => {
  it('IDEMPOTENT: every column is added IF NOT EXISTS', () => {
    const adds = statements.match(/ADD COLUMN[^,;]*/gi) ?? [];
    expect(adds.length).toBe(4);
    for (const add of adds) {
      expect(add).toMatch(/ADD COLUMN IF NOT EXISTS/i);
    }
  });

  it('COLUMN TYPES match the lazy DDL exactly', () => {
    // A type that differs from what ensureArrivalColumns() creates would apply
    // cleanly on a fresh database and silently do nothing on one where the
    // lazy DDL already ran — leaving two environments with different schemas
    // and only one of them tested.
    const lazy = fs.readFileSync(
      path.resolve(__dirname, '../src/services/technicianService.ts'), 'utf8',
    );
    const lazyBlock = lazy.slice(
      lazy.indexOf('const ensureArrivalColumns'),
      lazy.indexOf('const runArrivalTransition'),
    );

    for (const column of ['accepted_at', 'en_route_at', 'arrived_at', 'declined_at']) {
      expect(statements).toMatch(new RegExp(`${column}\\s+TIMESTAMPTZ`, 'i'));
      expect(lazyBlock).toMatch(new RegExp(`${column}\\s+TIMESTAMPTZ`, 'i'));
    }
  });

  it('NULLABILITY: no NOT NULL and no DEFAULT', () => {
    // Either would rewrite the table and change the meaning of every existing
    // row. These columns are additive history, and an absent value means the
    // stage did not happen — not that it happened at some default time.
    const adds = statements.match(/ADD COLUMN[^,;]*/gi) ?? [];
    for (const add of adds) {
      expect(add).not.toMatch(/NOT NULL/i);
      expect(add).not.toMatch(/DEFAULT/i);
    }
  });

  it('covers exactly the four columns the executor writes', () => {
    const executor = fs.readFileSync(
      path.resolve(__dirname, '../src/services/booking/transitionExecutor.ts'), 'utf8',
    );
    const written = ['accepted_at', 'en_route_at', 'arrived_at', 'declined_at']
      .filter((c) => new RegExp(`${c}\\s*=`).test(executor));
    // Every column the executor stamps must be in the migration.
    for (const column of written) {
      expect(statements).toContain(column);
    }
    expect(written.length).toBeGreaterThan(0);
  });

  it('NO EMBEDDED TRANSACTION: the runner owns BEGIN and COMMIT', () => {
    // A migration carrying its own COMMIT ends the runner's transaction early,
    // which defeats the dry run and has taken production down before.
    expect(statements).not.toMatch(/\bBEGIN\b/i);
    expect(statements).not.toMatch(/\bCOMMIT\b/i);
    expect(statements).not.toMatch(/\bROLLBACK\b/i);
  });

  it('touches ONE table, and only by adding columns', () => {
    // No data migration, no drop, no rename, no constraint. The blast radius
    // of this file is exactly four nullable columns.
    expect(statements).not.toMatch(/\bDROP\b/i);
    expect(statements).not.toMatch(/\bRENAME\b/i);
    expect(statements).not.toMatch(/\bUPDATE\b/i);
    expect(statements).not.toMatch(/\bDELETE\b/i);
    const tables = [...statements.matchAll(/ALTER TABLE\s+([\w.]+)/gi)].map((m) => m[1]);
    expect([...new Set(tables)]).toEqual(['servana.booking_workers']);
  });

  it('is named so the runner will pick it up', () => {
    // The runner only reads files matching /^\d{3}-.+\.sql$/.
    expect(/^\d{3}-.+\.sql$/.test(path.basename(FILE))).toBe(true);
  });

  it('does not reuse an existing migration number', () => {
    const dir = path.dirname(FILE);
    const numbers = fs.readdirSync(dir)
      .filter((f) => /^\d{3}-.+\.sql$/.test(f))
      .map((f) => f.slice(0, 3));
    const duplicated = numbers.filter((n, i) => numbers.indexOf(n) !== i && n === '027');
    expect(duplicated).toEqual([]);
  });
});

describe('the compatibility bridge stays until production crosses 027', () => {
  const service = fs.readFileSync(
    path.resolve(__dirname, '../src/services/technicianService.ts'), 'utf8',
  );

  it('ensureArrivalColumns() still exists', () => {
    // Deliberately NOT deleted with B1.4. Removing it before 027 is applied in
    // production would reintroduce the gap it covers, and a rollback to
    // pre-027 code must still find the columns being created.
    expect(service).toContain('const ensureArrivalColumns');
  });

  it('the legacy arrival entry points still await it', () => {
    for (const fn of ['markEnRoute', 'markArrived']) {
      const start = service.indexOf(`export const ${fn}`);
      const body = service.slice(start, start + 500);
      expect(body).toContain('await ensureArrivalColumns()');
    }
  });

  it('the executor does NOT — schema repair is not a transition', () => {
    const executor = fs.readFileSync(
      path.resolve(__dirname, '../src/services/booking/transitionExecutor.ts'), 'utf8',
    );
    expect(executor).not.toContain('ensureArrivalColumns');
    expect(executor).not.toMatch(/ALTER TABLE \$\{s\}\.booking_workers/);
  });
});
