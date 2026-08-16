/**
 * The baseline gap, and the rules any baseline must satisfy (§152, §155–§157).
 *
 * ## The finding this file exists to carry
 *
 * `scripts/migrations/` cannot build Servana's database from zero. Applying the
 * chain to an empty database dies on `001-massage-services.sql`, which seeds the
 * catalog by reading `servana.service_option_meta` and `servana.bookings` — and
 * nothing here creates either. Eighteen foundational tables are in that
 * position, and they are the oldest and most load-bearing ones in the platform.
 *
 * Both numbers above were once "009" and "eleven". They were wrong: the model
 * only recorded tables an `ALTER` named, so dependencies expressed as DML were
 * invisible. `npm run db:verify:embedded` executes the chain on a real
 * PostgreSQL and now gates against that class of under-reporting.
 *
 * The migration chain is therefore an INCREMENT over a schema that exists only
 * in production. That is the structural gap this command names, and it means no
 * CI job can currently catch a migration defect before a deploy does.
 *
 * ## Why this file does not contain the missing DDL
 *
 * It would be easy to write eighteen `CREATE TABLE` statements that look right.
 * It would also be a fiction. The migrations only ever ADD columns to these
 * tables — not one of them defines a primary key, a core column or a foreign
 * key for any of them — so their real shape is not in this repository to
 * be read. Inferring it from the SELECT lists in service code would produce a
 * baseline that is plausible, unverified, and authoritative-looking, and CI
 * would then prove a fresh database matches a schema production does not have.
 *
 * A wrong baseline is worse than a missing one, because a missing one is
 * visibly missing.
 *
 * So what is delivered instead is:
 *
 *   1. the gap, PROVEN and machine-checkable (`baselineGap`);
 *   2. the REQUIREMENTS any baseline must meet, derived from evidence that IS
 *      in the repository — every column a migration adds, every column a
 *      foreign key targets, every ownership and sequence rule (`requirements`);
 *   3. the semantic rules Catalog V2 must satisfy, which ARE fully derivable
 *      today and are asserted now (`checkCanonicalSemantics`);
 *   4. capture tooling that produces the real baseline from an authoritative
 *      database, with sanitisation enforced in code (`capture-schema-baseline`).
 *
 * When somebody with database access runs the capture, `verifyBaseline` checks
 * its output against (2) and (3) before it is trusted.
 */

import fs from 'fs';
import path from 'path';
import {
  replay,
  missingBaselineTables,
  referenceTarget,
  resolveTableName,
  type ReplayInput,
  type SchemaCatalog,
} from './schemaModel';
import { APPROVED_OWNER_ROLES } from './migrationSafety';

export const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');
export const BASELINE_DIR = path.resolve(__dirname, '..', 'baseline');
export const BASELINE_FILE = path.join(BASELINE_DIR, '000-baseline.sql');

/** Every migration, in the order the runner applies them. */
export const migrationInputs = (): ReplayInput[] =>
  fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}-.+\.sql$/.test(f))
    .sort()
    .map((file) => ({ file, sql: fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8') }));

/** The baseline, when one has been captured. `null` until then. */
export const baselineInput = (): ReplayInput | null =>
  fs.existsSync(BASELINE_FILE)
    ? { file: '000-baseline.sql', sql: fs.readFileSync(BASELINE_FILE, 'utf8') }
    : null;

/** Replay migrations alone — what a fresh database would actually get. */
export const replayMigrationsOnly = (): SchemaCatalog => replay(migrationInputs());

/** Replay baseline + migrations — what a fresh database gets once one exists. */
export const replayWithBaseline = (): SchemaCatalog => {
  const baseline = baselineInput();
  return replay(baseline ? [baseline, ...migrationInputs()] : migrationInputs());
};

// ─── The gap ──────────────────────────────────────────────────────────────────

export interface BaselineGap {
  /** Tables a migration alters that no migration creates. */
  missingTables: string[];
  /** True when a fresh database can reach the current schema unaided. */
  bootstrapsFromZero: boolean;
  /** Present only when a baseline file exists. */
  baselineCaptured: boolean;
}

export const baselineGap = (): BaselineGap => {
  const catalog = replayWithBaseline();
  const missing = missingBaselineTables(catalog);
  return {
    missingTables: missing,
    bootstrapsFromZero: missing.length === 0,
    baselineCaptured: baselineInput() !== null,
  };
};

// ─── What a baseline must contain ─────────────────────────────────────────────

export interface TableRequirement {
  table: string;
  /**
   * Columns the repository PROVES the table must already have.
   *
   * Two sources, both hard evidence rather than inference:
   *   - a migration adds a column to it, so the table exists and the ADD must
   *     land on something;
   *   - another table's foreign key targets a column of it, so that column must
   *     exist and be unique.
   *
   * This is a lower bound. The real table has more columns, and the capture is
   * what supplies them.
   */
  provenColumns: string[];
  /** Foreign keys from elsewhere that point at this table. */
  referencedBy: Array<{ from: string; column: string }>;
  /** Which migrations alter it, i.e. what breaks without it. */
  alteredBy: string[];
  /**
   * Every migration that names it at all — ALTER, SELECT, INSERT, INDEX.
   *
   * `alteredBy` alone misses the tables a migration only reads from, and those
   * are just as fatal: the chain's actual first failure is `001`, which merely
   * selects from two tables nothing creates. Keeping both makes the difference
   * between "shape is proven" and "existence is proven" visible.
   */
  neededBy: string[];
  owner: string;
}

const ADD_COLUMN = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:servana\.)?(\w+)([\s\S]*?);/gi;

/**
 * The requirements a captured baseline must satisfy, computed from the
 * repository rather than declared by hand.
 */
export const requirements = (): TableRequirement[] => {
  const catalog = replayMigrationsOnly();
  const missing = missingBaselineTables(catalog);
  const out = new Map<string, TableRequirement>();
  for (const table of missing) {
    out.set(table, {
      table, provenColumns: [], referencedBy: [], alteredBy: [], neededBy: [],
      owner: APPROVED_OWNER_ROLES[0],
    });
  }

  // Every migration that names a missing table, however it names it.
  for (const problem of catalog.problems) {
    if (problem.kind !== 'missing-table') continue;
    const match =
      /ALTER TABLE on ([\w.]+)/.exec(problem.detail) ??
      /reference to ([\w.]+)/.exec(problem.detail) ??
      /unknown ([\w.]+)/.exec(problem.detail);
    const requirement = match ? out.get(match[1]) : undefined;
    if (requirement && !requirement.neededBy.includes(problem.file)) {
      requirement.neededBy.push(problem.file);
    }
  }

  // Columns proven by ADD COLUMN, and the migrations that need the table.
  for (const input of migrationInputs()) {
    for (const match of input.sql.matchAll(ADD_COLUMN)) {
      const table = match[1].toLowerCase();
      const requirement = out.get(table);
      if (!requirement) continue;
      if (!requirement.alteredBy.includes(input.file)) requirement.alteredBy.push(input.file);
      for (const add of match[2].matchAll(/ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?/gi)) {
        const column = add[1].toLowerCase();
        if (!requirement.provenColumns.includes(column)) requirement.provenColumns.push(column);
      }
      for (const alter of match[2].matchAll(/ALTER\s+(?:COLUMN\s+)?"?(\w+)"?\s+(?:SET|DROP|TYPE)/gi)) {
        const column = alter[1].toLowerCase();
        if (!requirement.provenColumns.includes(column)) requirement.provenColumns.push(column);
      }
    }
  }

  // Columns proven by an inbound foreign key.
  for (const table of catalog.tables.values()) {
    for (const column of table.columns.values()) {
      if (!column.references) continue;
      const [target, targetColumn] = column.references.split('.');
      const requirement = out.get(target);
      if (!requirement) continue;
      requirement.referencedBy.push({ from: table.name, column: column.name });
      if (!requirement.provenColumns.includes(targetColumn)) {
        requirement.provenColumns.push(targetColumn);
      }
    }
  }

  return [...out.values()].sort((a, b) => a.table.localeCompare(b.table));
};

// ─── Canonical semantics (§155–§157) ──────────────────────────────────────────

export interface SemanticFinding {
  rule: string;
  ok: boolean;
  detail: string;
}

/**
 * The Catalog V2 rules, executed against a replayed catalog.
 *
 * These are checkable TODAY, because migration 020 creates the whole Catalog V2
 * hierarchy and 024/025 finish it — unlike the missing foundational tables, none
 * of Catalog V2 depends on a schema that exists only in production.
 *
 * They are also the rules with the most expensive failure mode: if
 * `service_families` ever became the target of a canonical capability foreign
 * key again, the platform would silently be back to booking a coarse family
 * instead of a specific service.
 */
export const checkCanonicalSemantics = (catalog: SchemaCatalog): SemanticFinding[] => {
  const findings: SemanticFinding[] = [];
  const add = (rule: string, ok: boolean, detail: string) => findings.push({ rule, ok, detail });

  const services = catalog.tables.get('services');
  const subcategories = catalog.tables.get('catalog_subcategories');
  const categories = catalog.tables.get('catalog_categories');

  // §155 — the hierarchy exists and is wired.
  add('catalog-hierarchy-exists', Boolean(services && subcategories && categories),
    `services=${!!services} catalog_subcategories=${!!subcategories} catalog_categories=${!!categories}`);

  const subcategoryFk = services?.columns.get('subcategory_id');
  const subcategoryTarget = subcategoryFk ? referenceTarget(catalog, subcategoryFk) : null;
  add('services-to-subcategory', subcategoryTarget === 'catalog_subcategories.id',
    `services.subcategory_id -> ${subcategoryTarget ?? 'nothing'}`);

  const categoryFk = subcategories?.columns.get('category_id');
  const categoryTarget = categoryFk ? referenceTarget(catalog, categoryFk) : null;
  add('subcategory-to-category', categoryTarget === 'catalog_categories.id',
    `catalog_subcategories.category_id -> ${categoryTarget ?? 'nothing'}`);

  // §155 — services is the renamed catalog_services, not the legacy table.
  add('services-is-catalog-v2', Boolean(services?.formerNames.includes('catalog_services')),
    `services former names: [${services?.formerNames.join(', ') ?? ''}]`);

  // §157 — canonical provider capability targets services.id.
  const capability = catalog.tables.get('catalog_provider_services')?.columns.get('service_id');
  const capabilityTarget = capability ? referenceTarget(catalog, capability) : null;
  add('capability-to-canonical-service', capabilityTarget === 'services.id',
    `catalog_provider_services.service_id -> ${capabilityTarget ?? 'nothing'}`);

  // §157 — and nothing canonical targets the legacy family table.
  const familyTargets: string[] = [];
  for (const table of catalog.tables.values()) {
    for (const column of table.columns.values()) {
      if (referenceTarget(catalog, column)?.startsWith('service_families.')) {
        familyTargets.push(`${table.name}.${column.name}`);
      }
    }
  }
  add('no-canonical-fk-to-family',
    !familyTargets.some((t) => t.startsWith('catalog_')),
    familyTargets.length ? `family-targeting FKs: ${familyTargets.join(', ')}` : 'none');

  // §156 — the sequence, its floor, its ownership and the column default.
  const sequence = catalog.sequences.get('catalog_services_id_seq');
  add('services-sequence-exists', Boolean(sequence), sequence ? 'present' : 'missing');
  add('services-sequence-floor', (sequence?.start ?? 0) >= 100000,
    `START ${sequence?.start ?? 'none'} — must clear carried-over ids`);
  add('services-sequence-owned-by-column', sequence?.ownedBy === 'services.id',
    `OWNED BY ${sequence?.ownedBy ?? 'nothing'}`);
  add('services-id-default', Boolean(services?.columns.get('id')?.default?.includes('catalog_services_id_seq')),
    `services.id DEFAULT ${services?.columns.get('id')?.default ?? 'none'}`);

  // Ownership, for everything the migrations create.
  const wrongOwner: string[] = [];
  for (const table of catalog.tables.values()) {
    if (table.isView) continue;
    if (table.owner && !APPROVED_OWNER_ROLES.includes(table.owner)) wrongOwner.push(table.name);
  }
  add('no-unapproved-owner', wrongOwner.length === 0,
    wrongOwner.length ? wrongOwner.join(', ') : `all declared owners in [${APPROVED_OWNER_ROLES.join(', ')}]`);

  const sequenceOwner = sequence?.owner;
  add('sequence-owner-approved', !sequenceOwner || APPROVED_OWNER_ROLES.includes(sequenceOwner),
    `catalog_services_id_seq owner ${sequenceOwner ?? 'unset'}`);

  return findings;
};

/** Semantic rules that must hold. A failing one blocks the gate. */
export const failingSemantics = (catalog: SchemaCatalog): SemanticFinding[] =>
  checkCanonicalSemantics(catalog).filter((f) => !f.ok);

// ─── Verifying a captured baseline ────────────────────────────────────────────

export interface BaselineVerdict {
  captured: boolean;
  bootstrapsFromZero: boolean;
  missingTables: string[];
  /** Requirements a captured baseline fails to satisfy. */
  unmetRequirements: string[];
  failingSemantics: SemanticFinding[];
  /** Anything in the baseline that must never be there. */
  sanitisationProblems: string[];
}

/**
 * Patterns that must never appear in a committed baseline.
 *
 * §153: no secrets, no environment-specific owners, no volatile data, no
 * private records. Checked against the file rather than trusted, because a
 * baseline is produced by a tool run on somebody's laptop against a database
 * full of real people.
 */
export const FORBIDDEN_BASELINE_PATTERNS: ReadonlyArray<{ pattern: RegExp; why: string }> =
  Object.freeze([
    {
      pattern: /\bINSERT\s+INTO\b/i,
      why: 'row data — a schema baseline carries structure and never records',
    },
    {
      pattern: /\bCOPY\s+\w+.*\bFROM\s+stdin\b/i,
      why: 'bulk row data from a dump — the same problem at a larger scale',
    },
    {
      pattern: /@[\w.-]+\.[a-z]{2,}/i,
      why: 'something shaped like an email address, which means a person reached the file',
    },
    {
      pattern: /\+63\d{9,}/,
      why: 'a Philippine mobile number — a customer or provider contact detail',
    },
    {
      pattern: /\bPASSWORD\s+'/i,
      why: 'a role password, which must never live in a versioned artifact',
    },
    {
      pattern: /\b(eyJ[A-Za-z0-9_-]{10,})/,
      why: 'a JSON Web Token — a live credential someone could replay',
    },
    {
      pattern: /\$2[aby]\$\d{2}\$/,
      why: 'a bcrypt hash — a password digest, still sensitive and still crackable',
    },
    {
      pattern: /\bOWNER\s+TO\s+postgres\b/i,
      why: 'the postgres superuser as an owner, which is the ownership outage in a file',
    },
    {
      pattern: /\bCREATE\s+ROLE\b/i,
      why: 'role creation — environment-specific, and roles are provisioned outside the schema',
    },
    {
      pattern: /\bALTER\s+ROLE\b/i,
      why: 'role alteration — environment-specific and often carries a password',
    },
  ]);

export const sanitisationProblems = (sql: string): string[] => {
  const problems: string[] = [];
  for (const { pattern, why } of FORBIDDEN_BASELINE_PATTERNS) {
    const match = pattern.exec(sql);
    if (match) problems.push(`${why} (matched near "${match[0].slice(0, 40)}")`);
  }
  return problems;
};

export const verifyBaseline = (): BaselineVerdict => {
  const baseline = baselineInput();
  const catalog = replayWithBaseline();
  const missing = missingBaselineTables(catalog);

  const unmet: string[] = [];
  if (baseline) {
    for (const requirement of requirements()) {
      const table = resolveTableName(catalog, requirement.table);
      if (!table) { unmet.push(`${requirement.table}: not created by the baseline`); continue; }
      for (const column of requirement.provenColumns) {
        if (!table.columns.has(column)) {
          unmet.push(`${requirement.table}.${column}: proven necessary, absent from the baseline`);
        }
      }
    }
  }

  return {
    captured: baseline !== null,
    bootstrapsFromZero: missing.length === 0,
    missingTables: missing,
    unmetRequirements: unmet,
    failingSemantics: failingSemantics(catalog),
    sanitisationProblems: baseline ? sanitisationProblems(baseline.sql) : [],
  };
};
