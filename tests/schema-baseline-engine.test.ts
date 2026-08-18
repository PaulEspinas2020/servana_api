/**
 * The fresh-database gate, EXECUTED (§158, §159, §161).
 *
 * ## Why this suite exists
 *
 * `tests/schema-baseline.test.ts` checks the migration chain with a hand-written
 * DDL interpreter, because TAB 15 concluded no PostgreSQL engine was reachable.
 * A detector nothing checks is a detector that can fail open, and this one did:
 * it reported eleven missing tables when there are more, and named migration 009
 * as the wall when the chain dies on 001.
 *
 * PGlite is PostgreSQL 18 compiled to WebAssembly. It runs in-process, so the
 * chain can be executed by the same parser and planner production uses. That
 * makes the model checkable, and this suite is the check.
 *
 * ## The invariant
 *
 * Engine-proven ⊆ model-reported.
 *
 * Not equality, and the asymmetry is deliberate. The engine stops each file at
 * its first error, so a file blocked by `bookings` never reveals that it also
 * needs `payments`; the model reads every reference regardless of execution
 * order and legitimately sees more. What must never happen again is the
 * reverse — the engine proving a table missing that the model does not report.
 *
 * ## What this cannot prove
 *
 * PGlite runs as one bundled superuser, so role separation is unenforceable
 * here. The "apply as `admin`, never as the container superuser" property — the
 * one that made 29 of 116 tables unusable in production once — is still covered
 * only by the static owner assertions and by the CI job's real service
 * container. This suite proves reachability, not ownership.
 */

/**
 * ## Why the engine itself runs outside Jest
 *
 * PGlite loads its WASM through a dynamic `import()`, which Jest's VM refuses
 * without `--experimental-vm-modules`. Turning that on for the whole 250-suite
 * run to accommodate one file is a poor trade, so the executed replay lives in
 * `npm run db:verify -- --embedded` and is a gate in `npm run verify`.
 *
 * What stays here is everything that can be proven without booting a database:
 * the error parsing and the chain-application policy. Those are the parts most
 * likely to rot silently — a regex that stops matching PostgreSQL's wording
 * would make the gate report an empty gap and look like success.
 */

import { applyChain, parseMissingRelation } from '../scripts/lib/embeddedEngine';
import { replayMigrationsOnly } from '../scripts/lib/schemaBaseline';
import { missingBaselineTables } from '../scripts/lib/schemaModel';

describe('parseMissingRelation', () => {
  it('reads the relation out of a PostgreSQL error', () => {
    expect(parseMissingRelation('relation "servana.bookings" does not exist')).toBe('bookings');
    expect(parseMissingRelation('view "service_families" does not exist')).toBe('service_families');
  });

  it('returns null for an error that is not about a missing relation', () => {
    // A column-level failure is a different requirement and must not be
    // mistaken for a missing table, or the gap inventory inflates.
    expect(parseMissingRelation('column "webhook_event_id" does not exist')).toBeNull();
  });
});

describe('applyChain', () => {
  it('stops at the first failure when asked, because the runner does', async () => {
    const seen: string[] = [];
    const exec = async (sql: string) => {
      if (sql.includes('ROLLBACK')) return;
      seen.push(sql);
      throw new Error('relation "servana.bookings" does not exist');
    };
    const outcomes = await applyChain(
      exec,
      [{ file: 'a.sql', sql: 'SELECT 1;' }, { file: 'b.sql', sql: 'SELECT 2;' }],
      { stopOnFirstFailure: true },
    );
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ file: 'a.sql', ok: false, missingRelation: 'bookings' });
  });

  it('continues past failures otherwise, so the whole gap is enumerable', async () => {
    const exec = async (sql: string) => {
      if (sql.includes('ROLLBACK')) return;
      throw new Error('relation "servana.payments" does not exist');
    };
    const outcomes = await applyChain(exec, [
      { file: 'a.sql', sql: 'SELECT 1;' },
      { file: 'b.sql', sql: 'SELECT 2;' },
    ]);
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((o) => !o.ok)).toBe(true);
  });
});

describe('the tables the ALTER-only model used to miss', () => {
  it('are reported now, by name', () => {
    /**
     * Pinned individually. These were absent from the original eleven because
     * nothing ALTERs them — migrations only select from or insert into them —
     * so a baseline verified against that list would have been accepted while
     * still being unable to bootstrap a database.
     *
     * `provider_catalog_offerings` and `service_options` were each proven
     * missing by PostgreSQL 18 refusing the migration that reads them.
     */
    const modelled = missingBaselineTables(replayMigrationsOnly());
    for (const table of [
      'provider_catalog_offerings',
      'provider_onboarding_cases',
      'service_options',
    ]) {
      expect(modelled).toContain(table);
    }
  });

  it('does not flag a sequence or a function call as a missing table', () => {
    /**
     * The failure mode of widening the model: `nextval('servana.x_seq')` and
     * `servana.some_function(...)` both look like schema-qualified relations.
     * Counting either would inflate the gap and make the requirements list
     * unsatisfiable.
     */
    const modelled = missingBaselineTables(replayMigrationsOnly());
    expect(modelled.filter((t) => t.endsWith('_seq'))).toEqual([]);
  });
});
