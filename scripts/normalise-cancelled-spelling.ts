/**
 * Normalise `booking_workers.status` from 'CANCELED' to 'CANCELLED'.
 *
 * The schema carried two spellings of the same state: `bookings.status` was
 * written 'CANCELLED' (double L), `booking_workers.status` 'CANCELED' (single).
 * Both were load-bearing and both were read defensively in different places —
 * except one, which was not: `getWorkerDashboard` counted the parent's spelling
 * against the child's table, so every provider's cancelled-job count read zero
 * for as long as the query existed.
 *
 * The application now WRITES only 'CANCELLED'. This reconciles rows written
 * before that change. Reads still accept both, and should keep accepting both
 * until this has run everywhere — a query that matches only the canonical
 * spelling against un-normalised data reintroduces the exact bug.
 *
 * DRY RUN BY DEFAULT:
 *   npx ts-node scripts/normalise-cancelled-spelling.ts
 *   npx ts-node scripts/normalise-cancelled-spelling.ts --apply
 *
 * Idempotent. Safe to run repeatedly; the second run reports zero.
 *
 * Doing this BEFORE launch makes it a schema decision. Afterwards it is a data
 * migration against live bookings, with a window where the two spellings
 * coexist and every reader has to handle both.
 */

import { db } from '../src/config';
import dbQuery from '../src/db/dbQuery';

const s = db.schema;
const APPLY = process.argv.includes('--apply');

async function main() {
  const { rows } = await dbQuery.query(
    `SELECT COUNT(*)::int AS n FROM ${s}.booking_workers WHERE status = 'CANCELED'`,
    []
  );
  const n = rows[0]?.n ?? 0;

  if (!n) {
    console.log("No rows spelled 'CANCELED'. Nothing to normalise.");
    return;
  }

  console.log(`${n} booking_workers row(s) spelled 'CANCELED'.`);

  // Sanity check before writing: the canonical spelling must not already be in
  // use on this table in a way that means something different. It does not —
  // both spell the same state — but if a future status genuinely differed, a
  // blind UPDATE would merge two distinct states into one and be unrecoverable.
  const { rows: existing } = await dbQuery.query(
    `SELECT COUNT(*)::int AS n FROM ${s}.booking_workers WHERE status = 'CANCELLED'`,
    []
  );
  console.log(`${existing[0]?.n ?? 0} row(s) already spelled 'CANCELLED'.`);

  if (!APPLY) {
    console.log('');
    console.log('DRY RUN. Re-run with --apply to normalise.');
    return;
  }

  const res = await dbQuery.query(
    `UPDATE ${s}.booking_workers
     SET status = 'CANCELLED'
     WHERE status = 'CANCELED'`,
    []
  );
  console.log(`Normalised ${res.rowCount} row(s).`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('normalisation failed:', e.message);
    process.exit(1);
  });
