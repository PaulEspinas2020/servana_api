/**
 * Gate: a real PostgreSQL agrees that "this month" means the MANILA month.
 *
 *   npm run period:business
 *
 * ## Why this is not a jest test
 *
 * PGlite loads its WASM through a dynamic import, which needs
 * `--experimental-vm-modules` inside jest's VM context.
 * `verify-refund-segregation.ts`, `verify-fresh-db.ts` and
 * `verify-schema-code-skew.ts` are scripts for the same reason, and turning
 * that flag on for a 250-suite run to accommodate one check is a worse trade
 * than running the check where it already works.
 *
 * `tests/business-period.test.ts` keeps everything provable WITHOUT a database:
 * that the fragments are built from one constant, and that no service truncates
 * a period without naming a zone. What it cannot prove is that Postgres agrees,
 * and the whole defect was a disagreement about what Postgres does.
 *
 * ## The defect
 *
 * `src/db/dbQuery.ts` pins the session to `timezone=UTC` — deliberately, so
 * timestamps parse identically everywhere. The consequence is that a bare
 * `DATE_TRUNC('month', ts)` truncates to a UTC month, and Manila is UTC+8, so
 * the first eight hours of every Manila month fall in the previous UTC one.
 *
 * Five services computed a boundary and three happened to be right:
 *
 *   Manila-bounded    adminDashboardService (6), adminFinanceService (2)
 *   UTC-bounded       adminProviderService.thisMonthGross
 *                     technicianService monthly earnings label
 *
 * So two admin screens reported "this month" over different months, and a
 * provider's monthly earnings breakdown filed a job completed at 03:00 on the
 * first into the month before — money in the wrong row, on the screen a
 * provider checks to see whether they were paid correctly.
 *
 * ## What this executes
 *
 * The exported fragments themselves, not copies of them, against real
 * PostgreSQL compiled to WebAssembly, with the session pinned to UTC exactly as
 * production is — because the defect only exists under that setting.
 */

import { PGlite } from '@electric-sql/pglite';
import {
  BUSINESS_TIMEZONE,
  businessMonthLabel,
  businessMonthOf,
  businessNow,
  inCurrentBusinessPeriod,
} from '../src/services/sql/businessPeriod';

/**
 * The instant the whole defect turns on.
 *
 * 2026-08-31 19:00 UTC is 2026-09-01 03:00 in Manila. A month boundary sits
 * between the two readings, which is the only kind of instant that can tell a
 * correct implementation from one that merely agrees with the server's zone.
 */
const BOUNDARY_UTC = '2026-08-31 19:00:00';

interface Check { name: string; ok: boolean; detail?: string }

const main = async (): Promise<number> => {
  console.log('\n[business-period] real PostgreSQL, session pinned to UTC as production is\n');

  const db = await new PGlite();
  const checks: Check[] = [];

  const expect = (name: string, actual: unknown, wanted: unknown): void => {
    const ok = String(actual) === String(wanted);
    checks.push({ ok, name, detail: ok ? undefined : `expected ${wanted}, got ${actual}` });
  };

  try {
    await db.exec(`
      SET TIME ZONE 'UTC';
      CREATE TABLE t (naive timestamp, tz timestamptz);
      INSERT INTO t VALUES ('${BOUNDARY_UTC}', '${BOUNDARY_UTC}+00');
    `);

    const one = async (expr: string): Promise<string> => {
      const r = await db.query<{ v: unknown }>(`SELECT ${expr} AS v FROM t`);
      return String(r.rows[0].v);
    };

    // ── The fix, on both column types ────────────────────────────────────────
    expect(
      'a zoned column is labelled with the MANILA month',
      await one(businessMonthLabel('tz')),
      '2026-09',
    );
    expect(
      'a NAIVE column is labelled with the MANILA month',
      await one(businessMonthLabel('naive', true)),
      '2026-09',
    );

    // ── The negative controls, on the same row ───────────────────────────────
    // Without these, every assertion above passes just as well against data
    // that never crosses a boundary — and crossing one is the entire defect.
    expect(
      'the OLD zoned expression still yields the previous month',
      await one(`TO_CHAR(DATE_TRUNC('month', tz), 'YYYY-MM')`),
      '2026-08',
    );
    expect(
      'the OLD naive expression still yields the previous month',
      await one(`TO_CHAR(DATE_TRUNC('month', naive), 'YYYY-MM')`),
      '2026-08',
    );
    expect(
      'converting a naive column ONCE is still wrong — the plausible half-fix',
      await one(`TO_CHAR(DATE_TRUNC('month', naive AT TIME ZONE '${BUSINESS_TIMEZONE}'), 'YYYY-MM')`),
      '2026-08',
    );

    // ── Grouping and labelling must use the SAME expression ──────────────────
    // If they disagree, rows aggregate into one month and print as another,
    // which is worse than either being wrong on its own.
    const grouped = await db.query<{ m: string; g: string }>(`
      SELECT ${businessMonthLabel('naive', true)} AS m,
             ${businessMonthOf('naive', true)}::text AS g
        FROM t
       GROUP BY ${businessMonthOf('naive', true)}
    `);
    expect('grouping produces exactly one bucket', grouped.rows.length, 1);
    expect('the label and the bucket agree', grouped.rows[0]?.m, '2026-09');
    expect(
      'the bucket is the September one',
      String(grouped.rows[0]?.g).slice(0, 7),
      '2026-09',
    );

    // ── inCurrentBusinessPeriod converts BOTH sides ──────────────────────────
    // Converting only NOW() and leaving the column in UTC moves the boundary
    // rather than fixing it. Pinning "now" makes this deterministic.
    const pinnedNow = `(TIMESTAMPTZ '2026-09-15 00:00:00+00' AT TIME ZONE '${BUSINESS_TIMEZONE}')`;
    const inPeriod = inCurrentBusinessPeriod('tz', 'month').split(businessNow()).join(pinnedNow);
    const r = await db.query<{ v: boolean }>(`SELECT ${inPeriod} AS v FROM t`);
    expect('the boundary instant counts as THIS Manila month', r.rows[0]?.v, true);

    // And that it is not simply true for everything.
    const pinnedOct = `(TIMESTAMPTZ '2026-10-15 00:00:00+00' AT TIME ZONE '${BUSINESS_TIMEZONE}')`;
    const outPeriod = inCurrentBusinessPeriod('tz', 'month').split(businessNow()).join(pinnedOct);
    const r2 = await db.query<{ v: boolean }>(`SELECT ${outPeriod} AS v FROM t`);
    expect('and NOT as the following month', r2.rows[0]?.v, false);
  } finally {
    await db.close();
  }

  for (const c of checks) {
    console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : ` — ${c.detail}`}`);
  }

  const failed = checks.filter((c) => !c.ok);
  console.log('');
  if (failed.length === 0) {
    console.log('[business-period] OK.');
    return 0;
  }
  console.error(`[business-period] ${failed.length} check(s) failed.`);
  return 1;
};

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('[business-period] threw:', error);
    process.exit(1);
  });
