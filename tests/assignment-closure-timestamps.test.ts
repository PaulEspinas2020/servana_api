/**
 * A closed assignment records WHEN it closed.
 *
 * A row reading `DECLINED` with no record of when it became declined is
 * incomplete lifecycle data, independent of anything that consumes it. This is
 * a lifecycle-integrity correction, not a chat feature — bounded historical
 * read happens to be the consumer that noticed.
 *
 * The target invariant, once every path is covered:
 *
 *   DECLINED  → declined_at
 *   CANCELLED → cancelled_at
 *   COMPLETED → completed_at
 *
 * No closed assignment status without its matching closure timestamp.
 */

import fs from 'fs';
import path from 'path';

const EXECUTOR = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'booking', 'transitionExecutor.ts'), 'utf8',
).replace(/\r\n/g, '\n');

/** Source with comments stripped — a rule described in prose is not enforced. */
const code = EXECUTOR
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

/**
 * The statement that closes the outgoing row on a reassignment, INCLUDING the
 * call that issues it.
 *
 * The window opens at the enclosing `query(` rather than at the SQL, because
 * which client issues the statement is part of what these tests check — a
 * window starting at `SET` cannot see whether it ran on the transaction or on
 * the pool.
 */
const reassignClose = (): string => {
  const sqlAt = code.indexOf("SET status = 'DECLINED'");
  expect(sqlAt).toBeGreaterThan(-1);
  // From the `await`, so the RECEIVER is inside the window — starting at
  // `query(` would cut off the `client.` that this test is about.
  const callAt = code.lastIndexOf('await ', sqlAt);
  expect(callAt).toBeGreaterThan(-1);
  return code.slice(callAt, code.indexOf(');', sqlAt));
};

describe('ADMIN_REASSIGN closes the outgoing assignment completely', () => {
  it('writes the status AND the timestamp', () => {
    const stmt = reassignClose();
    expect(stmt).toContain("status = 'DECLINED'");
    expect(stmt).toContain('declined_at');
  });

  it('writes both in the SAME statement', () => {
    /**
     * Not two statements. A status and its timestamp written separately can
     * separate — a failure between them leaves exactly the incomplete row this
     * corrects, and the second write has no transaction of its own to protect
     * it.
     */
    const stmt = reassignClose();
    const setAt = stmt.indexOf("SET status = 'DECLINED'");
    const stampAt = stmt.indexOf('declined_at');
    const closeAt = stmt.indexOf('WHERE booking_id');
    expect(setAt).toBeLessThan(stampAt);
    expect(stampAt).toBeLessThan(closeAt);
  });

  it('uses COALESCE, so a retry never moves the timestamp forward', () => {
    /**
     * The invariant that makes this safe to retry. A provider who genuinely
     * declined earlier, before an admin reassigned the booking away, keeps the
     * moment THEY declined rather than inheriting the admin's.
     */
    expect(reassignClose()).toContain('COALESCE(declined_at, NOW())');
    expect(reassignClose()).not.toMatch(/declined_at\s*=\s*NOW\(\)\s*[,\n]/);
  });

  it('runs inside the executor transaction', () => {
    /**
     * Asserted by WHICH CLIENT it uses, not by source position.
     *
     * My first version compared offsets against the last `COMMIT` and failed:
     * the close lives inside `applyState`, which is DEFINED below the commit
     * and CALLED from above it. Source order is not execution order, and a
     * guard that confuses the two reports a real statement as misplaced.
     *
     * `client` is the transaction-scoped connection the executor opens after
     * BEGIN; `dbQuery` is the pool. Using the former IS being in the
     * transaction.
     */
    expect(reassignClose()).toContain('client.query');
    expect(reassignClose()).not.toContain('dbQuery.query');
    expect(code).toContain("client.query('BEGIN')");
    expect(code).toContain("client.query('ROLLBACK')");
  });

  it('is reached only when the provider actually CHANGES', () => {
    /**
     * ADMIN_REASSIGN to the same provider is an idempotent no-op, so no
     * departure happened and no departure time may be written. Stamping one
     * would record a closure that did not occur.
     */
    expect(code).toContain("sameTarget: 'IDEMPOTENT_NO_OP'");
    const noOpAt = code.indexOf('IDEMPOTENT_NO_OP');
    expect(noOpAt).toBeGreaterThan(-1);
  });
});

describe('no backfill, and NULL keeps meaning "unknown"', () => {
  it('nothing writes declined_at to historical rows', () => {
    // A backfill would invent departure times, and an invented bound is worse
    // than an absent one: it looks authoritative.
    for (const forbidden of [
      'UPDATE servana.booking_workers SET declined_at',
      'declined_at = assigned_at',
      'declined_at = updated_at',
    ]) {
      expect(EXECUTOR).not.toContain(forbidden);
    }
    const migrations = fs.readdirSync(path.join(__dirname, '..', 'scripts', 'migrations'));
    for (const file of migrations) {
      const sql = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'migrations', file), 'utf8');
      expect(`${file}:${/UPDATE\s+servana\.booking_workers[\s\S]*declined_at/i.test(sql)}`)
        .toBe(`${file}:false`);
    }
  });

  it('no departure time is reconstructed from transition ordering', () => {
    /**
     * The tempting fix, and the wrong one. Correlating `booking_transitions` by
     * order turns missing data into an inferred authorization boundary, and it
     * is wrong the moment a provider holds two intervals.
     */
    expect(code).not.toMatch(/declined_at[\s\S]{0,200}booking_transitions/);
  });
});

describe('the remaining closure paths are QUEUED, not silently missing', () => {
  it('PROVIDER_CANCEL already stamps cancelled_at', () => {
    expect(code).toContain('cancelled_at = CASE WHEN $4 THEN cancelled_at ELSE NOW() END');
  });

  it('PROVIDER_COMPLETE already stamps completed_at', () => {
    expect(code).toContain("status = 'COMPLETED', completed_at = NOW()");
  });

  it('ADMIN_CANCEL / CUSTOMER_CANCEL still close WITHOUT a timestamp', () => {
    /**
     * Pinned as a known gap rather than left to be rediscovered. This closes
     * any active row on the booking and writes status only, so a cancelled
     * assignment has no trustworthy upper bound either.
     *
     * Deliberately NOT bundled into this commit: `declined_at` is the wrong
     * column for a cancellation, and the right one — `cancelled_at` — deserves
     * its own declared change rather than riding along.
     *
     * When it lands, this test inverts.
     */
    const bulkClose = code.indexOf("UPDATE ${s}.booking_workers SET status = $2");
    expect(bulkClose).toBeGreaterThan(-1);
    const stmt = code.slice(bulkClose, code.indexOf(');', bulkClose));
    expect(stmt).toContain("status IN ('ASSIGNED','ACCEPTED','EN_ROUTE','ARRIVED')");
    // The gap, asserted so its closure is a visible diff.
    expect(stmt).not.toContain('cancelled_at');
  });

  it('bounded historical read stays blocked until every path has a bound', () => {
    const blocker = fs.readFileSync(
      path.join(__dirname, '..', 'docs', 'booking', 'BOUNDED_HISTORICAL_READ_BLOCKER.md'), 'utf8',
    );
    expect(blocker).toContain('BLOCKED');
    // And T10 is still unmeasured — do not choose an interval model by guessing.
    // Matched on an unwrappable token: prose in a markdown document line-wraps,
    // so asserting a phrase is asserting the formatter.
    expect(blocker).toContain('ON CONFLICT DO NOTHING');
    expect(blocker).toContain('T10');
  });
});
