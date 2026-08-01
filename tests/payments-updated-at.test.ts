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
 * Source-level assertions: the schema is created by a bootstrap function at
 * boot rather than by migration files, so there is no schema artefact to
 * inspect and no database in CI.
 */

import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..', 'src');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

const finance = read('services', 'adminFinanceService.ts');
const scheduler = read('scheduler.ts');

describe('the column exists', () => {
  it('is added by the boot-time schema bootstrap', () => {
    expect(finance).toMatch(
      /ALTER TABLE \$\{s\}\.payments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ/,
    );
  });

  it('is backfilled rather than left NULL', () => {
    // A NULL updated_at makes `updated_at < NOW() - INTERVAL '6 hours'` false,
    // so those rows would be invisible to the retry job forever — the bug
    // would survive its own fix.
    expect(finance).toMatch(/UPDATE \$\{s\}\.payments SET updated_at = COALESCE\(/);
    expect(finance).toMatch(/WHERE updated_at IS NULL/);
  });

  it('backfills only from columns that exist on payments', () => {
    // Naming a column that does not exist would raise the same 42703 this
    // change fixes — at boot, which is worse. `created_at` is deliberately not
    // referenced: it appears nowhere else in the codebase.
    // NOW() contains its own parens, so a lazy [^)]* capture truncates the
    // list mid-expression. Strip function calls before splitting.
    const backfill = (
      finance.match(/SET updated_at = COALESCE\(([\s\S]*?)\)\s*$/m)?.[1] ??
      finance.match(/SET updated_at = COALESCE\(([^;]*?)\)\s*\n/)?.[1] ??
      ''
    ).replace(/NOW\(\)/g, '');
    expect(backfill).toContain('paid_at');
    expect(backfill).not.toContain('created_at');

    for (const col of backfill.split(',').map((c) => c.trim())) {
      if (!col) continue;
      // Every referenced column must be created by this same bootstrap or used
      // elsewhere against the payments table.
      const declared =
        new RegExp(`payments ADD COLUMN IF NOT EXISTS ${col}\\b`).test(finance);
      const used = new RegExp(`\\bp\\.${col}\\b`).test(finance);
      expect(declared || used).toBe(true);
    }
  });

  it('gets a default so new rows are never NULL', () => {
    expect(finance).toMatch(/ALTER COLUMN updated_at SET DEFAULT NOW\(\)/);
  });
});

describe('the column stays honest', () => {
  it('is maintained by a trigger, not by each writer remembering', () => {
    // Two INSERT sites already write payments rows without naming updated_at
    // (bookingService, adminCreateBookingService). Relying on writers would
    // leave a stale value, and stale here silently means "retry this payment".
    expect(finance).toMatch(/CREATE OR REPLACE FUNCTION \$\{s\}\.touch_payments_updated_at/);
    expect(finance).toMatch(/BEFORE UPDATE ON \$\{s\}\.payments/);
    expect(finance).toMatch(/NEW\.updated_at = NOW\(\)/);
  });

  it('drops the trigger before creating it, so boot is idempotent', () => {
    // ensureFinanceSchema runs on every start.
    const dropIdx = finance.indexOf('DROP TRIGGER IF EXISTS trg_payments_updated_at');
    const createIdx = finance.indexOf('CREATE TRIGGER trg_payments_updated_at');
    expect(dropIdx).toBeGreaterThan(-1);
    expect(createIdx).toBeGreaterThan(dropIdx);
  });
});

describe('the consumers that were broken', () => {
  it('the retry job still filters on updated_at', () => {
    expect(scheduler).toMatch(/p\.updated_at\s*<\s*NOW\(\)\s*-\s*INTERVAL/);
  });

  it('every payments column the scheduler reads is one we create or already had', () => {
    const query = scheduler.slice(
      scheduler.indexOf('FROM ${dbSchema}.payments p'),
      scheduler.indexOf('FROM ${dbSchema}.payments p') + 600,
    );
    const cols = [...query.matchAll(/\bp\.([a-z_]+)/g)].map((m) => m[1]);
    expect(cols.length).toBeGreaterThan(0);
    for (const c of cols) {
      const known = ['id', 'booking_id', 'amount', 'status', 'provider', 'updated_at'];
      expect(known).toContain(c);
    }
  });
});
