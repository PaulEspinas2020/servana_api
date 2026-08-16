/**
 * Migration numbering is an ordering contract (TAB 02).
 *
 * ## Why duplicate numbers matter
 *
 * `run-migrations.ts` applies files in `readdirSync().sort()` order, so the
 * number is the only thing deciding what runs before what. Two files sharing a
 * number are ordered by their SUFFIX — `020-catalog-v2-expand` before
 * `020-payment-superseded-sessions`, because `c` sorts before `p`. That is an
 * accident of naming standing in for a deliberate decision, and it silently
 * changes if either file is renamed.
 *
 * It is worse than a tidiness problem when the two touch related objects: the
 * pair at 021 is a catalog backfill and an onboarding backfill, and nothing in
 * the filenames says which must land first.
 *
 * ## Why the existing four are kept rather than renumbered
 *
 * They are already applied in production — all four are rows in
 * `servana.schema_migrations` as of 2026-08-16. Renaming a file changes the
 * ledger key, so the runner would see the new name as PENDING and re-run a
 * migration production already has. For `021-catalog-v2-backfill` that means
 * re-running a backfill against live catalog data.
 *
 * So they are registered, with the ordering each pair actually relies on, and
 * a FIFTH duplicate fails the build. The debt is bounded and named instead of
 * being repeated.
 */

import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'scripts', 'migrations');

/**
 * Duplicate numbers that predate this rule, with the order they rely on.
 *
 * Do not add to this. A new migration takes the next free number.
 */
const KNOWN_DUPLICATES: Readonly<Record<string, { files: string[]; why: string }>> =
  Object.freeze({
    '020': {
      files: ['020-catalog-v2-expand.sql', '020-payment-superseded-sessions.sql'],
      why:
        'Independent: one builds the Catalog V2 hierarchy, the other adds a ' +
        'payments column. They touch no common object, so either order is ' +
        'correct and the alphabetical accident is harmless.',
    },
    '021': {
      files: ['021-backfill-submitted-onboarding-cases.sql', '021-catalog-v2-backfill.sql'],
      why:
        'Both are backfills and both are DML. The onboarding one sorts first ' +
        'and neither reads what the other writes — onboarding cases and ' +
        'catalog rows are disjoint. Order is not load-bearing, but it is ' +
        'alphabetical rather than chosen, which is why it is written down.',
    },
  });

const migrationFiles = (): string[] =>
  fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}-.+\.sql$/.test(f)).sort();

const numberOf = (file: string): string => file.slice(0, 3);

describe('migration numbering', () => {
  const files = migrationFiles();

  it('finds the migrations at all (positive fixture)', () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it('every file uses the three-digit prefix the runner sorts on', () => {
    // A file the pattern does not match is not applied at all — it would be
    // skipped in silence rather than failing.
    const all = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
    expect(all.sort()).toEqual(files);
  });

  it('adds no duplicate number beyond the four already applied', () => {
    const byNumber = new Map<string, string[]>();
    for (const file of files) {
      const n = numberOf(file);
      byNumber.set(n, [...(byNumber.get(n) ?? []), file]);
    }

    const duplicates = [...byNumber.entries()].filter(([, group]) => group.length > 1);
    const unregistered = duplicates.filter(([n]) => !(n in KNOWN_DUPLICATES));

    expect(unregistered.map(([n, group]) => `${n}: ${group.join(', ')}`)).toEqual([]);
  });

  it('the registered duplicates still name the files that exist', () => {
    /**
     * If one of a registered pair is renamed or removed, the entry becomes
     * fiction — and the ledger key changes, which is the thing this rule exists
     * to prevent.
     */
    for (const [number, entry] of Object.entries(KNOWN_DUPLICATES)) {
      for (const file of entry.files) {
        expect(files).toContain(file);
        expect(numberOf(file)).toBe(number);
      }
    }
  });

  it('every registered duplicate explains the ordering it relies on', () => {
    for (const entry of Object.values(KNOWN_DUPLICATES)) {
      expect(entry.why.length).toBeGreaterThan(60);
      expect(entry.files.length).toBeGreaterThan(1);
    }
  });

  it('the next migration would take a free number', () => {
    // Guards the practical mistake: reaching for a number already in use.
    const used = new Set(files.map(numberOf));
    const highest = Math.max(...[...used].map(Number));
    expect(used.has(String(highest + 1).padStart(3, '0'))).toBe(false);
  });
});
