/**
 * A removal migration must never be auto-marked as already applied.
 *
 * `verify-baseline-ledger` decides whether a migration can be marked applied by
 * asking whether the objects it CREATES are present in the baseline. A migration
 * that only DROPS creates nothing, so the list of expected objects is empty —
 * and the old code read that as "no schema effect, it must have run".
 *
 * For 037 that is exactly backwards. The baseline is production's dump, and it
 * carries all 39 stale `notification_key` constraints 037 exists to remove. So a
 * fresh database would keep them AND skip the migration, permanently, with the
 * fresh-DB gate reporting PASS.
 *
 * This is the same defect the comment in `ledgerAtBaselineSql` describes for
 * 030–035, arriving from the other direction: there, present-but-unapplied;
 * here, absent-effect mistaken for no-effect.
 */

import fs from 'fs';
import path from 'path';
import { checkAll } from '../scripts/verify-baseline-ledger';
import { declaresDestructive } from '../scripts/lib/migrationSafety';

const BASELINE = path.resolve(__dirname, '../scripts/baseline/000-baseline.sql');
const MIGRATIONS = path.resolve(__dirname, '../scripts/migrations');

describe('the baseline genuinely still carries what 037 removes', () => {
  it('production has now applied 037, so the dump no longer carries them', () => {
    /**
     * The premise FLIPPED, and this suite was written to notice.
     *
     * It used to assert the stale constraints were still in the dump, with the
     * note: "If production had already lost these, 037 would be a no-op and
     * marking it applied would be harmless — so assert the premise rather than
     * assume it." Production applied 037 on 2026-08-18, and the 2026-08-19
     * recapture picked that up, so the constraints are gone.
     *
     * The guarantee this suite exists for is unchanged and still enforced
     * below: 037 stays ABSENT rather than being auto-marked. That is now the
     * conservative reading rather than the load-bearing one — re-running a
     * DROP ... IF EXISTS on a fresh database is a no-op — and conservative is
     * the correct direction for a removal that cannot be proven either way.
     */
    const baseline = fs.readFileSync(BASELINE, 'utf8');
    const stale = baseline.match(
      /(provider|customer)_notifications_notification_key_key\d+/g,
    );
    expect(stale).toBeNull();
  });
});

describe('a destructive migration is never marked applied at baseline', () => {
  const checks = checkAll();
  const verdictOf = (file: string) => checks.find((c) => c.file === file)?.verdict;

  it('037 is ABSENT, not "no schema effect"', () => {
    expect(verdictOf('037-notification-key-drop-global-uniques.sql')).toBe('ABSENT');
  });

  it('every declared-destructive migration is ABSENT', () => {
    // The rule, not the instance — so a future removal migration is covered by
    // the same guarantee without anyone remembering to add a case here.
    const files = fs
      .readdirSync(MIGRATIONS)
      .filter((f) => /^\d{3}-.+\.sql$/.test(f))
      .filter((f) => declaresDestructive(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8')));

    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(verdictOf(file)).toBe('ABSENT');
    }
  });

  it('says WHY it cannot be proven, rather than reporting a phantom object', () => {
    const check = checks.find((c) => c.file === '037-notification-key-drop-global-uniques.sql')!;
    expect(check.missing.join(' ')).toMatch(/removal/i);
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
    expect(noEffect.length).toBe(14);
    // The catalog seeds are the reason the bucket exists.
    expect(noEffect.map((c) => c.file)).toEqual(
      expect.arrayContaining(['002-massage-specific-services.sql']),
    );
  });

  it('030-036 are now present, because the baseline finally contains them', () => {
    /**
     * These were ABSENT until 2026-08-19 for a plain reason: the baseline was
     * captured 2026-08-16 and they were applied to production after it. The
     * recapture reflects them, so the evidence-based checker sees their objects
     * and reports present. Nothing about the checker changed.
     */
    for (const f of ['030', '031', '032', '033', '034', '035', '036']) {
      const check = checks.find((c) => c.file.startsWith(f))!;
      expect(check.verdict).toBe('present');
    }
  });

  it('037 is the only migration left ABSENT', () => {
    // A removal cannot be proven from a dump, so it stays ABSENT by design.
    // Stated as "only" so that a NEW absent migration — a genuinely undeployed
    // one — cannot hide inside this bucket unnoticed.
    const absent = checks.filter((c) => c.verdict === 'ABSENT').map((c) => c.file);
    expect(absent).toEqual(['037-notification-key-drop-global-uniques.sql']);
  });

  it('everything the baseline demonstrably has is still "present"', () => {
    expect(checks.filter((c) => c.verdict === 'present').length).toBe(23);
  });
});
