/**
 * Writes every generated TAB 08 messaging document.
 *
 *   docs/messaging/MESSAGING_V1_CONTRACT.md
 *
 * Run: npm run messaging:docs        (rewrite)
 *      npm run messaging:docs:check  (fail if the committed file is stale)
 *
 * ## Why this is GENERATED
 *
 * A hand-written messaging contract is correct on the day it is written and
 * quietly wrong afterwards, and in this domain "quietly wrong" is a document
 * that tells a client team a provider can read the whole transcript, or that an
 * event exists which the backend never emits. Both are the sort of thing that
 * is discovered by a client team, in integration, at the worst moment.
 *
 * So every table below is produced by EXECUTING the real declarations —
 * `mayWrite`, `messageReadFloor`, `mayOpenConversation`, `REALTIME_EVENTS`,
 * `ATTACHMENT_POLICY`, `MESSAGING_CAPABILITIES` — never by reading their source
 * or restating them. The write-permission matrix and the visibility table in
 * particular are EVIDENCE: they are built by running the real decision
 * functions over every input, so if a precedence changes the table changes with
 * it.
 *
 * `tests/messaging-docs-generated.test.ts` runs the check, so a policy edit that
 * is not followed by a regenerate fails the gate rather than leaving the
 * documentation describing a system the backend no longer implements.
 */

import fs from 'fs';
import path from 'path';

import {
  ATTACHMENT_POLICY,
  CLIENT_MESSAGE_ID,
  CLIENT_SURFACES,
  CONVERSATION_IDENTITY,
  CONVERSATION_KINDS,
  CONVERSATION_STATES,
  CONVERSATION_STATUS_NAMES,
  FALLBACK_RECONCILIATION,
  MESSAGE_BODY_MAX,
  MESSAGE_DTO_FIELDS,
  MESSAGE_PAGE,
  MESSAGE_TYPES,
  MESSAGING_CAPABILITIES,
  MESSAGING_SIGNALS,
  PARTICIPANT_SEATS,
  REALTIME_EVENTS,
  REALTIME_NAMESPACE,
  REALTIME_ROOM,
  REALTIME_SCHEMA_VERSION,
  RECEIPT_MODEL,
  SEND_RATE_LIMIT,
  SENDABLE_MESSAGE_TYPES,
  SESSION_HYGIENE,
  UNREAD_DEFINITION,
  UNREAD_FOR_NON_PARTICIPANT,
  WRITABLE_STATUSES,
  mayOpenConversation,
  mayWrite,
  messageReadFloor,
  type ClientSurface,
  type ParticipantSeat,
} from '../src/services/messaging/messagingPolicy';
import { V1_CONTRACT, V1_PREFIX, type ContractEntry } from '../src/api/v1/contract';

const OUT_DIR = path.resolve(__dirname, '..', 'docs', 'messaging');

const HEADER = `<!--
  GENERATED FILE - do not edit by hand.
  Source: scripts/generate-messaging-docs.ts, derived from
    src/services/messaging/messagingPolicy.ts   (states, seats, floors, events, attachments)
    src/services/messaging/conversationDto.ts   (the one message projection)
    src/api/v1/contract.ts                      (the canonical endpoints)
  Regenerate: npm run messaging:docs
-->

# Messaging v1 Contract
`;

const SURFACE_LABEL: Record<ClientSurface, string> = {
  customerMobile: 'Customer Mobile',
  customerWeb: 'Customer Web',
  providerMobile: 'Provider Mobile',
  providerWeb: 'Provider Web',
  admin: 'Admin Web',
};

const yesNo = (b: boolean) => (b ? 'yes' : '—');

// ─── Sections ─────────────────────────────────────────────────────────────────

function conversationSection(): string {
  const rows = CONVERSATION_STATUS_NAMES.map((name) => {
    const spec = CONVERSATION_STATES[name];
    return `| \`${name}\` | ${yesNo(spec.partiesMayWrite)} | ${yesNo(spec.supportMayWrite)} | ${spec.enteredBy} |`;
  }).join('\n');

  return `## 1. The Conversation resource

A conversation is **${Object.keys(CONVERSATION_KINDS).join(', ')}**-kind and nothing else: every
conversation in the platform is anchored to a booking, participants are derived from that booking,
and there is no direct customer↔provider channel. A messaging layer whose only membership rule is
"whoever the booking says" cannot leak across accounts by construction.

- **Identity** — \`${CONVERSATION_IDENTITY.idColumn}\` (${CONVERSATION_IDENTITY.idType}).
- **Anchor** — ${CONVERSATION_IDENTITY.anchor}.
- ${CONVERSATION_IDENTITY.note}

Participants are never supplied by a caller. There is no add-participant operation, because there is
nothing a caller could add someone to: membership is a projection of \`booking_workers\` and
\`bookings.user_id\`, repaired by \`chat.reconciler\`, and permitted only to NARROW what the booking
already granted.

### Lifecycle states

| State | Parties may post | Support may post | Entered by |
| --- | --- | --- | --- |
${rows}

Writable states: ${WRITABLE_STATUSES.map((s) => `\`${s}\``).join(', ')}.

\`is_closed\` is the pre-\`status\` compatibility boolean and is still maintained. It means "the
parties cannot write here", three shipped clients read it, and it is republished in the DTO so a
client that knows nothing about \`status\` still behaves correctly.

### Opening a conversation

A booking conversation is a consequence of a provider being CONFIRMED, not of somebody opening a
screen. \`POST ${V1_PREFIX}/conversations\` honours that:

${(['customer', 'provider', 'support'] as ParticipantSeat[])
  .map((seat) => {
    const withProvider = mayOpenConversation(seat, { hasActiveProvider: true });
    const without = mayOpenConversation(seat, { hasActiveProvider: false });
    return `- **${seat}** — with a confirmed provider: ${yesNo(withProvider.allowed)}; without one: ${
      without.allowed ? 'yes' : `refused ("${without.reason}")`
    }`;
  })
  .join('\n')}
`;
}

function authorizationSection(): string {
  /**
   * The matrix is EVIDENCE. Every cell is the return value of the real decision
   * function, so a change to precedence rewrites this table.
   */
  const seats: ParticipantSeat[] = [...PARTICIPANT_SEATS];
  const header = `| State | ${seats.join(' | ')} |`;
  const divider = `| --- | ${seats.map(() => '---').join(' | ')} |`;
  const rows = CONVERSATION_STATUS_NAMES.map((status) => {
    const cells = seats.map((seat) => (mayWrite(status, seat).allowed ? 'may post' : 'read only'));
    return `| \`${status}\` | ${cells.join(' | ')} |`;
  }).join('\n');

  const floors = seats
    .map((seat) => {
      const withAssignment = messageReadFloor(seat, '2026-08-03T00:00:00.000Z');
      const without = messageReadFloor(seat, null);
      return `| ${seat} | ${
        withAssignment.mode === 'full' ? 'whole transcript' : `from \`${withAssignment.since}\``
      } | ${without.mode === 'denied' ? `**denied** — ${without.reason}` : 'whole transcript'} |`;
    })
    .join('\n');

  return `## 2. Authorization

Every read and every write is authorized on the SERVER, from the booking:

- the **customer** is \`bookings.user_id\`;
- a **provider** is an ACTIVE row in \`booking_workers\` — and their assignment window travels with
  the authorization, from the same row, so the two cannot disagree;
- **support** is authorized by role. That is a deliberate, audited grant, and an admin who posts is
  recorded as a participant so "who from Servana touched this booking" is answerable from the
  participant list rather than by reading every message.

\`chat_participants\` is a PROJECTION. It may narrow access and may never widen it: a missing row
contributes nothing rather than defaulting to permissive.

### Who may post, by state

${header}
${divider}
${rows}

### How far back each seat may read

| Seat | With an assignment start | Without one |
| --- | --- | --- |
${floors}

A replacement provider reads from THEIR assignment forward and never inherits the previous
provider's transcript. An assignment with no usable start FAILS CLOSED — "I cannot tell where your
access begins" is not an argument for showing everything.

### Refusals do not confirm what exists

One code answers both "no such conversation" and "not yours". Conversation ids are sequential
integers, so an endpoint that returned 404 for an unknown id and 403 for a real one would let anyone
count the platform's conversations by walking them.
`;
}

function messageSection(): string {
  return `## 3. The message DTO

One builder — \`services/messaging/conversationDto.buildMessageView\` — produces every message the
platform emits, for every transport. The canonical projection publishes:

${MESSAGE_DTO_FIELDS.map((f) => `\`${f}\``).join(', ')}.

Message types: ${MESSAGE_TYPES.map((t) => `\`${t}\``).join(', ')}. A caller may send
${SENDABLE_MESSAGE_TYPES.map((t) => `\`${t}\``).join(', ')}; \`system\` is authored by the backend
only and every system message is keyed and deduplicated.

- Body limit: **${MESSAGE_BODY_MAX}** characters.
- Send throttle: **${SEND_RATE_LIMIT.maxMessages}** messages per
  **${SEND_RATE_LIMIT.windowMs / 1000}s**, per sender, applied AFTER the idempotency check so a
  retry of an accepted message never consumes budget.
- \`clientMsgId\` is **required**: ${CLIENT_MESSAGE_ID.minLength}–${CLIENT_MESSAGE_ID.maxLength}
  characters matching \`${CLIENT_MESSAGE_ID.pattern}\`, unique per (conversation, sender) by partial
  unique index. A retried send returns the ORIGINAL message rather than creating a second one.

### Sender identity

Derived from authentication, always. \`sender_uid\` is written from the actor the handler built out
of the verified token; there is no path, query or body parameter that can name a sender, a customer
or a provider.

### Pagination

Keyset on \`${MESSAGE_PAGE.cursorField}\`, ${MESSAGE_PAGE.order}. Default
**${MESSAGE_PAGE.defaultLimit}**, clamped to **${MESSAGE_PAGE.maxLimit}**.
\`cursor\` — ${MESSAGE_PAGE.cursorMeaning}

Offset paging is wrong for a live transcript: rows arrive at the end while a reader pages, so page
two of an offset scan silently repeats or skips messages.

### Delivery and read receipts

- **Delivered — not tracked.** ${RECEIPT_MODEL.delivered.reason}
- **Read — tracked.** Source: \`${RECEIPT_MODEL.read.source}\`.
  ${RECEIPT_MODEL.read.perMessage}
`;
}

function unreadSection(): string {
  return `## 4. Unread

ONE definition, one SQL expression, two call sites — the inbox and the per-conversation count. A
message is unread for a participant when:

${UNREAD_DEFINITION.map((clause, i) => `${i + 1}. ${clause};`).join('\n')}

\`POST ${V1_PREFIX}/conversations/:conversationId/read\` advances the pointer and returns the
resulting count, so a client never has to guess what its badge should now say. The pointer is a
monotonic high-water mark and is only ever advanced to a message that exists in THIS conversation
and is visible to that participant — both enforced in SQL, so an out-of-order client cannot un-read
a conversation or point at somebody else's thread.

An admin authorized by role holds no pointer. Unread is undefined for them and is reported as
\`{ count: ${UNREAD_FOR_NON_PARTICIPANT.count}, isParticipant: ${UNREAD_FOR_NON_PARTICIPANT.isParticipant} }\`
rather than invented.

### Drift detection

The count is produced by SQL and then RECOMPUTED from the message rows applying the same five
clauses. The two are compared, and a disagreement raises \`UNREAD_COUNT_DRIFT\`. The recount is not
used to correct the answer: silently returning the better number would hide the fact that two
readings of one table disagree, and a badge that self-heals on read is wrong everywhere it is not
read.
`;
}

function realtimeSection(): string {
  const serverRows = REALTIME_EVENTS.filter((e) => e.direction === 'server→client')
    .map((e) => `| \`${e.name}\` | ${e.payload} | ${e.description} |`)
    .join('\n');
  const clientRows = REALTIME_EVENTS.filter((e) => e.direction === 'client→server')
    .map((e) => `| \`${e.name}\` | ${e.payload} | ${e.description} |`)
    .join('\n');

  return `## 5. Realtime

One schema across Customer Mobile, Customer Web, Provider Mobile and Provider Web.

- Namespace: \`${REALTIME_NAMESPACE}\`
- Room: \`${REALTIME_ROOM}\` — membership re-authorized server-side on every join
- Schema version: **${REALTIME_SCHEMA_VERSION}**, stamped on every server-emitted payload alongside
  \`event\` and \`emittedAt\`

The event NAMES are the ones that already exist. Minting a clean vocabulary and emitting both for a
while would double-deliver every message to any client listening to the old and the new name — and a
duplicate message is exactly what this work removes. What was centralised is the payload: one
builder, one catalog, and a throw for any event not in it.

### Server → client

| Event | Payload | Meaning |
| --- | --- | --- |
${serverRows}

### Client → server

| Event | Payload | Meaning |
| --- | --- | --- |
${clientRows}

### Fallback reconciliation

- Endpoint: \`${FALLBACK_RECONCILIATION.endpoint}\`
- Merge key: \`${FALLBACK_RECONCILIATION.mergeKey}\`
- ${FALLBACK_RECONCILIATION.guarantee}
- ${FALLBACK_RECONCILIATION.duplicateSuppression}

The realtime payload is a SUPERSET of the REST message: it carries the canonical fields plus the
legacy keys the four shipped clients already read. Projecting a received payload through the
canonical projection yields byte-for-byte the REST body for the same message id, which is what makes
a reconnect an id comparison rather than a content comparison.

## 6. Session hygiene

- **Sign-out** — ${SESSION_HYGIENE.onSignOut}
- **Account switch** — ${SESSION_HYGIENE.onAccountSwitch}
- **Client obligation** — ${SESSION_HYGIENE.clientObligation}
- **No placeholder data** — ${SESSION_HYGIENE.noPlaceholderData}

A socket authenticates once at handshake and its actor never changes, so a connection cannot begin
speaking for a second account. The gap that needed closing was the other one: revoking a token stops
the next REQUEST, and an already-open socket keeps receiving the previous account's messages.
\`endAllSessions\` now evicts them, for every reason it is called with.
`;
}

function attachmentSection(): string {
  return `## 7. Attachments

| Rule | Value |
| --- | --- |
| Maximum per message | ${ATTACHMENT_POLICY.maxPerMessage} |
| Maximum size | ${ATTACHMENT_POLICY.maxBytes / (1024 * 1024)} MiB |
| Allowed types | ${ATTACHMENT_POLICY.allowedMimeTypes.map((m) => `\`${m}\``).join(', ')} |
| Content type proven by | \`${ATTACHMENT_POLICY.contentTypeProof}\` |
| Ownership | ${ATTACHMENT_POLICY.ownership} |
| Upload authorization | ${ATTACHMENT_POLICY.uploadAuthorization} |

Accepted reference forms, and nothing else:

${ATTACHMENT_POLICY.acceptedReferenceForms.map((f) => `- \`${f}\``).join('\n')}

Any other host, bucket or prefix is refused. An unchecked \`url\` field is an open redirect and an
SSRF surface wearing a filename, and quoting somebody else's object URL must not attach their file
to your message — which is why the reference is re-derived from the caller's own uid prefix on every
send rather than trusted because it looks like one of ours.

The declared mime is validated against an allow-list at send time AND proven from the file's magic
bytes at upload time. A client can claim any content type it likes.

### How the object is served

**${ATTACHMENT_POLICY.urlModel.kind}** — expires: ${yesNo(ATTACHMENT_POLICY.urlModel.expires)};
re-authorized per request: ${yesNo(ATTACHMENT_POLICY.urlModel.reauthorizedPerRequest)}.

The object is stored with a random download token and served from a URL containing it. It is not
publicly listable and the bucket needs no \`allUsers\` grant — but anyone holding the URL can fetch
it, and the URL does not expire.

The stronger model exists in this codebase and is what provider documents use:
\`${ATTACHMENT_POLICY.urlModel.strongerModelAvailable}\`. Chat attachments do not use it yet.
${ATTACHMENT_POLICY.urlModel.whyNotYet} It is recorded here rather than left as an unstated
difference between two parts of the same system.
`;
}

function observabilitySection(): string {
  const rows = MESSAGING_SIGNALS.map(
    (s) => `| \`${s.code}\` | ${s.detects} | ${s.why} |`,
  ).join('\n');

  return `## 8. Observability

Counted per window and reported under \`[messaging-telemetry]\`. Codes and counts only — no uid, no
conversation id, no message body. A log that names who was talking to whom has to be protected like
the conversation it describes.

| Signal | Detects | Why it is counted |
| --- | --- | --- |
${rows}
`;
}

function endpointSection(): string {
  const entries = V1_CONTRACT.filter((e) => e.domain === 'conversations');
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

  return `## 9. Canonical endpoints

| Endpoint | Auth | Idempotent | Domain service |
| --- | --- | --- | --- |
${rows}

### Legacy routes still mounted

Every one of these stays until the client that calls it has migrated, and every one is counted by
\`api/v1/legacyTelemetry\` — the watch list is derived from this same contract, so a route can only
be documented as superseded if it is also being measured.

| Legacy route | Disposition | Canonical successor | Why it is still there |
| --- | --- | --- | --- |
${legacy}
`;
}

function callerMatrixSection(): string {
  const header = `| Capability | ${CLIENT_SURFACES.map((s) => SURFACE_LABEL[s]).join(' | ')} |`;
  const divider = `| --- | ${CLIENT_SURFACES.map(() => '---').join(' | ')} |`;

  const rows = MESSAGING_CAPABILITIES.map((capability) => {
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

  const rationale = MESSAGING_CAPABILITIES.map(
    (c) => `**${c.title}** (\`${c.domainModule}\`)\n\n${c.roleSplitRationale}`,
  ).join('\n\n');

  return `## 10. Cross-platform caller matrix

\`migrated\` — this client calls the canonical v1 route today.
\`legacy\` — this client calls a legacy route the canonical entry supersedes.
\`planned\` — this client will migrate; it calls no equivalent today.
\`—\` — the capability does not apply to this client.

${header}
${divider}
${rows}

No client is \`migrated\` yet: the platform application repositories are out of scope until the
backend Master Command completes. Every legacy route above stays mounted and reaches the same
authorization, the same write and the same conversation ids, so a client migrating later changes its
URL and its response parsing — not which messages it can see.

### Why each capability is or is not role-split

${rationale}
`;
}

// ─── Composition ──────────────────────────────────────────────────────────────

export function messagingContractDoc(): string {
  return [
    HEADER,
    '> The single messaging truth for Customer Mobile, Customer Web, Provider Mobile,',
    '> Provider Web and Admin Web. Everything below is derived by EXECUTING',
    '> `src/services/messaging/messagingPolicy.ts` — the permission matrix and the',
    '> visibility table are produced by running the real decision functions, so they',
    '> are evidence of the behaviour rather than a description of it.',
    '',
    conversationSection(),
    authorizationSection(),
    messageSection(),
    unreadSection(),
    realtimeSection(),
    attachmentSection(),
    observabilitySection(),
    endpointSection(),
    callerMatrixSection(),
  ].join('\n');
}

export function generateAll(): Array<{ relPath: string; content: string }> {
  return [{ relPath: 'docs/messaging/MESSAGING_V1_CONTRACT.md', content: messagingContractDoc() }];
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
      console.error(`Messaging docs are stale — run "npm run messaging:docs":\n  ${stale.join('\n  ')}`);
      process.exitCode = 1;
    } else {
      console.log('Messaging docs are up to date.');
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
