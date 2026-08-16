/**
 * A deterministic, engine-free model of what the migration chain builds.
 *
 * ## Why this exists at all
 *
 * The release gate for this command is "a fresh database can reach current
 * schema automatically". Answering that normally means creating a database and
 * running the migrations. No PostgreSQL engine is reachable from this
 * environment — no `psql`, no `pg_dump`, no Docker — and the only database this
 * repository has credentials for is production, which this work is forbidden to
 * touch.
 *
 * So the question is answered STATICALLY instead: replay every migration
 * against an empty catalog and see what breaks. That is weaker than running it,
 * and it is not nothing — it catches exactly the class of defect this command
 * exists to find, which is a migration that references a table no migration
 * creates.
 *
 * ## What it deliberately is NOT
 *
 * Not a PostgreSQL implementation. It understands a subset of DDL: create,
 * alter, rename, drop, sequences, views, ownership. Anything it does not
 * recognise is COUNTED and reported as `unparsed` rather than skipped in
 * silence — a parser that quietly ignores what it cannot read gives exactly the
 * false confidence this file is meant to remove.
 *
 * An assertion built on this model is therefore only as strong as the
 * `unparsed` count is small, and `tests/schema-baseline.test.ts` asserts that
 * count stays bounded.
 */

import { maskNonCode } from './migrationSafety';

export const DEFAULT_SCHEMA = 'servana';

// ─── The catalog ──────────────────────────────────────────────────────────────

export interface ColumnModel {
  name: string;
  type: string;
  notNull: boolean;
  default: string | null;
  /** Fully-qualified `table.column` this column references, if any. */
  references: string | null;
}

export interface TableModel {
  name: string;
  columns: Map<string, ColumnModel>;
  primaryKey: string[];
  owner: string | null;
  /** Which migration file introduced it. */
  createdBy: string;
  /** Rename history, oldest first. */
  formerNames: string[];
  isView: boolean;
}

export interface SequenceModel {
  name: string;
  start: number | null;
  ownedBy: string | null;
  owner: string | null;
  createdBy: string;
}

export interface ReplayProblem {
  file: string;
  statement: string;
  kind:
    | 'missing-table'
    | 'missing-column'
    | 'missing-sequence'
    | 'missing-fk-target'
    | 'duplicate-table'
    | 'unparsed';
  detail: string;
}

export interface SchemaCatalog {
  tables: Map<string, TableModel>;
  sequences: Map<string, SequenceModel>;
  problems: ReplayProblem[];
  statementsSeen: number;
  statementsApplied: number;
}

const emptyCatalog = (): SchemaCatalog => ({
  tables: new Map(),
  sequences: new Map(),
  problems: [],
  statementsSeen: 0,
  statementsApplied: 0,
});

// ─── Statement splitting ──────────────────────────────────────────────────────

/**
 * Split on semicolons that terminate a statement.
 *
 * `maskNonCode` (shared with the TAB 14 migration guard) blanks comments,
 * string literals and `$$`-quoted bodies first, so a semicolon inside a
 * PL/pgSQL block or a COMMENT string does not split a statement in half. The
 * mask is length-preserving, so offsets into it index the real text.
 */
export const splitStatements = (sql: string): string[] => {
  const masked = maskNonCode(sql);
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < masked.length; i += 1) {
    if (masked[i] === ';') {
      const statement = sql.slice(start, i).trim();
      if (statement) out.push(statement);
      start = i + 1;
    }
  }
  const tail = sql.slice(start).trim();
  if (tail) out.push(tail);
  return out;
};

/**
 * Statement text with comments and literals blanked, whitespace collapsed.
 *
 * Used for STRUCTURE — deciding what kind of statement this is and where its
 * clauses begin. Never for VALUES: `maskNonCode` blanks string literals, so a
 * default of `nextval('servana.catalog_services_id_seq')` reads as `nextval( )`
 * here. `rawValue` below recovers the real text.
 */
const codeOf = (statement: string): string =>
  maskNonCode(statement).replace(/\s+/g, ' ').trim();

/**
 * Recover a value from the RAW statement, which still has its literals.
 *
 * Matching the same pattern against the unmasked text is safe for the narrow
 * cases used here — a DEFAULT clause for a named column — because the column
 * name anchors it, and a column name cannot appear inside a string literal in a
 * position that would also match the surrounding SQL keywords.
 */
const rawValue = (statement: string, pattern: RegExp): string | null => {
  const match = pattern.exec(statement);
  if (!match) return null;
  let value = match[1].trim().replace(/[\s,;]+$/, '');
  // Drop only a closing paren that has no opener — the one belonging to the
  // enclosing DDL. `nextval('…_seq')` must keep its own.
  while (value.endsWith(')')) {
    const opens = (value.match(/\(/g) ?? []).length;
    const closes = (value.match(/\)/g) ?? []).length;
    if (closes <= opens) break;
    value = value.slice(0, -1).trimEnd();
  }
  return value;
};

const unqualify = (name: string): string =>
  name.replace(new RegExp(`^${DEFAULT_SCHEMA}\\.`, 'i'), '').replace(/^"|"$/g, '').toLowerCase();

// ─── Column parsing ───────────────────────────────────────────────────────────

/**
 * Split a CREATE TABLE body on top-level commas, returning masked/raw pairs.
 *
 * The boundaries are found in the MASKED text so a comma inside a string
 * literal or a `CHECK (... IN ('a','b'))` list does not split a column in half.
 * `maskNonCode` is length-preserving, so the same offsets slice the raw text —
 * which is where a DEFAULT's actual value still exists.
 *
 * That pairing is the whole point. A default of `'active'` masks to blanks, so
 * reading it from the masked text yields nothing and reading the next
 * non-blank token yields the CHECK clause instead.
 */
interface Definition { masked: string; raw: string }

const splitDefinitions = (maskedBody: string, rawBody?: string): Definition[] => {
  const raw = rawBody ?? maskedBody;
  const out: Definition[] = [];
  let depth = 0;
  let start = 0;
  const push = (from: number, to: number) => {
    const masked = maskedBody.slice(from, to).trim();
    if (masked) out.push({ masked, raw: raw.slice(from, to).trim() });
  };
  for (let i = 0; i < maskedBody.length; i += 1) {
    const c = maskedBody[i];
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if (c === ',' && depth === 0) { push(start, i); start = i + 1; }
  }
  push(start, maskedBody.length);
  return out;
};

const TABLE_CONSTRAINT = /^(CONSTRAINT|PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY|EXCLUDE)\b/i;

const parseReferences = (definition: string): string | null => {
  const match = /REFERENCES\s+(?:(\w+)\.)?(\w+)\s*\(\s*(\w+)\s*\)/i.exec(definition);
  if (!match) return null;
  return `${match[2].toLowerCase()}.${match[3].toLowerCase()}`;
};

/**
 * The DEFAULT clause, read from the RAW definition.
 *
 * Bounded by the keywords that can legally follow it, so
 * `DEFAULT 'active' CHECK (...)` yields `'active'` rather than swallowing the
 * constraint.
 */
const parseDefault = (raw: string): string | null => {
  const match =
    /\bDEFAULT\s+((?:'(?:[^']|'')*'|[^\s])(?:(?!\s+(?:NOT\s+NULL|NULL|REFERENCES|CHECK|UNIQUE|PRIMARY\s+KEY|GENERATED|COLLATE)\b)[\s\S])*)/i
      .exec(raw);
  return match ? match[1].trim().replace(/[\s,]+$/, '') : null;
};

const parseColumn = (definition: Definition): ColumnModel | null => {
  if (TABLE_CONSTRAINT.test(definition.masked.trim())) return null;
  const match = /^"?([a-z_][a-z0-9_]*)"?\s+(.+)$/is.exec(definition.masked.trim());
  if (!match) return null;
  const rest = match[2];
  const typeMatch = /^([A-Za-z][\w ]*(?:\([^)]*\))?(?:\[\])?)/.exec(rest);
  return {
    name: match[1].toLowerCase(),
    type: (typeMatch ? typeMatch[1] : rest).trim().toUpperCase(),
    notNull: /\bNOT\s+NULL\b/i.test(rest),
    default: parseDefault(definition.raw),
    references: parseReferences(rest),
  };
};

/** SERIAL and friends create their own sequence — modelled so §156 can check it. */
const isSerial = (type: string): boolean => /\b(BIG)?SERIAL\b/i.test(type);

// ─── Replay ───────────────────────────────────────────────────────────────────

export interface ReplayInput {
  file: string;
  sql: string;
}

/**
 * Apply one statement to the catalog.
 *
 * Returns `true` when the statement was understood — whether or not it
 * succeeded. An unrecognised statement is recorded as `unparsed`, which is the
 * honest answer and is what keeps the model's limits visible.
 */
const applyStatement = (catalog: SchemaCatalog, file: string, statement: string): void => {
  const code = codeOf(statement);
  if (!code) return;
  catalog.statementsSeen += 1;

  /**
   * The same statement, masked but NOT whitespace-collapsed.
   *
   * `maskNonCode` preserves length, so an offset into `aligned` is the same
   * offset in `statement`. That is what lets a clause be located structurally
   * (in the masked text, where a comma inside a literal cannot mislead) and
   * then read literally (from the raw text, where the value still exists).
   */
  const aligned = maskNonCode(statement);
  const rawSlice = (from: number, to: number) => statement.slice(from, to);

  const note = (kind: ReplayProblem['kind'], detail: string) =>
    catalog.problems.push({ file, statement: code.slice(0, 160), kind, detail });

  const applied = () => { catalog.statementsApplied += 1; };

  // ── CREATE TABLE ────────────────────────────────────────────────────────
  let m = /^CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?([\w.".]+)\s*\(([\s\S]*)\)\s*$/i.exec(code);
  if (m) {
    applied();
    const name = unqualify(m[2]);
    const ifNotExists = Boolean(m[1]);
    if (catalog.tables.has(name)) {
      if (!ifNotExists) note('duplicate-table', `${name} already exists`);
      return;
    }
    const columns = new Map<string, ColumnModel>();
    const primaryKey: string[] = [];

    // Re-locate the body in the length-aligned text so the raw slice matches.
    const bodyMatch = /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[\w.".]+\s*\(([\s\S]*)\)\s*$/i
      .exec(aligned);
    const bodyStart = bodyMatch ? (bodyMatch.index ?? 0) + bodyMatch[0].indexOf('(') + 1 : -1;
    const definitions = bodyMatch
      ? splitDefinitions(bodyMatch[1], rawSlice(bodyStart, bodyStart + bodyMatch[1].length))
      : splitDefinitions(m[3]);

    for (const definition of definitions) {
      const column = parseColumn(definition);
      if (column) {
        columns.set(column.name, column);
        if (/\bPRIMARY\s+KEY\b/i.test(definition.masked)) primaryKey.push(column.name);
        if (isSerial(column.type)) {
          const seq = `${name}_${column.name}_seq`;
          catalog.sequences.set(seq, {
            name: seq, start: 1, ownedBy: `${name}.${column.name}`, owner: null, createdBy: file,
          });
          column.default = `nextval('${seq}')`;
        }
        continue;
      }
      const pk = /^PRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(definition.masked.trim());
      if (pk) primaryKey.push(...pk[1].split(',').map((s) => s.trim().replace(/"/g, '').toLowerCase()));
      const fk = /^(?:CONSTRAINT\s+\w+\s+)?FOREIGN\s+KEY\s*\(\s*(\w+)\s*\)\s*(REFERENCES[\s\S]*)$/i.exec(definition.masked.trim());
      if (fk) {
        const target = parseReferences(fk[2]);
        const column = columns.get(fk[1].toLowerCase());
        if (column && target) column.references = target;
      }
    }
    catalog.tables.set(name, {
      name, columns, primaryKey, owner: null, createdBy: file, formerNames: [], isView: false,
    });
    return;
  }

  // ── CREATE VIEW ─────────────────────────────────────────────────────────
  m = /^CREATE\s+(OR\s+REPLACE\s+)?VIEW\s+([\w.".]+)/i.exec(code);
  if (m) {
    applied();
    const name = unqualify(m[2]);
    catalog.tables.set(name, {
      name, columns: new Map(), primaryKey: [], owner: null, createdBy: file,
      formerNames: [], isView: true,
    });
    return;
  }

  m = /^ALTER\s+VIEW\s+([\w.".]+)\s+OWNER\s+TO\s+(\w+)/i.exec(code);
  if (m) {
    applied();
    const view = catalog.tables.get(unqualify(m[1]));
    if (view) view.owner = m[2].toLowerCase();
    else note('missing-table', `ALTER VIEW on unknown ${unqualify(m[1])}`);
    return;
  }

  m = /^DROP\s+VIEW\s+(IF\s+EXISTS\s+)?([\w.".]+)/i.exec(code);
  if (m) {
    applied();
    const name = unqualify(m[2]);
    if (!catalog.tables.has(name) && !m[1]) note('missing-table', `DROP VIEW on unknown ${name}`);
    catalog.tables.delete(name);
    return;
  }

  m = /^DROP\s+TABLE\s+(IF\s+EXISTS\s+)?([\w.".]+)/i.exec(code);
  if (m) {
    applied();
    catalog.tables.delete(unqualify(m[2]));
    return;
  }

  // ── CREATE SEQUENCE ─────────────────────────────────────────────────────
  m = /^CREATE\s+SEQUENCE\s+(IF\s+NOT\s+EXISTS\s+)?([\w.".]+)(.*)$/i.exec(code);
  if (m) {
    applied();
    const name = unqualify(m[2]);
    const start = /\bSTART\s+(?:WITH\s+)?(\d+)/i.exec(m[3]);
    if (!catalog.sequences.has(name)) {
      catalog.sequences.set(name, {
        name, start: start ? Number(start[1]) : 1, ownedBy: null, owner: null, createdBy: file,
      });
    }
    return;
  }

  m = /^ALTER\s+SEQUENCE\s+([\w.".]+)\s+(.*)$/i.exec(code);
  if (m) {
    applied();
    const name = unqualify(m[1]);
    const sequence = catalog.sequences.get(name);
    if (!sequence) { note('missing-sequence', `ALTER SEQUENCE on unknown ${name}`); return; }
    const owned = /OWNED\s+BY\s+([\w.".]+)/i.exec(m[2]);
    if (owned) {
      const parts = owned[1].split('.').map((p) => p.toLowerCase());
      sequence.ownedBy = parts.slice(-2).join('.');
    }
    const owner = /OWNER\s+TO\s+(\w+)/i.exec(m[2]);
    if (owner) sequence.owner = owner[1].toLowerCase();
    return;
  }

  // ── ALTER TABLE ─────────────────────────────────────────────────────────
  m = /^ALTER\s+TABLE\s+(IF\s+EXISTS\s+)?(?:ONLY\s+)?([\w.".]+)\s+([\s\S]*)$/i.exec(code);
  if (m) {
    applied();
    const ifExists = Boolean(m[1]);
    const name = unqualify(m[2]);
    const action = m[3];
    const table = catalog.tables.get(name);

    if (!table) {
      // THE finding this whole model exists to surface: a migration altering a
      // table that no migration in the repository creates.
      if (!ifExists) note('missing-table', `ALTER TABLE on ${name}, which nothing creates`);
      return;
    }

    const rename = /^RENAME\s+TO\s+([\w."]+)/i.exec(action);
    if (rename) {
      const to = unqualify(rename[1]);
      catalog.tables.delete(name);
      table.formerNames.push(name);
      table.name = to;
      catalog.tables.set(to, table);
      return;
    }

    const renameColumn = /^RENAME\s+COLUMN\s+([\w."]+)\s+TO\s+([\w."]+)/i.exec(action);
    if (renameColumn) {
      const from = unqualify(renameColumn[1]);
      const to = unqualify(renameColumn[2]);
      const column = table.columns.get(from);
      if (!column) { note('missing-column', `${name}.${from}`); return; }
      table.columns.delete(from);
      column.name = to;
      table.columns.set(to, column);
      return;
    }

    // RENAME CONSTRAINT and similar: understood, no model impact.
    if (/^RENAME\s+CONSTRAINT/i.test(action)) return;

    const owner = /^OWNER\s+TO\s+(\w+)/i.exec(action);
    if (owner) { table.owner = owner[1].toLowerCase(); return; }

    // A single ALTER TABLE may carry several comma-separated actions.
    // Align the action clause so ADD COLUMN defaults are read from raw text.
    const actionStart = aligned.length - action.length >= 0
      ? aligned.indexOf(action.slice(0, 24))
      : -1;
    const rawAction = actionStart >= 0 ? rawSlice(actionStart, actionStart + action.length) : action;

    for (const clause of splitDefinitions(action, rawAction)) {
      const add = /^(?:ADD\s+COLUMN\s+)(IF\s+NOT\s+EXISTS\s+)?([\s\S]+)$/i.exec(clause.masked.trim());
      if (add) {
        const rawAdd = /^(?:ADD\s+COLUMN\s+)(?:IF\s+NOT\s+EXISTS\s+)?([\s\S]+)$/i.exec(clause.raw.trim());
        const column = parseColumn({ masked: add[2], raw: rawAdd ? rawAdd[1] : add[2] });
        if (column && !table.columns.has(column.name)) table.columns.set(column.name, column);
        continue;
      }
      const drop = /^DROP\s+COLUMN\s+(IF\s+EXISTS\s+)?([\w."]+)/i.exec(clause.masked.trim());
      if (drop) { table.columns.delete(unqualify(drop[2])); continue; }

      const alterColumn = /^ALTER\s+(?:COLUMN\s+)?([\w."]+)\s+([\s\S]+)$/i.exec(clause.masked.trim());
      if (alterColumn) {
        const column = table.columns.get(unqualify(alterColumn[1]));
        if (!column) { note('missing-column', `${name}.${unqualify(alterColumn[1])}`); continue; }
        const setDefault = /^SET\s+DEFAULT\s+([\s\S]+)$/i.exec(alterColumn[2]);
        if (setDefault) {
          /**
           * Recovered from the raw STATEMENT, anchored on the column name.
           *
           * A default like `nextval('servana.catalog_services_id_seq')` lives
           * entirely inside a string literal, so the masked text carries
           * `nextval( )` and nothing usable. The column name anchors the match
           * to the right clause when one ALTER carries several.
           */
          const anchored = new RegExp(
            `\\b${column.name}\\b\\s+SET\\s+DEFAULT\\s+([\\s\\S]+?)(?:,\\s*(?:ALTER|ADD|DROP)\\b|\\s*$)`,
            'i',
          );
          column.default = rawValue(statement, anchored) ?? setDefault[1].trim();
        }
        if (/^DROP\s+DEFAULT/i.test(alterColumn[2])) column.default = null;
        if (/^SET\s+NOT\s+NULL/i.test(alterColumn[2])) column.notNull = true;
        if (/^DROP\s+NOT\s+NULL/i.test(alterColumn[2])) column.notNull = false;
        const type = /^(?:SET\s+DATA\s+)?TYPE\s+([\w ()\[\]]+)/i.exec(alterColumn[2]);
        if (type) column.type = type[1].trim().toUpperCase();
        continue;
      }

      const addConstraint = /^ADD\s+(?:CONSTRAINT\s+[\w."]+\s+)?FOREIGN\s+KEY\s*\(\s*([\w"]+)\s*\)\s*([\s\S]+)$/i.exec(clause.masked.trim());
      if (addConstraint) {
        const column = table.columns.get(unqualify(addConstraint[1]));
        const target = parseReferences(addConstraint[2]);
        if (column && target) column.references = target;
        continue;
      }
      // ADD CONSTRAINT ... CHECK/UNIQUE, DROP CONSTRAINT, VALIDATE: no model impact.
    }
    return;
  }

  // ── Statements with no model impact, recognised so they are not "unparsed" ──
  if (
    /^(CREATE\s+(UNIQUE\s+)?INDEX|DROP\s+INDEX|COMMENT\s+ON|GRANT|REVOKE|SET\s|SELECT|INSERT|UPDATE|DELETE|DO|WITH|CREATE\s+OR\s+REPLACE\s+FUNCTION|CREATE\s+FUNCTION|CREATE\s+TRIGGER|DROP\s+TRIGGER|ANALYZE|VACUUM|REFRESH|CREATE\s+EXTENSION|CREATE\s+SCHEMA|ALTER\s+SCHEMA|BEGIN|COMMIT|ROLLBACK)\b/i.test(code)
  ) {
    applied();
    return;
  }

  note('unparsed', code.slice(0, 120));
};

/**
 * Replay a chain of SQL files against an empty catalog.
 *
 * The order is the order the runner applies them: `readdirSync().sort()`, which
 * is the same lexical sort the caller must supply.
 */
export const replay = (inputs: readonly ReplayInput[]): SchemaCatalog => {
  const catalog = emptyCatalog();
  for (const input of inputs) {
    for (const statement of splitStatements(input.sql)) {
      applyStatement(catalog, input.file, statement);
    }
  }
  return catalog;
};

// ─── Reading the result ───────────────────────────────────────────────────────

export const tableNames = (catalog: SchemaCatalog): string[] =>
  [...catalog.tables.keys()].sort();

/**
 * Resolve a referenced table name through rename history.
 *
 * PostgreSQL foreign keys bind to the target's OID, not to its name, so
 * `ALTER TABLE catalog_services RENAME TO services` silently re-points every FK
 * that referenced `catalog_services`. A model that compared names would report
 * every one of them as dangling and bury the real gaps.
 *
 * This is the Catalog V2 case specifically: `catalog_provider_services.service_id`
 * was declared against `catalog_services` in migration 020 and now targets
 * `services`, which is exactly what §157 requires of it.
 */
export const resolveTableName = (catalog: SchemaCatalog, name: string): TableModel | null => {
  const direct = catalog.tables.get(name);
  if (direct) return direct;
  for (const table of catalog.tables.values()) {
    if (table.formerNames.includes(name)) return table;
  }
  return null;
};

/** The CURRENT name of the table a column references, after renames. */
export const referenceTarget = (
  catalog: SchemaCatalog,
  column: ColumnModel,
): string | null => {
  if (!column.references) return null;
  const [table, target] = column.references.split('.');
  const resolved = resolveTableName(catalog, table);
  return resolved ? `${resolved.name}.${target}` : null;
};

/** Foreign keys whose target table does not exist, even after following renames. */
export const danglingForeignKeys = (
  catalog: SchemaCatalog,
): Array<{ from: string; to: string }> => {
  const out: Array<{ from: string; to: string }> = [];
  for (const table of catalog.tables.values()) {
    for (const column of table.columns.values()) {
      if (!column.references) continue;
      if (!resolveTableName(catalog, column.references.split('.')[0])) {
        out.push({ from: `${table.name}.${column.name}`, to: column.references });
      }
    }
  }
  return out.sort((a, b) => a.from.localeCompare(b.from));
};

/** Tables a migration tried to ALTER but nothing creates — the baseline gap. */
export const missingBaselineTables = (catalog: SchemaCatalog): string[] => {
  const names = new Set<string>();
  for (const problem of catalog.problems) {
    if (problem.kind !== 'missing-table') continue;
    const match = /ALTER TABLE on ([\w.]+)/.exec(problem.detail) ?? /unknown ([\w.]+)/.exec(problem.detail);
    if (match) names.add(match[1]);
  }
  return [...names].sort();
};

export const columnOf = (
  catalog: SchemaCatalog,
  table: string,
  column: string,
): ColumnModel | null => catalog.tables.get(table)?.columns.get(column) ?? null;
