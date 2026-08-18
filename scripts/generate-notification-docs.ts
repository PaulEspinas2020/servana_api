/**
 * Writes every generated TAB 09 document.
 *
 *   docs/notifications/DOMAIN_EVENT_REGISTRY.md
 *   docs/notifications/NOTIFICATIONS_V1_CONTRACT.md
 *
 * Run: npm run notification:docs        (rewrite)
 *      npm run notification:docs:check  (fail if the committed file is stale)
 *
 * ## Why this is GENERATED
 *
 * An event registry is the document most likely to rot, because it describes
 * something invisible: nobody notices that the registry claims an event the
 * backend never publishes until a client team builds a screen around it.
 *
 * So every table below is produced by EXECUTING the real declarations —
 * `DOMAIN_EVENTS`, `projectEvent`, `mayDeliver`, `deepLinkFor`,
 * `ATTACHMENT`-style policy objects — never by reading their source or
 * restating them. The projection tables in particular are EVIDENCE: they are
 * built by running the real projector over a fixed fixture event, so if a
 * template or a key changes, the table changes with it.
 */

import fs from 'fs';
import path from 'path';

import {
  CHANNEL_POLICY,
  CLIENT_SURFACES,
  DEEP_LINK_TARGETS,
  DEEP_LINK_TARGET_NAMES,
  DOMAIN_EVENTS,
  DOMAIN_EVENT_NAMES,
  ENTITY_REFS,
  ENTITY_REF_NAMES,
  EVENT_SIGNALS,
  FORBIDDEN_REFS,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CATEGORY_NAMES,
  NOTIFICATION_CAPABILITIES,
  NOTIFICATION_CHANNELS,
  PREFERENCE_OVERRIDE_CATEGORIES,
  RECIPIENT_SEATS,
  deepLinkFor,
  mayDeliver,
  projectEvent,
  type ClientSurface,
  type DomainEventEnvelope,
  type DomainEventSpec,
  type NotificationCategory,
} from '../src/services/events/domainEvents';
import { MAX_DISPATCH_ATTEMPTS } from '../src/services/events/eventOutbox';
import {
  MAX_DEVICES_PER_SEND,
  PERMANENT_TOKEN_ERRORS,
} from '../src/services/events/deviceTokenService';
import { V1_CONTRACT, V1_PREFIX, type ContractEntry } from '../src/api/v1/contract';

const OUT_DIR = path.resolve(__dirname, '..', 'docs', 'notifications');

const header = (title: string, sources: string) => `<!--
  GENERATED FILE - do not edit by hand.
  Source: scripts/generate-notification-docs.ts, derived from
${sources}
  Regenerate: npm run notification:docs
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

/**
 * One fixture event per name, so the projection tables are produced by RUNNING
 * the projector rather than describing it.
 *
 * Every canonical id the spec requires is present, plus every optional one, so
 * a template that references a ref it did not declare shows up as an
 * unsubstituted placeholder — which `projectEvent` drops, which makes the row
 * visibly missing from the table.
 */
const fixtureFor = (name: string): DomainEventEnvelope => {
  const spec = DOMAIN_EVENTS[name as keyof typeof DOMAIN_EVENTS] as DomainEventSpec;
  const refs: Record<string, string | number> = {};
  for (const ref of [...spec.requiredRefs, ...spec.optionalRefs]) {
    refs[ref] =
      ref === 'bookingId' ? 75
        : ref === 'serviceId' ? 15
        : ref === 'conversationId' ? 11
        : ref === 'messageId' ? 4021
        : ref === 'reviewId' ? 'rev-1'
        : ref === 'applicationId' ? 'app-1'
        : ref === 'paymentId' ? 900
        : ref === 'providerUid' ? 'provider-uid'
        : 'customer-uid';
  }
  return {
    id: 1,
    name: name as keyof typeof DOMAIN_EVENTS,
    version: spec.version,
    refs,
    display: { bookingCode: 'SVN-000075' },
    occurredAt: '2026-08-14T00:00:00.000Z',
    metadata: {},
  };
};

// ─── DOMAIN_EVENT_REGISTRY.md ─────────────────────────────────────────────────

function eventCatalogSection(): string {
  const rows = DOMAIN_EVENT_NAMES.map((name) => {
    const spec = DOMAIN_EVENTS[name] as DomainEventSpec;
    const seats = spec.recipients
      .filter((r) => r.notification)
      .map((r) => r.seat)
      .join(', ') || '—';
    return `| \`${name}\` | v${spec.version} | ${spec.requiredRefs.map((r) => `\`${r}\``).join(', ')} | ${
      yesNo(spec.transactional)
    } | ${seats} |`;
  }).join('\n');

  return `## 1. The event catalog

${DOMAIN_EVENT_NAMES.length} canonical events. Each names a FACT the platform already reaches;
nothing here invents a business moment.

| Event | Version | Required canonical ids | Transactional | Notifies |
| --- | --- | --- | --- | --- |
${rows}

**Transactional** means the event is written INSIDE the producing transaction, so a rollback
leaves no event and a commit leaves a durable one. The booking state machine has that boundary and
uses it. Producers that commit per statement — messaging, payments, reviews — publish immediately
after their write; the event is still durable and still deduplicated, it just does not inherit the
fact's atomicity. The column says which is which rather than letting the registry overstate the
guarantee.

### What each event means

${DOMAIN_EVENT_NAMES.map((name) => {
  const spec = DOMAIN_EVENTS[name] as DomainEventSpec;
  return `**\`${name}\`** — ${spec.description}\n\nPublished by \`${spec.publishedBy}\`.`;
}).join('\n\n')}
`;
}

function refsSection(): string {
  const rows = ENTITY_REF_NAMES.map(
    (ref) => `| \`${ref}\` | ${ENTITY_REFS[ref]} |`,
  ).join('\n');

  return `## 2. Canonical identifiers

An event payload may carry these and only these. Canonical ids, never a screen name and never a
legacy Level-3 identifier — a screen name is a client's current implementation detail, and an event
that carries one breaks the moment a client renames a route.

| Ref | Resolves to |
| --- | --- |
${rows}

### Refused outright

${FORBIDDEN_REFS.map((r) => `\`${r}\``).join(', ')}

\`serviceFamilyId\` is on that list deliberately. Catalog V2 is production-certified with
\`services.id\` as the canonical specific-service identity, and \`service_families\` is legacy coarse
provenance. Putting a family id in an event payload is how it would quietly become the bookable
identity again. \`publishEvent\` throws rather than dropping the field, because a silently-stripped
ref is a producer that thinks it sent something.
`;
}

function projectionSection(): string {
  const blocks = DOMAIN_EVENT_NAMES.map((name) => {
    const projections = projectEvent(fixtureFor(name));
    if (!projections.length) {
      return `### \`${name}\`\n\nNo notification. The event is recorded and observed; nobody is interrupted.`;
    }
    const rows = projections
      .map(
        (p) =>
          `| ${p.seat} | \`${p.type}\` | \`${p.category}\` | ${p.title} | \`${p.notificationKey}\` | \`${p.deepLink}\` |`,
      )
      .join('\n');
    return `### \`${name}\`

| Seat | Type | Category | Title | Idempotency key | Deep link |
| --- | --- | --- | --- | --- | --- |
${rows}`;
  }).join('\n\n');

  return `## 3. Projections

Produced by RUNNING \`projectEvent\` over a fixture event with every declared id present. If a
template or a key changes, this table changes with it — which is what makes it evidence rather than
description.

The keys below are the deduplication contract. Where a legacy call site already produces the same
notification, the projection reuses its key EXACTLY, so the owner-scoped unique index on
\`(owner_uid, notification_key)\` collapses the two producers into one row whichever wins the race.
That is what let the event layer become the producer without a flag day.

${blocks}

### Which legacy producer each projection supersedes

${DOMAIN_EVENT_NAMES.flatMap((name) => {
  const spec = DOMAIN_EVENTS[name] as DomainEventSpec;
  return spec.recipients
    .filter((r) => r.notification)
    .map((r) => `- \`${name}\` → ${r.seat}: ${r.notification!.supersedes ?? '**new** — nothing notified this before'}`);
}).join('\n')}
`;
}

function outboxSection(): string {
  return `## 4. The outbox

\`servana.domain_event_outbox\`, applied by \`scripts/migrations/033-domain-event-outbox.sql\` or
lazily by \`eventOutbox.ensureOutboxSchema\`.

Two failure modes it removes, both of which have occurred here:

- **notify-before-commit** — the notification is written and the transaction then rolls back. The
  provider is told they have a job that does not exist, and there is no way to take it back.
- **commit-then-lose** — the transaction commits and the process dies before the fire-and-forget
  notification runs. The fact happened, nobody was told, and nothing records that a notification
  was owed.

### Idempotency, at two layers

1. **Publish** — \`(event_name, dedupe_key)\` is unique where a key is supplied, so a retried
   publish of a named fact produces one event.
2. **Delivery** — every projected notification carries a deterministic key under an owner-scoped
   unique index, so even a doubly-projected event writes one row.

The second layer is the one that matters. The first only prevents wasted work; the second prevents
a duplicate reaching a person.

### Dispatch

Claimed with \`FOR UPDATE SKIP LOCKED\` plus a status compare-and-swap, so two dispatchers take
disjoint sets. A failed dispatch stays \`PENDING\` and is retried up to **${MAX_DISPATCH_ATTEMPTS}**
attempts, then becomes \`FAILED\` — terminal for the dispatcher and visible to an operator.
Retrying forever is how one poison row becomes an infinite loop that starves every event behind it.
`;
}

function preferenceSection(): string {
  const categoryRows = NOTIFICATION_CATEGORY_NAMES.map((name) => {
    const spec = NOTIFICATION_CATEGORIES[name];
    return `| \`${name}\` | ${spec.label} | ${yesNo(spec.defaultOn)} | ${
      PREFERENCE_OVERRIDE_CATEGORIES.includes(name) ? 'yes' : '—'
    } | ${spec.description} |`;
  }).join('\n');

  const channelRows = NOTIFICATION_CHANNELS.map(
    (channel) => `| \`${channel}\` | ${yesNo(CHANNEL_POLICY[channel].obeysPreference)} | ${CHANNEL_POLICY[channel].reason} |`,
  ).join('\n');

  // EVIDENCE: run the real decider over the case that matters — a disabled
  // category — for every category and channel.
  const disabledMatrix = NOTIFICATION_CATEGORY_NAMES.map((category) => {
    const cells = NOTIFICATION_CHANNELS.map((channel) => {
      const d = mayDeliver(category as NotificationCategory, channel, { [category]: false } as never);
      if (!d.deliver) return 'withheld';
      return d.overridden ? '**override**' : 'deliver';
    });
    return `| \`${category}\` | ${cells.join(' | ')} |`;
  }).join('\n');

  return `## 5. Preferences

One model, one table, every account. \`provider_notification_preferences\` is keyed on a uid and has
no role column — it has always been capable of serving anyone. Both legacy routes onto it were gated
on a provider role and the customer push path never read it at all, so a customer had no way to
configure notifications and, if they had, nothing would have consulted the answer.

| Category | Label | On by default | May override | Meaning |
| --- | --- | --- | --- | --- |
${categoryRows}

### Channels

A preference governs whether we INTERRUPT somebody. It does not govern whether a fact is recorded.

| Channel | Obeys preference | Why |
| --- | --- | --- |
${channelRows}

### What happens when a category is turned OFF

Produced by running \`mayDeliver\` for each category with that category disabled.

| Category | ${NOTIFICATION_CHANNELS.join(' | ')} |
| --- | ${NOTIFICATION_CHANNELS.map(() => '---').join(' | ')} |
${disabledMatrix}

\`**override**\` is the transactional carve-out: a person cannot opt out of being told their account
or a safety case needs them. \`promotions\` is deliberately excluded from it, so the carve-out can
never be used to deliver marketing.
`;
}

function deepLinkSection(): string {
  const rows = DEEP_LINK_TARGET_NAMES.map((name) => {
    const spec = DEEP_LINK_TARGETS[name];
    const customer = deepLinkFor(name, 'customer', { [spec.ref ?? 'bookingId']: 75 } as never);
    const provider = deepLinkFor(name, 'provider', { [spec.ref ?? 'bookingId']: 75 } as never);
    return `| \`${name}\` | ${spec.ref ? `\`${spec.ref}\`` : '—'} | ${
      customer ? `\`${JSON.stringify(customer)}\`` : '—'
    } | ${provider ? `\`${JSON.stringify(provider)}\`` : '—'} |`;
  }).join('\n');

  return `## 6. The deep-link contract

One target per destination, each keyed on a CANONICAL id. The two client vocabularies are
projections of it, not separate truths — customer clients read \`{ routeKey, resourceId }\` and
provider clients read \`{ page | screen, bookingId | applicationId }\`. Both already exist in shipped
builds and neither can be changed by this backend, so the target is declared once and rendered into
both. A migrating client reads \`target\` plus the canonical ids and stops parsing either.

Rendered below by running \`deepLinkFor\` with booking 75.

| Target | Canonical id | Customer clients | Provider clients |
| --- | --- | --- | --- |
${rows}

### Authorization happens AFTER navigation

Every target that names a resource carries \`requiresAccessCheck\`. The notification is a POINTER,
not a grant: tapping it navigates, and the screen then calls the canonical endpoint, which
authorizes. A deep link carrying its own authority would be a capability URL sitting in a
notification tray.

A target that needs an id and is not given one renders **null** rather than a route containing the
literal \`{id}\`. A deep link to "{id}" is worse than no deep link, because the client opens a
screen and then fails to load it.

### CONVERSATION, for providers, deliberately omits the booking id

ServanaWorker's route resolver prefers a booking id over a page name and would open
\`JobDetailsView\`, which has no chat entry point (PM-257) — so a tap would land the provider on a
screen with no way to reach the message it announced. Without the id it falls back to the tab shell,
where Messages is one tap away. Restore the id once the job screen can open a thread.
`;
}

function deviceSection(): string {
  return `## 7. Device tokens

\`servana.account_device_tokens\` is the canonical registry for every account regardless of role.

Providers had a token TABLE and therefore multi-device push. Customers had a single COLUMN, so a
customer signed in on a phone and a tablet only ever received push on whichever signed in last —
silently, with no error anywhere. Same platform, same feature, two implementations, one broken.

- The **token** is the primary key, not \`(uid, token)\`. A device can only be signed into one
  account at a time, so registering a token another account holds MOVES it. Keying on the pair
  would let a shared or resold handset accumulate owners and receive both accounts' notifications.
- Both legacy stores are **dual-written and still read**. \`tokensFor\` returns the union, so a
  device registered through a legacy route before this shipped stays reachable.
- At most **${MAX_DEVICES_PER_SEND}** devices per send, so a corrupted token store cannot turn one
  notification into an unbounded fan-out.

### Stale tokens

Pruned on exactly these push-provider errors:

${PERMANENT_TOKEN_ERRORS.map((e) => `- \`${e}\``).join('\n')}

Deliberately only these two. Quota, unavailable, timeout and internal are transient, and deleting a
token on a transient failure would un-enroll working devices during exactly the outage that caused
it.
`;
}

function observabilitySection(): string {
  const rows = EVENT_SIGNALS.map(
    (s) => `| \`${s.code}\` | ${s.detects} | ${s.why} |`,
  ).join('\n');

  return `## 8. Observability

Counted per window and reported under \`[event-telemetry]\`. Codes and counts only — no uid, no
booking id, no notification body. A log that names who was told what has to be protected like the
notification it describes.

| Signal | Detects | Why it is counted |
| --- | --- | --- |
${rows}
`;
}

// ─── NOTIFICATIONS_V1_CONTRACT.md ─────────────────────────────────────────────

function endpointSection(): string {
  const entries = V1_CONTRACT.filter((e) => e.domain === 'notifications');
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

  return `## 1. Canonical endpoints

| Endpoint | Auth | Idempotent | Domain service |
| --- | --- | --- | --- |
${rows}

The command names \`POST /api/v1/notifications/:notificationId/read\`. The repository already had
\`PATCH ${V1_PREFIX}/notifications/:key/read\`, implemented and documented, and \`:key\` IS the
notification identifier — opaque, owner-scoped, and the only handle any store exposes. Reusing the
equivalent canonical route that already exists is what the command asks for; minting a second method
for one idempotent operation would be a blind string replacement.

### Legacy routes still mounted

Every one stays until the client that calls it has migrated, and every one is counted by
\`api/v1/legacyTelemetry\` — the watch list is derived from this same contract, so a route can only
be documented as superseded if it is also being measured.

| Legacy route | Disposition | Canonical successor | Why it is still there |
| --- | --- | --- | --- |
${legacy}
`;
}

function inboxSection(): string {
  return `## 2. The inbox contract

ONE notification shape over three physical stores. Which store a caller reads is resolved from
their ACCOUNT, never from a parameter, so the three tables are three private inboxes rather than one
shared surface.

| Seat | Store |
| --- | --- |
| customer | \`customer_notifications\` |
| provider | \`provider_notifications\` |
| admin | \`admin_notifications\` |

### The defect this closed

\`GET ${V1_PREFIX}/notifications\` called \`listCustomerNotifications\` directly. A PROVIDER calling
the canonical endpoint received an EMPTY ARRAY — not an error, not a 403, just nothing — while their
notifications sat in \`provider_notifications\` where only the legacy provider route looked. The
endpoint was documented as serving any authenticated caller and served one of the three seats.

### Why three tables and not one

Each has live writers, live readers and different columns. Merging them is a data migration against
the only reachable database, which is production. What the release gate needs is one CONTRACT: one
DTO, one unread definition, one ordering, one mark-read semantic. That is achievable now, and it is
what this is.

### Unread reconciles

A notification is unread when its status is \`unread\` and it has not expired. The count is produced
by the SAME store resolution the list uses, so the badge and the screen can never be reading
different tables — and every mutation returns the resulting count, so a client never has to
re-fetch to learn its badge or decrement a number it guessed.
`;
}

function callerMatrixSection(): string {
  const header = `| Capability | ${CLIENT_SURFACES.map((s) => SURFACE_LABEL[s]).join(' | ')} |`;
  const divider = `| --- | ${CLIENT_SURFACES.map(() => '---').join(' | ')} |`;

  const rows = NOTIFICATION_CAPABILITIES.map((capability) => {
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

  const rationale = NOTIFICATION_CAPABILITIES.map(
    (c) => `**${c.title}** (\`${c.domainModule}\`)\n\n${c.roleSplitRationale}`,
  ).join('\n\n');

  return `## 3. Cross-platform caller matrix

\`migrated\` — this client calls the canonical v1 route today.
\`legacy\` — this client calls a legacy route the canonical entry supersedes.
\`planned\` — this client will migrate; it calls no equivalent today.
\`—\` — the capability does not apply to this client.

${header}
${divider}
${rows}

No client is \`migrated\` yet: the platform application repositories are out of scope until the
backend Master Command completes. Every legacy route above stays mounted and reaches the same
domain service, so a client migrating later changes its URL and its response parsing — not which
notifications it can see.

### Why each capability is or is not role-split

${rationale}
`;
}

function seatSection(): string {
  return `## 4. One event, three reactions

The release gate is that Admin, customer and provider react to the SAME source event. That is a
property of there being one projection function, not of three code paths being kept in step.

Seats: ${RECIPIENT_SEATS.map((s) => `\`${s}\``).join(', ')}.

Recipients are resolved from the SOURCE OF TRUTH, never from the payload. The customer comes from
\`bookings.user_id\` and providers from the ACTIVE assignment — the same status list that authorizes
chat — so a provider reassigned away cannot be notified about a booking they can no longer open,
which would be a notification pointing at a screen that will refuse them.

The actor is excluded from their own event: a person who sent a message, cancelled their own booking
or left a review does not need to be told they did it.
`;
}

// ─── Composition ──────────────────────────────────────────────────────────────

export function domainEventRegistryDoc(): string {
  return [
    header(
      'Domain Event Registry',
      '    src/services/events/domainEvents.ts       (the events, projections, deep links, preferences)\n' +
      '    src/services/events/eventOutbox.ts        (the durable publisher)\n' +
      '    src/services/events/deviceTokenService.ts (the device registry)',
    ),
    '> Every table below is produced by EXECUTING `src/services/events/domainEvents.ts`.',
    '> The projection and preference matrices are built by running the real',
    '> `projectEvent` and `mayDeliver` functions, so they are evidence of the',
    '> behaviour rather than a description of it.',
    '',
    eventCatalogSection(),
    refsSection(),
    projectionSection(),
    outboxSection(),
    preferenceSection(),
    deepLinkSection(),
    deviceSection(),
    observabilitySection(),
  ].join('\n');
}

export function notificationContractDoc(): string {
  return [
    header(
      'Notifications v1 Contract',
      '    src/services/events/domainEvents.ts           (categories, deep links, capabilities)\n' +
      '    src/services/events/notificationInbox.ts      (the one inbox contract)\n' +
      '    src/api/v1/contract.ts                        (the canonical endpoints)',
    ),
    '> The single notification truth for Customer Mobile, Customer Web, Provider',
    '> Mobile, Provider Web and Admin Web.',
    '',
    endpointSection(),
    inboxSection(),
    callerMatrixSection(),
    seatSection(),
  ].join('\n');
}

export function generateAll(): Array<{ relPath: string; content: string }> {
  return [
    { relPath: 'docs/notifications/DOMAIN_EVENT_REGISTRY.md', content: domainEventRegistryDoc() },
    { relPath: 'docs/notifications/NOTIFICATIONS_V1_CONTRACT.md', content: notificationContractDoc() },
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
      console.error(`Notification docs are stale — run "npm run notification:docs":\n  ${stale.join('\n  ')}`);
      process.exitCode = 1;
    } else {
      console.log('Notification docs are up to date.');
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
