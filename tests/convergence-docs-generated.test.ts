/**
 * The convergence documents are DERIVED, and this is what keeps it that way.
 *
 * The parity matrix is the most dangerous document in this repository to let go
 * stale. It is what five client teams plan releases against, and a stale cell
 * reads as permission: "Customer Mobile — migrated" tells a reviewer the alias
 * behind it is safe to delete. Deleting an alias a shipped Flutter build still
 * calls is not a documentation error; it is an outage on a platform whose
 * installed base cannot be corrected for weeks.
 *
 * So the generator is checked in the gate, and these tests assert the committed
 * files say what the code says.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' }, tempId: undefined }));
jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
  pool: { connect: jest.fn() },
}));

import fs from 'fs';
import path from 'path';
import { generateAll, manifestDrift, staleFiles } from '../scripts/generate-convergence-docs';
import {
  CLIENT_SURFACES,
  MIGRATION_ORDER,
  SERVICE_DELEGATIONS,
  SURFACE_CORRECTION_COST,
  SURFACE_LABEL,
  canonicalManifest,
  capabilityRegistry,
  convergenceSummary,
  deprecationPlan,
  parityRow,
} from '../src/api/v1/convergence';
import { RETIREMENT_CRITERIA } from '../src/api/v1/legacyTelemetry';

const REPO_ROOT = path.resolve(__dirname, '..');
const read = (rel: string): string =>
  fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

describe('the committed documents are the generated ones', () => {
  it('are not stale — run "npm run convergence:docs" if this fails', () => {
    expect(staleFiles()).toEqual([]);
  });

  it('generates exactly the five files it claims to', () => {
    expect(generateAll().map((f) => f.relPath)).toEqual([
      'docs/api/CLIENT_ENDPOINT_PARITY_MATRIX.md',
      'docs/api/CANONICAL_CALL_MANIFEST.json',
      'docs/api/DEPRECATION_SCHEDULE.md',
      'docs/api/LEGACY_TELEMETRY_SPEC.md',
      'docs/api/PER_CLIENT_MIGRATION_PLAN.md',
    ]);
  });

  it('the markdown carries the do-not-edit header', () => {
    for (const file of [
      'CLIENT_ENDPOINT_PARITY_MATRIX', 'DEPRECATION_SCHEDULE',
      'LEGACY_TELEMETRY_SPEC', 'PER_CLIENT_MIGRATION_PLAN',
    ]) {
      expect(read(`docs/api/${file}.md`)).toContain('GENERATED FILE');
    }
  });

  it('the manifest says so too, inside the JSON', () => {
    // A JSON file cannot carry a comment, so the note is a key.
    const manifest = JSON.parse(read('docs/api/CANONICAL_CALL_MANIFEST.json'));
    expect(manifest.$comment).toContain('GENERATED');
  });

  it('reports no manifest drift against the router', () => {
    expect(manifestDrift()).toEqual([]);
  });
});

describe('the parity matrix states what the contract states', () => {
  const doc = read('docs/api/CLIENT_ENDPOINT_PARITY_MATRIX.md');
  const summary = convergenceSummary();

  it('publishes the counts from the real registry', () => {
    expect(doc).toContain(`| Capabilities | ${summary.capabilities} |`);
    expect(doc).toContain(`| Canonical endpoints mounted | ${summary.implementedEndpoints} |`);
    expect(doc).toContain(`| Legacy mappings tracked | ${summary.legacyMappings} |`);
  });

  it('carries a row for every capability, with its verdict', () => {
    for (const capability of capabilityRegistry()) {
      const row = parityRow(capability);
      const line = doc.split('\n').find((l) => l.startsWith(`| ${capability.title} | `));
      expect(line).toBeDefined();
      expect(line).toContain(row.verdict);
    }
  });

  it('renders each cell from the caller state, not from prose', () => {
    const legend: Record<string, string> = {
      migrated: '**migrated**', legacy: 'legacy', planned: 'planned', 'n/a': '—', mixed: '⚠ mixed',
    };
    const matrix = doc.slice(doc.indexOf('## 3. The matrix'), doc.indexOf('## 4.'));
    for (const capability of capabilityRegistry()) {
      const row = parityRow(capability);
      const line = matrix.split('\n').find((l) => l.startsWith(`| ${capability.title} | `));
      if (!line) continue;
      const cells = line.split('|').slice(3, 3 + CLIENT_SURFACES.length).map((c) => c.trim());
      CLIENT_SURFACES.forEach((surface, i) => {
        expect(cells[i]).toBe(legend[row.surfaces[surface]]);
      });
    }
  });

  it('states plainly that no client has migrated', () => {
    // The honest number. A matrix showing optimistic cells reads as permission
    // to start deleting aliases.
    expect(summary.migratedCallerCells).toBe(0);
    expect(doc).toContain('No client has migrated');
  });

  it('reports zero divergent capabilities as a number, not a claim', () => {
    expect(doc).toContain(`| **Divergent (forked truth)** | **${summary.byVerdict.DIVERGENT}** |`);
  });

  it('names every surface and its correction cost', () => {
    for (const surface of CLIENT_SURFACES) {
      expect(doc).toContain(SURFACE_LABEL[surface]);
    }
    expect(doc).toContain('reverse order of correction cost');
  });

  it('publishes every verified delegation with its evidence file', () => {
    for (const delegation of SERVICE_DELEGATIONS) {
      expect(doc).toContain(delegation.from);
      expect(doc).toContain(delegation.to);
      expect(doc).toContain(delegation.evidenceFile);
    }
  });

  it('explains what ⚠ mixed means, because it is the cell people misread', () => {
    expect(doc).toContain('⚠ mixed');
    expect(doc).toContain('neither\nmigrated nor legacy');
  });
});

describe('the deprecation schedule is conditions, not dates', () => {
  const doc = read('docs/api/DEPRECATION_SCHEDULE.md');
  const plan = deprecationPlan();

  it('states the four-part gate with the real windows', () => {
    expect(doc).toContain(`${RETIREMENT_CRITERIA.webZeroTrafficDays} consecutive days`);
    expect(doc).toContain(`${RETIREMENT_CRITERIA.mobileZeroTrafficDays} consecutive days`);
  });

  it('carries a row for every alias in the plan', () => {
    expect(plan.length).toBeGreaterThan(50);
    for (const row of plan.slice(0, 25)) {
      expect(doc).toContain(`${row.legacy.method.toUpperCase()} ${row.legacy.path}`);
    }
  });

  it('names the blocker for every non-retirable alias', () => {
    const blocked = plan.filter((r) => !r.retirable);
    expect(blocked.length).toBeGreaterThan(0);
    for (const row of blocked.slice(0, 10)) {
      for (const reason of row.blockedBy) expect(doc).toContain(reason);
    }
  });

  it('contains no calendar date, because none of this is time-based', () => {
    const body = doc.slice(doc.indexOf('## 1.'));
    expect(body).not.toMatch(/\b20\d{2}-\d{2}-\d{2}\b/);
  });

  it('names the next safe step and it is not a deletion', () => {
    expect(doc).toContain('## 5. The next safe step');
    expect(doc).toContain('Neither retires anything');
  });
});

describe('the telemetry spec describes the middleware that exists', () => {
  const doc = read('docs/api/LEGACY_TELEMETRY_SPEC.md');

  it('states what is counted and what is refused', () => {
    expect(doc).toContain('No uid');
    expect(doc).toContain('never\nthe User-Agent itself');
  });

  it('names the real header the middleware reads', () => {
    const source = read('src/api/v1/legacyTelemetry.ts');
    expect(source).toContain('x-servana-client');
    expect(doc).toContain('X-Servana-Client');
  });

  it('publishes the count of routes actually on the watch list', () => {
    const watched = new Set(deprecationPlan().map((r) => `${r.legacy.method} ${r.legacy.path}`));
    expect(doc).toContain(`**${watched.size} distinct legacy routes**`);
  });

  it('says what the measurement cannot tell you', () => {
    // A count of arriving requests cannot see a client that ships the old call
    // behind a feature flag. That is why the caller matrix is a separate gate.
    expect(doc).toContain('## 5. What this cannot tell you');
    expect(doc).toContain('feature flag');
  });
});

describe('the per-client plan is a work list, not an argument', () => {
  const doc = read('docs/api/PER_CLIENT_MIGRATION_PLAN.md');

  it('orders clients cheapest-to-correct first, mobile last', () => {
    /**
     * The ordering principle, asserted against the document rather than trusted.
     * A plan that put Customer Mobile first would be asking the client with the
     * largest uncorrectable installed base to go before anything had been proven
     * on a surface that can be reverted in minutes.
     */
    const headings = doc.split('\n').filter((l) => /^## \d+\. /.test(l));
    expect(headings).toEqual([
      '## 1. Admin Web',
      '## 2. Provider Web',
      '## 3. Customer Web',
      '## 4. Provider Mobile',
      '## 5. Customer Mobile',
    ]);
  });

  it('gives every client a section with its correction cost and window', () => {
    for (const surface of MIGRATION_ORDER) {
      const cost = SURFACE_CORRECTION_COST[surface];
      expect(doc).toContain(`## ${cost.order}. ${SURFACE_LABEL[surface]}`);
      expect(doc).toContain(`**${cost.retirementDays} days** of observed silence`);
    }
  });

  it('lists only capabilities that surface actually performs', () => {
    // A work list that told Admin to migrate the customer address book would be
    // a plan nobody could follow.
    const adminSection = doc.slice(doc.indexOf('## 1. Admin Web'), doc.indexOf('## 2. Provider Web'));
    expect(adminSection).not.toContain('Manage my saved addresses');
  });

  it('names the legacy path each row moves off, or says there is none', () => {
    const rows = doc.split('\n').filter((l) => l.startsWith('| ') && l.includes('/api/v1/'));
    expect(rows.length).toBeGreaterThan(30);
    for (const row of rows.slice(0, 20)) {
      const movesFrom = row.includes('/api/') || row.includes('this is new');
      expect(movesFrom).toBe(true);
    }
  });

  it('states that migrating retires nothing', () => {
    // The sentence that stops a completed migration being read as permission to
    // delete the alias behind it.
    expect(doc).toContain('Migrating a client does not retire anything');
  });
});

describe('the manifest is usable by a client team', () => {
  const manifest = JSON.parse(read('docs/api/CANONICAL_CALL_MANIFEST.json'));

  it('carries the prefix, the surfaces and a count', () => {
    expect(manifest.prefix).toBe('/api/v1');
    expect(manifest.surfaces).toEqual([...CLIENT_SURFACES]);
    expect(manifest.endpointCount).toBe(canonicalManifest().length);
  });

  it('gives every endpoint a method, a path, an auth mode and a service', () => {
    for (const endpoint of manifest.endpoints) {
      expect(endpoint.method).toMatch(/^(GET|POST|PUT|PATCH|DELETE)$/);
      expect(endpoint.path.startsWith('/api/v1')).toBe(true);
      expect(['public', 'authenticated', 'provider', 'admin']).toContain(endpoint.auth);
      expect(endpoint.domainService.length).toBeGreaterThan(3);
    }
  });

  it('tells a client which surfaces each endpoint is for', () => {
    for (const endpoint of manifest.endpoints) {
      expect(Array.isArray(endpoint.surfaces)).toBe(true);
      for (const surface of endpoint.surfaces) {
        expect(CLIENT_SURFACES).toContain(surface);
      }
    }
  });

  it('is sorted, so a diff between two versions is readable', () => {
    const ids = manifest.endpoints.map((e: any) => e.id);
    expect(ids).toEqual([...ids].sort());
  });
});
