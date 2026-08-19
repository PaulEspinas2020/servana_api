/**
 * Does the schema this repository BUILDS contain everything the code READS?
 *
 * ## Why this exists
 *
 * On 19 August 2026 every catalog read on production returned 500 while the
 * test suite was green — 278 suites, 5,957 tests — and `/healthz` returned 200
 * throughout. The application code and the migration chain in this repository
 * are mutually consistent: replaying the chain in PGlite reaches 132 tables and
 * every catalog query resolves. Production disagreed with both.
 *
 * Nothing was watching for that. The tests mock the database, so they cannot
 * see a table that is not there; the fresh-db gate proves migrations RUN but
 * never asks whether the code can read what they produce; and a health check
 * that does not touch the read path reports health during a total outage.
 *
 * This closes the gap between those two: it executes the migration chain, then
 * asserts that every schema-qualified relation the source references actually
 * exists in the result.
 *
 * ## What it catches
 *
 * A query naming a table or column the chain never creates — the shape of the
 * catalog outage, and the shape any rename produces when code and schema move
 * at different speeds. The catalog-v2 sequence renames `catalog_services` to
 * `services` and the legacy `services` to `service_families` (024), which is
 * exactly the manoeuvre where a half-applied chain leaves readable SQL pointing
 * at a relation that is no longer there.
 *
 * ## What it does NOT catch
 *
 * It compares the code against the schema THIS REPOSITORY produces, not against
 * production. A production database that has drifted from the chain is invisible
 * here by construction — that is what the readiness endpoint and the synthetic
 * check are for. This gate proves the repository is self-consistent, which is a
 * precondition for diagnosing drift rather than a substitute for it.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..', 'src');

/** Every `${anything}.relation` or `servana.relation` the source names. */
export const relationsReferencedInSource = (): Map<string, string[]> => {
  const found = new Map<string, string[]>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!p.endsWith('.ts')) continue;
      const text = readFileSync(p, 'utf8');

      /**
       * Only variables actually BOUND to the schema count.
       *
       * `${dbSchema}.services` is a schema-qualified table. `${b}.status` is a
       * column behind a SQL table alias, and the two are indistinguishable by
       * shape — a naive pattern reports `status`, `revenue`, `slots` and
       * `worker_uid` as missing tables, which is noise that would get this gate
       * switched off within a week.
       *
       * The binding is unambiguous in source: `const dbSchema = db.schema` or
       * `const s = db.schema`. Anything not bound that way is an alias.
       */
      const schemaVars = new Set<string>(
        [...text.matchAll(/const\s+([A-Za-z_]\w*)\s*=\s*(?:db|database)\.schema\b/g)].map(
          (b) => b[1],
        ),
      );
      if (schemaVars.size === 0) continue;

      /**
       * A bare `servana.` literal is deliberately NOT matched. The only place it
       * appears in this codebase is `servana.com.ph` in URLs and allow-lists,
       * which reports `com` as a missing table — noise that discredits the gate.
       * Every real query interpolates the schema variable.
       */
      const alternatives = [...schemaVars].map((v) => `\\$\\{${v}\\}`);
      const re = new RegExp(`(?:${alternatives.join('|')})\\.([a-z_][a-z0-9_]*)`, 'g');

      // Line comments carry commented-out SQL — `// LEFT JOIN ${dbSchema}.x` —
      // which names a relation nothing executes.
      const executable = text
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*)/.test(line))
        .join('\n');

      let m: RegExpExecArray | null;
      while ((m = re.exec(executable)) !== null) {
        const rel = m[1];

        // `CREATE FUNCTION ${s}.name(` and `EXECUTE FUNCTION ${s}.name(` are
        // routines, not relations. A trailing `(` is the discriminator.
        const after = executable.slice(m.index + m[0].length, m.index + m[0].length + 1);
        if (after === '(') continue;
        const list = found.get(rel) ?? [];
        if (!list.includes(p)) list.push(p);
        found.set(rel, list);
      }
    }
  };
  walk(SRC);
  return found;
};

/**
 * Relations that are not tables and must not be reported missing.
 *
 * Kept explicit and small. A generous ignore list turns this gate into
 * decoration, so anything added here needs a reason beside it.
 */
export const NON_RELATIONS = new Set<string>([
  // Postgres catalog and information schema, named directly in checks.
  'tables', 'columns', 'constraint_column_usage', 'key_column_usage',
  'table_constraints', 'referential_constraints', 'schemata', 'routines',
  'sequences', 'views', 'triggers', 'check_constraints',
]);

export const missingRelations = (
  referenced: Map<string, string[]>,
  present: Set<string>,
): Array<{ relation: string; files: string[] }> =>
  [...referenced.entries()]
    .filter(([rel]) => !present.has(rel) && !NON_RELATIONS.has(rel))
    .map(([relation, files]) => ({ relation, files }))
    .sort((a, b) => a.relation.localeCompare(b.relation));
