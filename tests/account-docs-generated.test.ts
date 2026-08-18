/**
 * The profile and settings contracts are DERIVED, and this is what keeps them
 * that way.
 *
 * Both documents are produced by EXECUTING `accountPolicy` rather than by
 * describing it. That is only worth anything if a declaration edit which is not
 * followed by a regenerate FAILS — otherwise they are hand-written documents
 * with machine-generated headers, which is worse than honestly hand-written ones
 * because they read as authoritative.
 *
 * A sensitive-field policy is the document most dangerous to let rot: one that
 * says a field is private while the projection publishes it is worse than no
 * document at all, because a client team reads it and stops checking.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' }, tempId: undefined }));
jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
  pool: { connect: jest.fn() },
}));

import fs from 'fs';
import path from 'path';
import { staleFiles, generateAll } from '../scripts/generate-account-docs';
import {
  ACCOUNT_SEATS,
  ADDRESS_LIMITS,
  COMPLETION_REQUIREMENTS,
  ME_EXCLUSIONS,
  ME_FIELDS,
  NEVER_PROJECTED,
  PROVIDER_PROFILE_FIELDS,
  SETTINGS_CATALOG,
  providerFieldsVisibleTo,
} from '../src/services/account/accountPolicy';
import { V1_CONTRACT, V1_PREFIX } from '../src/api/v1/contract';
import { expectMigrationsAreBackedByAManifest } from './support/callerMatrix';

const REPO_ROOT = path.resolve(__dirname, '..');
const read = (relPath: string): string =>
  fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8').replace(/\r\n/g, '\n');

describe('the committed documents are the generated ones', () => {
  it('are not stale — run "npm run account:docs" if this fails', () => {
    expect(staleFiles()).toEqual([]);
  });

  it('generates exactly the files it claims to', () => {
    expect(generateAll().map((f) => f.relPath)).toEqual([
      'docs/account/PROFILE_V1_CONTRACT.md',
      'docs/account/SETTINGS_V1_CONTRACT.md',
    ]);
  });

  it('both carry the do-not-edit header, so a hand edit is at least visible', () => {
    for (const file of generateAll()) expect(read(file.relPath)).toContain('GENERATED FILE');
  });
});

describe('the profile contract states what the code states', () => {
  const doc = read('docs/account/PROFILE_V1_CONTRACT.md');

  it('lists every /me field with its class and writability', () => {
    for (const field of ME_FIELDS) expect(doc).toContain(`\`${field.id}\``);
  });

  it('names what /me excludes and who owns each', () => {
    for (const [excluded, owner] of Object.entries(ME_EXCLUSIONS)) {
      expect(doc).toContain(`\`${excluded}\``);
      expect(doc).toContain(owner);
    }
  });

  /**
   * The disclosure matrix is EVIDENCE — produced by running
   * `providerFieldsVisibleTo` for each seat. These assertions compare the
   * document against the function's real output, so a classification change
   * that is not regenerated fails here.
   */
  it('renders the disclosure matrix from the real function', () => {
    /**
     * Scoped to the matrix SECTION.
     *
     * `/me` and the provider registry share field ids — `email` appears in
     * both tables with different columns — so a document-wide row lookup finds
     * the wrong one and compares a label against a seat.
     */
    const start = doc.indexOf('### Provider field disclosure, by seat');
    const section = doc.slice(start, doc.indexOf('A field reaches a customer', start));
    expect(start).toBeGreaterThan(0);

    for (const seat of ACCOUNT_SEATS) {
      const visible = new Set(providerFieldsVisibleTo(seat));
      for (const field of PROVIDER_PROFILE_FIELDS) {
        const row = section.split('\n').find((line) => line.startsWith(`| \`${field.id}\` |`));
        expect(row).toBeDefined();
        const cells = row!.split('|').map((c) => c.trim());
        // 0 empty, 1 field, 2 class, then one cell per seat in declared order.
        const cell = cells[3 + ACCOUNT_SEATS.indexOf(seat)];
        expect(cell).toBe(visible.has(field.id) ? 'visible' : '—');
      }
    }
  });

  it('states that a customer needs BOTH signals to agree', () => {
    expect(doc).toContain('two independent signals agree');
    expect(doc).toContain('Either can veto');
  });

  it('lists every never-projected credential', () => {
    for (const entry of NEVER_PROJECTED) expect(doc).toContain(`\`${entry}\``);
  });

  it('states the address ceiling and the default-address rule', () => {
    expect(doc).toContain(`**${ADDRESS_LIMITS.maxPerAccount}** addresses per account`);
    expect(doc).toContain('Exactly one address per account carries is_primary.');
    expect(doc).toContain('two primaries');
  });

  it('records that ownership moved into SQL', () => {
    expect(doc).toContain('Ownership is in SQL, not in a controller');
  });

  it('lists every completion requirement with whether it blocks', () => {
    for (const requirement of COMPLETION_REQUIREMENTS) {
      expect(doc).toContain(`\`${requirement.id}\``);
    }
    expect(doc).toContain('`percent` and `canProceed` answer different questions');
  });

  it('shows the completion cases as run output, not as prose', () => {
    // The second case is the one the gate exists for: looks nearly done, cannot
    // take work.
    expect(doc).toMatch(/photo but no accepted documents.*canProceed: false/);
    expect(doc).toMatch(/everything but a photo.*canProceed: true/);
  });

  it('states the account-switch contract for both halves', () => {
    expect(doc).toContain('## 6. Account-switch invalidation');
    expect(doc).toContain('Client obligation');
  });

  it('lists every canonical account endpoint at its real path', () => {
    for (const entry of V1_CONTRACT.filter((e) => e.domain === 'account')) {
      expect(doc).toContain(`${entry.method.toUpperCase()} ${V1_PREFIX}${entry.path}`);
    }
  });

  it('lists every legacy path the contract names for this domain', () => {
    for (const entry of V1_CONTRACT.filter((e) => e.domain === 'account')) {
      for (const legacy of entry.legacy) {
        expect(doc).toContain(`${legacy.method.toUpperCase()} ${legacy.path}`);
      }
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
    expectMigrationsAreBackedByAManifest(doc, '## Cross-platform caller matrix');
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

describe('the settings contract states what the code states', () => {
  const doc = read('docs/account/SETTINGS_V1_CONTRACT.md');

  it('lists every setting with its group and default', () => {
    for (const spec of SETTINGS_CATALOG) {
      expect(doc).toContain(`\`${spec.id}\``);
      expect(doc).toContain(`\`${spec.group}\``);
    }
  });

  it('states that notification preferences are a POINTER, not a copy', () => {
    expect(doc).toContain('## 2. Notification preferences are a POINTER');
    expect(doc).toContain('services/events/domainEvents');
  });

  it('states that security is read-only and says why', () => {
    expect(doc).toContain('It is READ-ONLY, deliberately');
    expect(doc).toContain('turn two-factor **off**');
  });

  it('names where every security action lives', () => {
    expect(doc).toContain('changePassword');
    expect(doc).toContain('revokeSessions');
  });
});
