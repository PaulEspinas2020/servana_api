/**
 * The fresh-database gate, executed against a real PostgreSQL.
 *
 * ## Why this exists
 *
 * TAB 15 originally concluded that no engine was reachable — no `psql`, no
 * `pg_dump`, no Docker — and answered the release gate with `lib/schemaModel.ts`,
 * a hand-written DDL interpreter that replays the chain against a modelled
 * catalog. That was the honest option available at the time, but a detector that
 * only ever validates itself is exactly the kind that fails open, and this one
 * did: it under-reported the gap by three tables and named the wrong migration
 * as the stopping point (see `docs/database/TAB15_CERTIFICATION.md` §1).
 *
 * PGlite is PostgreSQL compiled to WebAssembly. It runs in-process, needs no
 * server, no container and no install beyond an npm dependency, so the chain can
 * now be *executed* by the same parser and planner production runs rather than
 * modelled by a regex. The model stays as the zero-dependency fallback; this is
 * the authority, and `tests/schema-baseline-engine.test.ts` fails the build if
 * the two ever disagree again.
 *
 * ## What it cannot check
 *
 * PGlite runs everything as a single bundled superuser. Role separation is not
 * enforceable inside it, so the "apply as `admin`, never as the container
 * superuser" property — the one that made 29 of 116 tables unusable once — is
 * still only checked by the static owner assertions and by the CI job's real
 * service container. This file proves *reachability*, not *ownership*.
 */

import { stripTransactionControl } from './migrationSafety';
import type { ReplayInput } from './schemaModel';

/** The role migrations expect to own what they create. */
export const RUNTIME_ROLE = 'admin';

/** The schema every migration is written against. No migration creates it. */
export const TARGET_SCHEMA = 'servana';

export interface FileOutcome {
  file: string;
  ok: boolean;
  /** First line of the engine's error, when it failed. */
  error?: string;
  /** `servana.<table>` the engine reported as absent, when that was the cause. */
  missingRelation?: string;
}

export interface EngineReplay {
  outcomes: FileOutcome[];
  /** Files that applied cleanly. */
  applied: number;
  /**
   * Every relation the chain needs that nothing in the chain creates, proven by
   * the engine refusing it. Enumerated by continuing past failures — see
   * `stopOnFirstFailure` for why that differs from what the runner does.
   */
  missingRelations: string[];
  /** The file the real runner would die on, since it throws on first failure. */
  firstFailure: string | null;
  /** Tables present in `servana` after the run. */
  tablesReached: string[];
}

/** `relation "servana.bookings" does not exist` → `bookings`. */
export const parseMissingRelation = (message: string): string | null => {
  const relation = /relation "(?:servana\.)?([\w.]+)" does not exist/i.exec(message);
  if (relation) return relation[1].replace(/^servana\./, '').toLowerCase();
  const view = /view "(?:servana\.)?([\w.]+)" does not exist/i.exec(message);
  if (view) return view[1].replace(/^servana\./, '').toLowerCase();
  return null;
};

/** Anything that can run SQL. Keeps this file free of a driver dependency. */
export type Exec = (sql: string) => Promise<unknown>;

/**
 * Apply a chain of SQL files, each in its own transaction.
 *
 * `stopOnFirstFailure` mirrors `scripts/run-migrations.ts`, which throws as soon
 * as one migration fails — so that mode answers "where does a real deploy die?".
 * Continuing instead answers "what is the *complete* set of things missing?",
 * which is what a baseline has to supply. Both are useful and they are not the
 * same question; reporting only the first would understate the gap exactly the
 * way the static model did.
 */
export const applyChain = async (
  exec: Exec,
  chain: readonly ReplayInput[],
  options: { stopOnFirstFailure?: boolean } = {},
): Promise<FileOutcome[]> => {
  const outcomes: FileOutcome[] = [];
  for (const input of chain) {
    try {
      await exec(`BEGIN; ${stripTransactionControl(input.sql)} ; COMMIT;`);
      outcomes.push({ file: input.file, ok: true });
    } catch (error) {
      await exec('ROLLBACK').catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      const first = message.split('\n')[0];
      outcomes.push({
        file: input.file,
        ok: false,
        error: first,
        missingRelation: parseMissingRelation(message) ?? undefined,
      });
      if (options.stopOnFirstFailure) break;
    }
  }
  return outcomes;
};

/**
 * Boot an in-process PostgreSQL, apply the chain from zero, and report.
 *
 * The role and schema are created first because no migration creates either —
 * the deploy wrapper owns them. Withholding them would make every migration fail
 * for a reason that has nothing to do with the gap being measured.
 */
export const runEmbeddedReplay = async (
  chain: readonly ReplayInput[],
  options: { stopOnFirstFailure?: boolean } = {},
): Promise<EngineReplay> => {
  // Imported lazily so the static gate keeps working without the dependency.
  const { PGlite } = await import('@electric-sql/pglite');
  const db = await PGlite.create();
  try {
    await db.exec(
      `CREATE ROLE ${RUNTIME_ROLE};
       CREATE SCHEMA IF NOT EXISTS ${TARGET_SCHEMA} AUTHORIZATION ${RUNTIME_ROLE};`,
    );

    const outcomes = await applyChain((sql) => db.exec(sql), chain, options);

    const tables = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = $1 ORDER BY 1`,
      [TARGET_SCHEMA],
    );

    const missing = new Set<string>();
    for (const outcome of outcomes) {
      if (outcome.missingRelation) missing.add(outcome.missingRelation);
    }

    return {
      outcomes,
      applied: outcomes.filter((o) => o.ok).length,
      missingRelations: [...missing].sort(),
      firstFailure: outcomes.find((o) => !o.ok)?.file ?? null,
      tablesReached: tables.rows.map((r) => r.table_name).sort(),
    };
  } finally {
    await db.close();
  }
};

/**
 * The complete missing set, found by iterating.
 *
 * One pass only reveals the *first* missing relation per file, because the
 * engine stops at the first error in a statement batch. A file blocked by
 * `bookings` may also need `payments`, and that second need stays invisible
 * until the first is satisfied. So: run, create an empty stand-in for every
 * relation the engine named, run again, and repeat until nothing new appears.
 *
 * The stand-ins are deliberately column-less. They resolve the *name* so the
 * next reference can surface, and they cannot be mistaken for a real baseline —
 * a migration that needs an actual column on one of them still fails, and that
 * failure is itself a proven requirement.
 */
export const enumerateMissingRelations = async (
  chain: readonly ReplayInput[],
  maxRounds = 12,
): Promise<{ relations: string[]; rounds: number; converged: boolean }> => {
  const { PGlite } = await import('@electric-sql/pglite');
  const known = new Set<string>();
  let rounds = 0;

  for (; rounds < maxRounds; rounds += 1) {
    const db = await PGlite.create();
    let discovered = 0;
    try {
      await db.exec(
        `CREATE ROLE ${RUNTIME_ROLE};
         CREATE SCHEMA IF NOT EXISTS ${TARGET_SCHEMA} AUTHORIZATION ${RUNTIME_ROLE};`,
      );
      for (const relation of known) {
        await db.exec(`CREATE TABLE IF NOT EXISTS ${TARGET_SCHEMA}."${relation}"()`);
      }
      const outcomes = await applyChain((sql) => db.exec(sql), chain);
      for (const outcome of outcomes) {
        if (outcome.missingRelation && !known.has(outcome.missingRelation)) {
          known.add(outcome.missingRelation);
          discovered += 1;
        }
      }
    } finally {
      await db.close();
    }
    if (discovered === 0) return { relations: [...known].sort(), rounds: rounds + 1, converged: true };
  }
  return { relations: [...known].sort(), rounds, converged: false };
};
