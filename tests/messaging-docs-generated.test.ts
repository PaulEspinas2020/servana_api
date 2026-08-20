/**
 * The messaging contract document is DERIVED, and this is what keeps it that way.
 *
 * `docs/messaging/MESSAGING_V1_CONTRACT.md` is produced by EXECUTING
 * `messagingPolicy` rather than by describing it. That is only worth anything if
 * a policy edit which is not followed by a regenerate FAILS — otherwise it is a
 * hand-written document with a machine-generated header, which is worse than an
 * honestly hand-written one because it reads as authoritative.
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
import { staleFiles, generateAll } from '../scripts/generate-messaging-docs';
import {
  ATTACHMENT_POLICY,
  CONVERSATION_STATUS_NAMES,
  MESSAGE_BODY_MAX,
  MESSAGE_PAGE,
  MESSAGING_SIGNALS,
  REALTIME_EVENT_NAMES,
  REALTIME_SCHEMA_VERSION,
  UNREAD_DEFINITION,
} from '../src/services/messaging/messagingPolicy';
import { V1_CONTRACT, V1_PREFIX } from '../src/api/v1/contract';
import { expectMigrationsAreBackedByAManifest } from './support/callerMatrix';

const REPO_ROOT = path.resolve(__dirname, '..');
const read = (relPath: string): string =>
  fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8').replace(/\r\n/g, '\n');

describe('the committed messaging document is the generated one', () => {
  it('is not stale — run "npm run messaging:docs" if this fails', () => {
    expect(staleFiles()).toEqual([]);
  });

  it('generates exactly the files it claims to', () => {
    expect(generateAll().map((f) => f.relPath)).toEqual([
      'docs/messaging/MESSAGING_V1_CONTRACT.md',
    ]);
  });

  it('carries the do-not-edit header, so a hand edit is at least visible', () => {
    expect(read('docs/messaging/MESSAGING_V1_CONTRACT.md')).toContain('GENERATED FILE');
  });
});

describe('the document states what the code states', () => {
  const doc = read('docs/messaging/MESSAGING_V1_CONTRACT.md');

  it('lists every conversation state with who may post in it', () => {
    for (const state of CONVERSATION_STATUS_NAMES) expect(doc).toContain(`\`${state}\``);
    // The matrix is built by RUNNING mayWrite, so these two rows are evidence.
    expect(doc).toMatch(/\| `READ_ONLY` \| read only \| read only \| may post \|/);
    expect(doc).toMatch(/\| `ACTIVE` \| may post \| may post \| may post \|/);
  });

  it('states the provider read floor and that it fails closed', () => {
    expect(doc).toMatch(/\*\*denied\*\* — Message history is not available for this assignment/);
    expect(doc).toContain('never inherits the previous');
  });

  it('states that refusals do not confirm which conversations exist', () => {
    expect(doc).toContain('Refusals do not confirm what exists');
  });

  it('lists every realtime event', () => {
    for (const name of REALTIME_EVENT_NAMES) expect(doc).toContain(`\`${name}\``);
    expect(doc).toContain(`**${REALTIME_SCHEMA_VERSION}**`);
  });

  it('states the five unread clauses', () => {
    for (const clause of UNREAD_DEFINITION) expect(doc).toContain(clause);
  });

  it('states the attachment limits, and states them as numbers', () => {
    expect(doc).toContain(`| Maximum per message | ${ATTACHMENT_POLICY.maxPerMessage} |`);
    expect(doc).toContain(`| Maximum size | ${ATTACHMENT_POLICY.maxBytes / (1024 * 1024)} MiB |`);
    for (const mime of ATTACHMENT_POLICY.allowedMimeTypes) expect(doc).toContain(`\`${mime}\``);
  });

  it('states the message limits and the pagination convention', () => {
    expect(doc).toContain(`**${MESSAGE_BODY_MAX}** characters`);
    expect(doc).toContain(`**${MESSAGE_PAGE.defaultLimit}**`);
    expect(doc).toContain(`**${MESSAGE_PAGE.maxLimit}**`);
  });

  it('is explicit that no delivery receipt is published', () => {
    expect(doc).toContain('**Delivered — not tracked.**');
    expect(doc).not.toMatch(/`deliveredAt`/);
  });

  it('lists every telemetry signal with why it is counted', () => {
    for (const signal of MESSAGING_SIGNALS) {
      expect(doc).toContain(`\`${signal.code}\``);
      expect(doc).toContain(signal.detects);
    }
  });

  it('lists every canonical messaging endpoint at its real path', () => {
    for (const entry of V1_CONTRACT.filter((e) => e.domain === 'conversations')) {
      expect(doc).toContain(`${entry.method.toUpperCase()} ${V1_PREFIX}${entry.path}`);
    }
  });

  it('lists every legacy route the contract names for this domain', () => {
    for (const entry of V1_CONTRACT.filter((e) => e.domain === 'conversations')) {
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
    expectMigrationsAreBackedByAManifest(doc, '## 10. Cross-platform caller matrix');
  });

  it('names all five client surfaces in the caller matrix', () => {
    for (const surface of [
      'Customer Mobile', 'Customer Web', 'Provider Mobile', 'Provider Web', 'Admin Web',
    ]) {
      expect(doc).toContain(surface);
    }
  });

  it('explains the role split for every capability rather than asserting one exists', () => {
    expect(doc).toContain('### Why each capability is or is not role-split');
  });

  it('states the session-hygiene contract both sides have to honour', () => {
    expect(doc).toContain('## 6. Session hygiene');
    expect(doc).toContain('clear the account-scoped conversation');
  });
});
