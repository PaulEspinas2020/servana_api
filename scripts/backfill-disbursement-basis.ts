/**
 * Backfill disbursements whose basis excluded paid additional work.
 *
 * `createDisbursement` used to compute the split from `bookings.final_price`
 * alone. Additional work is charged through its own PayMongo checkout and never
 * writes back to final_price, so on-site upsells contributed exactly 0 to
 * provider pay. The service now includes them; this reconciles rows written
 * before that change.
 *
 * DRY RUN BY DEFAULT. It prints what it would change and exits. Pass `--apply`
 * to write. This rewrites money, and a script that rewrites money should not do
 * so because someone typed its name without reading it.
 *
 *   npx ts-node scripts/backfill-disbursement-basis.ts
 *   npx ts-node scripts/backfill-disbursement-basis.ts --apply
 *
 * Only PENDING rows are touched. A RELEASED disbursement has already been paid
 * out through PayMongo, and editing the record after the fact would make the
 * ledger disagree with what actually left the account — those are reported for
 * manual settlement instead of being silently rewritten.
 *
 * Idempotent: rows already matching the correct basis are skipped, so running it
 * twice changes nothing the second time.
 */

import { db } from '../src/config';
import dbQuery from '../src/db/dbQuery';
import { splitRevenue } from '../src/services/revenueSplit';

const schema = db.schema;
const APPLY = process.argv.includes('--apply');

const peso = (n: number) =>
  `PHP ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function main() {
  const { rows } = await dbQuery.query(
    `SELECT d.id,
            d.booking_id,
            d.status,
            d.total_amount,
            d.servana_share,
            d.worker_share,
            b.final_price,
            COALESCE((
              SELECT SUM(p.amount)
              FROM ${schema}.payments p
              WHERE p.booking_id = b.id
                AND p.additional_request_id IS NOT NULL
                AND p.status = 'PAID'
            ), 0) AS additional_paid
     FROM ${schema}.disbursements d
     JOIN ${schema}.bookings b ON b.id = d.booking_id
     ORDER BY d.id`,
    []
  );

  if (!rows.length) {
    console.log('No disbursements exist. Nothing to backfill.');
    return;
  }

  let corrected = 0;
  let owedTotal = 0;
  const released: string[] = [];

  for (const r of rows) {
    const basis = Number(r.final_price) + Number(r.additional_paid || 0);
    const want = splitRevenue(basis);
    const have = Number(r.worker_share);

    if (Math.abs(want.providerShare - have) < 0.005) continue; // already correct

    const delta = want.providerShare - have;

    if (r.status !== 'PENDING') {
      released.push(
        `  booking #${r.booking_id} (disbursement ${r.id}, ${r.status}) ` +
          `underpaid by ${peso(delta)} — needs manual settlement`
      );
      continue;
    }

    corrected++;
    owedTotal += delta;
    console.log(
      `  booking #${r.booking_id}: basis ${peso(Number(r.total_amount))} -> ${peso(want.totalAmount)}, ` +
        `provider ${peso(have)} -> ${peso(want.providerShare)}  (${delta >= 0 ? '+' : ''}${peso(delta)})`
    );

    if (APPLY) {
      await dbQuery.query(
        `UPDATE ${schema}.disbursements
         SET total_amount = $2, servana_share = $3, worker_share = $4, updated_at = NOW()
         WHERE id = $1 AND status = 'PENDING'`,
        [r.id, want.totalAmount, want.servanaShare, want.providerShare]
      );
    }
  }

  console.log('');
  console.log(`Scanned ${rows.length} disbursement(s).`);
  console.log(`${corrected} PENDING row(s) ${APPLY ? 'corrected' : 'would be corrected'}.`);
  if (corrected) console.log(`Net additional provider pay: ${peso(owedTotal)}`);

  if (released.length) {
    console.log('');
    console.log('ALREADY RELEASED — not rewritten, settle these by hand:');
    released.forEach((l) => console.log(l));
  }

  if (!APPLY && corrected) {
    console.log('');
    console.log('DRY RUN. Re-run with --apply to write these changes.');
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('backfill failed:', e.message);
    process.exit(1);
  });
