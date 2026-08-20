/**
 * The home contract is DERIVED, and this is what keeps it that way.
 *
 * `docs/home/HOME_V1_CONTRACT.md` is produced by EXECUTING `homePolicy`. That is
 * only worth anything if a declaration edit which is not followed by a
 * regenerate FAILS — otherwise it is a hand-written document with a
 * machine-generated header, which is worse than an honestly hand-written one
 * because it reads as authoritative.
 *
 * The dangerous column is OWNERSHIP. A document claiming the catalog owns
 * `featuredServices` while the homepage quietly started deciding it is exactly
 * the drift this tab exists to prevent, and nobody would notice from reading
 * either side.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' }, tempId: undefined }));
jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
  pool: { connect: jest.fn() },
}));

import fs from 'fs';
import path from 'path';
import { staleFiles, generateAll } from '../scripts/generate-home-docs';
import {
  PAYLOAD_BUDGET,
  PERSONAL_SECTIONS,
  PUBLIC_SECTIONS,
  SECTION_REASONS,
  SECTION_TYPES,
  SECTION_TYPE_NAMES,
  SERVICE_CARD_REFERENCE,
  cacheControlFor,
} from '../src/services/home/homePolicy';
import { V1_CONTRACT, V1_PREFIX } from '../src/api/v1/contract';
import { expectMigrationsAreBackedByAManifest } from './support/callerMatrix';

const REPO_ROOT = path.resolve(__dirname, '..');
const read = (relPath: string): string =>
  fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8').replace(/\r\n/g, '\n');

describe('the committed document is the generated one', () => {
  it('is not stale — run "npm run home:docs" if this fails', () => {
    expect(staleFiles()).toEqual([]);
  });

  it('generates exactly the file it claims to', () => {
    expect(generateAll().map((f) => f.relPath)).toEqual(['docs/home/HOME_V1_CONTRACT.md']);
  });

  it('carries the do-not-edit header, so a hand edit is at least visible', () => {
    expect(read('docs/home/HOME_V1_CONTRACT.md')).toContain('GENERATED FILE');
  });
});

describe('the contract states what the code states', () => {
  const doc = read('docs/home/HOME_V1_CONTRACT.md');

  it('lists every section with its owner, TTL and ceiling', () => {
    for (const name of SECTION_TYPE_NAMES) {
      const spec = SECTION_TYPES[name];
      const row = doc.split('\n').find((line) => line.startsWith(`| \`${name}\` | ${spec.audience} |`));
      expect(row).toBeDefined();
      // The ownership column is the load-bearing one.
      expect(row).toContain(spec.ownedBy);
      expect(row).toContain(`${spec.ttlSeconds}s`);
    }
  });

  it('states the section count from the declaration', () => {
    expect(doc).toContain(`${SECTION_TYPE_NAMES.length} declared sections`);
  });

  it('renders the caching table from the REAL decision function', () => {
    // Each row is run output. A section changing audience rewrites this table.
    expect(doc).toContain(`| every public section | \`${cacheControlFor([...PUBLIC_SECTIONS])}\` |`);
    expect(doc).toContain(`| every personal section | \`${cacheControlFor([...PERSONAL_SECTIONS])}\` |`);
    expect(doc).toContain(
      `| \`categories\` + \`activeBooking\` | \`${cacheControlFor(['categories', 'activeBooking'])}\` |`,
    );
  });

  it('states that any personal section makes the whole response no-store', () => {
    expect(doc).toContain('private, no-store');
    expect(doc).toContain('Vary: Authorization');
  });

  it('names the forbidden identifiers explicitly', () => {
    for (const forbidden of SERVICE_CARD_REFERENCE.forbidden) {
      expect(doc).toContain(`\`${forbidden}\``);
    }
    expect(doc).toContain(SERVICE_CARD_REFERENCE.idSource);
  });

  it('states that the homepage declares no status vocabulary of its own', () => {
    expect(doc).toContain('declares no status vocabulary of its own');
  });

  it('lists every partial-failure reason with its meaning', () => {
    for (const [code, meaning] of Object.entries(SECTION_REASONS)) {
      expect(doc).toContain(`\`${code}\``);
      expect(doc).toContain(meaning);
    }
    expect(doc).toContain('EMPTY');
    expect(doc).toContain('UNAVAILABLE');
  });

  it('publishes the payload budget as numbers', () => {
    expect(doc).toContain(`| Total items across every section | ${PAYLOAD_BUDGET.maxTotalItems} |`);
    expect(doc).toContain(`| Serialized bytes | ${PAYLOAD_BUDGET.maxBytes / 1024} KiB |`);
    expect(doc).toContain(`| Queries per request | ${PAYLOAD_BUDGET.maxQueriesPerRequest} |`);
  });

  it('explains why banners are empty rather than inventing a source', () => {
    expect(doc).toContain('no promotions table');
    expect(doc).toContain('NOT_CONFIGURED');
  });

  it('records that /home/refresh was deliberately NOT built', () => {
    // The command named it optional. An endpoint whose only behaviour is to
    // return what the previous one returned is a route called by mistake.
    expect(doc).toContain('/home/refresh');
    expect(doc).toContain('NOT built');
  });

  it('lists every canonical home endpoint at its real path', () => {
    for (const entry of V1_CONTRACT.filter((e) => e.domain === 'home')) {
      expect(doc).toContain(`${entry.method.toUpperCase()} ${V1_PREFIX}${entry.path}`);
    }
  });

  /**
   * A migration may be CLAIMED only where a manifest proves it (TAB 04).
   *
   * This asserted `not.toContain('migrated')` while no client repository was in
   * scope. Provider Web now publishes a generated manifest with a file:line per
   * call site, so 36 migrations are provable and the old assertion failed
   * BECAUSE the registry became correct. The intent — do not claim a migration
   * nobody verified — is unchanged.
   */
  it('claims a migration only where a client manifest proves one', () => {
    expectMigrationsAreBackedByAManifest(doc, '## 7. Cross-platform caller matrix');
  });

  it('names all five client surfaces and explains every role split', () => {
    for (const surface of [
      'Customer Mobile', 'Customer Web', 'Provider Mobile', 'Provider Web', 'Admin Web',
    ]) {
      expect(doc).toContain(surface);
    }
    expect(doc).toContain('### Why each capability is or is not role-split');
  });
});
