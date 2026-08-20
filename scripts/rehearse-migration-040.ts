/**
 * Execute migration 040 on a real PostgreSQL. Nothing else does.
 *
 * Same reason as `rehearse-migration-039.ts`: `db:verify:embedded` does not run
 * a data migration. `verify-baseline-ledger` classifies by declared schema
 * objects, 040 declares none, so it lands in the "no schema effect" bucket and
 * is marked applied before the chain runs. The rehearsal would report PASS on a
 * run in which this SQL never executed.
 *
 * PGlite is PostgreSQL 18 compiled to WebAssembly, so the CHECK constraint, the
 * guarded UPDATE and the DO block are all executed by the real engine.
 *
 * Run: npm run migration:040:rehearse
 */

import fs from 'fs';
import path from 'path';

import { createEngine, RUNTIME_ROLE, TARGET_SCHEMA } from './lib/embeddedEngine';

const MIGRATION_FILE = '040-retire-duplicate-massage-subcategory.sql';

const MIGRATION = fs.readFileSync(
  path.resolve(__dirname, 'migrations', MIGRATION_FILE),
  'utf8',
);

/**
 * The two tables 040 touches, from `scripts/baseline/000-baseline.sql`.
 *
 * The CHECK constraint is copied verbatim: it is what decides whether
 * `'archived'` is even a legal value, and a simplified column would let the
 * migration pass here and fail on production.
 */
const SCHEMA_SQL = `
CREATE TABLE ${TARGET_SCHEMA}.catalog_categories (
  id integer NOT NULL PRIMARY KEY,
  name character varying NOT NULL,
  status character varying NOT NULL
    CHECK (status IN ('draft','active','inactive','archived'))
);

CREATE TABLE ${TARGET_SCHEMA}.catalog_subcategories (
  id integer NOT NULL PRIMARY KEY,
  category_id integer NOT NULL,
  name character varying NOT NULL,
  display_order integer DEFAULT 0,
  status character varying NOT NULL
    CHECK (status IN ('draft','active','inactive','archived')),
  legacy_service_family_id integer,
  created_at timestamptz DEFAULT NOW(),
  updated_at timestamptz DEFAULT NOW(),
  archived_at timestamptz
);
`;

/** Production's Personal Care rows on 2026-08-20. */
const SEED = `
INSERT INTO ${TARGET_SCHEMA}.catalog_categories (id, name, status)
VALUES (3, 'Personal Care', 'active');

INSERT INTO ${TARGET_SCHEMA}.catalog_subcategories
  (id, category_id, name, display_order, status, legacy_service_family_id)
VALUES
  ( 9, 3, 'Hair',               0, 'active', 2),
  (10, 3, 'Massage',            0, 'active', 2),
  (11, 3, 'Massage & Wellness', 0, 'active', 52),
  (12, 3, 'Nails',              0, 'active', 2);
`;

type Engine = Awaited<ReturnType<typeof createEngine>>;

const freshDatabase = async (seed = SEED): Promise<Engine> => {
  const db = await createEngine();
  await db.exec(
    `CREATE ROLE ${RUNTIME_ROLE};
     CREATE SCHEMA IF NOT EXISTS ${TARGET_SCHEMA} AUTHORIZATION ${RUNTIME_ROLE};`,
  );
  await db.exec(SCHEMA_SQL);
  await db.exec(seed);
  return db;
};

const scalar = async (db: Engine, sql: string): Promise<string> => {
  const result: any = await db.query(sql);
  return String(Object.values(result.rows[0] ?? {})[0] ?? '');
};

/** What `getPublicCatalog` would return: active subcategories of active categories. */
const visibleSubcategories = async (db: Engine): Promise<string[]> => {
  const result: any = await db.query(
    `SELECT sc.name FROM ${TARGET_SCHEMA}.catalog_subcategories sc
       JOIN ${TARGET_SCHEMA}.catalog_categories c ON c.id = sc.category_id
      WHERE sc.status = 'active' AND c.status = 'active'
      ORDER BY sc.name`,
  );
  return result.rows.map((r: { name: string }) => r.name);
};

const failures: string[] = [];

const check = (name: string, condition: boolean, detail = ''): void => {
  if (condition) {
    console.log(`    pass  ${name}`);
  } else {
    console.log(`    FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    failures.push(name);
  }
};

/**
 * Runs the migration and reports a throw as a named failure.
 *
 * Returns false when it threw, so a caller can stop rather than assert against
 * a database the migration did not finish with.
 */
const apply = async (db: Engine, what: string): Promise<boolean> => {
  try {
    await db.exec(MIGRATION);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(what, false, message.split('\n')[0]);
    return false;
  }
};

async function main(): Promise<void> {
  console.log(`\nServana — executed rehearsal of ${MIGRATION_FILE}`);
  console.log('  EMBEDDED PostgreSQL (PGlite, in-process)\n');

  // ── The state it starts from ───────────────────────────────────────────────
  {
    const db = await freshDatabase();
    try {
      const before = await visibleSubcategories(db);
      check('starts with BOTH massage sections visible',
        before.filter((n) => /massage/i.test(n)).length === 2,
        before.join(', '));
    } finally {
      await db.close();
    }
  }

  // ── What it does ───────────────────────────────────────────────────────────
  {
    const db = await freshDatabase();
    try {
      // Applied through `apply`, not a bare `exec`.
      //
      // A bare await here dumps PGlite's whole error object — including the
      // migration's own SQL, reprinted line by line — and the run ends with no
      // RESULT line at all. A harness must NAME the failure: pointing this
      // migration at the wrong subcategory id produced ninety lines of noise
      // and no verdict, which is indistinguishable from the harness crashing.
      if (!(await apply(db, 'the migration runs on a correct catalogue'))) {
        return;
      }
      const after = await visibleSubcategories(db);

      check('exactly one massage section remains',
        after.filter((n) => /massage/i.test(n)).length === 1, after.join(', '));
      check('the one that remains is "Massage" (legacy family 2)',
        after.includes('Massage') && !after.includes('Massage & Wellness'),
        after.join(', '));
      check('Hair and Nails are untouched',
        after.includes('Hair') && after.includes('Nails'), after.join(', '));

      check('the row is archived, not deleted',
        (await scalar(db,
          `SELECT COUNT(*) FROM ${TARGET_SCHEMA}.catalog_subcategories WHERE id = 11`)) === '1');
      check('archived_at is stamped',
        (await scalar(db,
          `SELECT archived_at IS NOT NULL FROM ${TARGET_SCHEMA}.catalog_subcategories WHERE id = 11`)) === 'true');
    } finally {
      await db.close();
    }
  }

  // ── Idempotency ────────────────────────────────────────────────────────────
  {
    const db = await freshDatabase();
    try {
      await db.exec(MIGRATION);
      const stampedAt = await scalar(db,
        `SELECT archived_at FROM ${TARGET_SCHEMA}.catalog_subcategories WHERE id = 11`);
      await db.exec(MIGRATION);
      const stampedAgain = await scalar(db,
        `SELECT archived_at FROM ${TARGET_SCHEMA}.catalog_subcategories WHERE id = 11`);

      check('a second run changes nothing', stampedAt === stampedAgain,
        `${stampedAt} then ${stampedAgain}`);
    } finally {
      await db.close();
    }
  }

  // ── Rollback is exact ──────────────────────────────────────────────────────
  {
    const db = await freshDatabase();
    try {
      await db.exec(MIGRATION);
      await db.exec(`UPDATE ${TARGET_SCHEMA}.catalog_subcategories
                        SET status = 'active', archived_at = NULL WHERE id = 11;`);
      const restored = await visibleSubcategories(db);

      check('the documented rollback restores the section',
        restored.filter((n) => /massage/i.test(n)).length === 2,
        restored.join(', '));
    } finally {
      await db.close();
    }
  }

  // ── It refuses to retire the wrong row ─────────────────────────────────────
  {
    // Identity is re-asserted rather than assumed. Against a catalogue seeded
    // differently, "whatever is row 11" could be any section at all — so the
    // guards must hold AND the postcondition must catch the no-op.
    const renamed = SEED.replace("'Massage & Wellness', 0, 'active', 52",
                                 "'Aromatherapy', 0, 'active', 52");
    const db = await freshDatabase(renamed);
    try {
      let threw = '';
      try {
        await db.exec(MIGRATION);
      } catch (error) {
        threw = error instanceof Error ? error.message : String(error);
      }

      check('a renamed row 11 is refused, not archived',
        /postcondition failed/i.test(threw), threw.split('\n')[0] || 'it did not throw');
      check('and that row is left alone',
        (await scalar(db,
          `SELECT status FROM ${TARGET_SCHEMA}.catalog_subcategories WHERE id = 11`)) === 'active');
    } finally {
      await db.close();
    }
  }

  console.log(
    `\n  RESULT: ${failures.length === 0 ? 'PASS' : `FAIL — ${failures.join(', ')}`}\n`,
  );
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
