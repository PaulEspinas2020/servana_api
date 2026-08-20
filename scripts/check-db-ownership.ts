/**
 * Fails if anything in the `servana` schema is not owned by the application role.
 *
 * WHY THIS EXISTS
 *
 * On 2026-08-10 document upload returned "Something went wrong on our side" for
 * every provider. The cause was not the upload code: 29 of the 116 tables in the
 * schema were owned by `postgres` and the app's `admin` role had no privileges
 * on any of them. Writing a verification event raised Postgres 42501
 * (permission denied), the raw error escaped with no `statusCode`, and the
 * controller turned it into a bare 500.
 *
 * It was invisible for three reasons at once: the error was swallowed without a
 * log, 87 tables DID work so most of the app behaved, and the failing tables
 * clustered in newer features (support cases, reviews, verification events,
 * profile revisions) that nobody exercised often.
 *
 * How it happened: the deploy applies migrations as `psql -U admin`, so those
 * tables belong to `admin`. Anything applied by hand as
 * `sudo -u postgres psql` belongs to `postgres` instead — and the repo's own
 * history records migrations being half-applied that way.
 *
 * This is a CHECK, not a repair. Reassigning ownership requires being the owner
 * or a superuser, which `admin` is not, so a migration cannot fix it — the
 * remedy has to be run as `postgres`:
 *
 *   DO $$ DECLARE r record; BEGIN
 *     FOR r IN SELECT tablename FROM pg_tables
 *               WHERE schemaname='servana' AND tableowner <> 'admin' LOOP
 *       EXECUTE format('ALTER TABLE servana.%I OWNER TO admin', r.tablename);
 *     END LOOP;
 *   END $$;
 *
 * Run: npm run check:db-ownership
 */
import { pool } from '../src/db/dbQuery';
import { db } from '../src/config';

const SCHEMA = String(db.schema ?? 'servana');
const APP_ROLE = String(db.user ?? 'admin');

async function main() {
  const client = await pool.connect();
  try {
    const tables = await client.query(
      `SELECT tablename AS name, tableowner AS owner
         FROM pg_tables WHERE schemaname = $1 AND tableowner <> $2
        ORDER BY tablename`,
      [SCHEMA, APP_ROLE],
    );
    const sequences = await client.query(
      `SELECT sequencename AS name, sequenceowner AS owner
         FROM pg_sequences WHERE schemaname = $1 AND sequenceowner <> $2
        ORDER BY sequencename`,
      [SCHEMA, APP_ROLE],
    );

    const total = await client.query(
      `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = $1`,
      [SCHEMA],
    );

    // pg types rowCount as `number | null`. It is null for statements that
    // return no result set, never for a SELECT — but `null + null` is 0 and
    // would report a clean ownership check on a query that returned nothing.
    const bad = (tables.rowCount ?? 0) + (sequences.rowCount ?? 0);
    if (bad === 0) {
      console.log(`check-db-ownership: OK — all ${total.rows[0].n} tables and every sequence in "${SCHEMA}" are owned by "${APP_ROLE}".`);
      return 0;
    }

    console.error(`check-db-ownership: ${bad} object(s) in "${SCHEMA}" are NOT owned by "${APP_ROLE}".`);
    console.error('The application will fail with Postgres 42501 (permission denied) on every one of them,');
    console.error('and the controller will report it to the provider as a generic 500.\n');
    for (const r of tables.rows) console.error(`  table     ${r.name}  (owner: ${r.owner})`);
    for (const r of sequences.rows) console.error(`  sequence  ${r.name}  (owner: ${r.owner})`);
    console.error('\nFix as postgres — see the header of this file for the statement.');
    return 1;
  } finally {
    client.release();
  }
}

main()
  .then((code) => { process.exit(code); })
  .catch((err) => {
    console.error('check-db-ownership: could not run:', err?.message ?? err);
    process.exit(2);
  });
