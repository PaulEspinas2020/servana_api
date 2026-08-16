/**
 * Every schema change the application can perform at RUNTIME (TAB 02).
 *
 * ## Why this is worth a script
 *
 * TAB 02's acceptance is "runtime startup performs zero unmanaged table or
 * column changes" and "the API starts successfully with DDL privileges
 * revoked". Neither can be argued from a grep count: what matters is which
 * OBJECT each statement touches, and whether a migration already owns it.
 *
 * A runtime `CREATE TABLE IF NOT EXISTS` is invisible to the migration ledger.
 * The schema then has two authorities that never compare notes, and the
 * difference only shows up when the application role loses DDL rights — which
 * is exactly the change TAB 02 asks for.
 *
 * ## Classification
 *
 *   owned_by_migration  a migration creates or alters the same object. The
 *                       runtime statement is redundant and removable.
 *   UNMANAGED           no migration mentions it. This is the gap.
 *
 * Run: npm run ddl:inventory
 */

import fs from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..');
const SRC = path.join(REPO_ROOT, 'src');
const MIGRATIONS = path.join(REPO_ROOT, 'scripts', 'migrations');

export interface RuntimeDdl {
  file: string;
  line: number;
  kind: 'CREATE TABLE' | 'ALTER TABLE' | 'CREATE INDEX';
  object: string;
  statement: string;
}

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.isFile() && full.endsWith('.ts') ? [full] : [];
  });

/** Strip comments so a documented example is not counted as a statement. */
const withoutComments = (text: string): string[] =>
  text.split(/\r?\n/).map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? '' : line));

/**
 * A qualifier is optional and comes in two shapes.
 *
 * Most statements interpolate the schema — `${s}.bookings` — but some spell it
 * literally, `servana.bookings`. The first version of this pattern required the
 * `${…}` form, so every literally-qualified statement was invisible and the
 * inventory under-reported. A mutation test caught it: an injected
 * `CREATE TABLE IF NOT EXISTS servana.probe (…)` did not move the count.
 */
const QUALIFIER = String.raw`(?:\$\{[^}]*\}|[A-Za-z_]\w*)?\s*\.?\s*`;

const PATTERNS: Array<{ kind: RuntimeDdl['kind']; re: RegExp }> = [
  {
    kind: 'CREATE TABLE',
    re: new RegExp(String.raw`CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${QUALIFIER}"?(\w+)"?`, 'i'),
  },
  {
    kind: 'ALTER TABLE',
    re: new RegExp(String.raw`ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?${QUALIFIER}"?(\w+)"?`, 'i'),
  },
  {
    kind: 'CREATE INDEX',
    re: new RegExp(String.raw`CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?`, 'i'),
  },
];

/**
 * `IF` is not an index name.
 *
 * These statements are template literals, so `CREATE INDEX IF NOT` can end a
 * line with `EXISTS idx_foo` on the next one. Reading line by line then
 * captures the keyword. Dropping SQL keywords is cheaper and less fragile than
 * reassembling multi-line statements, and the object still gets counted when
 * its real name appears.
 */
const SQL_KEYWORDS = new Set(['if', 'not', 'exists', 'unique', 'concurrently', 'on']);

export const runtimeDdl = (): RuntimeDdl[] => {
  const found: RuntimeDdl[] = [];
  for (const file of walk(SRC)) {
    const lines = withoutComments(fs.readFileSync(file, 'utf8'));
    lines.forEach((line, i) => {
      for (const { kind, re } of PATTERNS) {
        const m = re.exec(line);
        if (!m) continue;
        if (SQL_KEYWORDS.has(m[1].toLowerCase())) continue;
        found.push({
          file: path.relative(REPO_ROOT, file).split(path.sep).join('/'),
          line: i + 1,
          kind,
          object: m[1].toLowerCase(),
          statement: line.trim().slice(0, 100),
        });
        break;
      }
    });
  }
  return found;
};

/** Objects any migration creates or alters. */
export const migrationObjects = (): Set<string> => {
  const objects = new Set<string>();
  for (const file of fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))) {
    const sql = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');
    for (const m of sql.matchAll(
      /(?:CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?|ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?)(?:servana\.)?"?(\w+)"?/gi,
    )) {
      objects.add(m[1].toLowerCase());
    }
    for (const m of sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?/gi)) {
      objects.add(m[1].toLowerCase());
    }
  }
  return objects;
};

if (require.main === module) {
  const ddl = runtimeDdl();
  const owned = migrationObjects();

  const unmanaged = ddl.filter((d) => !owned.has(d.object));
  const managed = ddl.filter((d) => owned.has(d.object));

  const byFile = new Map<string, RuntimeDdl[]>();
  for (const d of unmanaged) {
    byFile.set(d.file, [...(byFile.get(d.file) ?? []), d]);
  }

  // eslint-disable-next-line no-console
  const log = console.log;
  log('Runtime DDL inventory (TAB 02)\n');
  log(`  runtime DDL statements   ${ddl.length}`);
  log(`  owned by a migration     ${managed.length}`);
  log(`  UNMANAGED                ${unmanaged.length}\n`);

  if (unmanaged.length) {
    log('  Objects no migration mentions — the schema has a second authority:\n');
    for (const [file, entries] of [...byFile.entries()].sort()) {
      log(`    ${file}`);
      for (const e of entries) log(`      :${e.line}  ${e.kind}  ${e.object}`);
    }
  }

  const distinctObjects = [...new Set(unmanaged.map((d) => d.object))].sort();
  log(`\n  distinct unmanaged objects: ${distinctObjects.length}`);
  if (distinctObjects.length) log(`    ${distinctObjects.join(', ')}`);

  process.exitCode = unmanaged.length ? 1 : 0;
}
