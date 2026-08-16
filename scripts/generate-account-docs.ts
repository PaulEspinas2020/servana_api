/**
 * Writes every generated TAB 10 document.
 *
 *   docs/account/PROFILE_V1_CONTRACT.md
 *   docs/account/SETTINGS_V1_CONTRACT.md
 *
 * Run: npm run account:docs        (rewrite)
 *      npm run account:docs:check  (fail if the committed file is stale)
 *
 * ## Why this is GENERATED
 *
 * A sensitive-field policy written in prose is correct on the day it is written
 * and quietly wrong afterwards, and here "quietly wrong" means a document that
 * tells a client team a field is private while the projection publishes it.
 *
 * So the disclosure matrix is produced by RUNNING `providerFieldsVisibleTo` for
 * every seat, and the completion tables by running `computeCompletion` over real
 * inputs. If a classification changes, the table changes with it — which makes
 * these tables evidence rather than description.
 */

import fs from 'fs';
import path from 'path';

import {
  ACCOUNT_CAPABILITIES,
  ACCOUNT_SEATS,
  ACCOUNT_SWITCH_INVALIDATION,
  ADDRESS_FIELDS,
  ADDRESS_IDENTITY,
  ADDRESS_LIMITS,
  CLIENT_SURFACES,
  COMPLETION_REQUIREMENTS,
  CUSTOMER_PROFILE_FIELDS,
  DEFAULT_ADDRESS_RULE,
  ME_EXCLUSIONS,
  ME_FIELDS,
  ME_WRITABLE_FIELDS,
  NEVER_PROJECTED,
  PROVIDER_PROFILE_FIELDS,
  PROVIDER_SELF_EDITABLE_FIELDS,
  READABLE_BY,
  SECURITY_ACTIONS,
  SECURITY_READ_FIELDS,
  SENSITIVITY_CLASSES,
  SETTINGS_CATALOG,
  SETTINGS_WRITABLE,
  computeCompletion,
  providerFieldsVisibleTo,
  validateAddress,
  type AccountSeat,
  type ClientSurface,
} from '../src/services/account/accountPolicy';
import { V1_CONTRACT, V1_PREFIX, type ContractEntry } from '../src/api/v1/contract';

const OUT_DIR = path.resolve(__dirname, '..', 'docs', 'account');

const header = (title: string, sources: string) => `<!--
  GENERATED FILE - do not edit by hand.
  Source: scripts/generate-account-docs.ts, derived from
${sources}
  Regenerate: npm run account:docs
-->

# ${title}
`;

const SURFACE_LABEL: Record<ClientSurface, string> = {
  customerMobile: 'Customer Mobile',
  customerWeb: 'Customer Web',
  providerMobile: 'Provider Mobile',
  providerWeb: 'Provider Web',
  admin: 'Admin Web',
};

const yesNo = (b: boolean) => (b ? 'yes' : '—');

// ─── PROFILE_V1_CONTRACT.md ───────────────────────────────────────────────────

function meSection(): string {
  const rows = ME_FIELDS.map(
    (f) => `| \`${f.id}\` | ${f.label} | \`${f.classification}\` | ${yesNo(f.writableBySelf)} | ${f.writeNote ?? ''} |`,
  ).join('\n');

  const exclusions = Object.entries(ME_EXCLUSIONS)
    .map(([what, where]) => `| \`${what}\` | \`${where}\` |`)
    .join('\n');

  return `## 1. \`/me\` — the common account record

Identity, contact and a verification SUMMARY. Nothing else.

The temptation is real: every client needs the account and one round trip is
cheaper than two. But a \`/me\` that carried the provider's compliance state and the
customer's address book would be fetched by every screen, used by almost none, and it
is the payload most likely to be cached, logged and shipped to an analytics tool.

So role data lives behind its own endpoints and \`/me\` carries a \`profiles\` POINTER —
which extensions exist for this account — rather than their contents.

| Field | Label | Class | Writable by self | Why not |
| --- | --- | --- | --- | --- |
${rows}

Writable at \`PATCH ${V1_PREFIX}/me\`: ${ME_WRITABLE_FIELDS.map((f) => `\`${f}\``).join(', ')}.

An unwritable field is **refused by name**, not dropped. Silently ignoring \`email\`
leaves the caller believing they changed a verified identifier.

### What \`/me\` deliberately does NOT carry

| Excluded | Owned by |
| --- | --- |
${exclusions}
`;
}

function sensitivitySection(): string {
  const rows = SENSITIVITY_CLASSES.map(
    (c) => `| \`${c}\` | ${READABLE_BY[c].map((seat) => `\`${seat}\``).join(', ')} |`,
  ).join('\n');

  const seats: AccountSeat[] = [...ACCOUNT_SEATS];
  const header = `| Provider field | Class | ${seats.join(' | ')} |`;
  const divider = `| --- | --- | ${seats.map(() => '---').join(' | ')} |`;
  const visible = new Map(seats.map((seat) => [seat, new Set(providerFieldsVisibleTo(seat))]));
  const fieldRows = PROVIDER_PROFILE_FIELDS.map((field) => {
    const cells = seats.map((seat) => (visible.get(seat)!.has(field.id) ? 'visible' : '—'));
    return `| \`${field.id}\` | \`${field.classification}\` | ${cells.join(' | ')} |`;
  }).join('\n');

  return `## 2. Sensitive-field policy (§107)

Four classes, and one table saying which seat may read each.

| Class | Readable by |
| --- | --- |
${rows}

A \`seat\` is a RELATIONSHIP, not a role claim from a token: \`self\` is the account
reading its own row, \`otherCustomer\` is a customer looking at a provider, \`admin\` is
staff. It is resolved server-side on every request.

### Provider field disclosure, by seat

Produced by RUNNING \`providerFieldsVisibleTo\` for each seat. If a classification
changes, this table changes with it.

${header}
${divider}
${fieldRows}

A field reaches a customer only when **two independent signals agree**: its
classification must be readable by \`otherCustomer\` AND the field registry's own
\`customerVisible\` flag must be set. Either can veto — which is what makes "sensitive
documents do not leak" a property of the declaration rather than of every query
author remembering to omit a column.

The provider field registry is NOT restated here. It is
\`providerProfileComplianceService.PROFILE_FIELD_REGISTRY\`, which already carried a
classification, a customer-visible flag and a masked flag, and which
\`/api/provider/profile-fields\` already serves to Provider Web. Declaring a second
provider taxonomy beside it is exactly the mistake this policy exists to prevent.

### Never projected, at any seat

${NEVER_PROJECTED.map((f) => `\`${f}\``).join(', ')}

Not a sensitivity class — a refusal. These are credentials and verification
artefacts. An admin who needs a document uses the document endpoint, which authorizes
per document and records the access; a profile read is not that.

Projections are built ADDITIVELY: every DTO names its fields. Nothing is built by
copying a row and deleting what should not travel, because a subtractive projection
discloses every column somebody later adds.
`;
}

function customerSection(): string {
  const rows = CUSTOMER_PROFILE_FIELDS.map(
    (f) => `| \`${f.id}\` | \`${f.classification}\` | ${yesNo(f.writableBySelf)} | ${f.writeNote ?? ''} |`,
  ).join('\n');

  const addressRows = ADDRESS_FIELDS.map(
    (f) => `| \`${f.id}\` | ${yesNo(f.required)} | ${f.maxLength ?? '—'} | ${f.note} |`,
  ).join('\n');

  // EVIDENCE: run the real validator over the cases that matter.
  const missingRequired = validateAddress({}, { isCreate: true });
  const atLimit = validateAddress(
    { addressOne: '1 Street' },
    { isCreate: true, existingCount: ADDRESS_LIMITS.maxPerAccount },
  );
  const patchWithoutRequired = validateAddress({ label: 'Home' }, { isCreate: false });

  return `## 3. Customer profile and addresses

The customer EXTENSION only. The identity half is \`/me\`; duplicating it is how two
endpoints come to disagree about a name.

| Field | Class | Writable by self | Note |
| --- | --- | --- | --- |
${rows}

### The address book

- **Identity** — \`${ADDRESS_IDENTITY.idColumn}\` (${ADDRESS_IDENTITY.idFormat}).
- **Owner** — \`${ADDRESS_IDENTITY.owner}\`.
- ${ADDRESS_IDENTITY.note}
- At most **${ADDRESS_LIMITS.maxPerAccount}** addresses per account.

| Field | Required on create | Max length | Note |
| --- | --- | --- | --- |
${addressRows}

Validator output, produced by running \`validateAddress\`:

- create with nothing: \`${missingRequired.refusal}\` — ${missingRequired.message}
- create at the ceiling: \`${atLimit.refusal}\` — ${atLimit.message}
- patch without the required line: ${patchWithoutRequired.ok ? '**accepted**' : 'refused'} — on PATCH an absent field means "leave it alone", never "clear it".

### The default address

- ${DEFAULT_ADDRESS_RULE.statement}
- ${DEFAULT_ADDRESS_RULE.onFirstAddress}
- ${DEFAULT_ADDRESS_RULE.onDelete}
- ${DEFAULT_ADDRESS_RULE.atomicity}

The legacy path set the new default and cleared the others in two separate statements
with no transaction. A failure between them left the account with TWO primaries, and
every reader picks whichever the planner returned first — including checkout, which is
how a booking gets addressed to a house somebody moved out of.

### Ownership is in SQL, not in a controller

The legacy \`getAddressByAddressId\` selects by id alone and the handler compares the
owner afterwards. That is correct today and is one careless caller away from not
being — the row is already in memory by the time anybody asks whose it is. Every
canonical statement carries \`AND uid = $n\`.

One refusal covers "no such address" and "not yours". Address ids are short generated
strings, so an endpoint that distinguished them would let a caller confirm which ids
exist, and these are people's homes.
`;
}

function providerSection(): string {
  return `## 4. Provider profile, documents, availability and services

### Editing is PROPOSING

A provider does not edit their public profile; they propose a change and it is
reviewed. \`PATCH ${V1_PREFIX}/provider/profile\` accepts only registry fields marked
\`editable: review\` — ${PROVIDER_SELF_EDITABLE_FIELDS.map((f) => `\`${f}\``).join(', ')} — and
DELEGATES to the compliance service's revision workflow rather than writing a column.

Identifier fields change through re-verification. Operational fields are set by
Servana. Both are refused by name, with the message naming where the change actually
happens.

A \`clientRequestId\` is REQUIRED. Without it a provider on a flaky connection queues
three copies of one biography change for a human to review.

### Documents are STATE, never content (§104)

\`worker_requirements\` is the real model. The command is explicit that
\`provider_documents\` must not be invented if it does not exist, and it does not.

The list is driven by the document CATALOG rather than by the stored rows, so a
required document that has never been submitted appears as \`missing\`. A list built
from rows alone shows an empty screen to a provider who has everything left to do.

No URL and no storage path appears. The preview endpoint mints a short-lived signed
URL after re-authorizing, which is a different operation with a different audit trail
— folding it into a profile read would turn every profile fetch into a document
disclosure.

### Availability reads what matching consumes (§105)

\`GET/PATCH ${V1_PREFIX}/provider/availability\` reads and writes
\`providerAvailabilityEngine\` — the same engine the matching pipeline selects on.

That equality is the release gate. A provider editing one source while matching reads
another is a provider who is unbookable for reasons nobody can see.

The PATCH REPLACES the week, which is why it is idempotent: the same body twice
reaches the same schedule. \`expectedVersion\` is what stops two devices silently
overwriting each other.

### Services are keyed on \`services.id\`

The Catalog V2 canonical specific-service identity. Never a service family:
\`service_families\` is legacy coarse provenance, and a provider service list keyed on a
family is how the family becomes the bookable identity again.
`;
}

function completionSection(): string {
  const rows = COMPLETION_REQUIREMENTS.map(
    (r) => `| \`${r.id}\` | ${r.role} | ${yesNo(r.blocking)} | ${r.note} |`,
  ).join('\n');

  // EVIDENCE: run the real function over the cases that distinguish the two
  // numbers the policy insists are different.
  const almost = computeCompletion({
    role: 'provider',
    hasName: true,
    hasVerifiedContact: true,
    hasPhoto: false,
    hasRequiredDocuments: true,
    hasServices: true,
    hasAvailability: true,
  });
  const blocked = computeCompletion({
    role: 'provider',
    hasName: true,
    hasVerifiedContact: true,
    hasPhoto: true,
    hasRequiredDocuments: false,
    hasServices: true,
    hasAvailability: true,
  });

  return `## 5. Profile completion (§109)

Backend-derived. A client cannot compute this: document review state, service
qualification and availability all live behind endpoints a welcome card does not call,
and two of the three are what matching actually selects on.

| Requirement | Role | Blocking | Why |
| --- | --- | --- | --- |
${rows}

### \`percent\` and \`canProceed\` answer different questions

\`percent\` counts every requirement including the cosmetic ones, because that is what a
progress bar means to a person. \`canProceed\` counts only the BLOCKING ones, because
that is what the product gates on. Conflating them is how a client shows "80%
complete" beside a button that does not work.

Produced by running \`computeCompletion\`:

- **everything but a photo**: ${almost.percent}% complete, \`canProceed: ${almost.canProceed}\`, missing ${almost.missing.map((m) => `\`${m}\``).join(', ')}
- **photo but no accepted documents**: ${blocked.percent}% complete, \`canProceed: ${blocked.canProceed}\`, blocked by ${blocked.blockedBy.map((m) => `\`${m}\``).join(', ')}

The second is the case the gate exists for: a provider who looks nearly done and
cannot take work, because matching cannot select them.
`;
}

function invalidationSection(): string {
  return `## 6. Account-switch invalidation (§108)

**Server guarantee** — ${ACCOUNT_SWITCH_INVALIDATION.serverGuarantee}

**Client obligation** — drop, on every account switch:

${ACCOUNT_SWITCH_INVALIDATION.clientObligation.map((c) => `- ${c}`).join('\n')}

${ACCOUNT_SWITCH_INVALIDATION.signal}

Stated as a contract rather than left as an assumption about what the apps happen to
do — the same shape TAB 08 used for chat session hygiene, and for the same reason: a
cached profile rendered under the next person's identity is a leak the server cannot
see.
`;
}

// ─── SETTINGS_V1_CONTRACT.md ──────────────────────────────────────────────────

function settingsSection(): string {
  const rows = SETTINGS_CATALOG.map(
    (s) => `| \`${s.id}\` | \`${s.group}\` | ${s.label} | \`${String(s.defaultValue)}\` | ${yesNo(s.writableBySelf)} | ${s.note} |`,
  ).join('\n');

  return `## 1. The settings catalog

One store, one catalog, every account and every client.

There was no server-side settings store before this. Locale and privacy choices were
held per-client, so Customer Web and Customer Mobile each remembered a different
language for the same person and neither could tell the backend.

| Setting | Group | Label | Default | Writable | Note |
| --- | --- | --- | --- | --- | --- |
${rows}

Writable at \`PATCH ${V1_PREFIX}/me/settings\`: ${SETTINGS_WRITABLE.map((s) => `\`${s}\``).join(', ')}.

Every declared setting is ALWAYS present in the response, filled from the account's row
or the catalog default. A client never has to decide what a missing key means, which is
the decision that produces two different answers in two clients.

PATCH rather than PUT: a full replace means a client that knows about four settings
silently resets the one it has never heard of every time the backend adds another. An
unknown key is REFUSED rather than ignored, so two clients cannot come to disagree
about what a person chose.

The GET returns settings GROUPED and the PATCH accepts either the grouped or the flat
shape, so a client can round-trip what it read without reshaping it.
`;
}

function notificationsPointerSection(): string {
  return `## 2. Notification preferences are a POINTER

The nine notification categories are declared in
\`services/events/domainEvents.NOTIFICATION_CATEGORIES\` and served by
\`GET/PATCH ${V1_PREFIX}/me/notification-preferences\`.

\`${V1_PREFIX}/me/settings\` returns the endpoint AND the current values for
convenience, and owns neither. Restating the categories here would be a second
preference model — which is precisely what TAB 09 existed to prevent, and it very
nearly had one: the preference table is keyed on a uid and has no role column, yet
both legacy routes onto it were gated on a provider role, so customers received
notifications they had no way to configure.
`;
}

function securitySection(): string {
  const actions = Object.entries(SECURITY_ACTIONS)
    .map(([action, where]) => `| \`${action}\` | ${where} |`)
    .join('\n');

  return `## 3. Security

\`GET ${V1_PREFIX}/me/security\` reports POSTURE:

${SECURITY_READ_FIELDS.map((f) => `- \`${f}\``).join('\n')}

### It is READ-ONLY, deliberately

Every security ACTION already has a dedicated endpoint with its own proof of
possession. Folding them into a settings PATCH would put credential changes behind a
JSON body — including the ability to turn two-factor **off** from a session that
should not be able to.

The response names where each action lives, so a client does not hardcode it:

| Action | Endpoint |
| --- | --- |
${actions}

\`twoFactorEnabled\` appears in the settings catalog as \`writableBySelf: false\` for the
same reason. It is readable there and changeable only through the credential ceremony.
`;
}

// ─── Shared sections ──────────────────────────────────────────────────────────

function endpointSection(): string {
  const entries = V1_CONTRACT.filter((e) => e.domain === 'account');
  const rows = entries
    .map(
      (e: ContractEntry) =>
        `| \`${e.method.toUpperCase()} ${V1_PREFIX}${e.path}\` | ${e.auth} | ${
          e.idempotent ? 'yes' : 'no'
        } | \`${e.domainService}\` |`,
    )
    .join('\n');

  const legacy = entries
    .flatMap((e) => e.legacy.map((l) => ({ entry: e, legacy: l })))
    .map(
      ({ entry, legacy: l }) =>
        `| \`${l.method.toUpperCase()} ${l.path}\` | ${l.disposition} | \`${entry.id}\` | ${l.note} |`,
    )
    .join('\n');

  return `## Canonical endpoints

| Endpoint | Auth | Idempotent | Domain service |
| --- | --- | --- | --- |
${rows}

### Legacy routes still mounted

Every one stays until the client that calls it has migrated, and every one is counted
by \`api/v1/legacyTelemetry\` — the watch list is derived from this same contract, so a
route can only be documented as superseded if it is also being measured.

| Legacy route | Disposition | Canonical successor | Why it is still there |
| --- | --- | --- | --- |
${legacy}
`;
}

function callerMatrixSection(): string {
  const head = `| Capability | ${CLIENT_SURFACES.map((s) => SURFACE_LABEL[s]).join(' | ')} |`;
  const divider = `| --- | ${CLIENT_SURFACES.map(() => '---').join(' | ')} |`;

  const rows = ACCOUNT_CAPABILITIES.map((capability) => {
    const cells = CLIENT_SURFACES.map((surface) => {
      if (!capability.surfaces.includes(surface)) return '—';
      const states = capability.contractIds
        .map((id) => V1_CONTRACT.find((e) => e.id === id)?.callers[surface])
        .filter(Boolean);
      if (!states.length) return '·';
      if (states.every((s) => s === 'migrated')) return 'migrated';
      if (states.some((s) => s === 'legacy')) return 'legacy';
      if (states.every((s) => s === 'n/a')) return '—';
      return 'planned';
    });
    return `| ${capability.title} | ${cells.join(' | ')} |`;
  }).join('\n');

  const rationale = ACCOUNT_CAPABILITIES.map(
    (c) => `**${c.title}** (\`${c.domainModule}\`)\n\n${c.roleSplitRationale}`,
  ).join('\n\n');

  return `## Cross-platform caller matrix

\`migrated\` — this client calls the canonical v1 route today.
\`legacy\` — this client calls a legacy route the canonical entry supersedes.
\`planned\` — this client will migrate; it calls no equivalent today.
\`—\` — the capability does not apply to this client.

${head}
${divider}
${rows}

No client is \`migrated\` yet: the platform application repositories are out of scope
until the backend Master Command completes. Every legacy route above stays mounted and
reaches the same domain service, so a client migrating later changes its URL and its
response parsing — not what it is allowed to see.

### Why each capability is or is not role-split

${rationale}
`;
}

// ─── Composition ──────────────────────────────────────────────────────────────

export function profileContractDoc(): string {
  return [
    header(
      'Profile v1 Contract',
      '    src/services/account/accountPolicy.ts                 (fields, sensitivity, addresses, completion)\n' +
      '    src/services/providerProfileComplianceService.ts      (the provider field registry)\n' +
      '    src/api/v1/contract.ts                                (the canonical endpoints)',
    ),
    '> The single account/profile truth for Customer Mobile, Customer Web, Provider',
    '> Mobile, Provider Web and Admin Web. The disclosure matrix and the completion',
    '> tables are produced by RUNNING the real decision functions, so they are',
    '> evidence of the behaviour rather than a description of it.',
    '',
    meSection(),
    sensitivitySection(),
    customerSection(),
    providerSection(),
    completionSection(),
    invalidationSection(),
    endpointSection(),
    callerMatrixSection(),
  ].join('\n');
}

export function settingsContractDoc(): string {
  return [
    header(
      'Settings v1 Contract',
      '    src/services/account/accountPolicy.ts        (the settings catalog and security surface)\n' +
      '    src/services/events/domainEvents.ts          (notification categories, pointed at)\n' +
      '    src/api/v1/contract.ts                       (the canonical endpoints)',
    ),
    '> One settings store for every account and every client. No separate web and',
    '> mobile stores, and notification preferences are a POINTER to the TAB 09 model',
    '> rather than a second copy of it.',
    '',
    settingsSection(),
    notificationsPointerSection(),
    securitySection(),
  ].join('\n');
}

export function generateAll(): Array<{ relPath: string; content: string }> {
  return [
    { relPath: 'docs/account/PROFILE_V1_CONTRACT.md', content: profileContractDoc() },
    { relPath: 'docs/account/SETTINGS_V1_CONTRACT.md', content: settingsContractDoc() },
  ];
}

/** Compares generated content with what is on disk. Newline-normalised for Windows checkouts. */
export function staleFiles(): string[] {
  const repoRoot = path.resolve(__dirname, '..');
  const stale: string[] = [];
  for (const file of generateAll()) {
    const abs = path.join(repoRoot, file.relPath);
    if (!fs.existsSync(abs)) {
      stale.push(file.relPath);
      continue;
    }
    const onDisk = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
    if (onDisk !== file.content.replace(/\r\n/g, '\n')) stale.push(file.relPath);
  }
  return stale;
}

if (require.main === module) {
  if (process.argv.includes('--check')) {
    const stale = staleFiles();
    if (stale.length) {
      console.error(`Account docs are stale — run "npm run account:docs":\n  ${stale.join('\n  ')}`);
      process.exitCode = 1;
    } else {
      console.log('Account docs are up to date.');
    }
  } else {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    for (const file of generateAll()) {
      const abs = path.resolve(__dirname, '..', file.relPath);
      fs.writeFileSync(abs, file.content, 'utf8');
      console.log(`wrote ${file.relPath}`);
    }
  }
}
