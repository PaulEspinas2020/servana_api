/**
 * Which authority in this repository creates each object the application can
 * create at runtime (TAB 02).
 *
 * ## Why this exists alongside runtime-ddl-inventory
 *
 * `ddl:inventory` answers "does a MIGRATION own this object", and the answer for
 * 154 statements is no. That number has been read as the size of TAB 02: 154
 * statements to move into migrations, estimated at one to two weeks.
 *
 * It is not, because migrations are no longer the only thing in the repository
 * that builds the schema. TAB 15 added `scripts/baseline/000-baseline.sql` — a
 * pg_dump of production — and `db:verify:embedded` PROVES a fresh database
 * reaches the current schema by restoring that baseline and then applying the
 * pending migrations on top. Anything the baseline declares is therefore already
 * reproducible from this repository without the application issuing any DDL.
 *
 * The inventory predates the baseline being an authority and never learned about
 * it. So it reports the union of two very different problems as one number:
 *
 *   owned_by_migration   a migration builds it. Runtime DDL is redundant.
 *   owned_by_baseline    the baseline builds it. Runtime DDL is redundant too —
 *                        the statement still has to be DELETED for TAB 02's
 *                        acceptance, but nothing needs AUTHORING first.
 *   UNMANAGED            nothing in the repository builds it. A migration has to
 *                        be written before the runtime call can go, and until
 *                        one is, the object exists only where the application
 *                        has already run.
 *
 * Only the third class is authoring work. Separating them turns "154 statements,
 * multi-week" into a deletion backlog plus a short, specific authoring list.
 *
 * ## Why columns are checked separately
 *
 * pg_dump folds columns into `CREATE TABLE`, so object-level matching says
 * nothing about a column. `ALTER TABLE booking_workers ADD COLUMN cancelled_at`
 * scores as covered because `booking_workers` is in the baseline, while the
 * column is not. Those are real gaps and they are counted here.
 *
 * ## What this deliberately cannot do
 *
 * Some call sites interpolate the column name from a loop variable
 * (`ADD COLUMN IF NOT EXISTS ${col}`). The name is not in the source text, so it
 * cannot be resolved statically. Those are reported as INDETERMINATE and listed
 * rather than assumed covered — assuming would be the same mistake this script
 * exists to correct. Resolve them by reading the call site.
 *
 * Run: npm run schema:authority
 */

import fs from 'fs';
import path from 'path';

import { runtimeDdl, migrationObjects, type RuntimeDdl } from './runtime-ddl-inventory';

const REPO_ROOT = path.resolve(__dirname, '..');
const SRC = path.join(REPO_ROOT, 'src');
const MIGRATIONS = path.join(REPO_ROOT, 'scripts', 'migrations');
const BASELINE = path.join(REPO_ROOT, 'scripts', 'baseline', '000-baseline.sql');

export type Authority = 'migration' | 'baseline' | 'UNMANAGED';

export interface Classified extends RuntimeDdl {
  authority: Authority;
}

/**
 * Objects `000-baseline.sql` declares.
 *
 * `ALTER TABLE` counts as evidence the table exists: pg_dump emits it only for
 * defaults, constraints and ownership on a table the same dump created.
 */
export const baselineObjects = (): Set<string> => {
  const sql = fs.readFileSync(BASELINE, 'utf8');
  const objects = new Set<string>();
  const patterns = [
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:ONLY\s+)?(?:servana\.)?"?(\w+)"?/gi,
    /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?/gi,
    /ALTER\s+TABLE\s+(?:ONLY\s+)?(?:servana\.)?"?(\w+)"?/gi,
  ];
  for (const re of patterns) {
    for (const m of sql.matchAll(re)) objects.add(m[1].toLowerCase());
  }
  return objects;
};

/** Every runtime DDL statement, labelled with the authority that covers it. */
export const classify = (): Classified[] => {
  const migration = migrationObjects();
  const baseline = baselineObjects();
  return runtimeDdl().map((d) => ({
    ...d,
    authority: migration.has(d.object)
      ? 'migration'
      : baseline.has(d.object)
        ? 'baseline'
        : 'UNMANAGED',
  }));
};

// ─── Column-level ─────────────────────────────────────────────────────────────

export interface AddColumn {
  file: string;
  line: number;
  table: string;
  /** `null` when the source interpolates the name and it cannot be resolved. */
  column: string | null;
  raw: string;
}

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.isFile() && full.endsWith('.ts') ? [full] : [];
  });

/** Blank comment lines so a documented example is not read as a statement. */
const withoutComments = (text: string): string =>
  text
    .split(/\r?\n/)
    .map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? '' : line))
    .join('\n');

const QUALIFIER = String.raw`(?:\$\{[^}]*\}|[A-Za-z_]\w*)?\s*\.?\s*`;

/**
 * `IF` is not a column name.
 *
 * `ADD COLUMN IF NOT EXISTS ${col}` makes a naive `(\w+)` capture backtrack:
 * `${` cannot start an identifier, so the engine gives up the optional
 * `IF NOT EXISTS` and captures `IF` instead. Matching the interpolation as its
 * own alternative is what stops that, and the keyword set is belt-and-braces —
 * the same guard `runtime-ddl-inventory` needs for index names.
 */
const SQL_KEYWORDS = new Set(['if', 'not', 'exists', 'column', 'add']);

/** Every `ALTER TABLE … ADD COLUMN` the application can issue. */
export const runtimeAddColumns = (): AddColumn[] => {
  const found: AddColumn[] = [];
  for (const file of walk(SRC)) {
    const text = withoutComments(fs.readFileSync(file, 'utf8'));
    const alter = new RegExp(
      String.raw`ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?${QUALIFIER}"?(\w+)"?`,
      'gi',
    );
    let m: RegExpExecArray | null;
    while ((m = alter.exec(text))) {
      const table = m[1].toLowerCase();
      const line = text.slice(0, m.index).split('\n').length;
      // The statement body ends where its template literal or string does.
      const rest = text.slice(m.index);
      const end = rest.search(/[`]|"\s*,|'\s*,/);
      const body = end > 0 ? rest.slice(0, end) : rest.slice(0, 4000);
      const column = new RegExp(
        String.raw`ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(\$\{[^}]*\}|"?\w+"?)`,
        'gi',
      );
      for (const c of body.matchAll(column)) {
        const token = c[1].replace(/"/g, '');
        const interpolated = token.startsWith('${') || SQL_KEYWORDS.has(token.toLowerCase());
        found.push({
          file: path.relative(REPO_ROOT, file).split(path.sep).join('/'),
          line,
          table,
          column: interpolated ? null : token.toLowerCase(),
          raw: token,
        });
      }
    }
  }
  return found;
};

/** Columns declared per table, parsed from `CREATE TABLE` blocks and `ADD COLUMN`. */
const declaredColumns = (sources: string[]): Map<string, Set<string>> => {
  const map = new Map<string, Set<string>>();
  const add = (table: string, column: string) => {
    const key = table.toLowerCase();
    if (!map.has(key)) map.set(key, new Set());
    map.get(key)!.add(column.toLowerCase());
  };

  for (const sql of sources) {
    for (const m of sql.matchAll(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:servana\.)?"?(\w+)"?\s*\(([\s\S]*?)\n\s*\);/gi,
    )) {
      for (const line of m[2].split(/\r?\n/)) {
        const col = /^\s+"?(\w+)"?\s+\S/.exec(line);
        if (col && !/^(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK)$/i.test(col[1])) add(m[1], col[1]);
      }
    }
    for (const m of sql.matchAll(
      /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:servana\.)?"?(\w+)"?([\s\S]*?);/gi,
    )) {
      for (const c of m[2].matchAll(/ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?/gi)) {
        add(m[1], c[1]);
      }
    }
  }
  return map;
};

/** Columns the baseline or any migration declares. */
export const declaredColumnsFromRepo = (): Map<string, Set<string>> =>
  declaredColumns([
    fs.readFileSync(BASELINE, 'utf8'),
    ...fs
      .readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => fs.readFileSync(path.join(MIGRATIONS, f), 'utf8')),
  ]);

// ─── Statements the inventory cannot see ──────────────────────────────────────

/**
 * `CREATE INDEX` whose NAME is interpolated — invisible to `ddl:inventory`.
 *
 * Its pattern captures the index name to identify the object. When the name is
 * `${n}` from a loop, `$` cannot start an identifier, so the regex backtracks and
 * captures the SQL keyword `IF` instead — which the keyword guard then discards.
 * The statement is real runtime DDL and is silently absent from the count.
 *
 * That matters for TAB 02 specifically: the acceptance criterion is the API
 * starting with DDL privileges revoked, and an index the inventory cannot see is
 * still an index the application tries to create. Five of these exist, creating
 * indexes on `admin_audit_events`, three finance tables and
 * `finance_ledger_events`, so the deletion backlog is larger than
 * `ddl:inventory` reports by exactly this number.
 *
 * Reported rather than folded into the total, because the OBJECT each one
 * targets cannot be resolved statically either — the name and the columns both
 * come from a loop variable. Resolve by reading the call site.
 */
export interface InvisibleIndex {
  file: string;
  line: number;
  /** The table it indexes, when that part is not interpolated. */
  table: string | null;
  statement: string;
}

export const interpolatedIndexes = (): InvisibleIndex[] => {
  const found: InvisibleIndex[] = [];
  const re = new RegExp(
    String.raw`CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?\$\{[^}]*\}\s+ON\s+${QUALIFIER}"?(\w+)"?`,
    'i',
  );
  for (const file of walk(SRC)) {
    const lines = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n');
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      const m = re.exec(line);
      if (!m) return;
      found.push({
        file: path.relative(REPO_ROOT, file).split(path.sep).join('/'),
        line: i + 1,
        table: m[1]?.toLowerCase() ?? null,
        statement: line.trim().slice(0, 110),
      });
    });
  }
  return found;
};

// ─── Contested objects ────────────────────────────────────────────────────────

/**
 * Objects created by MORE THAN ONE runtime code path.
 *
 * Two `CREATE TABLE IF NOT EXISTS` for one object is not idempotence — it is a
 * race with a SILENT loser. Whichever runs first creates the table; the other
 * does nothing and reports nothing. If their definitions differ, the loser's
 * service then reads columns that do not exist.
 *
 * That is not hypothetical. `provider_source_attribution` had two definitions,
 * one keyed on `provider_uid` and one on `uid`, with near-disjoint columns.
 * Production has the second, so `GET /admin/providers/:uid/attribution` and
 * `POST /admin/providers/attribution/backfill` failed with 42703 — for however
 * long both definitions had coexisted, with nothing in any log to say so.
 *
 * Only `CREATE TABLE` counts here. Two `ALTER TABLE … ADD COLUMN` statements
 * adding different columns to one table compose correctly; two CREATEs are
 * mutually exclusive.
 */
export interface Contested {
  object: string;
  files: string[];
  /** Columns each file declares that the baseline does NOT have. */
  unsatisfiable: Array<{ file: string; columns: string[] }>;
}

/** Column names declared by the runtime CREATE TABLE at `file`:`line`. */
const runtimeCreateColumns = (file: string, line: number): Set<string> => {
  const lines = fs
    .readFileSync(path.join(REPO_ROOT, file), 'utf8')
    .replace(/\r\n/g, '\n')
    .split('\n');

  let depth = 0;
  let started = false;
  const body: string[] = [];
  for (let i = line - 1; i < lines.length && i < line + 200; i++) {
    const text = lines[i];
    for (const ch of text) {
      if (ch === '(') { depth++; started = true; }
      else if (ch === ')') depth--;
    }
    body.push(started && body.length === 0 ? text.slice(text.indexOf('(') + 1) : text);
    if (started && depth <= 0) break;
  }

  const columns = new Set<string>();
  for (const entry of body.join('\n').split(/,\s*\n|\n/)) {
    const m = /^\s*"?([a-z_][a-z0-9_]*)"?\s+[A-Za-z]/.exec(entry);
    if (m && !/^(constraint|primary|unique|foreign|check|references|on|where)$/i.test(m[1])) {
      columns.add(m[1].toLowerCase());
    }
  }
  return columns;
};

export const contestedObjects = (): Contested[] => {
  const creates = runtimeDdl().filter((d) => d.kind === 'CREATE TABLE');

  const byObject = new Map<string, Map<string, number[]>>();
  for (const d of creates) {
    if (!byObject.has(d.object)) byObject.set(d.object, new Map());
    const files = byObject.get(d.object)!;
    files.set(d.file, [...(files.get(d.file) ?? []), d.line]);
  }

  const declared = declaredColumnsFromRepo();
  const out: Contested[] = [];

  for (const [object, files] of byObject) {
    if (files.size < 2) continue;
    const known = declared.get(object) ?? new Set<string>();
    const unsatisfiable: Contested['unsatisfiable'] = [];

    for (const [file, lineNumbers] of files) {
      const missing = new Set<string>();
      for (const line of lineNumbers) {
        for (const column of runtimeCreateColumns(file, line)) {
          if (!known.has(column)) missing.add(column);
        }
      }
      if (missing.size) unsatisfiable.push({ file, columns: [...missing].sort() });
    }

    out.push({ object, files: [...files.keys()].sort(), unsatisfiable });
  }

  return out.sort((a, b) => a.object.localeCompare(b.object));
};

export interface ColumnGaps {
  missing: AddColumn[];
  indeterminate: AddColumn[];
}

export const columnGaps = (): ColumnGaps => {
  const declared = declaredColumnsFromRepo();
  const adds = runtimeAddColumns();
  return {
    missing: adds.filter((a) => a.column !== null && !(declared.get(a.table)?.has(a.column) ?? false)),
    indeterminate: adds.filter((a) => a.column === null),
  };
};

// ─── Report ───────────────────────────────────────────────────────────────────

if (require.main === module) {
  const rows = classify();
  const adds = runtimeAddColumns();
  const { missing, indeterminate } = columnGaps();

  const of = (a: Authority) => rows.filter((r) => r.authority === a);
  const distinct = (xs: Classified[]) => new Set(xs.map((x) => x.object));

  // eslint-disable-next-line no-console
  const log = console.log;
  log('Schema authority for runtime DDL (TAB 02)\n');
  log(`  runtime DDL statements        ${rows.length}`);
  log(`    owned by a migration        ${of('migration').length}`);
  log(`    owned by the baseline       ${of('baseline').length}   ← delete the call; nothing to author`);
  log(`    UNMANAGED                   ${of('UNMANAGED').length}   ← author a migration FIRST\n`);

  const gap = of('UNMANAGED');
  if (gap.length) {
    log('  Objects NOTHING in this repository creates:\n');
    const byFile = new Map<string, Classified[]>();
    for (const d of gap) byFile.set(d.file, [...(byFile.get(d.file) ?? []), d]);
    for (const [file, entries] of [...byFile.entries()].sort()) {
      log(`    ${file}`);
      for (const e of entries) log(`      :${e.line}  ${e.kind}  ${e.object}`);
    }
    log(`\n    distinct: ${[...distinct(gap)].sort().join(', ')}`);
  }

  log(`\n  runtime ADD COLUMN statements  ${adds.length}`);
  log(`    declared in the repository   ${adds.length - missing.length - indeterminate.length}`);
  log(`    MISSING                      ${missing.length}`);
  log(`    interpolated, unresolvable   ${indeterminate.length}`);
  if (missing.length) {
    log('\n  Columns NOTHING in this repository declares:\n');
    for (const a of missing) log(`    ${a.table}.${a.column}   ← ${a.file}:${a.line}`);
  }
  if (indeterminate.length) {
    log('\n  Column name interpolated — resolve by reading the call site:\n');
    for (const a of indeterminate) log(`    ${a.table}.${a.raw}   ← ${a.file}:${a.line}`);
  }

  const invisible = interpolatedIndexes();
  log(`\n  CREATE INDEX with an interpolated NAME  ${invisible.length}`);
  log('    invisible to ddl:inventory, so its count understates the backlog by this much');
  for (const i of invisible) {
    log(`    ${i.file}:${i.line}  on ${i.table ?? '<interpolated>'}`);
  }

  const contested = contestedObjects();
  const broken = contested.filter((c) => c.unsatisfiable.length > 0);
  log(`\n  objects created by MORE THAN ONE runtime path  ${contested.length}`);
  log(`    ...whose definition production cannot satisfy  ${broken.length}`);
  if (contested.length) {
    log('\n  One definition won the CREATE-TABLE-IF-NOT-EXISTS race; the rest did nothing:\n');
    for (const c of contested) {
      const mark = c.unsatisfiable.length ? '  ⛔' : '    ';
      log(`${mark}${c.object}`);
      for (const f of c.files) log(`        ${f}`);
      for (const u of c.unsatisfiable) {
        log(`        ⛔ ${u.file} declares columns nothing in the repo has: ${u.columns.join(', ')}`);
      }
    }
  }

  log('');
  process.exitCode = gap.length || missing.length || broken.length ? 1 : 0;
}
