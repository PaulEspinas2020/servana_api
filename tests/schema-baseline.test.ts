/**
 * Fresh-database reproducibility (§152, §155–§160).
 *
 * ## What this suite proves, and what it cannot
 *
 * It PROVES, statically, that the migration chain in this repository cannot
 * build Servana's database from zero: eleven foundational tables are altered by
 * migrations and created by none, so a fresh database stops at migration 009.
 * That is the structural gap this command exists to close, and it is asserted
 * here as a fact with a name attached rather than described in a document.
 *
 * It CANNOT prove that a captured baseline matches production, because no
 * PostgreSQL engine is reachable from this environment and the only database
 * with credentials is production. Every assertion below is therefore about the
 * repository's own consistency, and the certification says so.
 *
 * ## Why the gap assertion is written to change
 *
 * `bootstrapsFromZero` is asserted `false` today. When a baseline is captured
 * that becomes `true` and this test fails — deliberately. A test that passed
 * either way would be measuring nothing, and the failure is the prompt to move
 * the assertion and the certification together.
 */

import fs from 'fs';
import path from 'path';
import {
  BASELINE_FILE,
  FORBIDDEN_BASELINE_PATTERNS,
  baselineGap,
  baselineInput,
  checkCanonicalSemantics,
  migrationInputs,
  replayMigrationsOnly,
  replayWithBaseline,
  requirements,
  sanitisationProblems,
  verifyBaseline,
} from '../scripts/lib/schemaBaseline';
import {
  columnOf,
  danglingForeignKeys,
  referenceTarget,
  replay,
  resolveTableName,
  splitStatements,
} from '../scripts/lib/schemaModel';
import { residualTransactionControl } from '../scripts/lib/migrationSafety';
import {
  CATALOG_QUERIES,
  checkSource,
  queriesAreCatalogOnly,
  renderBaseline,
  renderType,
} from '../scripts/capture-schema-baseline';
import { checkLiveTarget } from '../scripts/verify-fresh-db';

const REPO_ROOT = path.resolve(__dirname, '..');

// ─── The model is trustworthy enough to build on ──────────────────────────────

describe('the replay model reads the migrations it claims to', () => {
  const catalog = replayMigrationsOnly();

  it('reads every migration in the directory', () => {
    expect(migrationInputs().length).toBeGreaterThan(30);
  });

  it('parses every statement — an unread one is unmeasured risk', () => {
    /**
     * The model's own limit, asserted. Every conclusion in this suite is only
     * as strong as this number, so it is pinned at zero rather than "small".
     */
    const unparsed = catalog.problems.filter((p) => p.kind === 'unparsed');
    expect(unparsed.map((p) => `${p.file}: ${p.statement}`)).toEqual([]);
    expect(catalog.statementsSeen).toBeGreaterThan(300);
  });

  it('does not split a statement on a semicolon inside a literal or a block', () => {
    const sql = `COMMENT ON TABLE t IS 'a; b; c';\nDO $$ BEGIN PERFORM 1; END $$;\nSELECT 1;`;
    expect(splitStatements(sql)).toHaveLength(3);
  });

  it('follows a rename when resolving a foreign key, as PostgreSQL does', () => {
    // FKs bind to an OID, not a name. `catalog_services` became `services`, and
    // a model comparing names would report every FK to it as dangling.
    expect(resolveTableName(catalog, 'catalog_services')?.name).toBe('services');
  });

  it('leaves no foreign key pointing at a table the chain never builds, except the known three', () => {
    // `provider_catalog_offerings` and `worker_requirements` are themselves part
    // of the baseline gap, so their inbound FKs dangle for the same reason.
    const dangling = danglingForeignKeys(catalog).map((d) => d.to);
    for (const target of dangling) {
      expect(['provider_catalog_offerings.id', 'worker_requirements.id']).toContain(target);
    }
  });
});

// ─── §152: the gap ────────────────────────────────────────────────────────────

describe('the repository cannot build the database from zero', () => {
  const gap = baselineGap();

  it('names the eleven foundational tables nothing creates', () => {
    expect(gap.missingTables).toEqual([
      'booking_escalations',
      'booking_workers',
      'bookings',
      'chat_participants',
      'disbursements',
      'email_otps',
      'payments',
      'service_families',
      'services',
      'user_profile',
      'worker_requirements',
    ]);
  });

  it('reports bootstrapsFromZero as false, which is the honest state today', () => {
    /**
     * Asserted `false` on purpose. When a baseline is captured this fails, and
     * that failure is the prompt to move this assertion and the certification
     * in the same change. A test that tolerated both answers would measure
     * nothing.
     */
    expect(gap.bootstrapsFromZero).toBe(false);
    expect(gap.baselineCaptured).toBe(false);
  });

  it('the chain stops at the first ALTER of a table nothing creates', () => {
    // Migration 009 is the wall. Anything before it is catalog seed data.
    const first = replayMigrationsOnly().problems.find((p) => p.kind === 'missing-table');
    expect(first?.file).toBe('009-provider-profile-compliance.sql');
    expect(first?.detail).toContain('user_profile');
  });

  it('every migration that alters a missing table is named in the requirements', () => {
    for (const requirement of requirements()) {
      // `service_families` is a rename cascade rather than a directly altered
      // table, so it is the one entry with no ADD COLUMN evidence.
      if (requirement.table === 'service_families') continue;
      expect(requirement.alteredBy.length).toBeGreaterThan(0);
    }
  });

  it('records the columns a baseline must supply, from evidence not guesswork', () => {
    const byTable = new Map(requirements().map((r) => [r.table, r]));
    // Proven by ALTER ... ADD COLUMN in a real migration.
    expect(byTable.get('bookings')!.provenColumns).toEqual(
      expect.arrayContaining(['catalog_service_id', 'is_synthetic']),
    );
    expect(byTable.get('payments')!.provenColumns).toEqual(
      expect.arrayContaining(['checkout_attempt', 'refund_attempt', 'return_origin']),
    );
    // Proven by an inbound foreign key rather than by an ALTER.
    expect(byTable.get('worker_requirements')!.referencedBy).toEqual(
      expect.arrayContaining([{ from: 'provider_certifications', column: 'related_document_id' }]),
    );
    expect(byTable.get('worker_requirements')!.provenColumns).toContain('id');
  });

  it('proves a total of 42 columns across the eleven', () => {
    // A number that moves when a migration adds a column to a foundational
    // table, so the requirement set cannot silently go stale.
    const total = requirements().reduce((n, r) => n + r.provenColumns.length, 0);
    expect(total).toBe(42);
  });

  it('does NOT ship invented DDL for any of them', () => {
    /**
     * The central judgement of this tab, asserted so it cannot be quietly
     * reversed. The migrations only ADD columns to these eleven — not one
     * defines a primary key or a core column — so their real shape is not in
     * this repository. Writing plausible CREATE TABLEs would make CI prove a
     * fresh database matches a schema production does not have.
     */
    expect(fs.existsSync(BASELINE_FILE)).toBe(false);
    expect(baselineInput()).toBeNull();
  });
});

// ─── §155–§157: canonical semantics ───────────────────────────────────────────

describe('Catalog V2 semantics hold, and are checkable today', () => {
  const catalog = replayWithBaseline();
  const findings = checkCanonicalSemantics(catalog);
  const byRule = new Map(findings.map((f) => [f.rule, f]));

  it('every declared rule passes', () => {
    expect(findings.filter((f) => !f.ok).map((f) => `${f.rule}: ${f.detail}`)).toEqual([]);
    expect(findings.length).toBeGreaterThanOrEqual(12);
  });

  it('the hierarchy is category → subcategory → service', () => {
    expect(byRule.get('services-to-subcategory')!.ok).toBe(true);
    expect(byRule.get('subcategory-to-category')!.ok).toBe(true);
    const subcategory = columnOf(catalog, 'services', 'subcategory_id');
    expect(referenceTarget(catalog, subcategory!)).toBe('catalog_subcategories.id');
  });

  it('`services` is the renamed catalog_services, not the legacy family table', () => {
    /**
     * Migration 024 renames the legacy `services` to `service_families` and
     * then `catalog_services` to `services`. Getting this backwards would put
     * the coarse family back in the canonical position, which is the one thing
     * the standing constraints forbid outright.
     */
    expect(catalog.tables.get('services')!.formerNames).toContain('catalog_services');
  });

  it('canonical provider capability targets services.id (§157)', () => {
    const capability = columnOf(catalog, 'catalog_provider_services', 'service_id');
    expect(referenceTarget(catalog, capability!)).toBe('services.id');
  });

  it('no catalog_* table has a foreign key to service_families', () => {
    // Legacy relationships (employee_services, service_options,
    // worker_service_applications) still key on families and that is intended;
    // a CANONICAL table doing so would not be.
    expect(byRule.get('no-canonical-fk-to-family')!.ok).toBe(true);
  });
});

describe('the services sequence cannot collide with carried-over ids (§156)', () => {
  const catalog = replayWithBaseline();
  const sequence = catalog.sequences.get('catalog_services_id_seq');

  it('exists, and starts above every legacy id', () => {
    /**
     * Catalog V2 seeded `services.id` FROM `service_options.id`, so every
     * carried-over id is in the legacy range. A sequence starting at 1 would
     * mint an id that already belongs to a migrated service.
     */
    expect(sequence).toBeDefined();
    expect(sequence!.start).toBe(100000);
  });

  it('is owned BY the column, so it is dropped with the table', () => {
    expect(sequence!.ownedBy).toBe('services.id');
  });

  it('is owned by the approved runtime role', () => {
    expect(sequence!.owner).toBe('admin');
  });

  it('is actually wired as the column default', () => {
    // A sequence that exists and is not the default is a sequence nothing uses.
    expect(columnOf(catalog, 'services', 'id')!.default)
      .toBe("nextval('servana.catalog_services_id_seq')");
  });

  it('the setval floor is reapplied by migration 025, not assumed', () => {
    const migration = migrationInputs().find((m) => m.file.startsWith('025-'))!;
    expect(migration.sql).toMatch(/setval\(/);
    expect(migration.sql).toMatch(/GREATEST\(100000/);
  });

  it('the bootstrap fixtures sit above the sequence and never advance it', () => {
    /**
     * Three ranges, no overlap: carried-over ids below 100000, minted ids from
     * 100001, fixtures at 900000+. A `setval` in the fixture file would push
     * newly minted services into the fixture band, where they would be
     * indistinguishable from seed data.
     */
    const fixtures = fs.readFileSync(
      path.join(REPO_ROOT, 'scripts/baseline/bootstrap-fixtures.sql'), 'utf8',
    );
    expect(fixtures).toMatch(/900001|900101|900201/);
    expect(fixtures).not.toMatch(/^\s*SELECT setval/m);
    expect(fixtures).toContain('deliberately NOT advanced');
  });
});

describe('every object the migrations create is owned by the runtime role', () => {
  const catalog = replayWithBaseline();

  it('declares no owner outside the approved list', () => {
    const wrong = [...catalog.tables.values()]
      .filter((t) => t.owner && t.owner !== 'admin')
      .map((t) => `${t.name} -> ${t.owner}`);
    expect(wrong).toEqual([]);
  });

  it('never names postgres as an owner', () => {
    // The outage this guards against: 29 of 116 tables owned by `postgres`
    // after a hand-applied migration, with the app holding no privileges.
    for (const input of migrationInputs()) {
      expect(input.sql).not.toMatch(/OWNER\s+TO\s+postgres\b/i);
    }
  });
});

// ─── §159: replay expectations ────────────────────────────────────────────────

describe('the chain can be replayed', () => {
  it('no migration leaks transaction control past the stripper', () => {
    // The wrapper owns the transaction. A surviving COMMIT would break
    // atomicity on the very first fresh-database run — which is when nobody is
    // watching for it.
    const leaking = migrationInputs()
      .filter((m) => residualTransactionControl(m.sql).length > 0)
      .map((m) => m.file);
    expect(leaking).toEqual([]);
  });

  it('replaying the same inputs twice yields the same catalog', () => {
    // Determinism, so a CI failure is about the migrations and not about the
    // model having state.
    const a = replay(migrationInputs());
    const b = replay(migrationInputs());
    expect([...a.tables.keys()].sort()).toEqual([...b.tables.keys()].sort());
    expect(a.problems.length).toBe(b.problems.length);
  });

  it('creates every table with IF NOT EXISTS, so a second pass is a no-op', () => {
    /**
     * §159 asks for idempotence explicitly. A `CREATE TABLE` without the guard
     * fails on the second replay, and the second replay is exactly what a
     * re-run after a partial failure is.
     */
    const unguarded: string[] = [];
    for (const input of migrationInputs()) {
      for (const match of input.sql.matchAll(/CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?(?:servana\.)?(\w+)/gi)) {
        if (!match[1]) unguarded.push(`${input.file}: ${match[2]}`);
      }
    }
    expect(unguarded).toEqual([]);
  });

  it('creates every index with IF NOT EXISTS too', () => {
    const unguarded: string[] = [];
    for (const input of migrationInputs()) {
      for (const match of input.sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(CONCURRENTLY\s+)?(IF\s+NOT\s+EXISTS\s+)?(\w+)/gi)) {
        if (!match[2]) unguarded.push(`${input.file}: ${match[3]}`);
      }
    }
    expect(unguarded).toEqual([]);
  });

  it('the migration ledger is keyed on the file name, so order is stable', () => {
    const runner = fs.readFileSync(path.join(REPO_ROOT, 'scripts/run-migrations.ts'), 'utf8');
    expect(runner).toMatch(/schema_migrations/);
    expect(runner).toMatch(/migration_name TEXT PRIMARY KEY/);
    expect(runner).toMatch(/checksum_sha256/);
    // Applied in lexical order, which is why the NNN- prefix is mandatory.
    expect(runner).toMatch(/\.sort\(\)/);
  });
});

// ─── §153: capture tooling ────────────────────────────────────────────────────

describe('the capture tool cannot read production or copy a row', () => {
  const production = { host: 'prod.servana.internal', database: 'servana' };

  it('refuses the configured production host outright', () => {
    const check = checkSource('postgres://u@prod.servana.internal:5432/servana', {}, production);
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain('production host');
  });

  it('refuses the production database name on a remote host', () => {
    const check = checkSource('postgres://u@some-replica:5432/servana', {}, production);
    expect(check.allowed).toBe(false);
  });

  it('allows a local disposable instance', () => {
    expect(checkSource('postgres://u@localhost:5432/servana_baseline', {}, production).allowed)
      .toBe(true);
  });

  it('requires an explicit acknowledgement for any other host', () => {
    const target = 'postgres://u@scratch.example:5433/anything';
    expect(checkSource(target, {}, production).allowed).toBe(false);
    expect(checkSource(target, { BASELINE_SOURCE_ACK: 'scratch.example:5433' }, production).allowed)
      .toBe(true);
  });

  it('issues catalog queries only — there is no path that reads an app table', () => {
    /**
     * "It cannot copy a row" as a checkable property rather than a comment.
     * Every query is declared as data and every one must touch a catalog view.
     */
    expect(CATALOG_QUERIES.length).toBeGreaterThan(5);
    expect(queriesAreCatalogOnly()).toBe(true);
    for (const query of CATALOG_QUERIES) {
      expect(query.sql).not.toMatch(/\bFROM\s+servana\./i);
    }
  });

  it('normalises ownership rather than copying it from the source', () => {
    const sql = renderBaseline(new Map([
      ['columns', [{ table_name: 'demo', column_name: 'id', data_type: 'integer', character_maximum_length: null, numeric_precision: 32, numeric_scale: 0, is_nullable: 'NO', column_default: null }]],
      ['constraints', []], ['indexes', []], ['sequences', []], ['sequence_ownership', []],
    ]));
    expect(sql).toContain('ALTER TABLE servana.demo OWNER TO admin;');
    expect(sql).not.toMatch(/OWNER TO postgres/i);
  });

  it('renders types with their precision', () => {
    expect(renderType({ data_type: 'character varying', character_maximum_length: 200, numeric_precision: null, numeric_scale: null }))
      .toBe('CHARACTER VARYING(200)');
    expect(renderType({ data_type: 'numeric', character_maximum_length: null, numeric_precision: 12, numeric_scale: 2 }))
      .toBe('NUMERIC(12,2)');
  });

  it('emits CREATE TABLE IF NOT EXISTS, so the baseline is replayable too', () => {
    const sql = renderBaseline(new Map([
      ['columns', [{ table_name: 'demo', column_name: 'id', data_type: 'integer', character_maximum_length: null, numeric_precision: 32, numeric_scale: 0, is_nullable: 'NO', column_default: null }]],
      ['constraints', []], ['indexes', []], ['sequences', []], ['sequence_ownership', []],
    ]));
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS servana.demo');
  });
});

describe('a baseline is scanned for secrets and people before it is written', () => {
  it('rejects row data', () => {
    expect(sanitisationProblems("INSERT INTO servana.user_profile VALUES (1);")[0])
      .toContain('row data');
  });

  it('rejects an email address, a phone number, a JWT and a bcrypt hash', () => {
    expect(sanitisationProblems("-- dana@example.com").length).toBe(1);
    expect(sanitisationProblems("-- +639170000000").length).toBe(1);
    expect(sanitisationProblems("-- eyJhbGciOiJIUzI1NiJ9abc").length).toBe(1);
    expect(sanitisationProblems("-- $2b$10$abcdefghijklmno").length).toBe(1);
  });

  it('rejects environment-specific ownership and role statements', () => {
    expect(sanitisationProblems('ALTER TABLE x OWNER TO postgres;').length).toBe(1);
    expect(sanitisationProblems("CREATE ROLE admin PASSWORD 'x';").length).toBeGreaterThan(0);
  });

  it('accepts clean DDL', () => {
    expect(sanitisationProblems(
      'CREATE TABLE IF NOT EXISTS servana.demo (id INT);\nALTER TABLE servana.demo OWNER TO admin;',
    )).toEqual([]);
  });

  it('declares a reason for every forbidden pattern', () => {
    for (const { why } of FORBIDDEN_BASELINE_PATTERNS) {
      expect(why.length).toBeGreaterThan(8);
    }
  });

  it('reports nothing to verify while no baseline exists', () => {
    const verdict = verifyBaseline();
    expect(verdict.captured).toBe(false);
    expect(verdict.sanitisationProblems).toEqual([]);
    expect(verdict.unmetRequirements).toEqual([]);
    // ...but the gate still fails, because the gap is the thing.
    expect(verdict.bootstrapsFromZero).toBe(false);
  });
});

// ─── §158: the CI gate ────────────────────────────────────────────────────────

describe('the fresh-database gate is wired and refuses production', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));

  it('exposes db:verify, baseline:plan and baseline:capture', () => {
    expect(pkg.scripts['db:verify']).toBeDefined();
    expect(pkg.scripts['baseline:plan']).toBeDefined();
    expect(pkg.scripts['baseline:capture']).toBeDefined();
  });

  it('the live gate refuses the production host', () => {
    expect(checkLiveTarget('postgres://u@prod.servana.internal/db', {}, { host: 'prod.servana.internal' }).allowed)
      .toBe(false);
  });

  it('the live gate allows localhost and gates anything else behind an ack', () => {
    expect(checkLiveTarget('postgres://u@localhost:5432/fresh', {}, { host: 'prod' }).allowed).toBe(true);
    expect(checkLiveTarget('postgres://u@ci-db:5432/fresh', {}, { host: 'prod' }).allowed).toBe(false);
    expect(checkLiveTarget('postgres://u@ci-db:5432/fresh', { FRESH_DB_ACK: 'ci-db:5432' }, { host: 'prod' }).allowed)
      .toBe(true);
  });

  it('the workflow pins a major version and applies as the runtime role', () => {
    const workflow = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/fresh-db.yml'), 'utf8');
    expect(workflow).toMatch(/image:\s*postgres:16/);
    expect(workflow).not.toMatch(/image:\s*postgres:latest/);
    // Applying as a superuser would let a migration pass here and fail live.
    expect(workflow).toContain('CREATE SCHEMA servana AUTHORIZATION admin');
    expect(workflow).toContain('postgres://admin:');
  });

  it('the workflow asserts ownership after applying', () => {
    const workflow = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/fresh-db.yml'), 'utf8');
    expect(workflow).toContain('tableowner <> \'admin\'');
  });

  it('the static job runs unconditionally and the live job waits for a baseline', () => {
    const workflow = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/fresh-db.yml'), 'utf8');
    expect(workflow).toMatch(/hashFiles\('scripts\/baseline\/000-baseline\.sql'\) != ''/);
  });

  it('carries no real credential', () => {
    const workflow = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/fresh-db.yml'), 'utf8');
    expect(workflow).not.toMatch(/eyJ[A-Za-z0-9._-]{20,}/);
    expect(workflow).toMatch(/ci-not-a-secret/);
  });
});

// ─── §160: fixtures ───────────────────────────────────────────────────────────

describe('the bootstrap fixtures create no fake production truth', () => {
  const fixtures = fs.readFileSync(
    path.join(REPO_ROOT, 'scripts/baseline/bootstrap-fixtures.sql'), 'utf8',
  );

  it('seeds only the catalog hierarchy', () => {
    const inserts = [...fixtures.matchAll(/INSERT\s+INTO\s+servana\.(\w+)/gi)].map((m) => m[1]);
    expect([...new Set(inserts)].sort())
      .toEqual(['catalog_categories', 'catalog_subcategories', 'services']);
  });

  it('seeds no person, booking, payment or credential', () => {
    for (const table of [
      'user_credentials', 'user_profile', 'bookings', 'payments',
      'customer_reviews', 'chat_messages', 'worker_requirements',
    ]) {
      expect(fixtures).not.toMatch(new RegExp(`INSERT\\s+INTO\\s+servana\\.${table}\\b`, 'i'));
    }
  });

  it('marks every row as synthetic in its own data', () => {
    // So a row that escapes into a shared environment identifies itself rather
    // than being read as a customer.
    expect(fixtures.match(/FIXTURE/g)!.length).toBeGreaterThanOrEqual(3);
    expect(fixtures).toMatch(/synthetic/i);
  });

  it('leaves the seeded service unbookable', () => {
    // A bookable fixture service is a service somebody can create a booking
    // against in a shared environment.
    expect(fixtures).toMatch(/false,\s*'inactive'/);
  });

  it('is idempotent, so seeding twice is not an error', () => {
    const inserts = (fixtures.match(/INSERT\s+INTO/gi) ?? []).length;
    const guards = (fixtures.match(/ON\s+CONFLICT\s*\([^)]*\)\s*DO\s+NOTHING/gi) ?? []).length;
    expect(guards).toBe(inserts);
  });

  it('contains nothing the sanitiser would reject', () => {
    // The fixture file is held to the same standard as a captured baseline,
    // minus the no-rows rule it exists to break.
    const withoutInserts = fixtures.replace(/INSERT\s+INTO/gi, '-- seeded');
    expect(sanitisationProblems(withoutInserts)).toEqual([]);
  });
});
