/**
 * The schema-authority gap is small, specific, and booking-critical (TAB 02).
 *
 * ## What this corrects
 *
 * `runtime-ddl-budget.test.ts` pins 154 statements as "not owned by a
 * migration", and TAB 02 was scoped from that number: 154 statements to move,
 * one to two weeks, "the multi-week core". That scoping is wrong, and the reason
 * is that migrations stopped being the only schema authority in this repository
 * when TAB 15 added `scripts/baseline/000-baseline.sql`.
 *
 * 148 of the 154 touch an object the baseline already declares. `db:verify:embedded`
 * proves a fresh database reaches the current schema by restoring that baseline
 * and applying pending migrations on top, so those objects are already
 * reproducible from the repository. Their runtime DDL still has to be DELETED
 * before the API can start with DDL privileges revoked — but nothing has to be
 * AUTHORED first, and deletion is not a multi-week design exercise.
 *
 * Six statements were different. Nothing in this repository created them:
 *
 *   booking_transitions              transitionExecutor — the ONE canonical
 *   idx_booking_transitions_booking  booking state-transition writer
 *   booking_transition_idempotency
 *   booking_evidence                 bookingEvidenceService
 *   idx_booking_evidence_booking_worker
 *   worker_onboarding                technicianService
 *
 * Plus three columns on `booking_workers` that the baseline does not carry:
 * `cancelled_at`, `cancellation_reason_code`, `cancellation_note`. The call site
 * says so itself — "Queued for a real migration alongside 027's arrival columns".
 *
 * ## Why those mattered more than the 154 did
 *
 * They are not in production. The baseline IS production's dump, and they are
 * absent from it, so they existed only where this unreleased code had already
 * run. On deploy the application would create them itself on first use — the
 * behaviour TAB 02 exists to remove, on the booking write path, and the
 * behaviour that fails outright once DDL privileges are revoked.
 *
 * `036-booking-transition-evidence-onboarding.sql` closes that gap, so both
 * budgets below are now ZERO and this suite's job changes from measuring a debt
 * to keeping it at nil: a new runtime `CREATE TABLE` for an object no migration
 * and no baseline declares fails here.
 *
 * ## What 036 does NOT do
 *
 * The runtime DDL is still in place, on purpose. Deleting it before 036 is
 * applied to production would make booking transitions depend on a migration
 * that has not run. Those statements are now counted as migration-owned and
 * redundant — the 148, plus these — and they come out when TAB 02 revokes DDL
 * privileges, after the apply.
 */

import fs from 'fs';
import path from 'path';

import {
  baselineObjects,
  classify,
  columnGaps,
  declaredColumnsFromRepo,
  runtimeAddColumns,
} from '../scripts/schema-authority';
import { runtimeDdl, migrationObjects } from '../scripts/runtime-ddl-inventory';

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'scripts', 'migrations');

/**
 * At nil since migration 036. These may never rise: a runtime CREATE TABLE for
 * an object neither a migration nor the baseline declares is a schema the only
 * copy of which lives wherever that code has happened to run.
 */
const UNMANAGED_STATEMENT_BUDGET = 0;
const MISSING_COLUMN_BUDGET = 0;

/** The migration that closed the gap. Named so deleting it fails loudly. */
const CLOSING_MIGRATION = '036-booking-transition-evidence-onboarding.sql';

/** What 036 had to claim, and must keep claiming. */
const CLAIMED_OBJECTS = [
  'booking_evidence',
  'booking_transition_idempotency',
  'booking_transitions',
  'idx_booking_evidence_booking_worker',
  'idx_booking_transitions_booking',
  'worker_onboarding',
] as const;

const CLAIMED_COLUMNS = [
  'cancellation_note',
  'cancellation_reason_code',
  'cancelled_at',
] as const;

describe('schema authority is classified, not lumped', () => {
  const rows = classify();
  const gap = rows.filter((r) => r.authority === 'UNMANAGED');

  it('finds runtime DDL and a real baseline (positive fixtures)', () => {
    /**
     * A scan that found nothing would satisfy every budget below forever.
     *
     * The floor is deliberately well BELOW the current count, because the whole
     * point of TAB 02 is that this number falls — it was 214, and pinning the
     * fixture just under it failed the moment the deletion pass removed 37
     * statements. A positive fixture proves the scan works; it must not double as
     * a budget, or it fails on progress.
     */
    expect(rows.length).toBeGreaterThan(50);
    expect(baselineObjects().size).toBeGreaterThan(200);
    expect(runtimeAddColumns().length).toBeGreaterThan(20);
  });

  it('every statement lands in exactly one authority', () => {
    /**
     * Conservation, not occupancy. The UNMANAGED bucket is EMPTY since 036, so
     * asserting all three are occupied would fail for the good reason — which it
     * did, and is why this checks the sum instead.
     */
    for (const row of rows) {
      expect(['migration', 'baseline', 'UNMANAGED']).toContain(row.authority);
    }
    const total =
      rows.filter((r) => r.authority === 'migration').length +
      rows.filter((r) => r.authority === 'baseline').length +
      gap.length;
    expect(total).toBe(rows.length);
  });

  it('is an exact refinement of the migration-only inventory', () => {
    /**
     * THE load-bearing identity. The old gate's 154 must split cleanly into
     * baseline-owned plus genuinely unmanaged, with nothing invented and nothing
     * lost. If this drifts, one of the two scripts is measuring something else
     * and the numbers in every report built on them are no longer comparable.
     */
    const owned = migrationObjects();
    const notMigrationOwned = runtimeDdl().filter((d) => !owned.has(d.object));
    const baselineOwned = rows.filter((r) => r.authority === 'baseline');

    expect(baselineOwned.length + gap.length).toBe(notMigrationOwned.length);
  });

  it('adds no statement that nothing in the repository creates', () => {
    expect(gap.length).toBeLessThanOrEqual(UNMANAGED_STATEMENT_BUDGET);
  });

  it('nothing is unmanaged, and the gap is named if it ever returns', () => {
    // Named rather than counted, so the failure message says WHICH object.
    expect([...new Set(gap.map((g) => g.object))].sort()).toEqual([]);
  });

  it('the budget is not stale — it still matches reality', () => {
    // A budget left above the real number permits silent growth up to the gap.
    expect(UNMANAGED_STATEMENT_BUDGET - gap.length).toBeLessThanOrEqual(1);
  });

  it('migration 036 is what claims the six, and it still exists', () => {
    /**
     * The budget above reads zero either because 036 claims these objects or
     * because somebody deleted the runtime DDL — and those are very different
     * states. This pins the first: 036 present, and declaring all six by name.
     */
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, CLOSING_MIGRATION), 'utf8');
    for (const object of CLAIMED_OBJECTS) {
      expect(sql).toContain(object);
    }
    for (const column of CLAIMED_COLUMNS) {
      expect(sql).toContain(column);
    }
  });

  it('036 fingerprints the runtime definitions rather than redesigning them', () => {
    /**
     * Applying 036 to a database the runtime path already bootstrapped must be a
     * no-op. Every table is IF NOT EXISTS, and the columns are additive and
     * nullable — a widened type or an added NOT NULL would diverge from the
     * database the application built, on the one host that matters.
     */
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, CLOSING_MIGRATION), 'utf8');
    const creates = sql.match(/CREATE\s+TABLE(\s+IF\s+NOT\s+EXISTS)?/gi) ?? [];
    expect(creates.length).toBe(4);
    expect(creates.every((c) => /IF\s+NOT\s+EXISTS/i.test(c))).toBe(true);

    const addColumns = sql.match(/ADD\s+COLUMN(\s+IF\s+NOT\s+EXISTS)?/gi) ?? [];
    expect(addColumns.length).toBe(CLAIMED_COLUMNS.length);
    expect(addColumns.every((c) => /IF\s+NOT\s+EXISTS/i.test(c))).toBe(true);
    expect(sql).not.toMatch(/ADD\s+COLUMN[^,;]*NOT\s+NULL/i);
  });
});

describe('columns the application adds are declared somewhere', () => {
  const { missing, indeterminate } = columnGaps();

  it('adds no undeclared column', () => {
    expect(missing.length).toBeLessThanOrEqual(MISSING_COLUMN_BUDGET);
  });

  it('nothing is missing, and names what is if it ever returns', () => {
    expect(missing.map((m) => `${m.table}.${m.column}`).sort()).toEqual([]);
  });

  it('the three booking_workers cancellation columns are now declared', () => {
    // The specific gap 036 closed. Asserted on the parsed declarations rather
    // than on the file text, so it fails if the migration stops being READ as
    // declaring them — a rename, a reformat, a broken parser.
    const declared = declaredColumnsFromRepo().get('booking_workers');
    expect(declared).toBeDefined();
    for (const column of CLAIMED_COLUMNS) {
      expect([...declared!]).toContain(column);
    }
  });

  it('reports an interpolated column name rather than assuming it is covered', () => {
    /**
     * Two call sites build the column name from a loop variable, so it is not in
     * the source text. Both were resolved BY READING them, and both are covered:
     *
     *   adminBookingService:170   six confirmCols — all present in the baseline's
     *                             booking_workers CREATE TABLE
     *   experienceStore:156       category, opened_by_role, state_snapshot — all
     *                             added by migration 030
     *
     * They stay reported rather than silently counted, because an earlier draft
     * of this scan captured the SQL keyword `IF` as the column name for exactly
     * these two and scored them as real gaps. Assuming either way is the mistake.
     */
    expect(indeterminate).toHaveLength(2);
    expect(indeterminate.every((a) => a.column === null)).toBe(true);
    expect(indeterminate.map((a) => a.table).sort()).toEqual([
      'booking_escalations',
      'booking_workers',
    ]);
  });

  it('never reports a SQL keyword as a column name', () => {
    // The backtracking bug this scan was written around.
    const all = runtimeAddColumns();
    for (const a of all) {
      expect(a.column).not.toBe('if');
      expect(a.column).not.toBe('not');
      expect(a.column).not.toBe('exists');
    }
  });
});
