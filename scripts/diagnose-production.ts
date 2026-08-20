/**
 * Read-only production diagnosis for the 2026-08-19 catalog outage.
 *
 *   npm run db:diagnose
 *
 * Run it ON the production host, in the same environment the app runs in. It
 * reads `DB_*` and `SCHEMA` from the process environment exactly as
 * `src/config.ts` does, so it carries no credential of its own and connects the
 * way the application connects. If the app cannot reach the database, neither
 * can this — and that is itself the answer.
 *
 * ## Read-only, and enforced rather than promised
 *
 * Every query is a hard-coded SELECT with no interpolated input. The session is
 * additionally opened as `SET default_transaction_read_only = on`, so the
 * database itself refuses a write even if somebody edits a query into this file
 * later. A statement timeout bounds every call, because a diagnostic that can
 * pin a table on a system already in trouble is a second incident.
 *
 * ## What it settles
 *
 * The outage was traced to `/readyz`:
 *
 *     SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string
 *
 * — the process could not authenticate to Postgres at boot. That explains the
 * 500s. It does NOT settle three things this programme could not answer without
 * database access, and each has a consequence:
 *
 *   1. Can the runtime role actually SELECT the catalog tables? An ownership
 *      fault previously made 29 of 116 tables unusable on this platform, and
 *      `024-catalog-v2-canonical-rename.sql` carries an explicit `OWNER TO
 *      admin` because of it. If the password is fixed and the catalog is still
 *      500, this is where to look.
 *   2. Does `servana.locations` exist? `npm run db:skew` found the admin
 *      booking path queries it and no migration creates it. The recaptured
 *      production baseline says it is absent — this confirms against the live
 *      database rather than a dump.
 *   3. Is the ledger consistent with the schema? A repaired checksum on a
 *      migration that never fully applied is a ledger that lies convincingly.
 */

import { Pool, type QueryResultRow } from 'pg';
import { db } from '../src/config';

const SCHEMA = db.schema || 'servana';

const CATALOG_TABLES = ['services', 'service_families', 'catalog_categories', 'catalog_subcategories'];

const main = async (): Promise<number> => {
  const missing = (['user', 'host', 'database', 'password'] as const).filter((k) => !db[k]);
  if (missing.length) {
    console.error(`  FAIL  DB_${missing.map((m) => m.toUpperCase()).join(', DB_')} not set in this environment.`);
    console.error('        Run this on the production host, in the same environment as the app.');
    return 2;
  }

  const pool = new Pool({
    user: db.user,
    host: db.host,
    database: db.database,
    password: db.password,
    port: db.port ? parseInt(db.port, 10) : 5432,
    max: 1,
    connectionTimeoutMillis: 8000,
    // Read-only at the session level, so the database refuses a write even if
    // this file is edited later. Belt and braces, deliberately.
    options: `-c default_transaction_read_only=on -c statement_timeout=10000`,
  });

  const q = async <T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ) =>
    (await pool.query<T>(sql, params)).rows;

  try {
    const [who] = await q<{ user: string; dbname: string; ver: string }>(
      `SELECT current_user AS user, current_database() AS dbname, version() AS ver`,
    );
    console.log(`\n  connected as ${who.user} to ${who.dbname}`);
    console.log(`  ${who.ver.split(',')[0]}`);
    console.log(`  schema: ${SCHEMA}\n`);

    // ── 1. Can this role actually read the catalog? ───────────────────────────
    console.log('  1. CATALOG READABILITY (the unexplained half of the outage)');
    for (const t of CATALOG_TABLES) {
      const [row] = await q<{ present: boolean; owner: string | null; can_select: boolean | null }>(
        `SELECT
           to_regclass($1) IS NOT NULL                              AS present,
           (SELECT tableowner FROM pg_tables
             WHERE schemaname = $2 AND tablename = $3)              AS owner,
           CASE WHEN to_regclass($1) IS NULL THEN NULL
                ELSE has_table_privilege(current_user, $1, 'SELECT') END AS can_select`,
        [`${SCHEMA}.${t}`, SCHEMA, t],
      );
      const state = !row.present
        ? 'ABSENT'
        : row.can_select
          ? `ok        owner=${row.owner}`
          : `NO SELECT owner=${row.owner}   <-- this would 500 every read`;
      console.log(`     ${t.padEnd(24)} ${state}`);
    }

    // A privilege check is not a read. Prove it by reading.
    console.log('\n  2. AN ACTUAL READ (privilege checks can disagree with reality)');
    for (const t of ['services', 'catalog_categories']) {
      try {
        const [row] = await q<{ n: string }>(`SELECT count(*)::text AS n FROM ${SCHEMA}.${t}`);
        console.log(`     SELECT count(*) FROM ${SCHEMA}.${t} -> ${row.n} rows`);
      } catch (e) {
        console.log(`     SELECT count(*) FROM ${SCHEMA}.${t} -> FAILED: ${(e as Error).message}`);
      }
    }

    // ── 3. The db:skew finding, confirmed live ───────────────────────────────
    console.log('\n  3. servana.locations (db:skew said the code reads it and nothing creates it)');
    const [loc] = await q<{ present: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS present`, [
      `${SCHEMA}.locations`,
    ]);
    console.log(
      loc.present
        ? '     present — so it exists as drift outside the migration chain'
        : '     ABSENT  — adminCreateBookingService.ts:430 500s whenever a serviceLocationId is supplied',
    );

    // ── 4. Ledger vs reality ─────────────────────────────────────────────────
    console.log('\n  4. MIGRATION LEDGER');
    const applied = await q<{ migration_name: string }>(
      `SELECT migration_name FROM ${SCHEMA}.schema_migrations ORDER BY migration_name`,
    );
    console.log(`     ${applied.length} migrations recorded as applied`);
    const last = applied.slice(-3).map((r) => r.migration_name);
    console.log(`     most recent: ${last.join(', ')}`);
    const has037 = applied.some((r) => r.migration_name.startsWith('037-'));
    console.log(
      has037
        ? '     037-notification-key-drop-global-uniques.sql: applied'
        : '     037-notification-key-drop-global-uniques.sql: PENDING — the next deploy will run it',
    );

    // ── 5. The columns the catalog query needs ────────────────────────────────
    console.log('\n  5. services COLUMNS the catalog read requires');
    const cols = await q<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'services'`,
      [SCHEMA],
    );
    const have = new Set(cols.map((c) => c.column_name));
    for (const c of ['subcategory_id', 'slug', 'short_description', 'image_url', 'bookable']) {
      console.log(`     ${c.padEnd(20)} ${have.has(c) ? 'present' : 'MISSING'}`);
    }

    console.log('\n  Done. Nothing was written: the session is read-only.\n');
    return 0;
  } catch (e) {
    console.error(`\n  CONNECTION OR QUERY FAILED: ${(e as Error).message}`);
    console.error('  If this is the SASL/password error, the environment this script');
    console.error('  read is the same one the app reads — which is the finding.\n');
    return 1;
  } finally {
    await pool.end();
  }
};

main().then((c) => process.exit(c));
