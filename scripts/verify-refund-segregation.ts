/**
 * Gate: a real PostgreSQL refuses a self-approved refund.
 *
 *   npm run refunds:segregation
 *
 * ## Why this is not a jest test
 *
 * PGlite loads its WASM through a dynamic import, which needs
 * `--experimental-vm-modules` inside jest's VM context. `verify-fresh-db.ts` and
 * `verify-schema-code-skew.ts` are scripts for the same reason, and adding that
 * flag for the whole suite to accommodate one check is a worse trade than
 * running the check where it already works.
 *
 * ## Why it exists at all, given tests/refund-segregation-of-duties.test.ts
 *
 * Those unit tests drive `approveRefund` against a fake `dbQuery` that returns
 * canned rows and never looks at the SQL. Removing the guard from the statement
 * broke exactly ONE of the eighteen — the assertion on the string. Every
 * behavioural case kept passing, because the fake had already decided how many
 * rows to return.
 *
 * So the unit tests prove the guard is written, the classification is right and
 * the refusal is audited. They cannot prove PostgreSQL applies the predicate.
 * This does, by executing `approveRefundSql` — the exported statement the
 * service itself issues, not a copy of it — against real PostgreSQL compiled to
 * WebAssembly.
 *
 * ## What is set up, and what deliberately is not
 *
 * Only `finance_refund_reviews`, with the columns this statement touches. The
 * full baseline is 132 tables and replaying it would make a two-second check
 * into a slow one while proving nothing extra about this predicate. The
 * column types match the baseline; if the real table drifts from them, that is
 * `db:skew` and `fresh-db` territory and those gates already run.
 */

import { createEngine } from './lib/embeddedEngine';
import { approveRefundSql } from '../src/services/finance/refundApprovalSql';

const SCHEMA = 'servana';
const REQUESTER = 'admin-alice';
const OTHER = 'admin-bob';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];
const record = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

const main = async (): Promise<number> => {
  const db = await createEngine();

  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS ${SCHEMA};
    CREATE TABLE ${SCHEMA}.finance_refund_reviews (
      id                     serial PRIMARY KEY,
      booking_id             integer NOT NULL,
      payment_id             integer,
      amount                 numeric(12,2) NOT NULL,
      status                 text NOT NULL DEFAULT 'requested',
      requested_by           text,
      reviewed_by            text,
      reviewed_at            timestamptz,
      payout_reversal_needed boolean NOT NULL DEFAULT false,
      updated_at             timestamptz NOT NULL DEFAULT NOW()
    );
  `);

  const seed = async (id: number, requestedBy: string | null, status = 'requested') => {
    await db.query(
      `INSERT INTO ${SCHEMA}.finance_refund_reviews (id, booking_id, amount, status, requested_by)
       VALUES ($1, 41, 500.00, $2, $3)`,
      [id, status, requestedBy],
    );
  };

  const approve = async (id: number, actor: string, enforce = true) =>
    db.query(approveRefundSql(SCHEMA, enforce), [id, actor]);

  // ── The control ────────────────────────────────────────────────────────────

  await seed(1, REQUESTER);
  const selfApproval = await approve(1, REQUESTER);
  record(
    'the requester cannot approve their own refund',
    selfApproval.rows.length === 0,
    `${selfApproval.rows.length} row(s) updated, expected 0`,
  );

  const untouched = await db.query<{ status: string; reviewed_by: string | null }>(
    `SELECT status, reviewed_by FROM ${SCHEMA}.finance_refund_reviews WHERE id = 1`,
  );
  record(
    'the refused row is left exactly as it was',
    untouched.rows[0]?.status === 'requested' && untouched.rows[0]?.reviewed_by === null,
    `status=${untouched.rows[0]?.status} reviewed_by=${String(untouched.rows[0]?.reviewed_by)}`,
  );

  // ── The control does not over-refuse ───────────────────────────────────────

  await seed(2, REQUESTER);
  const otherApproval = await approve(2, OTHER);
  record(
    'a different admin CAN approve it',
    otherApproval.rows.length === 1,
    `${otherApproval.rows.length} row(s) updated, expected 1`,
  );

  /**
   * A review with no recorded requester is approvable.
   *
   * `requested_by` is nullable in the baseline and rows predating the admin
   * route may carry NULL. `NULL <> 'bob'` is NULL, not true, so without the
   * explicit `requested_by IS NULL OR` those rows would become permanently
   * unapprovable — a control that quietly bricks historical data rather than
   * refusing a specific act.
   */
  await seed(3, null);
  const nullRequester = await approve(3, OTHER);
  record(
    'a review with no recorded requester is still approvable',
    nullRequester.rows.length === 1,
    `${nullRequester.rows.length} row(s) updated, expected 1`,
  );

  // ── The escape hatch ───────────────────────────────────────────────────────

  await seed(4, REQUESTER);
  const bypassed = await approve(4, REQUESTER, false);
  record(
    'the configured bypass really does lift the predicate',
    bypassed.rows.length === 1,
    `${bypassed.rows.length} row(s) updated, expected 1`,
  );

  // ── The predicate is the only thing that changed ───────────────────────────

  await seed(5, REQUESTER, 'approved');
  const wrongStatus = await approve(5, OTHER);
  record(
    'an already-approved review is still refused',
    wrongStatus.rows.length === 0,
    `${wrongStatus.rows.length} row(s) updated, expected 0`,
  );

  // ── Report ─────────────────────────────────────────────────────────────────

  console.log('\n[refund-segregation] real PostgreSQL, the service’s own statement\n');
  for (const check of checks) {
    console.log(`  ${check.ok ? '✓' : '✗'} ${check.name}${check.ok ? '' : ` — ${check.detail}`}`);
  }

  const failed = checks.filter((c) => !c.ok);
  console.log('');
  if (failed.length === 0) {
    console.log('[refund-segregation] OK.');
    return 0;
  }
  console.error(`[refund-segregation] ${failed.length} check(s) failed.`);
  return 1;
};

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('[refund-segregation] threw:', error);
    process.exit(1);
  });
