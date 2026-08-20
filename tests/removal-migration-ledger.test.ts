/**
 * A removal migration must never be marked applied UNLESS it proves itself.
 *
 * ## What changed, and why the old rule had to go
 *
 * `verify-baseline-ledger` decides whether a migration can be marked applied by
 * asking whether the objects it CREATES are present in the baseline. A removal
 * creates nothing, so the list is empty — and the first version of this checker
 * read that as "no schema effect, it must have run", which for 037 was exactly
 * backwards.
 *
 * The fix was a blanket ABSENT for anything declaring SERVANA:DESTRUCTIVE. That
 * was right while the baseline still carried the 39 stale constraints. It
 * stopped being right on 2026-08-19, when the baseline was recaptured from a
 * production that HAD applied 037: the constraints are gone, the migration is
 * genuinely reflected, and ABSENT became permanently unsatisfiable. The live
 * fresh-database gate failed on every run with "migrations still pending: 1"
 * and no recapture could ever clear it. A gate that cannot be satisfied stops
 * being read.
 *
 * ## The rule now
 *
 * A removal may be marked applied only when it DECLARES what it removed and the
 * baseline bears that out — the removed objects absent, and a declared anchor
 * present so that "absent" cannot be confused with "never existed". Every
 * ambiguity resolves to ABSENT.
 *
 * The guarantee this suite has always protected is unchanged: a removal is
 * never auto-marked on the strength of finding nothing.
 */

import fs from 'fs';
import path from 'path';
import { checkAll } from '../scripts/verify-baseline-ledger';
import { declaresDestructive, provesRemoval, removalAnchors, removalPatterns } from '../scripts/lib/migrationSafety';

const BASELINE = path.resolve(__dirname, '../scripts/baseline/000-baseline.sql');
const MIGRATIONS = path.resolve(__dirname, '../scripts/migrations');
const baselineSql = () => fs.readFileSync(BASELINE, 'utf8');

describe('the baseline no longer carries what 037 removes', () => {
  it('production applied 037, so the dump is free of the stale constraints', () => {
    const stale = baselineSql().match(/(provider|customer)_notifications_notification_key_key\d+/g);
    expect(stale).toBeNull();
  });

  it('the owner-scoped indexes 037 re-asserts ARE in the dump', () => {
    // This is the other half of the proof. Without it, "the constraints are
    // absent" is equally consistent with a database that never had the tables.
    const sql = baselineSql();
    expect(sql).toContain('uq_provider_notifications_owner_key');
    expect(sql).toContain('uq_customer_notifications_owner_key');
  });
});

describe('a removal is marked applied only when it proves itself', () => {
  const checks = checkAll();
  const verdictOf = (file: string) => checks.find((c) => c.file === file)?.verdict;

  it('037 declares both halves of its proof', () => {
    const sql = fs.readFileSync(path.join(MIGRATIONS, '037-notification-key-drop-global-uniques.sql'), 'utf8');
    expect(removalPatterns(sql).length).toBeGreaterThan(0);
    expect(removalAnchors(sql).length).toBeGreaterThan(0);
  });

  it('037 is present, because the baseline bears the declaration out', () => {
    expect(verdictOf('037-notification-key-drop-global-uniques.sql')).toBe('present');
  });

  it('every declared-destructive migration is either proven or ABSENT — never assumed', () => {
    // The rule, not the instance, so a future removal is covered without anyone
    // remembering to add a case here.
    const files = fs
      .readdirSync(MIGRATIONS)
      .filter((f) => /^\d{3}-.+\.sql$/.test(f))
      .filter((f) => declaresDestructive(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8')));

    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const sql = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');
      const proven = provesRemoval(sql, baselineSql()).proven;
      expect(verdictOf(file)).toBe(proven ? 'present' : 'ABSENT');
      // Never "no schema effect" — that is the bucket that skips a migration
      // forever, and a removal must never land in it.
      expect(verdictOf(file)).not.toBe('no-schema-effect');
    }
  });
});

describe('the proof fails closed', () => {
  const sql = () => fs.readFileSync(path.join(MIGRATIONS, '037-notification-key-drop-global-uniques.sql'), 'utf8');

  it('refuses a removal that declares nothing', () => {
    const stripped = sql().replace(/^-- SERVANA:(REMOVES|ANCHOR) .*$/gm, '--');
    const proof = provesRemoval(stripped, baselineSql());
    expect(proof.proven).toBe(false);
    expect(proof.reasons.join(' ')).toMatch(/no SERVANA:REMOVES/);
  });

  it('refuses an absence with no anchor', () => {
    const noAnchor = sql().replace(/^-- SERVANA:ANCHOR .*$/gm, '--');
    const proof = provesRemoval(noAnchor, baselineSql());
    expect(proof.proven).toBe(false);
    expect(proof.reasons.join(' ')).toMatch(/without SERVANA:ANCHOR/);
  });

  it('refuses when the anchor is not in the baseline', () => {
    // replaceAll, not replace: the index name appears twice in a pg_dump — once
    // in the `-- Name:` header and once in the statement — and replacing only
    // the first left the anchor perfectly findable, so the first version of
    // this case passed while proving nothing.
    const proof = provesRemoval(sql(), baselineSql().replaceAll('uq_customer_notifications_owner_key', 'renamed_away'));
    expect(proof.proven).toBe(false);
    expect(proof.reasons.join(' ')).toMatch(/anchor absent/);
  });

  it('refuses when the baseline still carries what is claimed removed', () => {
    const withStale =
      baselineSql() +
      '\nALTER TABLE ONLY servana.provider_notifications\n' +
      '    ADD CONSTRAINT provider_notifications_notification_key_key12 UNIQUE (notification_key);\n';
    const proof = provesRemoval(sql(), withStale);
    expect(proof.proven).toBe(false);
    expect(proof.reasons.join(' ')).toMatch(/still carries/);
  });

  it('refuses an unparseable pattern rather than ignoring it', () => {
    const broken = sql().replace(/^-- SERVANA:REMOVES .*$/m, '-- SERVANA:REMOVES ADD CONSTRAINT (unclosed');
    const proof = provesRemoval(broken, baselineSql());
    expect(proof.proven).toBe(false);
    expect(proof.reasons.join(' ')).toMatch(/unparseable/);
  });

  it('does not read its own documentation as a declaration', () => {
    /**
     * The first parser used indexOf, so the docblock explaining the markers was
     * parsed as declaring them, and 037 failed its own check with an anchor
     * reading "asserts the context EXISTS. Absence alone proves nothing —" — a
     * sentence of prose offered as a schema object. A marker now has to OPEN
     * the comment.
     */
    const prose = [
      '-- The ANCHOR marker asserts the context exists.',
      '-- Mentioning SERVANA:ANCHOR mid-sentence must not declare anything.',
      '-- SERVANA:ANCHOR a_real_declaration',
    ].join('\n');
    expect(removalAnchors(prose)).toEqual(['a_real_declaration']);
  });

  it('scopes the pattern to the two notification tables, not every notification_key', () => {
    // admin_notifications carries a COMPOSITE (admin_uid, notification_key)
    // constraint that 037 deliberately leaves alone. A pattern loose enough to
    // match it would report the removal unproven forever.
    const sqlText = sql();
    const composite =
      'ALTER TABLE ONLY servana.admin_notifications\n' +
      '    ADD CONSTRAINT admin_notifications_admin_uid_notification_key_key UNIQUE (admin_uid, notification_key);';
    expect(provesRemoval(sqlText, baselineSql() + '\n' + composite).proven).toBe(true);
  });
});

describe('the fix did not reclassify anything else', () => {
  const checks = checkAll();

  it('the genuine DML-only migrations are still "no schema effect"', () => {
    /**
     * That bucket exists for the catalog seeds and backfills, which really did
     * run and really cannot be proven from schema. Sweeping them into ABSENT
     * would make `migrations:apply` try to re-run 001–008, which DELETE and
     * re-insert service_options and would issue new option IDs the mobile apps
     * reference.
     */
    const noEffect = checks.filter((c) => c.verdict === 'no-schema-effect');
    expect(noEffect.length).toBe(16);
    expect(noEffect.map((c) => c.file)).toEqual(
      expect.arrayContaining([
        '002-massage-specific-services.sql',
        // 15th, from cf80d9c. `039-electrical-service-coverage.sql` inserts
        // service_coverage_geo rows for legacy family 67 and declares no DDL at
        // all — 0 CREATE/ALTER/DROP, 2 INSERTs — so the classifier puts it in
        // this bucket by its own rule. That commit updated schema-baseline.test
        // for the new migration and did not update this count, which left the
        // gate red on a correct migration.
        //
        // NAMED rather than only counted, so the next DML migration arrives as
        // a reviewable line in the diff instead of a number somebody bumps.
        '039-electrical-service-coverage.sql',
        // 16th. `040-retire-duplicate-massage-subcategory.sql` flips one
        // `catalog_subcategories.status` to 'archived' — 0 CREATE/ALTER/DROP,
        // 1 UPDATE — so it lands here by the same rule.
        //
        // Like 039 it is executed nowhere else: the fresh-database rehearsal
        // seeds this bucket as already applied, so a data migration would
        // otherwise reach production having never run. `npm run
        // migration:040:rehearse` runs it on PGlite.
        '040-retire-duplicate-massage-subcategory.sql',
      ]),
    );
  });

  it('030-036 are present, because the baseline contains them', () => {
    for (const f of ['030', '031', '032', '033', '034', '035', '036']) {
      expect(checks.find((c) => c.file.startsWith(f))!.verdict).toBe('present');
    }
  });

  it('the only ABSENT migration is the one this repository knows is undeployed', () => {
    /**
     * Stated as an exact list so a NEW genuinely-undeployed migration cannot
     * hide in this bucket unnoticed — which is exactly what it just caught.
     *
     * `038-telemetry-events.sql` creates the worker-app telemetry table (TAB
     * 06). It is ABSENT from the captured baseline because it has never been
     * applied: nothing from this programme has been deployed. That is the
     * honest state, and naming it here is the mechanism working rather than
     * being worked around.
     *
     * It comes OFF this list the moment production runs it, and the assertion
     * then goes red until somebody says so.
     */
    expect(checks.filter((c) => c.verdict === 'ABSENT').map((c) => c.file))
      .toEqual(['038-telemetry-events.sql']);
  });

  it('everything the baseline demonstrably has is still "present"', () => {
    // 23 proven by presence + 037 proven by absence.
    expect(checks.filter((c) => c.verdict === 'present').length).toBe(24);
  });
});
