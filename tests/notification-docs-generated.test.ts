/**
 * The event registry and the notification contract are DERIVED, and this is
 * what keeps them that way.
 *
 * Both documents are produced by EXECUTING `domainEvents` rather than by
 * describing it. That is only worth anything if a declaration edit which is not
 * followed by a regenerate FAILS — otherwise they are hand-written documents
 * with machine-generated headers, which is worse than honestly hand-written ones
 * because they read as authoritative.
 *
 * An event registry is the document most likely to rot, because it describes
 * something invisible: nobody notices that the registry claims an event the
 * backend never publishes until a client team builds a screen around it.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' }, tempId: undefined }));
jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
  pool: { connect: jest.fn() },
}));

import fs from 'fs';
import path from 'path';
import { staleFiles, generateAll } from '../scripts/generate-notification-docs';
import {
  DEEP_LINK_TARGET_NAMES,
  DOMAIN_EVENTS,
  DOMAIN_EVENT_NAMES,
  ENTITY_REF_NAMES,
  EVENT_SIGNALS,
  FORBIDDEN_REFS,
  NOTIFICATION_CATEGORY_NAMES,
  type DomainEventSpec,
} from '../src/services/events/domainEvents';
import { V1_CONTRACT, V1_PREFIX } from '../src/api/v1/contract';
import { expectMigrationsAreBackedByAManifest } from './support/callerMatrix';

const REPO_ROOT = path.resolve(__dirname, '..');
const read = (relPath: string): string =>
  fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8').replace(/\r\n/g, '\n');

describe('the committed documents are the generated ones', () => {
  it('are not stale — run "npm run notification:docs" if this fails', () => {
    expect(staleFiles()).toEqual([]);
  });

  it('generates exactly the files it claims to', () => {
    expect(generateAll().map((f) => f.relPath)).toEqual([
      'docs/notifications/DOMAIN_EVENT_REGISTRY.md',
      'docs/notifications/NOTIFICATIONS_V1_CONTRACT.md',
    ]);
  });

  it('both carry the do-not-edit header, so a hand edit is at least visible', () => {
    for (const file of generateAll()) expect(read(file.relPath)).toContain('GENERATED FILE');
  });
});

describe('the registry states what the code states', () => {
  const doc = read('docs/notifications/DOMAIN_EVENT_REGISTRY.md');

  it('lists every declared event with its required canonical ids', () => {
    for (const name of DOMAIN_EVENT_NAMES) {
      expect(doc).toContain(`\`${name}\``);
      const spec = DOMAIN_EVENTS[name] as DomainEventSpec;
      for (const ref of spec.requiredRefs) expect(doc).toContain(`\`${ref}\``);
    }
  });

  it('states how many events there are, from the declaration', () => {
    expect(doc).toContain(`${DOMAIN_EVENT_NAMES.length} canonical events`);
  });

  it('distinguishes the transactional publishers from the rest', () => {
    // The registry must not overstate the guarantee: only the booking state
    // machine writes its event inside the producing transaction.
    expect(doc).toContain('| `BookingAssigned` | v1 | `bookingId`, `providerUid` | yes |');
    expect(doc).toContain('| `MessageReceived` |');
    expect(doc).toMatch(/\| `MessageReceived` \|[^|]*\|[^|]*\| — \|/);
  });

  it('publishes the deduplication keys, which are the migration contract', () => {
    // The keys are how the legacy producers and the projector collapse onto one
    // row. A registry that omitted them would document the design and hide the
    // one detail somebody has to check before deleting a legacy call.
    expect(doc).toContain('`assigned_job_{bookingId}_{providerUid}`'.replace(/\{bookingId\}/, '75').replace(/\{providerUid\}/, 'provider-uid'));
    expect(doc).toContain('`chat_msg:4021`');
  });

  it('names which legacy producer each projection supersedes', () => {
    expect(doc).toContain('### Which legacy producer each projection supersedes');
    expect(doc).toContain('**new** — nothing notified this before');
  });

  it('lists every canonical identifier and every forbidden one', () => {
    for (const ref of ENTITY_REF_NAMES) expect(doc).toContain(`\`${ref}\``);
    for (const ref of FORBIDDEN_REFS) expect(doc).toContain(`\`${ref}\``);
  });

  it('states that the legacy service family is refused, and why', () => {
    expect(doc).toContain('Catalog V2 is production-certified');
    expect(doc).toContain('`services.id`');
  });

  it('lists every preference category with its default', () => {
    for (const category of NOTIFICATION_CATEGORY_NAMES) expect(doc).toContain(`\`${category}\``);
  });

  it('shows the override matrix as EVIDENCE, produced by running the decider', () => {
    // accountSecurity is transactional; promotions never is.
    expect(doc).toMatch(/\| `accountSecurity` \| deliver \| \*\*override\*\* \|/);
    expect(doc).toMatch(/\| `promotions` \| deliver \| withheld \|/);
  });

  it('lists every deep-link target with both client projections', () => {
    for (const target of DEEP_LINK_TARGET_NAMES) expect(doc).toContain(`\`${target}\``);
    expect(doc).toContain('Authorization happens AFTER navigation');
  });

  it('lists every telemetry signal with why it is counted', () => {
    for (const signal of EVENT_SIGNALS) {
      expect(doc).toContain(`\`${signal.code}\``);
      expect(doc).toContain(signal.detects);
    }
  });
});

describe('the contract states what the contract states', () => {
  const doc = read('docs/notifications/NOTIFICATIONS_V1_CONTRACT.md');

  it('lists every canonical notification endpoint at its real path', () => {
    for (const entry of V1_CONTRACT.filter((e) => e.domain === 'notifications')) {
      expect(doc).toContain(`${entry.method.toUpperCase()} ${V1_PREFIX}${entry.path}`);
    }
  });

  it('lists every legacy route the contract names for this domain', () => {
    for (const entry of V1_CONTRACT.filter((e) => e.domain === 'notifications')) {
      for (const legacy of entry.legacy) {
        expect(doc).toContain(`${legacy.method.toUpperCase()} ${legacy.path}`);
      }
    }
  });

  it('explains the PATCH-vs-POST divergence from the command rather than hiding it', () => {
    expect(doc).toContain('The command names `POST /api/v1/notifications/:notificationId/read`');
  });

  it('records the empty-provider-inbox defect it closed', () => {
    expect(doc).toContain('### The defect this closed');
    expect(doc).toContain('EMPTY ARRAY');
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
    expectMigrationsAreBackedByAManifest(doc, '## 3. Cross-platform caller matrix');
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
});
