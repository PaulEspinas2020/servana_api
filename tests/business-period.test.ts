/**
 * "This month" means the Manila month, everywhere.
 *
 * ## The defect
 *
 * `src/db/dbQuery.ts` pins the pg session to `timezone=UTC`, deliberately, so
 * that timestamps parse identically on every machine. That pinning is right and
 * is not what changed here.
 *
 * Its consequence is that a bare `DATE_TRUNC('month', ts)` truncates to a **UTC**
 * month. Servana operates in Asia/Manila, UTC+8, so the first eight hours of
 * every Manila month fall in the previous UTC one.
 *
 * Five services computed a period boundary and they did not agree:
 *
 *     Manila-bounded, correct    adminDashboardService   6 sites
 *                                adminFinanceService     2 sites
 *
 *     UTC-bounded, wrong         adminProviderService    thisMonthGross
 *                                technicianService       monthly earnings label
 *
 * So two admin screens reported "this month" over different months, and a
 * provider's monthly earnings breakdown filed a job completed at 03:00 on the
 * first into the month before — money in the wrong row, on the screen a provider
 * checks to see whether they were paid correctly.
 *
 * ## Why the fix is a shared fragment
 *
 * Because the five sites were already five careful edits and three of them
 * happened to be right. A rule that must be remembered at every call site will
 * be half-applied again the next time somebody adds a dashboard tile.
 *
 * ## Why the two helpers are not interchangeable
 *
 * `AT TIME ZONE` does different things to the two timestamp types, and getting
 * it wrong is invisible: the result is a plausible timestamp that is eight hours
 * out. Every case below was measured against PGlite rather than reasoned about.
 */

import fs from 'fs';
import path from 'path';
import {
  BUSINESS_TIMEZONE,
  inBusinessZone,
  inBusinessZoneFromNaiveUtc,
  businessNow,
  businessPeriodStart,
  businessMonthLabel,
  businessMonthOf,
} from '../src/services/sql/businessPeriod';

describe('the business timezone is named once', () => {
  it('is an IANA name, not an offset', () => {
    // An offset hard-coded as +08 would be a silent lie if the zone ever
    // changed. Postgres resolves the name against its own tz database.
    expect(BUSINESS_TIMEZONE).toBe('Asia/Manila');
    expect(BUSINESS_TIMEZONE).not.toMatch(/^[+-]/);
  });

  it('builds the fragments from that one constant', () => {
    expect(inBusinessZone('x')).toContain(BUSINESS_TIMEZONE);
    expect(inBusinessZoneFromNaiveUtc('x')).toContain(BUSINESS_TIMEZONE);
    expect(businessNow()).toContain(BUSINESS_TIMEZONE);
    expect(businessPeriodStart('month')).toContain(BUSINESS_TIMEZONE);
  });

  it('converts a NAIVE column twice and a zoned one once', () => {
    // The single most important difference in this file. A naive column has to
    // be told what it MEANS before it can be moved.
    expect(inBusinessZoneFromNaiveUtc('c')).toBe(`(c AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Manila')`);
    expect(inBusinessZone('c')).toBe(`(c AT TIME ZONE 'Asia/Manila')`);
  });
});

describe('no service computes a period boundary without the zone', () => {
  const SRC = path.join(__dirname, '..', 'src', 'services');

  const tsFiles = (dir: string, acc: string[] = []): string[] => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) tsFiles(full, acc);
      else if (entry.name.endsWith('.ts')) acc.push(full);
    }
    return acc;
  };

  it('finds DATE_TRUNC in the services, so the sweep is not vacuous', () => {
    const hits = tsFiles(SRC).filter((f) => /DATE_TRUNC/.test(fs.readFileSync(f, 'utf8')));
    expect(hits.length).toBeGreaterThan(0);
  });

  it('never truncates a period without naming a timezone on the same line', () => {
    /**
     * Line-scoped on purpose: a `DATE_TRUNC('month', x)` that carries no zone
     * anywhere near it is the exact shape of the two defects this fixed.
     *
     * `businessPeriod.ts` itself is excluded — it is where the zone is named,
     * and its own fragments are built from the constant.
     */
    const offenders: string[] = [];
    for (const file of tsFiles(SRC)) {
      if (file.endsWith(path.join('sql', 'businessPeriod.ts'))) continue;
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (!/DATE_TRUNC\(\s*'(day|week|month)'/.test(line)) return;
        if (/AT TIME ZONE|businessNow|businessPeriodStart|businessMonthOf/.test(line)) return;
        offenders.push(`${path.relative(SRC, file).replace(/\\/g, '/')}:${i + 1}  ${line.trim()}`);
      });
    }
    // Named, not counted: whoever trips this needs the line.
    expect(offenders).toEqual([]);
  });
});
