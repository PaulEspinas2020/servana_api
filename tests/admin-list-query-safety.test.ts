/**
 * The three query defects this codebase has actually had (TAB 14).
 *
 * ## Why these three and not a general performance suite
 *
 * The book names each of them as a MEASURED defect rather than a hypothetical,
 * and the sharpest is worth stating in full because it is the reason this file
 * exists at all:
 *
 *   > 95 services existed, 55 were reachable, 40 were invisible — and the
 *   > duplicate rows from the same join were being counted into the total.
 *
 * That was an admin "show me everything" list INNER JOINing an optional
 * relation. Nothing looked broken. The page rendered, the count was a number,
 * and 40 rows simply were not there. **That is the failure mode worth a gate:
 * silent, plausible, and invisible to anyone who does not already know the
 * expected row count.**
 *
 * ## What was found when all three were re-audited
 *
 * Nothing. All 31 inner-semantics joins in the admin and catalog services are
 * sound, and the reasons differ in a way worth recording:
 *
 *   - the catalog chain (`services → catalog_subcategories → catalog_categories`)
 *     is safe **structurally**, not by care: both join keys are `NOT NULL` with
 *     foreign keys, so the relation is mandatory and an inner join cannot hide
 *     a row. Catalog V2 made the historical defect unrepresentable.
 *   - the rest are predicates, not spines. `JOIN payments … WHERE status NOT IN
 *     ('PAID','REFUNDED')` sits inside a CTE whose PURPOSE is to select guests
 *     with an outstanding payment, and the outer query `LEFT JOIN`s that CTE —
 *     so a guest with no payment still appears in the total. An inner join is
 *     only a defect on the spine of a "show everything" query.
 *
 * Reporting that honestly matters more than finding something. A gate written
 * to justify itself is worse than no gate.
 */

import fs from 'fs';
import path from 'path';

const SERVICES = path.join(__dirname, '..', 'src', 'services');
const BASELINE = path.join(__dirname, '..', 'scripts', 'baseline', '000-baseline.sql');

const walk = (dir: string): string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? walk(path.join(dir, e.name))
        : e.name.endsWith('.ts')
          ? [path.join(dir, e.name)]
          : [],
    );

/**
 * SQL `JOIN`, not `Array.prototype.join`.
 *
 * The first version of this detector matched `.join(',')` and reported 188
 * inner joins where there are 87 — it counted every string concatenation in the
 * service layer as a database join. Recorded because the book's own evidence
 * base makes the same point about a different matcher: **a number produced by a
 * matcher must be spot-verified against real call sites before it is acted on.**
 * Excluding a preceding dot is what separates the two.
 */
const SQL_JOIN = /(^|[^.\w])\bJOIN\b/i;
const OUTER_JOIN = /\b(LEFT|RIGHT|FULL|CROSS|NATURAL)\s+(OUTER\s+)?JOIN\b/i;
const LOOKS_LIKE_SQL = /\bON\b|\bUSING\b/i;

interface JoinSite {
  file: string;
  line: number;
  text: string;
}

const innerJoins = (): JoinSite[] => {
  const out: JoinSite[] = [];
  for (const abs of walk(SERVICES)) {
    const rel = path.relative(SERVICES, abs).split(path.sep).join('/');
    fs.readFileSync(abs, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (!SQL_JOIN.test(line)) return;
        if (!LOOKS_LIKE_SQL.test(line)) return;
        if (OUTER_JOIN.test(line)) return;
        out.push({ file: rel, line: i + 1, text: line.trim() });
      });
  }
  return out;
};

const adminJoins = () => innerJoins().filter((j) => /^(admin|catalog)/i.test(j.file));

describe('the detector is right before its number is used (positive control)', () => {
  it('does not count Array.prototype.join as a SQL join', () => {
    const jsJoin = "  const where = conditions.join(' AND ');";
    expect(SQL_JOIN.test(jsJoin) && LOOKS_LIKE_SQL.test(jsJoin)).toBe(false);
  });

  it('does count a real inner join', () => {
    const sql = 'JOIN servana.catalog_subcategories sc ON sc.id = s.subcategory_id';
    expect(SQL_JOIN.test(sql) && LOOKS_LIKE_SQL.test(sql) && !OUTER_JOIN.test(sql)).toBe(true);
  });

  it('does not count a LEFT JOIN, which cannot hide a row', () => {
    const sql = 'LEFT JOIN servana.payments p ON p.booking_id = b.id';
    expect(OUTER_JOIN.test(sql)).toBe(true);
  });

  it('finds joins in the real service layer', () => {
    expect(adminJoins().length).toBeGreaterThan(20);
  });
});

describe('the catalog chain cannot hide a service, structurally', () => {
  const baseline = fs.readFileSync(BASELINE, 'utf8');

  /**
   * This is the guarantee that makes the historical defect unrepresentable.
   * If either column ever becomes nullable, every inner join along the chain
   * silently starts hiding rows again — and the page that hides them is the one
   * whose purpose is to show all of them.
   */
  it('services.subcategory_id is NOT NULL', () => {
    const table = baseline.slice(baseline.indexOf('CREATE TABLE servana.services '));
    const decl = table.slice(0, table.indexOf(');'));
    expect(decl).toMatch(/subcategory_id\s+integer\s+NOT NULL/i);
  });

  it('catalog_subcategories.category_id is NOT NULL', () => {
    const table = baseline.slice(baseline.indexOf('CREATE TABLE servana.catalog_subcategories'));
    const decl = table.slice(0, table.indexOf(');'));
    expect(decl).toMatch(/category_id\s+integer\s+NOT NULL/i);
  });
});

describe('a new inner join in an admin list service has to be looked at', () => {
  /**
   * A declared count, in the same spirit as `EXPECTED_SUITE_COUNT` and the
   * scheduled-job registry.
   *
   * There is no static check that can tell a safe inner join from an unsafe one
   * — it depends on whether the relation is optional and whether the join is on
   * the query's spine, and both are judgement. What a gate CAN do is refuse to
   * let a new one arrive unnoticed.
   *
   * **When this fails:** read the new join and answer one question — *can the
   * row on the left exist without a match on the right?* If yes, and this is a
   * list, it must be a LEFT JOIN. If no, raise the number in the same commit.
   * A DROP is worth a moment too: it may mean a list quietly became narrower.
   *
   * All 31 at the time of writing were audited individually and are recorded in
   * `docs/audits/TAB14_QUERY_SAFETY.md`.
   *
   * **31 -> 34 on 2026-08-20.** Three joins were added to
   * `getPublicCatalogSummary`, which had been counting each level by its own
   * status while `getPublicCatalog` filters through both ancestors — so the
   * summary reported 95 services beside a tree of 85 the moment a subcategory
   * was archived. The counts now use the tree's rule, which needs the joins.
   *
   * Audited by the question this gate asks. Can the left row exist without a
   * match on the right? No, and the describe block directly above proves it
   * rather than asserting it: `services.subcategory_id` and
   * `catalog_subcategories.category_id` are both NOT NULL in the baseline. An
   * inner join along that chain cannot hide a row, which is the same guarantee
   * that makes the tree's own joins safe.
   */
  const REVIEWED_ADMIN_INNER_JOINS = 34;

  it(`has exactly ${REVIEWED_ADMIN_INNER_JOINS} reviewed inner joins`, () => {
    const found = adminJoins();
    expect({
      count: found.length,
      sites: found.map((j) => `${j.file}:${j.line}`),
    }).toMatchObject({ count: REVIEWED_ADMIN_INNER_JOINS });
  });
});

describe('the other two defect classes are absent, and stay absent', () => {
  const allSource = walk(SERVICES)
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n');

  it('no array filtering that would compute a cross product', () => {
    /**
     * The defect is `unnest(a), unnest(b)` in a FROM clause, which produces the
     * cross product of the two arrays rather than pairing them element-wise.
     * The correct form pairs them — `unnest(a, b)` or `WITH ORDINALITY`.
     *
     * There is no `unnest` anywhere in the service layer today, so the class
     * cannot occur. This fails the day one appears, which is the right moment
     * to check which form it is.
     */
    expect(allSource).not.toMatch(/\bunnest\s*\(/i);
  });

  it('the admin booking list counts what it filters, not what it paginates', () => {
    const svc = fs.readFileSync(path.join(SERVICES, 'adminBookingService.ts'), 'utf8');
    // The count wraps the SAME base query and the LIMIT lives only on the data
    // query. Counting the paginated rows is how meta.total ends up equal to the
    // page size, and counting a DIFFERENT query is how it ends up plausible and
    // wrong.
    expect(svc).toMatch(/SELECT COUNT\(\*\) AS total FROM \(\$\{baseSQL\}\) AS sub/);
    expect(svc).toMatch(/\$\{baseSQL\}\s*ORDER BY[^`]*LIMIT/);
  });
});
