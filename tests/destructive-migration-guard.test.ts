/**
 * A destructive migration must not apply as a side effect of a routine deploy.
 *
 * Found by reading the deploy workflow rather than the migrations: `deploy.yml`
 * walked every file in `scripts/migrations/` and ran anything without a `.done`
 * marker on the runner host. Migration 037 drops 39 unique constraints. Nothing
 * stood between the next push and that happening, with nobody having decided to.
 */

import fs from 'fs';
import path from 'path';
import {
  DESTRUCTIVE_MARKER,
  DESTRUCTIVE_ACK_VAR,
  declaresDestructive,
  destructiveAuthorised,
  scanMigration,
} from '../scripts/lib/migrationSafety';

const MIGRATIONS = path.resolve(__dirname, '../scripts/migrations');
const read = (f: string) => fs.readFileSync(path.join(MIGRATIONS, f), 'utf8');
const files = () => fs.readdirSync(MIGRATIONS).filter((f) => /^\d{3}-.+\.sql$/.test(f)).sort();

describe('declaring a migration destructive', () => {
  it('recognises the marker', () => {
    expect(declaresDestructive(`-- ${DESTRUCTIVE_MARKER} drops things\nSELECT 1;`)).toBe(true);
  });

  it('does not guess from SQL', () => {
    /**
     * Inference would be wrong in both directions. `DROP TRIGGER` immediately
     * recreated (031) is not destructive, and 037 drops its constraints from
     * inside an EXECUTE format(...) string that no pattern-match can see.
     * The author knows; a scanner does not.
     */
    expect(declaresDestructive('DROP TABLE servana.things;')).toBe(false);
    expect(declaresDestructive("EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, c);")).toBe(
      false,
    );
  });

  it('reports it as a finding so migrations:plan shows it', () => {
    const findings = scanMigration('099-x.sql', `-- ${DESTRUCTIVE_MARKER}\nSELECT 1;`);
    const d = findings.find((f) => f.rule === 'destructive');
    expect(d).toBeDefined();
    expect(d!.detail).toContain(DESTRUCTIVE_ACK_VAR);
  });
});

describe('authorisation is per migration, never blanket', () => {
  const NAME = '037-notification-key-drop-global-uniques';

  it('refuses when nothing is set', () => {
    expect(destructiveAuthorised(NAME, undefined)).toBe(false);
    expect(destructiveAuthorised(NAME, '')).toBe(false);
  });

  it('accepts the migration named exactly', () => {
    expect(destructiveAuthorised(NAME, NAME)).toBe(true);
  });

  it('accepts one of several, comma-separated and space-tolerant', () => {
    expect(destructiveAuthorised(NAME, `040-other, ${NAME} , 041-more`)).toBe(true);
  });

  it('does NOT authorise a different migration', () => {
    // The whole point: authorising one destructive migration must not authorise
    // the next one somebody writes.
    expect(destructiveAuthorised('038-something-else', NAME)).toBe(false);
  });

  it('is not satisfied by a truthy blanket value', () => {
    // A CI variable left set to "1" or "true" would otherwise authorise
    // everything forever.
    expect(destructiveAuthorised(NAME, '1')).toBe(false);
    expect(destructiveAuthorised(NAME, 'true')).toBe(false);
    expect(destructiveAuthorised(NAME, 'yes')).toBe(false);
  });
});

describe('037 is marked, and it is the only one', () => {
  it('037 declares itself destructive', () => {
    expect(declaresDestructive(read('037-notification-key-drop-global-uniques.sql'))).toBe(true);
  });

  it('no other migration is marked', () => {
    /**
     * Pinned so marking a migration destructive is a deliberate act. If this
     * fails because a new migration is marked, that is correct — update the
     * list and make sure the deploy that carries it names the migration.
     */
    const marked = files().filter((f) => declaresDestructive(read(f)));
    expect(marked).toEqual(['037-notification-key-drop-global-uniques.sql']);
  });
});

describe('the runner applies the safe prefix and HOLDS', () => {
  const SOURCE = fs.readFileSync(
    path.resolve(__dirname, '../scripts/run-migrations.ts'),
    'utf8',
  );

  /**
   * This originally refused the WHOLE batch if any pending migration was
   * destructive and unnamed. Rehearsing against real PostgreSQL showed that is
   * backwards: it made 036 — additive, wanted now — unappliable without also
   * authorising 037, which drops 39 constraints and deserves its own window.
   *
   * Verified live against PostgreSQL 16: 030-036 applied, 037 held, exit 0,
   * schema at 132 tables with the 40 stale constraints still present.
   */
  it('checks each migration inside the loop, so the prefix still applies', () => {
    const loop = SOURCE.indexOf('for (const migration of pending) {');
    const check = SOURCE.indexOf('declaresDestructive(migration.sql)');
    expect(loop).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(loop);
  });

  it('breaks rather than continuing — it must not skip ahead', () => {
    /**
     * Migrations are ordered. Applying 038 while 037 is held would produce a
     * schema nobody has described, so everything behind the held one waits too.
     */
    const block = SOURCE.slice(
      SOURCE.indexOf('declaresDestructive(migration.sql)'),
      SOURCE.indexOf('await client.query(\'BEGIN\')'),
    );
    expect(block).toContain('break;');
    expect(block).not.toContain('continue;');
  });

  it('names the env var and the migration in the HELD notice', () => {
    const block = SOURCE.slice(
      SOURCE.indexOf('declaresDestructive(migration.sql)'),
      SOURCE.indexOf('await client.query(\'BEGIN\')'),
    );
    expect(block).toContain('HELD');
    expect(block).toContain('DESTRUCTIVE_ACK_VAR');
  });

  it('exits SUCCESS when holding, so a deploy is not blocked forever', () => {
    /**
     * Failing here would stop the deploy before its restart, leaving new code
     * undeployed for as long as ANY destructive migration sits pending. The
     * hold is the intended outcome, not an error.
     */
    const holdBlock = SOURCE.slice(
      SOURCE.indexOf('const held: string[] = []'),
      SOURCE.indexOf('} finally {'),
    );
    expect(holdBlock).not.toContain('throw new Error');
    expect(holdBlock).not.toContain('process.exit(1)');
  });

  it('reports what was applied and what was held', () => {
    expect(SOURCE).toContain('applied, ');
    expect(SOURCE).toContain('held: ');
  });
});

describe('the deploy script uses the real runner', () => {
  /**
   * These properties used to be asserted against `.github/workflows/deploy.yml`.
   * That file is gone — this platform runs no CI on any repository — and the
   * deploy is now `scripts/deploy-prod.sh`, which carries the same steps. The
   * properties did not change with the medium, so neither did the assertions.
   */
  const SH = fs.readFileSync(
    path.resolve(__dirname, '../scripts/deploy-prod.sh'),
    'utf8',
  );

  it('no longer keeps a second ledger in marker files', () => {
    // `.done` files on the runner host vs servana.schema_migrations in the
    // database — two ledgers for one question, and they had already diverged.
    // Asserted on the EXECUTABLE body, not the file: the comment above the step
    // deliberately explains what the marker-file ledger was and why it went.
    expect(SH).not.toMatch(/^\s*DONE_DIR=/m);
    expect(SH).not.toMatch(/touch "[$]DONE_DIR/);
    expect(SH).not.toMatch(/^\s*for FILE in .*scripts\/migrations/m);
  });

  it('invokes the runner that holds the advisory lock and checks checksums', () => {
    expect(SH).toContain('npm run migrations:apply');
  });

  it('plans before it applies', () => {
    const plan = SH.indexOf('npm run migrations:plan');
    const apply = SH.indexOf('npm run migrations:apply');
    expect(plan).toBeGreaterThan(-1);
    expect(apply).toBeGreaterThan(plan);
  });

  it('keeps migrations after the checks and the build, and before the restart', () => {
    /**
     * Load-bearing ordering, got wrong once already: a failing check must touch
     * nothing, and a failing migration must stop short of the restart so the old
     * code keeps serving.
     *
     * The full suite is deliberately NOT one of these checks — it runs in the
     * pre-push hook, on a machine with memory. What runs here are the checks
     * specific to this host: typecheck, docs drift, secret scan, and the
     * protected-contract guard.
     */
    const checks = SH.indexOf('npm run guard:protected-contracts');
    const build = SH.indexOf('npm run build');
    const migrate = SH.indexOf('npm run migrations:apply');
    const restart = SH.indexOf('$PM2 start');
    expect(checks).toBeGreaterThan(-1);
    expect(checks).toBeLessThan(build);
    expect(build).toBeLessThan(migrate);
    expect(migrate).toBeLessThan(restart);
  });

  it('passes the destructive-migration authorisation through from the operator', () => {
    // It used to come from an Actions repo variable. With Actions gone it must
    // come from the calling shell — and it must NOT be hardcoded here, which
    // would authorise every future destructive migration rather than the one
    // deploy that intends it.
    expect(SH).toMatch(/SERVANA_APPLY_DESTRUCTIVE/);
    // Every assignment must derive from the environment. A literal migration
    // name here would authorise it on every subsequent deploy, silently.
    const assignments = SH.match(/SERVANA_APPLY_DESTRUCTIVE=\S*/g) ?? [];
    expect(assignments.length).toBeGreaterThan(0);
    for (const a of assignments) {
      expect(a).toMatch(/SERVANA_APPLY_DESTRUCTIVE="\$\{SERVANA_APPLY_DESTRUCTIVE/);
    }
  });
});
