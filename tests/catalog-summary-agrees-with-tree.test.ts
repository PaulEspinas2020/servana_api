/**
 * The summary must count what the tree serves, and its freshness must move
 * whenever any level of the tree changes.
 *
 * ## What this caught
 *
 * Both defects were invisible until something was archived for the first time.
 *
 * 1. Each count filtered only the row's OWN status, while `getPublicCatalog`
 *    filters `s.status AND sc.status AND c.status`. Retiring one duplicate
 *    subcategory on 2026-08-20 took the tree from 95 services to 85 and left
 *    the summary reporting 95 — the number a client renders as "95 services
 *    available" beside a list of 85.
 *
 * 2. `lastUpdatedAt` was `MAX(services.updated_at)` alone. Archiving a
 *    subcategory changes what the endpoint serves without touching a service
 *    row, so the marker did not move and `notModified` would have answered
 *    **304** to every client holding the old tree. The retirement would have
 *    been invisible to the people it was for.
 *
 * Asserted against the SQL rather than a live database: this repository's
 * suite runs without one, and the defect was in the query text both times.
 */

import fs from 'fs';
import path from 'path';

const source = fs
  .readFileSync(
    path.resolve(__dirname, '../src/services/catalogPublicService.ts'),
    'utf8',
  )
  // Normalised: a CRLF checkout must not change what this test reads.
  .replace(/\r\n/g, '\n');

/** The body of a named exported function, up to the next top-level export. */
const functionBody = (name: string): string => {
  const start = source.indexOf(`export const ${name}`);
  if (start < 0) throw new Error(`${name} is no longer exported`);
  const next = source.indexOf('\nexport ', start + 1);
  return source.slice(start, next < 0 ? undefined : next);
};

/** Collapse whitespace so indentation is not a difference. */
const flat = (sql: string) => sql.replace(/\s+/g, ' ');

describe('the summary counts what the tree serves', () => {
  const summary = flat(functionBody('getPublicCatalogSummary'));

  it('counts services through BOTH ancestors', () => {
    // The tree's rule. A service under an archived subcategory is not served,
    // so it must not be counted.
    expect(summary).toContain(
      'WHERE s.status = $1 AND sc.status = $1 AND c.status = $1',
    );
  });

  it('counts subcategories through their category', () => {
    expect(summary).toContain('WHERE sc.status = $1 AND c.status = $1');
  });

  it('the tree it must agree with still filters all three', () => {
    // Without this the assertions above pin a rule the tree may have stopped
    // applying — agreement asserted from one side only is not agreement.
    const tree = flat(functionBody('getPublicCatalog'));
    expect(tree).toContain(
      'WHERE s.status = $1 AND sc.status = $1 AND c.status = $1',
    );
  });

  it('no count filters on a bare status any more', () => {
    // The shape of the original defect: `FROM services WHERE status = $1`,
    // with no join and no ancestor check.
    expect(summary).not.toMatch(/FROM \$\{dbSchema\}\.services\s+WHERE status = \$1/);
    expect(summary).not.toMatch(
      /FROM \$\{dbSchema\}\.catalog_subcategories\s+WHERE status = \$1/,
    );
  });
});

describe('freshness moves when any level changes', () => {
  const summary = flat(functionBody('getPublicCatalogSummary'));

  it.each([
    ['services', '${dbSchema}.services'],
    ['subcategories', '${dbSchema}.catalog_subcategories'],
    ['categories', '${dbSchema}.catalog_categories'],
  ])('takes MAX(updated_at) from %s', (_level, table) => {
    expect(summary).toContain(`SELECT MAX(updated_at) FROM ${table}`);
  });

  it('combines them with GREATEST, not by picking one', () => {
    expect(summary).toContain('GREATEST(');
  });

  it('a NULL from an empty table cannot swallow the others', () => {
    // GREATEST returns NULL in Postgres only if EVERY argument is NULL, but an
    // empty table yielding NULL would still be a hole worth closing — and a
    // null `lastUpdatedAt` disables conditional requests entirely.
    expect(summary.match(/COALESCE\(\(SELECT MAX\(updated_at\)/g) ?? []).toHaveLength(3);
  });
});

describe('the freshness value is what the response actually sends', () => {
  it('applyFreshness is driven by summary.lastUpdatedAt', () => {
    // The counts could be perfect and the caching still wrong if the header
    // came from somewhere else. This pins the two together.
    const controller = fs
      .readFileSync(
        path.resolve(__dirname, '../src/controllers/catalogPublicController.ts'),
        'utf8',
      )
      .replace(/\r\n/g, '\n');

    expect(controller).toContain('applyFreshness(res, summary.lastUpdatedAt)');
    expect(controller).toContain('notModified(req, summary.lastUpdatedAt)');
  });
});
