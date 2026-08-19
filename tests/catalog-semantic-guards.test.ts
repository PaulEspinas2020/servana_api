import fs from 'fs';
import path from 'path';

/**
 * CATALOG SEMANTIC GUARDS — release gate.
 *
 * Catalog V2 made `services` mean the 95 canonical Specific Services and
 * `service_families` mean the 10 legacy coarse families. Nothing enforced that
 * distinction, so a future refactor could quietly map Service back onto the family
 * table — which is the exact ambiguity the whole migration existed to remove, and
 * which cost a production outage on the way.
 *
 * These tests fail if the semantics are reversed. They are deliberately
 * source-and-migration based rather than database based, so they run in CI without
 * a live database.
 */

const SRC = path.join(__dirname, '..', 'src');
const MIG = path.join(__dirname, '..', 'scripts', 'migrations');
const read = (...p: string[]) => fs.readFileSync(path.join(...p), 'utf8');
const readSrc = (...p: string[]) => read(SRC, ...p);
const migration = (name: string) => read(MIG, name);

/** Every .ts under src, so a new file cannot dodge the guards. */
function allSourceFiles(dir = SRC, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) allSourceFiles(full, acc);
    else if (entry.name.endsWith('.ts')) acc.push(full);
  }
  return acc;
}

// ─── §40 / §47 — Service maps to `services` ──────────────────────────────────

describe('semantic guard: Service means the canonical Specific Service', () => {
  const expand = migration('020-catalog-v2-expand.sql');
  const rename = migration('024-catalog-v2-canonical-rename.sql');

  it('the canonical table carries the hierarchy column, not a category string', () => {
    // Table names alone are not evidence (§47) — the canonical entity is the one
    // that hangs off a subcategory. The legacy family carried a free-text category.
    expect(expand).toMatch(/subcategory_id\s+INT NOT NULL REFERENCES \$\{dbSchema\}\.catalog_subcategories\(id\)|subcategory_id\s+INT NOT NULL REFERENCES servana\.catalog_subcategories\(id\)/);
  });

  it('the rename makes services the canonical table and service_families the legacy one', () => {
    expect(rename).toMatch(/ALTER TABLE servana\.services RENAME TO service_families/);
    expect(rename).toMatch(/ALTER TABLE servana\.catalog_services RENAME TO services/);
  });

  it('renames the legacy primary key BEFORE the new table claims it', () => {
    // A constraint name is unique per schema; the reverse order fails with
    // 'relation "services_pkey" already exists'. Learned the hard way.
    const freeIdx = rename.indexOf('RENAME CONSTRAINT services_pkey TO service_families_pkey');
    const claimIdx = rename.indexOf('RENAME CONSTRAINT catalog_services_pkey TO services_pkey');
    expect(freeIdx).toBeGreaterThan(-1);
    expect(claimIdx).toBeGreaterThan(-1);
    expect(freeIdx).toBeLessThan(claimIdx);
  });
});

// ─── §41 — ServiceFamily maps to `service_families` ──────────────────────────

describe('semantic guard: legacy family reads never name the canonical table', () => {
  const LEGACY_FAMILY_MODULES = [
    'services/serviceService.ts',
    'services/serviceApplicationService.ts',
    'services/technicianService.ts',
  ];

  it.each(LEGACY_FAMILY_MODULES)(
    '%s reads legacy families from service_families',
    (rel) => {
      const src = readSrc(...rel.split('/'));
      expect(src).toMatch(/\$\{dbSchema\}\.service_families/);
    },
  );

  it('no module selects legacy-family columns out of the canonical services table', () => {
    // `category` only ever existed on the legacy family. Selecting it from
    // `services` is precisely the query that returned HTTP 500 during the outage.
    for (const file of allSourceFiles()) {
      const src = fs.readFileSync(file, 'utf8');
      const offending = /FROM \$\{dbSchema\}\.services\b[\s\S]{0,200}?\bcategory\b/.test(src)
        || /SELECT[^;]{0,200}\bcategory\b[\s\S]{0,200}FROM \$\{dbSchema\}\.services\b/.test(src);
      expect({ file: path.relative(SRC, file), offending }).toEqual({
        file: path.relative(SRC, file), offending: false,
      });
    }
  });
});

// ─── §42 — provider capability targets the canonical service ─────────────────

describe('semantic guard: canonical provider capability points at services', () => {
  const expand = migration('020-catalog-v2-expand.sql');

  it('catalog_provider_services references the canonical service table', () => {
    expect(expand).toMatch(
      /CREATE TABLE IF NOT EXISTS servana\.catalog_provider_services[\s\S]*?service_id\s+INT NOT NULL REFERENCES servana\.catalog_services\(id\)/,
    );
  });

  it('the capability fan-out is reversible — it records its legacy origin', () => {
    const backfill = migration('021-catalog-v2-backfill.sql');
    expect(backfill).toMatch(/legacy_service_family_id/);
  });
});

// ─── §45 / §46 — worker_service_applications FK, the Deploy 2 defect ─────────

describe('semantic guard: worker_service_applications is a LEGACY family relationship', () => {
  const src = readSrc('services', 'serviceApplicationService.ts');

  it('the FK references service_families, not services', () => {
    /**
     * The fresh-database defect closed in Deploy 2: `service_id` on this table is
     * a LEGACY family id, so pointing it at `services(id)` would resolve a
     * four-way-ambiguous id to the wrong entity.
     *
     * This used to read the bootstrap DDL in `serviceApplicationService`, with the
     * note that "on an existing database CREATE TABLE IF NOT EXISTS skips it, so
     * only this test can catch a regression". TAB 02 deleted that bootstrap, and
     * the note's premise with it: the constraint now comes from
     * `scripts/baseline/000-baseline.sql`, which is production's own dump.
     *
     * So this asserts the FK that ACTUALLY EXISTS rather than the one some code
     * intended to create — which is what the guard was always reaching for.
     */
    const baseline = fs
      .readFileSync(path.join(__dirname, '..', 'scripts', 'baseline', '000-baseline.sql'), 'utf8')
      .replace(/\r\n/g, '\n');

    expect(baseline).toContain(
      'ADD CONSTRAINT worker_service_applications_service_id_fkey FOREIGN KEY (service_id) ' +
        'REFERENCES servana.service_families(id)',
    );
    expect(baseline).not.toMatch(
      /worker_service_applications_service_id_fkey FOREIGN KEY \(service_id\) REFERENCES servana\.services\(id\)/,
    );
    // And the service must not have quietly regained a competing definition.
    expect(src).not.toContain('CREATE TABLE IF NOT EXISTS ${dbSchema}.worker_service_applications');
  });
});

// ─── §43 / §44 — legacy links and options stay legacy ───────────────────────

describe('semantic guard: legacy relationships keep legacy meaning', () => {
  it('employee_services joins resolve to the family table', () => {
    const src = readSrc('services', 'technicianService.ts');
    expect(src).toMatch(/\$\{dbSchema\}\.service_families s ON s\.id = es\.service_id/);
  });

  it('service_options still hangs off the family, not the canonical service', () => {
    // service_options.service_id has always meant the family. Reinterpreting it as a
    // canonical service id would silently re-point 95 rows.
    const src = readSrc('services', 'serviceService.ts');
    expect(src).toMatch(/\$\{dbSchema\}\.service_families/);
  });
});

// ─── §23 / §24 — the id sequence, found broken in the Deploy 2 audit ─────────

describe('semantic guard: a new Service can be created without supplying an id', () => {
  const seq = migration('025-catalog-v2-services-sequence.sql');

  it('services.id has a default backed by a sequence', () => {
    expect(seq).toMatch(/ALTER TABLE servana\.services\s+ALTER COLUMN id SET DEFAULT nextval\(/);
  });

  it('the sequence is owned by the column so it cannot be orphaned again', () => {
    expect(seq).toMatch(/ALTER SEQUENCE servana\.catalog_services_id_seq OWNED BY servana\.services\.id/);
  });

  it('the sequence can never be set below the highest existing id', () => {
    // A plain setval to a constant would collide with the carried-over ids.
    expect(seq).toMatch(/GREATEST\(100000, \(SELECT COALESCE\(MAX\(id\), 0\) FROM servana\.services\)\)/);
  });

  it('does not assert a specific next value (§24)', () => {
    expect(seq).not.toMatch(/=\s*100001/);
  });
});

// ─── Deployment-safety guards learned from the outage ────────────────────────

describe('semantic guard: catalog migrations stay deployment-safe', () => {
  const catalogMigrations = fs.readdirSync(MIG).filter(f => f.startsWith('02') && f.endsWith('.sql'));

  it('has catalog v2 migrations to check', () => {
    expect(catalogMigrations.length).toBeGreaterThan(0);
  });

  it.each(catalogMigrations)('%s contains no transaction control', (name) => {
    // A migration carrying its own BEGIN/COMMIT cannot be dry-run: the inner COMMIT
    // ends the outer transaction and the change lands on production. That happened.
    const sql = migration(name);
    const offending = sql.split('\n').filter(l => /^\s*(BEGIN|COMMIT|ROLLBACK|END)\s*;/i.test(l));
    expect(offending).toEqual([]);
  });

  /**
   * The CREATE matcher below is the whole gate. If it stops matching — an object
   * kind it does not name, a rename, a formatting change — every migration takes
   * the early return and eleven tests pass having asserted nothing.
   *
   * Measured 2026-08-19 via a per-test assertion census: 9 of these 11 already
   * make ZERO assertions, because 9 of the 11 catalog migrations create no
   * objects. That is correct, and it is also exactly the state a broken matcher
   * produces. This test is what tells the two apart.
   */
  const migrationsCreatingObjects = (): string[] =>
    catalogMigrations.filter((name) => /CREATE (TABLE|VIEW|SEQUENCE)/i.test(migration(name)));

  it('the ownership rule is still reached by at least one migration', () => {
    expect(migrationsCreatingObjects()).not.toEqual([]);
  });

  it.each(catalogMigrations)('%s sets ownership on every object it creates', (name) => {
    // Objects created as postgres broke the deploy with "permission denied".
    const sql = migration(name);
    const creates = (sql.match(/CREATE (TABLE|VIEW|SEQUENCE)/gi) ?? []).length;
    if (creates === 0) return;
    expect(sql).toMatch(/OWNER TO admin/);
  });
});
