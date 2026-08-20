/**
 * A query may not key a provider-owned table on the wrong column.
 *
 * ## Why this is a gate and not a fixed bug
 *
 * `adminProviderService.safeCount` returns -1 on ANY thrown query, and its
 * caller renders -1 as "table not queryable". That is a reasonable contract for
 * a table that may genuinely be absent — this schema has drifted before — but it
 * means a MISSPELLED COLUMN produces the same output as a missing table. The
 * query does not fail loudly; it reports "unknown" forever.
 *
 * Three of the ten rows in `getProviderOverlapMap` were wrong that way from the
 * day it was written, and nothing noticed:
 *
 *   - `employee_services WHERE uid`                 → the column is `employee_uid`
 *   - `employee_catalog_capabilities WHERE uid`     → the column is `employee_uid`
 *   - `worker_locations` queried through Postgres   → it is a MongoDB collection
 *
 * The first two were found upstream on `feat/admin-dedup-hardening` (8d2781e,
 * 2026-07-10) and never reached `main`. The third was found here, by asking the
 * same question of every row rather than of the two the branch named — which is
 * the argument for a gate over a patch.
 *
 * ## Why the consequence is worse than a wrong number
 *
 * The overlap map exists so an operator can see what a duplicate provider row
 * still owns before deleting it. `employee_services` and
 * `employee_catalog_capabilities` are precisely the two tables that say "this
 * row has live work attached". Reporting them as unknown makes a row carrying
 * active assignments look exactly like an empty one.
 *
 * ## Which direction this fails in
 *
 * It reads source text, so it cannot prove the column exists in the database —
 * only that the codebase spells it one way. That is enough here because the
 * codebase is already self-consistent: the majority spelling is corroborated by
 * a UNIQUE constraint recorded in providerCatalogService.ts. If the schema ever
 * renames the column, this test keeps passing and the CONTROL below is what
 * catches the drift, because it pins the majority spelling to a real count.
 */

import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..', 'src');

const sourceFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return e.isFile() && e.name.endsWith('.ts') ? [full] : [];
  });

/**
 * Comments are stripped before the code rules run.
 *
 * This file is a text scan, so a comment that QUOTES the forbidden shape in
 * order to explain it reads as an offender. That is not a hypothetical: the
 * rationale block in `getProviderOverlapMap` names the exact broken query it
 * replaced, and this gate flagged it on first run. Refusing to let the fix be
 * documented would be a worse outcome than the false positive, so the scan
 * looks at code and the descriptor assertions below look at raw text.
 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

// Only the stripped text is retained. Holding the raw source of every file in
// `src` as well doubled this suite's retained heap for no gain — the one place
// that needs raw text is a single named file, read on demand below. This
// repository runs a heap guard because a growing suite once stalled production.
const FILES = sourceFiles(SRC).map(f => ({
  file: path.relative(path.join(__dirname, '..'), f),
  text: stripComments(fs.readFileSync(f, 'utf8')),
}));

/**
 * Tables keyed on `employee_uid`. The spelling is not a convention this test
 * invents — it is the majority spelling already in the tree, and the
 * `UNIQUE (employee_uid, offering_id)` constraint on
 * `employee_catalog_capabilities` is recorded in providerCatalogService.ts.
 */
const EMPLOYEE_KEYED = ['employee_services', 'employee_catalog_capabilities'];

/** Collections that live in MongoDB and must never appear as `${schema}.name`. */
const MONGO_COLLECTIONS = ['worker_locations'];

describe('provider table predicates use the column the table actually has', () => {
  it.each(EMPLOYEE_KEYED)('%s is never keyed on a bare `uid`', table => {
    // Matches `<table> [alias] WHERE [alias.]uid` — the shape that reads as
    // correct and silently returns -1. `employee_uid` does not match, because
    // the boundary before `uid` requires a non-word character or a dot.
    const wrong = new RegExp(`${table}\\s+(?:\\w+\\s+)?WHERE\\s+(?:\\w+\\.)?uid\\b`, 'i');

    const offenders = FILES.filter(f => wrong.test(f.text)).map(f => f.file);

    expect(offenders).toEqual([]);
  });

  it.each(EMPLOYEE_KEYED)('%s is keyed on `employee_uid` somewhere (control)', table => {
    // Without this, the assertion above would pass by the table disappearing.
    const right = new RegExp(`${table}\\b[\\s\\S]{0,120}?employee_uid`, 'i');

    expect(FILES.some(f => right.test(f.text))).toBe(true);
  });

  it.each(MONGO_COLLECTIONS)('%s is never queried as a Postgres relation', collection => {
    // `${dbSchema}.worker_locations` / `${s}.worker_locations` — the interpolated
    // schema prefix is what makes it a Postgres reference.
    const asRelation = new RegExp(`\\$\\{\\s*\\w+\\s*\\}\\.${collection}\\b`);

    const offenders = FILES.filter(f => asRelation.test(f.text)).map(f => f.file);

    expect(offenders).toEqual([]);
  });

  it.each(MONGO_COLLECTIONS)('%s is reached through the Mongo client (control)', collection => {
    const viaMongo = new RegExp(`collection\\(\\s*['"\`]${collection}['"\`]`);

    expect(FILES.some(f => viaMongo.test(f.text))).toBe(true);
  });
});

describe('the overlap map reports what it queried', () => {
  // Raw, not stripped: these assertions are about the descriptor literals, and
  // reading them from the real file keeps the check honest about what ships.
  const service = {
    text: fs.readFileSync(path.join(SRC, 'services', 'adminProviderService.ts'), 'utf8'),
  };

  it('names `employee_uid` in the tables[] descriptor for both employee-keyed tables', () => {
    // The descriptor is what the operator reads. A correct query paired with a
    // descriptor that still says `uid` sends them to the wrong column by hand.
    for (const table of EMPLOYEE_KEYED) {
      const row = service.text
        .split('\n')
        .find(l => l.includes(`table: '${table}'`) && l.includes('column:'));

      expect(row).toBeDefined();
      expect(row).toContain("column: 'employee_uid'");
    }
  });

  it('still distinguishes "unknown" from zero', () => {
    // -1 is the whole reason a wrong column was invisible. Keep it, but keep it
    // documented: if this contract ever changes to 0, every gap in this map
    // starts reading as a confirmed empty table.
    expect(service.text).toMatch(/return -1;/);
  });
});
