/**
 * The real-PostgreSQL connection for the concurrency suite.
 *
 * Everything else in this repository proves the executor ASKS for the right
 * locks. Nothing proves PostgreSQL HONOURS them. That gap closes only against
 * a real server: `FOR UPDATE`, `pg_advisory_xact_lock`, concurrent commits,
 * rollbacks and deadlock behaviour cannot be faked, and a fake that appeared
 * to prove them would be worse than an open gap.
 *
 * ## It will not touch production, and it will not guess
 *
 * Three independent refusals, because one is a preference and three are a
 * policy:
 *
 *   1. DEDICATED variables. `PG_RACE_TEST_*`, never `DB_*`. There is no
 *      fallback to the application's own credentials — a fallback is how a
 *      concurrency suite ends up running against production at 2am.
 *   2. An explicit opt-in, `ALLOW_POSTGRES_RACE_TESTS=true`. Configuration
 *      alone is not consent.
 *   3. The database NAME must look disposable. These tests create, mutate and
 *      destroy rows; a name that could plausibly be real is refused outright.
 *
 * ## Why it SKIPS rather than fails when unconfigured
 *
 * A developer with no database should not see a red suite they cannot fix.
 * But the skip is loud, and the certification document carries
 * `BLOCKED_BY_TEST_DATABASE` — not PASS — until this has actually run. A
 * skipped proof is an open gap, and it is recorded as one.
 */

import { Pool, type PoolClient } from 'pg';

export interface RaceDatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  /** `src/config.ts` reads SCHEMA; the snapshot must say which one it restored. */
  schema: string;
}

/** Names that read as disposable. Anything else is refused. */
const DISPOSABLE_NAME = /(^|_)(race|concurrency|test|tmp|scratch)(_|$)/i;

/** Names that must never be accepted, whatever else they also contain. */
const FORBIDDEN_NAME = /prod|production|live|servana$/i;

export type RaceDatabaseStatus =
  | { usable: true; config: RaceDatabaseConfig }
  | { usable: false; reason: string };

export function resolveRaceDatabase(env: NodeJS.ProcessEnv = process.env): RaceDatabaseStatus {
  if (String(env.ALLOW_POSTGRES_RACE_TESTS ?? '').toLowerCase() !== 'true') {
    return {
      usable: false,
      reason:
        'ALLOW_POSTGRES_RACE_TESTS is not "true". These tests create and destroy '
        + 'rows, so they require explicit consent rather than merely a reachable '
        + 'database.',
    };
  }

  const host = env.PG_RACE_TEST_HOST;
  const database = env.PG_RACE_TEST_DATABASE;
  const user = env.PG_RACE_TEST_USER;
  const password = env.PG_RACE_TEST_PASSWORD;
  const port = Number(env.PG_RACE_TEST_PORT ?? 5432);

  const missing = [
    !host && 'PG_RACE_TEST_HOST',
    !database && 'PG_RACE_TEST_DATABASE',
    !user && 'PG_RACE_TEST_USER',
    !password && 'PG_RACE_TEST_PASSWORD',
  ].filter(Boolean);

  if (missing.length) {
    return {
      usable: false,
      reason:
        `Missing ${missing.join(', ')}. These are DELIBERATELY separate from the `
        + 'application\'s DB_* variables: there is no fallback, because a fallback '
        + 'is how a concurrency suite ends up pointed at production.',
    };
  }

  if (FORBIDDEN_NAME.test(database!)) {
    return {
      usable: false,
      reason:
        `Refusing to run against a database named "${database}". The name matches `
        + 'a production-looking pattern, and this suite destroys data.',
    };
  }

  if (!DISPOSABLE_NAME.test(database!)) {
    return {
      usable: false,
      reason:
        `Refusing to run against "${database}": the name does not read as `
        + 'disposable. Use something unmistakable such as servana_race_test or '
        + 'servana_concurrency_ci.',
    };
  }

  return {
    usable: true,
    config: {
      host: host!,
      port,
      database: database!,
      user: user!,
      password: password!,
      schema: env.PG_RACE_TEST_SCHEMA || 'servana',
    },
  };
}

/**
 * Points the APPLICATION's pool at the race database, for this process only.
 *
 * The executor is the thing under test and it uses `src/db/dbQuery`'s pool,
 * built from `DB_*` at import time. So the race database has to arrive through
 * those variables — there is no injection seam, and inventing one purely for a
 * test would change the code the test is supposed to certify.
 *
 * The direction matters. This never reads `DB_*`; it only ever WRITES them,
 * and only from a config that has already passed all three refusals in
 * `resolveRaceDatabase`. When the suite is unconfigured this function is never
 * reached, so there is no path on which an unconfigured run touches whatever
 * `DB_*` happened to contain.
 *
 * Must be called BEFORE the executor is imported. `src/config.ts` snapshots the
 * environment at module load, so an import that has already happened keeps the
 * old pool.
 */
export function pointApplicationPoolAtRaceDatabase(
  config: RaceDatabaseConfig,
  env: NodeJS.ProcessEnv = process.env,
): void {
  env.DB_HOST = config.host;
  env.DB_PORT = String(config.port);
  env.DB_DATABASE = config.database;
  env.DB_USER = config.user;
  env.DB_PASSWORD = config.password;
  env.SCHEMA = config.schema;
}

/**
 * Two independent connections, which is the entire point.
 *
 * A race needs two real sessions. Running both "transactions" on one pooled
 * client proves nothing about locking — it proves a single session can execute
 * two statements in order.
 */
export class RaceHarness {
  private pool: Pool;

  constructor(private readonly config: RaceDatabaseConfig) {
    this.pool = new Pool({ ...config, max: 8 });
  }

  async client(): Promise<PoolClient> {
    return this.pool.connect();
  }

  /** The PostgreSQL major version actually under test, for the record. */
  async serverMajorVersion(): Promise<number> {
    const c = await this.pool.connect();
    try {
      const r = await c.query('SHOW server_version');
      return Number(String(r.rows[0].server_version).split('.')[0]);
    } finally {
      c.release();
    }
  }

  /**
   * Runs two operations so they genuinely contend.
   *
   * Both are started before either is awaited, so each opens its own connection
   * and its own transaction and the second really does block on the first's
   * locks. Awaiting the first and then starting the second would be two
   * sequential calls wearing a costume.
   *
   * Neither side may reject out of here: a race has two OUTCOMES, and a
   * refusal is one of them. `Promise.allSettled` keeps the loser's error as a
   * value so the caller can assert what KIND of loss it was — a domain refusal
   * and a driver crash are not the same result.
   */
  async contend<A, B>(a: () => Promise<A>, b: () => Promise<B>): Promise<{ a: A | Error; b: B | Error }> {
    const pa = a();
    const pb = b();
    const settle = await Promise.allSettled([pa, pb]);
    return {
      a: settle[0].status === 'fulfilled' ? settle[0].value : (settle[0].reason as Error),
      b: settle[1].status === 'fulfilled' ? settle[1].value : (settle[1].reason as Error),
    };
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * A PostgreSQL deadlock is a FAILURE here, not a successful serialisation.
 *
 * The whole point of standardising on booking-then-provider lock order is that
 * the deadlock never forms. `40P01` means the order was violated somewhere and
 * PostgreSQL cleaned up after us, which is not the same as being correct.
 */
export const isDeadlock = (error: unknown): boolean =>
  !!error && typeof error === 'object' && (error as { code?: string }).code === '40P01';
