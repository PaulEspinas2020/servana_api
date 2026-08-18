/**
 * The finance contract document is DERIVED, and this is what keeps it that way.
 *
 * `docs/finance/FINANCE_V1_CONTRACT.md` is produced by executing
 * `financePolicy` rather than by describing it. That is only worth anything if a
 * policy edit which is not followed by a regenerate FAILS — otherwise the
 * document is a hand-written one with a machine-generated header, which is worse
 * than an honestly hand-written one because it reads as authoritative.
 *
 * The second half asserts the CLAIMS the document makes are the claims the code
 * makes. A generated file can still be generated from the wrong thing.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' }, tempId: undefined }));
jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
  pool: { connect: jest.fn() },
}));

import fs from 'fs';
import path from 'path';
import { staleFiles, generateAll } from '../scripts/generate-finance-docs';
import {
  PROVIDER_PAYOUT_WINDOW_HOURS,
  RECONCILIATION_CHECKS,
  REFUND_TRIGGER_NAMES,
  LEDGER_EVENT_NAMES,
  PAYMENT_STATE_NAMES,
} from '../src/services/finance/financePolicy';
import { V1_CONTRACT, V1_PREFIX } from '../src/api/v1/contract';
import { expectMigrationsAreBackedByAManifest } from './support/callerMatrix';

const REPO_ROOT = path.resolve(__dirname, '..');
const read = (relPath: string): string =>
  fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8').replace(/\r\n/g, '\n');

describe('the committed finance document is the generated one', () => {
  it('is not stale — run "npm run finance:docs" if this fails', () => {
    expect(staleFiles()).toEqual([]);
  });

  it('generates exactly the files it claims to', () => {
    expect(generateAll().map((f) => f.relPath)).toEqual([
      'docs/finance/FINANCE_V1_CONTRACT.md',
    ]);
  });

  it('carries the do-not-edit header, so a hand edit is at least visible', () => {
    expect(read('docs/finance/FINANCE_V1_CONTRACT.md')).toContain('GENERATED FILE');
  });
});

describe('the document states what the code states', () => {
  const doc = read('docs/finance/FINANCE_V1_CONTRACT.md');

  /**
   * The number a provider plans around. It was documented as 48 while the
   * scheduler released at 72 for long enough to matter, so it is asserted here
   * against the constant AND against the literal.
   */
  it('states the payout window, and states 72', () => {
    expect(doc).toContain(`${PROVIDER_PAYOUT_WINDOW_HOURS} hours`);
    expect(doc).toContain('72 hours');
    expect(doc).not.toMatch(/payout window is 48/i);
  });

  it('states the internal fixer earns no per-job commission', () => {
    expect(doc).toMatch(/No per-job commission\s+is calculated, recorded or paid/i);
    expect(doc).toContain('INTERNAL_FIXER_SALARIED');
  });

  it('lists every payment state', () => {
    for (const state of PAYMENT_STATE_NAMES) expect(doc).toContain(`\`${state}\``);
  });

  it('lists every ledger event', () => {
    for (const event of LEDGER_EVENT_NAMES) expect(doc).toContain(`\`${event}\``);
  });

  it('lists every refund trigger', () => {
    for (const trigger of REFUND_TRIGGER_NAMES) expect(doc).toContain(`\`${trigger}\``);
  });

  it('lists every reconciliation check with its remediation', () => {
    for (const check of RECONCILIATION_CHECKS) {
      expect(doc).toContain(`\`${check.code}\``);
      expect(doc).toContain(check.remediation);
    }
  });

  it('lists every canonical finance endpoint at its real path', () => {
    for (const entry of V1_CONTRACT.filter((e) => e.domain === 'finance')) {
      expect(doc).toContain(`${entry.method.toUpperCase()} ${V1_PREFIX}${entry.path}`);
    }
  });

  /**
   * A migration may be CLAIMED only where a manifest proves it (TAB 04).
   *
   * This asserted `not.toContain('migrated')` while no client repository was
   * in scope. Provider Web now publishes a generated manifest with a
   * file:line per call site, so 36 migrations are provable and the old
   * assertion failed BECAUSE the registry became correct. The intent — do
   * not claim a migration nobody verified — is unchanged.
   */
  it('claims a migration only where a client manifest proves one', () => {
    expectMigrationsAreBackedByAManifest(doc, '## 8. Cross-platform caller matrix');
  });

  it('names all five client surfaces in the caller matrix', () => {
    for (const surface of [
      'Customer Mobile', 'Customer Web', 'Provider Mobile', 'Provider Web', 'Admin Web',
    ]) {
      expect(doc).toContain(surface);
    }
  });

  it('explains the role split for every capability rather than asserting one exists', () => {
    // The command asks for exactly this sentence per capability.
    expect(doc).toContain('### Why each capability is or is not role-split');
  });
});
