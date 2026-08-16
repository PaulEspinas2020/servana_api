# TAB 08 — Booking Communication: Messaging + Conversations

## Verdict

```
MESSAGING VERDICT: CERTIFIED_WITH_NONBLOCKING_GAPS
```

Every release gate is met in code, with tests that were actually executed. The
gaps below are environmental or sequencing, not defects: migration 032 has not
been applied to any database because the only reachable one is production, and
no client has migrated because the platform-app repositories are out of scope
until the backend Master Command completes.

```
NO CROSS-ACCOUNT / THREAD LEAKAGE      PROVEN      ✔  24 behavioural cases over real SQL, not stubs
SENDER IDENTITY IS AUTH-DERIVED        STRUCTURAL  ✔  no path/query/body field can name a sender
ONE MESSAGE / CONVERSATION IDENTITY    YES         ✔  one builder, one id space, legacy + canonical on one object
REALTIME AND FALLBACK RECONCILE        EQUATION    ✔  toMessageDto(socketPayload) === REST body, asserted
UNREAD COUNTS RECONCILE                DERIVED x2  ✔  SQL count vs independent recount; drift is a signal
ATTACHMENTS ACCESS-CONTROLLED          OWNED-ONLY  ✔  uid-prefixed object name re-derived on every send
ATTACHMENT URL MODEL                   CAPABILITY  ⚠  unguessable, non-expiring; signed previews need a client release
ONE DOMAIN SERVICE BEHIND ALL CLIENTS  PROVEN      ✔  legacy + canonical + admin driven over one fixture
CONVERSATION STATE POLICY              EXECUTED    ✔  the doc's matrix is produced by running the decider
READ FLOOR FAILS CLOSED                YES         ✔  no usable assignment start ⇒ denied, never unbounded
REFUSALS DO NOT ENUMERATE              COLLAPSED   ✔  one code for "no such thread" and "not yours"
SESSION HYGIENE ON SIGN-OUT            WIRED       ✔  sockets evicted at endAllSessions, every reason
NO PLACEHOLDER / DEMO DATA             ASSERTED    ✔  only keyed system messages are backend-authored
TELEMETRY §89                          6 SIGNALS   ✔  declared catalog == emitted catalog, asserted
MIGRATION 032 APPLIED                  NOT RUN     ⚠  deploy precondition, additive, lazily self-healing
CLIENTS MIGRATED                       0 of 5      ⚠  out of scope until the Master Command completes
PRODUCTION SMOKE                       NOT RUN     ✖  forbidden by the standing rules
```

Branch `main`, HEAD `36ca152`. **All work is uncommitted and local.** Nothing was
pushed, deployed, or run against production.

---

## 1. The sweep

`src/chat/` already existed and was substantial: a controller, a Socket.IO
gateway, a realtime emitter, a membership reconciler, a 680-line repository and a
930-line transport-agnostic service. Earlier work had already fixed the two
serious defects — authorization moved from the `chat_participants` projection to
`booking_workers`, and the message read floor moved with it, so a missing
projection row can no longer mean "no floor".

So TAB 08 is centralisation, not greenfield. What the sweep found missing:

| Surface | State before | State now |
| --- | --- | --- |
| `/api/chat/*` (4 clients) | The only conversation API. No envelope, no seat, no unread on detail. | Unchanged and still mounted. Now a projection of the same page reader. |
| `/api/bookings/:id/conversation` | Resolve-only, never creates. | Unchanged. Canonical successor `POST /api/v1/conversations` added. |
| `/api/admin/communications/*` | Own SQL for reads; send already delegated to `chat.service`. | Unchanged. Documented `ROLE_SPECIFIC` with its reason. |
| Socket.IO `/chat` | 7 events, each emitted ad hoc, payloads built at the call site. | One catalog, one emitter, envelope stamped, undeclared names throw. |
| Notification bridge | `new_message` push, body never travels. | Unchanged. |
| Attachment upload | Owned-key rule, magic-byte validation. | Unchanged rules, now DECLARED in the policy and published. |
| Message DTO | `toCamel(row)` + attachments, per call site. | One builder for REST, socket, legacy and admin. |
| Unread | One SQL expression, inbox only. | One expression, two call sites, plus an independent recount. |
| Sign-out | Tokens revoked; sockets left open. | Sockets evicted at `endAllSessions`, for every reason. |

### The three defects the sweep found

1. **A live socket outlived its session.** `endAllSessions` revoked refresh
   tokens and cleared the FCM token. A Socket.IO connection authenticates once at
   handshake, so it stayed in its conversation rooms and kept receiving that
   account's messages after sign-out or an account switch — which is the state in
   which a cached transcript is rendered under the next person's identity.
   Fixed at `endAllSessions`, not in the logout handler, so password changes,
   "sign out all devices" and admin security actions get it too. That is the
   lesson `clearFcmToken` already taught the same module.

2. **`mayWrite` precedence, found by a test.** When the conversation policy was
   extracted, the pre-`status` `is_closed` boolean was checked first.
   `setConversationStatus` writes that boolean for *every* non-writable state, so
   a READ_ONLY conversation answered with the generic "Conversation is closed",
   losing the sentence that tells a customer their booking finished rather than
   being cancelled. The leakage suite caught it on first run. The boolean now
   decides only the case it exists for: a row written before `status` existed.

3. **The canonical route was an id-enumeration oracle.** The first draft returned
   404 for an unknown conversation and 403 for a real one the caller may not
   read. Conversation ids are sequential integers, so that difference lets anyone
   count the platform's conversations by walking them. The legacy *detail* route
   never had this — it resolves access before existence — but the legacy
   *transcript* route does. The canonical surface now answers one code for both,
   and `CONVERSATION_NOT_FOUND` was removed from the v1 enum rather than left as
   a code nothing can emit.

---

## 2. Endpoints

### Added — canonical, 6 entries

| Method | Path | Domain service |
| --- | --- | --- |
| POST | `/api/v1/conversations` | `messagingService.openConversation` |
| GET | `/api/v1/conversations` | `messagingService.listConversations` |
| GET | `/api/v1/conversations/:conversationId` | `messagingService.getConversation` |
| GET | `/api/v1/conversations/:conversationId/messages` | `messagingService.listMessages` |
| POST | `/api/v1/conversations/:conversationId/messages` | `chat.service.sendMessage` |
| POST | `/api/v1/conversations/:conversationId/read` | `messagingService.markRead` |

`conversations.list` was a `planned` placeholder from TAB 01; it is now
implemented. The other five are new entries.

### Changed — same behaviour, one declaration

- `chat.repository` no longer DECLARES `CONVERSATION_STATUS` /
  `WRITABLE_STATUSES`; it re-exports them from `messagingPolicy`, unchanged, so
  every existing importer is unaffected. The declaration moved because the
  repository imports `../config` and therefore needed a database to be read at
  all, which put the conversation policy out of reach of a docs generator.
- `chat.service` now DECIDES writability with `mayWrite` and the read floor with
  `messageReadFloor` instead of restating both inline, and takes its four limits
  from the policy instead of literals.
- `chat.service.getMessages` is now a projection of a new `getMessagePage`, which
  the canonical handler also calls. Its return shape is byte-identical —
  `{ messages, nextCursor }` — because `chat.controller` spreads it into a
  response body four clients read.
- `hydrateMessage` builds through `conversationDto.buildMessageView`. The legacy
  keys (`senderRole`, `createdAt`, full attachment rows) are all still present.
- `emitToConversation` delegates to `emitMessagingEvent`, which validates the
  event name and stamps `event` / `schemaVersion` / `emittedAt` additively.
- `endAllSessions` evicts chat sockets and reports `realtimeSocketsClosed`.
- `chat_participants` gains `last_read_at` (additive, nullable, no backfill).

### Aliased — legacy routes still serving traffic

Every one stays mounted, unchanged, and every one is counted by
`api/v1/legacyTelemetry` — the watch list is derived from the same contract, so a
route can only be documented as superseded if it is also being measured.

`GET /api/chat/conversations` · `GET /api/chat/conversations/:id` ·
`GET /api/chat/conversations/:id/messages` ·
`POST /api/chat/conversations/:id/messages` · `POST /api/chat/conversations/:id/read` ·
`GET /api/bookings/:bookingId/conversation`

### Role-specific, documented

`GET|POST /api/admin/communications/conversations*` — permissioned, audited, and
carrying moderation state the customer-facing route has no business publishing.
The admin SEND already delegates to `chat.service.sendMessage`, which the parity
suite drives to prove it obeys the same idempotency and validation rules.

### Retired

None. Nothing in this domain was found dead.

---

## 3. The architecture

### One declaration

`src/services/messaging/messagingPolicy.ts` holds no database handle and imports
nothing. It declares the conversation kinds and identity, the lifecycle states
with who may post in each, the seats, the message limits, the pagination
convention, the receipt model, the unread definition, the attachment policy, the
realtime event catalog, the session-hygiene contract, the telemetry signals and
the caller matrix — plus three pure decision functions: `mayWrite`,
`messageReadFloor`, `mayOpenConversation`.

Four consumers: the services ENFORCE it, the DTO PROJECTS from it,
`scripts/generate-messaging-docs.ts` EXECUTES it to write
`MESSAGING_V1_CONTRACT.md`, and the tests ASSERT against it. The write-permission
matrix and the visibility table in the document are produced by *running* the
deciders over every input, so they are evidence rather than description.

### One message, two vocabularies, one object

The hard constraint: four shipped clients read the current realtime payload
(`payload.id`, `payload.body`, `payload.createdAt`, `payload.senderRole`) and none
of them can be redeployed by this backend. A canonical DTO that replaced those
keys would break every one of them on deploy.

So `buildMessageView` produces one object carrying both vocabularies:

```
buildMessageView(row, attachments, ctx) -> MessageView
        │                                      │
   legacy keys                            canonical keys
        │                                      │
toLegacyMessage-shaped body            toMessageDto(view)
  (/api/chat/... unchanged)              (/api/v1/... publishes)
```

The socket emits the whole `MessageView`. So:

- shipped clients keep reading the keys they already read;
- a migrated client reads the canonical keys off the **same** payload;
- `toMessageDto(realtimePayload)` is byte-for-byte the REST body.

That last line is the reconciliation gate, and it is asserted as an equation in
`messaging-unread-reconciliation.test.ts` rather than promised in prose.

### Ids stayed numbers

A string id is the better shape for a bigint column and was not available: every
shipped client parses `id` as a number, and the realtime payload has to stay
readable by them. `chat_messages.id` is a 32-bit SERIAL, so the value is
representable; the day it is not is the day the column type changes, and that
change would carry this one.

### The inbox does not resolve full access per row

`resolveAccessForConversation` costs three to five queries. Running it per
conversation would make a provider's inbox O(n) round trips. The list query
instead returns two derived columns — `viewer_is_client` from the booking, and
the participant's own `can_send` — which is enough to name the seat and render a
composer.

That value is **advisory** and the OpenAPI schema says so. The authoritative
check runs on the write, against `booking_workers`. The failure mode of an
advisory `canSend: true` is a composer that produces a 409 — a bad second, not a
leak — and the failure mode of skipping the write check would be the leak, which
is not skipped.

---

## 4. Tests actually executed

Full local run, 2026-08-13: **225 suites / 4,882 tests, all passing**, plus both
typechecks, the protected-contract guard and all four doc-drift checks. Nothing
below is claimed unexecuted.

### Suites added — 6, 111 tests

| Suite | Tests | What it proves |
| --- | --- | --- |
| `messaging-leakage.test.ts` | 24 | Customer A/B, Provider A/B, unassigned provider, reassigned provider, cancelled, read-only, admin, participant disclosure. |
| `messaging-unread-reconciliation.test.ts` | 21 | The five unread clauses, badge-vs-thread agreement, monotonic pointer, drift detection, socket-vs-REST equality, duplicate suppression, receipts. |
| `messaging-contract.test.ts` | 25 | Legacy-vs-canonical authorization parity, one write behind three callers, sender forgery refused, cursor paging, attachment policy. |
| `messaging-policy.test.ts` | 29 | The deciders, the wiring, the realtime catalog, telemetry parity, no placeholder data, the pinned limits. |
| `messaging-session-hygiene.test.ts` | 10 | Socket eviction on sign-out, per-conversation eviction, the emitter's refusal of undeclared events. |
| `messaging-docs-generated.test.ts` | 18 | The committed document is the generated one, and says what the code says. |

`tests/support/chatDbFake.ts` routes the REAL SQL rather than stubbing the
repository. That is deliberate: the guarantees in this domain ARE SQL — the read
floor is a `created_at >= $4` predicate, unread is five clauses in a scalar
subquery, the pointer is monotonic because of a `WHERE`, and idempotency is a
partial unique index. A suite that stubbed those out would prove the service
calls a function, which is not what anybody is worried about. The fake enforces
the partial unique index, so the two-device race test cannot pass against
behaviour PostgreSQL would refuse.

### Suites updated — 4, because they correctly caught this work

| Suite | Why |
| --- | --- |
| `reassignment-visibility-current` | Eight source-inspection assertions named `visibleAfter = access.assignedAt` and `const unbounded`. The DECISION moved into `messageReadFloor`; the floor's SOURCE is unchanged. Now asserted against the real function. |
| `provider-communications-hardening` | Asserted the literals `4000`, `16`, `128` and `["text","image","file"]` in the service. Now asserted against the declaration the service imports — and additionally that `system` is not in the sendable set, which a literal list could not say. |
| `booking-conversation-lifecycle` | `WRITABLE_STATUSES` is no longer a source literal to regex; it is derived from the state specs. Now asserts the runtime value plus the re-export. Three DDL regexes re-anchored on `export const ensureChatLifecycleSchema`. |
| `messaging-hardening` | Same read-floor mechanism change. |
| `v1-router`, `suite-inventory` | Six new contract entries, six new suites (219 → 225). |

---

## 5. Cross-platform caller matrix

Rendered in full, with a per-capability role-split rationale, in
`MESSAGING_V1_CONTRACT.md` §10 — generated from `MESSAGING_CAPABILITIES`, so it
cannot drift from the contract.

Summary: **six capabilities, zero role splits.** Every surface performs the same
business operation through the same endpoint and the same domain service. Where
behaviour differs by role it is a POLICY applied inside one handler — the read
floor by seat, the participant list for support, `mayOpenConversation` for an
unassigned booking — not a second endpoint that could forget it.

The one genuinely role-specific surface is admin communications, which is
documented as `ROLE_SPECIFIC` with its reason: a different question (moderation,
reports, permissioned export) over the same conversation ids.

Every cell reads `legacy`, `planned` or `n/a`. No client is migrated, and the
document asserts that it claims none.

---

## 6. Gaps

### P0 — none

### P1 — none

### P2 — deploy precondition

**Migration `032-messaging-read-receipts.sql` has never been applied.** One
additive nullable column. `ensureChatLifecycleSchema` performs the same DDL
lazily at boot, so a deploy without the migration self-heals; the migration
exists so a DBA can apply it deliberately. `ADD COLUMN` with no default is a
catalog-only change in PostgreSQL 11+ — no rewrite, no long lock.

Not applied here because the only reachable database is production, which this
work is forbidden to touch.

### P2 — a weaker model than the one this codebase already has

**Chat attachment URLs are unguessable capability URLs, not re-authorized signed
previews.** The object carries a random `firebaseStorageDownloadTokens` value and
is served from a URL containing it: not publicly listable, no `allUsers` grant,
but anyone holding the URL can fetch it and the URL does not expire.

The stronger model exists here — `uploadPrivateFileToStorage` plus a 300-second
`createPrivatePreviewUrl` minted after re-authorizing the caller — and is what
provider documents use. Chat attachments do not, because all four shipped
clients STORE the returned URL and render it directly; moving to signed previews
changes the client contract from "a URL you keep" to "a URL you re-request",
which is a client release rather than a backend change.

Deliberately not changed in this tab, and recorded in `ATTACHMENT_POLICY.urlModel`
so the generated contract states it rather than leaving it as an unstated
difference between two parts of one system. It is the natural companion to the
first client migration.

### P3 — sequencing

1. **No client has migrated.** Platform-app repositories are out of scope until
   the backend Master Command completes, so every caller cell reads `legacy`.
   Nothing is retired and nothing can be until traffic says so.

2. **The realtime schema version is 1 and no client reads it.** It is stamped
   now so the NEXT payload change is detectable rather than guessed at. Until a
   client branches on it, it is a promise rather than a mechanism.

3. **Unread drift has never fired against a real database.** The detector is
   proven by breaking the query it watches (`messaging-unread-reconciliation`
   forces a disagreement and asserts the signal), but locally both derivations
   run over the same fake. The first production window is a discovery exercise.

4. **`sendAdminMessage` hardcodes `role: 1`** after `verifyRoles([1])` has
   already proven it. Consistent and not currently wrong, but it is the one
   place in the messaging path where a role is asserted rather than read.

---

## 7. The next safe deprecation step

**Migrate Admin Web onto `GET /api/v1/conversations`.** Cheapest first move, for
three reasons: it is a web client so the retirement window is 14 days of observed
zero traffic rather than 90; it has no installed base to outlive a release; and
the admin oversight list is the one caller whose current route
(`/api/admin/communications/conversations`) is `ROLE_SPECIFIC` rather than an
alias, so migrating it proves the canonical route serves a privileged reader
without retiring anything the four apps depend on.

Then, in order: Customer Web (`/api/chat/conversations` → canonical, 14-day
window), Provider Web, then the two mobile clients together — mobile aliases need
90 days of observed zero traffic because an unupdated app keeps calling the old
path for as long as it stays installed. `RETIREMENT_CRITERIA` in
`api/v1/legacyTelemetry` states all of this, and the telemetry that measures it
is already running.

No legacy route may be deleted before its criteria are met. The
`/api/services/:id/options-with-addons` incident — a path that looked dead from
the server and was the only thing a shipped build knew how to call — is why the
window is stated in days of observed traffic rather than in releases.
