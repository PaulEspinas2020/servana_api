/**
 * The synthetic-booking marker, and the seven properties it has to hold.
 *
 * A release smoke has to run the real lifecycle against production, because
 * that is the only place TAB 04's locking, assignment persistence, timelines
 * and compatibility projections can actually be proven. The cost is a booking
 * that was never real demand — and production carries 109 bookings and has
 * never recorded a completion, so an unmarked smoke would create the platform's
 * FIRST completion.
 *
 * This suite is what makes that safe to do.
 */

import fs from 'fs';
import path from 'path';

import {
  excludeSyntheticSql,
  andExcludeSynthetic,
  REPORTING_SURFACES,
  OPERATIONAL_SURFACES,
  SyntheticFinancialRefusal,
} from '../src/services/booking/syntheticBookings';

const SRC = path.join(__dirname, '..', 'src');

/** Source with comments stripped — a rule mentioned in prose is not enforced. */
const codeOf = (relative: string): string => fs
  .readFileSync(path.join(SRC, relative), 'utf8')
  .replace(/\r\n/g, '\n')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((l) => !l.trim().startsWith('//'))
  .join('\n');

const migration = (): string => fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'migrations', '028-booking-synthetic-marker.sql'),
  'utf8',
).replace(/\r\n/g, '\n');

// ─── The column ───────────────────────────────────────────────────────────────

describe('the marker is explicit, defaulted and server-owned', () => {
  it('is a real column, NOT NULL with a false default', () => {
    // Defaulted false means every existing row is real BY CONSTRUCTION rather
    // than by a backfill somebody has to remember to run.
    const sql = migration();
    expect(sql).toContain('ALTER TABLE servana.bookings');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS is_synthetic BOOLEAN NOT NULL DEFAULT false');
  });

  it('carries no BEGIN/COMMIT of its own', () => {
    // The runner wraps each migration; an inner COMMIT ends that transaction
    // early and defeats the plan step — on production.
    const sql = migration().toUpperCase();
    expect(sql).not.toMatch(/^\s*BEGIN\s*;/m);
    expect(sql).not.toMatch(/^\s*COMMIT\s*;/m);
  });

  it('indexes only the rare TRUE rows', () => {
    // `is_synthetic = false` matches virtually every row, so an index on the
    // common case would never be chosen. The lookup that needs help is "find
    // the smoke bookings", for audit.
    expect(migration()).toContain('WHERE is_synthetic = true');
  });

  it('is NEVER read from a request body', () => {
    /**
     * The marker is server-controlled. If any controller or service read it
     * from a payload, a normal customer or provider client could mark their own
     * booking synthetic and vanish from every business metric — which is fraud
     * with a boolean.
     */
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.ts')) continue;
        const rel = path.relative(SRC, full).split(path.sep).join('/');
        const code = codeOf(rel);
        // Any route from a request into the marker, however spelled.
        if (/req\.body[^;]*is_?[Ss]ynthetic/.test(code)
          || /is_?[Ss]ynthetic[^;]*req\.body/.test(code)
          || /body\.isSynthetic/.test(code)
          || /body\.is_synthetic/.test(code)) {
          offenders.push(rel);
        }
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });

  it('the body-read detector actually detects', () => {
    // Negative fixture. A guard that has never seen a positive case could be
    // matching nothing at all.
    const fixture = 'const flag = req.body.is_synthetic;';
    expect(/req\.body[^;]*is_?[Ss]ynthetic/.test(fixture)).toBe(true);
    expect(/req\.body[^;]*is_?[Ss]ynthetic/.test('const x = req.body.status;')).toBe(false);
  });
});

// ─── The exclusion policy ─────────────────────────────────────────────────────

describe('the exclusion policy is central, not scattered', () => {
  it('emits the predicate for a given alias', () => {
    expect(excludeSyntheticSql('b')).toBe('b.is_synthetic = false');
    expect(andExcludeSynthetic('bk')).toBe(' AND bk.is_synthetic = false');
  });

  it('every booking query over reporting or operational data is CLASSIFIED', () => {
    /**
     * The point of the inventory. A new reporting query that silently includes
     * synthetic rows fails invisibly — a KPI that is slightly wrong looks
     * exactly like one that is right — so adding a query without classifying it
     * has to fail here instead.
     *
     * Reviewed inventory rather than heuristic: a query cannot be judged
     * reporting-or-operational by its shape, only by what its number is used
     * for.
     */
    const classified = { ...REPORTING_SURFACES, ...OPERATIONAL_SURFACES };
    expect(Object.keys(classified).length).toBeGreaterThanOrEqual(7);

    // Every entry states WHY, because "it is in the list" is not a reason.
    for (const [surface, reason] of Object.entries(classified)) {
      expect(surface).toMatch(/^[a-zA-Z]+#[a-zA-Z]+$/);
      expect(reason.length).toBeGreaterThan(40);
    }
  });

  it('reporting and operational are disjoint', () => {
    // A surface that appeared in both would mean the policy is undecided about
    // it, and whichever branch was read first would win.
    const overlap = Object.keys(REPORTING_SURFACES)
      .filter((k) => k in OPERATIONAL_SURFACES);
    expect(overlap).toEqual([]);
  });

  it('every REPORTING surface file actually applies the filter', () => {
    // The list is a promise; this is the check that it was kept.
    const files: Record<string, string> = {
      'adminDashboardService#bookingAggregations': 'services/adminDashboardService.ts',
      'adminFinanceService#revenue': 'services/adminFinanceService.ts',
      'providerPerformanceService#providerStats': 'services/providerPerformanceService.ts',
      'providerSupplyHealthService#demand': 'services/providerSupplyHealthService.ts',
    };
    expect(Object.keys(files).sort()).toEqual(Object.keys(REPORTING_SURFACES).sort());

    for (const [surface, file] of Object.entries(files)) {
      const code = codeOf(file);
      const applies = code.includes('excludeSyntheticSql')
        || code.includes('is_synthetic, false) = false');
      expect(applies).toBe(true);
      expect(surface).toBeTruthy();
    }
  });

  it('OPERATIONAL surfaces deliberately do NOT filter', () => {
    /**
     * An admin must be able to find the smoke booking and watch it move. A
     * smoke you cannot observe is not a smoke, and hiding the row would also
     * make the tab counts disagree with the list beneath them.
     */
    const code = codeOf('services/adminBookingService.ts');
    expect(code).not.toContain('excludeSyntheticSql');
    expect(code).not.toContain('is_synthetic = false');
  });
});

// ─── Lifecycle semantics are UNCHANGED ────────────────────────────────────────

describe('the marker changes accounting, never lifecycle', () => {
  it('the canonical executor never reads it', () => {
    /**
     * The principle, enforced. A separate "test transition" path would exercise
     * code that never runs in anger, and the smoke would prove nothing about
     * the executor that actually ships.
     */
    const executor = codeOf('services/booking/transitionExecutor.ts');
    expect(executor).not.toContain('is_synthetic');
    expect(executor).not.toContain('isSynthetic');
  });

  it('the canonical state derivation never reads it', () => {
    const canonical = codeOf('services/booking/canonicalState.ts');
    expect(canonical).not.toContain('synthetic');
  });

  it('the state SQL generators never read it', () => {
    // Display and filtering must treat a synthetic booking exactly like a real
    // one, or the smoke stops testing the board.
    const generator = codeOf('services/booking/adminOpsStatusSql.ts');
    expect(generator).not.toContain('synthetic');
  });

  it('no projection branches on it', () => {
    const projections = codeOf('services/booking/projections.ts');
    expect(projections).not.toContain('synthetic');
  });
});

// ─── Money ────────────────────────────────────────────────────────────────────

describe('a synthetic booking cannot move real money', () => {
  it('createDisbursement refuses, loudly', () => {
    const code = codeOf('services/disbursement.service.ts');
    expect(code).toContain('SyntheticFinancialRefusal');
    expect(code).toContain('is_synthetic === true');
  });

  it('the refusal THROWS rather than returning null', () => {
    /**
     * The neighbouring guards — no provider, no price — return null because
     * they are ordinary business conditions. This one means a synthetic booking
     * reached a money path, which is a release-safety failure and must not look
     * like a routine skip in a log.
     */
    const code = codeOf('services/disbursement.service.ts');
    const idx = code.indexOf('is_synthetic === true');
    expect(idx).toBeGreaterThan(-1);
    const branch = code.slice(idx, idx + 160);
    expect(branch).toContain('throw new SyntheticFinancialRefusal');
    expect(branch).not.toContain('return null');
  });

  it('refuses BEFORE any PayMongo call', () => {
    // Ordering is the property. A check after the request has been sent
    // prevents nothing.
    const code = codeOf('services/disbursement.service.ts');
    expect(code.indexOf('is_synthetic === true'))
      .toBeLessThan(code.indexOf('axios.post'));
  });

  it('the error names the booking and carries a stable code', () => {
    const error = new SyntheticFinancialRefusal(4242);
    expect(error.code).toBe('SYNTHETIC_BOOKING_NO_MONEY_MOVEMENT');
    expect(error.message).toContain('4242');
    expect(error.name).toBe('SyntheticFinancialRefusal');
    expect(error).toBeInstanceOf(Error);
  });

  it('the guard is NARROW — one financial check, not a test mode', () => {
    /**
     * A broad financial bypass would be a larger risk than the one it prevents.
     * Exactly one service may consult the marker for money purposes.
     */
    const consumers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.ts')) continue;
        const rel = path.relative(SRC, full).split(path.sep).join('/');
        if (rel === 'services/booking/syntheticBookings.ts') continue;
        if (codeOf(rel).includes('SyntheticFinancialRefusal')) consumers.push(rel);
      }
    };
    walk(SRC);
    expect(consumers).toEqual(['services/disbursement.service.ts']);
  });
});

// ─── The seven required properties, stated as the contract ────────────────────

describe('THE SMOKE-SAFETY CONTRACT', () => {
  it('REAL BOOKING: counted in normal metrics', () => {
    // The default is false, so a real booking is included without anyone
    // having to do anything — the safe direction for the common case.
    expect(migration()).toContain('NOT NULL DEFAULT false');
  });

  it('SYNTHETIC BOOKING: not counted in business metrics', () => {
    expect(Object.keys(REPORTING_SURFACES).sort()).toEqual([
      'adminDashboardService#bookingAggregations',
      'adminFinanceService#revenue',
      'providerPerformanceService#providerStats',
      'providerSupplyHealthService#demand',
    ]);
  });

  it('ADMIN EXPLICIT SYNTHETIC QUERY: can retrieve it', () => {
    expect(Object.keys(OPERATIONAL_SURFACES)).toContain('adminBookingService#getAdminBookings');
    expect(Object.keys(OPERATIONAL_SURFACES)).toContain('adminBookingService#getAdminBookingDetail');
  });

  it('CANONICAL STATE: unchanged by the flag', () => {
    expect(codeOf('services/booking/canonicalState.ts')).not.toContain('synthetic');
  });

  it('TRANSITION EXECUTOR: same code path', () => {
    expect(codeOf('services/booking/transitionExecutor.ts')).not.toContain('synthetic');
  });

  it('PROVIDER PERFORMANCE: synthetic accept/decline does not alter real metrics', () => {
    const code = codeOf('services/providerPerformanceService.ts');
    expect(code).toContain('excludeSyntheticSql');
    // Both halves: the accept/decline/completion counts AND the cancellation
    // count, which is a separate query and was easy to miss.
    expect((code.match(/excludeSyntheticSql/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('COMPLETION METRICS: a synthetic completion is not the first real one', () => {
    // The specific thing this whole patch exists to prevent.
    const code = codeOf('services/adminDashboardService.ts');
    expect(code).toContain('excludeSyntheticSql');
  });
});
