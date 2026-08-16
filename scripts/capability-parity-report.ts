/**
 * Is `catalog_provider_services` complete enough to stand alone yet?
 *
 * Read-only by default. Reports the adoption gap the matching fallback is
 * currently carrying:
 *
 *   npm run capability:parity      measure, change nothing
 *   npm run capability:reconcile   project the missing rows, then re-measure
 *
 * ## Why this exists rather than "the migration ran, so it is fine"
 *
 * Migration 029 backfills and guards at the moment it runs. Grants made
 * afterwards are projected by the writers — but a writer added later without a
 * projection, a deploy window, or a direct SQL grant by an operator all produce
 * legacy-only rows that nothing would notice. The fallback keeps those
 * providers assignable, which is the point, and it also hides the drift.
 *
 * So the number is measured on demand, and `CANONICAL_ADOPTION_CRITERIA`
 * requires it to be clean before the fallback is removed.
 *
 * ## Safety
 *
 * `--apply` writes ONLY into `catalog_provider_services`, and only rows that
 * legacy grants already imply. It cannot widen capability: every row it writes
 * corresponds to a permission the provider already has at the family grain. It
 * touches no legacy table, no provider record and no booking.
 *
 * Refuses a remote database unless CAPABILITY_REMOTE_ACK names it exactly,
 * mirroring `run-migrations.ts` — the same reasoning, the same guard.
 */

import { pool } from '../src/db/dbQuery';
import { db } from '../src/config';
import {
  CAPABILITY_PARITY_SQL,
  readParityRow,
  supplyCollapseVerdict,
  type CapabilityParity,
} from '../src/services/booking/capabilityProjection';

const apply = process.argv.includes('--apply');
const schema = db.schema;

/** Every legacy grant with no canonical counterpart, projected in one statement. */
const RECONCILE_SQL = `
  INSERT INTO ${schema}.catalog_provider_services
    (provider_uid, service_id, status, legacy_service_family_id, source)
  SELECT l.provider_uid, l.service_id, 'active', l.family_id, 'migrated_from_family'
    FROM (
      SELECT es.employee_uid AS provider_uid, s.id AS service_id, es.service_id AS family_id
        FROM ${schema}.employee_services es
        JOIN ${schema}.services s ON s.legacy_service_family_id = es.service_id
      UNION
      SELECT wsa.worker_uid, s.id, wsa.service_id
        FROM ${schema}.worker_service_applications wsa
        JOIN ${schema}.services s ON s.legacy_service_family_id = wsa.service_id
       WHERE wsa.status = 'approved'
    ) l
   ON CONFLICT (provider_uid, service_id) DO NOTHING`;

const report = (label: string, parity: CapabilityParity): void => {
  const verdict = supplyCollapseVerdict(parity);
  console.log(JSON.stringify({
    label,
    schema,
    target: `${db.host}/${db.database}`,
    ...parity,
    safeToRetireFallback: verdict.safeToRetireFallback,
    detail: verdict.detail,
  }, null, 2));
};

async function main(): Promise<void> {
  const host = String(db.host ?? '');
  const database = String(db.database ?? '');
  if (!host || !database) throw new Error('Database configuration is incomplete; nothing was attempted.');

  const local = /^(localhost|127\.0\.0\.1|::1)$/i.test(host);
  if (apply && !local && process.env.CAPABILITY_REMOTE_ACK !== `${host}/${database}`) {
    throw new Error(`Remote reconcile refused. Set CAPABILITY_REMOTE_ACK exactly to ${host}/${database}.`);
  }

  const client = await pool.connect();
  try {
    const before = readParityRow((await client.query(CAPABILITY_PARITY_SQL(schema))).rows[0] ?? {});
    report(apply ? 'before' : 'parity', before);

    if (!apply) {
      if (before.legacyOnly > 0) {
        console.log(`\n${before.legacyOnly} legacy-only grant(s). Run "npm run capability:reconcile" to project them.`);
        process.exitCode = 1;
      }
      return;
    }

    await client.query('BEGIN');
    try {
      const written = await client.query(RECONCILE_SQL);
      await client.query('COMMIT');
      console.log(`\nprojected ${written.rowCount ?? 0} canonical row(s)`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }

    const after = readParityRow((await client.query(CAPABILITY_PARITY_SQL(schema))).rows[0] ?? {});
    report('after', after);
    if (after.legacyOnly > 0) process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
