/**
 * payments.updated_at — the column two live queries assumed and nobody created.
 *
 * `scheduler.ts` filters failed PayMongo payments on `p.updated_at`, so the
 * retry job raised Postgres 42703 (undefined_column) on every single run. No
 * failed payment has ever been retried. `adminFinanceService` selects the same
 * column in the finance payments list, so that query failed too.
 *
 * It surfaced in production pm2 logs during an unrelated Firebase key rotation
 * — nothing was watching for it, which is the more interesting problem.
 *
 * ## Why these assertions moved (TAB 02)
 *
 * This suite used to read `adminFinanceService.ts` and assert on the DDL text
 * inside `ensureFinanceSchema`, and said why: "the schema is created by a
 * bootstrap function at boot rather than by migration files, so there is no
 * schema artefact to inspect and no database in CI."
 *
 * That premise no longer holds. `scripts/baseline/000-baseline.sql` IS a schema
 * artefact — production's own `pg_dump` — and `npm run db:verify:embedded` applies
 * it to a real PostgreSQL. So every guarantee below is now asserted against the
 * schema that will actually exist, rather than against code that intended to
 * create it. That is strictly stronger, and it is why `ensureFinanceSchema` could
 * be deleted.
 *
 * ## The one guarantee that genuinely changed
 *
 * The bootstrap also ran a one-time DML backfill:
 *
 *   UPDATE payments SET updated_at = COALESCE(paid_at, submitted_at, NOW())
 *     WHERE updated_at IS NULL
 *
 * That is gone and is deliberately NOT re-homed into a migration: it is already
 * applied in production, its own predicate makes it a no-op there now, and a
 * fresh database has no payment rows. What replaces it as protection is the
 * column DEFAULT plus the trigger, both asserted below. A NULL `updated_at`
 * appearing again would mean a writer inserted one explicitly — the column is
 * nullable — and the fix belongs at that writer, not in a boot-time sweep over
 * the payments table.
 */

import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..');
const read = (...p: string[]) =>
  fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n');

const baseline = read('scripts', 'baseline', '000-baseline.sql');
const finance = read('src', 'services', 'adminFinanceService.ts');
const scheduler = read('src', 'scheduler.ts');

/** The columns `servana.payments` is created with. */
const paymentsColumns = (): string => {
  const m = /CREATE TABLE servana\.payments \(([\s\S]*?)\n\);/.exec(baseline);
  if (!m) throw new Error('baseline does not create servana.payments');
  return m[1];
};

describe('the column exists, in the schema rather than in a bootstrap', () => {
  const columns = paymentsColumns();

  it('the baseline really defines payments (positive fixture)', () => {
    // A regex matching nothing would make every assertion below vacuous.
    expect(columns).toContain('booking_id');
    expect(columns.split('\n').length).toBeGreaterThan(10);
  });

  it('payments.updated_at is present', () => {
    expect(columns).toMatch(/updated_at timestamp with time zone/);
  });

  it('has a DEFAULT, so a new row is never NULL', () => {
    /**
     * This is what makes the deleted backfill unnecessary going forward. A NULL
     * `updated_at` makes `updated_at < NOW() - INTERVAL '6 hours'` false, so such
     * a row would be invisible to the retry job forever — the bug would survive
     * its own fix.
     */
    expect(columns).toMatch(/updated_at timestamp with time zone DEFAULT now\(\)/);
  });

  it('the sibling columns the old backfill read still exist', () => {
    // It seeded from COALESCE(paid_at, submitted_at, NOW()). The ORDER mattered:
    // seeding from paid_at means the retry job counts its 6 hours from a real
    // event instead of treating every historical payment as instantly eligible.
    expect(columns).toMatch(/\bpaid_at\b/);
    expect(columns).toMatch(/\bsubmitted_at\b/);
  });

  it('the bootstrap that used to create all this is gone', () => {
    // The point of the change, asserted so a revert is visible rather than quiet.
    expect(finance).not.toMatch(/ALTER TABLE .*payments ADD COLUMN/);
    expect(finance).not.toMatch(/CREATE TABLE IF NOT EXISTS/);
    expect(finance).not.toMatch(/CREATE OR REPLACE FUNCTION/);
    expect(finance).not.toMatch(/CREATE TRIGGER/);
  });
});

describe('the column stays honest', () => {
  it('is maintained by a trigger, not by each writer remembering', () => {
    /**
     * Two INSERT sites write payments rows without naming updated_at
     * (bookingService, adminCreateBookingService). Relying on writers would leave
     * a stale value, and stale here silently means "retry this payment".
     */
    expect(baseline).toMatch(
      /CREATE FUNCTION servana\.touch_payments_updated_at\(\) RETURNS trigger/,
    );
    expect(baseline).toMatch(/NEW\.updated_at = NOW\(\);/);
    expect(baseline).toMatch(
      /CREATE TRIGGER trg_payments_updated_at BEFORE UPDATE ON servana\.payments FOR EACH ROW EXECUTE FUNCTION servana\.touch_payments_updated_at\(\)/,
    );
  });

  it('the trigger and its function are BOTH in the artefact', () => {
    /**
     * Asserted as a pair on purpose. A trigger whose function is missing does not
     * fail at creation — it fails at the first UPDATE, which for this table means
     * the first payment status change. `pg_dump` emits them in separate sections,
     * so it is possible to carry one and not the other.
     *
     * It is also the ONLY trigger in the schema, which is why losing it silently
     * would be easy.
     */
    expect((baseline.match(/CREATE TRIGGER/g) ?? []).length).toBe(1);
    expect((baseline.match(/CREATE FUNCTION servana\.touch_payments_updated_at/g) ?? []).length).toBe(1);
  });
});

describe('the consumers that were broken', () => {
  it('the retry job still filters on updated_at', () => {
    expect(scheduler).toMatch(/p\.updated_at\s*<\s*NOW\(\)\s*-\s*INTERVAL/);
  });

  it('every payments column the scheduler reads exists in the baseline', () => {
    /**
     * The original form of this checked the scheduler's columns against a
     * hardcoded list. Checking them against the actual schema is the same idea
     * with the guesswork removed — and it is precisely the 42703 this suite
     * exists for.
     */
    const query = scheduler.slice(
      scheduler.indexOf('FROM ${dbSchema}.payments p'),
      scheduler.indexOf('FROM ${dbSchema}.payments p') + 600,
    );
    const cols = [...query.matchAll(/\bp\.([a-z_]+)/g)].map((m) => m[1]);
    expect(cols.length).toBeGreaterThan(0);

    const declared = paymentsColumns();
    for (const c of new Set(cols)) {
      expect(declared).toMatch(new RegExp(`^\\s+${c}\\s`, 'm'));
    }
  });
});
